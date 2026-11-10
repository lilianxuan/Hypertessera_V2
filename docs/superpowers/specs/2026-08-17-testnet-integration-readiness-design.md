# BNB Testnet 聯調準備：設計文件

日期：2026-08-17（週一）
目標聯調日：2026-08-26（下週三）
狀態：待實作

## 1. 背景

客戶提出六項交接需求與兩項 SDK 缺口反饋，並於今日告知前端已推送至
`alliancechuan/hyperTessera-web`，要求「週一先看看是不是 OK」。本文件記錄現況驗證結果、
決策，以及工作分解。

涉及兩個 repo：

- `alliancechuan/hyperTessera`（本 repo）— 合約 + offchain SDK
- `alliancechuan/hyperTessera-web` — 前端 Workbench + backend；已 clone 至
  `hyperTessera-web/`（已加入 `.gitignore`）。`hcheng826` 具 WRITE 權限，可發 PR。

## 2. 現況驗證

### 2.1 客戶反饋的兩點缺口 — 均屬實

**AdapterRegistry 無 SDK 部署方法。** `AdapterRegistry` 沒有 Factory，只能
`new AdapterRegistry(owner)`（`script/Deploy.s.sol:317`）。`control-panel/abis.json` 只存 ABI
不存 bytecode（`build-abis.sh` 只抽 `.abi`），SDK 因此無 bytecode 可用。

**ProtocolFeeConfig 只有唯讀封裝。** SDK 僅 `creationFeeOf` / `paymentTokenOf` /
`feeRevenuePool`（`offchain/src/sdk.ts:846-853`）。合約端 `setFee` / `setPaymentToken` /
`setRevenuePool` 三個 Governor-only 函數皆已存在（`src/.../ProtocolFeeConfig.sol:29-47`），
純粹是 SDK 未封裝。

### 2.2 第 5 項「多簽」的前提錯誤

僅 `Settlement` 為真正的 M-of-N（`mapping(vault => operators[])` + `threshold`）。

- `NAVOracle` 為 per-rwaToken **單一 signer**：`recovered != _signer[rwaToken]` 即 revert
  （`src/asset-infrastructure/NAVOracle.sol:52`）
- `ReservePSM` 為 per-assetId **單一 authorizedSigner**（`src/wrapped-assets/ReservePSM.sol:208`）

兩者皆為 `ECDSA.recover` 比對 EOA，**無 EIP-1271**。Gnosis Safe 等合約錢包無法作為 signer。

### 2.3 重新部署的擴散範圍 — 零串連（關鍵）

- `ReservePSM` constructor 僅取 `accessControl_`（`ReservePSM.sol:57`），且 `src/` 下**無任何
  合約引用它**，為獨立葉節點。
- `NAVOracle` 僅被 `RWAAdapter` 以 constructor 參數持有（`RWAAdapter.sol:16` immutable）。已部署
  的三個 target adapter 為 `FirstPeriodAdapter` / `LiquidityAdapter`，**不引用 navOracle**。

因此改這兩個合約後重新部署，地址表僅 `navOracle`、`reservePSM` 兩格變動，其餘 18 個地址、
三個 Vault、Settlement、Timelock 全部不動。

`lib/openzeppelin-contracts/.../SignatureChecker.sol` 已在 repo 中，改動幅度小。

### 2.4 鏈上權限現況（BSC Testnet 實查，非文件推論）

| 項目 | 實查結果 |
|---|---|
| `GOVERNOR_ROLE` 持有者 | 部署錢包 `0x425beB70…` **與** ops `0x58f7E11A…` **皆為 true** |
| 三個 Vault 的 `owner()` | 全部 = 部署錢包 `0x425beB70…` |
| `Settlement.threshold(vault)` | 三個 Vault 全部 = 1 |
| `ProtocolFeeConfig.revenuePool()` | 已設為 `0xbe77ac98…`（RevenuePool），**無需再設** |
| `ProtocolFeeConfig.paymentTokenOf(Stable)` | `0x0`，**未設定** — 客戶要求預先設定，需補 |
| `AdapterRegistry.registryOwner()` | 部署錢包 `0x425beB70…` |
| MockUSDT `decimals()` | 6 |

