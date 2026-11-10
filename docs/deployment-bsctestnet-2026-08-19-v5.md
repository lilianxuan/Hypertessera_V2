# BNB Smart Chain Testnet 全新部署紀錄 v5（2026-08-19）

> ⚠️ **本文件已作廢**：本代（v5）的 chainId 97 地址已被 [`deployment-bsctestnet-2026-08-20-v6.md`](./deployment-bsctestnet-2026-08-20-v6.md) 取代，請改用 v6 的地址。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署錢包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三個 Vault 的 Owner）
- **原始碼 commit**：`7dc7e8f`（`docs: client reply on the Subscription Cap redesign`，分支 `feat/subscription-cap-share`，PR #21）
- **腳本**：`script/Deploy.s.sol`，依序執行 `Deploy` → `DeployW3` → `DeployW4`，全部帶 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **取代**：[`deployment-bsctestnet-2026-08-18-v4.md`](./deployment-bsctestnet-2026-08-18-v4.md)（commit `10fce7f`）。
  **v4 那一代的 chainId 97 地址全部作廢，請改用本文件的地址。**

---

> ## ⚠️ 本次交付唯一的操作陷阱：`subscriptionCapShare` 是 `0`
>
> 三個 Vault 的 `subscriptionCapShare()` 目前**全部是 `0`，代表「不限額」**。
>
> ```
> CashVault.subscriptionCapShare() = 0
> NoteVault.subscriptionCapShare() = 0
> LPVault.subscriptionCapShare()   = 0
> ```
>
> **`script/Deploy.s.sol` 不會設定這個值**（它從頭到尾沒有碰任何產品參數，
> 連 `StateManager.setProductParams` 都沒呼叫）。因此：
>
> **Curator 必須在開放認購之前呼叫 `setSubscriptionCapShare(uint256)` 把上限設好，
> 否則這個上限形同不存在，認購金額不受任何限制。**
>
> 該函式走 `VaultTimelock`，已在三顆 Timelock 的 constructor 白名單裡登記為
> `ActionClass.CURATOR`（見下面「驗證結果」），Curator 可直接排程執行，不需要重新部署。

---

## 這次相對 v4 改了什麼

v4 的 commit 是 `10fce7f`，本次是 `7dc7e8f`，中間共 9 個 commit：

```
7dc7e8f docs: client reply on the Subscription Cap redesign
13a8e7a feat: enforce FIFO prefix amounts on deposit settlement
6f49714 refactor: rename strategy/ to adaptors/; drop misleading SupplyCapExceeded param names
e4f87c1 feat: FIFO partial fills on the LP Vault; drop the request-time raise cap
e1f211d feat: share-denominated subscription cap checked against end-of-settle state
b4e54e2 revert: restore the one-shot guard on StateManager.setVaultFactory
3e3cbfa feat: enumerate the remaining mapping-only sets; make vaultFactory re-settable
7dd2a86 feat: on-chain adapter enumeration on AdapterFactory and BaseVault (#20)
86c9998 feat: on-chain vault index in StateManager, plus v4 testnet redeploy (#19)
```

| # | 改動 | 影響層 | 鏈上可見證據 |
|---|---|---|---|
| 1 | **Subscription Cap 改為份額計價**：`ProductParams.subscriptionCap`（USDT）移除，改成 `BaseVault.subscriptionCapShare`（份額），並改在 settle 的**結束態**檢查 | Types / BaseVault / EarnVault / LiquidityEarnVault / StateManager | `ProductParams` 由 11 欄變 **10 欄**（`setProductParams` selector 由 `0x361ef54f` 變 `0xb302da8a`）；三顆 Vault 新增 `subscriptionCapShare()` |
| 2 | `VaultTimelock` 白名單新增 `setSubscriptionCapShare`（`ActionClass.CURATOR`），並補上白名單的鏈上列舉 | VaultTimelock | VaultTimelock 5,045 → 6,766 bytes（**+1,721**）；`allowedActionCount()` = `11` |
| 3 | LP Vault 的 FIFO 部分成交、取消 request-time raise cap | LiquidityEarnVault | LiquidityEarnVault 20,987 → 21,435 bytes（**+448**） |
| 4 | deposit settle 強制 FIFO prefix 金額 | BaseVault / Settlement | Settlement 8,499 → 9,004 bytes（**+505**） |
| 5 | `AdapterFactory` / `AdapterRegistry` / `AdapterRegistryFactory` / `VaultFactory` 的鏈上列舉 API | Factory 層 | AdapterFactory 1,366 → 2,329（**+963**）、AdapterRegistry 777 → 1,755（**+978**）、AdapterRegistryFactory 1,383 → 3,052（**+1,669**）、VaultFactory 9,373 → 11,575（**+2,202**） |
| 6 | `RevenuePool` 的來源列舉 | RevenuePool | RevenuePool 2,797 → 3,744（**+947**） |
| 7 | `StateManager` 移除 `subscriptionCap` 相關欄位與檢查 | StateManager | StateManager 14,806 → 14,700（**−106**） |
| 8 | `src/asset-management/strategy/` 更名為 `adaptors/` | 純檔案搬移 | Adapter 三顆的 bytecode **Δ = 0** |

### 為什麼必須整代重新部署

與 v4 同樣的理由，而且這次更硬：`StateManager` **不在 proxy 後面**（本協議只有 `UnifiedPool`
是 UUPS），`StateManager.setVaultFactory` 是一次性的（`VaultFactoryAlreadySet`，`b4e54e2`
已把 `3e3cbfa` 暫時放寬的版本改回一次性），而 `VaultFactory`／`Vault`／`Queue`／`ClaimRegistry`／
`Settlement` 的 `sm` 全是 constructor immutable。這次連 Vault 本身的 bytecode 都變了
（`subscriptionCapShare` 是新的 storage 變數），Vault 一經 `VaultFactory` 產出即不可升級，
所以整條 immutable 連鎖只能整代重來。

### 部署流程

與 v4 完全相同的三階段 + 一階段手動配置，環境變數傳遞方式也沒變：

