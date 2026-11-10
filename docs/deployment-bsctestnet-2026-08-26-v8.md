# BNB Smart Chain Testnet 全新部署记录 v8（2026-08-26）

> ⚠️ **本文档已作废**：本代（v8）的 chainId 97 地址已被 [`deployment-bsctestnet-2026-08-26-v9.md`](./deployment-bsctestnet-2026-08-26-v9.md) 取代，请改用 v9 的地址。**例外**：MockUSDT `0xF7611799e16E5fFcAA00dBA882DB6e73F0731921` 被 v9 沿用，仍然有效。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署钱包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三个 Vault 的 Owner）
- **源代码 commit**：`c4d4b90`（PR #29 `客户十二份文档实现：审计一/二报告 + 最终周期与最终兑付 + 募集上限/净额度 + 资不抵债清算 + 移除 Tranche`，分支 `main`）
- **脚本**：`script/Deploy.s.sol`，依序运行 `Deploy` → `DeployW3` → `DeployW4`，全部带 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **区块范围**：`127,278,258` – `127,279,274`
- **交易笔数**：18 + 24 + 23 + 8 = **73 笔，全部 status `0x1`**
- **取代**：[`deployment-bsctestnet-2026-08-21-v7.md`](./deployment-bsctestnet-2026-08-21-v7.md)（commit `56cd4a8`）。
  **v7 那一代的 chainId 97 地址全部作废，请改用本文档的地址。**

---

> ## ⚠️ 本代最重要的变更：`ProductParams` 与 `VaultFactory.DeployParams` 是不兼容的 ABI 变更
>
> 前端、链下系统、索引器必须同版本升级，不能用 v7 的 ABI 调本代合约。
>
> **`ProductParams`**：删除 `firstCycleStart`，其位置由 `subscriptionCapShare` 顶替，
> 字段总数仍为 10，但**第 5 个字段的语义完全不同**：
>
> ```
> subscriptionStart, subscriptionEnd, walletSubscriptionCap, minRaiseAmount,
> subscriptionCapShare,          // ← 原 firstCycleStart 的位置
> cycleDuration, maturityTimestamp, claimingStart, claimingEnd, feeParams
> ```
>
> 用旧 ABI 编码调用 `setProductParams` 不会 revert，而是**把募集期开始时间写进募集上限**，
> 属于静默的错误配置。请务必确认前端已换成本代 ABI。
>
> **`VaultFactory.DeployParams`**：删除 `initialProduct` / `initialCycle` 两个字段
> （审计第 7 项：初始状态不再由调用方传入，固定为 `CONFIGURING` / `ACCEPTING`），
> 从 13 个字段减为 11 个。

> ## ⚠️ 本代编译走 `via_ir`，字节码与 2026-08-17 审计所看的构建不同
>
> `foundry.toml` 自 2026-08-25 起打开 `via_ir = true`：Cash/Note 金库的创建字节码
> 在旧的 legacy codegen 下已装不下新增的最终兑付路径。`via_ir` 为两个 Deployer 各省回约 10%。
>
> **每一个合约的字节码都因此与审计当时的构建不同**，重新审计时请以本代 commit `c4d4b90`
> ＋ `via_ir = true` 的产物为准。当前最紧的余量：
>
> ```
> EarnVaultDeployer            22,251 bytes   （余量 2,325）
> LiquidityEarnVaultDeployer   22,143 bytes   （余量 2,433）
> EarnVault                    20,461 bytes   （余量 4,115）
> LiquidityEarnVault           20,085 bytes   （余量 4,491）
> ```
>
> 相比 v7 的“`EarnVaultDeployer` 只剩 401 字节余量”，本代余量回到 2,325 字节。

> ## ⚠️ `UnifiedPool` 不再有 Tranche 分类
>
> `Tranche` 枚举与 `addTrancheVault(Tranche,address)` 已从代码库删除，本代用
> `addVault(address)` 注册金库；存储槽占位也一并删除（全新部署，无需兼容旧布局）。
> 前端 / SDK 若还在调 `addTrancheVault`，本代合约上不存在该函数。
> 查询金库注册状态改用 `vaultConfigured(address)` / `vaultActive(address)`。

> ## ⚠️ 沿用历代的操作陷阱：`subscriptionCapShare` 仍是 `0`
>
> ```
> CashVault.subscriptionCapShare() = 0
> NoteVault.subscriptionCapShare() = 0
> LPVault.subscriptionCapShare()   = 0
> ```
>
> `0` 代表**不限额**。`script/Deploy.s.sol` 从头到尾不碰任何产品参数，
> **Curator 必须在开放认购之前把募集上限写进 `ProductParams.subscriptionCapShare`**
> （本代该参数并入 `setProductParams`，不再有独立 setter），否则认购金额不受限制。
> 本次部署已确认三个 Vault 的该值均为 `0`，为客户确认过的预期状态。

