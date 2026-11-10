# BNB Smart Chain Testnet 全新部署记录 v7（2026-08-21）

> ⚠️ **本文档已作废**：本代（v7）的 chainId 97 地址已被 [`deployment-bsctestnet-2026-08-26-v8.md`](./deployment-bsctestnet-2026-08-26-v8.md) 取代，请改用 v8 的地址。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署钱包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三个 Vault 的 Owner）
- **源代码 commit**：`56cd4a8`（`回退 PR #26，按《合约修改建议0820》实现五项改动 + 恢复回退误伤的 0819 第 4 项 (#27)`，分支 `main`）
- **脚本**：`script/Deploy.s.sol`，依序运行 `Deploy` → `DeployW3` → `DeployW4`，全部带 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **区块范围**：`126,290,644` – `126,291,790`
- **取代**：[`deployment-bsctestnet-2026-08-20-v6.md`](./deployment-bsctestnet-2026-08-20-v6.md)（commit `e671ba9`）。
  **v6 那一代的 chainId 97 地址全部作废，请改用本文档的地址。**

---

> ## ⚠️ 本代最重要的架构变更：三个 Vault 不再是 EIP-1167 克隆
>
> v6 的 `CashVault` / `NoteVault` / `LPVault` 是 45 字节的 minimal proxy，delegatecall 到共用实现合约。
> PR #27 回退了这个改动，**本代三个 Vault 各自是完整部署的独立合约**：
>
> ```
> CashVault  0xe0265431…   runtime 22,343 bytes   （EarnVault 全量）
> NoteVault  0x3c1cbB30…   runtime 22,343 bytes   （EarnVault 全量）
> LPVault    0xAD0BcaaE…   runtime 21,263 bytes   （LiquidityEarnVault 全量）
> ```
>
> - **不再有 implementation 地址**。v6 文档里的 `EARN_VAULT_IMPLEMENTATION` /
>   `LP_VAULT_IMPLEMENTATION` 两个 key 本代不存在，前端 / SDK / 索引器请删掉。
> - 链上实测 runtime 大小与本地 `forge build --sizes` 的 `EarnVault` 22,343 /
>   `LiquidityEarnVault` 21,263 完全一致，可作为“确实不是克隆”的直接证据。
> - Vault 地址的用法没变：一律用上面这三个地址，行为与 v6 的 proxy 地址等价。

> ## ⚠️ `AdapterRegistry` 与 `AdapterRegistryFactory` 已删除
>
> 按《合约修改建议 0820》第 1 项，这两个合约已从代码库移除，本代**不部署**。
> v6 前端 key 区块里的 `adapterRegistry` / `adapterRegistryFactory` 两个 key 请一并删掉。
> Adapter 的准入改由 `AdapterFactory` 自身承担，`DeployW4` 因此比 v6 少了 3 笔
> `setAdapterAllowed` 交易（26 笔 → 23 笔）。

> ## ⚠️ 沿用 v5／v6 的操作陷阱：`subscriptionCapShare` 仍是 `0`
>
> ```
> CashVault.subscriptionCapShare() = 0
> NoteVault.subscriptionCapShare() = 0
> LPVault.subscriptionCapShare()   = 0
> ```
>
> `0` 代表**不限额**。`script/Deploy.s.sol` 从头到尾不碰任何产品参数，
> **Curator 必须在开放认购之前调用 `setSubscriptionCapShare(uint256)`**，否则认购金额不受限制。
> 本次部署已确认三个 Vault 的该值均为 `0`，为客户确认过的预期状态。

---

## 这次相对 v6 改了什么

v6 的 commit 是 `e671ba9`，本次是 `56cd4a8`。中间只有一个合并提交，即 PR #27：

```
56cd4a8 回退 PR #26，按《合约修改建议0820》实现五项改动 + 恢复回退误伤的 0819 第 4 项 (#27)
```

内容对应 [`contract-feedback-20260820-response.md`](./contract-feedback-20260820-response.md) 的五项：