| 階段 | 讀取的環境變數 |
|---|---|
| `Deploy` | 無（只需 `TEST_PK`） |
| `DeployW3` | `HYPER_ACCESS_CONTROL`、`REVENUE_POOL`、`USDT`、`PROTOCOL_FEE_CONFIG` |
| `DeployW4` | `HYPER_ACCESS_CONTROL`、`STATE_MANAGER`、`QUEUE`、`UNIFIED_POOL`、`USDT`、`CASH_VAULT`、`NOTE_VAULT`、`LP_VAULT`、`SETTLEMENT_OPERATORS`、`SETTLEMENT_THRESHOLD`、`DATA_PROVIDER_SIGNER` |

交易筆數與 v4 逐階段相同：18 / 26 / 26 筆，另加階段四 8 筆手動配置，合計 **78 筆**。

### EIP-170 前置檢查

廣播前先跑 `forge build --sizes`：**exit code 0，全部 margin 為正、無 violation**。

```
tightest runtime margins:
  EarnVaultDeployer                          runtime= 24,347  rt_margin=    229
  LiquidityEarnVaultDeployer                 runtime= 23,414  rt_margin=  1,162
  EarnVault                                  runtime= 22,515  rt_margin=  2,061
  LiquidityEarnVault                         runtime= 21,435  rt_margin=  3,141
  RWAAdapterDeployer                         runtime= 14,768  rt_margin=  9,808
  StateManager                               runtime= 14,700  rt_margin=  9,876
```

`EarnVaultDeployer` 依舊是全 repo 最接近上限的合約，餘裕從 v4 的 **293 bytes 縮到 229 bytes**
（`EarnVault` 加了 `subscriptionCapShare` 的 +64 bytes 直接吃掉 deployer 的餘裕）。
**往 `BaseVault`／`EarnVault` 再加任何 public/external 函式前都必須先跑 `forge build --sizes`。**