---

## 这次相对 v7 改了什么

v7 的 commit 是 `56cd4a8`，本次是 `c4d4b90`。中间是 PR #29 的 6 个提交：

```
112f408 feat: 审计反馈十项修复 + 一年期最终周期结算 + 募集上限并入 ProductParams
833b0f7 docs(contracts): 修正两处仍引用已删除 enterFinalSettlement 的注释
f141027 feat: 净募集额度（subscriptionCapUsedShares）+ totalSubscribed 记账边界统一
3f293a6 feat: 最终周期在 SETTLING 执行 + 份额直接兑付 + 审计V2部分修复 + pending 会计口径回退
ff8c786 chore(offchain,panel): 同步最终周期重构后的 SDK / KeeperBot / ABI / 控制面板
eeae534 feat: writeDownInsolvency 最小化改造 + UnifiedPool 移除 Tranche 分类
d4c587a refactor(UnifiedPool): 全新部署，直接删除 tranche 存储槽占位与 Tranche 枚举
```

逐项说明见 [`contract-feedback-20260824-response.md`](./contract-feedback-20260824-response.md)。
对本次部署可见的影响：

| # | 改动 | 对本次部署的可见影响 |
|---|---|---|
| 一 | 审计反馈十项修复 | `UnifiedPool` 各入口加 `sm.registeredVaults` 校验；`DeployParams` 少两个字段 |
| 二 | 一年期产品最终周期结算 | `ProductParams` 删 `firstCycleStart`；`enterFinalSettlement` 已删除 |
| 三 | 募集上限并入 `ProductParams` | 新增 `subscriptionCapShare` 字段，占用原 `firstCycleStart` 的位置 |
| 六 | `totalSubscribed` 记账边界统一 | 行为改动，地址表无变化 |
| 七 | 净募集额度 `subscriptionCapUsedShares` | 新增只读接口 |
| 八 | `writeDownInsolvency` 最小化改造 | 行为改动，地址表无变化 |
| 九 | `UnifiedPool` 移除 Tranche | `addTrancheVault` → `addVault`；`Tranche` 枚举删除 |

另：`LiquidityBridge` 的构造函数增加了 `stateManager` 参数（`new LiquidityBridge(usdt, sm)`）。

### 部署前本地校验

```
forge build --sizes   →  88 个合约全部非空、0 violation，最紧余量 2,325 bytes
forge test            →  987 项全部通过（28 个测试套件，0 失败）
```

---

## 完整地址表

### 前端 `deployments.js` 可直接贴入的区块（23 个 key）