| # | 改动 | 对本次部署的可见影响 |
|---|---|---|
| 1 | 删除 `AdapterRegistry`，并回退 EIP-1167 克隆 | 少两个合约；三个 Vault 变回全量部署 |
| 2 | 取消批量清理，统一由客户自主撤单 | 无新增合约；`sweepExpiredRequests` 已不存在 |
| 3 | 部分成交的赎回 | 行为改动，地址表无变化 |
| 4 | 白名单与转账路径拆成两个独立开关 | 行为改动，地址表无变化 |
| 5 | 产品核心信息同步写入 `AssetRegistry` | 行为改动，地址表无变化 |

另附：恢复了被 PR #26 回退误伤的“0819 第 4 项修复（SETTLING 请求截止）”。

### 合约体积

回退克隆之后，`EarnVaultDeployer` 重新逼近 24,576 字节上限：

```
EarnVaultDeployer            24,175 bytes   （余量 401 bytes）
LiquidityEarnVaultDeployer   23,242 bytes   （余量 1,334 bytes）
```

**余量只剩 401 字节**，后续再往 `EarnVault` 加代码时必须先看这个数字。
这正是当初改用克隆的原因，也是《合约修改建议 0820》第 1 项要求实测后再决定的点。

---

## 完整地址表

### 前端 `deployments.js` 可直接贴入的区块（23 个 key）