廣播前也跑過完整測試：`forge test` → **955 passed / 0 failed / 0 skipped**。

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
    sourceCommit: '7dc7e8f',
    addresses: Object.freeze({
      hyperAccessControl: '0xb056A45f241d30164f2d2ddBa42e55E64f4d1f30',
      stateManager: '0x15d305C9D167aB20f536964623606cD4bB5Ff667',
      navOracle: '0x5Dba8A725eb215A433d591Ee4564325F0D7E444A',
      mintBurnController: '0x9C4E7d232B57159373B13Ce0d30077049B7e2f64',
      assetRegistry: '0xb0BeD9dd427c055F5b086fce026eeFdA797CbF33',
      protocolFeeConfig: '0x11C77bF046D138175b22ADB90Dca43643a49fCE6',
      reservePSM: '0x7cc4579a0f2ee7bc525154761fC34fa1eD2c83Dc',
      poRRegistry: '0x14FE616eB2f51B96c727D4D64a0bCA2b600A731c',
      queue: '0x4329C84cabc1d67a5F8E22Acd3972E1D7E7EDB02',
      revenuePool: '0x8442f88bf7e16B4cb3Bc47049F34651D7aCaaF24',
      unifiedPool: '0x22870f7E064614D022f7DF3788cEb94d8D4e5526',
      settlement: '0x8a0f93703A76A0B2F20b521De7Fc84bE400d9874',
      vaultFactory: '0x6F239972fad9F3dBa69E0305AFF93584968A347a',
      adapterFactory: '0x95E2f615469FAD73e52c613F719FA14de33E58b1',
      adapterRegistry: '0x0e97Fe9366d18dABfE759D684D427073bE09304A',
      adapterRegistryFactory: '0xF91DE70F29d836478459f1b092B02C9AA476de53',
      liquidityBridge: '0x2C97987cE2804ee360D49D013a7b4780A5d072cf',
      claimRegistry: '0xf617EB363f03711D969e906c91980F67a04Ab596',
      mockUsdt: '0x95b17e189bA1483b5ab0156a895da5caA5F00cF6',
      cashVault: '0x2EAe528B02778476d5C268f7fB4e9e610924dab1',
      noteVault: '0x5E3633b647Ed8cCa0bB9F849d5B3ef49b1F090aE',
      lpVault: '0xB81d173d0899A0b4d4A216903144dFC84FEFfBae',
      cashAdapter: '0x7ebeFFBFeC8De5b7B330f06A29E1A33BCFc228e4',
      noteAdapter: '0xe9E3dc7B9177Dd3294f562793da384E53e71E892',
      lpAdapter: '0x16E86C3B3168215e008E0045140431DcF3B6b4bE',
    }),
  }),
});
```

### 全部地址 + bytecode 位元組數

逐一以 `cast code <addr> --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545` 取回並計算長度，
**全部非空（38/38）**。「Δ」欄是相對 v4 的位元組差。

| 階段 | 合約 | 地址 | bytecode | Δ vs v4 |
|---|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0xb056A45f241d30164f2d2ddBa42e55E64f4d1f30` | 1109 bytes | 0 |
| Deploy | StubStateManager | `0xeDf17A518872090710343694c37032C22e292202` | 3645 bytes | **−18** |
| Deploy | MockUSDT | `0x95b17e189bA1483b5ab0156a895da5caA5F00cF6` | 1720 bytes | 0 |
| Deploy | RevenuePool | `0x8442f88bf7e16B4cb3Bc47049F34651D7aCaaF24` | 3744 bytes | **+947** |
| Deploy | ProtocolFeeConfig | `0x11C77bF046D138175b22ADB90Dca43643a49fCE6` | 1827 bytes | 0 |
| Deploy | AssetRegistry | `0xb0BeD9dd427c055F5b086fce026eeFdA797CbF33` | 10109 bytes | 0 |
| Deploy | MintBurnController | `0x9C4E7d232B57159373B13Ce0d30077049B7e2f64` | 3427 bytes | 0 |
| Deploy | NAVOracle（W2 那顆，前端不用） | `0x49776731F1C5B1cE19B370D89Aea98C121B851eF` | 3983 bytes | 0 |
| Deploy | PoRRegistry | `0x14FE616eB2f51B96c727D4D64a0bCA2b600A731c` | 2985 bytes | 0 |
| Deploy | SToken / RWAToken（demo 資產 1） | `0xfb10cC4df07E2Ff489C390c12C6941039c111fbE` | 4202 bytes | 0 |
| Deploy | JToken（demo 資產 2） | `0xb05E3728901E4E98f804dF4BD71F439598B66A28` | 4202 bytes | 0 |
| Deploy | Queue（W2 那顆，綁 StubStateManager，前端不用） | `0x6AeDe5F6DfD1236802e83aC3e66033F0CEc0a60E` | 4178 bytes | 0 |
| Deploy | ReservePSM | `0x7cc4579a0f2ee7bc525154761fC34fa1eD2c83Dc` | 10577 bytes | 0 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0x5ab723B736AE40559Aa8ABBA970fe7A65a8fD852` | 2329 bytes | **+963** |
| Deploy | RWAAdapter（W2 demo） | `0x343C944D3680876a32Aac8A4b997a60DB378fBc5` | 13014 bytes | 0 |
| DeployW3 | **StateManager** | `0x15d305C9D167aB20f536964623606cD4bB5Ff667` | 14700 bytes | **−106** |
| DeployW3 | ClaimRegistry | `0xf617EB363f03711D969e906c91980F67a04Ab596` | 1946 bytes | 0 |
| DeployW3 | **NAVOracle** | `0x5Dba8A725eb215A433d591Ee4564325F0D7E444A` | 3983 bytes | 0 |
| DeployW3 | **Queue** | `0x4329C84cabc1d67a5F8E22Acd3972E1D7E7EDB02` | 4178 bytes | 0 |
| DeployW3 | LiquidityBridge | `0x2C97987cE2804ee360D49D013a7b4780A5d072cf` | 1291 bytes | 0 |
| DeployW3 | UnifiedPool implementation | `0x8861c331205Be08dF775435C4C9a42590c78245E` | 8851 bytes | 0 |
| DeployW3 | **UnifiedPool（ERC1967 proxy，用這個）** | `0x22870f7E064614D022f7DF3788cEb94d8D4e5526` | 163 bytes | 0 |
| DeployW3 | EarnVaultDeployer | `0x11c9C54FbCAC2Ec645d022e8337C3046ce2C917a` | 24347 bytes | **+64** |
| DeployW3 | LiquidityEarnVaultDeployer | `0x3E756fFB548775879323bA18bEF33cf64D62D619` | 23414 bytes | **+448** |
| DeployW3 | VaultFactory | `0x6F239972fad9F3dBa69E0305AFF93584968A347a` | 11575 bytes | **+2202** |
| DeployW3 | AdapterRegistryFactory | `0xF91DE70F29d836478459f1b092B02C9AA476de53` | 3052 bytes | **+1669** |
| DeployW3 | AdapterRegistry（共用，由工廠產出） | `0x0e97Fe9366d18dABfE759D684D427073bE09304A` | 1755 bytes | **+978** |
| DeployW3 | CashVault (EarnVault, htCASH) | `0x2EAe528B02778476d5C268f7fB4e9e610924dab1` | 22515 bytes | **+64** |
| DeployW3 | NoteVault (EarnVault, htNOTE) | `0x5E3633b647Ed8cCa0bB9F849d5B3ef49b1F090aE` | 22515 bytes | **+64** |
| DeployW3 | LPVault (LiquidityEarnVault, htLP) | `0xB81d173d0899A0b4d4A216903144dFC84FEFfBae` | 21435 bytes | **+448** |
| DeployW3 | CashVaultTimelock | `0xbD40d6410239d7D5Ce2119BaFdDCCc9B72a279e5` | 6766 bytes | **+1721** |
| DeployW3 | NoteVaultTimelock | `0x6682B884d87eEFD584AB95691E7006775636CfAd` | 6766 bytes | **+1721** |
| DeployW3 | LPVaultTimelock | `0x343Aa0b5f440aF9AE7F6BCa117641d155D50C2C8` | 6766 bytes | **+1721** |
| DeployW4 | Settlement | `0x8a0f93703A76A0B2F20b521De7Fc84bE400d9874` | 9004 bytes | **+505** |
| DeployW4 | AdapterFactory | `0x95E2f615469FAD73e52c613F719FA14de33E58b1` | 2329 bytes | **+963** |
| DeployW4 | CashAdapter (FirstPeriodAdapter) | `0x7ebeFFBFeC8De5b7B330f06A29E1A33BCFc228e4` | 11807 bytes | 0 |
| DeployW4 | NoteAdapter (FirstPeriodAdapter) | `0xe9E3dc7B9177Dd3294f562793da384E53e71E892` | 11807 bytes | 0 |
| DeployW4 | LPAdapter (LiquidityAdapter) | `0x16E86C3B3168215e008E0045140431DcF3B6b4bE` | 12442 bytes | 0 |

鏈上 runtime 長度與本 commit 的本地 artifact（`forge build --sizes`）**逐一吻合**（38/38）。
`RWAAdapter`／`FirstPeriodAdapter`／`LiquidityAdapter` 三顆的 Δ = 0 正好印證第 8 項改動
（`strategy/` → `adaptors/`）純粹是檔案搬移、沒有動到任何邏輯。

`UnifiedPool` proxy 只有 163 bytes 是正常的——ERC1967Proxy 本體就這麼小，實作在
`0x8861c331…`。前端／SDK 一律用 proxy 位址 `0x22870f7E…`。

### 重複合約的釐清

與 v4 一樣，部署腳本三階段會產生兩個 `NAVOracle`、兩個 `Queue`、兩個 `AdapterFactory`。
以鏈上呼叫判定實際接線的那一份：

| 合約 | 實際接線（用這個） | 另一份（不要用） | 判定依據（`cast call`） |
|---|---|---|---|
| `Queue` | **`0x4329C84c…`**（W3） | `0x6AeDe5F6…`（W2，綁 StubStateManager） | `Settlement.queue()` = `0x4329C84c…`；三個 Vault 的 `queue()` 都 = `0x4329C84c…`；`W3 Queue.sm()` = `0x15d305C9…`（真 StateManager），`W2 Queue.sm()` = `0xeDf17A51…`（Stub） |
| `AdapterFactory` | **`0x95E2f615…`**（W4） | `0x5ab723b7…`（W2 demo） | `W4 AdapterFactory.isAdapter(cashAdapter)` = `true`；`W2 AdapterFactory.isAdapter(cashAdapter)` = `false` |
| `NAVOracle` | **`0x5Dba8A72…`**（W3，前端 key 用這個） | `0x49776731…`（W2，供 W2 demo RWAAdapter） | 腳本的 `setSigner` 只打在 W2 那顆上；W3 那顆由階段四手動補設（見下） |

與 v4 一樣，**W3 那顆 NAVOracle 的 signer 已於階段四手動補設**為部署錢包：

```
W3 NAVOracle.signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538   (本次手動補設)
```

> **這個 signer 是暫時值。** 客戶正式的 NAV signer 名單給了之後，以 NAVOracle owner 身分呼叫
> `setSigner(rwaToken, realSigner)` 覆蓋即可，不需重新部署。

---

## 部署交易 hash

### 階段一：`Deploy`（18 筆，全部 status `0x1`，合計 26,531,611 gas）

```
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 類型 | 目標 | tx hash |
|---|---|---|---|
| 1 | CREATE | HyperAccessControl | `0x7687638da5c61ea0df32f8619a2ec3d2e24f65bc69641c3fb1506edd154eb83f` |
| 2 | CREATE | StubStateManager | `0xd1faf17832d8638bcfa387689b0c6ab06773caea0182288b551e3e1ef7c2e1f4` |
| 3 | CREATE | MockUSDT | `0x5f591c8a67dd50ce7c259e2c02f555b39f5815034d38b64d17ba8d145c75015a` |
| 4 | CREATE | RevenuePool | `0x83f18ad0f3c47aebcfa0fb8a0d8922ff8271d8fdc01e702c2fcf71b2f3c16bf7` |
| 5 | CREATE | ProtocolFeeConfig | `0x688f0e8f5828768b8ee37ac5e629610dbba7050bcc007a47011657ec719191b4` |
| 6 | CREATE | AssetRegistry | `0x0d8d8c382629ba40550de3dfcd29c5b54fd389d9623405bc8c1d06dbcea718c2` |
| 7 | CREATE | NAVOracle (W2) | `0x60673f73828c6450185a78f42d08d191a21e7feeacec5506b210368b5f868648` |
| 8 | CREATE | PoRRegistry | `0xe8d6534b8127b195744eb214f9f4c650f8c98f835a2fa09c19f44a57abd3144f` |
| 9 | CALL | AssetRegistry.registerAsset (S) | `0xac93973943c0b19e5ece747684dd86af244548d92bc7257761986e5c58af08c7` |
| 10 | CALL | AssetRegistry.registerAsset (J) | `0x9320b55d38846d10beaaee9b32f6280216c47c10b65ecb407199bed12c581d39` |
| 11 | CREATE | Queue (W2) | `0x575d3abffbc9369ee8539e48c4136eb685205d68964358e15c79137357f5f292` |
| 12 | CREATE | ReservePSM | `0x123cbaf62c54c9af33580e6f476d1f99e15350aaec55e065b5b79788a77f92c5` |
| 13 | CALL | ReservePSM.deployWrappedToken | `0xf08a0de0dab6392e2dbaf14744495163710f171b757d7eb8e1b74ae85f9d8a9b` |
| 14 | CREATE | AdapterFactory (W2) | `0x822317df1eaa132fc9d562eb423b73dafea7ef5d2b80a244409dbaa22ce9d32f` |
| 15 | CALL | AdapterFactory.deployRWAAdapter | `0x5a59c6967c83321bcddac3b2f94d47f5e100e0c741cc38615ba436b8a55a49d4` |
| 16 | CALL | MintBurnController.setTokenAgent(1) | `0x4c3a7063365ce7f5215d2579fa10062c7260ba4a421c3857a62f1886b60f40e5` |
| 17 | CALL | MintBurnController.setTokenAgent(2) | `0xb09f3db3d5e3fe2587c26d197b1eb4f5cf382af8ed9b8c62d7f0bc4e035828bd` |
| 18 | CALL | NAVOracle(W2).setSigner | `0x2f1e987b0bdbece763682db7cc588560459d51fa34602e65935b24351d633d92` |

