# BNB Smart Chain Testnet 全新部署紀錄 v4（2026-08-18）

> ## ⚠️ 已作廢 — 本文件已被 v5 取代
>
> 本文件記錄的 chainId 97 地址**全部作廢，請勿再使用**。
> 現行可用的一代請看 **[`deployment-bsctestnet-2026-08-19-v5.md`](./deployment-bsctestnet-2026-08-19-v5.md)**
> （commit `7dc7e8f`，分支 `feat/subscription-cap-share`）。
>
> v5 重新部署的原因：Subscription Cap 從 `ProductParams.subscriptionCap`（USDT 計價）
> 改為 `BaseVault.subscriptionCapShare`（份額計價，於 settle 結束態檢查）。
> `ProductParams` 少了一個欄位、`BaseVault`／`EarnVault`／`LiquidityEarnVault`／
> `VaultTimelock`／`Settlement`／`RevenuePool`／`AdapterFactory` 的 bytecode 全部變了，
> 而 `StateManager` 不在 proxy 後面、Vault 一經 `VaultFactory` 產出即不可升級，
> 因此只能整代重來。


- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署錢包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三個 Vault 的 Owner）
- **原始碼 commit**：`10fce7f`（`feat: add an on-chain vault index to StateManager`，分支 `main`）
- **腳本**：`script/Deploy.s.sol`，依序執行 `Deploy` → `DeployW3` → `DeployW4`，全部帶 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **取代**：[`deployment-bsctestnet-2026-08-17-v3.md`](./deployment-bsctestnet-2026-08-17-v3.md)（commit `36809f2`）。
  **v3 那一代的 chainId 97 地址全部作廢，請改用本文件的地址。**

## 這次相對 v3 改了什麼

**功能上只有一項改動：`StateManager` 新增鏈上 Vault 索引。** 其餘所有合約的 bytecode
與 v3 逐位元組相同（見下面地址表的「Δ vs v3」欄）。

| # | 改動 | 影響層 | 鏈上可見證據 |
|---|---|---|---|
| 1 | `StateManager` 新增 `address[] private _vaultList`，`registerVault` 時 append | **StateManager** | StateManager 12,693 → 14,806 bytes（**+2,113**） |
| 2 | 新增 view：`vaultCount()`、`vaultAt(uint256)`、`vaultsPaged(uint256,uint256)`、`vaultsWithRole(address,uint256,uint256)` | **StateManager** | 新 SM `vaultCount()` = `3`；v3 SM 同一呼叫是**空 revert `0x`**（無此函式） |
| 3 | `src/libs/Types.sol` 新增 `VaultRole` enum（OWNER/CURATOR/GUARDIAN/ALLOCATOR/KEEPER，對應 `vaultsWithRole` 回傳 mask 的 bit 位置） | Types（純型別，不佔 bytecode） | `vaultsWithRole` 回傳 mask `31` = `0b11111` |
| 4 | `script/StubStateManager.sol` 補齊新的 `IStateManager` 介面（僅測試/W2 佔位用） | Script | StubStateManager 3,201 → 3,663 bytes（**+462**） |

### 為什麼必須整代重新部署

`StateManager` **不在 proxy 後面**（本協議只有 `UnifiedPool` 是 UUPS），而且
`StateManager.setVaultFactory` 是一次性的（`VaultFactoryAlreadySet`）。因此無法就地升級，
也無法把新的 StateManager 掛回既有的 VaultFactory／Vault／Queue／ClaimRegistry／Settlement
（這些的 `sm` 全是 constructor immutable）。整條 immutable 連鎖只能整代重來。

### 相對 v3 程序的差異：UnifiedPool 移到 W3

v3 部署完後發現 `UnifiedPool` 綁到 `StubStateManager`（見 v3 文件末段「補充」）。
修法已經寫回 `script/Deploy.s.sol`：`UnifiedPool`（implementation + ERC1967 proxy）
與 `RevenuePool.addAuthorizedSource` 都從 `Deploy`（W1/W2）**移到 `DeployW3`**，
一次就 initialize 到真正的 StateManager，`reinitializeStateManager` 本次**完全沒有被呼叫**。

連帶的環境變數變化（**與 v3 文件記載的流程不同，照本文件走**）：

| 階段 | 讀取的環境變數 |
|---|---|
| `Deploy` | 無（只需 `TEST_PK`） |
| `DeployW3` | `HYPER_ACCESS_CONTROL`、**`REVENUE_POOL`（新增）**、`USDT`、`PROTOCOL_FEE_CONFIG` |
| `DeployW4` | `HYPER_ACCESS_CONTROL`、`STATE_MANAGER`、`QUEUE`、**`UNIFIED_POOL`（改為 W3 的輸出）**、`USDT`、`CASH_VAULT`、`NOTE_VAULT`、`LP_VAULT`、`SETTLEMENT_OPERATORS`、`SETTLEMENT_THRESHOLD`、`DATA_PROVIDER_SIGNER` |

因此交易筆數也和 v3 不同：階段一 21 → **18** 筆（少了 UnifiedPool impl、proxy、
`addAuthorizedSource` 三筆），階段二 23 → **26** 筆（多了那三筆）。

驗證結果：`UnifiedPool.sm()` = `0xd0A47736…`（真 StateManager），**第一次 initialize 就正確**。

### EIP-170 前置檢查

廣播前先跑 `forge build --sizes`（forge 1.7.1）。本版 forge 印的是 margin 欄而非
v3 文件裡的 `VIOLATIONS:` 摘要行，因此逐列檢查 margin 是否為負；**全部為正、指令 exit code 0**：

```
$ forge build --sizes   →  exit=0
TOTAL contracts: 89
VIOLATIONS: NONE

tightest runtime margins:
  EarnVaultDeployer                          runtime= 24,283  rt_margin=    293  initcode= 24,312  ic_margin= 24,840
  LiquidityEarnVaultDeployer                 runtime= 22,966  rt_margin=  1,610  initcode= 22,995  ic_margin= 26,157
  EarnVault                                  runtime= 22,451  rt_margin=  2,125  initcode= 23,526  ic_margin= 25,626
  LiquidityEarnVault                         runtime= 20,987  rt_margin=  3,589  initcode= 22,179  ic_margin= 26,973
  StateManager                               runtime= 14,806  rt_margin=  9,770  initcode= 15,143  ic_margin= 34,009
  RWAAdapterDeployer                         runtime= 14,768  rt_margin=  9,808  initcode= 14,797  ic_margin= 34,355
```