> 相对 v6 的 25 个 key，删掉了 `adapterRegistry` 与 `adapterRegistryFactory`。

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: '56cd4a8',
    addresses: Object.freeze({
      hyperAccessControl: '0x6A9927a56661534A0F093d64070d05BfEc91c351',
      stateManager: '0xb0806C368254E9C2A7BDf8A93a593b8160356802',
      navOracle: '0x9b204464a357972B9E6935a1f80D2a2f2f6520a5',
      mintBurnController: '0xBE79B3C282A0bDF8E4C8a1627B4F220a4a1A8114',
      assetRegistry: '0x742C178bC89E085C2B8A6A58c6961a1C7BEcF6DF',
      protocolFeeConfig: '0xE3083110409216Fd66d78C4fcDB7592b720c30b3',
      reservePSM: '0xc681cF88d7E2142b7cE9afd829Ac8663c5A48b18',
      poRRegistry: '0xa0A94855e98DA9747bCbB4a11FDCb3F9EC90c100',
      queue: '0x176cf1cfE7A4B8EA6961c9E39A41575F2638fD23',
      revenuePool: '0xFa6004510eF65c845702047e25110A4d36487788',
      unifiedPool: '0x9a1c8d73faB354AdDDcBDEAa92D81035687F6645',
      settlement: '0xdB7F914Bd1FA892cA3026F8C1727651A871c3c6A',
      vaultFactory: '0x298c33484760d043844123E4141869dc61973af6',
      adapterFactory: '0x6D7320249dAF7Ff64aA5C0d8aa7808B72dA6ACEA',
      liquidityBridge: '0xC35474Af87acDf64d57424E039561fd2eD30a232',
      claimRegistry: '0xEfD95A0cd29652C9374b4c309f1De159ad99574d',
      mockUsdt: '0x38eE768D4E1070FFF07997e3674a02F6cEC6D957',
      cashVault: '0xe0265431A84E5A53914566B6bf1B5aD91D37285E',
      noteVault: '0x3c1cbB3092E221B928A4daaFa3E072D66AdEa0E9',
      lpVault: '0xAD0BcaaEC4ff8ecc94b3c0aC028dA713f6767420',
      cashAdapter: '0x7c6a340c8653344d41beB91531720fD754AAf5A0',
      noteAdapter: '0x6f0e924F94AB05Ae39d991b92880cDB8767EA3A4',
      lpAdapter: '0xF486F553a8038d8b7F8CE7c840ddac59b964CAa5',
    }),
  }),
})
```

### 各阶段部署的合约

| 阶段 | 合约 | 地址 |
|---|---|---|
| Deploy | HyperAccessControl | `0x6A9927a56661534A0F093d64070d05BfEc91c351` |
| Deploy | StubStateManager（仅供 W2 demo） | `0xfceE6941B8C427b1c3156c95b48Fbb955837FeFb` |
| Deploy | MockUSDT | `0x38eE768D4E1070FFF07997e3674a02F6cEC6D957` |
| Deploy | RevenuePool | `0xFa6004510eF65c845702047e25110A4d36487788` |
| Deploy | ProtocolFeeConfig | `0xE3083110409216Fd66d78C4fcDB7592b720c30b3` |
| Deploy | AssetRegistry | `0x742C178bC89E085C2B8A6A58c6961a1C7BEcF6DF` |
| Deploy | NAVOracle（W2 那颗，前端不用） | `0x4Ac121e1afdD17E573210B9516c16486B14Ec55a` |
| Deploy | PoRRegistry | `0xa0A94855e98DA9747bCbB4a11FDCb3F9EC90c100` |
| Deploy | Queue（W2 那颗，前端不用） | `0x6D615ee0D7e2223c6474AfE306bD9f851C5e8549` |
| Deploy | ReservePSM | `0xc681cF88d7E2142b7cE9afd829Ac8663c5A48b18` |
| Deploy | AdapterFactory（W2 demo，前端不用） | `0x93c417401F0188826133FC769b5762ddb69378E5` |
| Deploy | RWAAdapter（W2 demo，前端不用） | `0x4d47EA4B2467eA61Dbb424b04a9c7453B4C77329` |
| Deploy | SToken / RWAToken | `0x0d15d37c2E5CcD82dbaB14aE90E145Db90A6c31f` |
| Deploy | JToken | `0x1dAc0f0ec1Ddb8a4cb34B4CaebAf7e2DF5CA3602` |
| Deploy | MintBurnController | `0xBE79B3C282A0bDF8E4C8a1627B4F220a4a1A8114` |
| DeployW3 | **StateManager** | `0xb0806C368254E9C2A7BDf8A93a593b8160356802` |
| DeployW3 | ClaimRegistry | `0xEfD95A0cd29652C9374b4c309f1De159ad99574d` |
| DeployW3 | **NAVOracle** | `0x9b204464a357972B9E6935a1f80D2a2f2f6520a5` |
| DeployW3 | **Queue** | `0x176cf1cfE7A4B8EA6961c9E39A41575F2638fD23` |
| DeployW3 | LiquidityBridge | `0xC35474Af87acDf64d57424E039561fd2eD30a232` |
| DeployW3 | **UnifiedPool** | `0x9a1c8d73faB354AdDDcBDEAa92D81035687F6645` |
| DeployW3 | VaultFactory | `0x298c33484760d043844123E4141869dc61973af6` |
| DeployW3 | **CashVault** | `0xe0265431A84E5A53914566B6bf1B5aD91D37285E` |
| DeployW3 | **NoteVault** | `0x3c1cbB3092E221B928A4daaFa3E072D66AdEa0E9` |
| DeployW3 | **LPVault** | `0xAD0BcaaEC4ff8ecc94b3c0aC028dA713f6767420` |
| DeployW3 | CashVaultTimelock | `0x5c143A9BEb314902f87e8b5e899cFF04873F63DC` |
| DeployW3 | NoteVaultTimelock | `0x6099Fcc15ae895c1C01afcF0f265475BE554B280` |
| DeployW3 | LPVaultTimelock | `0xfcC90D6813aA07Ecb42b6aC3ba7BCb54a438F3Ed` |
| DeployW4 | **Settlement** | `0xdB7F914Bd1FA892cA3026F8C1727651A871c3c6A` |
| DeployW4 | **AdapterFactory** | `0x6D7320249dAF7Ff64aA5C0d8aa7808B72dA6ACEA` |
| DeployW4 | **CashAdapter** | `0x7c6a340c8653344d41beB91531720fD754AAf5A0` |
| DeployW4 | **NoteAdapter** | `0x6f0e924F94AB05Ae39d991b92880cDB8767EA3A4` |
| DeployW4 | **LPAdapter** | `0xF486F553a8038d8b7F8CE7c840ddac59b964CAa5` |

### 重复合约的厘清

与 v5／v6 一样，三阶段会产生两个 `NAVOracle`、两个 `Queue`、两个 `AdapterFactory`：

| 合约 | 实际接线（用这个） | 另一份（不要用） | 判定依据（`cast call`） |
|---|---|---|---|
| `Queue` | **`0x176cf1cf…`**（W3） | `0x6D615ee0…`（W2，绑 StubStateManager） | `Settlement.queue()` = `0x176cf1cf…`；三个 Vault 的 `queue()` 都 = `0x176cf1cf…`；`W3 Queue.sm()` = `0xb0806C36…`（真 StateManager），`W2 Queue.sm()` = `0xfceE6941…`（Stub） |
| `AdapterFactory` | **`0x6D732024…`**（W4） | `0x93c41740…`（W2 demo） | `W4 AdapterFactory.isAdapter(cashAdapter)` = `true` |
| `NAVOracle` | **`0x9b204464…`**（W3，前端 key 用这个） | `0x4Ac121e1…`（W2，供 W2 demo RWAAdapter） | 脚本的 `setSigner` 只打在 W2 那颗上；W3 那颗由阶段四手动补设（见下） |

W3 那颗 NAVOracle 的 signer 已于阶段四手动补设为部署钱包：

```
W3 NAVOracle.signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538   (本次手动补设)
```

> **这个 signer 是暂时值。** 客户正式的 NAV signer 名单给了之后，以 NAVOracle owner 身份调用
> `setSigner(rwaToken, signer)` 换掉。

---

## 各阶段交易记录

### 阶段一：`Deploy`（18 笔，全部 status `0x1`，合计 27,932,096 gas，区块 126,290,644 – 126,290,771）

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | HyperAccessControl | `0xa28f34b9e7f2e6191e9e326bb08910cf7d9ce67107a9c2b19cf73bb9fe68de00` |
| 2 | CREATE | StubStateManager | `0x7b900b054870f1c09dfa73d60b215a912ed31352e84bcfa123ee37297649a306` |
| 3 | CREATE | MockUSDT | `0x80e587c41f8a3444398ea51cdb9864b13aecc8906bce75e2ebd577f002499b82` |
| 4 | CREATE | RevenuePool | `0xe0922e6438364e98c2b7af36f6aec8679b31793b76e723e80a31da4c3af79dea` |
| 5 | CREATE | ProtocolFeeConfig | `0x43910b3fc2f26c4e434609f147e1abf3b3d336844faca24770ce45f830412ffd` |
| 6 | CREATE | AssetRegistry | `0xe420b7901d5a9e2589a964f8876939ffd071acfb7337f1424d52bc02e075544b` |
| 7 | CREATE | NAVOracle (W2) | `0x2328ffce2b2e628d706a840d05a4aa95ea0637cbf7bcca0e3ba3d3bbc75f3c58` |
| 8 | CREATE | PoRRegistry | `0xfa1078d34c6eae8be5153ef25b4dbfb550cef35962fc53e47065efb53d2f0148` |
| 9 | CALL | AssetRegistry.registerAsset | `0x0a9668243d2a73abea6910960f84d83c8aad72448dbd22cbe6f5b22ecc169db6` |
| 10 | CALL | AssetRegistry.registerAsset | `0x78ae9db2bf70fa1004244d0b3394b5f6130a0a26c39a309121a977c549da7c20` |
| 11 | CREATE | Queue (W2) | `0xa535bd055fe72fada02af67d78d63379a1a846044d959ace93596ebecc623ea4` |
| 12 | CREATE | ReservePSM | `0xf88c0950cfffbf62d7dbe35a0c9275d8067245945dfe64ab4939a3d1ba4b53ee` |
| 13 | CALL | ReservePSM.deployWrappedToken | `0xb4a8ad6026bb8d7bfec9d02ad1782c4beada9bc6b1648a4447e8c76cdf1a5574` |
| 14 | CREATE | AdapterFactory (W2) | `0xb10f570a98814fd75c91e1213c34c5dc0953f1fd12dff5a8036d3c4a7d901f6b` |
| 15 | CALL | AdapterFactory.deployRWAAdapter | `0xb38fbf382924575f7679d471290018689507a831c852796ba581fa41fa5ce4fc` |
| 16 | CALL | MintBurnController.setTokenAgent | `0xfb2f18a1f80ca09154c38226370adfbf3b332f8e6956d99be293d1909de0ea93` |
| 17 | CALL | MintBurnController.setTokenAgent | `0x6fb90e5ff88280103b0a025fa584207c572a38870348eaa37e55b168a514fe65` |
| 18 | CALL | NAVOracle(W2).setSigner | `0x87cd0fa5edf1ab07420a8f43ff0c769c6c683bed2a18b349784af3f7325535af` |

### 阶段二：`DeployW3`（24 笔，全部 status `0x1`，合计 43,067,976 gas，区块 126,290,858 – 126,291,043）

环境变量：`HYPER_ACCESS_CONTROL=0x6A9927a5…`、`REVENUE_POOL=0xFa600451…`、
`USDT=0x38eE768D…`、`PROTOCOL_FEE_CONFIG=0xE3083110…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | StateManager | `0x1de7c59c94037f29fb6b3a56dc6b6435deeb79ffe8d3412b6277d61bb0476174` |
| 2 | CREATE | ClaimRegistry | `0xed133ad69bf0e9f99fe3774a6d440866433f6a2aeb8f6667f4afd85bb674e3cf` |
| 3 | CREATE | NAVOracle (W3) | `0xfbd9e8ed2275f7db34c23238b6e7a3d9617622bcc2f572b096573542023c61b4` |
| 4 | CREATE | Queue (W3) | `0xdff759d46c9e3e35afc84ff3918893a05ec7af8c10ccb5c5c306f6529775a738` |
| 5 | CREATE | LiquidityBridge | `0xccc50c4dfa1738803af305c71b6ab8353d39cdfb066a867909154c5288c9a3bf` |
| 6 | CREATE | UnifiedPool（实现） | `0xc8ff08dfceafacbe2c251576d545f5d376980c20b3302583473d9124ec4b5671` |
| 7 | CREATE | ERC1967Proxy（UnifiedPool 代理） | `0x4b553abab1b67e0c157774d1d021350e3f1a020c79d613a7f7b3a9e623f9a647` |
| 8 | CALL | addAuthorizedSource | `0x6a098b70516f405f7c8825b027b2772fe0c50e023be2dc199e1451e249e5ab05` |
| 9 | CREATE | EarnVaultDeployer | `0xef107982c7d4829d6b90f3be3c7910b60380d84f799423589cf70486243227e9` |
| 10 | CREATE | LiquidityEarnVaultDeployer | `0x9b5b0769d98970471aa23536cd1c5502ff254c2c9baa769325d1a9be45253dfe` |
| 11 | CREATE | VaultFactory | `0xe4c1a625f95f69c111d4141f0486cda1332a43a18487e70d57d0025c11938dc1` |
| 12 | CALL | StateManager.setVaultFactory | `0xde1b9c75eea35978d5b1c2daa43ed96498073cc3c40bc7332fc0b299be111ca0` |
| 13 | CALL | VaultFactory.deployVault (Cash) | `0x0dcc62f2882d082f2d512ab0a7fdf9ab9124c741879c46003ad1e4ca7969e739` |
| 14 | CALL | VaultFactory.deployVault (Note) | `0x2fe0f2695fbb3f7166f6171bc1e944ca965521b1fb55ad4251d0941f763d3f18` |
| 15 | CALL | VaultFactory.deployVault (LP) | `0xb137a5538a1dcd26295bbf90dccc7febdc6f6bef04036ffec5ba280a2b08b5b7` |
| 16 | CALL | CashVault.setKeeper | `0x572ba54c39cfd93848f4dec672181d4c4af22bcb679e840f5189dc9c7d3cb756` |
| 17 | CALL | CashVault.setCurator | `0xc274c13ca4456f943a0116b03d0432fbca5356dba0adf4470ce4f15f4ea66cad` |
| 18 | CALL | NoteVault.setKeeper | `0xa6ce2cbaf285367e7ab92ec940c03ef7286dac562a127be39e84ad6c06da9413` |
| 19 | CALL | NoteVault.setCurator | `0xda4909aa8dcfc150242881dd5e7c222d9d50f0eb3847e531ffe61fbc4c9b23a1` |
| 20 | CALL | LPVault.setKeeper | `0xfdcccbec1dcaaa5332a780814ec649bb64e9966c247b3a5275ebb7f535698844` |
| 21 | CALL | LPVault.setCurator | `0xec19ec3d789cb9635193cd28410b4e560e666f8d11c7fca88f977257eb654292` |
| 22 | CALL | UnifiedPool.addTrancheVault (Cash) | `0x80a04c68c98ebb40f5bba56a364265110c3d631b49bee29ca986181ba1d6d728` |
| 23 | CALL | UnifiedPool.addTrancheVault (Note) | `0xccc059b17d3305d19d4b99be6a669e46862ba0998d46f14b2b6eb611f7fbefaa` |
| 24 | CALL | UnifiedPool.addTrancheVault (LP) | `0xafe1df0fbf741541e2bc1dfddfd67f5b24b839e490f929453a7c775a98bde547` |