**結論：部署錢包 `0x425beB70…` 的私鑰是幾乎所有鏈上配置動作的必要條件** — Settlement
`setOperator`/`setThreshold`（Vault Owner only）、ProtocolFeeConfig `setPaymentToken`/`setFee`
（Governor）、AdapterRegistry `setAdapterAllowed`（registry owner）、PSM `deployWrappedToken`
（Governor）。交接文件曾稱 GOVERNOR_ROLE 已「轉給」ops，實查為**加授**而非移轉。

`MockUSDT.mint` 無權限控管（`test/mocks/MockUSDT.sol:65`），任何地址可自由鑄造。

### 2.5 前端 repo 現況

**地址表為完全不同的舊部署。** `Workbench/src/workspaces/config/deployments.js` 的
`sourceCommit` 為 `7a49a6f5`，20 個地址與交接文件 §2 的 `9e61456` target 部署**無一相同**。
shape 亦不同：多出 `navVault`、`mockUsdt`，`protocolFeeConfig` 被註解。第 1 項確實未開始。

**Vendored SDK 已是 fork，非 copy。** `Workbench/src/integrations/hypertessera/upstream/sdk.ts`
共 2260 行（本 repo `offchain/src/sdk.ts` 為 1051 行）。方法面比對：新增 108 個、移除 45 個，
且含大量改名 — `setCurator`→`setVaultCurator`、`setNAVSigner`→`setNavTokenSigner`、
`scheduleParamChange`→`scheduleVaultParamChange`、`addAdapter`→`addVaultAdapter` 等。

交接文件 §6.3 規劃的「改用 npm 真包、不再手動 vendor」路徑因此**目前不可行**。

**`registerAsset` / `deployVault` 的回傳值 — 非缺陷，屬重構價值。** 兩者（fork `sdk.ts:1060-1077`、
`:1409-1433`）直接 `return tx.wait()` 回傳 receipt，而本 repo 版本回傳 `{ assetId, token }` 與新
Vault 地址（`offchain/src/sdk.ts:558-563`、`:567-568`）。但三個 UI 呼叫點都各自解析了事件
（`RegisterAssetForm.jsx:620-632`、`CreateVaultBlueprint.jsx:254-264`、
`IssueNewAssetToken.jsx:89-99`），功能上是通的。價值在於消除三處重複並回復與 upstream 的
API 對等，**不是聯調阻塞項**。

（本文件初版曾將此列為「會卡死聯調第一步」的 P0 回歸，該判斷有誤 — 當時只讀了 fork 的
SDK 未查呼叫端。真正的阻塞項是下方的地址表。）

僅 `currentAdapter.js:1040` 的 `asset.register` capability 回傳未解析的 receipt，其消費端若需
`assetId` 需自行處理。

**地址表指向錯誤的部署 — 真正的 P0 阻塞項（已修，PR #1）。**

`deployments.js` 指向 `7a49a6f5` 的舊部署，與 vendored 的 target ABI 及呼叫程式碼不匹配：

- **`deployVault` 必然 revert。** 目標 VaultFactory `0x426DaAD1…` 的 bytecode 含 14 欄位
  `deployVault` 的 selector `0x22e1f147`；原配置的 `0x63089ad3…` **不含**該 selector
  （bytecode 亦相差懸殊，4303 vs 18749 字元）。而 `CreateVaultBlueprint.jsx:240-252` 正是按
  target 的 14 欄位結構體構造參數。
- **資產註冊被關閉。** `protocolFeeConfig` 被註解，`RegisterAssetForm.jsx:266` 的
  `ok: Boolean(addrs.protocolFeeConfig)` 恆為 false。
- **Adapter 面板退回 demo 值。** `addrs.adapterRegistry` 被兩個面板引用，但地址表無此鍵。

**兩個幽靈方法 — 呼叫不存在的合約函數。** 將 fork 的 108 個 `getFunction("…")` 呼叫與已部署
合約的 324 個函數名做完整比對，`fundAdapter` 與 `recallAdapter` **在 `src/` 源碼與部署
bytecode 中皆不存在**，呼叫必然失敗。對應地，fork 的 `abis.target.json` 在 `EarnVault` 與
`LiquidityEarnVault` 上多出三條合約沒有的 ABI 條目：`fundAdapter`、`recallAdapter`、
`getDepositRequest`。其餘 24 個合約的 ABI 與本 repo `control-panel/abis.json` 逐位元組一致。

