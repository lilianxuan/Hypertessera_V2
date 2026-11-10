# BNB Smart Chain Testnet 全新部署紀錄 v2（2026-08-17）

> ## ⚠️ 已作廢 — 本文件已被 v3 取代
>
> 本文件記錄的 chainId 97 地址**全部作廢，請勿再使用**。
> 現行可用的一代請看 **[`deployment-bsctestnet-2026-08-17-v3.md`](./deployment-bsctestnet-2026-08-17-v3.md)**
> （commit `36809f2`）。
>
> v3 重新部署的原因：`BaseVault.getDepositRequest`、`AssetRegistry.setMetadataURI`/`metadataURIOf`、
> `Settlement.submitBatch` 兩階段拆分、`EarnVault.deposit` 定價順序修正、EIP-1271、
> `markRefundable` 事件、`fundAdapter`/`recallAdapter`、`realAssets` 計入閒置餘額等改動落在
> Vault／Asset／Settlement 層，immutable 連鎖使部分替換做不到。
>
> v2 的合約仍留在鏈上，本文件保留作為 v3 驗證時的**對照組**用途。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署錢包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三個 Vault 的 Owner）
- **原始碼 commit**：`af3d3db`（分支 `feat/testnet-integration-prep`）
- **腳本**：`script/Deploy.s.sol`，依序執行 `Deploy` → `DeployW3` → `DeployW4`，全部帶 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **取代**：[`deployment-bsctestnet-2026-08-17.md`](./deployment-bsctestnet-2026-08-17.md)（commit `4501efa`）。**那一代 chainId 97 地址全部作廢。**

## 這次相對上一版改了什麼

上一版部署（commit `4501efa`）之後合約又動了四處，其中兩處落在 Vault／Asset 層，
因此必須整代重新部署：

| # | 改動 | commit | 影響層 |
|---|---|---|---|
| 1 | `BaseAdapter.createBuyOrder` 新增守衛：拒絕 `destination == address(this)`（`SelfDestinationNotAllowed`）與 `address(0)`（`ZeroAddress`） | `11c79fc` | Adapter |
| 2 | `LiquidityAdapter` 刪除無法觸達的 `bridgeToCash` / `recallCashTokens` / `cashTokenBalance`，`realAssets()` 覆寫一併移除 | `93ecc5e` | Adapter |
| 3 | `LiquidityEarnVault` 合約 NatSpec 改寫（純註解，但會改變 metadata hash → bytecode 改變） | `9acf8cb` | **Vault** |
| 4 | `RWAToken` 移除 ERC-1644 的 `controllerTransfer` | `79703a2` | **Asset** |

### 為什麼部分替換做不到

immutable / 一次性設定形成連鎖：

- 改動 3 動到 `LiquidityEarnVault` bytecode → `LiquidityEarnVaultDeployer` 變 →
  `VaultFactory`（deployer 位址 immutable）變 → `StateManager.setVaultFactory` 是一次性的
  （重設會 revert `VaultFactoryAlreadySet`）→ 只能重新部署 `StateManager`
- `Queue.sm` 是 immutable，`Settlement.{sm, unifiedPool, queue}` 全是 immutable →
  `StateManager` 換了，`Queue` 與 `Settlement` 也必須跟著重來
- 改動 4 動到 `RWAToken` → `AssetRegistry.mintBurnController` 是 immutable 且在建構子裡 `new`
  出來 → Asset 層也只能整組重來
- 改動 1、2 動到 `BaseAdapter` / `LiquidityAdapter` → 帶動 `AdapterFactory`

所以整代重來。

### 腳本改動

**本次沒有改動 `script/Deploy.s.sol`。** 上一版已經把 `AdapterRegistryFactory` 加進 `DeployW3`，
這次直接沿用。三個階段都是一次跑成功，沒有遇到腳本 bug。

---

## 完整地址表