### 階段二：`DeployW3`（26 筆，全部 status `0x1`，合計 44,546,079 gas）

環境變數：`HYPER_ACCESS_CONTROL=0xb056A45f…`、`REVENUE_POOL=0x8442f88b…`、
`USDT=0x95b17e18…`、`PROTOCOL_FEE_CONFIG=0x11C77bF0…`

| # | 類型 | 目標 | tx hash |
|---|---|---|---|
| 1 | CREATE | StateManager | `0x8313ee0012985077b323a0ec92bdaa58c56e92f188168d443de159f3053a828d` |
| 2 | CREATE | ClaimRegistry | `0x028e8cf916fd4816e72e93104fe100cf974b17c7db65bc7c159846fd915f4bb9` |
| 3 | CREATE | NAVOracle | `0xe41164768ee6c44d6e35a258abb4f0edc6ad03ce45d5332a3d914e2f60bb663a` |
| 4 | CREATE | Queue | `0xb595813558e201c18eedef131d9c116b56c28bc196daa70fcf845f75464d0ce1` |
| 5 | CREATE | LiquidityBridge | `0xd2ca036631a10c31bcc311db734f946f94cffb090f70e83a8f17ba288dcf54ab` |
| 6 | CREATE | UnifiedPool implementation | `0x0c78a59f27573b928e20b78b04b055059cc325ae4871c517273e4d56942cef0d` |
| 7 | CREATE | ERC1967Proxy (UnifiedPool) | `0xd324ed234e91dc706854cedfe5138988f70b0dbda964a9bf339c40e22c29a4a0` |
| 8 | CALL | RevenuePool.addAuthorizedSource(pool) | `0x372fea59156b2a912f323fa3961d153ee074f457fff25b07975a255ffe7a2dba` |
| 9 | CREATE | EarnVaultDeployer | `0x870fe197a6341ae7ab9e1533543dec1ce8563fcef9d219936475eb5898ba8a90` |
| 10 | CREATE | LiquidityEarnVaultDeployer | `0x6f64bb01d3527e9ee7688713c5c82cdb87004b64c8ac8e06d3e9af53765b3cb9` |
| 11 | CREATE | VaultFactory | `0x181ab9cf2ca5f202f334c8fac5b0daf51acaf18764d429cb4e8afaf40ae3908e` |
| 12 | CREATE | AdapterRegistryFactory | `0x0bf46cf2828bc7fd05c68e2b208270e2ac50718dc95db26e153093fbea7848d5` |
| 13 | CALL | AdapterRegistryFactory.deployRegistry | `0x708a000acb96c05448b06d1da036be3f2346af34983a82dd420dbac74087c901` |
| 14 | CALL | StateManager.setVaultFactory | `0xfd25fdcc63bdbea582bf5ab2b39c1127907e11cdc07dbc6dd579acef7066b23c` |
| 15 | CALL | VaultFactory.deployVault (Cash) | `0x90c694a9df189c7f1cb46e48aa6b17e55e8d9abc8508596443c70ea8577743cd` |
| 16 | CALL | VaultFactory.deployVault (Note) | `0xac2613d6bf3a70389e2973489b8f725a55c72056e15ddaf293f8b1b36498b2eb` |
| 17 | CALL | VaultFactory.deployVault (LP) | `0xba38fdbac8287133d3b194410c34b092258776bebf0fcf03d010b2375e0a9ae6` |
| 18 | CALL | CashVault.setKeeper | `0xdbc7bab76a9117c0667c67c0bbc0a6ca91e7442e8e5211a3361606c004c6a162` |
| 19 | CALL | CashVault.setCurator | `0x2391e90321494bd41d25ba5e8f6377cbf23de5ab576fea2838f4033cd7670b8e` |
| 20 | CALL | NoteVault.setKeeper | `0x03974afec67e12493e372b2df104cb5079c05bc6185875742ff6058990b5a3ad` |
| 21 | CALL | NoteVault.setCurator | `0xe72fa2bc1523254e15c531d63b9bb6516a65fa3e4cac35a9da9cd0e4beaf0225` |
| 22 | CALL | LPVault.setKeeper | `0x0a9580e29317bbacf9ed75da4e0772f3300fa0aebdaa2bc80fc878a4811e7a59` |
| 23 | CALL | LPVault.setCurator | `0x8b93ff3369ac5cef296e8d054aa46325b586323843d54b14be3f8279cfda5b0f` |
| 24 | CALL | UnifiedPool.addTrancheVault (Cash) | `0x0ee56d69afb68dd1182934f5cf4038d4e150881fb77e9bfa01237db5d6addbf7` |
| 25 | CALL | UnifiedPool.addTrancheVault (Note) | `0x968d62a8a511ba14b77f9b14d66569a1b288a83093e1b52a4020520af9265cae` |
| 26 | CALL | UnifiedPool.addTrancheVault (LP) | `0x57de2510ea7ca785b4c75a5d0ed16af6102e34efd236a14520c1526621396d6d` |

