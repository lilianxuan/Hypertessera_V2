# BNB Smart Chain Testnet 全新部署记录 v9（2026-08-26）

> ⚠️ **本文档已作废**：本代（v9）的 chainId 97 地址已被 [`deployment-bsctestnet-2026-08-29-v10.md`](./deployment-bsctestnet-2026-08-29-v10.md) 取代，请改用 v10 的地址。**例外**：MockUSDT `0xF7611799e16E5fFcAA00dBA882DB6e73F0731921` 被 v10 沿用，仍然有效。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署钱包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三个 Vault 的 Owner）
- **源代码 commit**：`612ddf1`（PR #31 `Audit Feedback V2 剩余四项（#2/#4/#6/#11）+ rebalance deal 入口 + 回复文档补齐十二份来源`，分支 `main`）
- **脚本**：`script/Deploy.s.sol`，依序运行 `Deploy` → `DeployW3` → `DeployW4`，全部带 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **区块范围**：`127,300,833` – `127,301,608`
- **交易笔数**：17 + 24 + 23 + 11 = **75 笔，全部 status `0x1`**
- **取代**：[`deployment-bsctestnet-2026-08-26-v8.md`](./deployment-bsctestnet-2026-08-26-v8.md)（commit `c4d4b90`）。
  **v8 那一代的 chainId 97 地址全部作废，请改用本文档的地址** —— 唯一例外是 MockUSDT，见下。

---

> ## ✅ 本代唯一沿用 v8 的合约：MockUSDT
>
> ```
> MockUSDT  0xF7611799e16E5fFcAA00dBA882DB6e73F0731921   （与 v8 完全相同）
> ```
>
> 此前每换一代都会重新部署 MockUSDT，导致 15 个测试钱包的 USDT 余额全部归零，必须重跑
> `fundWallets.ts` 补铸。本次改为**沿用 v8 那一颗**：
>
> - MockUSDT 是独立的 ERC-20，`mint` 完全开放，**不持有任何协议合约的引用** ——
>   `RevenuePool`、`ProtocolFeeConfig`、`ReservePSM`、三个 Vault 与三个 Adapter 都只是把它的地址
>   当作构造参数/入参使用。因此换代不需要换币。
> - `script/Deploy.s.sol` 新增读取环境变量 `USDT`：**已设置则沿用该地址，未设置（或为 0）则照旧
>   部署一颗新的**（本机 anvil 全量部署仍走新部署路径，行为不变）。
> - 结果：**15 个测试钱包的 100,000 USDT 全部保留，本代不需要执行阶段五**。
>   实测 `fundWallets.ts --dry-run` 输出 `0/15 wallets need BNB, 0/15 need USDT`。
>
> 副作用：v8 一代的合约仍在链上，且与本代共用同一颗 USDT。这在测试网无实际影响 ——
> 两代合约互不引用，v8 的 Vault 只是不再被使用。若需要彻底隔离，把 `USDT` 环境变量留空重新部署
> 一颗即可。

> ## ⚠️ 本代新增：`BaseVault.configureClaimRegistry` 必须在部署后接线
>
> Audit Feedback V2 #11 的修复引入了 `claimRegistry` 与 `claimGracePeriod` 两个 Vault 级参数，
> 它们**不在构造函数里**，需要部署后单独设置（与 `setSettlement` / `setUnifiedPool` 一样）。
> 本次已在阶段四为三个 Vault 设好：
>
> ```
> claimRegistry    = 0x69C7b88259C37d6C95ac48d40C50157eCaf9856a
> claimGracePeriod = 2,592,000 秒（30 天）
> ```
>
> **`claimGracePeriod = 30 天` 是我们暂定的运营参数，请贵方确认。** 它决定
> `recordOverdueClaims` 最早可以在到期后多久登记逾期未领请求。修改走该 Vault 的 VaultTimelock
> （`configureClaimRegistry` 已加入 OWNER 类白名单）。

> ## ⚠️ 沿用历代的操作陷阱：`subscriptionCapShare` 仍是 `0`
>
> ```
> CashVault / NoteVault / LPVault .subscriptionCapShare() = 0
> ```
>
> `0` 代表**不限额**。`script/Deploy.s.sol` 不碰任何产品参数，**Curator 必须在开放认购之前把募集
> 上限写进 `ProductParams.subscriptionCapShare`**，否则认购金额不受限制。本次已确认三个 Vault
> 该值均为 `0`，为预期状态。