> 相对 v6 的 27 笔少了 3 笔：v6 需要单独 CREATE `EarnVault` / `LiquidityEarnVault` 两个实现合约
> 再做克隆，本代三次 `deployVault` 直接在交易内部完成全量部署。

### 阶段三：`DeployW4`（23 笔，全部 status `0x1`，合计 21,310,566 gas，区块 126,291,168 – 126,291,331）

环境变量另加：`STATE_MANAGER=0xb0806C36…`、`QUEUE=0x176cf1cf…`、
**`UNIFIED_POOL=0x9a1c8d73…`（来自 DeployW3 的输出）**、
`CASH_VAULT=0xe0265431…`、`NOTE_VAULT=0x3c1cbB30…`、`LP_VAULT=0xAD0BcaaE…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | Settlement | `0x73f9e136a95167c9c501ff2909b857f0a402a2fbc90188fa164751154981af66` |
| 2 | CALL | CashVault.setSettlement | `0xff3991295ad4eac349a8a9cb376cb0f6def8f62087fb71df99cc28b45727c681` |
| 3 | CALL | NoteVault.setSettlement | `0xa7b86c0e2d31aa5432e8197dafbed24fe31454631b3d65d250b92cb8f9020011` |
| 4 | CALL | LPVault.setSettlement | `0xfcdc43f7a30ddd7320defdfa97f2b4b40fa22bf31db51326f74bb61891fa45dc` |
| 5 | CALL | Settlement.setOperator (Cash) | `0x6be26326f1663a61d7fee4b9020ef48e014ab2ec4fbdb0dc6f3adb0e10b47e28` |
| 6 | CALL | Settlement.setThreshold (Cash) | `0x5418dfe9a38c6212d9ad590edd62e62f5e1f05c8aaad8b46e543988911ba2f35` |
| 7 | CALL | Settlement.setOperator (Note) | `0x864fb1d0caa52b33dd37254d651951cf08f85501cf89b23ca7da1e13d41a70ca` |
| 8 | CALL | Settlement.setThreshold (Note) | `0xbb123506015ec7183fc62a335357c5b2630e72e9f69c8af075e67b231eb2a70a` |
| 9 | CALL | Settlement.setOperator (LP) | `0x7410b7d293dda6c5d0f3f1e137bff5d67720b57bf7ee8bdcbb578aec73369c43` |
| 10 | CALL | Settlement.setThreshold (LP) | `0xc8e1d9c2e73f255b95b65de9e6aa9e27b2f7f45ada3b2530571f52c897563d5e` |
| 11 | CREATE | AdapterFactory | `0xe53713dd72704ce021862a1af754a8bcdd1019a5d7606498d5976749146426bf` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | `0xa0f4bfbe41e3c7d7894a6d3e1c62f2434f61571be6fb625bf73279119b024abe` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | `0x6e0e8f0ae55b6aa64290879b4de7a4701c39d549f2967fb63b849ddd275ffdbd` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | `0x0030e07ad0c69dba5cf9ab8b313af248e0bbfdb8bdda06fd35af83f81b281eef` |
| 15 | CALL | LPVault.setAdapter | `0x48ccc4c3e4cc42c75dd2a73aa8e1f6b50b1bdd2a09484f9db57fc8bc62811980` |
| 16 | CALL | CashVault.addAdapter | `0x11e766c71eac388884d47eb31ce26d4fb0f8d783f0895fc04ccd0792a1e6760b` |
| 17 | CALL | NoteVault.addAdapter | `0xf3e48c3aea763928ae144734f0ae4a809f81b8f94aadadddd475a87e8dd70156` |
| 18 | CALL | CashVault.setUnifiedPool | `0x765e793d29906a098eb0024ab84013e358229717515c0e2fbdc248af5210eee2` |
| 19 | CALL | NoteVault.setUnifiedPool | `0xc976eb0738637253da1c2884785873c8b75af112281bb78ab26c6b117f2e9a29` |
| 20 | CALL | LPVault.setUnifiedPool | `0x1e0d1e3fc1efd2e13cd6c50401c2a888a3950c6bc0d7c83f64994f1cab59027d` |
| 21 | CALL | CashAdapter.setDataProvider | `0x2136345ef0e29031866f25853c15a5d218e131daaa86e3778f0cfd6644dccecf` |
| 22 | CALL | NoteAdapter.setDataProvider | `0x3fa409199328900c5e8f0b37108389d3389119bbb2f4fef8b50c9cb88dc8c293` |
| 23 | CALL | LPAdapter.setDataProvider | `0x7ab46db8edf537f86e3e70e71484f7403bbbb093b001f0595fa216495f0ef3ec` |

> 相对 v6 的 26 笔少了 3 笔 `AdapterRegistry.setAdapterAllowed` —— `AdapterRegistry` 已删除。

### 阶段四：部署后手动配置（8 笔 `cast send`，全部 status `0x1`，合计 391,038 gas，区块 126,291,676 – 126,291,790）

| 动作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0xd84913f11f384b7b105f564357e01123e21f841372ce7800d30972e9191407fe` |
| `CashVault.setGuardian(deployer)` | 48,438 | `0x98c71fd6271f943c06a112c540c3e9b30be58bfdeff15485ea44e840ff5bfa95` |
| `CashVault.setAllocator(deployer)` | 48,394 | `0x833a9835f6e767de03ac49e765d064cd77286f87c8488c8de2f87c99afc4ba4a` |
| `NoteVault.setGuardian(deployer)` | 48,438 | `0x7cdc7fe1abc05b615206062b7d390ee9e7f49f1bf929595065bc72f9b3e02b6f` |
| `NoteVault.setAllocator(deployer)` | 48,394 | `0xefe8107e079b3332ec6abd6c818702f9d776cc605530ddb707e93e15031e02a9` |
| `LPVault.setGuardian(deployer)` | 48,394 | `0xf1a67f57f2348f8ebbf3442d609a244c0160cb6757981c15a815eeb71d935676` |
| `LPVault.setAllocator(deployer)` | 48,416 | `0x817bb61ac275a914a1f725b4afb36f68a32f1c7454845995b386604e4e58c4b8` |
| **`NAVOracle(W3).setSigner(SToken, deployer)`** | 48,251 | `0x2db9cc972ba84a1f85fa7ee2bd8acf7f5a72a32662c36bf70f5a963b3c716cc7` |