### 前端 `deployments.js` 可直接貼入的區塊（24 個 key）

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: 'af3d3db',
    addresses: Object.freeze({
      hyperAccessControl: '0x82c56b7b1a072C4B4B6103D3a9F03F461B929D3e',
      stateManager: '0xedf762804478E7f9cb7063FA4c01A0FA13D0Cda4',
      navOracle: '0x64A3F86255d4Cf1fd59514FA4df6bc37F6318a59',
      mintBurnController: '0x5d766d3f8fB3E13b6804C44890e96716Ad541947',
      assetRegistry: '0x971c0EaAb2F92A07C177393A3f7944787ACea400',
      protocolFeeConfig: '0x7206Ea20F57f7383D3ac345c37c23B75448bEeF0',
      reservePSM: '0x66e187b8369EDdDe312A8ba260BC556Ceb8939dA',
      poRRegistry: '0x94966cFfAD27eF4D10163c44c00F243214869262',
      queue: '0x34779E72f7Ec7f1b4F034163095b8351bBe9f160',
      revenuePool: '0x9b51bEAF11924B3C659abf82E49d3Dc0E286f2d7',
      unifiedPool: '0x343bbCcf31030D8c7252fF5D9D9f6b8925E8Bd08',
      settlement: '0xB30370ab27d4CBe6B3F7C876C843787FfeAa4998',
      vaultFactory: '0xb9E07A8E96A852CE1c486c427fCaA4cc934deCf7',
      adapterFactory: '0xE3A8e887332eBED30Ca7d94824c53E068367805e',
      adapterRegistry: '0x3f4c6ec92557ca8A533e798961559946212CD1c6',
      adapterRegistryFactory: '0x4eB2F5bCd344eD5dC00d20AFE0869b5AEdfE9C51',
      liquidityBridge: '0x617E26724BfDd46916E3c4f31fbD3d98f4D147c5',
      mockUsdt: '0x32F7E97d1c7a47453c79787f498C82894Ac92578',
      cashVault: '0x8864a30cfB12c18AB580BBb19E5cb23107b000C7',
      noteVault: '0x93Ec063E98d9C19a89AFD944B28c7e5c17d9F7f6',
      lpVault: '0xeE5540030FEca45d28f5c5Dd4729ADC49CcCFEAc',
      cashAdapter: '0x0fBb0162aB92e116Edf7d1712E60C349D348Ca41',
      noteAdapter: '0x3c01F0999a603F60073c5B4BA6028EeB225B6A6a',
      lpAdapter: '0xD02ccA5f0A963F3Cc98e49b3979178Ad4f509f93',
    }),
  }),
});
```

### 全部地址 + bytecode 位元組數

逐一以 `cast code <addr> --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545` 取回並計算長度，
**全部非空（38/38）**。「Δ」欄是相對上一版的位元組差。

| 階段 | 合約 | 地址 | bytecode | Δ vs v1 |
|---|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0x82c56b7b1a072C4B4B6103D3a9F03F461B929D3e` | 1109 bytes | 0 |
| Deploy | StubStateManager | `0x1991fEF28C344DFb1e34c8D6516F808A61691790` | 3201 bytes | 0 |
| Deploy | MockUSDT | `0x32F7E97d1c7a47453c79787f498C82894Ac92578` | 1720 bytes | 0 |
| Deploy | RevenuePool | `0x9b51bEAF11924B3C659abf82E49d3Dc0E286f2d7` | 2797 bytes | 0 |
| Deploy | ProtocolFeeConfig | `0x7206Ea20F57f7383D3ac345c37c23B75448bEeF0` | 1827 bytes | 0 |
| Deploy | AssetRegistry | `0x971c0EaAb2F92A07C177393A3f7944787ACea400` | 9132 bytes | **−353** |
| Deploy | MintBurnController | `0x5d766d3f8fB3E13b6804C44890e96716Ad541947` | 3427 bytes | 0 |
| Deploy | NAVOracle（W2 那顆，前端不用） | `0xafA6FDe285B06Bd3922a2393aeb927C4a46270Cd` | 3983 bytes | 0 |
| Deploy | PoRRegistry | `0x94966cFfAD27eF4D10163c44c00F243214869262` | 2985 bytes | 0 |
| Deploy | SToken / RWAToken（demo 資產 1） | `0xb77A4EfA88D9999277f3548d3BB311Ef025B7330` | 4202 bytes | **−346** |
| Deploy | JToken（demo 資產 2） | `0x2F2c3D14A2783B91e346F188E758B9d7Fc9b91b7` | 4202 bytes | **−346** |
| Deploy | UnifiedPool implementation | `0xCAb867442d24Aa2D396d1a540570e4e6bcBB1268` | 8451 bytes | 0 |
| Deploy | **UnifiedPool（ERC1967 proxy，用這個）** | `0x343bbCcf31030D8c7252fF5D9D9f6b8925E8Bd08` | 163 bytes | 0 |
| Deploy | Queue（W2 那顆，綁 StubStateManager，前端不用） | `0xf36974e80aBd49343f7FA00dB6FF5B2B01734565` | 4178 bytes | 0 |
| Deploy | ReservePSM | `0x66e187b8369EDdDe312A8ba260BC556Ceb8939dA` | 10577 bytes | 0 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0xbF17ED38548F77d63d8F8615fD959c0716bED30A` | 1366 bytes | 0 |
| Deploy | RWAAdapter（W2 demo） | `0x7330b491C6188796DE549EE8cE42bFCf5110db03` | 13014 bytes | **+80** |
| DeployW3 | **StateManager** | `0xedf762804478E7f9cb7063FA4c01A0FA13D0Cda4` | 12693 bytes | 0 |
| DeployW3 | ClaimRegistry | `0xcD6408feB20fDe998952d8d8a2970bA2E1d17095` | 1946 bytes | 0 |
| DeployW3 | **NAVOracle** | `0x64A3F86255d4Cf1fd59514FA4df6bc37F6318a59` | 3983 bytes | 0 |
| DeployW3 | **Queue** | `0x34779E72f7Ec7f1b4F034163095b8351bBe9f160` | 4178 bytes | 0 |
| DeployW3 | LiquidityBridge | `0x617E26724BfDd46916E3c4f31fbD3d98f4D147c5` | 1291 bytes | 0 |
| DeployW3 | EarnVaultDeployer | `0xEf0a2Ba6c42999b785669AB14842a803e09d7867` | 23971 bytes | 0 |
| DeployW3 | LiquidityEarnVaultDeployer | `0x5423B299A968b858647fB32559CD5219546A85f6` | 22654 bytes | 0 |
| DeployW3 | VaultFactory | `0xb9E07A8E96A852CE1c486c427fCaA4cc934deCf7` | 9373 bytes | 0 |
| DeployW3 | AdapterRegistryFactory | `0x4eB2F5bCd344eD5dC00d20AFE0869b5AEdfE9C51` | 1383 bytes | 0 |
| DeployW3 | AdapterRegistry（共用，由工廠產出） | `0x3f4c6ec92557ca8A533e798961559946212CD1c6` | 777 bytes | 0 |
| DeployW3 | CashVault (EarnVault, htCASH) | `0x8864a30cfB12c18AB580BBb19E5cb23107b000C7` | 22139 bytes | 0 |
| DeployW3 | NoteVault (EarnVault, htNOTE) | `0x93Ec063E98d9C19a89AFD944B28c7e5c17d9F7f6` | 22139 bytes | 0 |
| DeployW3 | LPVault (LiquidityEarnVault, htLP) | `0xeE5540030FEca45d28f5c5Dd4729ADC49CcCFEAc` | 20675 bytes | 0（長度同，metadata hash 已變，見下） |
| DeployW3 | CashVaultTimelock | `0xDE81c6A5490a3377ea8a86F6A8116aa173Fd69C2` | 5045 bytes | 0 |
| DeployW3 | NoteVaultTimelock | `0x71CB43abcD9F8123Fd93B38Ad92934C85c5783B1` | 5045 bytes | 0 |
| DeployW3 | LPVaultTimelock | `0x6f4874B9888F94410272F0C389Bf57D1318F1f79` | 5045 bytes | 0 |
| DeployW4 | Settlement | `0xB30370ab27d4CBe6B3F7C876C843787FfeAa4998` | 8401 bytes | 0 |
| DeployW4 | AdapterFactory | `0xE3A8e887332eBED30Ca7d94824c53E068367805e` | 1366 bytes | 0 |
| DeployW4 | CashAdapter (FirstPeriodAdapter) | `0x0fBb0162aB92e116Edf7d1712E60C349D348Ca41` | 11807 bytes | **+80** |
| DeployW4 | NoteAdapter (FirstPeriodAdapter) | `0x3c01F0999a603F60073c5B4BA6028EeB225B6A6a` | 11807 bytes | **+80** |
| DeployW4 | LPAdapter (LiquidityAdapter) | `0xD02ccA5f0A963F3Cc98e49b3979178Ad4f509f93` | 12442 bytes | **−1135** |

位元組差完全對得上四項改動：Asset 層 −346（`controllerTransfer` 移除）、Adapter 層 +80
（新增兩個守衛）、`LiquidityAdapter` −1135（三個函式 + `realAssets()` 覆寫移除）。

`UnifiedPool` proxy 只有 163 bytes 是正常的——ERC1967Proxy 本體就這麼小，實作在
`0xCAb86744…`。前端／SDK 一律用 proxy 位址 `0x343bbCcf…`。

### 重複合約的釐清

部署腳本三階段會產生兩個 `NAVOracle`、兩個 `Queue`、兩個 `AdapterFactory`。
以鏈上呼叫判定實際接線的那一份：

| 合約 | 實際接線（用這個） | 另一份（不要用） | 判定依據（`cast call`） |
|---|---|---|---|
| `Queue` | **`0x34779E72…`**（W3） | `0xf36974e8…`（W2，綁 StubStateManager） | `Settlement.queue()` = `0x34779E72…`；`CashVault/NoteVault/LPVault.queue()` 三個都 = `0x34779E72…`；`W3 Queue.sm()` = `0xedf76280…`（真 StateManager），`W2 Queue.sm()` = `0x1991fEF2…`（Stub） |
| `AdapterFactory` | **`0xE3A8e887…`**（W4） | `0xbF17ED38…`（W2 demo） | `W4 AdapterFactory.isAdapter(cashAdapter)` = `true`、`isAdapter(lpAdapter)` = `true`；`W2 AdapterFactory.isAdapter(cashAdapter)` = `false` |
| `NAVOracle` | **`0x64A3F862…`**（W3，前端 key 用這個） | `0xafA6FDe2…`（W2，供 W2 demo RWAAdapter） | `W2 RWAAdapter.navOracle()` = `0xafA6FDe2…`；`W2 NAVOracle.signerOf(SToken)` = 部署錢包，`W3 NAVOracle.signerOf(SToken)` = `0x0` |

**注意**：兩個 `NAVOracle` 跟上一版一樣是「兩顆都活著、各管各的」。前端 key `navOracle` 沿用
W3 那顆 `0x64A3F862…`（它是 Vault 世代的一部分），但它目前**還沒有設定任何 signer**；
`Deploy` 階段的 `nav.setSigner(sToken, governor)` 設在 W2 那顆上。等實際要用 W3 NAVOracle
推 NAV 時，需要先呼叫 `setSigner`。

---

## 部署交易 hash

### 階段一：`Deploy`（21 筆，全部 status `0x1`，合計 27,926,129 gas）

```
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | HyperAccessControl | 374,859 | `0x681b44c2dfb8099155a56f70bb5446d431158576a42773eeb55680954d849db8` |
| 2 | CREATE | StubStateManager | 747,549 | `0xc2f0a3730ad27576ff1f72550dd4fae207bd35f32504a4d8fff900ac57cb1846` |
| 3 | CREATE | MockUSDT | 499,340 | `0x1d39216516e7bf824b6d150b1fc9b2adfde6e63c28f0f5829f1229668da730cd` |
| 4 | CREATE | RevenuePool | 660,471 | `0x5227c2db96c32a6aaaa9fd7731fe96272ce5422b85cc76db384724275c60f4e4` |
| 5 | CREATE | ProtocolFeeConfig | 474,112 | `0xd72e9e7d8e4ad91fee2b35cde7294bcce6430d6c7ac0115a81cd6a40645025db` |
| 6 | CREATE | AssetRegistry | 2,821,281 | `0x3c25a24ee321c99cc229c49c8bf0980ea09f604058a42c7dd90efebdd15fd85d` |
| 7 | CREATE | NAVOracle (W2) | 975,498 | `0xf9b518656e5d2ac60b9a2ce871e3da6a7cb9f7c441de5ad349e3eea1e825276f` |
| 8 | CREATE | PoRRegistry | 700,412 | `0xe16f05d393f922a47792af4b486b6c68fa5028fe589deef9b831ef02c77fb545` |
| 9 | CALL | AssetRegistry.registerAsset (S) | 1,076,226 | `0xf56e03a832f4af5907f08cecff879eb3520ebb437184379f194dbebf1b7db827` |
| 10 | CALL | AssetRegistry.registerAsset (J) | 1,076,238 | `0x9d9fbe51e4373b49e0ab8ae049e1a5275a666dd0c44c0bf1f59e1cb321eb45ee` |
| 11 | CREATE | UnifiedPool impl | 1,906,839 | `0xfa13d614f44410921eb1fc72cde7b43dfc1505f7c5746d1f9dca4e0a205fe627` |
| 12 | CREATE | ERC1967Proxy (UnifiedPool) | 244,670 | `0xea607aa7df0417e942971821ce770c8374b2a3329b32f5a6dc4f7964bea2b489` |
| 13 | CREATE | Queue (W2) | 958,962 | `0xe68db7d1d9cebb96bad43bff99fcb7ce66d7e0f5e14c358fcdb7155924879f67` |
| 14 | CREATE | ReservePSM | 2,336,141 | `0xbd289ca3064c636cf5a9cc07e7819a422d61638016edb9e4ee8c56b091ea0c2d` |
| 15 | CALL | RevenuePool.addAuthorizedSource | 51,702 | `0x26a841820e0ca3663cf09eac8cf95647815916cfd4d32e1f3111e8283588058f` |
| 16 | CALL | ReservePSM.deployWrappedToken | 568,290 | `0x6fe10e40463e3dc4539580d85c233e50d124f9f44831e865a7b6d3cbdf5987e6` |
| 17 | CREATE | AdapterFactory (W2) | 9,533,626 | `0x84a04031e743f8ae2996b8d755b544a72181510ddd4487ae2dd864ce250f3354` |
| 18 | CALL | AdapterFactory.deployRWAAdapter | 2,768,614 | `0x25cc86c6aa7a6e0a994e45623c7b602db04595833ff1b0e0067b9a3865a89e29` |
| 19 | CALL | MintBurnController.setTokenAgent(1) | 51,524 | `0xd3cae9cb8c9c99f452a38e7c2afe34cbe6ee23a9222615764f8fad57102a584f` |
| 20 | CALL | MintBurnController.setTokenAgent(2) | 51,524 | `0x699d2ea4644f4757668e41075e626298d9b726c0adad1f9d66cd62528e50b5e4` |
| 21 | CALL | NAVOracle.setSigner | 48,251 | `0xa07dcb78d16bb862f30105964d7356b67be78e4e4624d25270624996e09bf44d` |

