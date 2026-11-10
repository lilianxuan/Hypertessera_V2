# BNB Smart Chain Testnet 全新部署记录 v10（2026-08-29）

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署钱包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三个 Vault 的 Owner）
- **源代码 commit**：`ca71da9`（PR #33 `Audit Feedback V3 四项修复 + Adapter 通用资产退出及回款订单`，分支 `main`）
- **脚本**：`script/Deploy.s.sol`，依序运行 `Deploy` → `DeployW3` → `DeployW4`，全部带 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **区块范围**：`127,872,774` – `127,873,862`
- **交易笔数**：17 + 27 + 24 + 11 = **79 笔，全部 status `0x1`**
- **取代**：[`deployment-bsctestnet-2026-08-26-v9.md`](./deployment-bsctestnet-2026-08-26-v9.md)（commit `612ddf1`）。
  **v9 那一代的 chainId 97 地址全部作废，请改用本文档的地址** —— 唯一例外是 MockUSDT，见下。

---

> ## ✅ 继续沿用的合约：MockUSDT
>
> ```
> MockUSDT  0xF7611799e16E5fFcAA00dBA882DB6e73F0731921   （与 v8 / v9 完全相同）
> ```
>
> 自 v9 起 `script/Deploy.s.sol` 读取环境变量 `USDT`：已设置则沿用该地址，未设置（或为 0）则
> 照旧部署一颗新的。本代继续沿用同一颗，15 个测试钱包的 USDT 余额不因换代归零。
> 阶段一因此仍是 17 笔（不含 CREATE MockUSDT）。

> ## 🆕 本代最重要的变更：`UnifiedPool` 双 Governor 白名单
>
> Audit Feedback V3 #1/#2 把共享资金池的准入改为治理控制。`attributeInterest` /
> `attributePrincipal` / `receiveVaultPrincipal` / `distribute` 现在**同时**要求：
>
> 1. 调用方 Vault 在 `vaultWhitelisted` 内；
> 2. 该 Vault 当前的 `settlement()` 在 `settlementWhitelisted` 内。
>
> 两项缺一不可 —— 白名单内的 Vault 随时可以改自己的 `settlement()`，只查 Vault 会让它换上
> 攻击者控制的 Settlement 再自任 Operator。此外 `operatorTransfer` /
> `operatorTransferToRevenuePool` 改为 GOVERNOR_ROLE 专属。
>
> **这两个白名单没设好，协议一上线就是死的。** 部署脚本已经接线：`DeployW3` 为三个 Vault 调用
> `setVaultWhitelisted`（阶段二多出的 3 笔），`DeployW4` 为 Settlement 调用
> `setSettlementWhitelisted`（阶段三多出的 1 笔）。本次部署后已用 `cast call` 逐个复核，
> 四个标志全部返回 `true`，**未发生需要额外补设的情况**。