---

## 这次相对 v8 改了什么

v8 的 commit 是 `c4d4b90`，本次是 `612ddf1`。中间只有一个合并提交，即 PR #31：

```
612ddf1 fix: Audit Feedback V2 剩余四项（#2/#4/#6/#11）+ rebalance deal 入口 + 回复文档补齐十二份来源 (#31)
```

内容对应 [`contract-feedback-20260824-response.md`](./contract-feedback-20260824-response.md) 第十二部分：

| V2 # | 改动 | 对本次部署的可见影响 |
|---|---|---|
| 2 | `pendingDeposits` 键区分订单类型（buy / rebalance 分属两个键空间） | `liveDealOrderIds` 中 rebalance 条目为 `2**128 + orderId`，链下读取需注意 |
| — | 新增 `updateRebalanceDealData` / `clearRebalanceDealValue` | Adapter ABI 新增两个函数与两个事件（纯加法） |
| 4 | `RWAAdapter` 新增受控 RWA 转出订单簿 | `RWAAdapter` 新增三个函数；本代 W2 demo RWAAdapter 体积 11,247 → 12,982 |
| 6 | 时效检查仅对 VALUE_RETURN 执行 | 行为改动，地址表无变化 |
| 11 | `BaseVault.recordOverdueClaims` + `configureClaimRegistry` | **阶段四新增 3 笔接线交易** |

### 合约体积

`configureClaimRegistry` / `recordOverdueClaims` 落在 `BaseVault` 上，因此两个 Deployer 都变大：

```
EarnVaultDeployer            23,447 bytes   （余量 1,129，v8 为 2,325）
LiquidityEarnVaultDeployer   23,143 bytes   （余量 1,433，v8 为 2,433）
EarnVault                    21,669 bytes   （余量 2,907）
LiquidityEarnVault           21,287 bytes   （余量 3,289）
```

**`EarnVaultDeployer` 余量只剩 1,129 字节**，后续再往 `BaseVault` 加代码前必须先跑
`forge build --sizes`。

### 部署前本地校验

```
forge build --sizes   →  88 个合约全部非空、0 violation
forge test            →  1010 项全部通过（28 个测试套件，0 失败）
链下单元测试            →  114 项全部通过
```

---

## 完整地址表

### 前端 `deployments.js` 可直接贴入的区块（24 个 key）