### 階段二：`DeployW3`（23 筆，全部 status `0x1`，合計 37,366,249 gas）

環境變數：`HYPER_ACCESS_CONTROL=0x82c56b7b…`、`UNIFIED_POOL=0x343bbCcf…`（proxy）、
`USDT=0x32F7E97d…`、`PROTOCOL_FEE_CONFIG=0x7206Ea20…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | StateManager | 2,826,928 | `0x81346f183ea03ee9eba4fa30fa8920970e990e281c54d7d15121fde6fae7927a` |
| 2 | CREATE | ClaimRegistry | 476,236 | `0x3d0a188c1b0f791cbae38c5a6d01e817f5193a4f25fca18c98d68a28acad1876` |
| 3 | CREATE | NAVOracle | 975,498 | `0x9843e0fa5734252b13e627211fcc069426f446a3d1fc03278dc3ef31ce56c906` |
| 4 | CREATE | Queue | 958,962 | `0x0d201c21c4320d1e9d215dd1fd362992270bae8f43be4835fb9fd428d8b40976` |
| 5 | CREATE | LiquidityBridge | 357,550 | `0x24f4003ce5f17226421dc9d506d19fdb7f9fe5616cbe4288133a4c5752c2a7f0` |
| 6 | CREATE | EarnVaultDeployer | 5,236,571 | `0xdad4ecaeae8e8daa923e24b0318c319b5ae3b849a46ac8a0a1cb06baef3afcd2` |
| 7 | CREATE | LiquidityEarnVaultDeployer | 4,951,562 | `0x8eb545eaac2cb4e898d7388827efdc4a5388f375caa62c13905969b95861607a` |
| 8 | CREATE | VaultFactory | 2,101,275 | `0x0c234da579b6644e8e11ae62fafc04881775681b7da5ab3393de0847e9432d8e` |
| 9 | CREATE | AdapterRegistryFactory | 352,058 | `0x10991444a5798162efeef94cb3fe6611d32105bcc80741226e3b7f8d21e7f9d0` |
| 10 | CALL | AdapterRegistryFactory.deployRegistry | 256,209 | `0xb4975a50a92c9886eb17e3c968459a76cc6fc4cb39bf17d8fe701e5a00728ffb` |
| 11 | CALL | StateManager.setVaultFactory | 51,862 | `0xbba3dfdeabaf2cea6218afe846dfa3d721ed7e2d615b565279176d9fb895c32b` |
| 12 | CALL | VaultFactory.deployVault (Cash) | 6,112,559 | `0xaa12d68dac6769bbb0545d56938ebfeb8988859b6e50a31d2b56473e1661c0b4` |
| 13 | CALL | VaultFactory.deployVault (Note) | 6,092,419 | `0xa169558be9dc9aec76ba9a12a1fe40b7397a5e3a910a85e51f38bac4020d52c1` |
| 14 | CALL | VaultFactory.deployVault (LP) | 5,842,044 | `0xa8482f9fe81eb7920d38fa224841fee4ca6844a30acc5d4cc38949afe6887ad3` |
| 15 | CALL | CashVault.setKeeper | 48,585 | `0xf2f36e598b2da84d84c4af5fbfc2f550af69d11afbb68c79dde417ad10dbd138` |
| 16 | CALL | CashVault.setCurator | 48,348 | `0x72a9d6a8f400d4e2c12c3ce665ca67957f74ac4f3b994b211edd9b39c8deb9f1` |
| 17 | CALL | NoteVault.setKeeper | 48,585 | `0xbc0b631b5cf52eb3e55704777105f92de01fa0efd90205782867ae0bae31f242` |
| 18 | CALL | NoteVault.setCurator | 48,348 | `0xff294158223ad1bb5ae1dfbc2a0040a0c0bc47546e745580e120349fdf938112` |
| 19 | CALL | LPVault.setKeeper | 48,585 | `0x62e697a11bc1bd153324c92d9aac1b1b391354192cd620eee2b66d155060b4bd` |
| 20 | CALL | LPVault.setCurator | 48,348 | `0xc3f9f22e02df38a5b281bc5c0d0f21b05c09b5bbd06c19714fed11f252b3a907` |
| 21 | CALL | UnifiedPool.addTrancheVault (Cash) | 147,971 | `0x622ec6b7a37033409cbd6acbc14697bab963cbad5603b0243946b9f090efce81` |
| 22 | CALL | UnifiedPool.addTrancheVault (Note) | 167,895 | `0xe99b4ffc31142b102ee5070cf22d076f8cfc52bc51cb752079cd84d9e692cc46` |
| 23 | CALL | UnifiedPool.addTrancheVault (LP) | 167,851 | `0x1db09a3f9514509238e13e2bb9b4e48fab21f0b3ef0562eef81b5c5c7f4d3b9b` |

### 階段三：`DeployW4`（26 筆，全部 status `0x1`，合計 20,596,481 gas）

環境變數另加：`STATE_MANAGER=0xedf76280…`、`QUEUE=0x34779E72…`、`NAV_ORACLE=0x64A3F862…`、
`CASH_VAULT=0x8864a30c…`、`NOTE_VAULT=0x93Ec063E…`、`LP_VAULT=0xeE554003…`，以及
`SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | Settlement | 1,871,860 | `0xdc33d0c13d15429176d56f2103ea35326bd33f43bdb7a1c9bbce45589f50b734` |
| 2 | CALL | CashVault.setSettlement | 56,657 | `0x48a8f38d4fb50512957d2346c38a6385da11b136e66d95783256661b29d026ca` |
| 3 | CALL | NoteVault.setSettlement | 56,657 | `0x1c3494b71e0ae8ea2ce4c87bf65b8dc6a14dd6297a91172c492f56fc8717f873` |
| 4 | CALL | LPVault.setSettlement | 56,613 | `0x04577d47e0b5a68db6be8c5f7c3263e6cd07ec3861e9a56bf94ebe83159a1a01` |
| 5 | CALL | Settlement.setOperator (Cash) | 97,009 | `0x6384d97eff7d7c4983cdcd0e3c2f850e171d6a1412e40bae70902052d0854e24` |
| 6 | CALL | Settlement.setThreshold (Cash) | 53,912 | `0x2fbffb57d214765eb92bd2b12c962b57b20277500aa20e5ce87487b7e7aba1d8` |
| 7 | CALL | Settlement.setOperator (Note) | 97,021 | `0x74af043e47f79b206870c3ec74487b63ec5530401e4257df8a34965e04ab0995` |
| 8 | CALL | Settlement.setThreshold (Note) | 53,924 | `0x9665fdeee535521557ceb7905e85462a646d46c3fc1ea071dc7c8ee2a498d134` |
| 9 | CALL | Settlement.setOperator (LP) | 96,977 | `0x6d5c93463e6cb1701e25513649a76983d4aed3be2b28330f740d7e606a84e12b` |
| 10 | CALL | Settlement.setThreshold (LP) | 53,880 | `0xb28fbb5e44ddafe8d30c54b6f3a78e4b78b9642806f8c1703c1885acd98b0d89` |
| 11 | CREATE | AdapterFactory | 9,533,626 | `0xca5f2253ab5929941b895b4752f0ddbe95deec9b84562dcd11cbe24f2c1a1df6` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | 2,524,214 | `0x1c9af041756ebbef9efbc831a7b609e312d3cc229efb2bc037d752bbb02d4c10` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | 2,524,226 | `0xc2069af22c152cd15da4ef8d87c57957ba0968be1cbb118d7369992cd614d168` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | 2,651,573 | `0x38a616d6b3040fe4d63ce00e010b6debd04f60cf6a10d62d87b0cd917badddea` |
| 15 | CALL | AdapterRegistry.setAdapterAllowed (Cash) | 48,082 | `0xca311906e732e2c37e1dd311a12c524bde23931dce13dce51f43879159c8fae0` |
| 16 | CALL | AdapterRegistry.setAdapterAllowed (Note) | 48,082 | `0x43d0f9a12d4555dd39234d6fdae191a9c83e013c4cb71ff16822f366850d1f42` |
| 17 | CALL | AdapterRegistry.setAdapterAllowed (LP) | 48,082 | `0xcb43f784621e0fa455c9ae06ed33ba448f97e4c564d476a7b4f5b403a03a7b1e` |
| 18 | CALL | LPVault.setAdapter | 141,528 | `0xa2b6faafe8d6b59b9851df9abc32672e826c08eec1cc0bd4949330985ddf88f8` |
| 19 | CALL | CashVault.addAdapter | 119,217 | `0x050edb90a110b38b722826f9cd1e8486c6e0a1d49a35d0190f62110b4d92fd78` |
| 20 | CALL | NoteVault.addAdapter | 119,217 | `0x38733440422bbc402e05f0ce3bdbabf5dc146b47a39e6fb5fce8bce3197b055f` |
| 21 | CALL | CashVault.setUnifiedPool | 55,324 | `0xc6c6dfff44332ea5371cff9d0ce6dc7c8ee6af1230e26d138337fc9769c9bd56` |
| 22 | CALL | NoteVault.setUnifiedPool | 55,324 | `0x78d2b9f473dae2988049e90535fb4ea457f7cbdd2212d56456ac2e5709d8fa71` |
| 23 | CALL | LPVault.setUnifiedPool | 55,280 | `0xab92dd7057671bd464d68c75d9e7cc8bd7cc487ae7ab787c6516eba8dce2ad97` |
| 24 | CALL | CashAdapter.setDataProvider | 59,421 | `0xb1b0c3e62a6d615f4db8846fb5cd65213f57ae9cbb0d8fa74bdb9d4ee795d7b4` |
| 25 | CALL | NoteAdapter.setDataProvider | 59,421 | `0x65badc8327f1ac59aff4e935979613d9c4f201c367354ae03e8fcbc63b93fa54` |
| 26 | CALL | LPAdapter.setDataProvider | 59,354 | `0xf0b2b16b55b2f3c399a88c7937b8630fce7f109407d73e6ed89219d9a04152b2` |