> key 集合与 v7 相同，只是地址全部换代。

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: 'c4d4b90',
    addresses: Object.freeze({
      hyperAccessControl: '0x5D15F408cC5C3b44b088Ab394E8AD4DF4ba0f524',
      stateManager: '0x77299004BcF175b91135Df9747CbC840370a2f0A',
      navOracle: '0x55029ffed4B4A05FE0D3467abEdD3ebC2aBD5b48',
      mintBurnController: '0x350374Da36f5067F3660E75B5E2D2B1fCe985525',
      assetRegistry: '0xCe1Af9763d47baC8a6ACDD6bb927FF18f5f91bCC',
      protocolFeeConfig: '0xfDB6D451e9ED0303FEA2705e3cEB326710342da5',
      reservePSM: '0x96F7Ced32eda36a9B25eaFB69cA0bB1383AcDCeA',
      poRRegistry: '0x0519Ed49b35957119E41aa46F74dE7Cc51Fa2319',
      queue: '0xde44E2F961527abb02f8379BfBD17EA5E6F98Db6',
      revenuePool: '0x869B5Dcdf16319E92086Eb38C108cDbbE7374A8f',
      unifiedPool: '0x845ABfb1A1AaA7bd3Fa6724CDb5d3113ca6c560F',
      settlement: '0xBcbE30962DC456cF56449893228B3C1827711c63',
      vaultFactory: '0x5B03448A53C9a826bFF45364B554011E49F006e7',
      adapterFactory: '0x95f28432aC8c55348c0f05b2Ae610c94c04E1885',
      liquidityBridge: '0x25C00ACfa8c1aA5CAE3Cb59c6b62359fD226f2E5',
      claimRegistry: '0xcF3D0Cb2c8968217aA407Ff53Bb5c9bB80347580',
      mockUsdt: '0xF7611799e16E5fFcAA00dBA882DB6e73F0731921',
      cashVault: '0x29fFe5b91A833eeB6F5eAa03BE29Ef7B0226aC19',
      noteVault: '0x28dE5eB46F308A35f701a4B293C6fdD7c9d3f050',
      lpVault: '0x21751A48bdE178681b145a5f149fA9f88bDCd12f',
      cashAdapter: '0x97B132A2B6B2ce4cc337Fe12AB3b0478508bF2b1',
      noteAdapter: '0x9D2044C51B20800717f7fF7Dfa5bb8681cf1a337',
      lpAdapter: '0x9E30C4d84eF1F7Ab92c56d2f2c9759bAB20f4159',
    }),
  }),
})
```

### 全部合约（含前端不用的）

链上实测 runtime 字节数，**全部非空、全部 ≤ 24,576**：

| 阶段 | 合约 | 地址 | runtime |
|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0x5D15F408cC5C3b44b088Ab394E8AD4DF4ba0f524` | 969 |
| Deploy | StubStateManager | `0x8E478f77485CD817A82A5Ca41F7Bd2F424984458` | 2,429 |
| Deploy | MockUSDT | `0xF7611799e16E5fFcAA00dBA882DB6e73F0731921` | 1,708 |
| Deploy | RevenuePool | `0x869B5Dcdf16319E92086Eb38C108cDbbE7374A8f` | 3,173 |
| Deploy | ProtocolFeeConfig | `0xfDB6D451e9ED0303FEA2705e3cEB326710342da5` | 1,236 |
| Deploy | AssetRegistry | `0xCe1Af9763d47baC8a6ACDD6bb927FF18f5f91bCC` | 11,421 |
| Deploy | MintBurnController（AssetRegistry 内部部署） | `0x350374Da36f5067F3660E75B5E2D2B1fCe985525` | 3,137 |
| Deploy | NAVOracle（W2 那颗，前端不用） | `0x9BeD12f166416Bdd9760228C349FEA46F123fF10` | 3,526 |
| Deploy | PoRRegistry | `0x0519Ed49b35957119E41aa46F74dE7Cc51Fa2319` | 2,485 |
| Deploy | SToken / RWAToken（demo 资产 1） | `0x037C574D6D5f2Aa821E73b4884B820C7c07E88e2` | 4,832 |
| Deploy | JToken（demo 资产 2） | `0xAE0c6AC5093c920657aCDE4DF83671F81830CE7A` | 4,832 |
| Deploy | Queue（W2 那颗，绑 StubStateManager，前端不用） | `0xBfc7D68ee917783e2075e606C9F9EaB2E4E2AED5` | 2,740 |
| Deploy | ReservePSM | `0x96F7Ced32eda36a9B25eaFB69cA0bB1383AcDCeA` | 9,426 |
| Deploy | Wrapped S Token（PSM 内部部署，asset id 1） | `0xD97DbeC8daF7F32DD7c0ef57C78a8Ccc224FeF0A` | 1,961 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0x553752B9845eb9e0867F648339C8AdFbe5282d29` | 2,549 |
| Deploy | RWAAdapter（W2 demo） | `0x8a4bc95565A4491fAC0f10E6f4B60c4c0beC6bD2` | 11,247 |
| DeployW3 | **StateManager** | `0x77299004BcF175b91135Df9747CbC840370a2f0A` | 10,945 |
| DeployW3 | **ClaimRegistry** | `0xcF3D0Cb2c8968217aA407Ff53Bb5c9bB80347580` | 1,758 |
| DeployW3 | **NAVOracle** | `0x55029ffed4B4A05FE0D3467abEdD3ebC2aBD5b48` | 3,526 |
| DeployW3 | **Queue** | `0xde44E2F961527abb02f8379BfBD17EA5E6F98Db6` | 2,740 |
| DeployW3 | **LiquidityBridge** | `0x25C00ACfa8c1aA5CAE3Cb59c6b62359fD226f2E5` | 1,362 |
| DeployW3 | UnifiedPool 实现（前端不用，走代理） | `0x82261C807D8E59936Ec0cFee9710B119093f3B8A` | 7,072 |
| DeployW3 | **UnifiedPool 代理（ERC1967）** | `0x845ABfb1A1AaA7bd3Fa6724CDb5d3113ca6c560F` | 130 |
| DeployW3 | EarnVaultDeployer | `0x638979C6FD8aD6fE19d050c72751568Bba987418` | 22,251 |
| DeployW3 | LiquidityEarnVaultDeployer | `0xa09Ac7301a591A021CB8eE39fdf5E1Ac076Cb175` | 22,143 |
| DeployW3 | **VaultFactory** | `0x5B03448A53C9a826bFF45364B554011E49F006e7` | 11,903 |
| DeployW3 | **CashVault** | `0x29fFe5b91A833eeB6F5eAa03BE29Ef7B0226aC19` | 20,461 |
| DeployW3 | **NoteVault** | `0x28dE5eB46F308A35f701a4B293C6fdD7c9d3f050` | 20,461 |
| DeployW3 | **LPVault** | `0x21751A48bdE178681b145a5f149fA9f88bDCd12f` | 20,085 |
| DeployW3 | CashVaultTimelock | `0x3C62a81bB4C48A23a20C022A8c6F5330e697D046` | 5,801 |
| DeployW3 | NoteVaultTimelock | `0x9c5d9C21ce1a9555d02933E51C193fC3945Bf207` | 5,801 |
| DeployW3 | LPVaultTimelock | `0x44701CD08c840b56F3fa99595f8E69EF0ca13e25` | 5,801 |
| DeployW4 | **Settlement** | `0xBcbE30962DC456cF56449893228B3C1827711c63` | 7,176 |
| DeployW4 | **AdapterFactory** | `0x95f28432aC8c55348c0f05b2Ae610c94c04E1885` | 2,549 |
| DeployW4 | **CashAdapter**（FirstPeriodAdapter） | `0x97B132A2B6B2ce4cc337Fe12AB3b0478508bF2b1` | 10,355 |
| DeployW4 | **NoteAdapter**（FirstPeriodAdapter） | `0x9D2044C51B20800717f7fF7Dfa5bb8681cf1a337` | 10,355 |
| DeployW4 | **LPAdapter**（LiquidityAdapter） | `0x9E30C4d84eF1F7Ab92c56d2f2c9759bAB20f4159` | 10,913 |

三个 Vault 是各自完整部署的独立合约（不是 EIP-1167 克隆）：链上 runtime
20,461 / 20,461 / 20,085 与本地 `forge build --sizes` 的 `EarnVault` 20,461、
`LiquidityEarnVault` 20,085 完全一致。

### 角色

| 角色 | 地址 | 说明 |
|---|---|---|
| Governor / Owner | `0x425beB70d264362E4eb7953C4f7aFBDe01145538` | 三个 Vault 的 owner，AssetRegistry 的 Issuer |
| Curator（三个 Vault） | 同上 | `DeployW3` 设定 |
| Keeper（三个 Vault） | 同上 | `DeployW3` 设定 |
| Guardian（三个 Vault） | 同上 | 阶段四手动设定 |
| Allocator（三个 Vault） | 同上 | 阶段四手动设定 |
| Settlement Operator（三个 Vault，threshold = 1） | 同上 | `DeployW4` 设定 |
| Data Provider（三个 Adapter） | 同上 | `DeployW4` 设定 |
| Token Agent（asset 1 / 2） | 同上 | `Deploy` 设定 |
| NAV Signer（W3 NAVOracle，SToken） | 同上 | 阶段四手动设定 |

> 全部角色暂时都指向部署钱包。客户正式名单给出后，以对应 owner 身份逐个换掉。

---

## 各阶段交易记录

### 阶段一：`Deploy`（18 笔，全部 status `0x1`，合计 24,536,278 gas，区块 127,278,258 – 127,278,392）

```
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | HyperAccessControl | `0xd30fb064cf5bf437a69699dc99b940f96c651914109323bac519b50ea0c6680b` |
| 2 | CREATE | StubStateManager | `0x1d31ec85cdff6a44557b6c44961bb1379ed48eb3419f5afb52486cb477029d03` |
| 3 | CREATE | MockUSDT | `0x975eb6f8f67bdc0d696b8cec76a2c34d872bb5c9db966d2b154d5a34618d4649` |
| 4 | CREATE | RevenuePool | `0x70f9c5d52871e9b2236f9d877f96a9f09606ace15d4caddd7ab87c758326c1af` |
| 5 | CREATE | ProtocolFeeConfig | `0x29b1a59fbba76b96f4010acf08f9a21715bed85c0a17f4107fbeff1f45348b80` |
| 6 | CREATE | AssetRegistry | `0x56ecd469e9fc605e0ae8ad02d56ff7b1cc7984a1e8eecc5ef7d993be913da846` |
| 7 | CREATE | NAVOracle (W2) | `0x7f8930e12c64be396b04ef6521ff1cf085ed6fecca26bbe4bfe37e186ee7f94c` |
| 8 | CREATE | PoRRegistry | `0x0eb1dbda269fdc829e0d274ab821b10bb82bc000d697f1bab9b93549381a7801` |
| 9 | CALL | AssetRegistry.registerAsset (S) | `0x2c59b4fdf9171316faad4c49a9382c1bac5ee9fa14560254cdeebbff3fcb7e02` |
| 10 | CALL | AssetRegistry.registerAsset (J) | `0x785a7833f6005081e92824c1d3b7b7c61ad81d2ddd7c7fbae07a8c2affeaa417` |
| 11 | CREATE | Queue (W2) | `0xcf8aeb5313ad0d1b18f7ce51ab3d12b65534e9af9a011afb4a8020dde6f4261d` |
| 12 | CREATE | ReservePSM | `0xa2eb78a99e7c1df9b1eed2652e2b14ca5cdcb1739b06027c1fd1b602cd6fe1f2` |
| 13 | CALL | ReservePSM.deployWrappedToken | `0x8ac65d1f50486d76b03b31c9f2dffd42fb1965ffeff3a933b66553b39c6e5d83` |
| 14 | CREATE | AdapterFactory (W2) | `0xfe33258f1d3ca5372c2b3a519cbaad3dfcb364d7a003f6057f27119cb3ec8187` |
| 15 | CALL | AdapterFactory.deployRWAAdapter | `0xef77a293a2d7c018b93e47c75e684dff3838a72c37087e4bcdbf1e7f1f2d2b8c` |
| 16 | CALL | MintBurnController.setTokenAgent (1) | `0xb428b082b50da7d016653691555853ef1689dee06d9069ebbd76dee78574588f` |
| 17 | CALL | MintBurnController.setTokenAgent (2) | `0xad93657ec175935b700d489811bdf1dfa29b7a97a20c52fa4a9909775871be78` |
| 18 | CALL | NAVOracle(W2).setSigner | `0x499f71fe6f7e22da930f80261389ea1de7eece97d0c9ea73f5c051286c6508c7` |

