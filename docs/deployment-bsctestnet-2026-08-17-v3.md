# BNB Smart Chain Testnet 全新部署紀錄 v3（2026-08-17）

> ## ⚠️ 已作廢 — 本文件已被 v4 取代
>
> 本文件記錄的 chainId 97 地址**全部作廢，請勿再使用**。
> 現行可用的一代請看 **[`deployment-bsctestnet-2026-08-18-v4.md`](./deployment-bsctestnet-2026-08-18-v4.md)**
> （commit `10fce7f`）。
>
> v4 重新部署的原因：`StateManager` 新增鏈上 Vault 索引
> （`_vaultList` + `vaultCount`/`vaultAt`/`vaultsPaged`/`vaultsWithRole`）。
> `StateManager` 不在 proxy 後面，且 `setVaultFactory` 一次性，
> VaultFactory／Vault／Queue／ClaimRegistry／Settlement 的 `sm` 又都是 constructor immutable，
> 因此整代只能重新部署。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署錢包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三個 Vault 的 Owner）
- **原始碼 commit**：`36809f2`（分支 `feat/testnet-integration-prep`）
- **腳本**：`script/Deploy.s.sol`，依序執行 `Deploy` → `DeployW3` → `DeployW4`，全部帶 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **取代**：[`deployment-bsctestnet-2026-08-17-v2.md`](./deployment-bsctestnet-2026-08-17-v2.md)（commit `af3d3db`）。
  **那一代 chainId 97 地址全部作廢。**

## 這次相對 v2 改了什麼

v2 部署（commit `af3d3db`）之後合約累積了以下改動。其中多處落在 Vault／Asset／Adapter 層，
immutable 連鎖（`Queue.sm`、`Settlement.{sm,unifiedPool,queue}`、`AssetRegistry.mintBurnController`、
`VaultFactory` 的 deployer 位址、`StateManager.setVaultFactory` 一次性）使部分替換做不到，
因此整代重新部署。

| # | 改動 | 影響層 | 鏈上可見證據 |
|---|---|---|---|
| 1 | `BaseVault.getDepositRequest(uint256)` 新增 | **Vault** | 新 vault 回傳全零 struct；v2 vault 空 revert `0x` |
| 2 | `AssetRegistry.setMetadataURI` / `metadataURIOf` 新增 | **Asset** | 新 registry 可呼叫；v2 registry 空 revert `0x`。AssetRegistry 9,132 → 10,109 bytes（**+977**） |
| 3 | `Settlement.submitBatch` 執行段兩階段拆分（Phase A 先對全部 Vault 定價，Phase B 才依序 settle） | Settlement | Settlement 8,401 → 8,499 bytes（**+98**）；外部 selector `0x49644637` 未變 |
| 4 | `EarnVault.deposit` 定價順序修正 | **Vault** | EarnVault 22,139 → 22,451 bytes（**+312**，與 1 合計） |
| 5 | `BaseAdapter.createBuyOrder` 守衛（承 v2） | Adapter | `createBuyOrder(1, self, 0)` revert `0xb02bec7a` |
| 6 | `LiquidityAdapter` 刪死碼（承 v2） | Adapter | `bridgeToCash` 空 revert |
| 7 | `LiquidityEarnVault` NatSpec | **Vault** | LiquidityEarnVault 20,675 → 20,987 bytes（**+312**，與 1 合計） |
| 8 | ERC-1644 移除（`RWAToken.controllerTransfer`，承 v2） | **Asset** | 空 revert |
| 9 | EIP-1271 簽章支援 | Settlement / Vault | 含在上述 bytecode 增量內 |
| 10 | `markRefundable` 發出 `DepositMarkedRefundable` 事件 | **Vault** | 含在 Vault bytecode 增量內 |
| 11 | `AdapterRegistryFactory`（承 v2） | Vault 層 | `isRegistry(shared)` = `true` |
| 12 | `fundAdapter` / `recallAdapter` Vault↔Adapter 資金通道 | **Vault** | 三個 vault 上皆 PRESENT（revert `AdapterNotFound`，非空 revert） |
| 13 | `realAssets` 計入 Adapter 閒置餘額 | Adapter | 含在 Adapter bytecode 內 |

### EIP-170 前置檢查（v3 第一次嘗試失敗的原因）

先前一次 v3 嘗試時，`BaseVault` 同時加了 `getDepositRequest` 與 `getRedeemRequest`，
使 `EarnVaultDeployer` 超出 EIP-170 上限 58 bytes，`forge script` 在廣播前就拒絕。
拿掉 `getRedeemRequest` 後才過。**本次部署前已用 `forge build --sizes` 全面確認**：

```
contract                                 runtime rt_margin  initcode ic_margin
EarnVaultDeployer                          24283       293     24312     24840
LiquidityEarnVaultDeployer                 22966      1610     22995     26157
EarnVault                                  22451      2125     23526     25626
LiquidityEarnVault                         20987      3589     22179     26973
...
TOTAL contracts: 86
VIOLATIONS: NONE
```

`EarnVaultDeployer` 是全 repo 最接近上限的合約，餘裕僅 **293 bytes**。
往 `BaseVault` 再加任何 public/external 函式前都必須先跑 `forge build --sizes`。