### 階段三：`DeployW4`（26 筆，全部 status `0x1`，合計 21,266,568 gas）

環境變數另加：`STATE_MANAGER=0x15d305C9…`、`QUEUE=0x4329C84c…`、`UNIFIED_POOL=0x22870f7E…`、
`NAV_ORACLE=0x5Dba8A72…`、`CASH_VAULT=0x2EAe528B…`、`NOTE_VAULT=0x5E3633b6…`、`LP_VAULT=0xB81d173d…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 類型 | 目標 | tx hash |
|---|---|---|---|
| 1 | CREATE | Settlement | `0x11822e13348fdd6611e3fd49792774e8c6f9cb2263a3128b637e419b471be92e` |
| 2 | CALL | CashVault.setSettlement | `0xe12f316076d09aac089d419b7a5186ebde457bdb3c835e58527822a789194142` |
| 3 | CALL | NoteVault.setSettlement | `0xa9a99663fb48494c821809e066216294d76a0ccfe288f41480508549cfc79466` |
| 4 | CALL | LPVault.setSettlement | `0x8b5b66ecd70df3d28b7217bbe605f75bad5491084ba4bfc8d28e1889e791886c` |
| 5 | CALL | Settlement.setOperator (Cash) | `0x53dfe0abe1c771360e820f39c6eab4c09542c672faa0426264e045264038e927` |
| 6 | CALL | Settlement.setThreshold (Cash) | `0x19ac2808475bdf41d9794b220f804b6d3198d06ad63da6b33abf8daf8500b612` |
| 7 | CALL | Settlement.setOperator (Note) | `0x242fc237b10f43df7daffb7e9a5107521a86f94307d38fc04760bbe3b51d62e3` |
| 8 | CALL | Settlement.setThreshold (Note) | `0x18af44671879e5d2a5e9fff15ba33e6d2b6c2841b9d097edd11949cb76c1cd4d` |
| 9 | CALL | Settlement.setOperator (LP) | `0xc72f767cde50d65b5c89ffd604728fe878f5ac9029573354cb5e4f9d90139f8d` |
| 10 | CALL | Settlement.setThreshold (LP) | `0x1ce1f8f34d4d2d386641ec06c317035ad8b7e7f92c51cf0ee213c44c9d2159d5` |
| 11 | CREATE | AdapterFactory | `0x19da796289293a1687d4437e05b621560a0be13e2f02518cd3b988fcfa57a0d0` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | `0x6663ee58b3c56d04921d87bd8602312c7b2f891c6f094547385480454fe33007` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | `0xc375db5ef6aeb869d7990ddc9a19abbfe8d1a4d1e0590ea03620ad534861ee44` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | `0xc44b75cd09d2f4565b5ae7b7cc180857cc693f34094a62bbee622eff12763ad5` |
| 15 | CALL | AdapterRegistry.setAdapterAllowed (Cash) | `0xabd21e572611278e5574625737b62cb6c1aa4ae9a94d502c3ed320700e9234f5` |
| 16 | CALL | AdapterRegistry.setAdapterAllowed (Note) | `0x4383bbbc6b50744f005a334c808c338ce7106258d662bc538df070e245e0f6eb` |
| 17 | CALL | AdapterRegistry.setAdapterAllowed (LP) | `0x09561dbe35adf6ee044800e42c24faee7883702218c5a7a111890a646983ca2c` |
| 18 | CALL | LPVault.setAdapter | `0xc4d1d096a204efbba4cbdbb2d91fd1b8bb765c536841247c892c1a64c405736a` |
| 19 | CALL | CashVault.addAdapter | `0x09ed29e4ffc5488de54b7bdc3f72da3fa11b799aab446acb97c5847bb40b745e` |
| 20 | CALL | NoteVault.addAdapter | `0xd321934fb933c7ddebf17e29c2d708585ab6cf69170ea5e1f817cc3396a01c77` |
| 21 | CALL | CashVault.setUnifiedPool | `0xc4712efa3788cbb05d8b1ba9a544babc22f02148212fb27940e5f800b7ac9aa4` |
| 22 | CALL | NoteVault.setUnifiedPool | `0x363a9849645d1a50a54ec985c29e6dd6dc5136ff38c23707b51b2b316a10edd3` |
| 23 | CALL | LPVault.setUnifiedPool | `0x04c6e95924aeb9c2b3f9bd0fbf4e5738d838776eab703d507c19360f1ac8b370` |
| 24 | CALL | CashAdapter.setDataProvider | `0x14b6126c55a133f6037ede255b94334ad73e2285ddd06d1e714f0acb0669741b` |
| 25 | CALL | NoteAdapter.setDataProvider | `0xb832dcd90c24a0560272c6e94614c385de310722543fcab6470f557996800678` |
| 26 | CALL | LPAdapter.setDataProvider | `0x273627050efd0616f15951f2521fec9a9e01e44e8eac69b71f1533fe934d9bed` |

### 階段四：部署後手動配置（8 筆 `cast send`，全部 status `0x1`，合計 391,038 gas）

| 動作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0x136b99c32bdc0e1d1a46da571fecee8c46b7799516c02308f65c6d4d6951a23b` |
| `CashVault.setGuardian(deployer)` | 48,372 | `0x7980c77e66b040a2a7036db6a4a0b15dc00979df625a36ebb1bc8153a7d966ea` |
| `CashVault.setAllocator(deployer)` | 48,438 | `0xeb9ce245e1a3b63631895b977f832aa236a354b82e745e3ed57484114f144a84` |
| `NoteVault.setGuardian(deployer)` | 48,372 | `0xbdc7d7f1b9deb5163c55ee4a4bbb099b5c9c21207afe2b075e06df5f79ce9f69` |
| `NoteVault.setAllocator(deployer)` | 48,438 | `0xaa635b7b93438f7b94f7fd071f265d16561f66e0243f8312628b10cf79844c6f` |
| `LPVault.setGuardian(deployer)` | 48,416 | `0x454705a612bc0d564e3dcaf900851acf6b5472a09735c2c6e70f37320455c2f6` |
| `LPVault.setAllocator(deployer)` | 48,438 | `0x18c67ad28b1d77e486025a0833adc1aa8292db6356b7f5705dae9dbb2aa369b0` |
| **`NAVOracle(W3).setSigner(SToken, deployer)`** | 48,251 | `0x0436728e3e40ff3acb2ee0a44e61acdc99a5d843821856097db5a4941f1bd2bf` |