> 相对 v8 的 23 个 key，新增 `claimRegistry`（V2 #11 的 `recordOverdueClaims` 需要）。
> `mockUsdt` 与 v8 相同，其余全部换代。

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: '612ddf1',
    addresses: Object.freeze({
      hyperAccessControl: '0x4604424c97647C2E32050A632f6c7286553E1235',
      stateManager: '0xb3f644801c76A78543979D7E9e367D092B1f25aC',
      navOracle: '0xB28Cc9ce17F93EAe8aDD13523D33DcCe81a3515E',
      mintBurnController: '0xF08D09F7A03bCA8EE6b0f727F41Af7c76823F509',
      assetRegistry: '0x83DB56307741aA088Df8391152a184A96a198bB7',
      protocolFeeConfig: '0x7d901Bb4f8815D47Cd26189E7dD8065E68D8C967',
      reservePSM: '0x81Fed2662B7faCa1Dd42A306c60154E27dcA9Cb6',
      poRRegistry: '0x921ca3a939ac6c2a1c10B2316B86ca4BB2C53804',
      claimRegistry: '0x69C7b88259C37d6C95ac48d40C50157eCaf9856a',
      queue: '0xDe7021c2fa32062627f6DA5C7fa03013DA8a96ba',
      revenuePool: '0x651bC8821fcB3a98f54ce7bbcC909fae0543E36A',
      unifiedPool: '0x1a1D347cD6A94AF9389C1523d6C58084896a6FAd',
      settlement: '0xAeE2D999479D886bcB09fA405F0d87844C4fb785',
      vaultFactory: '0x150cA9240c549bd78522Db9ECCD96637Bb910005',
      adapterFactory: '0x8A1c46CD1b0cBd5C32438bb85B5cF8dc73741D58',
      liquidityBridge: '0xce6A8F48EDb96Ddf4Dec3484eFdf284B933499BD',
      mockUsdt: '0xF7611799e16E5fFcAA00dBA882DB6e73F0731921',
      cashVault: '0x367DbE05418DD7fe52599034F9Ec58fbbF553680',
      noteVault: '0x1EB0681A5DB7E5C7D21E1C17667bE5AB39D7C1b6',
      lpVault: '0x4927fca890AB876e4Bc114c8aa13a35256Ba4578',
      cashAdapter: '0x1B0a5a6Cd33B00BC125C3c46E72d85849c03aEFF',
      noteAdapter: '0x5dF104FdEf499c875DC7C261a11e39B99420f890',
      lpAdapter: '0x1A6C940E104D4De6c5421681306aED788ADC2399',
    }),
  }),
})
```

### 全部合约（含前端不用的）

链上实测 runtime 字节数，**全部非空、全部 ≤ 24,576**：

| 阶段 | 合约 | 地址 | runtime |
|---|---|---|---|
| （沿用 v8） | **MockUSDT** | `0xF7611799e16E5fFcAA00dBA882DB6e73F0731921` | 1,708 |
| Deploy (W1/W2) | HyperAccessControl | `0x4604424c97647C2E32050A632f6c7286553E1235` | 969 |
| Deploy | StubStateManager | `0xA760337D902E48185FB5d5969c30e81c0846544A` | 2,429 |
| Deploy | RevenuePool | `0x651bC8821fcB3a98f54ce7bbcC909fae0543E36A` | 3,173 |
| Deploy | ProtocolFeeConfig | `0x7d901Bb4f8815D47Cd26189E7dD8065E68D8C967` | 1,236 |
| Deploy | AssetRegistry | `0x83DB56307741aA088Df8391152a184A96a198bB7` | 11,421 |
| Deploy | MintBurnController（AssetRegistry 内部部署） | `0xF08D09F7A03bCA8EE6b0f727F41Af7c76823F509` | 3,137 |
| Deploy | NAVOracle（W2 那颗，前端不用） | `0x4A48767A20320eb65776d144F31EBc40aFc3E424` | 3,526 |
| Deploy | PoRRegistry | `0x921ca3a939ac6c2a1c10B2316B86ca4BB2C53804` | 2,485 |
| Deploy | SToken / RWAToken（demo 资产 1） | `0x881EB458a12eD57Dd97afCa25d9C9ebfD1324805` | 4,832 |
| Deploy | JToken（demo 资产 2） | `0x79466B59e093D01f68eb4e48a8B21027344E6dD5` | 4,832 |
| Deploy | Queue（W2 那颗，绑 StubStateManager，前端不用） | `0xFfDFD4BB48ABe8C12Ae3094AbD168afd08A11DD7` | 2,740 |
| Deploy | ReservePSM | `0x81Fed2662B7faCa1Dd42A306c60154E27dcA9Cb6` | 9,426 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0x1ADB99B3e85c2Cb3adA5188ec77A1110480fC258` | 2,549 |
| Deploy | RWAAdapter（W2 demo） | `0x745E8B5fa07128Cd2dA27E96d85063Dae53ec502` | 12,982 |
| DeployW3 | **StateManager** | `0xb3f644801c76A78543979D7E9e367D092B1f25aC` | 10,945 |
| DeployW3 | **ClaimRegistry** | `0x69C7b88259C37d6C95ac48d40C50157eCaf9856a` | 1,758 |
| DeployW3 | **NAVOracle** | `0xB28Cc9ce17F93EAe8aDD13523D33DcCe81a3515E` | 3,526 |
| DeployW3 | **Queue** | `0xDe7021c2fa32062627f6DA5C7fa03013DA8a96ba` | 2,740 |
| DeployW3 | **LiquidityBridge** | `0xce6A8F48EDb96Ddf4Dec3484eFdf284B933499BD` | 1,362 |
| DeployW3 | UnifiedPool 实现（前端不用，走代理） | `0xD57583151A67cef305cd762b0Ab1851DC108040C` | 7,072 |
| DeployW3 | **UnifiedPool 代理（ERC1967）** | `0x1a1D347cD6A94AF9389C1523d6C58084896a6FAd` | 130 |
| DeployW3 | EarnVaultDeployer | `0xddb08E6bfE0A9F9B33135F70a1cB36b6DB18A8C5` | 23,447 |
| DeployW3 | LiquidityEarnVaultDeployer | `0xE85653bd7ea51C57C7fb34C2695614408814b69d` | 23,143 |
| DeployW3 | **VaultFactory** | `0x150cA9240c549bd78522Db9ECCD96637Bb910005` | 12,154 |
| DeployW3 | **CashVault** | `0x367DbE05418DD7fe52599034F9Ec58fbbF553680` | 21,669 |
| DeployW3 | **NoteVault** | `0x1EB0681A5DB7E5C7D21E1C17667bE5AB39D7C1b6` | 21,669 |
| DeployW3 | **LPVault** | `0x4927fca890AB876e4Bc114c8aa13a35256Ba4578` | 21,287 |
| DeployW3 | CashVaultTimelock | `0x9B340969267Af629f0c2ECDE9C355725902Fd279` | 5,801 |
| DeployW3 | NoteVaultTimelock | `0x1c9469CC1E1810a8c6145496990012f32bD2E0a3` | 5,801 |
| DeployW3 | LPVaultTimelock | `0x70411929A7B3f954eeb0C23611Df77fB8169Ca9A` | 5,801 |
| DeployW4 | **Settlement** | `0xAeE2D999479D886bcB09fA405F0d87844C4fb785` | 7,176 |
| DeployW4 | **AdapterFactory** | `0x8A1c46CD1b0cBd5C32438bb85B5cF8dc73741D58` | 2,549 |
| DeployW4 | **CashAdapter**（FirstPeriodAdapter） | `0x1B0a5a6Cd33B00BC125C3c46E72d85849c03aEFF` | 10,962 |
| DeployW4 | **NoteAdapter**（FirstPeriodAdapter） | `0x5dF104FdEf499c875DC7C261a11e39B99420f890` | 10,962 |
| DeployW4 | **LPAdapter**（LiquidityAdapter） | `0x1A6C940E104D4De6c5421681306aED788ADC2399` | 11,520 |