**創建費檢查邏輯缺失。** fork 移除了 `creationFeeOf` / `paymentTokenOf` / `feeRevenuePool`，
即交接文件 §2 特別警告需帶上的費用檢查。目前費率為 0 故不會失敗，但 Governor 一改費率前端
即會靜默失敗。

**已自行解決 bytecode 問題。** fork 內含 `bytecode/AdapterRegistry.js` 與 `bytecode/NAVOracle.js`，
以 `ContractFactory` 實作 `deployAdapterRegistry` / `deployNavOracle`。故 AdapterRegistryFactory
不再是阻塞項。

**已核對無誤者：** fork 的 `feeKind` 驗證 0..2 `Native|Governance|Stable` 與
`src/libs/Types.sol:127` 的 enum 一致，非缺陷。

**前端 repo 的既有問題（與本次改動無關，未處理）：** `Workbench/package-lock.json` 與
`package.json` 不同步（`npm ci` 失敗，缺 `@emnapi/*`）；`src/demo/data/vaults.json` 未提交，
導致 10 個測試檔載入失敗（基線與改動後完全相同：10 failed / 39 passed / 335 tests passed）。

## 3. 決策記錄

| # | 決策 | 選擇 |
|---|---|---|
| D1 | NAV/PSM 多簽路線 | 改合約，加 EIP-1271 支援 |
| D2 | EIP-1271 上線節奏 | 兩階段：8/26 聯調用 EOA signer；Safe 路徑先於本地 anvil 驗證 |
| D3 | anvil 驗證保真度 | 部署**真實 Gnosis Safe**（singleton + ProxyFactory），非 mock ERC-1271 |
| D4 | AdapterRegistry 部署方法 | 新增 `AdapterRegistryFactory` 合約 |
| D5 | 測試錢包與資金 | 用戶提供資金錢包私鑰，本 session 全自動完成 |
| D6 | 前端工作範圍 | 直接在 `hyperTessera-web` 開 branch 實作並發 PR |
| D7 | SDK 分歧收斂 | 聯調前不動架構，僅修回歸；上游化列為聯調後工作 |
| D8 | Settlement M-of-N 門檻 | 3-of-5 |

## 4. 工作分解

優先序：P0 = 8/26 聯調的阻塞項；P1 = 客戶明確要求但不阻塞；P2 = 聯調後。

### WS-A｜合約改動（本 repo）

**A1（P1）NAVOracle / ReservePSM 加 EIP-1271**

`ECDSA.recover(...) != signer` 改為 `SignatureChecker.isValidSignatureNow(signer, digest, sig)`：
- `src/asset-infrastructure/NAVOracle.sol:51-52`
- `src/wrapped-assets/ReservePSM.sol:208`

副作用處理：兩處目前將 recover 出的地址用於事件／錯誤。`SignatureChecker` 只回傳 bool，
故 `NAVUpdated` 第五個參數（`NAVOracle.sol:70`）改發 `_signer[rwaToken]`；`InvalidSigner`
改發期望的 signer 而非 recovered。**ABI 與 function selector 均不變**，前端無需重新生成 ABI。

**A2（P1）AdapterRegistryFactory**

新合約，permissionless，風格對齊 `AdapterFactory`：

```solidity
function deployRegistry(address owner) external returns (address registry);
event AdapterRegistryDeployed(address indexed registry, address indexed owner, uint256 timestamp);
```

不接 `ProtocolFeeConfig` 費用門檻 — 現行 `AdapterFactory.deployAdapter` 亦無費用，保持一致。
需將 `AdapterRegistryFactory` 加入 `control-panel/build-abis.sh` 的 `CONTRACTS` 陣列。

**A3（P2）Gnosis Safe × EIP-1271 本地驗證**

於本地 anvil 部署真實 Safe singleton + ProxyFactory，建 2-of-3 Safe 作為 NAV signer 與 PSM
authorizedSigner，驗證：(a) 合約端接受 Safe 簽名；(b) 離線端能正確收集 Safe owner 簽名並
打包成 Safe 認得的 blob。**(b) 是 A3 真正的未知數**，也是 D2 拆兩階段的原因。

### WS-B｜SDK 補齊（本 repo `offchain/src/sdk.ts`）