`EarnVaultDeployer` 依舊是全 repo 最接近上限的合約，餘裕仍是 **293 bytes**（與 v3 相同，
本次改動沒有碰 Vault 層）。`StateManager` 加了 2,113 bytes 後餘裕仍有 9,770 bytes。
**往 `BaseVault` 再加任何 public/external 函式前都必須先跑 `forge build --sizes`。**

另外先跑過 `forge test --match-path test/StateManager.t.sol`：**97 passed / 0 failed**。

---

## 完整地址表

### 前端 `deployments.js` 可直接貼入的區塊（25 個 key）

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: '10fce7f',
    addresses: Object.freeze({
      hyperAccessControl: '0x6E631CDD697C47c2be62750b764a63648BD5389B',
      stateManager: '0xd0A47736e9Adf28f2A395834cB379E51441922bf',
      navOracle: '0xC5Ce1Ec697e39204Bb3B2e6c8AFaF185C27204b8',
      mintBurnController: '0x94599F37A014099cFFaeBe486926Cdf9b18e6dd3',
      assetRegistry: '0x46724D073ED024b170065396E10fa07423C6E4c5',
      protocolFeeConfig: '0x1CdbcBc727016FA3871207fB9f2E113989FCCE72',
      reservePSM: '0x0be798300c2afBeb6B454724D2737d04680E57fE',
      poRRegistry: '0x00fa74a855e763ff400f5aAD26C1Ee10C204103f',
      queue: '0xD81a25Bb81f79A56D470eaBEDafa159C05e8c798',
      revenuePool: '0x1931ac5a3247b140ABc58348c70B167581018E9E',
      unifiedPool: '0x460b041b6945c696C558F16F4D7Ca0fA030d5D3a',
      settlement: '0x332B9403934571a5Bddee9A20Bde6fCF1f48Daed',
      vaultFactory: '0xa6456E2dEBbA5FFA5bed720eeEb3765cFA96D5BE',
      adapterFactory: '0x9250244983667890D5D4F9C1aD037e48a55922C6',
      adapterRegistry: '0x6A3e989251d3C99cF972E8Be8857407404642D38',
      adapterRegistryFactory: '0x716613750A18176AcA415721153aFB5a4345672c',
      liquidityBridge: '0x2Fc076DfD20e0DB4e6797793a0C46235C19727C8',
      claimRegistry: '0xa4214C14fDda74d80983Ce24D41076820B013FF5',
      mockUsdt: '0x982c2ebdE0a34221a179a4F2363cFD7e20969b2e',
      cashVault: '0x050509B60B66Faa3d557dd90c30a74F3ab2AD3dd',
      noteVault: '0x6539622aD5573a998805BB9F99E515Fd097188b9',
      lpVault: '0xAb28ed57600Ea2F4D495a3cBAab7bfD11056cd21',
      cashAdapter: '0x3e24C78443C146CB77Bf9Dc8629dC659459c385B',
      noteAdapter: '0x93B97353D063c0B3601e2157453CF058484340ea',
      lpAdapter: '0xE04AA04614bC41B20A037f54d674bD4a2ad94270',
    }),
  }),
});
```

### 全部地址 + bytecode 位元組數

逐一以 `cast code <addr> --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545` 取回並計算長度，
**全部非空（38/38）**。「Δ」欄是相對 v3 的位元組差。

| 階段 | 合約 | 地址 | bytecode | Δ vs v3 |
|---|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0x6E631CDD697C47c2be62750b764a63648BD5389B` | 1109 bytes | 0 |
| Deploy | StubStateManager | `0xD312E62D2d854fEb50455B465e49E7Ffd72A7560` | 3663 bytes | **+462** |
| Deploy | MockUSDT | `0x982c2ebdE0a34221a179a4F2363cFD7e20969b2e` | 1720 bytes | 0 |
| Deploy | RevenuePool | `0x1931ac5a3247b140ABc58348c70B167581018E9E` | 2797 bytes | 0 |
| Deploy | ProtocolFeeConfig | `0x1CdbcBc727016FA3871207fB9f2E113989FCCE72` | 1827 bytes | 0 |
| Deploy | AssetRegistry | `0x46724D073ED024b170065396E10fa07423C6E4c5` | 10109 bytes | 0 |
| Deploy | MintBurnController | `0x94599F37A014099cFFaeBe486926Cdf9b18e6dd3` | 3427 bytes | 0 |
| Deploy | NAVOracle（W2 那顆，前端不用） | `0xc0764210E1cf97c1D823f49346Cd109FF8422319` | 3983 bytes | 0 |
| Deploy | PoRRegistry | `0x00fa74a855e763ff400f5aAD26C1Ee10C204103f` | 2985 bytes | 0 |
| Deploy | SToken / RWAToken（demo 資產 1） | `0xc014aAc77E29BbaA6BeBD2F70fa3B1f2E3F80ee0` | 4202 bytes | 0 |
| Deploy | JToken（demo 資產 2） | `0xB59ec56A855d693805eB56dCbc161239676e138c` | 4202 bytes | 0 |
| Deploy | Queue（W2 那顆，綁 StubStateManager，前端不用） | `0x3d8d3a76288b056f61C3E1d0DD4FC9082D4198a8` | 4178 bytes | 0 |
| Deploy | ReservePSM | `0x0be798300c2afBeb6B454724D2737d04680E57fE` | 10577 bytes | 0 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0x3c33b94f50213f24Cd4AA72bD8DdE5208c975E92` | 1366 bytes | 0 |
| Deploy | RWAAdapter（W2 demo） | `0xBeF4A98Bad72bbAaf3d1757c0ED029028BA31F64` | 13014 bytes | 0 |
| DeployW3 | **StateManager** | `0xd0A47736e9Adf28f2A395834cB379E51441922bf` | 14806 bytes | **+2113** |
| DeployW3 | ClaimRegistry | `0xa4214C14fDda74d80983Ce24D41076820B013FF5` | 1946 bytes | 0 |
| DeployW3 | **NAVOracle** | `0xC5Ce1Ec697e39204Bb3B2e6c8AFaF185C27204b8` | 3983 bytes | 0 |
| DeployW3 | **Queue** | `0xD81a25Bb81f79A56D470eaBEDafa159C05e8c798` | 4178 bytes | 0 |
| DeployW3 | LiquidityBridge | `0x2Fc076DfD20e0DB4e6797793a0C46235C19727C8` | 1291 bytes | 0 |
| DeployW3 | UnifiedPool implementation | `0x5Ed08093416e38A296E8248CFF85A3E496bc64FE` | 8851 bytes | **+400** |
| DeployW3 | **UnifiedPool（ERC1967 proxy，用這個）** | `0x460b041b6945c696C558F16F4D7Ca0fA030d5D3a` | 163 bytes | 0 |
| DeployW3 | EarnVaultDeployer | `0x2159c5c273636A3a5a19d234343c444Cc7Ae0687` | 24283 bytes | 0 |
| DeployW3 | LiquidityEarnVaultDeployer | `0x2BB173aDEA1FB8e7b4a9E39AC26744EFA654bfa5` | 22966 bytes | 0 |
| DeployW3 | VaultFactory | `0xa6456E2dEBbA5FFA5bed720eeEb3765cFA96D5BE` | 9373 bytes | 0 |
| DeployW3 | AdapterRegistryFactory | `0x716613750A18176AcA415721153aFB5a4345672c` | 1383 bytes | 0 |
| DeployW3 | AdapterRegistry（共用，由工廠產出） | `0x6A3e989251d3C99cF972E8Be8857407404642D38` | 777 bytes | 0 |
| DeployW3 | CashVault (EarnVault, htCASH) | `0x050509B60B66Faa3d557dd90c30a74F3ab2AD3dd` | 22451 bytes | 0 |
| DeployW3 | NoteVault (EarnVault, htNOTE) | `0x6539622aD5573a998805BB9F99E515Fd097188b9` | 22451 bytes | 0 |
| DeployW3 | LPVault (LiquidityEarnVault, htLP) | `0xAb28ed57600Ea2F4D495a3cBAab7bfD11056cd21` | 20987 bytes | 0 |
| DeployW3 | CashVaultTimelock | `0x258ab213461837526B31314E6c33691Bb3012B04` | 5045 bytes | 0 |
| DeployW3 | NoteVaultTimelock | `0x093b4487EeEA8b6354C23E5c8ECeFC732fC319a1` | 5045 bytes | 0 |
| DeployW3 | LPVaultTimelock | `0xAc068Cea66c3b19BA16eaF0d264E8fe0a27AAd8b` | 5045 bytes | 0 |
| DeployW4 | Settlement | `0x332B9403934571a5Bddee9A20Bde6fCF1f48Daed` | 8499 bytes | 0 |
| DeployW4 | AdapterFactory | `0x9250244983667890D5D4F9C1aD037e48a55922C6` | 1366 bytes | 0 |
| DeployW4 | CashAdapter (FirstPeriodAdapter) | `0x3e24C78443C146CB77Bf9Dc8629dC659459c385B` | 11807 bytes | 0 |
| DeployW4 | NoteAdapter (FirstPeriodAdapter) | `0x93B97353D063c0B3601e2157453CF058484340ea` | 11807 bytes | 0 |
| DeployW4 | LPAdapter (LiquidityAdapter) | `0xE04AA04614bC41B20A037f54d674bD4a2ad94270` | 12442 bytes | 0 |

鏈上 runtime 長度與本 commit 的本地 artifact（`forge build --sizes`）**逐一吻合**。
位元組差全部對得上：StateManager +2,113（vault 索引 + 四個 view）、
StubStateManager +462（補齊介面）、UnifiedPool implementation +400
（v3 事後 UUPS 升級加入的 `reinitializeStateManager` 現在已在原始碼裡，
所以新部署的 implementation 相對 v3 **最初那顆** 8,451 bytes 多了 400；
與 v3 升級後那顆 `0x0d188f35…` 相同）。**其餘 35 個合約全部 Δ = 0。**

`UnifiedPool` proxy 只有 163 bytes 是正常的——ERC1967Proxy 本體就這麼小，實作在
`0x5Ed08093…`。前端／SDK 一律用 proxy 位址 `0x460b041b…`。

### 重複合約的釐清

部署腳本三階段會產生兩個 `NAVOracle`、兩個 `Queue`、兩個 `AdapterFactory`。
以鏈上呼叫判定實際接線的那一份：

| 合約 | 實際接線（用這個） | 另一份（不要用） | 判定依據（`cast call`） |
|---|---|---|---|
| `Queue` | **`0xD81a25Bb…`**（W3） | `0x3d8d3a76…`（W2，綁 StubStateManager） | `Settlement.queue()` = `0xD81a25Bb…`；三個 Vault 的 `queue()` 都 = `0xD81a25Bb…`；`W3 Queue.sm()` = `0xd0A47736…`（真 StateManager），`W2 Queue.sm()` = `0xD312E62D…`（Stub） |
| `AdapterFactory` | **`0x92502449…`**（W4） | `0x3c33b94f…`（W2 demo） | `W4 AdapterFactory.isAdapter(cashAdapter)` = `true`；`W2 AdapterFactory.isAdapter(cashAdapter)` = `false` |
| `NAVOracle` | **`0xC5Ce1Ec6…`**（W3，前端 key 用這個） | `0xc0764210…`（W2，供 W2 demo RWAAdapter） | 腳本的 `setSigner` 只打在 W2 那顆上；W3 那顆由階段四手動補設（見下） |

與 v3 一樣，**W3 那顆 NAVOracle 的 signer 已於階段四手動補設**為部署錢包：

```
W3 NAVOracle.signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538   (本次手動補設)
```

> **這個 signer 是暫時值。** 客戶正式的 NAV signer 名單給了之後，以 NAVOracle owner 身分呼叫
> `setSigner(rwaToken, realSigner)` 覆蓋即可，不需重新部署。

---

## 部署交易 hash

### 階段一：`Deploy`（18 筆，全部 status `0x1`，合計 26,033,538 gas）

```
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | HyperAccessControl | 374,859 | `0x179ec4d7e6c6f2056b4a56b5c7e759c1185800fed8d545d913af8e35e9dc34b3` |
| 2 | CREATE | StubStateManager | 847,473 | `0xf1f41ecf507b69cd2d2ddaf61ffac7c821b2431a59d131fdc420e05b970b0b0c` |
| 3 | CREATE | MockUSDT | 499,328 | `0x178bb6796581bfd449d8079d8e5c24b27c52a3d0c9289d55bd6f6f6eca6098c4` |
| 4 | CREATE | RevenuePool | 660,471 | `0x3545f788190ef6350084b75546d53537511196fd5e4c034190fd5d3b9bb351db` |
| 5 | CREATE | ProtocolFeeConfig | 474,112 | `0xa3f7f834dc6d93dc56438ca12f7dfdab9e41208169ea28ad6cb20d0b4aea7bd3` |
| 6 | CREATE | AssetRegistry | 3,031,943 | `0xde418eea41e81db43d34fd04a21aaf20093880fa6757ad56fe5decbdb71de829` |
| 7 | CREATE | NAVOracle (W2) | 975,498 | `0x610b310e114f9a3b501ea62049f496ced03e1dc61e1d694a1ada0dd1e22667c3` |
| 8 | CREATE | PoRRegistry | 700,436 | `0xe6d30c299de5e53b57e4a4e6c7b9098d6d0628336711c605317281a3dfe63b05` |
| 9 | CALL | AssetRegistry.registerAsset (S) | 1,076,198 | `0x7fd388f34c21e53af5e7f0d11a42bc55e16d68597cf4c1079fadfc6fd11dbd45` |
| 10 | CALL | AssetRegistry.registerAsset (J) | 1,076,210 | `0x96749eb3d2dd2330d1748dfb59c19ad0f597cd7b5525cac61b58aba1e702611a` |
| 11 | CREATE | Queue (W2) | 958,962 | `0x0ffebd09aef5496b3f0c27691fa4388fbcf03dd8df068d65d731ae1ad4deb0ca` |
| 12 | CREATE | ReservePSM | 2,336,141 | `0xc4a3bfd9b6df519e63f5303ac7d41e517f97623a44234cf0d0deea8a0edcff95` |
| 13 | CALL | ReservePSM.deployWrappedToken | 568,290 | `0x0597dd771de8952b77dd0050e16d8c5314453c69924940fdbe555d3fd8d6864e` |
| 14 | CREATE | AdapterFactory (W2) | 9,533,614 | `0xc18410a5530d5688f622c618f30b61175dc03b905ffe1820be7bef560f21eb69` |
| 15 | CALL | AdapterFactory.deployRWAAdapter | 2,768,614 | `0xfeb55a8feccc81753beb78440bb93dbdb502cd19a0e6574bedf7720034609f1c` |
| 16 | CALL | MintBurnController.setTokenAgent(1) | 51,569 | `0x6a5b7f0c53d6c872ff78fe8461e28810cbe8ee28282f4ee72cb7793eef104bb8` |
| 17 | CALL | MintBurnController.setTokenAgent(2) | 51,569 | `0x460de984a16e34a4952703bb87269755b5daa3b1fc95876acf145386a46e3b99` |
| 18 | CALL | NAVOracle(W2).setSigner | 48,251 | `0x3d7a331e764eaaf83536de6bc0d9c7497e3b563263c607d3e2708800e323f805` |