> **注**：与 v3／v4／v5／v6 一样，8 笔里有 7 笔第一次送出时被 RPC 负载平衡后端以 `nonce too low`
> 拒绝（交易未上链、未耗 gas）。逐笔自动重送后全部成功，上表是成功的那 8 笔。
> Settlement threshold / operator 与三个 Adapter 的 Data Provider 已由 `DeployW4` 设好，阶段四不需再送。

### 阶段五：测试钱包补铸 MockUSDT — **本次未运行**

新的 MockUSDT 是 `0x38eE768D4E1070FFF07997e3674a02F6cEC6D957`，v6 的 MockUSDT
`0x6F86108A…` 上的余额在新环境等于不存在，15 个测试钱包的 USDT 全部归零。
需要跑集成测试前，`offchain/scripts/testnet/addresses.bscTestnet.json` 已随本次部署更新到 v7 地址，直接运行：

```
cd offchain
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run   # 先看计划
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts             # 实际送出
```

---

## 部署后验证

以下均为本次部署后以 `cast call` 实测的结果：

```
# 三个 Vault 不是克隆（runtime 大小 = 本地编译产物大小）
CashVault  runtime = 22,343 bytes      (forge build --sizes: EarnVault 22,343)
NoteVault  runtime = 22,343 bytes      (forge build --sizes: EarnVault 22,343)
LPVault    runtime = 21,263 bytes      (forge build --sizes: LiquidityEarnVault 21,263)

# 核心接线
StateManager.vaultFactory()  = 0x298c33484760d043844123E4141869dc61973af6
Settlement.queue()           = 0x176cf1cfE7A4B8EA6961c9E39A41575F2638fD23
CashVault.queue()            = 0x176cf1cfE7A4B8EA6961c9E39A41575F2638fD23
NoteVault.queue()            = 0x176cf1cfE7A4B8EA6961c9E39A41575F2638fD23
LPVault.queue()              = 0x176cf1cfE7A4B8EA6961c9E39A41575F2638fD23
Cash/Note/LP .settlement()   = 0xdB7F914Bd1FA892cA3026F8C1727651A871c3c6A
Cash/Note/LP .unifiedPool()  = 0x9a1c8d73faB354AdDDcBDEAa92D81035687F6645
W4 AdapterFactory.isAdapter(cashAdapter) = true

# 角色与参数
Cash/Note/LP .guardian()     = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP .allocator()    = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Settlement.threshold(each)   = 1
Settlement.isOperator(each, deployer) = true
Cash/Note/LP Adapter.dataProvider()   = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
ProtocolFeeConfig.paymentTokenOf(Stable) = 0x38eE768D4E1070FFF07997e3674a02F6cEC6D957
W3 NAVOracle.signerOf(SToken)            = 0x425beB70d264362E4eb7953C4f7aFBDe01145538

# 认购上限（确认为不限额）
Cash/Note/LP .subscriptionCapShare()  = 0
```