### 階段四：部署後手動配置（7 筆 `cast send`，全部 status `0x1`，合計 342,631 gas）

| 動作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0xe725113d4cd1aa0f9ac5ae735a9bfce0610c9dd9bb1519c372762c35f015da15` |
| `CashVault.setGuardian(deployer)` | 48,372 | `0xa31f4690dbde9175510966e8aa1915ff724b56187bc38bbfd8d12e50d2914888` |
| `NoteVault.setGuardian(deployer)` | 48,372 | `0xf45c5905500a7bdcd6d5cd94377e3ca3c951fe60697e0160adb88f84c2140863` |
| `LPVault.setGuardian(deployer)` | 48,438 | `0x925e794790e26e2ec8c388c2e2f4074b385a9e75ea71779a4f4fa802dd16379d` |
| `CashVault.setAllocator(deployer)` | 48,349 | `0x56dcd9bc92d620440ed0bf7f97a8d02c0efde21cafc3fdb85a2b0f821cb9e6ab` |
| `NoteVault.setAllocator(deployer)` | 48,349 | `0x8f77cd1911e052028d51bbd65ad29506d87ff1d8fefba4699487aafc7ec40246` |
| `LPVault.setAllocator(deployer)` | 48,438 | `0x0f333de59f92f1dc91c4c58e8f2af598cf0916bbe741f74970bb33459cf2115b` |

> **註**：三筆 `setAllocator` 第一次嘗試時，因為 RPC 負載平衡後端回報的 pending nonce 落後，
> 被節點以 `nonce too low` 拒絕（交易未上鏈、未耗 gas）。逐筆重送後全部成功，上表是成功的那三筆。
> Settlement threshold / operator 與三個 Adapter 的 Data Provider 已由 `DeployW4` 設好，
> 因此階段四不需要再送。

### 階段五：15 個測試錢包補鑄 MockUSDT（15 筆，全部成功，合計 784,455 gas）

`offchain/scripts/testnet/fundWallets.ts`，每個錢包 `mint` 100,000 USDT。
BNB 部分全部已足額（0/15 需要補），腳本冪等地跳過。

| # | 角色 | tx hash |
|---|---|---|
| 1 | governor | `0x511fb9b8add5e33356ef8a850efaa30b78263e7284cea875cad9d8ce59b34d44` |
| 2 | curator | `0xcf707f11db68d82218b581fe714eeda66dcd385553cd089194e6c6e871b3f00a` |
| 3 | guardian | `0x6275f330f8892832c909eb57a37a0d927b42c400bc477768ea2a3178a586541c` |
| 4 | allocator | `0xdc4ef265f3bba75912b16e0bd318b8c52ce6d413d8c6abf8ca9fad41f82b72df` |
| 5 | keeper | `0x31c17684b736de645110a1c1d09153f9b73bb1785b1c69500ee4e591a0e0e2ac` |
| 6 | dataProvider | `0x9650338e4a9b9524e09c6cd64ef393f40dd3879f5e6067390ac21976ce6756d3` |
| 7 | tokenAgent | `0x1123146f567638387256f1ca18a1d619f134a77aebea6404f87233adb71ddcfb` |
| 8 | navSigner | `0xc1d27ae1ccae6c69057eb29cb8811ca76186ce51c1e4282a9ed41336fcc4d85b` |
| 9 | settlementOperator1 | `0x4c8eac40ca46e38574f6a03a9f0db75dca3688a3b28d1d5f71d7bef8a83bf1b5` |
| 10 | settlementOperator2 | `0x2b5932c30ea879ab1e3c13dcfccbd671c947ddaebe3284c8d3a2f2d15f9e0b34` |
| 11 | settlementOperator3 | `0x0f5b7f671787868022033b44072c82c435cb0b8aa2b3a3070d490e8a6e9db82b` |
| 12 | settlementOperator4 | `0xd84d5456e36a0fc07264f8a67b8e573dccee284faa1a303c80ce17adf218bdef` |
| 13 | settlementOperator5 | `0x4d4a24ab811ec09b08010c4a28fbf1bf252b4a63d4787daef548d2983275ea7e` |
| 14 | investor1 | `0xfdca0db2e5190f137d0d1efa59fe1664f675a3f84d4c8b270a6f78092591b0c4` |
| 15 | investor2 | `0x0a26e92a8c013a5d43211d071749fee19eb420c82ea2fee7206eed61b941f219` |

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

USDT 是新部署的 MockUSDT `0x32F7E97d1c7a47453c79787f498C82894Ac92578`；舊 MockUSDT
`0x3Baed3ec…` 上的餘額在新環境等於不存在。

---

## Gas 與餘額

| 項目 | gas | BNB @ 0.1 gwei |
|---|---|---|
| 階段一 `Deploy`（21 筆） | 27,926,129 | 0.0027926129 |
| 階段二 `DeployW3`（23 筆） | 37,366,249 | 0.0037366249 |
| 階段三 `DeployW4`（26 筆） | 20,596,481 | 0.0020596481 |
| 階段四 部署後配置（7 筆） | 342,631 | 0.0000342631 |
| 階段五 15 錢包補鑄 USDT（15 筆） | 784,455 | 0.0000784455 |
| **合計（92 筆）** | **87,015,945** | **0.0087015945** |

- 部署前餘額：`0.217502549160000000` BNB
- 部署後餘額：`0.208800954660000000` BNB
- 實際扣除：`0.008701594500000000` BNB（與上表加總 **完全吻合**）
- 部署錢包 nonce：413 → 505

---

## 驗證結果

### bytecode

38 個地址逐一 `cast code`，**全部非空**，位元組數見上面地址表。

### 四項改動的上鏈驗證

驗證用 `cast call`（eth_call 模擬，不花 gas），並與**上一代合約做對照組**，
這比單純 grep bytecode 可靠得多。

> 補充：`SelfDestinationNotAllowed()` 的 selector `0xb02bec7a` **不會**以字面
> byte 出現在 runtime bytecode 裡（optimizer 沒有把它存成常數），所以純 grep 會誤判為
> ABSENT。以下改用實際執行來判定。

#### 改動 1 — `createBuyOrder` 的 destination 守衛

對 `CashAdapter 0x0fBb0162…` 以 Curator（部署錢包）身分做 eth_call：

| 呼叫 | 結果 |
|---|---|
| `createBuyOrder(1, <adapter 自己>, 0)` | **revert `0xb02bec7a`** = `SelfDestinationNotAllowed()` ✅ |
| `createBuyOrder(1, address(0), 0)` | **revert `0xd92e233d`** = `ZeroAddress()` ✅ |
| `createBuyOrder(1, 0x…dEaD, 0)` | 成功，回傳 orderId `0` ✅（守衛沒有誤擋正常路徑） |
| **對照組**：舊 CashAdapter `0x2905E3bE…` 同樣呼叫 destination=自己 | **成功**回傳 `0` — 舊版沒有守衛，證明差異真的來自這次改動 ✅ |

#### 改動 2 — `LiquidityAdapter` 移除橋接腿

| 目標 | `bridgeToCash(uint256)` `0x715e3bf4` | 結論 |
|---|---|---|
| 新 LPAdapter `0xD02ccA5f…` | revert，**空 revert data `0x`**（無此函式，dispatch 落空） | 已移除 ✅ |
| 舊 LPAdapter `0xDBf5519F…`（對照組） | revert `0x98b54057`（函式存在，卡在 `NotVault`） | 舊版仍有 ✅ |

`recallCashTokens(uint256)`（`0x53ed412e`）與 `cashTokenBalance()`（`0x2b3c539b`）在新
LPAdapter 上同樣是空 revert；bytecode grep 三個 selector 也都 ABSENT。
控制組：`liquidityBridge()` 在新 LPAdapter 上正常回傳 `0x0`（函式仍在）。

#### 改動 3 — `LiquidityEarnVault` NatSpec / metadata hash

純註解改動，長度不變，所以用 keccak 比對：

```
new LPVault on-chain len : 20675 bytes
old LPVault on-chain len : 20675 bytes
local artifact      len : 20675 bytes