**B1（P1）ProtocolFeeConfig 寫入封裝** — `setCreationFee` / `setFeePaymentToken` /
`setFeeRevenuePool`，接於現有 Module G 區塊（`sdk.ts:843` 之後）。Governor-only。

**B2（P1）AdapterRegistry 封裝** — `deployAdapterRegistry(owner, signer)`（經 A2 的 Factory，
解析 `AdapterRegistryDeployed` 取得地址）、`transferRegistryOwnership`。

### WS-C｜重新部署與地址表（本 repo）

**C1（P1）** 部署改動後的 `NAVOracle`、`ReservePSM`、新的 `AdapterRegistryFactory` 至 BSC
Testnet；於新 PSM 重跑必要的 `deployWrappedToken`；設定 NAV signer。

**C2（P0）** `ProtocolFeeConfig.setPaymentToken(Stable, MockUSDT)` — 客戶明確要求預先設定，
且實查為未設（§2.4）。`revenuePool` 已正確，不動。

**C3（P1）** 產出更新後的地址表交付文件（僅 `navOracle`、`reservePSM` 兩格變動，另新增
`adapterRegistryFactory`）。

### WS-D｜Testnet 準備（本 repo，新增 `offchain/scripts/testnet/`，與 `scripts/local/` 平行，不動 local）

**T1（P0）`wallets.ts`** — 全新 testnet-only 助記詞派生 15 個錢包 + 角色分配建議表
（客戶表明角色由他們分配，本表為建議版供覆蓋）。

**T2（P0）`addresses.bscTestnet.json`** — target 地址表，含 `adapterRegistry`、
`protocolFeeConfig`、`usdt` 三個交接文件 §2 提及但不在 `HyperTesseraAddresses` shape 內的地址。

**T3（P0）`fundWallets.ts`** — 自資金錢包批次分發 testnet BNB，並對 15 個錢包
`MockUSDT.mint`。

**T4（P1）`setupMultisig.ts`** — 對三個 Vault 執行 `setOperator` × N + `setThreshold`
（預設 3-of-5，可參數化）。需部署錢包私鑰（Vault Owner）。

**T5（P1）`runKeeper.ts` / `runSettlement.ts`** — 將現成 `KeeperBot` / `SettlementOperator`
指向 testnet。**不重寫任何狀態機推進邏輯**。

秘密處理：資金錢包與部署錢包私鑰一律走環境變數，**不進 git**；15 個測試錢包助記詞寫入
`.gitignore` 的檔案，另出一份僅含地址的交付表。

### WS-E｜前端（`hyperTessera-web`，開 branch 發 PR）

**E1（P0）更新 `deployments.js` — 已完成，PR #1。** 20 個地址換成 `9e61456` target 地址表，
補上 `protocolFeeConfig` 與 `adapterRegistry`，更新 `mockUsdt`，移除無引用的 `navVault`。
23 個地址皆以 `cast code` 確認鏈上有 bytecode；typecheck / build / `deployments.test.js` 5/5
通過。WS-C1 完成後需再發一次 PR 更新 `navOracle` / `reservePSM` 兩格。

**E2（P1）移除幽靈方法** — 刪除 fork 中的 `fundAdapter` / `recallAdapter` 兩個 SDK 方法，
以及 `abis.target.json` 內 `EarnVault` / `LiquidityEarnVault` 多出的三條 ABI 條目。**需先與
客戶確認**這三個函數是否為期望我方新增至合約的需求，而非單純的誤植。

**E3（P1）補回創建費檢查** — 將 `creationFeeOf` / `paymentTokenOf` / `feeRevenuePool` 補回
fork，並在資產／Vault 建立流程帶上費用計算。

**E7（P2）收斂 `registerAsset` / `deployVault` 回傳值** — 將事件解析收進 SDK，消除三個 UI
呼叫點的重複解析。非阻塞（見 §2.5），可與 D7 的上游化一併處理。

**E4（P1）錢包連接與 BNB Testnet 切換** — 接上 `offchain/src/web3.ts` 的 `connectWallet` /
`switchNetwork`（內建 `BNB_TESTNET` 常數與 4902 fallback）。

**E5（P1）同步 `bytecode/NAVOracle.js`** — A1 改動後此 bytecode 即過期，前端據此部署出的
NAVOracle 將不支援 EIP-1271。若 A2 的 Factory 完成，`bytecode/AdapterRegistry.js` 可一併移除。