### 阶段二：`DeployW3`（24 笔，全部 status `0x1`，合计 39,127,570 gas，区块 127,278,565 – 127,278,747）

```
HYPER_ACCESS_CONTROL=0x5D15F408… REVENUE_POOL=0x869B5Dcd… \
USDT=0xF7611799… PROTOCOL_FEE_CONFIG=0xfDB6D451… \
forge script script/Deploy.s.sol --tc DeployW3 \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | StateManager | `0xed7932b9767b3239b7811d127ec31d418ffbba6162b44597dc884f5ffe6240f0` |
| 2 | CREATE | ClaimRegistry | `0xe62972d53efac24a2b6f7e0082c01de1d3a6bc826e9c577fefb5fe970ffb9c41` |
| 3 | CREATE | NAVOracle (W3) | `0xb8291898c916c10c61de24f547b231205f451e94266a9a94390c76501a30666e` |
| 4 | CREATE | Queue (W3) | `0x806d267c9d965cdac8f228d926edb69f0a522395d1405f179e2d40412f278d01` |
| 5 | CREATE | LiquidityBridge | `0xd46a8928fb6075a7e99b4ab14650d595fd8a6c3d9a1a71de1eb952c05c8a747c` |
| 6 | CREATE | UnifiedPool（实现） | `0xace9aa4b9b42bb71a7b4d1f2e9a3168d8bb5810ee3ed08959e1bcdda38abfb38` |
| 7 | CREATE | ERC1967Proxy（UnifiedPool 代理） | `0xdfee846ec9f4d3ac5614471411fa09a321978ac12a60b0bc6e8434c8c99ee774` |
| 8 | CALL | RevenuePool.addAuthorizedSource(pool) | `0x8126a36eb04d7d064d9acb6e1bd5662d273cbff9721b6c82a2dca6b291f5f123` |
| 9 | CREATE | EarnVaultDeployer | `0x3426cf0e6ff73a905815e1ae2dd25da2a5e9b26f47765a941c4dcf1175d03e06` |
| 10 | CREATE | LiquidityEarnVaultDeployer | `0xf9f683fe1013aa1413bb6567fc3a60fad63deaa0b9a4d584906c50c762ac6269` |
| 11 | CREATE | VaultFactory | `0x51fc333e4dae036afdf0b71e497b240dfd1b7d7189dedc4f0895cefa2f7ae46f` |
| 12 | CALL | StateManager.setVaultFactory | `0xbf3f3ff068ffe8f788cd3c5df68ad5ebc1ce2b74d13918c3b519b478dcba0ab6` |
| 13 | CALL | VaultFactory.deployVault (Cash) | `0x739ac909acb754431ca55a15bd7aa68126719c20d236368118895d8ed4fd2e7d` |
| 14 | CALL | VaultFactory.deployVault (Note) | `0xd425c5f903cf868824985dc46b0811c03f39e6a2db6c238f5c636f2489e7ac53` |
| 15 | CALL | VaultFactory.deployVault (LP) | `0xc3ca4137839a207534933025e98b7df4eca311b5c26e8653d1c57e8c17b6c61a` |
| 16 | CALL | CashVault.setKeeper | `0x1f62dae2af9364c27ada689ddae433a1bb8280a4ab87ab5125c23a8d58e34e29` |
| 17 | CALL | CashVault.setCurator | `0x302a91925127f95ff443b0fee28123b41d0c6ed0813d428a62085e558607bbb7` |
| 18 | CALL | NoteVault.setKeeper | `0x1c172b5fc1dd851324cdc27e9637db61a65e12f0d4a2c73e83892d0855f37166` |
| 19 | CALL | NoteVault.setCurator | `0x100fa555805c57f6ff886cb76a0102dd5a61ef2fc9c5c7ccb0f2b3c495d27738` |
| 20 | CALL | LPVault.setKeeper | `0xca301735afd040a5e8cb8f910a4dccc9aedad76c719f5dfbba8f5eab8e02bcc2` |
| 21 | CALL | LPVault.setCurator | `0xa2aa31cb8a9a6c824ba35ebde0cbc371331dcea97839aca5a365e3d3b27c2eea` |
| 22 | CALL | UnifiedPool.addVault (Cash) | `0xee2ba7fd54b4421e23db1c116330a6a790151d47b7f9a5ede9e193665ebce5e1` |
| 23 | CALL | UnifiedPool.addVault (Note) | `0x439ce73ad6cd7171638b9366bd3a1606134e58ac742545d8c5c6bdc0c0834b31` |
| 24 | CALL | UnifiedPool.addVault (LP) | `0xb7b740d6e65dae898134000ddd93ac51358b6b98e75352e2c318ca011c0917fb` |

### 阶段三：`DeployW4`（23 笔，全部 status `0x1`，合计 18,790,033 gas，区块 127,278,889 – 127,279,059）

环境变量另加：`STATE_MANAGER=0x77299004…`、`QUEUE=0xde44E2F9…`、
**`UNIFIED_POOL=0x845ABfb1…`（来自 DeployW3 的输出）**、
`CASH_VAULT=0x29fFe5b9…`、`NOTE_VAULT=0x28dE5eB4…`、`LP_VAULT=0x21751A48…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | Settlement | `0x800e90ba049ac28f0d0b4dd51493c94f396a589b9a64c12b652502cc036e7e67` |
| 2 | CALL | CashVault.setSettlement | `0xe22e4ecea8c611e76409d398ccc60ac603042c5868073ad9cd753e5c37133b91` |
| 3 | CALL | NoteVault.setSettlement | `0x25f4096e658343599ce485f1be28146efdb59ea2fd4b5e19a5e4ec561b21efb4` |
| 4 | CALL | LPVault.setSettlement | `0x39762a1ba971117fb32cde71fcdd62fb37135dc55729657489ff303678842abd` |
| 5 | CALL | Settlement.setOperator (Cash) | `0x7feb7054508893cb0e12041f5c4113dbfcff92f5f944328885cb21a4e4678688` |
| 6 | CALL | Settlement.setThreshold (Cash) | `0xfcb21e600bb281b36d99142867f9d3174f1d573a849124e33c3c73feeaecf88e` |
| 7 | CALL | Settlement.setOperator (Note) | `0xdcb71c9e8b77018d4e0f2670748adbc85e18c4f5442b51706dc8c0343db7207e` |
| 8 | CALL | Settlement.setThreshold (Note) | `0xace5175c57b4c4f7971e1a939702212b9ed5add3ab6f91187cd2915b16a449c0` |
| 9 | CALL | Settlement.setOperator (LP) | `0x8bfc9ab9a2fdd0eeb25f9dc3b3900fd28ba1f544b62b82888d552655ea11704a` |
| 10 | CALL | Settlement.setThreshold (LP) | `0xf7c60361943c458c0839d730c5f4ee265398cef13ff9528e37822e944f2ecfb1` |
| 11 | CREATE | AdapterFactory | `0xdced551484dc0894b5c913c077e4fa1c1cb207d8e302b9c608acb75e0ef02814` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | `0xb0839699faf1fd277868e319de1b5ed291bf3c78865d1c5a0090bafbf9d289f4` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | `0xfdd23d442337b4735eb3cddea2f61eac90314bb88e335c30d29116936b336cb3` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | `0xde5689033163b2c2c7d3bf66332b5b4195b91cb91463f3b9872f7112cca93e85` |
| 15 | CALL | LPVault.setAdapter | `0x834a38a9db388e64afb9be1a7a85ce911bf4589b61bfc41081621bd4541ddd2c` |
| 16 | CALL | CashVault.addAdapter | `0xd4eb4aea4778b9d5ec4fae39171d644e401d065b6e975d2d50ce3066b50e8ff9` |
| 17 | CALL | NoteVault.addAdapter | `0x666c20f389be91d464518f23688e79453e148c28b0de09fa164d4db2e250ed3d` |
| 18 | CALL | CashVault.setUnifiedPool | `0xdacea17cdbcca80874d9cc7a10798fcf51e036518ed47739462af99bbe91ce77` |
| 19 | CALL | NoteVault.setUnifiedPool | `0x8949af7ae001150912e7255cbabc00ad4f3e3647db73f733237d37a937422c00` |
| 20 | CALL | LPVault.setUnifiedPool | `0x6b396442cf379b228cae3ee43451214dc58abd340c87b2df9eb0cf3c6aa945d7` |
| 21 | CALL | CashAdapter.setDataProvider | `0xd9c37241bf42010740280b385b43f8163b5904498e4b31a7144040015780d70c` |
| 22 | CALL | NoteAdapter.setDataProvider | `0x1f365f4c3300ce1d03d463a2c5b88d86bacf5b9fec6385a175f235b40ec6c7b0` |
| 23 | CALL | LPAdapter.setDataProvider | `0x696686efb7d1cedc6b4fb9f2d93325eeef451a52e397d74275fc8b5e3f4ed288` |