> 相對 v3 少了三筆：UnifiedPool implementation、ERC1967Proxy、`RevenuePool.addAuthorizedSource`
> ——它們搬到階段二了。

### 階段二：`DeployW3`（26 筆，全部 status `0x1`，合計 40,534,228 gas）

環境變數：`HYPER_ACCESS_CONTROL=0x6E631CDD…`、`REVENUE_POOL=0x1931ac5a…`、
`USDT=0x982c2ebd…`、`PROTOCOL_FEE_CONFIG=0x1CdbcBc7…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | StateManager | 3,283,651 | `0xb61b7dbd08b9d0f7f7a53d2971de716621bdafd4333c9179f68b8409d29fc3ba` |
| 2 | CREATE | ClaimRegistry | 476,248 | `0x90f27fa23d0f90a93a1e7ac0ad9913f19a8c662496df0b794807e5363e2e156d` |
| 3 | CREATE | NAVOracle | 975,498 | `0xcd4e7e4e16318fda2e5947abd608d3dccafcf7ce371e6b4eb501e74a11a3c82e` |
| 4 | CREATE | Queue | 958,962 | `0x49f2f8dab416b618bab2d94e94a68af3c88aee64cb1263bb1c19b550aa7fb74e` |
| 5 | CREATE | LiquidityBridge | 357,538 | `0x00ca7d0e936001c5fedd20fb5e21e72782a46afd1c5c978e55057db1724bab2d` |
| 6 | CREATE | UnifiedPool implementation | 1,993,337 | `0x300f2037b8126c70e5f2a8ac248d6cbff027649551150b73fc2175269c18292f` |
| 7 | CREATE | ERC1967Proxy (UnifiedPool) | 244,737 | `0xb906fc574b25be1af15dea245f08399fac378076daf378214a59b35690c46d04` |
| 8 | CALL | RevenuePool.addAuthorizedSource(pool) | 51,702 | `0x136cda1658d6b83a67f3afca542a0b21f28b422f2decc98e83f116aeb50e5a3f` |
| 9 | CREATE | EarnVaultDeployer | 5,304,064 | `0x507f795eb7ed6b4a2a81e8625032d1cd9c36124353c3f8a8ef97f1c2ecbdab1d` |
| 10 | CREATE | LiquidityEarnVaultDeployer | 5,019,097 | `0xf21e8157c86acfc21b498bdcea47ff4b1dbcc623271c2797b30d5fbca8366624` |
| 11 | CREATE | VaultFactory | 2,101,275 | `0x66e86bd225de1ae9fc3e8fd13470f1c012672f938df4ef8d3d6f5054078b7aad` |
| 12 | CREATE | AdapterRegistryFactory | 352,058 | `0xb1e277ea21dc6ca5ff56a04806a780b3868628db8c54c51d6cf1cc54c145debb` |
| 13 | CALL | AdapterRegistryFactory.deployRegistry | 256,209 | `0xf20937aa9d841c8b5b491c2b326f7c37c936bcb87eabb903f02f88c2c53293e6` |
| 14 | CALL | StateManager.setVaultFactory | 51,862 | `0x75a4b6c9aaff8994285b5c737b9d164efb2afef6f5cf23ddd821ca88000ec6a2` |
| 15 | CALL | VaultFactory.deployVault (Cash) | 6,219,439 | `0xca3382d175e1a62c4fd154b3361cb25ff02f4a75320795854a70621630d6ebb3` |
| 16 | CALL | VaultFactory.deployVault (Note) | 6,182,199 | `0x6de000a9bbe4937dda267971c328897114e8a2849b33cce3fe2973fd65dcc72a` |
| 17 | CALL | VaultFactory.deployVault (LP) | 5,931,824 | `0x317f7898f055667bba1a8a66a4f4cd48c76c853b6efbf8a34c62cf4ff0a70ccf` |
| 18 | CALL | CashVault.setKeeper | 48,585 | `0x46998715c1c8d2c1728e3e377f9902ee9fca76cadc841f22941232e6dfdc6c74` |
| 19 | CALL | CashVault.setCurator | 48,348 | `0x9e4e1a2f59815f8e84bf3a0a5599d812efd20190d5063bfbf09df6654581528e` |
| 20 | CALL | NoteVault.setKeeper | 48,585 | `0x727833798f0e08f9fd8880ff4f2b24774ce9e42e1b748a81863da6665f551747` |
| 21 | CALL | NoteVault.setCurator | 48,348 | `0xa5f232148256f7856a1614c3b34c3584d088db1c77162bb7b4afe253bbe5e08e` |
| 22 | CALL | LPVault.setKeeper | 48,585 | `0xaaf73f6ccbec43576ee475d79461ffdfce88cc290f65bf3981743ef330a23583` |
| 23 | CALL | LPVault.setCurator | 48,348 | `0xedbaf8c701cd7022a7781e088de5e950b1d8ae22867669b7347dd8cf1a0fcd56` |
| 24 | CALL | UnifiedPool.addTrancheVault (Cash) | 147,983 | `0x85416e39eb9539c527ec50b125dfbdf2290d2e805ee697dc63dff09cffeb5d2f` |
| 25 | CALL | UnifiedPool.addTrancheVault (Note) | 167,895 | `0x1937a929c21f4457a324dd2e5186775c53bee8760a5c7602e1da87921734cf80` |
| 26 | CALL | UnifiedPool.addTrancheVault (LP) | 167,851 | `0x6d3f2463a862e2162fccd9e000c43dc17fefec54dcf89d38192663b23cff8177` |

### 階段三：`DeployW4`（26 筆，全部 status `0x1`，合計 20,617,397 gas）

環境變數另加：`STATE_MANAGER=0xd0A47736…`、`QUEUE=0xD81a25Bb…`、`UNIFIED_POOL=0x460b041b…`、
`NAV_ORACLE=0xC5Ce1Ec6…`、`CASH_VAULT=0x050509B6…`、`NOTE_VAULT=0x6539622a…`、`LP_VAULT=0xAb28ed57…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | Settlement | 1,893,019 | `0x87c5f2b48ae797074c5e975fbb11ed7e2d67fe90591301739f6eb5d421b10706` |
| 2 | CALL | CashVault.setSettlement | 56,568 | `0x073f77ba21cda16727220379f11f8eebf2948ee6371e98a2673180107874509b` |
| 3 | CALL | NoteVault.setSettlement | 56,568 | `0x8b1b924230d7f8f81a62f21a459c92d6355b08c079109d650b9d25db26a8a95f` |
| 4 | CALL | LPVault.setSettlement | 56,524 | `0x11a4f46419ae03a9af2943236c1b732dfbb4fce612704140020b1b483f3984e2` |
| 5 | CALL | Settlement.setOperator (Cash) | 97,021 | `0x01dd0f77dd244884273fcd06f21666d3fcf3d09636fcef7f3ee06bbd8805f48a` |
| 6 | CALL | Settlement.setThreshold (Cash) | 53,924 | `0x2c2bc25053d6d84940cd60ac296b7031d27dcffb8712083f74f1409ff7af3c3d` |
| 7 | CALL | Settlement.setOperator (Note) | 97,021 | `0x5209f62b3f9ef9775590bc8ec22c0933cbbc8b80131e52ee02b785326bf9a9c8` |
| 8 | CALL | Settlement.setThreshold (Note) | 53,924 | `0x4614d890e509c615bbb24d1d19f43ef70af2186150e258582fe2d7bc77fb99d1` |
| 9 | CALL | Settlement.setOperator (LP) | 96,977 | `0x4a3f012bbef3b157bed376e2f390d085eb5e1984b6920393d39042ff59bf77a2` |
| 10 | CALL | Settlement.setThreshold (LP) | 53,880 | `0xba188cbf061890b69e125063141d77864f1a421f2588aa809e52658acf44267a` |
| 11 | CREATE | AdapterFactory | 9,533,614 | `0x45e47876bdc51ac93f241e49204fafbd8af1f0af19ed38cd0adb58c196c64c49` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | 2,524,226 | `0x5e3b330acd6d69b1e7b4a3a6ab312c016deba9a514135c0a4ddb593df67c3483` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | 2,524,226 | `0x0a18137640f1233097724923a9f111a0cdd09555613538c8c5b4e1e95225a86c` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | 2,651,573 | `0xb35b49d8dc7fe0c40a49a9b53eef5d788a987c7e1a19bda78ed843c8c3ed2749` |
| 15 | CALL | AdapterRegistry.setAdapterAllowed (Cash) | 48,082 | `0xa0d952014ffdec9ef8c8f61088720a6160685d899a30b18953bf6da410e4341a` |
| 16 | CALL | AdapterRegistry.setAdapterAllowed (Note) | 48,082 | `0xd67c1109fa32f4ec9475fff640a06fad0ac1d926a3670d70c9a42b1da7b9eeda` |
| 17 | CALL | AdapterRegistry.setAdapterAllowed (LP) | 48,082 | `0x21fb367652cdb72885537e3de6a895f4ed8e180f940ab7479a8a28b7474ca7e0` |
| 18 | CALL | LPVault.setAdapter | 141,528 | `0xa0618aa807c2640dcb60928f126e462b8be8ac6f3b2273f13e9f2921f01918fd` |
| 19 | CALL | CashVault.addAdapter | 119,217 | `0xa114d23683fde4205c49773ea5f3748f54910b255b19eccb597b7469b34290b0` |
| 20 | CALL | NoteVault.addAdapter | 119,217 | `0xf426ca61be33daf6a4a14799dadf4257af9c788edecde60cf49b410c15bbb0e7` |
| 21 | CALL | CashVault.setUnifiedPool | 55,324 | `0x73945893158da3a6679877888a039aacd93c01a9147b20abf7da6a3a0e63d0c1` |
| 22 | CALL | NoteVault.setUnifiedPool | 55,324 | `0xc2aeccac92675f893c2fd0092caeea4c0fb760b2b6fb00751a2100e70499c189` |
| 23 | CALL | LPVault.setUnifiedPool | 55,280 | `0x1bb378b2b1660a4ebfab6592e265d6db66c0e9936a3c315ba4e5b53914d76931` |
| 24 | CALL | CashAdapter.setDataProvider | 59,421 | `0xb0e7552b8b4310a7a3039553609c77d3db75451b9befd7474ed762549993b714` |
| 25 | CALL | NoteAdapter.setDataProvider | 59,421 | `0x537a020c1a21cbf1983ed4c2840787f8c51e4f94a1946b7952f2ab838be6d9f7` |
| 26 | CALL | LPAdapter.setDataProvider | 59,354 | `0xcf54433a8ce399bdd8daa49d2f7e4fb4fb5e7b28d5b5d764226afc3a6d052a77` |