> **關於那批孤兒合約**：前一次失敗的 v3 嘗試，階段一已上鏈（花費約 0.0028 BNB），
> 產生一批沒有 Vault 層的孤兒合約。那批**不可用、直接忽略**，本次從頭全新部署。

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
    sourceCommit: '36809f2',
    addresses: Object.freeze({
      hyperAccessControl: '0x495Cfd6068126E5Be02487c3B08987c98d72401e',
      stateManager: '0xF4bBfE2B65bdd67A5B382Ff7680dAadD264F96D5',
      navOracle: '0xcEb29fD1DEbA011769560A6560e7E202a9393594',
      mintBurnController: '0xcc7c7F30feFAb7D8eA107C73ad2db576B92a7a20',
      assetRegistry: '0xf856c633A2aeE55F4Fd78619E97882557653a04d',
      protocolFeeConfig: '0xF1909C1B70dFd880B67AedE435E5EF4e2aCac7bC',
      reservePSM: '0x1365D6dFa13213d3766cDdf65740BaB66C28Ce4a',
      poRRegistry: '0x6fFAdff687c783F16c722E8aB28Dc79744CC33a0',
      queue: '0x57BE09846Db8Be64EbedD6A63ae0507c7413A8B4',
      revenuePool: '0x101Ff50EAC13fE153d4B00095F8281bE2b957620',
      unifiedPool: '0x32AB7fC13704856166a8B5A0d5d8Bd590350c3Df',
      settlement: '0xF2f95496fBeD28A178F5a42af698cf657b8fd155',
      vaultFactory: '0x2F3Eb06ce79A25A7c9F5FBdD7c794ce6Ef66a6AD',
      adapterFactory: '0xEb847AE9875a99fAddaa98b184B9159B97530b0a',
      adapterRegistry: '0x555dd152A0d0229E5C6bE3d5B3A891B1eaFfe9E7',
      adapterRegistryFactory: '0x587BfE17d2A249425301549ac8f18c1d6F358692',
      liquidityBridge: '0x02521c8f5F9A4Cf6d73e65c4FeE618fCB1B8f78b',
      claimRegistry: '0x9983a823ac04bFfac78C5041e02FCbA4157a1C18',
      mockUsdt: '0x5f3B27f8697B912153F5C48f10f8E0b9D07Ccc4A',
      cashVault: '0x4161174820C9588946A02aacEb2e1BA87dF0f6Ac',
      noteVault: '0x06747911c1a2524e5f0D2F3c590b9A0C2489bD40',
      lpVault: '0x24Ed1116ef72abf0642da57942dAeD4e9d6bF894',
      cashAdapter: '0xb68Be99D6d93d7d30093f9aA9Ca73cBFcCE34EB5',
      noteAdapter: '0x59Fe7638d6D5318cba4f2666E9FA1097F53e8125',
      lpAdapter: '0xEd195b141b4AF0Abb110559d7C30fC5421e3b9d7',
    }),
  }),
});
```

### 全部地址 + bytecode 位元組數

逐一以 `cast code <addr> --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545` 取回並計算長度，
**全部非空（38/38）**。「Δ」欄是相對 v2 的位元組差。

| 階段 | 合約 | 地址 | bytecode | Δ vs v2 |
|---|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0x495Cfd6068126E5Be02487c3B08987c98d72401e` | 1109 bytes | 0 |
| Deploy | StubStateManager | `0x24e55CdD37da8C9eBd2B022BD68CaBFf1780c181` | 3201 bytes | 0 |
| Deploy | MockUSDT | `0x5f3B27f8697B912153F5C48f10f8E0b9D07Ccc4A` | 1720 bytes | 0 |
| Deploy | RevenuePool | `0x101Ff50EAC13fE153d4B00095F8281bE2b957620` | 2797 bytes | 0 |
| Deploy | ProtocolFeeConfig | `0xF1909C1B70dFd880B67AedE435E5EF4e2aCac7bC` | 1827 bytes | 0 |
| Deploy | AssetRegistry | `0xf856c633A2aeE55F4Fd78619E97882557653a04d` | 10109 bytes | **+977** |
| Deploy | MintBurnController | `0xcc7c7F30feFAb7D8eA107C73ad2db576B92a7a20` | 3427 bytes | 0 |
| Deploy | NAVOracle（W2 那顆，前端不用） | `0x2A7F694B0abeD7191Ee9C1275D3aE46Efc5392E7` | 3983 bytes | 0 |
| Deploy | PoRRegistry | `0x6fFAdff687c783F16c722E8aB28Dc79744CC33a0` | 2985 bytes | 0 |
| Deploy | SToken / RWAToken（demo 資產 1） | `0x9B78Dee63d4c3F39F1273DEba855cFf40fcce5ec` | 4202 bytes | 0 |
| Deploy | JToken（demo 資產 2） | `0x41cEFeb514b09DdF902FA108dE2113F3b556Bc81` | 4202 bytes | 0 |
| Deploy | UnifiedPool implementation | `0x8c642eEd1b83045622151680d5A60c5511a67464` | 8451 bytes | 0 |
| Deploy | **UnifiedPool（ERC1967 proxy，用這個）** | `0x32AB7fC13704856166a8B5A0d5d8Bd590350c3Df` | 163 bytes | 0 |
| Deploy | Queue（W2 那顆，綁 StubStateManager，前端不用） | `0x23e100Cb6d1930F8d7AD1C24B80C23EFe80ADe6d` | 4178 bytes | 0 |
| Deploy | ReservePSM | `0x1365D6dFa13213d3766cDdf65740BaB66C28Ce4a` | 10577 bytes | 0 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0xeb2b710Ed94520308b2382761452cA23fbbF878e` | 1366 bytes | 0 |
| Deploy | RWAAdapter（W2 demo） | `0x946e5608e8A7DB2FD2D90D17B80dD17967A09217` | 13014 bytes | 0 |
| DeployW3 | **StateManager** | `0xF4bBfE2B65bdd67A5B382Ff7680dAadD264F96D5` | 12693 bytes | 0 |
| DeployW3 | ClaimRegistry | `0x9983a823ac04bFfac78C5041e02FCbA4157a1C18` | 1946 bytes | 0 |
| DeployW3 | **NAVOracle** | `0xcEb29fD1DEbA011769560A6560e7E202a9393594` | 3983 bytes | 0 |
| DeployW3 | **Queue** | `0x57BE09846Db8Be64EbedD6A63ae0507c7413A8B4` | 4178 bytes | 0 |
| DeployW3 | LiquidityBridge | `0x02521c8f5F9A4Cf6d73e65c4FeE618fCB1B8f78b` | 1291 bytes | 0 |
| DeployW3 | EarnVaultDeployer | `0xe6b91F4731D3c91Ed2da57F2Fc2109b62aAa9AE4` | 24283 bytes | **+312** |
| DeployW3 | LiquidityEarnVaultDeployer | `0xd21e0414F7B408354D09D6ac95Ae60fe6dAe19E8` | 22966 bytes | **+312** |
| DeployW3 | VaultFactory | `0x2F3Eb06ce79A25A7c9F5FBdD7c794ce6Ef66a6AD` | 9373 bytes | 0 |
| DeployW3 | AdapterRegistryFactory | `0x587BfE17d2A249425301549ac8f18c1d6F358692` | 1383 bytes | 0 |
| DeployW3 | AdapterRegistry（共用，由工廠產出） | `0x555dd152A0d0229E5C6bE3d5B3A891B1eaFfe9E7` | 777 bytes | 0 |
| DeployW3 | CashVault (EarnVault, htCASH) | `0x4161174820C9588946A02aacEb2e1BA87dF0f6Ac` | 22451 bytes | **+312** |
| DeployW3 | NoteVault (EarnVault, htNOTE) | `0x06747911c1a2524e5f0D2F3c590b9A0C2489bD40` | 22451 bytes | **+312** |
| DeployW3 | LPVault (LiquidityEarnVault, htLP) | `0x24Ed1116ef72abf0642da57942dAeD4e9d6bF894` | 20987 bytes | **+312** |
| DeployW3 | CashVaultTimelock | `0x1e6e80C4028A6fb238bBFEBd9DdE8a5655A2c914` | 5045 bytes | 0 |
| DeployW3 | NoteVaultTimelock | `0x18997598ce82801302943d55a4296DEC882004F7` | 5045 bytes | 0 |
| DeployW3 | LPVaultTimelock | `0x3c6f2Ca2e75685906F0668023ad63874c3A5C720` | 5045 bytes | 0 |
| DeployW4 | Settlement | `0xF2f95496fBeD28A178F5a42af698cf657b8fd155` | 8499 bytes | **+98** |
| DeployW4 | AdapterFactory | `0xEb847AE9875a99fAddaa98b184B9159B97530b0a` | 1366 bytes | 0 |
| DeployW4 | CashAdapter (FirstPeriodAdapter) | `0xb68Be99D6d93d7d30093f9aA9Ca73cBFcCE34EB5` | 11807 bytes | 0 |
| DeployW4 | NoteAdapter (FirstPeriodAdapter) | `0x59Fe7638d6D5318cba4f2666E9FA1097F53e8125` | 11807 bytes | 0 |
| DeployW4 | LPAdapter (LiquidityAdapter) | `0xEd195b141b4AF0Abb110559d7C30fC5421e3b9d7` | 12442 bytes | 0 |

鏈上 runtime 長度與本 commit 的本地 artifact（`forge build --sizes`）**逐一吻合**。
位元組差對得上改動：Asset 層 +977（metadata URI 讀寫）、Vault 層 +312
（`getDepositRequest` + deposit 定價修正 + `fundAdapter`/`recallAdapter` + `markRefundable` 事件 + EIP-1271）、
Settlement +98（`submitBatch` 兩階段拆分）。Adapter 層本次 0（v2 已含那兩項改動）。

`UnifiedPool` proxy 只有 163 bytes 是正常的——ERC1967Proxy 本體就這麼小，實作在
`0x8c642eEd…`。前端／SDK 一律用 proxy 位址 `0x32AB7fC1…`。

### 重複合約的釐清

部署腳本三階段會產生兩個 `NAVOracle`、兩個 `Queue`、兩個 `AdapterFactory`。
以鏈上呼叫判定實際接線的那一份：

| 合約 | 實際接線（用這個） | 另一份（不要用） | 判定依據（`cast call`） |
|---|---|---|---|
| `Queue` | **`0x57BE0984…`**（W3） | `0x23e100Cb…`（W2，綁 StubStateManager） | `Settlement.queue()` = `0x57BE0984…`；三個 Vault 的 `queue()` 都 = `0x57BE0984…`；`W3 Queue.sm()` = `0xF4bBfE2B…`（真 StateManager），`W2 Queue.sm()` = `0x24e55CdD…`（Stub） |
| `AdapterFactory` | **`0xEb847AE9…`**（W4） | `0xeb2b710E…`（W2 demo） | `W4 AdapterFactory.isAdapter(cashAdapter)` = `true`；`W2 AdapterFactory.isAdapter(cashAdapter)` = `false` |
| `NAVOracle` | **`0xcEb29fD1…`**（W3，前端 key 用這個） | `0x2A7F694B…`（W2，供 W2 demo RWAAdapter） | `W2 RWAAdapter.navOracle()` = `0x2A7F694B…`；兩顆的 `signerOf(SToken)` 現在都 = 部署錢包（見下） |

**與 v2 的差別**：v2 的 W3 NAVOracle 沒有任何 signer（腳本的 `setSigner` 只打在 W2 那顆上），
前端指向的 oracle 實際上推不了 NAV。**本次已額外對 W3 那顆補設 signer**：

```
W2 NAVOracle.signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538   (腳本設定)
W3 NAVOracle.signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538   (本次手動補設)
```

> **這個 signer 是暫時值。** 設成部署錢包只是為了讓前端指向的 W3 NAVOracle 立即可用。
> 客戶正式的 NAV signer 名單給了之後，以 NAVOracle owner 身分呼叫
> `setSigner(rwaToken, realSigner)` 覆蓋即可，不需重新部署。

---

## 部署交易 hash

### 階段一：`Deploy`（21 筆，全部 status `0x1`，合計 28,136,813 gas）

```
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | HyperAccessControl | 374,859 | `0xf3b3e06af7de472c1b2cd08c491dac48a932b36caf8a09611e39cd1b47add01c` |
| 2 | CREATE | StubStateManager | 747,549 | `0x587e5d1891796ba4944176026a24a9d1432dec0924a4fef6d59f122c96970cf1` |
| 3 | CREATE | MockUSDT | 499,340 | `0xbc3c4b3b90c2f72bc1ce3a41440b84732fb0dcff28b05f0998e6d2ee8fd1b8cd` |
| 4 | CREATE | RevenuePool | 660,471 | `0xa92d079848028e245314b0adf285a018fa980658b921d67f81fab532a2d05794` |
| 5 | CREATE | ProtocolFeeConfig | 474,100 | `0xcb3e77b49929aebb2786987b0e8bceceaaeb6d83165c5f87feba9ae59c7be808` |
| 6 | CREATE | AssetRegistry | 3,031,931 | `0x48d7c73581bb8884b0bc1610b2670c9076b1ea6ce1fb6b2830ec84208f60d00b` |
| 7 | CREATE | NAVOracle (W2) | 975,498 | `0xeea2cd2f48a8ee59f0128bf4a8bdce4bf21ca14fc13cf7fa6e02ad89fb7e020d` |
| 8 | CREATE | PoRRegistry | 700,436 | `0x701298ab12eabfde3fc46ffbff05587d0710f227f1366f37f6e99e47568dbb30` |
| 9 | CALL | AssetRegistry.registerAsset (S) | 1,076,198 | `0x29642dacfc1ecf8a49676e481da6f23816d016ac29d9665f25c8848cbd8303bd` |
| 10 | CALL | AssetRegistry.registerAsset (J) | 1,076,210 | `0x37ab2fc179cb132aabf932dd7922e06d5ea5455d6cdf5e2f44433827e5ddf701` |
| 11 | CREATE | UnifiedPool impl | 1,906,839 | `0xdb00dd8ae330ccb79409a60103276e7b88b017ecc1e7a650b6987bd3d1486a3d` |
| 12 | CREATE | ERC1967Proxy (UnifiedPool) | 244,670 | `0x3818220ac4ffe5c58ee427b016d42a2fdd5ed189638b965bb90f5541239cd6ae` |
| 13 | CREATE | Queue (W2) | 958,950 | `0xd88213b7469a26f8561b1288b3a4a0ade37184be0f18740a9e677a74ef94a336` |
| 14 | CREATE | ReservePSM | 2,336,141 | `0x1a4cdd2a80f32244fb16d6364b8b4e6bac9f2c055e347bbe7c0cd22584b2d1eb` |
| 15 | CALL | RevenuePool.addAuthorizedSource | 51,702 | `0x7d08894def26f20f7e5b8c64095d41c31a84b4300bddf30533221b4493d41df8` |
| 16 | CALL | ReservePSM.deployWrappedToken | 568,290 | `0x2310524d5d161880e33507667afd353c121e0c450d747c2199ba19a3c429841b` |
| 17 | CREATE | AdapterFactory (W2) | 9,533,626 | `0x6e82aa7cbb50b6f496ce09bb91e0a992a59108610feb693d624f129d4aec0997` |
| 18 | CALL | AdapterFactory.deployRWAAdapter | 2,768,614 | `0xd5da839265b3e594e51b48f63303304084ae575d18261742ff989977deaaa2a6` |
| 19 | CALL | MintBurnController.setTokenAgent(1) | 51,569 | `0x6f5c83ae925ef2e092200e9b949e28bca2f2a842d1ab93abdc16c0290ce29169` |
| 20 | CALL | MintBurnController.setTokenAgent(2) | 51,569 | `0x50c5f95ea9771d20eaa81564b07bde1e45f792caf37f26dfacc6a4f27ffb3499` |
| 21 | CALL | NAVOracle.setSigner | 48,251 | `0x718aaad3c2fd10e49462384d73aca4600685bf6fd5a30f4c9b81401d13ed96d1` |