> **註**：與 v3／v4 一樣，8 筆裡有 5 筆第一次送出時被 RPC 負載平衡後端以 `nonce too low` 拒絕
> （交易未上鏈、未耗 gas）。逐筆自動重送後全部成功，上表是成功的那 8 筆。
> Settlement threshold / operator 與三個 Adapter 的 Data Provider 已由 `DeployW4` 設好，階段四不需再送。

### 階段五：15 個測試錢包補鑄 MockUSDT — **已執行**

新的 MockUSDT 是 `0x95b17e189bA1483b5ab0156a895da5caA5F00cF6`；v4 的 MockUSDT
`0x982c2ebd…` 上的餘額在新環境等於不存在，所以 15 個錢包全部需要補鑄。

先更新 `offchain/scripts/testnet/addresses.bscTestnet.json` 到 v5 位址（`fundWallets.ts`
透過 `config.ts` 讀取位址的來源），再執行：

```
cd offchain
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run   # 先看計畫
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts             # 實際送出
```

`--dry-run` 的結果是 **1/15 需要 BNB、15/15 需要 USDT** —— 錢包的 gas 餘額跨代保留，
只有 curator 因先前消耗掉到門檻以下，USDT 則因 MockUSDT 換了位址而全數歸零。
因此本階段送出 1 筆 BNB 轉帳（curator `0.000533889` BNB）與 15 筆 `mint`。

執行後 15 個錢包皆為 `100000.0` USDT、BNB 皆達標，腳本回報 `all 15 wallets funded.`。
腳本本身是冪等的（先讀餘額，已達標者跳過），重跑不會重複鑄幣。

---

## Gas 與餘額

| 項目 | gas | BNB @ 0.1 gwei |
|---|---|---|
| 階段一 `Deploy`（18 筆） | 26,531,611 | 0.0026531611 |
| 階段二 `DeployW3`（26 筆） | 44,546,079 | 0.0044546079 |
| 階段三 `DeployW4`（26 筆） | 21,266,568 | 0.0021266568 |
| 階段四 部署後配置（8 筆） | 391,038 | 0.0000391038 |
| **合計（78 筆）** | **92,735,296** | **0.0092735296** |