### 階段四：部署後手動配置（8 筆 `cast send`，全部 status `0x1`，合計 390,882 gas）

| 動作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0x5a00053cbd65db6d5f3936e23ae1c82843bd74623a1cf227881a24e1a2aa01c3` |
| `CashVault.setGuardian(deployer)` | 48,372 | `0xf471e07f3855370d1e5de2dcb329dc7dac4de2f9cc521065fcc381e692d9f750` |
| `NoteVault.setGuardian(deployer)` | 48,372 | `0xd4ba4079edc9ff4713bc5e11c80648c5049ec05c767c06dab707d44da8b59508` |
| `LPVault.setGuardian(deployer)` | 48,438 | `0x4afbcdc7184899a2a4b6de04dee22c05449a9e35a0dd293af3457850b12ca4b6` |
| `CashVault.setAllocator(deployer)` | 48,349 | `0x0494a4ea99b4d7a5e21d8ea801bd34db85abe8aed8c70a1e152537f7564a371f` |
| `NoteVault.setAllocator(deployer)` | 48,349 | `0x26a02190a9a10b74778550b57ece34eee03e67b5c9edc80a90e2ef579e8c815d` |
| `LPVault.setAllocator(deployer)` | 48,438 | `0xcf931b3584716b48bf66ecd80cfed5d1fd7ecf9bfe2975643a3329eef27d8c22` |
| **`NAVOracle(W3).setSigner(SToken, deployer)`** | 48,251 | `0x57ee0debbf1818d09ab92b557ffdc00406a2ebe62064a10bb3991eac35dee2cb` |

> **註**：與 v3 完全一樣，8 筆裡有 7 筆第一次送出時被 RPC 負載平衡後端以 `nonce too low` 拒絕
> （交易未上鏈、未耗 gas）。逐筆自動重送後全部成功，上表是成功的那 8 筆，合計 gas 與 v3 相同。
> Settlement threshold / operator 與三個 Adapter 的 Data Provider 已由 `DeployW4` 設好，階段四不需再送。

### 階段五：15 個測試錢包補鑄 MockUSDT — **已執行**

跑 `offchain/scripts/testnet/fundWallets.ts`。新的 MockUSDT 是
`0x982c2ebdE0a34221a179a4F2363cFD7e20969b2e`；v3 的 MockUSDT `0x5f3B27f8…` 上的餘額
在新環境等於不存在，所以 15 個錢包全部需要補鑄。

執行前先把 `offchain/scripts/testnet/addresses.bscTestnet.json` 更新到 v4 位址
（該檔是 `fundWallets.ts` 透過 `config.ts` 讀取位址的來源，先前仍指向已作廢的 v3 一代）。

`--dry-run` 的結果是 **0/15 需要 BNB、15/15 需要 USDT**：這批錢包的 gas 餘額跨代保留，
只有 USDT 因為 MockUSDT 換了位址而歸零。因此本階段只送出 15 筆 `mint`，沒有 BNB 轉帳。

執行後 15 個錢包皆為 `100000.0` USDT，腳本回報 `all 15 wallets funded.`。
腳本本身是冪等的（先讀餘額，已達標者跳過），重跑不會重複鑄幣。

---

## Gas 與餘額

| 項目 | gas | BNB @ 0.1 gwei |
|---|---|---|
| 階段一 `Deploy`（18 筆） | 26,033,538 | 0.0026033538 |
| 階段二 `DeployW3`（26 筆） | 40,534,228 | 0.0040534228 |
| 階段三 `DeployW4`（26 筆） | 20,617,397 | 0.0020617397 |
| 階段四 部署後配置（8 筆） | 390,882 | 0.0000390882 |
| **合計（78 筆）** | **87,576,045** | **0.0087576045** |

- 部署前餘額：`0.197041039060000000` BNB
- 部署後餘額：`0.188283434560000000` BNB
- 實際扣除：`0.008757604500000000` BNB（與上表加總 **完全吻合**）
- 部署錢包 nonce：621 → 699（78 筆）

---

## 驗證結果

### bytecode

38 個地址逐一 `cast code`，**全部非空（0 empty / 38）**，位元組數見上面地址表，
且與本 commit `forge build --sizes` 的本地 artifact 長度逐一吻合。

### 本次改動的驗收測試 — StateManager Vault 索引

RPC 一律 `https://data-seed-prebsc-1-s1.binance.org:8545`，
新 StateManager `0xd0A47736e9Adf28f2A395834cB379E51441922bf`，
部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`。

#### 1) `vaultCount()` = 3 ✅

```
$ cast call 0xd0A47736e9Adf28f2A395834cB379E51441922bf "vaultCount()(uint256)"
3
```

#### 2) `vaultsPaged(0,10)` 回傳三顆 Vault，順序即註冊順序 ✅

```
$ cast call 0xd0A47736e9Adf28f2A395834cB379E51441922bf "vaultsPaged(uint256,uint256)(address[])" 0 10
[0x050509B60B66Faa3d557dd90c30a74F3ab2AD3dd, 0x6539622aD5573a998805BB9F99E515Fd097188b9, 0xAb28ed57600Ea2F4D495a3cBAab7bfD11056cd21]
```

順序 = Cash → Note → LP，與 `DeployW3` 的 `deployVault` 呼叫順序（階段二第 15/16/17 筆）一致。

#### 3) `vaultsWithRole(deployer, 0, 10)` 三顆全中、OWNER bit 已設 ✅

```
$ cast call 0xd0A47736e9Adf28f2A395834cB379E51441922bf \
    "vaultsWithRole(address,uint256,uint256)(address[],uint8[])" \
    0x425beB70d264362E4eb7953C4f7aFBDe01145538 0 10