### 階段二：`DeployW3`（23 筆，全部 status `0x1`，合計 37,689,053 gas）

環境變數：`HYPER_ACCESS_CONTROL=0x495Cfd60…`、`UNIFIED_POOL=0x32AB7fC1…`（proxy）、
`USDT=0x5f3B27f8…`、`PROTOCOL_FEE_CONFIG=0xF1909C1B…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | StateManager | 2,826,928 | `0xeaee0153a1ae0bc2a62cee788ab182b59f96098f6bfc5295e0217133402a0cfa` |
| 2 | CREATE | ClaimRegistry | 476,236 | `0x82367cbefa997017f0acf79106c96e8fefe3c60b9aab16a941ef170ff7c69e29` |
| 3 | CREATE | NAVOracle | 975,498 | `0x799efeb3ccb33d20bd5ac4b154124cca7a0b04415c61d192b6aeaadf3ccae95f` |
| 4 | CREATE | Queue | 958,950 | `0x094be4a5f90f272dbe4efa6da2fdab8135f46c5b1b78677ccbee8a2e7b08dcce` |
| 5 | CREATE | LiquidityBridge | 357,550 | `0xd2edf29540c9a1845faf32acb96def6a7beabea8aa7c88840ac50f691c49ff77` |
| 6 | CREATE | EarnVaultDeployer | 5,304,064 | `0x8365f65870c443de6aaf8fff3695bdffb0da5fced15352140f35155477c4a955` |
| 7 | CREATE | LiquidityEarnVaultDeployer | 5,019,097 | `0x173dc198219649f0956262a88ff46405adbc2ef841e2a6445dbdb0a7b8a8f2ec` |
| 8 | CREATE | VaultFactory | 2,101,263 | `0x885b23cacef27c525a238652d146ec946bbabf5064eacb01341514defeecf2fc` |
| 9 | CREATE | AdapterRegistryFactory | 352,058 | `0x6b389f562d132b725d0f984c419a9eeb7fbfce907ffe092d7545cc86ae30b01b` |
| 10 | CALL | AdapterRegistryFactory.deployRegistry | 256,209 | `0x2c509d9cc7e4965392c3fd91f9da5815a7c88b822b0818bb87c267c5c014b754` |
| 11 | CALL | StateManager.setVaultFactory | 51,862 | `0x5d92c85cbab766429a8a720d38ba3f5f7211a5b7da2f31e92e16456230fb25af` |
| 12 | CALL | VaultFactory.deployVault (Cash) | 6,175,155 | `0x756d7ebfe43b0f310ecc60f989b25d30068d39519d268b7136051d0d9b7f4b39` |
| 13 | CALL | VaultFactory.deployVault (Note) | 6,155,015 | `0x3ed48683502dab2bf35e4b6c532c8725065b5003bd0c8d90197c87de824b1aa2` |
| 14 | CALL | VaultFactory.deployVault (LP) | 5,904,640 | `0x3d8ebe0ba660e38fdc59a09983281a5fac2a520090bbadd15d01a4cc3c0f29fb` |
| 15 | CALL | CashVault.setKeeper | 48,585 | `0x1453d7205d803f4815b233a216a7db563625c70fe415380569c7ea6e1a31b721` |
| 16 | CALL | CashVault.setCurator | 48,348 | `0xa58fd3121a64a519490da6d867208844d2dbe0ff4b5c1c7f35edfbba6dfc512b` |
| 17 | CALL | NoteVault.setKeeper | 48,585 | `0x3bafe7227f315da7b679cc02504cb8f6784f95f6a27cc2fafa0400286e53c29a` |
| 18 | CALL | NoteVault.setCurator | 48,348 | `0x39b8db2cc6e98265b70e439e50104c4e0a9d93814579e98156dfd2adaa999dfb` |
| 19 | CALL | LPVault.setKeeper | 48,585 | `0x9f9f91f5ca96dd2774f75da4ea2c5cb392578800e7d15b965a5528c7cd944ffc` |
| 20 | CALL | LPVault.setCurator | 48,348 | `0xb78c7b8b02e7fc95832cbc4ec8d7156c797d48b9c73ef027cd59f2b9e87c9c5b` |
| 21 | CALL | UnifiedPool.addTrancheVault (Cash) | 147,983 | `0xe3dab5c468e70ca0a4d346edc275adab96416d8b5202dfc67913682b47d21d2a` |
| 22 | CALL | UnifiedPool.addTrancheVault (Note) | 167,895 | `0x06259242633e364f4c807990b6ef83f2acf8573bee0e40803af52f0a7403218d` |
| 23 | CALL | UnifiedPool.addTrancheVault (LP) | 167,851 | `0x3714a5403dcd31b475fe7b69678b533aeac094f6440a450b3b01d2bfc7541719` |

### 階段三：`DeployW4`（26 筆，全部 status `0x1`，合計 20,617,676 gas）

環境變數另加：`STATE_MANAGER=0xF4bBfE2B…`、`QUEUE=0x57BE0984…`、`NAV_ORACLE=0xcEb29fD1…`、
`CASH_VAULT=0x41611748…`、`NOTE_VAULT=0x06747911…`、`LP_VAULT=0x24Ed1116…`，以及
`SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | Settlement | 1,893,043 | `0xbd69c7b25ed866ec1494fe2b8b0f68ade17c313bd520a47896774fa2953ccacf` |
| 2 | CALL | CashVault.setSettlement | 56,657 | `0xcd3eb09957001b320dce9703281d7abe5dc2427d5288ea927d7967fc62a71bf0` |
| 3 | CALL | NoteVault.setSettlement | 56,657 | `0x028aba10f7511bbd3f3d46f9e87f1b6fe00eb237931b85f24c82478a725d66c1` |
| 4 | CALL | LPVault.setSettlement | 56,613 | `0x210b31ee2eb38937aef703b5f6b4f44485f520fa90cd3a2bf95c900759c27585` |
| 5 | CALL | Settlement.setOperator (Cash) | 97,021 | `0xac7ac3e4357a8644598796c06a0129114da644fefeee28dbc9f01ed41dbafa4c` |
| 6 | CALL | Settlement.setThreshold (Cash) | 53,924 | `0x310fd7a943aec5275ca07a35dfc8ac5ed2210257fe056710a4028fcc6eaced15` |
| 7 | CALL | Settlement.setOperator (Note) | 97,021 | `0x8e375a67c85864b9ebbc0033ed5f59af1b473e6aa1c593ff7d003d4537ca197d` |
| 8 | CALL | Settlement.setThreshold (Note) | 53,924 | `0x3dc464c88ad0268b5e28574561070132238abb73848b559d0b4b2cd8e455edc6` |
| 9 | CALL | Settlement.setOperator (LP) | 96,977 | `0x9483e60bd59318f02b22c31fa3aa5c00787c18b455f4bfc2cd16bc5f55096e5d` |
| 10 | CALL | Settlement.setThreshold (LP) | 53,880 | `0x0bcfbf481139dbbf9e23505e3ba11fcb4be87105cd3d1a245e78e56ba97899fe` |
| 11 | CREATE | AdapterFactory | 9,533,626 | `0xc57e1f550e8ec6318a13ec85160db4ec8d11bf50da477c557d042a8b6f960d0c` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | 2,524,226 | `0x742861f65b9ce6e8f4b38fe40f807d0cb37ce44ae7b34eff8d0ce4575080f587` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | 2,524,226 | `0x098a747d06a8a6a3a8773a174a8697d4f3de9bee3376128c1473d336197bd2c7` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | 2,651,573 | `0x75f060d11390d4f0780a2779728b0d815f92fdefe45f14a703beb0e64bc89b6e` |
| 15 | CALL | AdapterRegistry.setAdapterAllowed (Cash) | 48,070 | `0x17c144862d3d7ffed4348f0b07b4281a580ca0768b94fdbd5731e63129d609f2` |
| 16 | CALL | AdapterRegistry.setAdapterAllowed (Note) | 48,082 | `0xe3547486a651202cc0ca1ed9079f498e197bbc1bb8c3cd7e7a2936bdd68b661f` |
| 17 | CALL | AdapterRegistry.setAdapterAllowed (LP) | 48,082 | `0x159821fb0336b59ce251fd87369d6e396465ae15902b8c07006d5f1f18f28c23` |
| 18 | CALL | LPVault.setAdapter | 141,528 | `0x723dcd8fcab791805435a6f1792e70ae3acd8f472862173f3a21c26654aff111` |
| 19 | CALL | CashVault.addAdapter | 119,205 | `0xe35f7a4fce260e0671190df929b57b26e6597855d1f5bbedc215ba934b947f20` |
| 20 | CALL | NoteVault.addAdapter | 119,217 | `0x13ebc2e75daf71be7f48225b2a7b671231d5ffa65bfea00c26c59f81fca0824e` |
| 21 | CALL | CashVault.setUnifiedPool | 55,324 | `0x302d2efb98d6025d2a82177925ec6fdbf4d4041976b9d28ed5b58185842bb52a` |
| 22 | CALL | NoteVault.setUnifiedPool | 55,324 | `0xaaf618df2faed5127d2360687676ecaceaf8ce8705566d863b66e85c46357e99` |
| 23 | CALL | LPVault.setUnifiedPool | 55,280 | `0xc297130b8c721dafe438df3b4a0c2bf4649be159b08e8c68cfd991e5e3f09c57` |
| 24 | CALL | CashAdapter.setDataProvider | 59,421 | `0x462e3324da3240880e29c7fb3c57b1477b20d9f2ee41a6e28ffe5a69b43616b1` |
| 25 | CALL | NoteAdapter.setDataProvider | 59,421 | `0x92bbd386bf1112ae35d5c9cd50ecfe6f10dcb70138fa362053f0deee8bc1f6c6` |
| 26 | CALL | LPAdapter.setDataProvider | 59,354 | `0xcfad3d27680c384eb8d9e60ad7fc7e278a28b513a152ebd49a61246f2ea80f45` |