### 阶段四：部署后手动配置（8 笔 `cast send`，全部 status `0x1`，合计 396,393 gas，区块 127,279,176 – 127,279,274）

| 动作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,018 | `0x739f39ef34d0c54ac4c7ed1a20f41452f8415044451c03a7dc38bf237722df20` |
| `CashVault.setAllocator(deployer)` | 49,529 | `0xc55fc7ac921b664f1bb08b4e5772c9d8f814efc0291b6a894ddf6fa87cff1338` |
| `NoteVault.setAllocator(deployer)` | 49,529 | `0x332ac6e5c21a513a923a74bcd9abee03e65fc7479d84b7b806df229add15f561` |
| `LPVault.setAllocator(deployer)` | 49,609 | `0xb80fb017fe54c210f0eaf90e49ce4fdcf12557d8d5ab861845730534ed3b9c33` |
| `CashVault.setGuardian(deployer)` | 49,221 | `0xe095ecc48367625c1b778a46659690b84f1583eb6e310382ef74fa4a56f11caa` |
| `NoteVault.setGuardian(deployer)` | 49,221 | `0xc00099cd5afc2ff35226b8777334981b96c99dac1fab2e2aeb5c45c96cc82d40` |
| `LPVault.setGuardian(deployer)` | 49,235 | `0xedc7fcc87c9bac435fb6fab5b4a15799f63a4816ddc135a4a2555e47fe637ef1` |
| **`NAVOracle(W3).setSigner(SToken, deployer)`** | 48,031 | `0xbad4cf57b68ab453189c8eadf272ec1f8a254ba5adf0e8085a726baaccaae07b` |