[0x050509B60B66Faa3d557dd90c30a74F3ab2AD3dd, 0x6539622aD5573a998805BB9F99E515Fd097188b9, 0xAb28ed57600Ea2F4D495a3cBAab7bfD11056cd21]
[31, 31, 31]
```

`31` = `0b11111` = OWNER(bit 0) | CURATOR(bit 1) | GUARDIAN(bit 2) | ALLOCATOR(bit 3) | KEEPER(bit 4)
——**要求的 OWNER bit（mask 值 1）三顆全部有設**，而且部署錢包確實同時是這三顆 Vault 的
Curator / Guardian / Allocator / Keeper（Curator+Keeper 由階段二設定，Guardian+Allocator 由階段四設定）。

#### 邊界與對照組

| 呼叫 | 結果 | 結論 |
|---|---|---|
| `vaultAt(0)` / `(1)` / `(2)` | `0x050509B6…` / `0x6539622a…` / `0xAb28ed57…` | 與 `vaultsPaged` 一致 ✅ |
| `vaultAt(3)` | revert `Panic(0x32)`（array out-of-bounds） | 越界正確 revert ✅ |
| `vaultsPaged(1,1)` | `[0x6539622a…]` | 窗格正確 ✅ |
| `vaultsPaged(3,10)` | `[]` | offset ≥ len 回空陣列，不 revert ✅ |
| `vaultsWithRole(0x0, 0, 10)` | `[]` `[]` | address(0) 一律不匹配 ✅ |
| `vaultsWithRole(0x…dEaD, 0, 10)` | `[]` `[]` | 無角色者回空 ✅ |
| **對照組** v3 StateManager `0xF4bBfE2B…` `vaultCount()` | revert，**空 revert data `0x`** | v3 沒有這個函式 ✅ |
| **對照組** v3 StateManager `registeredVaults(v3 CashVault)` | `true` | 對照組合約本身活著，證明上一列是「函式不存在」而非「合約不回應」 ✅ |

> **判讀規則**（同 v3）：函式不存在 → dispatch 落空 → **空 revert data `0x`**；
> 函式存在但業務邏輯擋下 → **具體的 error selector**（非空）。

### 連線狀態抽查（`cast call`）

```
StateManager.vaultFactory()               = 0xa6456E2dEBbA5FFA5bed720eeEb3765cFA96D5BE
StateManager.accessControl()              = 0x6E631CDD697C47c2be62750b764a63648BD5389B
UnifiedPool.sm()                          = 0xd0A47736e9Adf28f2A395834cB379E51441922bf   (真 StateManager，一次 initialize 到位)
UnifiedPool.usdt()                        = 0x982c2ebdE0a34221a179a4F2363cFD7e20969b2e
Settlement.sm()                           = 0xd0A47736e9Adf28f2A395834cB379E51441922bf
Settlement.unifiedPool()                  = 0x460b041b6945c696C558F16F4D7Ca0fA030d5D3a
Settlement.queue()                        = 0xD81a25Bb81f79A56D470eaBEDafa159C05e8c798  (W3 Queue)
W3 Queue.sm()                             = 0xd0A47736e9Adf28f2A395834cB379E51441922bf  (真 StateManager)
W2 Queue.sm()                             = 0xD312E62D2d854fEb50455B465e49E7Ffd72A7560  (Stub)
ProtocolFeeConfig.paymentTokenOf(Stable)  = 0x982c2ebdE0a34221a179a4F2363cFD7e20969b2e  (新 MockUSDT)
ProtocolFeeConfig.revenuePool()           = 0x1931ac5a3247b140ABc58348c70B167581018E9E
AssetRegistry.mintBurnController()        = 0x94599F37A014099cFFaeBe486926Cdf9b18e6dd3
AdapterRegistry.registryOwner()           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
AdapterRegistryFactory.isRegistry(shared) = true
W4 AdapterFactory.isAdapter(cashAdapter)  = true
W2 AdapterFactory.isAdapter(cashAdapter)  = false
LPVault.adapter()                         = 0xE04AA04614bC41B20A037f54d674bD4a2ad94270
MockUSDT.symbol()/decimals()              = "USDT" / 6
W3 NAVOracle.signerOf(SToken)             = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
```

三個 Vault 一致：

```
owner                                  = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
curator                                = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
guardian                               = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
allocator                              = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
isKeeper(deployer)                      = true
stateManager                           = 0xd0A47736e9Adf28f2A395834cB379E51441922bf
settlement                             = 0x332B9403934571a5Bddee9A20Bde6fCF1f48Daed
unifiedPool                            = 0x460b041b6945c696C558F16F4D7Ca0fA030d5D3a
adapterRegistry                        = 0x6A3e989251d3C99cF972E8Be8857407404642D38
queue                                  = 0xD81a25Bb81f79A56D470eaBEDafa159C05e8c798
StateManager.registeredVaults(vault)   = true
Settlement.threshold(vault)            = 1
Settlement.isOperator(vault, deployer) = true
```

各自的 VaultTimelock：Cash `0x258ab213…`、Note `0x093b4487…`、LP `0xAc068Cea…`

三個 Adapter 的 `dataProvider()` 全部 = `0x425beB70d264362E4eb7953C4f7aFBDe01145538`，
`vault()` 各自指回自己的 Vault，`asset()` 全部 = 新 MockUSDT `0x982c2ebd…`。

---

## 角色配置狀態

### 已配置（全部指向部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`）