### 階段四：部署後手動配置（8 筆 `cast send`，全部 status `0x1`，合計 390,882 gas）

| 動作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0xa6e73b375f6213ff81578cb6267c5359206c02bc516424896b080593b43f2371` |
| `CashVault.setGuardian(deployer)` | 48,372 | `0xc7a60fd33b4243279bc95fdf3a91031bbe6ef9c9280877b9d71c08b9069dff44` |
| `NoteVault.setGuardian(deployer)` | 48,372 | `0x4bf6fac54ca849bbed6cf84e2579c0d23a1da4eec002c1442a4b5e9552e3f7ad` |
| `LPVault.setGuardian(deployer)` | 48,438 | `0x049811be667673d7598a0ae82d579043f906e3942b3088d07f465bdd733423e6` |
| `CashVault.setAllocator(deployer)` | 48,349 | `0xe53a9def7e46079970c1d566acd351e8c6266637f415e3b4d9cf64903ff2ca47` |
| `NoteVault.setAllocator(deployer)` | 48,349 | `0x9d4c96650ef5df9fba7d2eecbb0f9ba0253b0f1134642d6c8ba99b37522a83a2` |
| `LPVault.setAllocator(deployer)` | 48,438 | `0x6b998c4ba9a85cf0c0fd8970d2b774fa21a839cfc52d139f72c388f97080d408` |
| **`NAVOracle(W3).setSigner(SToken, deployer)`** | 48,251 | `0xfc678f0bd15794e24bff0be8661986e989c3a6fc013737492fb10ed2b8b53045` |

> **註**：8 筆裡有 6 筆第一次送出時被 RPC 負載平衡後端以 `nonce too low` 拒絕
> （交易未上鏈、未耗 gas，與 v2 遇到的同一個問題）。逐筆自動重送後全部成功，上表是成功的那 8 筆。
> Settlement threshold / operator 與三個 Adapter 的 Data Provider 已由 `DeployW4` 設好，階段四不需再送。
> 相對 v2 多出的第 8 筆就是本次補上的 **W3 NAVOracle signer**。

### 階段五：15 個測試錢包補鑄 MockUSDT（15 筆，全部成功，合計 784,455 gas）

`offchain/scripts/testnet/fundWallets.ts`，每個錢包 `mint` 100,000 USDT。
BNB 部分全部已足額（0/15 需要補），腳本冪等地跳過。

| # | 角色 | tx hash |
|---|---|---|
| 1 | governor | `0x1034ae981f5fc368d02029c8be22dabdc822aaa379d04d53fe535d2a4674353d` |
| 2 | curator | `0x0e34b1aba7d04109e7197bae937ffe4bd01da3a649aa51fa5d47b9cbc0d38ba5` |
| 3 | guardian | `0xe1fc3cc87b267770a37624d0b809102532aa8ad7060039edeedb2279101d8e3c` |
| 4 | allocator | `0xfd8548da9257019fdad2529419b5bc0137189f55c325a9248b2cdd39090d5416` |
| 5 | keeper | `0xd2e63461a40d979954cd3aae270d7c068d569ada735d9bc7c92b54fcc43ce769` |
| 6 | dataProvider | `0x2baf6557f1a6bc7bc462a6f8137e33c0ec84021086122205d1653303b0fd2a3c` |
| 7 | tokenAgent | `0x9e2a5c9ed1c1d20f6f1c273027c06144a33001cbf13df1cb0a594fdfa448f84a` |
| 8 | navSigner | `0xa9bd3e70f48cddccff96cea65e93002b7946c82b84ec199933a85787663cb1d2` |
| 9 | settlementOperator1 | `0x065e5cefbb061ad50592cc6ce6993f7e94685b31875da5939d8fab4b739f8fa5` |
| 10 | settlementOperator2 | `0x31d70bd0f470c67dbd8511c5b79c5e491bc873b1366807797b9a20ba97b90ea8` |
| 11 | settlementOperator3 | `0x1fb1795b07a2abc9e735189f683849c08f1ef89baba113beb5f1af579a9a2883` |
| 12 | settlementOperator4 | `0x2e6a86189c89d2ec7eada6a0a76859c5b1f16a935cd276c1ab6b79cbae711ca5` |
| 13 | settlementOperator5 | `0x3308cce02a3e065d5a36719c12d22ccf790f01a8b9822b16361aad64d83da3a3` |
| 14 | investor1 | `0x066c6e5f850239d4065dc23a1199943d36610fb3e276a14f96dc90981e32b79d` |
| 15 | investor2 | `0x543ac0032c0f7ff985d69d7538a1c63a845d586a9f00f7cd405ef6be25d93b69` |

#### 15 個測試錢包最終餘額（腳本輸出）

```
  idx  role                    address                                       BNB          USDT