new on-chain keccak  : 0x825f547a948fe146fe85d9a20426281e4cf3172b8405990da67f627557cde5c1
old on-chain keccak  : 0x4689bf6ab6cb0092b8e831aa3f059cfafdb62dff490612d24e5338ce7505ae45
local artifact keccak: 0x825f547a948fe146fe85d9a20426281e4cf3172b8405990da67f627557cde5c1

MATCH:  新的鏈上 LPVault runtime == 本 commit 的本地 artifact
DIFFER: 與舊世代不同（metadata hash 如預期改變）

尾端 CBOR metadata：
new: ...5d817bb8dfbe45dedfaeb1c992ee8e53869ac37721030d64736f6c63430008180033
old: ...e5329c4b55c2e1cac3a80f04686dc54554971b88c7996d64736f6c63430008180033
```

#### 改動 4 — `RWAToken.controllerTransfer` 移除

| 目標 | `controllerTransfer(address,address,uint256,bytes)` `0x2dc990dd` | 結論 |
|---|---|---|
| 新 SToken `0xb77A4EfA…` | revert，**空 revert data `0x`** | 已移除 ✅ |
| 新 JToken `0x2F2c3D14…` | bytecode grep ABSENT | 已移除 ✅ |
| 舊 SToken `0x862DeBcA…`（對照組） | revert `0x23019e67` = `NotController()` | 舊版仍有 ✅ |

控制組：新 SToken 的 `name()` = `"S Token"`、`symbol()` = `"S-TKN"` 正常回傳。

### 其他 selector 檢查

以 `cast code <addr>` 抓 runtime bytecode 再找 dispatch 表中的 `PUSH4 <selector>`：

| 檢查項 | selector | 結果 |
|---|---|---|
| `CashVault.fundAdapter(address,uint256)` | `0xe4dc450c` | PRESENT ✅ |
| `NoteVault.fundAdapter(address,uint256)` | `0xe4dc450c` | PRESENT ✅ |
| `LPVault.fundAdapter(address,uint256)` | `0xe4dc450c` | PRESENT ✅ |
| `NAVOracle.updateNAV(address,uint256,uint256,bytes)`（W3 那顆） | `0x305ffd2c` | PRESENT ✅（selector 未變） |
| `CashAdapter.createBuyOrder(uint256,address,uint8)` | `0x8c3a629a` | PRESENT ✅ |

### 連線狀態抽查（`cast call`）

```
ProtocolFeeConfig.paymentTokenOf(Stable)  = 0x32F7E97d1c7a47453c79787f498C82894Ac92578  (新 MockUSDT)
ProtocolFeeConfig.revenuePool()           = 0x9b51bEAF11924B3C659abf82E49d3Dc0E286f2d7
AssetRegistry.mintBurnController()        = 0x5d766d3f8fB3E13b6804C44890e96716Ad541947
StateManager.vaultFactory()               = 0xb9E07A8E96A852CE1c486c427fCaA4cc934deCf7
Settlement.sm()                           = 0xedf762804478E7f9cb7063FA4c01A0FA13D0Cda4
Settlement.unifiedPool()                  = 0x343bbCcf31030D8c7252fF5D9D9f6b8925E8Bd08
Settlement.queue()                        = 0x34779E72f7Ec7f1b4F034163095b8351bBe9f160  (W3 Queue)
AdapterRegistry.registryOwner()           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
AdapterRegistryFactory.isRegistry(shared) = true
LPVault.adapter()                         = 0xD02ccA5f0A963F3Cc98e49b3979178Ad4f509f93
CashAdapter.vault()                       = 0x8864a30cfB12c18AB580BBb19E5cb23107b000C7
CashAdapter.asset()                       = 0x32F7E97d1c7a47453c79787f498C82894Ac92578
MockUSDT.symbol()/decimals()              = "USDT" / 6
```

三個 Vault 一致：

```
owner              = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
curator            = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
guardian           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
allocator          = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
isKeeper(deployer) = true
settlement         = 0xB30370ab27d4CBe6B3F7C876C843787FfeAa4998
unifiedPool        = 0x343bbCcf31030D8c7252fF5D9D9f6b8925E8Bd08
adapterRegistry    = 0x3f4c6ec92557ca8A533e798961559946212CD1c6
queue              = 0x34779E72f7Ec7f1b4F034163095b8351bBe9f160
Settlement.threshold(vault)            = 1
Settlement.isOperator(vault, deployer) = true
```

各自的 VaultTimelock：Cash `0xDE81c6A5…`、Note `0x71CB43ab…`、LP `0x6f4874B9…`

三個 Adapter 的 `dataProvider()` 全部 = `0x425beB70d264362E4eb7953C4f7aFBDe01145538`

---

## 角色配置狀態

### 已配置（全部指向部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`）