本地校验：`forge build` 通过（仅有既有 lint 警告），`forge test` **954 项全部通过、0 失败**。

---

## 角色一览（本代全部指向部署钱包，均为暂时值）

| 角色 | 载体 | 当前持有者 |
|---|---|---|
| Governor / Issuer / Token Agent | HyperAccessControl | 部署钱包 |
| Owner | 三个 Vault | 部署钱包 |
| Curator | 三个 Vault | 部署钱包 |
| Keeper | 三个 Vault | 部署钱包 |
| Guardian | 三个 Vault（阶段四补设） | 部署钱包 |
| Allocator | 三个 Vault（阶段四补设） | 部署钱包 |
| Settlement Operator | Settlement（threshold = 1） | 部署钱包 |
| Data Provider | 三个 Adapter | 部署钱包 |
| NAV Signer | NAVOracle **W2 `0x4Ac121e1…`**（脚本设置，对 SToken） | 部署钱包 |
| NAV Signer | NAVOracle **W3 `0x9b204464…`**（阶段四补设，对 SToken） | 部署钱包（**暂时值**） |

---

## 交接给客户前仍待处理

| # | 事项 | 说明 |
|---|---|---|
| 1 | `subscriptionCapShare` | 三个 Vault 目前都是 `0`（不限额），开放认购前 Curator 必须设定。 |
| 2 | NAVOracle signer 的正式名单 | W2／W3 两颗目前都指向部署钱包，属暂时值。 |
| 3 | Settlement operator 名单与 threshold | 目前是单签（部署钱包，threshold = 1），正式环境需换成客户的多签名单。 |
| 4 | Guardian / Allocator / Curator / Keeper | 目前全是部署钱包，需按客户的角色分工移交。 |
| 5 | 测试钱包补铸 MockUSDT | 阶段五本次未运行，跑集成测试前需先执行。 |
| 6 | `EarnVaultDeployer` 体积余量 | 只剩 401 字节，后续改动 `EarnVault` 前必须先确认体积。 |