------------------------------------------------------------------------------------------------
    0  governor                0x0cc4E413152726e52b611E097155CB7F773ade04       0.102      100000.0
    1  curator                 0x6A44B127ba25A37094B9049A22D4ACB6F2F50d1b       0.002      100000.0
    2  guardian                0x99C9a8Be9cF13fFdB704dE664F408948edFE50f8       0.002      100000.0
    3  allocator               0x361D9b663a9823487F05698Fc3a00D246880aE15       0.002      100000.0
    4  keeper                  0xEF2FF284a2dd06B9D7Be71447334C46c1BAe3AC5       0.002      100000.0
    5  dataProvider            0x43c4395C2B957cd3b6E8D96E15631f33b2768815       0.002      100000.0
    6  tokenAgent              0x0abab1C25fb946a73C35AcB78419c39E3ea011c9       0.002      100000.0
    7  navSigner               0x990A5DFD629F6046c65018d63343226b94F9e921       0.002      100000.0
    8  settlementOperator1     0x8d37C7dd17E50F4570B9cbb09CB39Ea5068d8dc1       0.002      100000.0
    9  settlementOperator2     0xAed6458ecAF8AD16eb93DEbc86DAb4c29f4A5131       0.002      100000.0
   10  settlementOperator3     0xF375Bc84604C363156ac625AED3D453947ae9C0d       0.002      100000.0
   11  settlementOperator4     0xA5b2650263bDd7b907d86A2736e39Ea893dEba65       0.002      100000.0
   12  settlementOperator5     0xaC7025158cBc6A2599Ebb00513A156B4AD1b9675       0.002      100000.0
   13  investor1               0xfaB397Ae958Da055fb9dc8BbfaF73f8Ab73B924E       0.002      100000.0
   14  investor2               0x7797d46Bc3A17f80D262B994DeEDD1E3410e6718       0.002      100000.0