> ## ⚠️ 沿用 v9 的运营警示一：`claimGracePeriod = 30 天` 仍是暂定值
>
> ```
> claimRegistry    = 0xF7C2BE26C1Ab57d305B83B4A513A4aD906E5687a
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

## 这次相对 v9 改了什么

v9 的 commit 是 `612ddf1`，本次是 `ca71da9`。中间只有一个合并提交，即 PR #33：

```
ca71da9 Audit Feedback V3 四项修复 + Adapter 通用资产退出及回款订单 (#33)
```

| 改动 | 内容 | 对本次部署的可见影响 |
|---|---|---|
| V3 #1/#2 | `UnifiedPool` 双白名单；`operatorTransfer` 系列改 GOVERNOR_ROLE | **阶段二多 3 笔、阶段三多 1 笔**；`UnifiedPool` 实现体积 7,072 → 7,787 |
| V3 #3 | 部分成交赎回款清算后仍可领取；新增 `getRedeemRequest` | `BaseVault` 变大，两个 Deployer 余量进一步收紧 |
| V3 #4 | `addAdapter` 自身写入 `adapter` 字段，两个入口同时锁死 | 无地址影响 |
| Adapter 重构 | 通用 Sell Order 取代旧 Sell / Rebalance / RWA Withdraw 三套订单簿 | **Adapter ABI 大幅变化**，前端与链下必须同版本升级 |

### Adapter ABI 是不兼容变更

旧的 `createSellOrder(amount)` / `executeSell`、Rebalance 体系、RWA Withdraw Order 全部删除，
换成 `BaseAdapter` 上全 Adapter 共用的通用 Sell Order（`CREATED` → `FUNDED` → `EXECUTED`，
交易对手经 `fundSellOrder` 先付款、Allocator 才能交付）。Deal 生命周期统一为
Buy 创建 → 持续计价 → Sell 减少或关闭，v9 引入的双 keyspace 偏移
（rebalance 条目为 `2**128 + orderId`）随之取消，链下读取逻辑需要相应回退。

### 合约体积

Adapter 因通用 Sell Order 全部变大，Vault 与 Deployer 因 V3 #3 也变大：

```
FirstPeriodAdapter           12,318 bytes   （v9 为 10,962）
LiquidityAdapter             12,356 bytes   （v9 为 11,520）
RWAAdapter                   12,967 bytes   （v9 为 12,982，删除 Withdraw Order 抵消了增量）
EarnVault                    22,490 bytes   （余量 2,086，v9 为 21,669）
LiquidityEarnVault           21,555 bytes   （余量 3,021，v9 为 21,287）
EarnVaultDeployer            24,268 bytes   （余量 308，v9 为 1,129）
LiquidityEarnVaultDeployer   23,411 bytes   （余量 1,165，v9 为 1,433）
UnifiedPool                   7,787 bytes   （v9 为 7,072）
```

> ### ⚠️ `EarnVaultDeployer` 距离 EIP-170 上限只剩 308 字节
>
> v9 时余量还有 1,129 字节，本代掉到 **308**。`./script/check-sizes.sh` 已就此发出警告。
> **后续任何往 `BaseVault` 加代码的改动，都必须先跑 `forge build --sizes` 确认还放得下**，
> 否则 `EarnVaultDeployer` 会直接超限、`DeployW3` 无法部署。

### 部署前本地校验

```
forge build --sizes        →  88 个合约全部非空、0 violation
./script/check-sizes.sh    →  44 个具名合约全部在 EIP-170 限制内
                              （1 个距上限不足 1,024 字节：EarnVaultDeployer 24,268）
forge test                 →  1,012 项全部通过（28 个测试套件，0 失败）
offchain npm run typecheck →  通过，无报错
offchain npm test          →  114 项全部通过（5 个测试文件）
```

---

## 完整地址表

### 前端 `deployments.js` 可直接贴入的区块（24 个 key）

> key 集合与 v9 相同。`mockUsdt` 与 v9 相同，其余全部换代。

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: 'ca71da9',
    addresses: Object.freeze({
      hyperAccessControl: '0x490A9161252fDC45189926011B3b2DA623aD0d2b',
      stateManager: '0x3f19C3254477aF794646E559fDCbD4D6767AF29b',
      navOracle: '0x4f9e8810663A819272c35c093d9211176C63C1D8',
      mintBurnController: '0xD1e27589c846f5622795e668E7EAcc99Cb72818c',
      assetRegistry: '0x46E8200b7f038042fa03C87b38B64559Fdb4819f',
      protocolFeeConfig: '0x16028286d59173f6f67AEAe87D18342b261bD528',
      reservePSM: '0xe412c1C3eC29c020101d25F209A2E28C1e341f49',
      poRRegistry: '0xb8E2Fe6F84C2e06C1a5D10b7d032fFBDe52D33B7',
      claimRegistry: '0xF7C2BE26C1Ab57d305B83B4A513A4aD906E5687a',
      queue: '0x7eE33a601573087d55a02334D330e6f125Bc0802',
      revenuePool: '0xE8687A0b6FE1758e6d00fa0e1d5E74A1bab70685',
      unifiedPool: '0x7aCe5c27dD12d8e2917f5Ef78E520509333c2D64',
      settlement: '0x69b9885448c12EdabA8A6FFEC7FfcE49fdeaeA75',
      vaultFactory: '0xBf95887065d8B13d4E2a248EC5754904912f90eb',
      adapterFactory: '0x54E52B10D5563e74c52658777734A7C1D896F3f2',
      liquidityBridge: '0x66afCF15E4F72a6B89fEc144d32AAA15264f36b3',
      mockUsdt: '0xF7611799e16E5fFcAA00dBA882DB6e73F0731921',
      cashVault: '0x4Bd56A857167a83efc2772AEA6683F3A61F3EAF1',
      noteVault: '0x9888344280dfCE798528Fa28c0697ba8A517348B',
      lpVault: '0x980fD6615b78bF90eF6f67DB2CBaE4A49a33c686',
      cashAdapter: '0x80A10519341339308733CABCcCEdaFE237e03BE5',
      noteAdapter: '0x12ce3D880383705E4DA079f9D996eC77e5489d2E',
      lpAdapter: '0xD06E71a74A69a31dEBED6220c4d0DD227Baa9d58',
    }),
  }),
})
```

### 全部合约（含前端不用的）

链上实测 runtime 字节数，**全部非空、全部 ≤ 24,576**：

| 阶段 | 合约 | 地址 | runtime |
|---|---|---|---|
| （沿用 v8/v9） | **MockUSDT** | `0xF7611799e16E5fFcAA00dBA882DB6e73F0731921` | 1,708 |
| Deploy (W1/W2) | HyperAccessControl | `0x490A9161252fDC45189926011B3b2DA623aD0d2b` | 969 |
| Deploy | StubStateManager | `0xe1b8cE20D90A2e632E76e95CD5B63e8E4FE86865` | 2,429 |
| Deploy | RevenuePool | `0xE8687A0b6FE1758e6d00fa0e1d5E74A1bab70685` | 3,173 |
| Deploy | ProtocolFeeConfig | `0x16028286d59173f6f67AEAe87D18342b261bD528` | 1,236 |
| Deploy | AssetRegistry | `0x46E8200b7f038042fa03C87b38B64559Fdb4819f` | 11,421 |
| Deploy | MintBurnController（AssetRegistry 内部部署） | `0xD1e27589c846f5622795e668E7EAcc99Cb72818c` | 3,137 |
| Deploy | NAVOracle（W2 那颗，前端不用） | `0x6663E8ba77db3Cd535Da02a640d446078cF3c24a` | 3,526 |
| Deploy | PoRRegistry | `0xb8E2Fe6F84C2e06C1a5D10b7d032fFBDe52D33B7` | 2,485 |
| Deploy | SToken / RWAToken（demo 资产 1） | `0x4a95A4C251Af57BFC5fEaf24A760D204828c1276` | 4,832 |
| Deploy | JToken（demo 资产 2） | `0xBF37D921EB3C01B260bbee5834a0A89d8956f51e` | 4,832 |
| Deploy | Queue（W2 那颗，绑 StubStateManager，前端不用） | `0x27A078d457d4eb6AF1D1ac62fDc4A2526C61137F` | 2,740 |
| Deploy | ReservePSM | `0xe412c1C3eC29c020101d25F209A2E28C1e341f49` | 9,426 |
| Deploy | WrappedToken（ReservePSM 内部部署） | `0xeF0002d46184A36191C5Cb7f5829F0f9E4fC311c` | 1,961 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0xAD07F06c4B951B4A18665c1ca8864f364DF970EE` | 2,549 |
| Deploy | RWAAdapter（W2 demo） | `0x8F1DfFD8b766a41bB8dE011E37300C8559Deb79e` | 12,967 |
| DeployW3 | **StateManager** | `0x3f19C3254477aF794646E559fDCbD4D6767AF29b` | 10,945 |
| DeployW3 | **ClaimRegistry** | `0xF7C2BE26C1Ab57d305B83B4A513A4aD906E5687a` | 1,758 |
| DeployW3 | **NAVOracle** | `0x4f9e8810663A819272c35c093d9211176C63C1D8` | 3,526 |
| DeployW3 | **Queue** | `0x7eE33a601573087d55a02334D330e6f125Bc0802` | 2,740 |
| DeployW3 | **LiquidityBridge** | `0x66afCF15E4F72a6B89fEc144d32AAA15264f36b3` | 1,362 |
| DeployW3 | UnifiedPool 实现（前端不用，走代理） | `0x6B3EDA3A6f4E975519DEC3450d659d21C026F026` | 7,787 |
| DeployW3 | **UnifiedPool 代理（ERC1967）** | `0x7aCe5c27dD12d8e2917f5Ef78E520509333c2D64` | 130 |
| DeployW3 | EarnVaultDeployer | `0x233E658BDb7d522008dc2fEF8cA4407d1a30A690` | 24,268 |
| DeployW3 | LiquidityEarnVaultDeployer | `0x8a22ba763eE663BcC1982AAA9037A1133baC2EB6` | 23,411 |
| DeployW3 | **VaultFactory** | `0xBf95887065d8B13d4E2a248EC5754904912f90eb` | 12,154 |
| DeployW3 | **CashVault** | `0x4Bd56A857167a83efc2772AEA6683F3A61F3EAF1` | 22,490 |
| DeployW3 | **NoteVault** | `0x9888344280dfCE798528Fa28c0697ba8A517348B` | 22,490 |
| DeployW3 | **LPVault** | `0x980fD6615b78bF90eF6f67DB2CBaE4A49a33c686` | 21,555 |
| DeployW3 | CashVaultTimelock | `0x25e0D8573EDF97244BF84f79773fa0A48b620900` | 5,801 |
| DeployW3 | NoteVaultTimelock | `0xa6Edf63dc5557E8F056D4195FfE7eb33973aD8F1` | 5,801 |
| DeployW3 | LPVaultTimelock | `0x9af70C00E55FDbd94053003c63C6069b4f346dC9` | 5,801 |
| DeployW4 | **Settlement** | `0x69b9885448c12EdabA8A6FFEC7FfcE49fdeaeA75` | 7,176 |
| DeployW4 | **AdapterFactory** | `0x54E52B10D5563e74c52658777734A7C1D896F3f2` | 2,549 |
| DeployW4 | **CashAdapter**（FirstPeriodAdapter） | `0x80A10519341339308733CABCcCEdaFE237e03BE5` | 12,318 |
| DeployW4 | **NoteAdapter**（FirstPeriodAdapter） | `0x12ce3D880383705E4DA079f9D996eC77e5489d2E` | 12,318 |
| DeployW4 | **LPAdapter**（LiquidityAdapter） | `0xD06E71a74A69a31dEBED6220c4d0DD227Baa9d58` | 12,356 |

三个 Vault 是各自完整部署的独立合约（不是 EIP-1167 克隆）：链上 runtime
22,490 / 22,490 / 21,555 与本地 `forge build --sizes` 的 `EarnVault` 22,490、
`LiquidityEarnVault` 21,555 完全一致。

> 两个 AdapterFactory 的构造函数各自另外部署了三颗只读的 creation-code 存储合约
> （本代分别为 `0xBacc7a98…` / `0x612d0c8f…` / `0x64565bEf…` 与 `0x616757418f…` /
> `0xce4ff7a2…` / `0xe800cd8b…`）。它们不对外暴露接口，与历代一样不列入上表。

### 角色

| 角色 | 地址 | 说明 |
|---|---|---|
| Governor / Owner | `0x425beB70d264362E4eb7953C4f7aFBDe01145538` | 三个 Vault 的 owner，AssetRegistry 的 Issuer，`UnifiedPool` 两个白名单的唯一管理者 |
| Curator / Keeper（三个 Vault） | 同上 | `DeployW3` 设定 |
| Guardian / Allocator（三个 Vault） | 同上 | 阶段四手动设定 |
| Settlement Operator（三个 Vault，threshold = 1） | 同上 | `DeployW4` 设定 |
| Data Provider（三个 Adapter） | 同上 | `DeployW4` 设定 |
| Token Agent（asset 1 / 2） | 同上 | `Deploy` 设定 |
| NAV Signer（W3 NAVOracle，SToken） | 同上 | 阶段四手动设定 |

> 全部角色暂时都指向部署钱包。客户正式名单给出后，以对应 owner 身份逐个换掉。

---

## 各阶段交易记录

### 阶段一：`Deploy`（17 笔，全部 status `0x1`，合计 25,500,874 gas，区块 127,872,774 – 127,872,898）

```
USDT=0xF7611799e16E5fFcAA00dBA882DB6e73F0731921 \
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | HyperAccessControl | `0x8e04d1f5440bc2bb25ff3829b2f0909e1adc18131df0ad33676b01384bdfc575` |
| 2 | CREATE | StubStateManager | `0x1c5a0c469a4b0081396a8f827066e23f8c89b71899da56a1d48a5b74f0be3e38` |
| 3 | CREATE | RevenuePool | `0xa609b1af7a0e44842e4e13ca4d4806529cf36932c5c7d3a32af610a6e75df390` |
| 4 | CREATE | ProtocolFeeConfig | `0xec70e10ce01e17159384b3be30c33a68730866240fc08c3fe54caa6b89a72ad2` |
| 5 | CREATE | AssetRegistry | `0xe460d2165b925b49962cc462cee5cd8da92d525ced5a0f6ec87bc36d20297b9a` |
| 6 | CREATE | NAVOracle | `0x2c7e5738949473dd91030d398d7c2cc2e555fe652b1c24cccd19c5217cbc5826` |
| 7 | CREATE | PoRRegistry | `0x8d3bc87af3c147b42c949625b8bccaa46f8ee2a9d5e0bddd74df44ab0fdd2546` |
| 8 | CALL | AssetRegistry.registerAsset | `0xb6a562c04fea4ac99346d3f8dd70bfade248e710b3fc80598628062004748afb` |
| 9 | CALL | AssetRegistry.registerAsset | `0x835960123a86981cc572de5780d05f74eb24b89065f3f9876d80b08a5543b0ee` |
| 10 | CREATE | Queue | `0xeb618a74bb438368c13aa1133ed3c68a33f4d78bbbf147069c2b8ea7e7d6ba31` |
| 11 | CREATE | ReservePSM | `0x05b49edfb53d28eaf8ebe2c4becebfa5df97bd0ef27fc496cea06fc431e83049` |
| 12 | CALL | ReservePSM.deployWrappedToken | `0x12435733983431fbd540305e6ef417367765fc155093d72d0d4223c612fc5c08` |
| 13 | CREATE | AdapterFactory | `0x195e601706dcb26688101357e361fb0b41ff7531330f48ddf347ecfc4f7a1623` |
| 14 | CALL | AdapterFactory.deployRWAAdapter | `0x08f075c04812801ddc373f0be3a7c4636c025fec76981c3382a9a6dc5a598d64` |
| 15 | CALL | MintBurnController.setTokenAgent | `0xd44cf465bf51487119eb1a044cd6339ac555a847dedcdc47de1de4aa7c2c967e` |
| 16 | CALL | MintBurnController.setTokenAgent | `0xc26d658c74243c7ea7de4e025a52b459b1c2989a381b8daf3f71d74ba44efcee` |
| 17 | CALL | NAVOracle.setSigner | `0x9d9d0240b3f70ebbf17477ea02d17a0fe21b960edf8cdc76aa90d9d067100704` |

### 阶段二：`DeployW3`（27 笔，全部 status `0x1`，合计 41,538,146 gas，区块 127,873,080 – 127,873,274）

环境变量：`HYPER_ACCESS_CONTROL=0x490A9161…`、`REVENUE_POOL=0xE8687A0b…`、
`USDT=0xF7611799…`、`PROTOCOL_FEE_CONFIG=0x16028286…`

> 比 v9 的 24 笔多 3 笔：第 25 – 27 笔的 `UnifiedPool.setVaultWhitelisted`（V3 #1/#2 新增）。

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | StateManager | `0x4a4b1daa95fd67ebb2bde4d6fd1f90443e1b904a772c3e7a91776e74807faefc` |
| 2 | CREATE | ClaimRegistry | `0x6510e247b213ffa387926569cec113035deafa7f464f8fe12e1f050ca886e3f1` |
| 3 | CREATE | NAVOracle | `0xbd0ed59876b330990d270431fed2285dcf169d4c2f4e744742fa9d5afcf598e0` |
| 4 | CREATE | Queue | `0x33b8400326bdf706bd8b5ff2be7cfce660e03d7a1be6a1ec750c81ccbc235ee8` |
| 5 | CREATE | LiquidityBridge | `0x140144f2263f8ef4cf121943970ace72d67367330af993ba79362b628fd1a855` |
| 6 | CREATE | UnifiedPool 实现 | `0x00d7e255a8b89d86f2f02f64ec45d1f118c053ad7d9f1c96e09323ffaf7ccbfc` |
| 7 | CREATE | ERC1967Proxy | `0x3a0e9c16ca1370d3fe35fa688afa79f45a8a3155a879b2ca5f81acee3354a9e6` |
| 8 | CALL | RevenuePool.addAuthorizedSource | `0x9329acce3949331f78f4b7a18eda121d4ac6e515c797f1b05c8ac24171753621` |
| 9 | CREATE | EarnVaultDeployer | `0x68182ebdddc0e3614beed1ab26065813bd880d8bd2987b8b01087a700ccfffe0` |
| 10 | CREATE | LiquidityEarnVaultDeployer | `0xe264a02f58e384fa731d70b0c70ae6d2988894a3afe3cd74ca940a6594904860` |
| 11 | CREATE | VaultFactory | `0x1ad1c75a62675b54bdf86a25dc4b30754c823060e7826e8a590ee4277d77374f` |
| 12 | CALL | StateManager.setVaultFactory | `0x8b626fa97b7b6a17ca312975780399f0b3b942f3f7dc81a75618ed0f2b2aa6f2` |
| 13 | CALL | VaultFactory.deployVault（Cash） | `0x664ff61c619750f409115d26f2ca939dea454f97644e3810f18959089b11f226` |
| 14 | CALL | VaultFactory.deployVault（Note） | `0xb6697e38f2a944488fe5888b61c6fadaa5c97bd3d51785aca98f7322b06747d5` |
| 15 | CALL | VaultFactory.deployVault（LP） | `0x799013abf7164f963e2419f05a893ae7007795ce1bbf1e2c73da1de4a8975712` |
| 16 | CALL | EarnVault.setKeeper | `0x40163bb37444f31620d6d97088555d0f68bb52d3473135005c71d52a686e7c19` |
| 17 | CALL | EarnVault.setCurator | `0x2efe7dad64535ee4c29cabd1f053e7efb729783370baac553e9b0737779deb03` |
| 18 | CALL | EarnVault.setKeeper | `0xc0aef362d69e930219a06b3fd1398620ec42d21cbcdb9745cd1833d09c16163d` |
| 19 | CALL | EarnVault.setCurator | `0xa96dfa3ee943dec66243b811cf38cfbf55b171de5feb5712513997b0e69b0be2` |
| 20 | CALL | LiquidityEarnVault.setKeeper | `0x18e1d473d2831fdc519c4ede28fa8fb5ba6fba6ef3615724abfde1b207272507` |
| 21 | CALL | LiquidityEarnVault.setCurator | `0xecfad08b6e1c2c1c63aa7bd5a41cd2fc3613a4161616237872739c96eb3abe46` |
| 22 | CALL | UnifiedPool.configureVault（Cash） | `0x6de8000dfea8599ce7e4430519631f6c65804da8ca7d40d3401d40b28655fcb4` |
| 23 | CALL | UnifiedPool.configureVault（Note） | `0x96beb4ae503f56034d4ce40df874dc343aadd8eaeb0d84bf63c9d0dbde9f901f` |
| 24 | CALL | UnifiedPool.configureVault（LP） | `0x8b25e2438cc9b062adada611ecca32d5e564bcb9ece0351f90ee3dd198012f6d` |
| 25 | CALL | **UnifiedPool.setVaultWhitelisted(Cash, true)** | `0x1bfb6bc826edbdcc0b36dbd0a535dbe423c3fa46d1960dd6e60e63539a0ed887` |
| 26 | CALL | **UnifiedPool.setVaultWhitelisted(Note, true)** | `0xe5ca292907d766c433e14500fec2314d80217796f914c3eb654a4372c51144ef` |
| 27 | CALL | **UnifiedPool.setVaultWhitelisted(LP, true)** | `0x0458020f7d7eb56b1534e09718aebf2113f2cb555b4c48e885000ee2f7e89096` |

### 阶段三：`DeployW4`（24 笔，全部 status `0x1`，合计 21,046,622 gas，区块 127,873,441 – 127,873,618）

环境变量另加：`STATE_MANAGER=0x3f19C325…`、`QUEUE=0x7eE33a60…`、
**`UNIFIED_POOL=0x7aCe5c27…`（来自 DeployW3 的输出）**、
`CASH_VAULT=0x4Bd56A85…`、`NOTE_VAULT=0x98883442…`、`LP_VAULT=0x980fD661…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

> 比 v9 的 23 笔多 1 笔：第 11 笔的 `UnifiedPool.setSettlementWhitelisted`（V3 #1/#2 新增）。

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | Settlement | `0xcbe1798cb24601bfb01103b24a6b780f0d2700e2217c602a90e7c83e819dc7a0` |
| 2 | CALL | CashVault.setSettlement | `0x51ed0c4afbdf759d30ddd1e0dd580fdc862908d525fb5ca512a7e2e72800c6cf` |
| 3 | CALL | NoteVault.setSettlement | `0xe731750a9abd097919e108a421d4a1db5298ce7b8b6769e45d67b3f6a807e410` |
| 4 | CALL | LPVault.setSettlement | `0xe0940ece04aa9f5f7f7f96e5412bca65342c5eb7a14b0c85b509cfc566e03c4c` |
| 5 | CALL | Settlement.setOperator | `0x316ba5bc7c23cd983bba8a9ce7de35e682ef84df9748eab6a43ed77d3d90d0af` |
| 6 | CALL | Settlement.setThreshold | `0xe22b95439cd3a3d62492c45bed54a8eab28bc52733d97ee98e898eb097d3d0e5` |
| 7 | CALL | Settlement.setOperator | `0x92f06acef346d9a94a53cc592db801d63bbbacb3b98715ce280bca7f398cd653` |
| 8 | CALL | Settlement.setThreshold | `0xb650b17e893619020e62a91e76104f8b9fdbd5bfa2983e8f007c9c7da5f8486f` |
| 9 | CALL | Settlement.setOperator | `0x025f41f27ef7b75a050c7eddf6c962418e3caab44341e7a4fabb5601c0a6344b` |
| 10 | CALL | Settlement.setThreshold | `0x292e42fb37504b6b098ce29997588d5c0d587b7656458bdd4211f78472373875` |
| 11 | CALL | **UnifiedPool.setSettlementWhitelisted(Settlement, true)** | `0x2778b8a32a76f285fe20eca07a8c995550f2759f946cc0f5c078aa2af0604176` |
| 12 | CREATE | AdapterFactory | `0x5ddaddd81d63506dcf2e3167c3f881e79d801856fcab162a83da0f9fde4e88dc` |
| 13 | CALL | AdapterFactory.deployAdapter（Cash） | `0x2807c9130a87e44b070ef71d0c44fab2aded1b590b9a2d6dd4755e484e44213f` |
| 14 | CALL | AdapterFactory.deployAdapter（Note） | `0x30c6b72928cb223187902f27ce6a8461defeefc8df52e3e38ea5281c3f7d96fc` |
| 15 | CALL | AdapterFactory.deployLiquidityAdapter（LP） | `0x0e0c37e11f8e2086d9930c76da8d5895c438eedbdb674f8d87665f80f932a5aa` |
| 16 | CALL | LPVault.setAdapter | `0xf3712a017d04a3b5b9db3e66eec6dd01de8a2e7cdc845b6ca024f1fbcc1c5c52` |
| 17 | CALL | CashVault.addAdapter | `0x79e2e170bac2e172464e23473de9318377f8724ae6271f5dea54fddac1a0b59d` |
| 18 | CALL | NoteVault.addAdapter | `0x5cc03e62cbfabd51aa6322aa0f14726ccb1a2967758333dadf2c97f92fe0ad21` |
| 19 | CALL | CashVault.setUnifiedPool | `0x6c3a80595341a7729bfdc2c3780ad35a3e1cd47c1520b10b1215a1133c695660` |
| 20 | CALL | NoteVault.setUnifiedPool | `0xaa43ed31589b18d204a32c91c8d2d0de08587b2259c84a56212a99b4b948f3b0` |
| 21 | CALL | LPVault.setUnifiedPool | `0x5425c60f3d146e19419cbc8c9763afb1a60ecd4a2c733e24ba863f06c283bde6` |
| 22 | CALL | FirstPeriodAdapter.setDataProvider | `0x403b8047df1b90b4034522a6ab82e91b295d25b6e23e9fd99da16d49072a9156` |
| 23 | CALL | FirstPeriodAdapter.setDataProvider | `0x92f109c3ad39926875ed2506100961f0a34e31d727c2d16a6b559e724e7688d2` |
| 24 | CALL | LiquidityAdapter.setDataProvider | `0x3372bcbdae16643a03e3e5c387250b82f05c3755addec5b1d726ec3ea80723ed` |

### 阶段四：部署后手动配置（11 笔 `cast send`，全部 status `0x1`，合计 632,690 gas）

> 与 v9 的 11 笔一一对应。V3 的两个白名单已由部署脚本接线，**本阶段无需补设**。

| 动作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,018 | `0x703f60ac68e86a1919b121740e2624264620af1e367cd437c7d8be66ea7accf4` |
| `CashVault.setGuardian(deployer)` | 49,243 | `0xa173c838e6906bbd9cd5371bb7e994cf8c9ebab8e818d30bc7af74aea8951ec2` |
| `CashVault.setAllocator(deployer)` | 49,617 | `0x1b3b25188c75833999043ee62086b122dfc310e0fcb3770556e3f725de78b0e3` |
| `NoteVault.setGuardian(deployer)` | 49,243 | `0xf0b45c48085b5f8f69ecc3b9bf41e46b1ac338bcc9a5c6f9b9dec86ac93ad77d` |
| `NoteVault.setAllocator(deployer)` | 49,617 | `0x83581071a2d93c7889c9e96bd4e9f528b4242af98bdec9193b75d6f10b8aaa5d` |
| `LPVault.setGuardian(deployer)` | 49,257 | `0xd4b542b733a9bb3d4e1ddf352b64ba2e42414fb49e550b09181a0380bb14d496` |
| `LPVault.setAllocator(deployer)` | 49,697 | `0xa4fa390ce2892a3ddcabcb563f6e35fc068a1e1b581a7f36535d96d1e827286c` |
| `NAVOracle(W3).setSigner(SToken, deployer)` | 48,031 | `0xdef015e5615688719ef8adba175faf748870ce1749d405da1a8769a408d5b4d3` |
| `CashVault.configureClaimRegistry(CR, 30d)` | 78,651 | `0x64413d34105caa287500bc0bf2c97ab7cb0e5e02a98d262aeaf95a94c8da945f` |
| `NoteVault.configureClaimRegistry(CR, 30d)` | 78,651 | `0x264a9e42a65697c74d752e249bdf18977e96cdeaf48c7fc11dd1e65d3519800c` |
| `LPVault.configureClaimRegistry(CR, 30d)` | 78,665 | `0x48c28b71c59572c1e91eb5c3f33706ba306af042614926254043a5e9c9eb0778` |

> 与历代一样，部分交易第一次送出时被 RPC 负载平衡后端以 `nonce too low` 拒绝（未上链、未耗 gas），
> 重送后全部成功，上表是成功的那 11 笔。
>
> 另外，`configureClaimRegistry` 的正确签名是 `(address,uint256)`。首次操作时误用了
> `(address,uint64)`，选择器不匹配、三笔全部在 gas 估算阶段被 revert（未上链、未耗 gas），
> 改用正确签名后一次通过。这不是合约缺陷，仅记录以免后续换代重蹈覆辙。

### 阶段五：测试钱包补铸 MockUSDT — **本代未执行**

MockUSDT 沿用 v8/v9 那一颗，15 个测试钱包的余额随换代原样保留，本代部署本身不需要执行阶段五。
但 v9 之后的联调消耗使部分钱包余额低于基准线，部署前实测：

```
$ npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run
  2/15 wallets need BNB, 4/15 need USDT
  BNB  -> guardian, tokenAgent
  MINT -> governor, curator, guardian, tokenAgent
```

这是 v9 一代联调消耗造成的自然回落（其余 11 个钱包仍是整 100,000 USDT），
**与本次换代无关，也不影响 v10 合约的可用性**。是否补齐由运营决定，
需要时直接跑 `fundWallets.ts`（去掉 `--dry-run`）即可。

---

## 部署后验证

以下均为本次部署后以 `cast call` 实测的结果：

```
# UnifiedPool 双白名单（V3 #1/#2，本代重点）
UnifiedPool.vaultWhitelisted(CashVault)          = true
UnifiedPool.vaultWhitelisted(NoteVault)          = true
UnifiedPool.vaultWhitelisted(LPVault)            = true
UnifiedPool.settlementWhitelisted(Settlement)    = true

# 三个 Vault 是全量部署，不是克隆
CashVault / NoteVault runtime = 22,490 bytes    (forge build --sizes: EarnVault 22,490)
LPVault               runtime = 21,555 bytes    (forge build --sizes: LiquidityEarnVault 21,555)

# 名称与所有权
CashVault.name()  = "HyperTessera Cash Earn"
NoteVault.name()  = "HyperTessera Note Earn"
LPVault.name()    = "HyperTessera Liquidity Earn"
Cash/Note/LP .owner()         = 0x425beB70d264362E4eb7953C4f7aFBDe01145538

# 核心接线
StateManager.vaultFactory()   = 0xBf95887065d8B13d4E2a248EC5754904912f90eb
Settlement.queue()            = 0x7eE33a601573087d55a02334D330e6f125Bc0802
Cash/Note/LP .stateManager()  = 0x3f19C3254477aF794646E559fDCbD4D6767AF29b
Cash/Note/LP .queue()         = 0x7eE33a601573087d55a02334D330e6f125Bc0802
Cash/Note/LP .settlement()    = 0x69b9885448c12EdabA8A6FFEC7FfcE49fdeaeA75
Cash/Note/LP .unifiedPool()   = 0x7aCe5c27dD12d8e2917f5Ef78E520509333c2D64
Cash/Note/LP .claimRegistry() = 0xF7C2BE26C1Ab57d305B83B4A513A4aD906E5687a
ClaimRegistry.stateManager()  = 0x3f19C3254477aF794646E559fDCbD4D6767AF29b
UnifiedPool 代理 implementation = 0x6B3EDA3A6f4E975519DEC3450d659d21C026F026
UnifiedPool.vaultConfigured / vaultActive (each) = true / true

# Adapter
Cash/Note/LP Adapter.vault()   = 对应的 CashVault / NoteVault / LPVault
Cash/Note/LP Adapter.asset()   = 0xF7611799e16E5fFcAA00dBA882DB6e73F0731921
AdapterFactory.isAdapter(each) = true

# 角色与参数
Cash/Note/LP .curator() / .guardian() / .allocator() = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP .subscriptionCapShare()   = 0        （不限额，需 Curator 开募前设定）
Cash/Note/LP .claimGracePeriod()       = 2592000  （30 天，待客户确认）
Settlement.threshold(each)             = 1
Settlement.isOperator(each, deployer)  = true
Cash/Note/LP Adapter.dataProvider()    = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
ProtocolFeeConfig.paymentTokenOf(Stable) = 0xF7611799e16E5fFcAA00dBA882DB6e73F0731921
NAVOracle(W3).signerOf(SToken)         = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
```

所有部署地址均已实测代码非空，且全部 ≤ 24,576 字节（EIP-170）。

**NAV signer 与各角色仍是部署钱包，为暂时值。** 客户正式名单给出后以对应 owner 身份替换。

---

## 部署成本

| 阶段 | 交易数 | gas |
|---|---|---|
| `Deploy` | 17 | 25,500,874 |
| `DeployW3` | 27 | 41,538,146 |
| `DeployW4` | 24 | 21,046,622 |
| 手动配置 | 11 | 632,690 |
| **合计** | **79** | **88,718,332** |

按 0.1 gwei 计约 **0.0088718 BNB**。部署钱包 `0x425beB70…` 部署前余额 0.7430239 BNB，
部署后 0.7341520 BNB，差额与上表完全一致。