三个 Vault 是各自完整部署的独立合约（不是 EIP-1167 克隆）：链上 runtime
21,669 / 21,669 / 21,287 与本地 `forge build --sizes` 的 `EarnVault` 21,669、
`LiquidityEarnVault` 21,287 完全一致。

### 角色

| 角色 | 地址 | 说明 |
|---|---|---|
| Governor / Owner | `0x425beB70d264362E4eb7953C4f7aFBDe01145538` | 三个 Vault 的 owner，AssetRegistry 的 Issuer |
| Curator / Keeper（三个 Vault） | 同上 | `DeployW3` 设定 |
| Guardian / Allocator（三个 Vault） | 同上 | 阶段四手动设定 |
| Settlement Operator（三个 Vault，threshold = 1） | 同上 | `DeployW4` 设定 |
| Data Provider（三个 Adapter） | 同上 | `DeployW4` 设定 |
| Token Agent（asset 1 / 2） | 同上 | `Deploy` 设定 |
| NAV Signer（W3 NAVOracle，SToken） | 同上 | 阶段四手动设定 |

> 全部角色暂时都指向部署钱包。客户正式名单给出后，以对应 owner 身份逐个换掉。

---

## 各阶段交易记录

### 阶段一：`Deploy`（17 笔，全部 status `0x1`，合计 25,030,180 gas，区块 127,300,833 – 127,300,954）