```

USDT 是新部署的 MockUSDT `0x5f3B27f8697B912153F5C48f10f8E0b9D07Ccc4A`；v2 的 MockUSDT
`0x32F7E97d…` 上的餘額在新環境等於不存在。

---

## Gas 與餘額

| 項目 | gas | BNB @ 0.1 gwei |
|---|---|---|
| 階段一 `Deploy`（21 筆） | 28,136,813 | 0.0028136813 |
| 階段二 `DeployW3`（23 筆） | 37,689,053 | 0.0037689053 |
| 階段三 `DeployW4`（26 筆） | 20,617,676 | 0.0020617676 |
| 階段四 部署後配置（8 筆） | 390,882 | 0.0000390882 |
| 階段五 15 錢包補鑄 USDT（15 筆） | 784,455 | 0.0000784455 |
| **合計（93 筆）** | **87,618,879** | **0.0087618879** |

- 部署前餘額：`0.206008341760000000` BNB
- 部署後餘額：`0.197246453860000000` BNB
- 實際扣除：`0.008761887900000000` BNB（與上表加總 **完全吻合**）
- 部署錢包 nonce：526 → 619（93 筆）

---

## 驗證結果

### bytecode

38 個地址逐一 `cast code`，**全部非空（0 empty / 38）**，位元組數見上面地址表，
且與本 commit `forge build --sizes` 的本地 artifact 長度逐一吻合。

### 用 `cast call` 實測，不用 bytecode grep

> **為什麼不用 grep**：optimizer 不會把 custom error selector 實體化成 runtime bytecode 裡的常數，
> 純 grep 會對 `SelfDestinationNotAllowed()`（`0xb02bec7a`）之類的 selector 產生**偽陰性**。
> 以下全部改用 `cast call`（eth_call 模擬，不花 gas）實際執行，並帶對照組。
>
> **判讀規則**：函式不存在 → dispatch 落空 → **空 revert data `0x`**；
> 函式存在但業務邏輯擋下 → **具體的 error selector**（非空）。

#### 改動 1 — `BaseVault.getDepositRequest(uint256)` 新增

`getDepositRequest(999999)`，selector `0x64b4c310`：

| 目標 | 結果 | 結論 |
|---|---|---|
| **新** CashVault `0x41611748…` | 回傳 6 words 全零 struct（`state == 0`） | 已加入 ✅ |
| **新** NoteVault `0x06747911…` | 回傳 6 words 全零 struct | 已加入 ✅ |
| **新** LPVault `0x24Ed1116…` | 回傳 6 words 全零 struct | 已加入 ✅ |
| **對照組** v2 CashVault `0x8864a30c…` | revert，**空 revert data `0x`** | v2 沒有 ✅ |
| **對照組** v2 NoteVault `0x93Ec063E…` | revert，**空 revert data `0x`** | v2 沒有 ✅ |
| **對照組** v2 LPVault `0xeE554003…` | revert，**空 revert data `0x`** | v2 沒有 ✅ |

`getRedeemRequest` **刻意不存在**（就是它讓 `EarnVaultDeployer` 超出 EIP-170）——
`grep -rn "function getRedeemRequest" src/` 無結果。

#### 改動 2 — `AssetRegistry` metadata URI

| 呼叫 | 新 AssetRegistry `0xf856c633…` | 對照組：v2 AssetRegistry `0x971c0EaA…` |
|---|---|---|
| `metadataURIOf(1)` `0x31e88988` | 回傳 ABI-encoded 空字串（offset `0x20`, len `0`） ✅ | 空 revert `0x`（無此函式） ✅ |
| `setMetadataURI(1, "ipfs://x")` `0x087dce94` | eth_call 成功（回傳 `0x`，void） ✅ | 空 revert `0x` ✅ |

（`setMetadataURI` 只做 eth_call 模擬，**沒有實際上鏈寫入**，所以鏈上 `metadataURIOf(1)` 仍是空字串。）

#### `registerAsset` selector 必須沒被 metadata 改動波及

| 檢查 | 結果 |
|---|---|
| `cast sig "registerAsset(bytes32,string,string,uint8,uint8)"` | `0x96beed42` — **與 v2 相同，未變** ✅ |
| 新 AssetRegistry 實測 `registerAsset(...)` | 成功回傳 assetId `3`（接在 demo 資產 1、2 之後） ✅ |

#### 改動 5 — `createBuyOrder` destination 守衛

以 Curator（部署錢包）身分 eth_call：

| 呼叫 | 結果 |
|---|---|
| CashAdapter `createBuyOrder(1, <自己>, 0)` | revert `0xb02bec7a` = `SelfDestinationNotAllowed()` ✅ |
| NoteAdapter `createBuyOrder(1, <自己>, 0)` | revert `0xb02bec7a` ✅ |
| LPAdapter `createBuyOrder(1, <自己>, 0)` | revert `0xb02bec7a` ✅ |
| CashAdapter `createBuyOrder(1, address(0), 0)` | revert `0xd92e233d` = `ZeroAddress()` ✅ |

#### 改動 12 — `fundAdapter` / `recallAdapter` 資金通道

| 目標 | `fundAdapter(address,uint256)` `0xe4dc450c` | `recallAdapter(address,uint256)` `0xe07c439b` |
|---|---|---|
| CashVault | revert `0xdfc24d3d` = `AdapterNotFound(address)` → **PRESENT** ✅ | revert `0xdfc24d3d` → **PRESENT** ✅ |
| NoteVault | revert `0xdfc24d3d` → **PRESENT** ✅ | revert `0xdfc24d3d` → **PRESENT** ✅ |
| LPVault | revert `0xdfc24d3d` → **PRESENT** ✅ | revert `0xdfc24d3d` → **PRESENT** ✅ |

（探測時故意傳一個不屬於該 vault 的 adapter 位址，所以停在 `AdapterNotFound`——
重點是**有具體 error、不是空 revert**，證明 dispatch 命中。）

#### `NAVOracle.updateNAV` selector 未變

| 檢查 | 結果 |
|---|---|
| `cast sig "updateNAV(address,uint256,uint256,bytes)"` | `0x305ffd2c` — **與 v2 相同，未變** ✅ |
| W3 NAVOracle `0xcEb29fD1…` 實測 | revert `0xe74c68bb` = `UnauthorizedSigner(address)` → **PRESENT** ✅ |

#### 移除項：`LiquidityAdapter.bridgeToCash` / `RWAToken.controllerTransfer`

| 目標 | 呼叫 | 結果 |
|---|---|---|
| **新** LPAdapter `0xEd195b14…` | `bridgeToCash(1)` `0x715e3bf4` | 空 revert `0x` → 已移除 ✅ |
| **新** LPAdapter（控制組） | `liquidityBridge()` | 正常回傳 `0x0`（函式仍在，證明合約會回應） ✅ |
| **新** SToken `0x9B78Dee6…` | `controllerTransfer(...)` `0x2dc990dd` | 空 revert `0x` → 已移除 ✅ |
| **新** JToken `0x41cEFeb5…` | `controllerTransfer(...)` | 空 revert `0x` → 已移除 ✅ |
| **新** SToken（控制組） | `name()` | 正常回傳 ✅ |

> **對照組要用 v1，不能用 v2**：這兩項移除是在 **v2** 就做掉的，所以 v2 那一代同樣是空 revert
> （已實測確認），拿 v2 當對照組證明不了東西。改用 **v1** 世代做正向對照，
> 確認這個探測方法確實能分辨「函式存在」：
>
> | v1 對照組 | 結果 |
> |---|---|
> | v1 LPAdapter `0xDBf5519F7aA37B88e0ba4e7BEC6422AD97e5f5b4` `bridgeToCash(1)` | revert `0x98b54057`（`NotVault`）→ **PRESENT**，方法有效 ✅ |
> | v1 SToken `0x862DeBcA4F1A8f293157621B8F37988BeEDF51dB` `controllerTransfer(...)` | revert `0x23019e67`（`NotController`）→ **PRESENT**，方法有效 ✅ |

#### 改動 3 — `Settlement.submitBatch` 兩階段拆分

拆分發生在 `submitBatch` **內部**（Phase A 先對批次內全部 Vault 定價，Phase B 才依 caller 給的順序 settle），
不是新增外部函式，因此外部 selector `0x49644637` 不變。鏈上證據是 bytecode 增量：

```
v2 Settlement 0xB30370ab… : 8401 bytes
v3 Settlement 0xF2f95496… : 8499 bytes   (+98)
```

### 連線狀態抽查（`cast call`）

```
ProtocolFeeConfig.paymentTokenOf(Stable)  = 0x5f3B27f8697B912153F5C48f10f8E0b9D07Ccc4A  (新 MockUSDT)
ProtocolFeeConfig.revenuePool()           = 0x101Ff50EAC13fE153d4B00095F8281bE2b957620
AssetRegistry.mintBurnController()        = 0xcc7c7F30feFAb7D8eA107C73ad2db576B92a7a20
AssetRegistry.metadataURIOf(1)            = ""   (尚未寫入，函式可讀)
StateManager.vaultFactory()               = 0x2F3Eb06ce79A25A7c9F5FBdD7c794ce6Ef66a6AD
Settlement.sm()                           = 0xF4bBfE2B65bdd67A5B382Ff7680dAadD264F96D5
Settlement.unifiedPool()                  = 0x32AB7fC13704856166a8B5A0d5d8Bd590350c3Df
Settlement.queue()                        = 0x57BE09846Db8Be64EbedD6A63ae0507c7413A8B4  (W3 Queue)
W3 Queue.sm()                             = 0xF4bBfE2B65bdd67A5B382Ff7680dAadD264F96D5  (真 StateManager)
W2 Queue.sm()                             = 0x24e55CdD37da8C9eBd2B022BD68CaBFf1780c181  (Stub)
AdapterRegistry.registryOwner()           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
AdapterRegistryFactory.isRegistry(shared) = true
W4 AdapterFactory.isAdapter(cashAdapter)  = true
W2 AdapterFactory.isAdapter(cashAdapter)  = false
W2 RWAAdapter.navOracle()                 = 0x2A7F694B0abeD7191Ee9C1275D3aE46Efc5392E7
LPVault.adapter()                         = 0xEd195b141b4AF0Abb110559d7C30fC5421e3b9d7
MockUSDT.symbol()/decimals()              = "USDT" / 6
```

三個 Vault 一致：

```
owner              = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
curator            = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
guardian           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
allocator          = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
isKeeper(deployer) = true
settlement         = 0xF2f95496fBeD28A178F5a42af698cf657b8fd155
unifiedPool        = 0x32AB7fC13704856166a8B5A0d5d8Bd590350c3Df
adapterRegistry    = 0x555dd152A0d0229E5C6bE3d5B3A891B1eaFfe9E7
queue              = 0x57BE09846Db8Be64EbedD6A63ae0507c7413A8B4
Settlement.threshold(vault)            = 1
Settlement.isOperator(vault, deployer) = true
```

各自的 VaultTimelock：Cash `0x1e6e80C4…`、Note `0x18997598…`、LP `0x3c6f2Ca2…`

三個 Adapter 的 `dataProvider()` 全部 = `0x425beB70d264362E4eb7953C4f7aFBDe01145538`，
`vault()` 各自指回自己的 Vault，`asset()` 全部 = 新 MockUSDT。

---

## 角色配置狀態

### 已配置（全部指向部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`）