| 角色 | 範圍 | 值 |
|---|---|---|
| Governor | HyperAccessControl | 部署錢包 |
| Issuer | AssetRegistry（demo 資產 1、2 的 owner） | 部署錢包 |
| Token Agent | MintBurnController，資產 1 與 2 | 部署錢包 |
| NAV Signer | NAVOracle（**W2 那顆 `0xafA6FDe2…`**，對 SToken） | 部署錢包 |
| Vault Owner | Cash / Note / LP | 部署錢包 |
| Curator | Cash / Note / LP | 部署錢包 |
| Guardian | Cash / Note / LP | 部署錢包 |
| Allocator | Cash / Note / LP | 部署錢包 |
| Keeper | Cash / Note / LP | 部署錢包 |
| Data Provider | Cash / Note / LP Adapter | 部署錢包 |
| Settlement Operator | Cash / Note / LP，threshold = 1 | 部署錢包（1-of-1） |
| Registry Owner | 共用 AdapterRegistry | 部署錢包 |
| Fee payment token | ProtocolFeeConfig，`Stable`(kind=2) | 新 MockUSDT `0x32F7E97d…` |

**全部設成部署錢包是刻意的**：客戶的正式角色名單還沒給我們，這一步只是讓環境單錢包可用。
所有這些角色都可由 Owner／Governor 隨時改，改的時候不需要重新部署。