```
USDT=0xF7611799e16E5fFcAA00dBA882DB6e73F0731921 \
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

> 比 v8 的 18 笔少一笔：`USDT` 已设置，本阶段不再 CREATE MockUSDT。

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | HyperAccessControl | `0xd1fec5124d140e7e5112f27ef6f705657db4cbf4ac40897a8b1bc71d44707fa8` |
| 2 | CREATE | StubStateManager | `0x94bcbb64bbb4b38707dbf6b62ec505b2895afbbae7b339063239601f8c73aa3c` |
| 3 | CREATE | RevenuePool | `0x4c077999d55d88d3f950646461f20288f17a2f82d6c990c40195493ee3b2e7a6` |
| 4 | CREATE | ProtocolFeeConfig | `0x83cb5025a20031e72bb7545817d91738e7e67108e660d6726bfce7df74bf0594` |
| 5 | CREATE | AssetRegistry | `0x8c1ade14799056a53e3213f56cb7bf0ab095a5fe63cb5452cf0baf3aaafd034a` |
| 6 | CREATE | NAVOracle | `0xd7dd34365a9c63dffdf923d2ff5bc51c817a004f737733822121dd21296de200` |
| 7 | CREATE | PoRRegistry | `0x476388069a0ac8e81498280f57bfe5b9993bff0de0a8d3bbbadde72406d56147` |
| 8 | CALL | AssetRegistry.registerAsset | `0x0648764f7d89dfeabda92c9b159ea5020121816b37dac1fc493e46f150019713` |
| 9 | CALL | AssetRegistry.registerAsset | `0xdcd5cd284d6785483ac94b7c9c8da0a34b082c1af24b4bf0dcb9d33c21c20844` |
| 10 | CREATE | Queue | `0x1b0f05dfbbe21540b0fa24b365b50d520cd89fef0f66d5cd311b8e0fa9616f6a` |
| 11 | CREATE | ReservePSM | `0x6de01c007044982ea55ecb24fd1d4bc4fb2873e455368b09b6f7e27a39a10438` |
| 12 | CALL | ReservePSM.deployWrappedToken | `0xa4970a9e21d8017fe6788661acbc807e04d889455ddbb9e74378527fbe340f71` |
| 13 | CREATE | AdapterFactory | `0xc0ddf3ae732f2d398f5841e0deb40003822cebdf492563df4d19bf1735d7b49c` |
| 14 | CALL | AdapterFactory.deployRWAAdapter | `0xa506f1d0bad539f92d483b13c6ef738ded1cf8a1b582ec29c7e9391108cbca16` |
| 15 | CALL | MintBurnController.setTokenAgent | `0x9b00b8a23cb3e601a53eaae479be6a0529cea4d2a2b7c98ed9473e2650212171` |
| 16 | CALL | MintBurnController.setTokenAgent | `0xeed299ed68c0e384b30bc5f97d48360fda70f480720da89ccf4f6210a55d6cc0` |
| 17 | CALL | NAVOracle.setSigner | `0xc23906bab6de8931114e2c3758124f573ba105095fab3edc2608049dce375a66` |

### 阶段二：`DeployW3`（24 笔，全部 status `0x1`，合计 40,586,676 gas，区块 127,301,042 – 127,301,218）

环境变量：`HYPER_ACCESS_CONTROL=0x4604424c…`、`REVENUE_POOL=0x651bC882…`、
`USDT=0xF7611799…`、`PROTOCOL_FEE_CONFIG=0x7d901Bb4…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | StateManager | `0x9a3a64fe88d5deabc6131b3256047226a2c85e7f667a8f2179bdf470066b13ab` |
| 2 | CREATE | ClaimRegistry | `0x22e314ada7045fd839c189c7538645f1de348cdb7d527bb9c41b9858d307fcc0` |
| 3 | CREATE | NAVOracle | `0x5098bf7ff2add95dbc4351e5b7e8b3d716efa7c96d0f80c36b5b1934ef712e03` |
| 4 | CREATE | Queue | `0xdf3e46194d9ece7418ea26313528a080b1c786e6982491ff6726f0859b759ca0` |
| 5 | CREATE | LiquidityBridge | `0x63e2b1d031828448dcb7328279d5aa61817f4c42a9ad7d027015252646a55e79` |
| 6 | CREATE | UnifiedPool | `0x080178ec9bc986d520286298a9b293a126a047f236309d43554d6e4fa660056d` |
| 7 | CREATE | ERC1967Proxy | `0x5e7c35cb2090458a23dacdfb1e3f1c1c452f013133a61ffa536d3d4bf89686f9` |
| 8 | CALL | addAuthorizedSource | `0x5b03a204ffa2b96524ecead75807577da9004dba70eba1778b62883c04656e4a` |
| 9 | CREATE | EarnVaultDeployer | `0x0e60703ba8384a7a2dc74dee78f6a9612942d5f42c59e05c71015e5ac93ac730` |
| 10 | CREATE | LiquidityEarnVaultDeployer | `0x6d852728586581bb231f9d1d49a92d2309d1b9afcac724b85089d294a0b4b3b3` |
| 11 | CREATE | VaultFactory | `0xd01229ee1a54590882aec10523585558847b7e488f15782f49c1b46b62a6bc56` |
| 12 | CALL | StateManager.setVaultFactory | `0xa859eb947a7b7b5a651ac63fd16aa1906c5540edd6d77c7f2cc1446c941f7511` |
| 13 | CALL | VaultFactory.deployVault | `0x1ad582e89b99024e1f5c7fee3865b31016a0ef0ac7bcf1aa84dc6a77c662d50f` |
| 14 | CALL | VaultFactory.deployVault | `0xe11262ba8b1ef19037a91ba3192d97b43c20488b9ad3c1b4c4b6ffe40df6accf` |
| 15 | CALL | VaultFactory.deployVault | `0xddc0e2ddacc9f92855828b0bc173b0eefbb317d902c97813c914aff3fc821a46` |
| 16 | CALL | EarnVault.setKeeper | `0xc7abb4ba31f67264ab49d70a26086d5e2084657a574f223717f9c635cd126532` |
| 17 | CALL | EarnVault.setCurator | `0xcb11370eb42d5f4fc98cd419a4482fdc79a8bc8e6336142623c32492ca97cc0a` |
| 18 | CALL | EarnVault.setKeeper | `0xc35c1c3dc804c2999832c96433a3f5b5da55777029c3fbd5c1509239aab5d38a` |
| 19 | CALL | EarnVault.setCurator | `0x3d247982927a3187a5a9664073940792db80eef58c66e72f439e33664151628f` |
| 20 | CALL | LiquidityEarnVault.setKeeper | `0x190a5637093e5005fe22f402221c4b07bc875c3e9c906d7731dcb6827fae6537` |
| 21 | CALL | LiquidityEarnVault.setCurator | `0x99b7874a2aa321df3b885c61f0de0254735653fcf2aa08c856dea5c6e36c0eeb` |
| 22 | CALL | ERC1967Proxy.call | `0x30faa55a1b03666670d20cb8ded27db8b34d5da7764882d1e617b6aac8043bd3` |
| 23 | CALL | ERC1967Proxy.call | `0x8c640a90a4f0935b10154e01942f33351be7a65267d985cf84b2149068c38049` |
| 24 | CALL | ERC1967Proxy.call | `0x80fdefa43721a646e65fa1aca32457f3772cc6140ca4300c3a766120e43b7df0` |