| 角色 | 範圍 | 值 |
|---|---|---|
| Governor | HyperAccessControl | 部署錢包 |
| Issuer | AssetRegistry（demo 資產 1、2 的 owner） | 部署錢包 |
| Token Agent | MintBurnController，資產 1 與 2 | 部署錢包 |
| NAV Signer | NAVOracle **W2 `0x2A7F694B…`**（腳本設定，對 SToken） | 部署錢包 |
| NAV Signer | NAVOracle **W3 `0xcEb29fD1…`**（本次補設，對 SToken） | 部署錢包（**暫時值**） |
| Vault Owner | Cash / Note / LP | 部署錢包 |
| Curator | Cash / Note / LP | 部署錢包 |
| Guardian | Cash / Note / LP | 部署錢包 |
| Allocator | Cash / Note / LP | 部署錢包 |
| Keeper | Cash / Note / LP | 部署錢包 |
| Data Provider | Cash / Note / LP Adapter | 部署錢包 |
| Settlement Operator | Cash / Note / LP，threshold = 1 | 部署錢包（1-of-1） |
| Registry Owner | 共用 AdapterRegistry | 部署錢包 |
| Fee payment token | ProtocolFeeConfig，`Stable`(kind=2) | 新 MockUSDT `0x5f3B27f8…` |