> **注**：与 v3 – v7 一样，部分交易第一次送出时被 RPC 负载平衡后端以 `nonce too low`
> 拒绝（交易未上链、未耗 gas）。逐笔自动重送后全部成功，上表是成功的那 8 笔。
> Settlement threshold / operator 与三个 Adapter 的 Data Provider 已由 `DeployW4` 设好，阶段四不需再送。

### 阶段五：测试钱包补铸 MockUSDT（15 笔 MINT，全部成功，最后一笔在区块 127,285,736）

新的 MockUSDT 是 `0xF7611799e16E5fFcAA00dBA882DB6e73F0731921`，v7 的 MockUSDT
`0x38eE768D…` 上的余额在新环境等于不存在，15 个测试钱包的 USDT 因此全部归零。
`offchain/scripts/testnet/addresses.bscTestnet.json` 已随本次部署更新到 v8 地址。

```
cd offchain
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run   # 先看计划
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts             # 实际送出
```

15 个角色钱包的 BNB 余额从 v7 一代沿用下来，全部达标，本次只补 USDT：
**每个钱包补铸 100,000 USDT，15/15 成功**。补铸后余额：

| idx | role | address | BNB | USDT |
|---|---|---|---|---|
| 0 | governor | `0x0cc4E413152726e52b611E097155CB7F773ade04` | 0.175984168 | 100,000 |
| 1 | curator | `0x6A44B127ba25A37094B9049A22D4ACB6F2F50d1b` | 0.07679974 | 100,000 |
| 2 | guardian | `0x99C9a8Be9cF13fFdB704dE664F408948edFE50f8` | 0.023894946 | 100,000 |
| 3 | allocator | `0x361D9b663a9823487F05698Fc3a00D246880aE15` | 0.016337556 | 100,000 |
| 4 | keeper | `0xEF2FF284a2dd06B9D7Be71447334C46c1BAe3AC5` | 0.015190599 | 100,000 |
| 5 | dataProvider | `0x43c4395C2B957cd3b6E8D96E15631f33b2768815` | 0.002 | 100,000 |
| 6 | tokenAgent | `0x0abab1C25fb946a73C35AcB78419c39E3ea011c9` | 0.002 | 100,000 |
| 7 | navSigner | `0x990A5DFD629F6046c65018d63343226b94F9e921` | 0.002 | 100,000 |
| 8 | settlementOperator1 | `0x8d37C7dd17E50F4570B9cbb09CB39Ea5068d8dc1` | 0.002 | 100,000 |
| 9 | settlementOperator2 | `0xAed6458ecAF8AD16eb93DEbc86DAb4c29f4A5131` | 0.002 | 100,000 |
| 10 | settlementOperator3 | `0xF375Bc84604C363156ac625AED3D453947ae9C0d` | 0.002 | 100,000 |
| 11 | settlementOperator4 | `0xA5b2650263bDd7b907d86A2736e39Ea893dEba65` | 0.002 | 100,000 |
| 12 | settlementOperator5 | `0xaC7025158cBc6A2599Ebb00513A156B4AD1b9675` | 0.002 | 100,000 |
| 13 | investor1 | `0xfaB397Ae958Da055fb9dc8BbfaF73f8Ab73B924E` | 0.002 | 100,000 |
| 14 | investor2 | `0x7797d46Bc3A17f80D262B994DeEDD1E3410e6718` | 0.002 | 100,000 |