### 阶段三：`DeployW4`（23 笔，全部 status `0x1`，合计 19,795,806 gas，区块 127,301,315 – 127,301,489）

环境变量另加：`STATE_MANAGER=0xb3f64480…`、`QUEUE=0xDe7021c2…`、
**`UNIFIED_POOL=0x1a1D347c…`（来自 DeployW3 的输出）**、
`CASH_VAULT=0x367DbE05…`、`NOTE_VAULT=0x1EB0681A…`、`LP_VAULT=0x4927fca8…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | Settlement | `0x9d82fff4af08a7251cd1110c354801e60b83dd2f178e48dd5af74ad783cd51c5` |
| 2 | CALL | setSettlement | `0x75268fe238b021a52a94e15f5c9d4e17d30ee9f964e78ed1e72c2397187c57c8` |
| 3 | CALL | setSettlement | `0x8c28e6d53022fb6d33989ed3a1a6fba0482fbc0dd8ca629ab6ba034bd56fa689` |
| 4 | CALL | setSettlement | `0x666a5304c6ff41d54c6d56b70104fe68db45da8e86b7a74cb02fc17c24ef6194` |
| 5 | CALL | Settlement.setOperator | `0x2b931ccaa2bc6cf985164af51a23716f798c040ffdfd7d34e1985cfe6a6ac1fd` |
| 6 | CALL | Settlement.setThreshold | `0xce30a0345fc36ac8bc3db004aad95f860542b84fad478b84206ab57efce02feb` |
| 7 | CALL | Settlement.setOperator | `0xc5a381966c7fc4254bd19b906709250d83359013fbb2deebc90f05f15233a20e` |
| 8 | CALL | Settlement.setThreshold | `0x5106c4e9033e369b8f9c1597513d86a87753780d94b95ce006f3da94f7746bfa` |
| 9 | CALL | Settlement.setOperator | `0xa0507cdb57a3576c3947389897b43d4d508a512a31feed7ea542bc7651ddacff` |
| 10 | CALL | Settlement.setThreshold | `0x02dc4bcbe51d88b35ab4edcfcdb391e8cc8b1ffb77eb949719de7f9ba2442809` |
| 11 | CREATE | AdapterFactory | `0xabaa8e76a18786475443e9ba7a36bb92e80c66e474639538f84030ddb570dfbf` |
| 12 | CALL | AdapterFactory.deployAdapter | `0x783ea562b7deece11bdc96319857de4efdea3aed843380537275bc76126079a7` |
| 13 | CALL | AdapterFactory.deployAdapter | `0xaeac055bc62a75a0f635b345387a359fb830088513ab2e0bfbf1e5de8f0d69f7` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter | `0x15fe311743a298b9853365e26bb755ee0bf66691f7812fd4284b702bef320f0d` |
| 15 | CALL | setAdapter | `0xc36b3a8378c60fe80b6475f47ebdf65b2286b6749db46f7f7838866bddf26660` |
| 16 | CALL | addAdapter | `0xb2c10774371d8ec487c515692e4a9e53c3437bbe3b3f9a4d34de972505497dc2` |
| 17 | CALL | addAdapter | `0xfd0dcac78297f3694fca692e684de03bdc48f83bd4e8b05c45326e937bdbf9bc` |
| 18 | CALL | setUnifiedPool | `0xae479c7d8d199fdd4700de9778765135a0e19b0d8775d1cadb2c242d77fe2c5c` |
| 19 | CALL | setUnifiedPool | `0x840724574def101e9d305ce51badf7e548df22ab47c07bb11df6fea30f50e681` |
| 20 | CALL | setUnifiedPool | `0x4d950e3689813d2dffac417381bb3d6423562125f4d0e663e80c5ddb39e33f67` |
| 21 | CALL | FirstPeriodAdapter.setDataProvider | `0xbe3492751f382eff32a1fe9d2fe1839d16becba9af4eb76f1db2632d3f365357` |
| 22 | CALL | FirstPeriodAdapter.setDataProvider | `0x1cdf1eae2ca3831451d569a99feb2410801c91220aeb9dde9938ee2e2df1a407` |
| 23 | CALL | LiquidityAdapter.setDataProvider | `0x8e7e83deddde3d715a12b73dd0af890630f79c4ccf0fea1ac2b12765b88e21d2` |

### 阶段四：部署后手动配置（11 笔 `cast send`，全部 status `0x1`，合计 546,299 gas）

> 比 v8 的 8 笔多 3 笔：三个 Vault 的 `configureClaimRegistry`（V2 #11 新增）。

| 动作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,018 | `0x1e7a27977231bba50d794c34c01f8640face73eaaad9dc42ba8ffbb525a48df0` |
| `CashVault.setGuardian(deployer)` | 49,243 | `0xbfa523a4118346da49cdfd0cd13265d70bc01510af39da9513269e3d2c64cbb8` |
| `CashVault.setAllocator(deployer)` | 49,617 | `0x9636e6db7b81d06a247700e8b6dfc26d51e60ee2405209d0ca2036429e585640` |
| `NoteVault.setGuardian(deployer)` | 49,243 | `0x29c34181dd22d9077804e76ceab75a24e6231b29910524f40c708a62181dc0f3` |
| `NoteVault.setAllocator(deployer)` | 49,617 | `0xfe719fb0c2163ea6670f792579953e163775f486a71397e2bb5478e7d34a4d7e` |
| `LPVault.setGuardian(deployer)` | 49,257 | `0x42ed3181c7bce9d3abd568eb1c989843e6c8a61fcb4a908bf4ce232b4dcc5991` |
| `LPVault.setAllocator(deployer)` | 49,697 | `0x9d4edb449d53ff375d9d4dfdd0afbdebc36a0d1ad481efb7aefabe4792745da7` |
| `NAVOracle(W3).setSigner(SToken, deployer)` | 48,031 | `0x137cb26f74ec2002a60fccb5383b9bb28528b2c87b8f1de9273effe1183fec7c` |
| **`CashVault.configureClaimRegistry(CR, 30d)`** | 78,651 | `0x8f43c9b3c29bae5b93d1fcbb736804714aba73579c97c005dbbb159297791013` |
| **`NoteVault.configureClaimRegistry(CR, 30d)`** | 78,651 | `0x8676fd5156a73d53076a5a372c432dfa7d17128a5ee6495ba869747127e457be` |
| **`LPVault.configureClaimRegistry(CR, 30d)`** | 78,665 | `0x229bbef88fa6e5bfd0ff52b52eeb75ca88ef593084f3af7879dffeb813e7153d` |

> 与历代一样，部分交易第一次送出时被 RPC 负载平衡后端以 `nonce too low` 拒绝（未上链、未耗 gas），
> 自动重送后全部成功，上表是成功的那 11 笔。

### 阶段五：测试钱包补铸 MockUSDT — **本代不需要执行**

MockUSDT 沿用 v8 那一颗，15 个测试钱包的余额原样保留。实测：

```
$ npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run
  0/15 wallets need BNB, 0/15 need USDT
  nothing to do — all wallets already funded.