**全部設成部署錢包是刻意的**：客戶的正式角色名單還沒給我們，這一步只是讓環境單錢包可用。
所有這些角色都可由 Owner／Governor 隨時改，改的時候不需要重新部署。

### 尚未配置（等客戶名單）

- **Settlement 3-of-5 多簽**：目前是 1-of-1（threshold=1、operator 只有部署錢包）。
  客戶給 5 個 operator 位址後，以 Vault Owner 身分對每個 Vault 呼叫
  `Settlement.setOperator(vault, op, true)` ×5 再 `Settlement.setThreshold(vault, 3)`。
- **Curator / Guardian / Allocator / Keeper 的正式持有人**：`offchain/scripts/testnet/ROLE_ASSIGNMENT.md`
  裡的 15 錢包分配表只是建議版，尚未套用到這一代合約上。
- **PoRRegistry proof publisher**：本次沒有設定。
- **NAVOracle signer 的正式名單**：W2／W3 兩顆目前都指向部署錢包，屬暫時值。
- **`lpAdapter.setBridgeTarget(liquidityBridge, cashVault)`**：依 `DeployW4` 註解，這屬於 Curator
  的初始參數設定，不是部署步驟，因此腳本與本次都沒有呼叫（現在 `LPAdapter.liquidityBridge()` = `0x0`）。
- **`AssetRegistry.setMetadataURI`**：函式已可用但本次沒有實際寫入任何 URI（僅做 eth_call 驗證）。

---

## 同步更新的檔案

- `docs/deployment-bsctestnet-2026-08-17-v2.md` — 開頭加上「已作廢／被本文件取代」標註
- `offchain/scripts/testnet/addresses.bscTestnet.json` — 換成本次新地址
- `control-panel/config.js` / `control-panel/deployments.json` — 由 `Deploy` 階段自動重寫（只含 W1/W2 那批地址）
- `control-panel/deployments-w3.json` / `deployments-w4.json` — 由對應階段自動重寫

`script/Deploy.s.sol` 與 `offchain/scripts/testnet/config.ts` 本次**未改動**。

---

## 補充：UnifiedPool StateManager 修正（2026-08-17，部署後）

本代部署完成後發現 `UnifiedPool` 綁錯 StateManager，已透過 UUPS 升級就地修正。
**Proxy 位址不變（`0x32AB7fC13704856166a8B5A0d5d8Bd590350c3Df`），上面的地址表全部仍然有效。**

### 問題

`DeployW3` 在 W1/W2 階段建立 UnifiedPool proxy，當時只有 `StubStateManager` 存在。
該 stub 不註冊任何 Vault，而 `UnifiedPool.sm` 在 `initialize()` 寫入一次後沒有 setter，
因此 `receiveVaultPrincipal`（以及 `BaseVault.returnPrincipalToPool`）對三顆 Vault 永遠
revert `UnregisteredVault`。

這與 W3 必須重新部署 Queue、ClaimRegistry 是同一個限制，UnifiedPool 當時被遺漏。
影響範圍有限：`distribute()` 檢查的是 `vaultConfigured` 而非 `sm`，所以 Settlement 批次不受影響，
只有 Vault→Pool 的本金返還路徑失效。

### 修正

新增 `UnifiedPool.reinitializeStateManager`（`reinitializer(2)`，Governor 限定），
透過既有的 `upgradeToAndCall` 執行。未新增任何 state variable，storage layout 不變。

| 項目 | 值 |
| --- | --- |
| 新 implementation | `0x0d188f359c73A2ecD2ebA03Ac803454af3817c8a` |
| implementation 部署 tx | `0xf77820ba3991f7a7a60419892ca001ac95c1ab448175a6e16383725ba73c9d72` |
| `upgradeToAndCall` tx | `0x65c15dfe15f0f067b63aada512c4a444cfebcb6d4ae71374db578bde10713a86` |
| 區塊 | 125579781 |
| gasUsed | 60,799 |
| 舊 implementation | `0x8c642eEd1b83045622151680D5A60C5511a67464` |

### 升級後驗證（已於鏈上確認）

- `UnifiedPool.sm()` = `0xF4bBfE2B65bdd67A5B382Ff7680dAadD264F96D5`，與 `Settlement.sm()` 一致
- `pool.usdt()`、`pool.totalPending()` 未變動
- Cash / Note / LP 三顆 Vault：`vaultConfigured` = true 且 `StateManager.registeredVaults` = true
- 事件：`Upgraded`、`StateManagerUpdated(stub → real)`、`Initialized(2)`

`reinitializeStateManager` 為一次性，已用掉；再次呼叫會 revert `InvalidInitialization`。

### 對下一代部署的影響

`script/Deploy.s.sol` 已修改：UnifiedPool 改為在 **W3** 階段部署（與真正的 StateManager 同時），
一次就 initialize 正確，不再呼叫 `reinitializeStateManager`。連帶影響環境變數：

- `DeployW3` 新增輸入 `REVENUE_POOL`，不再需要 `UNIFIED_POOL`
- `UNIFIED_POOL` 改為 **W3 的輸出**，`DeployW4` 從 W3 的輸出讀取