> 这 15 个地址与 v7 一代相同 —— 助记词未变，角色钱包不需要重新分配。
> 角色分工见 [`offchain/scripts/testnet/ROLE_ASSIGNMENT.md`](../offchain/scripts/testnet/ROLE_ASSIGNMENT.md)。
> 注意 `SETTLEMENT_THRESHOLD` 在 `wallets.ts` 里是 3-of-5，而本次部署的三个 Vault
> threshold 都设成 1（单一 Operator = 部署钱包）。要跑 3-of-5 集成测试，
> 需先把这 5 个 operator 加进 `Settlement` 并把 threshold 改成 3。
---

## 部署后验证

以下均为本次部署后以 `cast call` 实测的结果：

```
# 三个 Vault 是全量部署，不是克隆（runtime 大小 = 本地编译产物大小）
CashVault  runtime = 20,461 bytes      (forge build --sizes: EarnVault 20,461)
NoteVault  runtime = 20,461 bytes      (forge build --sizes: EarnVault 20,461)
LPVault    runtime = 20,085 bytes      (forge build --sizes: LiquidityEarnVault 20,085)

# 核心接线
StateManager.vaultFactory()   = 0x5B03448A53C9a826bFF45364B554011E49F006e7
Settlement.queue()            = 0xde44E2F961527abb02f8379BfBD17EA5E6F98Db6
Cash/Note/LP .queue()         = 0xde44E2F961527abb02f8379BfBD17EA5E6F98Db6
Cash/Note/LP .settlement()    = 0xBcbE30962DC456cF56449893228B3C1827711c63
Cash/Note/LP .unifiedPool()   = 0x845ABfb1A1AaA7bd3Fa6724CDb5d3113ca6c560F
LiquidityBridge.sm()          = 0x77299004BcF175b91135Df9747CbC840370a2f0A
LiquidityBridge.usdt()        = 0xF7611799e16E5fFcAA00dBA882DB6e73F0731921
UnifiedPool 代理 implementation = 0x82261C807D8E59936Ec0cFee9710B119093f3B8A
UnifiedPool.vaultConfigured(each) = true
UnifiedPool.vaultActive(each)     = true
AdapterFactory.isAdapter(each)    = true

# 角色与参数
Cash/Note/LP .curator()       = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP .guardian()      = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP .allocator()     = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP .subscriptionCapShare() = 0   （不限额，需 Curator 自行设定）
Settlement.threshold(each)    = 1
Settlement.isOperator(each, deployer) = true
Cash/Note/LP Adapter.dataProvider()   = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
ProtocolFeeConfig.paymentTokenOf(Stable) = 0xF7611799e16E5fFcAA00dBA882DB6e73F0731921
NAVOracle(W3).signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
ReservePSM 的 asset 1 包装代币  = 0xD97DbeC8daF7F32DD7c0ef57C78a8Ccc224FeF0A
```

**这个 NAV signer 是暂时值。** 客户正式的 NAV signer 名单给了之后，以 NAVOracle owner 身份调用
`setSigner(rwaToken, signer)` 换掉。

---

## 部署成本

| 阶段 | 交易数 | gas |
|---|---|---|
| `Deploy` | 18 | 24,536,278 |
| `DeployW3` | 24 | 39,127,570 |
| `DeployW4` | 23 | 18,790,033 |
| 手动配置 | 8 | 396,393 |
| **合计** | **73** | **82,850,274** |

按 0.1 gwei 计约 **0.0083 BNB**。部署钱包 `0x425beB70…` 部署后余额 0.1517 BNB。