### 尚未配置（等客戶名單）

- **Settlement 3-of-5 多簽**：目前是 1-of-1（threshold=1、operator 只有部署錢包）。
  客戶給 5 個 operator 位址後，以 Vault Owner 身分對每個 Vault 呼叫
  `Settlement.setOperator(vault, op, true)` ×5 再 `Settlement.setThreshold(vault, 3)`。
- **Curator / Guardian / Allocator / Keeper 的正式持有人**：`offchain/scripts/testnet/ROLE_ASSIGNMENT.md`
  裡的 15 錢包分配表只是建議版，尚未套用到這一代合約上。
- **PoRRegistry proof publisher**：本次沒有設定。
- **NAVOracle（W3 那顆 `0x64A3F862…`）的 signer**：本次沒有設定（只設了 W2 那顆對 SToken 的
  signer）。前端 key `navOracle` 指向 W3 這顆，實際要推 NAV 前需先 `setSigner`。
- **`lpAdapter.setBridgeTarget(liquidityBridge, cashVault)`**：依 `DeployW4` 註解，這屬於 Curator
  的初始參數設定，不是部署步驟，因此腳本與本次都沒有呼叫（現在 `LPAdapter.liquidityBridge()` = `0x0`）。

---

## 同步更新的檔案

- `docs/deployment-bsctestnet-2026-08-17.md` — 開頭加上「已作廢／被本文件取代」標註
- `offchain/scripts/testnet/addresses.bscTestnet.json` — 換成本次新地址（含新的 `usdt` 與 `adapterRegistryFactory`）
- `control-panel/config.js` — 由 `Deploy` 階段自動重寫（只含 W1/W2 那批地址）

`script/Deploy.s.sol` 與 `offchain/scripts/testnet/config.ts` 本次**未改動**。