**E6（P2）分歧清單** — 產出 fork 與 upstream 的完整差異清單（改名對照 + 移除清單），作為
D7 上游化的依據。

## 5. 需要提供給我的東西

依阻塞程度排序：

1. **部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538` 的私鑰** — WS-C2、WS-D 的 T4 的硬依賴。
   它同時是三個 Vault 的 Owner、AdapterRegistry owner，並持有 GOVERNOR_ROLE。**沒有它，
   Settlement 多簽與 ProtocolFeeConfig 設定都做不了。**
2. **資金錢包私鑰（需已有足量 testnet BNB）** — WS-D 的 T3。可與第 1 項為同一把。15 個錢包的
   gas 需求請估算後備妥；MockUSDT 我可自行鑄造，無需準備。
3. **ops 地址 `0x58f7E11AC4a1c9aa735215AF2dc897ac9f926367` 的私鑰**（若需完成 Adapter 的
   `setDataProvider`）— 鏈上實查確認三個 Vault 的 `getProductState` 皆為 0（`CONFIGURING`）、
   `curator()` 皆為 ops 地址、三個 Adapter 的 `dataProvider()` 皆仍為部署錢包。此階段
   `setDataProvider` 僅認 Curator 本人直接呼叫，無 Owner/Timelock 後備路徑。**已決定由客戶
   自行執行**，指令已寫入客戶答覆。

### 需要客戶確認的事項

1. **聯調日期** — 客戶原訊息稱「下週三」。若為 8/26 則時程可行；若實指本週三 8/19，則僅
   P0 可完成，WS-A 全部需順延。
2. **Settlement M-of-N 的 operator 名單** — M/N 已定為 3-of-5（D8）。若沿用 T1 的 15 個測試
   錢包則我方自行分配，否則請客戶提供 5 個地址。
3. **`fundAdapter` / `recallAdapter` / `getDepositRequest` 的意圖** — 這三個函數在合約中不存在
   （§2.5）。需確認是誤植（則刪除，E2）或是期望我方新增至合約的需求（則需另行評估）。
4. **`navVault` 欄位** — PR #1 已移除（全 repo 無任何讀取點且指向已停用部署）。若另有用途
   請告知以便加回。
5. **`setDataProvider` 的目標地址** — 客戶需決定實際要指定的 data provider 簽名地址。

## 6. 驗收標準

- WS-A：`forge test` 全綠，含 EIP-1271 新增測試（EOA 路徑回歸 + 合約錢包路徑）。
- WS-B：`npm run typecheck` + `npm test`（`offchain/test/sdk.unit.test.ts`）通過。
- WS-C：以 `cast code` 逐一確認新地址有 bytecode；`paymentTokenOf(Stable)` 回傳 MockUSDT。
- WS-D：15 個錢包鏈上 BNB 與 MockUSDT 餘額實查達標；`setupMultisig.ts` 執行後
  `Settlement.threshold(vault)` 回傳設定值。
- WS-E：`npm run typecheck` + `npm run build` 通過，且 `npm test` 與基線一致（基線為
  10 failed files / 335 tests passed，因 demo 資料未提交所致）；`registerAsset` / `deployVault`
  於 testnet 實跑並確實取回 `assetId` 與 Vault 地址。

## 7. 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| A3 的 Safe 簽名 blob 組裝為真正未知數 | 可能吃掉 P0 時間 | D2 已拆兩階段，8/26 走 EOA；A3 列 P2 |
| SDK fork 分歧持續擴大 | 每次合約改動需改兩邊 | D7 接受短期分歧；E6 先產出清單止血 |
| 前端 fork 可能有更多未發現的缺陷 | 聯調當天才爆 | 已做 108 個 `getFunction` 對 324 個合約函數的全量比對與 26 個 ABI 逐位元組 diff；仍需於 testnet 實跑 Phase 1-3 端到端補足行為層驗證 |
| 聯調日若為 8/19 | WS-A 全部趕不上 | 已列為第 5 節待確認項 |

## 8. 範圍外

- 不改動 Settlement 合約（M-of-N 已內建）。
- 不重新部署 §2 中除 `navOracle`/`reservePSM` 以外的任何地址。
- 不執行 SDK 上游化與命名統一（D7 列為聯調後）。
- 不觸碰 `offchain/scripts/local/` 既有本地 devnet 流程。