```

15 个角色钱包地址与 v7 / v8 相同（助记词未变），每个持有 100,000 USDT。

---

## 部署后验证

以下均为本次部署后以 `cast call` 实测的结果：

```
# 三个 Vault 是全量部署，不是克隆
CashVault / NoteVault runtime = 21,669 bytes    (forge build --sizes: EarnVault 21,669)
LPVault               runtime = 21,287 bytes    (forge build --sizes: LiquidityEarnVault 21,287)

# 核心接线
StateManager.vaultFactory()   = 0x150cA9240c549bd78522Db9ECCD96637Bb910005
Settlement.queue()            = 0xDe7021c2fa32062627f6DA5C7fa03013DA8a96ba
Cash/Note/LP .queue()         = 0xDe7021c2fa32062627f6DA5C7fa03013DA8a96ba
Cash/Note/LP .settlement()    = 0xAeE2D999479D886bcB09fA405F0d87844C4fb785
Cash/Note/LP .unifiedPool()   = 0x1a1D347cD6A94AF9389C1523d6C58084896a6FAd
LiquidityBridge.sm()          = 0xb3f644801c76A78543979D7E9e367D092B1f25aC
ClaimRegistry.stateManager()  = 0xb3f644801c76A78543979D7E9e367D092B1f25aC
UnifiedPool 代理 implementation = 0xD57583151A67cef305cd762b0Ab1851DC108040C
UnifiedPool.vaultConfigured / vaultActive (each) = true / true
AdapterFactory.isAdapter(each)  = true