- 部署前餘額：`0.188202469060000000` BNB
- 部署後餘額：`0.178928939460000000` BNB
- 實際扣除：`0.009273529600000000` BNB（與上表加總 **完全吻合**）
- 部署錢包 nonce：715 → 793（78 筆）

階段五（錢包補鑄）另計，不含在上表的 78 筆內：

- 1 筆 BNB 轉帳（curator `0.000533889` BNB）＋ 15 筆 `MockUSDT.mint`
- 補鑄後餘額：`0.178314504960000000` BNB
- 本階段實際扣除：`0.000614434500000000` BNB（其中 `0.000533889` 是轉出的本金，
  其餘 `0.0000805455` 為 16 筆交易的 gas）

---

## 驗證結果

### bytecode

38 個地址逐一 `cast code`，**全部非空（0 empty / 38）**，位元組數見上面地址表，
且與本 commit `forge build --sizes` 的本地 artifact 長度逐一吻合。

### 本次改動的驗收測試 — Subscription Cap 改份額計價

RPC 一律 `https://data-seed-prebsc-1-s1.binance.org:8545`。
新 StateManager `0x15d305C9D167aB20f536964623606cD4bB5Ff667`，
v4 StateManager `0xd0A47736e9Adf28f2A395834cB379E51441922bf` 當對照組。

#### 1) `ProductParams` 由 11 欄變 10 欄 ✅

`setProductParams` 的 selector 依 struct 欄位數而變，因此可以直接用 selector 存在與否判定：

```
sel(10 欄) = 0xb302da8a      sel(11 欄) = 0x361ef54f
```

| 呼叫 | 結果 | 結論 |
|---|---|---|
| **新 SM** `setProductParams(address,(uint256 ×10))` | revert `0x82b42900` = `Unauthorized()` | 函式**存在**，被權限擋下 ✅ |
| **新 SM** `setProductParams(address,(uint256 ×11))` | revert，**空 revert data `0x`** | 舊的 11 欄版本**已不存在** ✅ |
| **對照組 v4 SM** `setProductParams(address,(uint256 ×10))` | revert，**空 revert data `0x`** | v4 沒有 10 欄版本 ✅ |
| **對照組 v4 SM** `setProductParams(address,(uint256 ×11))` | revert `0x82b42900` = `Unauthorized()` | v4 是 11 欄版本 ✅ |

四格完全對角，兩代的 `ProductParams` 形狀互斥。

> **判讀規則**（同 v3／v4）：函式不存在 → dispatch 落空 → **空 revert data `0x`**；
> 函式存在但業務邏輯／權限擋下 → **具體的 error selector**（非空）。

#### 2) 三顆 Vault 都有 `subscriptionCapShare()`，值都是 `0` ✅

```
$ cast call 0x2EAe528B02778476d5C268f7fB4e9e610924dab1 "subscriptionCapShare()(uint256)"   →  0   (Cash)
$ cast call 0x5E3633b647Ed8cCa0bB9F849d5B3ef49b1F090aE "subscriptionCapShare()(uint256)"   →  0   (Note)
$ cast call 0xB81d173d0899A0b4d4A216903144dFC84FEFfBae "subscriptionCapShare()(uint256)"   →  0   (LP)
```

對照組 —— v4 的 CashVault `0x050509B6…` 同一呼叫是**空 revert `0x`**（無此函式）✅

**`0` = 不限額。見本文件開頭的紅框：Curator 必須在開放認購前自行設定。**

#### 3) `VaultTimelock.isActionAllowed(vault, setSubscriptionCapShare.selector, CURATOR)` = `true` ✅

`setSubscriptionCapShare(uint256)` 的 selector = `0x0bcbe087`，
`ActionClass` = `{ OWNER = 0, CURATOR = 1 }`。

| Timelock | 目標 Vault | `class = CURATOR (1)` | `class = OWNER (0)` |
|---|---|---|---|
| Cash `0xbD40d641…` | `0x2EAe528B…` | **`true`** ✅ | `false`（正確：這是 Curator 動作） |
| Note `0x6682B884…` | `0x5E3633b6…` | **`true`** ✅ | `false` |
| LP `0x343Aa0b5…` | `0xB81d173d…` | **`true`** ✅ | `false` |

三顆 Timelock 的 `vault()` 各自指回正確的 Vault；`allowedActionCount()` = `11`
（這個列舉 view 本身也是本次新增的：v4 的 Timelock `0x258ab213…` 同一呼叫是**空 revert `0x`**）。

### 連線狀態抽查（`cast call`）

```
StateManager.vaultFactory()               = 0x6F239972fad9F3dBa69E0305AFF93584968A347a
StateManager.accessControl()              = 0xb056A45f241d30164f2d2ddBa42e55E64f4d1f30
StateManager.vaultCount()                 = 3
StateManager.vaultsPaged(0,10)            = [0x2EAe528B…(Cash), 0x5E3633b6…(Note), 0xB81d173d…(LP)]
StateManager.vaultsWithRole(deployer,0,10)= mask [31, 31, 31]  (OWNER|CURATOR|GUARDIAN|ALLOCATOR|KEEPER)
UnifiedPool.sm()                          = 0x15d305C9D167aB20f536964623606cD4bB5Ff667   (真 StateManager，一次 initialize 到位)
UnifiedPool.usdt()                        = 0x95b17e189bA1483b5ab0156a895da5caA5F00cF6
Settlement.sm()                           = 0x15d305C9D167aB20f536964623606cD4bB5Ff667
Settlement.unifiedPool()                  = 0x22870f7E064614D022f7DF3788cEb94d8D4e5526
Settlement.queue()                        = 0x4329C84cabc1d67a5F8E22Acd3972E1D7E7EDB02  (W3 Queue)
W3 Queue.sm()                             = 0x15d305C9D167aB20f536964623606cD4bB5Ff667  (真 StateManager)
W2 Queue.sm()                             = 0xeDf17A518872090710343694c37032C22e292202  (Stub)
ProtocolFeeConfig.paymentTokenOf(Stable)  = 0x95b17e189bA1483b5ab0156a895da5caA5F00cF6  (新 MockUSDT)
ProtocolFeeConfig.revenuePool()           = 0x8442f88bf7e16B4cb3Bc47049F34651D7aCaaF24
AssetRegistry.mintBurnController()        = 0x9C4E7d232B57159373B13Ce0d30077049B7e2f64
AdapterRegistry.registryOwner()           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
AdapterRegistryFactory.isRegistry(shared) = true
W4 AdapterFactory.isAdapter(cashAdapter)  = true
W2 AdapterFactory.isAdapter(cashAdapter)  = false
LPVault.adapter()                         = 0x16E86C3B3168215e008E0045140431DcF3B6b4bE
MockUSDT.symbol()/decimals()              = "USDT" / 6
W3 NAVOracle.signerOf(SToken)             = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
```