| 角色 | 範圍 | 值 |
|---|---|---|
| Governor | HyperAccessControl | 部署錢包 |
| Issuer | AssetRegistry（demo 資產 1、2 的 owner） | 部署錢包 |
| Token Agent | MintBurnController，資產 1 與 2 | 部署錢包 |
| NAV Signer | NAVOracle **W2 `0xc0764210…`**（腳本設定，對 SToken） | 部署錢包 |
| NAV Signer | NAVOracle **W3 `0xC5Ce1Ec6…`**（階段四補設，對 SToken） | 部署錢包（**暫時值**） |
| Vault Owner | Cash / Note / LP | 部署錢包 |
| Curator | Cash / Note / LP | 部署錢包 |
| Guardian | Cash / Note / LP | 部署錢包 |
| Allocator | Cash / Note / LP | 部署錢包 |
| Keeper | Cash / Note / LP | 部署錢包 |
| Data Provider | Cash / Note / LP Adapter | 部署錢包 |
| Settlement Operator | Cash / Note / LP，threshold = 1 | 部署錢包（1-of-1） |
| Registry Owner | 共用 AdapterRegistry | 部署錢包 |
| Fee payment token | ProtocolFeeConfig，`Stable`(kind=2) | 新 MockUSDT `0x982c2ebd…` |