# 角色与参数
Cash/Note/LP .curator() / .guardian() / .allocator() = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP .subscriptionCapShare()   = 0        （不限额，需 Curator 开募前设定）
Cash/Note/LP .claimRegistry()          = 0x69C7b88259C37d6C95ac48d40C50157eCaf9856a
Cash/Note/LP .claimGracePeriod()       = 2592000  （30 天，待客户确认）
Settlement.threshold(each)             = 1
Settlement.isOperator(each, deployer)  = true
Cash/Note/LP Adapter.dataProvider()    = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
ProtocolFeeConfig.paymentTokenOf(Stable) = 0xF7611799e16E5fFcAA00dBA882DB6e73F0731921
NAVOracle(W3).signerOf(SToken)         = 0x425beB70d264362E4eb7953C4f7aFBDe01145538

# MockUSDT 沿用验证
governor 测试钱包 USDT 余额 = 100,000.0   （v8 铸的，本代直接可用）
```

**NAV signer 与各角色仍是部署钱包，为暂时值。** 客户正式名单给出后以对应 owner 身份替换。

---

## 部署成本

| 阶段 | 交易数 | gas |
|---|---|---|
| `Deploy` | 17 | 25,030,180 |
| `DeployW3` | 24 | 40,586,676 |
| `DeployW4` | 23 | 19,795,806 |
| 手动配置 | 11 | 546,299 |
| **合计** | **75** | **85,958,961** |

按 0.1 gwei 计约 **0.0086 BNB**。部署钱包 `0x425beB70…` 部署后余额 0.4430 BNB。