三個 Vault 一致：

```
owner                                  = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
curator                                = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
guardian                               = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
allocator                              = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
isKeeper(deployer)                     = true
stateManager                           = 0x15d305C9D167aB20f536964623606cD4bB5Ff667
settlement                             = 0x8a0f93703A76A0B2F20b521De7Fc84bE400d9874
unifiedPool                            = 0x22870f7E064614D022f7DF3788cEb94d8D4e5526
adapterRegistry                        = 0x0e97Fe9366d18dABfE759D684D427073bE09304A
queue                                  = 0x4329C84cabc1d67a5F8E22Acd3972E1D7E7EDB02
subscriptionCapShare                   = 0        ← 尚未設定，見開頭紅框
StateManager.registeredVaults(vault)   = true
Settlement.threshold(vault)            = 1
Settlement.isOperator(vault, deployer) = true
```

各自的 VaultTimelock：Cash `0xbD40d641…`、Note `0x6682B884…`、LP `0x343Aa0b5…`

三個 Adapter 的 `dataProvider()` 全部 = `0x425beB70d264362E4eb7953C4f7aFBDe01145538`，
`vault()` 各自指回自己的 Vault，`asset()` 全部 = 新 MockUSDT `0x95b17e18…`。

---

## 角色配置狀態

### 已配置（全部指向部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`）

| 角色 | 範圍 | 值 |
|---|---|---|
| Governor | HyperAccessControl | 部署錢包 |
| Issuer | AssetRegistry（demo 資產 1、2 的 owner） | 部署錢包 |
| Token Agent | MintBurnController，資產 1 與 2 | 部署錢包 |
| NAV Signer | NAVOracle **W2 `0x49776731…`**（腳本設定，對 SToken） | 部署錢包 |
| NAV Signer | NAVOracle **W3 `0x5Dba8A72…`**（階段四補設，對 SToken） | 部署錢包（**暫時值**） |
| Vault Owner | Cash / Note / LP | 部署錢包 |
| Curator | Cash / Note / LP | 部署錢包 |
| Guardian | Cash / Note / LP | 部署錢包 |
| Allocator | Cash / Note / LP | 部署錢包 |
| Keeper | Cash / Note / LP | 部署錢包 |
| Data Provider | Cash / Note / LP Adapter | 部署錢包 |
| Settlement Operator | Cash / Note / LP，threshold = 1 | 部署錢包（1-of-1） |
| Registry Owner | 共用 AdapterRegistry | 部署錢包 |
| Fee payment token | ProtocolFeeConfig，`Stable`(kind=2) | 新 MockUSDT `0x95b17e18…` |

**全部設成部署錢包是刻意的**：客戶的正式角色名單還沒給我們，這一步只是讓環境單錢包可用。
所有這些角色都可由 Owner／Governor 隨時改，改的時候不需要重新部署。

### 尚未配置

- **`subscriptionCapShare`**：三顆 Vault 都是 `0`（不限額）。**開放認購前必辦，見開頭紅框。**
- **產品參數 `StateManager.setProductParams`**：本次完全沒有設定（`Deploy.s.sol` 不碰產品參數）。
  認購／週期／到期／領取的時間軸都還是 `0`。
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

- `docs/deployment-bsctestnet-2026-08-18-v4.md` — 開頭加上「已作廢／被本文件取代」標註
- `control-panel/config.js` / `control-panel/deployments.json` — 由 `Deploy` 階段自動重寫
- `control-panel/deployments-w3.json` / `deployments-w4.json` — 由對應階段自動重寫
  （`wN` 是**部署階段**編號，不是世代編號，所以這一代沿用 w3／w4，沒有 `deployments-w5.json`）
- `.env.testnet` — 補上本代所有地址（三個階段之間相互傳遞用），secrets 未動
- `offchain/scripts/testnet/addresses.bscTestnet.json` — 更新到 v5 的 24 個位址

> `control-panel/deployments*.json` 與 `.env.testnet` 都在 `.gitignore` 裡（部署產物／secrets），
> 因此不會出現在 commit 裡，但本機已同步到本代位址。

> **`UnifiedPool` 的 key 位置與 v4 相同**：在 `deployments-w3.json`。
> 控制台 `index.html` 會把三份 JSON merge 起來
> （`Object.assign(deployments.addresses, extra.addresses)`），所以前端讀取不受影響。

`script/Deploy.s.sol` 本次**未改動**。

### 對 `script/Deploy.s.sol` 的建議（未實作）

`Deploy.s.sol` 從頭到尾沒有呼叫 `StateManager.setProductParams`，也沒有設定任何
Vault 的產品參數，因此「順便把 `subscriptionCapShare` 也設一設」在現行腳本裡沒有自然的落點
——真要加，等於是要在腳本裡新增一整段產品參數配置，那屬於 Curator 的職責而非部署步驟。
**建議維持現狀（腳本不設），改在 `docs/settlement-operator-runbook.md` 的開場流程裡
把 `setSubscriptionCapShare` 列為 Curator 開放認購前的必辦項。** 本次未動腳本。