**全部設成部署錢包是刻意的**：客戶的正式角色名單還沒給我們，這一步只是讓環境單錢包可用。
所有這些角色都可由 Owner／Governor 隨時改，改的時候不需要重新部署。

### 尚未配置（承 v3，狀態不變）

- **15 個測試錢包的新 MockUSDT 餘額**：本次未跑 `fundWallets.ts`（見階段五）。**這是啟用測試環境前的必辦項。**
- **Settlement 3-of-5 多簽**：目前是 1-of-1（threshold=1、operator 只有部署錢包）。
- **Curator / Guardian / Allocator / Keeper 的正式持有人**：`offchain/scripts/testnet/ROLE_ASSIGNMENT.md`
  的分配表尚未套用到這一代合約上。
- **PoRRegistry proof publisher**：本次沒有設定。
- **NAVOracle signer 的正式名單**：W2／W3 兩顆目前都指向部署錢包，屬暫時值。
- **`lpAdapter.setBridgeTarget(liquidityBridge, cashVault)`**：依 `DeployW4` 註解，這屬於 Curator
  的初始參數設定，不是部署步驟，因此腳本與本次都沒有呼叫（現在 `LPAdapter.liquidityBridge()` = `0x0`）。
- **`AssetRegistry.setMetadataURI`**：函式可用但本次沒有寫入任何 URI。

---

## 同步更新的檔案

- `docs/deployment-bsctestnet-2026-08-17-v3.md` — 開頭加上「已作廢／被本文件取代」標註
- `control-panel/config.js` / `control-panel/deployments.json` — 由 `Deploy` 階段自動重寫
- `control-panel/deployments-w3.json` / `deployments-w4.json` — 由對應階段自動重寫
- `.env.testnet` — 補上本代所有地址（三個階段之間相互傳遞用）

> **注意 `UnifiedPool` 的 key 換位置了**：以前在 `deployments.json`，現在在 `deployments-w3.json`
> （因為它改成 W3 部署）。控制台 `index.html` 會把三份 JSON merge 起來
> （`Object.assign(deployments.addresses, extra.addresses)`），所以前端讀取不受影響。

`script/Deploy.s.sol` 本次**未改動**。

`offchain/scripts/testnet/addresses.bscTestnet.json` **已更新**到 v4 位址。這個檔案是納入版控的，
先前指向 v3 的作廢一代；它同時是 `fundWallets.ts` 經由 `config.ts` 讀取位址的來源，所以階段五
必須在它更新之後才能跑。更新後已逐一用 `cast code` 核驗檔內全部 24 個位址皆有 bytecode
（`stateManager` 為 14,806 bytes，與本機 artifact 一致）。

本次部署產生了兩個 `NAVOracle`、兩個 `Queue`、兩個 `AdapterFactory`，該檔採用的是
W3/W4 的那一顆（`navOracle` = `0xC5Ce1Ec6…`、`queue` = `0xD81a25Bb…`、
`adapterFactory` = `0x92502449…`），與 `.env.testnet`、`deployments-w3.json`、
`deployments-w4.json` 的選擇一致。
