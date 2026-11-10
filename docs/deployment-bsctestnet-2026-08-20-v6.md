# BNB Smart Chain Testnet 全新部署记录 v6（2026-08-20）

> ⚠️ **本文档已作废**：本代（v6）的 chainId 97 地址已被 [`deployment-bsctestnet-2026-08-21-v7.md`](./deployment-bsctestnet-2026-08-21-v7.md) 取代，请改用 v7 的地址。

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署钱包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三个 Vault 的 Owner）
- **原代码 commit**：`e671ba9`（`ci: 新增 GitHub Actions——构建/体积/测试，以及 anvil 全量部署`，分支 `feat/contract-feedback-20260819`）
- **脚本**：`script/Deploy.s.sol`，依序运行 `Deploy` → `DeployW3` → `DeployW4`，全部带 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）
- **区块范围**：`126,103,794` – `126,104,717`
- **取代**：[`deployment-bsctestnet-2026-08-19-v5.md`](./deployment-bsctestnet-2026-08-19-v5.md)（commit `7dc7e8f`）。
  **v5 那一代的 chainId 97 地址全部作废，请改用本文档的地址。**

---

> ## ⚠️ 本代最重要的架构变更：三个 Vault 地址是 **EIP-1167 minimal proxy**
>
> `CashVault` / `NoteVault` / `LPVault` 的链上 runtime code 各只有 **45 bytes**，
> 内容是 EIP-1167 样板，delegatecall 到**共用的实现合约**：
>
> ```
> CashVault  0x35A8B559…  ->  EarnVault impl            0x46f53e36…
> NoteVault  0xcB5d65b3…  ->  EarnVault impl            0x46f53e36…   (与 Cash 共用同一颗)
> LPVault    0x63531f84…  ->  LiquidityEarnVault impl   0xab5d15df…
> ```
>
> - **前端 / SDK / 索引器一律用 Vault 地址**（proxy），不要用 implementation 地址。
> - Cash 与 Note **共用同一颗 EarnVault 实现**；storage 各自独立在自己的 proxy 里。
> - 实现合约本身在 constructor 就把 `initialize` 锁死，永远不会被初始化，直接调用它没有意义。
> - `VaultFactory` 在同一笔 `deployVault` 交易内完成 clone + `initialize`，
>   不存在“已部署但未初始化”的可观测中间状态。
> - 这**不是**可升级代理：`VaultFactory.earnImplementation` / `lpImplementation` 是
>   `immutable`，proxy 本身也没有任何切换 implementation 的路径。要换实现只能重新部署一代。

> ## ⚠️ 沿用 v5 的操作陷阱：`subscriptionCapShare` 仍是 `0`
>
> ```
> CashVault.subscriptionCapShare() = 0
> NoteVault.subscriptionCapShare() = 0
> LPVault.subscriptionCapShare()   = 0
> ```
>
> `0` 代表**不限额**。`script/Deploy.s.sol` 从头到尾不碰任何产品参数，
> **Curator 必须在开放认购之前调用 `setSubscriptionCapShare(uint256)`**，否则认购金额不受限制。

---

## 这次相对 v5 改了什么

v5 的 commit 是 `7dc7e8f`，本次是 `e671ba9`，中间 4 个 commit：

```
e671ba9 ci: 新增 GitHub Actions——构建/体积/测试，以及 anvil 全量部署
342d319 fix(offchain): 修复本地 anvil 部署脚本的两处 env 传递
4952367 fix(offchain,docs): 索引 ExpiredRequestCancelled、补齐 SDK 白名单封装、Keeper 接入 indexer
4bfc1d6 feat(contracts): 合约问题反馈20260819 四项修复 + Vault 改用 EIP-1167 克隆
```

### 客户反馈四项修复（`4bfc1d6`）

| # | 修复 | 影响层 | 链上可见证据 |
|---|---|---|---|
| 1 | **Registry 可更新**：`bindGovernance` 一次性，Registry 配错只能重部 Vault。添加 `BaseVault.setAdapterRegistry`（Owner / Governor），逐一检查现有 Adapter 在新 Registry 仍被允许，否则回滚 | BaseVault | v6 CashVault `setAdapterRegistry(address)` → revert `0x82b42900`（`Unauthorized()`，函数**存在**）；v5 CashVault 同一调用 → **空 revert `0x`**（函数不存在） |
| 2 | **RWAToken 白名单**：`transferPathCount == 0` 时 `_checkTransferPath` 直接放行。添加独立 `_whitelisted` 映射（刻意不复用 listId），`transfer`/`transferFrom` 先强制双方在白名单。mint/burn 不受影响 | RWAToken / AssetRegistry | v6 `SToken.isWhitelisted(deployer)` → `false`（函数存在、缺省未加白）；v5 SToken 同一调用 → **空 revert `0x`**。SToken 4,202 → **4,893 bytes（+691）**，AssetRegistry 10,109 → **10,800（+691）**（RWAToken 创建码内嵌其中） |
| 3 | **到期批量清理**：添加 `cancelExpiredRequests(uint256[])`（仅 Keeper、仅 SETTLING），退还 PENDING 申购的 USDT 与 QUEUED 赎回的 `remainingShares`，触发 `ExpiredRequestCancelled`。部分成交的赎回只退未成交份额并升为 SETTLED | BaseVault | v6 CashVault `cancelExpiredRequests(uint256[])`（sel `0x7ed036d2`）→ revert `0x82b42900`（存在）；v5 同一调用 → **空 revert `0x`** |
| 4 | **SETTLING 请求截止**：`requireOperable` 此前允许 SETTLING，导致到期后 `requestRedeem` 仍可入队却永远无法结算；已收紧为 OPERATING。`enterFinalSettlement` 另要求 cycle == ACCEPTING | BaseVault / StateManager | 纯状态机收紧，**无法用单次 `cast call` 直接证明**（需要有 SETTLING 状态的 Vault）；由合约测试覆盖 |

### 合约体积：改用 EIP-1167 克隆（同一 commit）

上述改动使 `EarnVaultDeployer` 超出 EIP-170 而无法部署——Deployer 的 runtime code 就是 Vault 的
创建码，v5 余量只剩 229 bytes，该模式已到结构性上限。

| 改动 | 结果 |
|---|---|
| `VaultFactory` 改为 clone `EarnVault` / `LiquidityEarnVault` 实现合约 | `EarnVaultDeployer`、`LiquidityEarnVaultDeployer` **两颗合约删除**，本代不再部署 |
| Vault 无 constructor 参数，改为 `initialize(...)`（`initializer` 保证一次性），实现合约自身在 constructor 锁定 | Vault 体积与 Factory 体积彻底解耦；VaultFactory 11,575 → **11,743（+168）** |
| `initialize` 把建构逻辑从创建码移进 runtime code，`EarnVault` 转而超限 440 bytes；遂将 `writeDownInsolvency` 的数组遍历抽成**外部库 `VaultInsolvency`**（delegatecall，读写 Vault 自身 storage、事件仍以 Vault 地址触发） | 添加独立部署的 `VaultInsolvency` **1,780 bytes**，由 forge 自动 link 进两颗 Vault 实现 |
| `cancelRequest` 与 `cancelExpiredRequests` 的重复实现合并为 `_unwindPendingDeposit` / `_unwindQueuedRedeem` | — |

未激活 `via_ir`，`optimizer_runs` 维持 200。

### 为什么必须整代重新部署

与 v5 同样的 immutable 连锁理由，而且这次 Vault 的部署模式本身变了：`StateManager` 不在 proxy
后面、`setVaultFactory` 是一次性的、`VaultFactory` 的 `earnImplementation`／`lpImplementation`
是 `immutable`，`Vault`／`Queue`／`ClaimRegistry`／`Settlement` 的 `sm` 全是 constructor immutable。
BaseVault 的 storage layout 也因白名单／清理功能而改变，旧 Vault 无法沿用。

### 部署流程

与 v5 完全相同的三阶段 + 一阶段手动配置：

| 阶段 | 读取的环境变量 |
|---|---|
| `Deploy` | 无（只需 `TEST_PK`） |
| `DeployW3` | `HYPER_ACCESS_CONTROL`、`REVENUE_POOL`、`USDT`、`PROTOCOL_FEE_CONFIG` |
| `DeployW4` | `HYPER_ACCESS_CONTROL`、`STATE_MANAGER`、`QUEUE`、`UNIFIED_POOL`、`USDT`、`CASH_VAULT`、`NOTE_VAULT`、`LP_VAULT`、`SETTLEMENT_OPERATORS`、`SETTLEMENT_THRESHOLD`、`DATA_PROVIDER_SIGNER` |

> **env 接线两个坑**（本次与本机 anvil 全量部署一并验证）：
> 1. `DeployW3` 需要 `REVENUE_POOL`（阶段一的输出）——`UnifiedPool` 的 `addAuthorizedSource` 移到了 W3。
> 2. `DeployW4` 的 `UNIFIED_POOL` 来自 **`DeployW3` 的输出**，不是阶段一；阶段一根本不部署 UnifiedPool。
>
> 本次**没有**使用 `offchain/scripts/local/deploy.ts`（它硬编 anvil RPC 与 anvil account 0 私钥），
> 三个阶段都是直接驱动 `forge script`。

交易笔数：**18 / 27 / 26**，另加阶段四 8 笔手动配置，合计 **79 笔**。
（`DeployW3` 比 v5 多一笔：`VaultInsolvency` 库是 forge 自动插入的 CREATE2 部署，排在第 1 笔。）

### EIP-170 前置检查

广播前跑 `forge build --sizes`：**exit code 0，全部 margin 为正、无 violation**。

```
tightest runtime margins:
  EarnVault                                  runtime= 24,127  rt_margin=    449
  LiquidityEarnVault                         runtime= 23,189  rt_margin=  1,387
  RWAAdapterDeployer                         runtime= 14,768  rt_margin=  9,808
  StateManager                               runtime= 14,701  rt_margin=  9,875
  LiquidityAdapterDeployer                   runtime= 13,984  rt_margin= 10,592
  FirstPeriodAdapterDeployer                 runtime= 13,342  rt_margin= 11,234
```

最接近上限的合约由 v5 的 `EarnVaultDeployer`（余裕 229）换成 `EarnVault` 实现本身（余裕 **449**）。
往 `BaseVault`／`EarnVault` 再加任何 public/external 函数前仍必须先跑 `forge build --sizes`。

---

## 完整地址表

### 前端 `deployments.js` 可直接贴入的区块（25 个 key）

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: 'e671ba9',
    addresses: Object.freeze({
      hyperAccessControl: '0xB9A677ce3D4c21Cb4661E04323194E4fdF9c015e',
      stateManager: '0xD94c9C80F07437F0F60f8371b5bF77D53096a314',
      navOracle: '0x35C9a6B293cb81ff2cBCb30C7afA689Fa1725acC',
      mintBurnController: '0x5cFEdaFaee4f7E874Db56E93a28Ff7bAeE639534',
      assetRegistry: '0xf37f5Dce7b559B9424A86De121334483f34cf670',
      protocolFeeConfig: '0x28e9d91170fED5AbCbaeFC624EcaD3f325C5fbdC',
      reservePSM: '0x744D1F6271308BD4191Cc4A1DF26eC277b090c83',
      poRRegistry: '0x33722421BDe2843ECd03f9aff607e813d6BD8839',
      queue: '0xdc7E9CEa519230029DA1988770C72cE03fa4ed6A',
      revenuePool: '0x4ABC64Ba46D18b5955C94e653967aD7fD866A184',
      unifiedPool: '0xe1d9958e32Ab6da31205f3fd06f22cE83290751b',
      settlement: '0x2eF6baAdF4583557b5a77f2E3C804858C6Ff62A5',
      vaultFactory: '0x7Eb0d3121D40923f0eB8eA4c57e2f17D81f122C2',
      adapterFactory: '0x83cba04b9a364Ce4D880B20996f14489437eBF11',
      adapterRegistry: '0xEF1AC5c48B02e7Cd742c345A26D527aFA9B84E96',
      adapterRegistryFactory: '0xE4D86fcF22E4026B9bdA43ce50f0ef7D3130cD2d',
      liquidityBridge: '0x8c3E86316aDaC69B47637231486a36aB625946e7',
      claimRegistry: '0x963ad46cdcFe7B6B3766e6efacbF0821f170D533',
      mockUsdt: '0x6F86108A0172ae573D6ebB30D75D6Cb42609fDAa',
      cashVault: '0x35A8B5597cd579CBeb5D4f91C2A19370aEf99edb',
      noteVault: '0xcB5d65b3EAcAb7471341bBe2d1dA59D2b3980012',
      lpVault: '0x63531f840FF2CB8952A64A8206E895051ECa9a04',
      cashAdapter: '0xf41aAa5f88f7d36842eB8B0Bb95cb716d86085BB',
      noteAdapter: '0xf08a8C2cD61DaF589cd51A40CfF6A03880Bd01FF',
      lpAdapter: '0x399B879178ACDbD2aa65ff09C09c55623498cB05',
    }),
  }),
});
```

### 全部地址 + bytecode 字节数

逐一以 `cast code <addr> --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545` 取回并计算长度，
**全部非空（40/40）、全部 ≤ 24,576 bytes（0 violation）**。“Δ”栏是相对 v5 的字节差。

| 阶段 | 合约 | 地址 | bytecode | Δ vs v5 |
|---|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0xB9A677ce3D4c21Cb4661E04323194E4fdF9c015e` | 1109 bytes | 0 |
| Deploy | StubStateManager | `0xc65e64f277e10cf32D3F155cc254c0aA95952A3B` | 3645 bytes | 0 |
| Deploy | MockUSDT | `0x6F86108A0172ae573D6ebB30D75D6Cb42609fDAa` | 1720 bytes | 0 |
| Deploy | RevenuePool | `0x4ABC64Ba46D18b5955C94e653967aD7fD866A184` | 3744 bytes | 0 |
| Deploy | ProtocolFeeConfig | `0x28e9d91170fED5AbCbaeFC624EcaD3f325C5fbdC` | 1827 bytes | 0 |
| Deploy | AssetRegistry | `0xf37f5Dce7b559B9424A86De121334483f34cf670` | 10800 bytes | **+691** |
| Deploy | MintBurnController | `0x5cFEdaFaee4f7E874Db56E93a28Ff7bAeE639534` | 3427 bytes | 0 |
| Deploy | NAVOracle（W2 那颗，前端不用） | `0xbB5BeEeAd95A237964081453cc372922Ae17d373` | 3983 bytes | 0 |
| Deploy | PoRRegistry | `0x33722421BDe2843ECd03f9aff607e813d6BD8839` | 2985 bytes | 0 |
| Deploy | SToken / RWAToken（demo 资产 1） | `0x0bf61af0F5D6671d948ea2069b5E084Ca312Cb94` | 4893 bytes | **+691** |
| Deploy | JToken（demo 资产 2） | `0xa93560a078AfDeA98b13460b52dc45593c10b66e` | 4893 bytes | **+691** |
| Deploy | Queue（W2 那颗，绑 StubStateManager，前端不用） | `0x5226FE2504c60cbB83CaE5e888cE6Fb6B1D10429` | 4178 bytes | 0 |
| Deploy | ReservePSM | `0x744D1F6271308BD4191Cc4A1DF26eC277b090c83` | 10577 bytes | 0 |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0xcc1f2A17efE4B83fff97a759F2e511acF62dAA9E` | 2329 bytes | 0 |
| Deploy | RWAAdapter（W2 demo） | `0xFbe8741471Ab5E8a2e1cec859153BBcFFd2C9B24` | 13014 bytes | 0 |
| DeployW3 | **VaultInsolvency（添加，delegatecall 库）** | `0x9367cF1f98ce202f0e5E9ea7661eBFcE77c45837` | 1780 bytes | **添加** |
| DeployW3 | **StateManager** | `0xD94c9C80F07437F0F60f8371b5bF77D53096a314` | 14701 bytes | **+1** |
| DeployW3 | ClaimRegistry | `0x963ad46cdcFe7B6B3766e6efacbF0821f170D533` | 1946 bytes | 0 |
| DeployW3 | **NAVOracle** | `0x35C9a6B293cb81ff2cBCb30C7afA689Fa1725acC` | 3983 bytes | 0 |
| DeployW3 | **Queue** | `0xdc7E9CEa519230029DA1988770C72cE03fa4ed6A` | 4178 bytes | 0 |
| DeployW3 | LiquidityBridge | `0x8c3E86316aDaC69B47637231486a36aB625946e7` | 1291 bytes | 0 |
| DeployW3 | UnifiedPool implementation | `0x297E4e201c6561464b04F88BEd7a1AF46b78e3F2` | 8851 bytes | 0 |
| DeployW3 | **UnifiedPool（ERC1967 proxy，用这个）** | `0xe1d9958e32Ab6da31205f3fd06f22cE83290751b` | 163 bytes | 0 |
| DeployW3 | **EarnVault implementation（Cash / Note 共用 clone 目标）** | `0x46F53E36235535309A02fF6cBe872116CeF7c85F` | 24127 bytes | **取代 EarnVaultDeployer** |
| DeployW3 | **LiquidityEarnVault implementation（LP clone 目标）** | `0xaB5d15Df0AEC2a2931c81850E3Ce6190f1BcF877` | 23189 bytes | **取代 LiquidityEarnVaultDeployer** |
| DeployW3 | VaultFactory | `0x7Eb0d3121D40923f0eB8eA4c57e2f17D81f122C2` | 11743 bytes | **+168** |
| DeployW3 | AdapterRegistryFactory | `0xE4D86fcF22E4026B9bdA43ce50f0ef7D3130cD2d` | 3052 bytes | 0 |
| DeployW3 | AdapterRegistry（共用，由工厂产出） | `0xEF1AC5c48B02e7Cd742c345A26D527aFA9B84E96` | 1755 bytes | 0 |
| DeployW3 | **CashVault (EIP-1167 proxy → EarnVault impl, htCASH)** | `0x35A8B5597cd579CBeb5D4f91C2A19370aEf99edb` | **45 bytes** | v5 是 22515（独立合约） |
| DeployW3 | **NoteVault (EIP-1167 proxy → EarnVault impl, htNOTE)** | `0xcB5d65b3EAcAb7471341bBe2d1dA59D2b3980012` | **45 bytes** | v5 是 22515（独立合约） |
| DeployW3 | **LPVault (EIP-1167 proxy → LiquidityEarnVault impl, htLP)** | `0x63531f840FF2CB8952A64A8206E895051ECa9a04` | **45 bytes** | v5 是 21435（独立合约） |
| DeployW3 | CashVaultTimelock | `0x6296547bAe7Dc2785e9fC313729A2cD326E08F28` | 6766 bytes | 0 |
| DeployW3 | NoteVaultTimelock | `0xD25df5a11dF88EFdcE8C8ce5027293522EF5413F` | 6766 bytes | 0 |
| DeployW3 | LPVaultTimelock | `0x6b7221c493fa12f1003055382fC34725fEE4e850` | 6766 bytes | 0 |
| DeployW4 | Settlement | `0x2eF6baAdF4583557b5a77f2E3C804858C6Ff62A5` | 9004 bytes | 0 |
| DeployW4 | AdapterFactory | `0x83cba04b9a364Ce4D880B20996f14489437eBF11` | 2329 bytes | 0 |
| DeployW4 | CashAdapter (FirstPeriodAdapter) | `0xf41aAa5f88f7d36842eB8B0Bb95cb716d86085BB` | 11807 bytes | 0 |
| DeployW4 | NoteAdapter (FirstPeriodAdapter) | `0xf08a8C2cD61DaF589cd51A40CfF6A03880Bd01FF` | 11807 bytes | 0 |
| DeployW4 | LPAdapter (LiquidityAdapter) | `0x399B879178ACDbD2aa65ff09C09c55623498cB05` | 12442 bytes | 0 |

链上 runtime 长度与本 commit 的本地 artifact（`forge build --sizes`）**逐一吻合**。
`Settlement`／三颗 Adapter／`Timelock`／`Queue` 的 Δ = 0，印证本代改动集中在 BaseVault 家族、
RWAToken 与 VaultFactory。

`UnifiedPool` proxy 只有 163 bytes 是正常的（ERC1967Proxy 本体就这么小）；前端／SDK 一律用
proxy 地址 `0xe1d9958e…`。

### 重复合约的厘清

与 v5 一样，三阶段会产生两个 `NAVOracle`、两个 `Queue`、两个 `AdapterFactory`：

| 合约 | 实际接线（用这个） | 另一份（不要用） | 判定依据（`cast call`） |
|---|---|---|---|
| `Queue` | **`0xdc7E9CEa…`**（W3） | `0x5226FE25…`（W2，绑 StubStateManager） | `Settlement.queue()` = `0xdc7E9CEa…`；三个 Vault 的 `queue()` 都 = `0xdc7E9CEa…`；`W3 Queue.sm()` = `0xD94c9C80…`（真 StateManager） |
| `AdapterFactory` | **`0x83cba04b…`**（W4） | `0xcc1f2A17…`（W2 demo） | `W4 AdapterFactory.isAdapter(cashAdapter)` = `true` |
| `NAVOracle` | **`0x35C9a6B2…`**（W3，前端 key 用这个） | `0xbB5BeEeA…`（W2，供 W2 demo RWAAdapter） | 脚本的 `setSigner` 只打在 W2 那颗上；W3 那颗由阶段四手动补设（见下） |

W3 那颗 NAVOracle 的 signer 已于阶段四手动补设为部署钱包：

```
W3 NAVOracle.signerOf(SToken) = 0x425beB70d264362E4eb7953C4f7aFBDe01145538   (本次手动补设)
```

> **这个 signer 是暂时值。** 客户正式的 NAV signer 名单给了之后，以 NAVOracle owner 身分调用
> `setSigner(rwaToken, realSigner)` 覆盖即可，不需重新部署。

---

## 部署交易 hash

### 阶段一：`Deploy`（18 笔，全部 status `0x1`，合计 26,958,069 gas，区块 126,103,794 – 126,103,930）

```
forge script script/Deploy.s.sol --tc Deploy \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 --broadcast --legacy --slow
```

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | HyperAccessControl | `0x1f6083c8e3d43fe42ff587e3b163007687aca15f0c2bad0fd0392bdd3662e961` |
| 2 | CREATE | StubStateManager | `0x65db761850a4a06422e7a7c9aa1ece477d082959163557a41fe1762e22924273` |
| 3 | CREATE | MockUSDT | `0xa2682f9ca8928abceda5ebb20100929c8c61a9b849e50c9e12f45cb1c16b32fe` |
| 4 | CREATE | RevenuePool | `0x2eb19439fd96d0d36d10aed783b8d88dfc286994742beee2e845bb6958dbfca3` |
| 5 | CREATE | ProtocolFeeConfig | `0xe51ae1a3120d58d42e40a2c62e1f34291c87dc2cf0ab8d9bb08c371fc41bf3bc` |
| 6 | CREATE | AssetRegistry | `0x8aec533601cb3dc10f2d34741dac2ca6ecb6f8f9513be57c559c48661271d1d2` |
| 7 | CREATE | NAVOracle (W2) | `0x5f415fa7b5efa9bf8844f749b63c419c112d94310fb3b8cb371c6efec3782802` |
| 8 | CREATE | PoRRegistry | `0x31ec6fabbfd6792a3d83ce4b2b491c5946df26aa2b8eead968e8198d72fe0245` |
| 9 | CALL | AssetRegistry.registerAsset (S) | `0xf7be7e3ffbfc53641193f8a5d43fe909c68a1c6126a1a31c113b830a2d29df61` |
| 10 | CALL | AssetRegistry.registerAsset (J) | `0x48e0de8658b295216865af1b5f2f07e9b3518a7c23589af41df70f8ed834e062` |
| 11 | CREATE | Queue (W2) | `0x464f139e4fa4651e76f80b7eaa0e68d980ab96be1379e14b6517b7d755bfea2d` |
| 12 | CREATE | ReservePSM | `0x645ff9359be4fdc8192b9103c34f1f5b0a9c1bc741032b217951d4e7c7a3183f` |
| 13 | CALL | ReservePSM.deployWrappedToken | `0x8cb8656be1754c3f0b7b539deea24c041ffc1dfded54967dba7d7ea050c1c82a` |
| 14 | CREATE | AdapterFactory (W2) | `0x04ddc437fd7765b3e64934842a12d9003dfcc73e7c8d5f2d3ff09d4f39f4c3d5` |
| 15 | CALL | AdapterFactory.deployRWAAdapter | `0xa1486fb45c78b824134338adca87acd5fcb92c1fd70b84adb0ab9d7b2b8972f4` |
| 16 | CALL | MintBurnController.setTokenAgent(1) | `0x915f045f60b056d3001004dd9d95b66e795e4d6d99e16a1b84f74841197d6201` |
| 17 | CALL | MintBurnController.setTokenAgent(2) | `0x04e047fb26635ec7b396eafe7086a885bf308598513e958cb885cff5f2fa5df9` |
| 18 | CALL | NAVOracle(W2).setSigner | `0x001ea88c64f1d9360a826d64e32ed1bac02ead6f10e39bcb2d3d21e923cae955` |

### 阶段二：`DeployW3`（27 笔，全部 status `0x1`，合计 31,667,584 gas，区块 126,104,041 – 126,104,236）

环境变量：`HYPER_ACCESS_CONTROL=0xB9A677ce…`、`REVENUE_POOL=0x4ABC64Ba…`、
`USDT=0x6F86108A…`、`PROTOCOL_FEE_CONFIG=0x28e9d911…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE2 | **VaultInsolvency（forge 自动 link 前置部署）** | `0xb355fd77b6f9a3514547f5b4d1aa0758a2e408bce59758182ab8f49930c8fb22` |
| 2 | CREATE | StateManager | `0x3c79f57ef53cc5837e45066a8dbd972043f3aa9a0fbfcb97db5e0f38293888da` |
| 3 | CREATE | ClaimRegistry | `0xa90d16acd0aed9e97d8dd9b1bffd95375a93f7c21de28af58cc2f7e8aec9b099` |
| 4 | CREATE | NAVOracle | `0xb278c55bf4d41f6e92897496569cdb0eaa084cdeb941dab2c13e0470793c1989` |
| 5 | CREATE | Queue | `0x8169a842b4ef43c5d15f54c59e48b07f9d5a8a409e4c314e7f8895d87d2618d3` |
| 6 | CREATE | LiquidityBridge | `0xd405d16261622f23d889861aa4d270963d21119d8e8eb809dd06a27672c5d42d` |
| 7 | CREATE | UnifiedPool implementation | `0x99006fcdb13757fe325e0b70018bfd5641a3cdf521d4c9447a620618d0c570b7` |
| 8 | CREATE | ERC1967Proxy (UnifiedPool) | `0xeec5fbbcb41fb4ba5ac65956346250f1e5a0d86d789482a0dc550dfa1095412c` |
| 9 | CALL | RevenuePool.addAuthorizedSource(pool) | `0xe46510236e238e6f3a58987ba0d1a5d94e7f686dd04f9800c04070eba3d80caf` |
| 10 | CREATE | **EarnVault implementation** | `0x7a7411af2202c4f24e4a4b4f1b17a7ce8ff4f4cf3d8ad43d2d8e778a3476e3e5` |
| 11 | CREATE | **LiquidityEarnVault implementation** | `0x0216e16f43460f847fe9434dd80a9092371f72e47448471a0b141b72fac279cd` |
| 12 | CREATE | VaultFactory | `0x1403411f51e160e318438891c7af26e6b43fb7d7f541d8c86084d55cbfa37e48` |
| 13 | CREATE | AdapterRegistryFactory | `0x0ce3f57a58c98f59cfed012c7e64629e137426bef1e5db603c4b5a948322e192` |
| 14 | CALL | AdapterRegistryFactory.deployRegistry | `0xc1f7535dd76a7fa78a82122883679fc3bffc6d23a7baad676a0f2a445e920b12` |
| 15 | CALL | StateManager.setVaultFactory | `0xc7d62e3961b0aba062d7a7290926947f5c731cd68b3e0c1053f9bf9fd4d6f841` |
| 16 | CALL | VaultFactory.deployVault (Cash，clone + initialize) | `0x23051e34144bd8cb4fc8f901ce580b76279e6cdccfd29275d0d6a0ec290ccbb1` |
| 17 | CALL | VaultFactory.deployVault (Note，clone + initialize) | `0xd0128b5c76f0accd2d50c1c7cee65a7c18727b74b20b3741f67257efd0e3a85e` |
| 18 | CALL | VaultFactory.deployVault (LP，clone + initialize) | `0x3d727f4c1348bae3d16c0f9f57acdd8e3052c20e54c6c182bd7231fef5bf52af` |
| 19 | CALL | CashVault.setKeeper | `0xca399d35180ebe4a3789e5e7af0924474d9d37a2c3fcc4eee47e1c095cecd84c` |
| 20 | CALL | CashVault.setCurator | `0xbb0d8c7ab45dd14e4bbbef88090b958b04a1a7c961703e0c0030d3ab9a7cb6df` |
| 21 | CALL | NoteVault.setKeeper | `0x8246ac8b827f7153e54ee9f88c1aa04912083737842ed29700c6e8c3a4fd8812` |
| 22 | CALL | NoteVault.setCurator | `0x7965dfd0346dbf3ba7a0fb52469bb5598c184d6849a5678f041e7ab8d8e2e499` |
| 23 | CALL | LPVault.setKeeper | `0xc428ca5a5b627908d64763fbd64a930f4cd8b147bb14666bc4857df379513ffc` |
| 24 | CALL | LPVault.setCurator | `0x1ce13487c95c16b5b8bb295cec0e257ee5cf9af15c86e4c0d65f4f46d32f58f2` |
| 25 | CALL | UnifiedPool.addTrancheVault (Cash) | `0x667c65839ccb11572841087e573250976d964f0109409846d8d1f56a0d0c7dae` |
| 26 | CALL | UnifiedPool.addTrancheVault (Note) | `0x56dec2a2d40ca6237b9a9e1da7ef2b4cd7c9dd785fe52ddbae7786907f2f88bd` |
| 27 | CALL | UnifiedPool.addTrancheVault (LP) | `0xd8732bf8cd9a1af7516255f6459ff75c2b3eae87f16afe4935843feb9106af26` |

### 阶段三：`DeployW4`（26 笔，全部 status `0x1`，合计 21,314,859 gas，区块 126,104,328 – 126,104,520）

环境变量另加：`STATE_MANAGER=0xD94c9C80…`、`QUEUE=0xdc7E9CEa…`、
**`UNIFIED_POOL=0xe1d9958e…`（来自 DeployW3 的输出）**、`NAV_ORACLE=0x35C9a6B2…`、
`CASH_VAULT=0x35A8B559…`、`NOTE_VAULT=0xcB5d65b3…`、`LP_VAULT=0x63531f84…`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 类型 | 目标 | tx hash |
|---|---|---|---|
| 1 | CREATE | Settlement | `0x0a6c6f2edc7a1fde50d1097a55103eb4344429b72d60ea97b5a5104d03397bfd` |
| 2 | CALL | CashVault.setSettlement | `0xd4f757bbfb85ee2d37c8dacf2a3a88b9c8deba13ac89b9f7493d9ad7d185d51c` |
| 3 | CALL | NoteVault.setSettlement | `0xf5f8d6a4ec7c9f61ee0bd0c0e9b4269645553745bb512d32dbe8764ebc338cc0` |
| 4 | CALL | LPVault.setSettlement | `0xfa79eab906793436334dd5aa7993263d27ed2afd6c68152baa6aef1200707dc7` |
| 5 | CALL | Settlement.setOperator (Cash) | `0xfa0e2a8c8d859fd1716a58a76a273af9826da3ca4cbff6cbe311edad10b6f0e3` |
| 6 | CALL | Settlement.setThreshold (Cash) | `0x66fd052ed8c66610dd08a1c2ba1f39edefccdc7e65a96c36d01bebee65fac9ea` |
| 7 | CALL | Settlement.setOperator (Note) | `0x13c8393ed76eb1efdd0ddb2aea65e75b2138a1e1279849a39eb90e653d687c30` |
| 8 | CALL | Settlement.setThreshold (Note) | `0x15c86f046b3aaa5b35c23f921d3317f059711348e465c94aa9730202d0ad19d6` |
| 9 | CALL | Settlement.setOperator (LP) | `0xf001242db15d16a8fbe9b8184b4da2e933dbf40fec1ae804fc4301fd32dcd483` |
| 10 | CALL | Settlement.setThreshold (LP) | `0x52a15f17f30dc2279f2b977cfd2b3070d5b68b35a231994301ba0ebcdfd86057` |
| 11 | CREATE | AdapterFactory | `0x1050b57cf6a6487f2361b1733d790a6ca7ad5e006291649b44342314a6c6fb84` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | `0x7387d8fac49db8cb9cce643bfeca2ef97ab986ef7c491c12cac285ac2b112131` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | `0xf73199d1d0438b7cf11bed3c34780401ab3c8b03e14d2c03a1687767e51354dc` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | `0x8624e295df93fde4c8efdc26619f49a9b380dba4304e33344b75da2899b0c2d8` |
| 15 | CALL | AdapterRegistry.setAdapterAllowed (Cash) | `0x7a5211a45e556355f3c24170d71de995e130f422d4f4b44b473efd59d0e9b6d0` |
| 16 | CALL | AdapterRegistry.setAdapterAllowed (Note) | `0x2a160bb617a3afe8c3129ae1a5d10a4266b5394f9dcfb4ffb1289fe5063c65f3` |
| 17 | CALL | AdapterRegistry.setAdapterAllowed (LP) | `0x8a364309755ae67eb44cd36073e0a25490517723c7837853e4721b89e25466b0` |
| 18 | CALL | LPVault.setAdapter | `0x70a1c6d468f0b1ff41e90f3b9f99b9db3ec0a696576040ca01d1c16f1d7a0761` |
| 19 | CALL | CashVault.addAdapter | `0x727951ebab94e49eb8cf213e6e795a492ec7f1d5107270cf3c9ccc83eb7b9c0b` |
| 20 | CALL | NoteVault.addAdapter | `0x1a9e7a0e22111e641565b3d08ab9a85f96667362e10b8ec1691c5ab040ac952a` |
| 21 | CALL | CashVault.setUnifiedPool | `0x5bdb279540ba345233adfbb6aae9aabf2f6d8eeb860e5aab310019be144a5b29` |
| 22 | CALL | NoteVault.setUnifiedPool | `0xe9b21f0e88db681da7a48f140c2dc6118c4c19593262ec5fe2f68e383f8d8b1e` |
| 23 | CALL | LPVault.setUnifiedPool | `0x06dfc073ae8293e16a8998aa29d4bdfa3bce8c1617ab46813b6d49b114d315d4` |
| 24 | CALL | CashAdapter.setDataProvider | `0x2b1604eced316976b5fb7013ca83688d03e6a7da9da33cecec323f733b0d9c43` |
| 25 | CALL | NoteAdapter.setDataProvider | `0x08738d1f79d097a43234f6c4639b53a758c01bb94ac638110e5d875cd4f97544` |
| 26 | CALL | LPAdapter.setDataProvider | `0xf6151c41f742677b8e3322872afd48386f223a39455ab40d0dd09405ce0c6015` |

### 阶段四：部署后手动配置（8 笔 `cast send`，全部 status `0x1`，合计 406,964 gas，区块 126,104,618 – 126,104,717）

| 动作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0x3c46aab0ea75fc5e35edde52f32615ddeaad185581fb0884dbe7291740281cb2` |
| `CashVault.setGuardian(deployer)` | 51,019 | `0x70708850c5b23a34f5a4430a0615252e890526b9c5037d6c6cdbcb856dcdd95d` |
| `CashVault.setAllocator(deployer)` | 51,085 | `0x82fb92652559ba924892f7f1c0ddf55223e34c333da2ccbf6ea5f6b2e5e88e15` |
| `NoteVault.setGuardian(deployer)` | 51,019 | `0x60586a2ff4b6a0882c848c52ba715b122391a1560414fa66dd9767926ffff8e7` |
| `NoteVault.setAllocator(deployer)` | 51,085 | `0xd462a4a7b92b5a177ed9bf8d20c5c692b4ff5a51f72ad12da8495cc62a34583f` |
| `LPVault.setGuardian(deployer)` | 51,085 | `0xc500cef52446c5f4d8356e23e2ceec3e2693f672e0aa274c67be9f230dfeedb9` |
| `LPVault.setAllocator(deployer)` | 51,107 | `0xd31a74c7dd6e1fc6315c620a775af4049794f61d2e7176bd70ed442dece8a186` |
| **`NAVOracle(W3).setSigner(SToken, deployer)`** | 48,251 | `0x0072662719a74de7f474369f0f4eb4a0abcc86a1bc8dc8f5b01f14cd21629c15` |

> **注**：与 v3／v4／v5 一样，8 笔里有 7 笔第一次送出时被 RPC 负载平衡后端以 `nonce too low`
> 拒绝（交易未上链、未耗 gas —— 部署后 nonce 恰好只前进 79，等于实际上链笔数，证明没有重复送出）。
> 逐笔自动重送后全部成功，上表是成功的那 8 笔。
> Settlement threshold / operator 与三个 Adapter 的 Data Provider 已由 `DeployW4` 设好，阶段四不需再送。

### 阶段五：测试钱包补铸 MockUSDT — **本次未运行**

新的 MockUSDT 是 `0x6F86108A0172ae573D6ebB30D75D6Cb42609fDAa`，v5 的 MockUSDT
`0x95b17e18…` 上的余额在新环境等于不存在，15 个测试钱包的 USDT 全部归零。
需要跑集成测试前，先把 `offchain/scripts/testnet/addresses.bscTestnet.json` 更新到 v6 地址，再运行：

```
cd offchain
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run   # 先看计划
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts             # 实际送出
```

脚本本身是幂等的（先读余额，已达标者跳过）。**本次交付未运行此阶段**，见文末“尚待人工处理”。

---

## Gas 与余额

| 项目 | gas | BNB @ 0.1 gwei |
|---|---|---|
| 阶段一 `Deploy`（18 笔） | 26,958,069 | 0.0026958069 |
| 阶段二 `DeployW3`（27 笔） | 31,667,584 | 0.0031667584 |
| 阶段三 `DeployW4`（26 笔） | 21,314,859 | 0.0021314859 |
| 阶段四 部署后配置（8 笔） | 406,964 | 0.0000406964 |
| **合计（79 笔）** | **80,347,476** | **0.0080347476** |

- 部署前余额：`0.078306830260000000` BNB
- 部署后余额：`0.070272082660000000` BNB
- 实际扣除：`0.008034747600000000` BNB（与上表加总 **完全吻合**）
- 部署钱包 nonce：811 → 890（79 笔）

比 v5 的 92,735,296 gas 少了约 12.4M —— 主因是两颗巨大的 Deployer 合约不再部署，
改为部署两颗实现 + 三次便宜的 clone。

---

## 验证结果

RPC 一律 `https://data-seed-prebsc-1-s1.binance.org:8545`。

### 1) bytecode 非空与 EIP-170 ✅

40 个地址（含两颗 Vault 实现、`VaultInsolvency`、`UnifiedPool` 实现、W2 的重复合约）逐一 `cast code`：
**0 empty / 40**，**0 个超过 24,576 bytes**。最大的是 `EarnVault` 实现 24,127 bytes（余裕 449）。

### 2) 三个 Vault 是 45-byte EIP-1167 proxy ✅

```
CashVault 0x35A8B559… code = 0x363d3d373d3d3d363d73 46f53e36235535309a02ff6cbe872116cef7c85f 5af43d82803e903d91602b57fd5bf3
NoteVault 0xcB5d65b3… code = 0x363d3d373d3d3d363d73 46f53e36235535309a02ff6cbe872116cef7c85f 5af43d82803e903d91602b57fd5bf3
LPVault   0x63531f84… code = 0x363d3d373d3d3d363d73 ab5d15df0aec2a2931c81850e3ce6190f1bcf877 5af43d82803e903d91602b57fd5bf3
```

三段都是标准 EIP-1167 样板（`363d3d373d3d3d363d73` + 20-byte 实现地址 + `5af43d82803e903d91602b57fd5bf3`），
中间的地址正好是本代部署的两颗实现。Cash / Note 指向同一颗。

### 3) `initialize()` 确实通过 proxy 跑过 ✅

三颗 proxy 的 view 全部有值（若 `initialize` 没跑，这些会是 `0` / 空字符串）：

| | Cash `0x35A8B559…` | Note `0xcB5d65b3…` | LP `0x63531f84…` |
|---|---|---|---|
| `name()` | `"HyperTessera Cash Earn"` | `"HyperTessera Note Earn"` | `"HyperTessera Liquidity Earn"` |
| `symbol()` | `htCASH` | `htNOTE` | `htLP` |
| `owner()` | `0x425beB70…` | `0x425beB70…` | `0x425beB70…` |
| `stateManager()` | `0xD94c9C80…` | `0xD94c9C80…` | `0xD94c9C80…` |
| `adapterRegistry()` | `0xEF1AC5c4…` | `0xEF1AC5c4…` | `0xEF1AC5c4…` |
| `vaultTimelock()` | `0x6296547b…` | `0xD25df5a1…` | `0x6b7221c4…` |
| `queue()` | `0xdc7E9CEa…` | `0xdc7E9CEa…` | `0xdc7E9CEa…` |
| `settlement()` | `0x2eF6baAd…` | `0x2eF6baAd…` | `0x2eF6baAd…` |
| `unifiedPool()` | `0xe1d9958e…` | `0xe1d9958e…` | `0xe1d9958e…` |
| `curator/guardian/allocator` | `0x425beB70…` | `0x425beB70…` | `0x425beB70…` |
| `isKeeper(deployer)` | `true` | `true` | `true` |
| `subscriptionCapShare()` | `0` | `0` | `0` |

### 4) `VaultFactory` 的两个 implementation 指针 ✅

```
VaultFactory.earnImplementation() = 0x46F53E36235535309A02fF6cBe872116CeF7c85F   (= 部署的 EarnVault 实现)
VaultFactory.lpImplementation()   = 0xaB5d15Df0AEC2a2931c81850E3Ce6190f1BcF877   (= 部署的 LiquidityEarnVault 实现)
VaultFactory.stateManager()       = 0xD94c9C80F07437F0F60f8371b5bF77D53096a314
```

两者皆非零，且与 proxy body 内嵌的地址、与 broadcast log 中的 CREATE 地址三方一致。

### 5) `VaultInsolvency` 确实被 link 进实现 runtime code ✅

`VaultInsolvency` = `0x9367cF1f98ce202f0e5E9ea7661eBFcE77c45837`。
在链上 runtime code 中搜索这 20 bytes：

```
EarnVault impl            0x46f53e36…   -> 命中（1 处）
LiquidityEarnVault impl   0xab5d15df…   -> 命中（1 处）
```

命中即代表 `delegatecall` 目标是实际部署的库地址，而不是 forge 未 link 时留下的
`__$…$__` placeholder。

### 6) 本次四项客户反馈修复的链上证据

判读规则同 v3–v5：函数不存在 → dispatch 落空 → **空 revert data `0x`**；
函数存在但被权限挡下 → **具体 error selector**（`0x82b42900` = `Unauthorized()`）。

| 修复 | v6 调用结果 | v5 对照组 | 结论 |
|---|---|---|---|
| #1 `BaseVault.setAdapterRegistry(address)` | revert `0x82b42900` | 空 revert `0x` | 函数**添加成功** ✅ |
| #2 `RWAToken.isWhitelisted(address)` | `false`（正常回传） | 空 revert `0x` | 白名单机制**已上链** ✅（缺省无人在白名单内，见下方待办） |
| #3 `BaseVault.cancelExpiredRequests(uint256[])`（sel `0x7ed036d2`） | revert `0x82b42900` | 空 revert `0x` | 函数**添加成功** ✅ |
| #4 `requireOperable` 收紧、`enterFinalSettlement` 要求 ACCEPTING | — | — | **未做链上验证**：纯状态机收紧，需要处于 SETTLING 的 Vault 才观察得到，由合约测试覆盖 |

v5 对照组用的是 v5 的 CashVault `0x2EAe528B…` 与 v5 的 SToken `0xfb10cC4d…`。

### 连接状态抽查（`cast call`）

```
StateManager.vaultFactory()               = 0x7Eb0d3121D40923f0eB8eA4c57e2f17D81f122C2
StateManager.accessControl()              = 0xB9A677ce3D4c21Cb4661E04323194E4fdF9c015e
StateManager.vaultCount()                 = 3
StateManager.vaultsPaged(0,10)            = [0x35A8B559…(Cash), 0xcB5d65b3…(Note), 0x63531f84…(LP)]
StateManager.registeredVaults(CashVault)  = true
UnifiedPool.sm()                          = 0xD94c9C80F07437F0F60f8371b5bF77D53096a314   (真 StateManager，一次 initialize 到位)
UnifiedPool.usdt()                        = 0x6F86108A0172ae573D6ebB30D75D6Cb42609fDAa
Settlement.sm()                           = 0xD94c9C80F07437F0F60f8371b5bF77D53096a314
Settlement.unifiedPool()                  = 0xe1d9958e32Ab6da31205f3fd06f22cE83290751b
Settlement.queue()                        = 0xdc7E9CEa519230029DA1988770C72cE03fa4ed6A  (W3 Queue)
Settlement.threshold(CashVault)           = 1
Settlement.isOperator(CashVault, deployer)= true
W3 Queue.sm()                             = 0xD94c9C80F07437F0F60f8371b5bF77D53096a314  (真 StateManager)
ProtocolFeeConfig.paymentTokenOf(Stable)  = 0x6F86108A0172ae573D6ebB30D75D6Cb42609fDAa  (新 MockUSDT)
ProtocolFeeConfig.revenuePool()           = 0x4ABC64Ba46D18b5955C94e653967aD7fD866A184
AdapterRegistry.registryOwner()           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
AdapterRegistryFactory.isRegistry(shared) = true
W4 AdapterFactory.isAdapter(cashAdapter)  = true
LPVault.adapter()                         = 0x399B879178ACDbD2aa65ff09C09c55623498cB05
MockUSDT.symbol()/decimals()              = "USDT" / 6
W3 NAVOracle.signerOf(SToken)             = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
Cash/Note/LP Adapter.dataProvider()       = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
LPAdapter.liquidityBridge()               = 0x0000000000000000000000000000000000000000  (刻意未设，见待办)
```

---

## 角色配置状态

### 已配置（全部指向部署钱包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`）

| 角色 | 范围 | 值 |
|---|---|---|
| Governor | HyperAccessControl | 部署钱包 |
| Issuer | AssetRegistry（demo 资产 1、2 的 owner） | 部署钱包 |
| Token Agent | MintBurnController，资产 1 与 2 | 部署钱包 |
| NAV Signer | NAVOracle **W2 `0xbB5BeEeA…`**（脚本设置，对 SToken） | 部署钱包 |
| NAV Signer | NAVOracle **W3 `0x35C9a6B2…`**（阶段四补设，对 SToken） | 部署钱包（**暂时值**） |
| Vault Owner | Cash / Note / LP | 部署钱包 |
| Curator | Cash / Note / LP | 部署钱包 |
| Guardian | Cash / Note / LP | 部署钱包 |
| Allocator | Cash / Note / LP | 部署钱包 |
| Keeper | Cash / Note / LP | 部署钱包 |
| Data Provider | Cash / Note / LP Adapter | 部署钱包 |
| Settlement Operator | Cash / Note / LP，threshold = 1 | 部署钱包（1-of-1） |
| Registry Owner | 共用 AdapterRegistry | 部署钱包 |
| Fee payment token | ProtocolFeeConfig，`Stable`(kind=2) | 新 MockUSDT `0x6F86108A…` |

**全部设成部署钱包是刻意的**：客户的正式角色名单还没给我们，这一步只是让环境单钱包可用。
这些角色都可由 Owner／Governor 随时改，不需重新部署。

### 尚待人工处理（本次未做）

| # | 项目 | 说明 |
|---|---|---|
| 1 | **RWAToken 白名单初始化（本代添加，优先）** | 修复 #2 上线后，`transfer`／`transferFrom` 要求收发双方都在白名单内。目前 SToken／JToken 的白名单是**空的**（`isWhitelisted(deployer) = false`），代表**现在没有任何地址能转这两颗 demo RWA Token**。要做转帐测试前，Issuer 必须先调用 `addToWhitelist(address[])`。mint／burn 不受影响。 |
| 2 | **`subscriptionCapShare`** | 三颗 Vault 都是 `0`（不限额）。开放认购前必办，见文首红框。 |
| 3 | **产品参数 `StateManager.setProductParams`** | 本次完全没设（`Deploy.s.sol` 不碰产品参数）。认购／周期／到期／领取的时间轴都还是 `0`。 |
| 4 | **测试钱包补铸 MockUSDT（阶段五）** | 本次**未运行**。MockUSDT 换地址后 15 个测试钱包 USDT 归零；`offchain/scripts/testnet/addresses.bscTestnet.json` 也**还停在 v5 地址**，需先更新再跑 `fundWallets.ts`。 |
| 5 | **Settlement 3-of-5 多签** | 目前是 1-of-1（threshold = 1、operator 只有部署钱包）。 |
| 6 | **Curator / Guardian / Allocator / Keeper 的正式持有人** | `offchain/scripts/testnet/ROLE_ASSIGNMENT.md` 的分配表尚未套用到这一代合约上。 |
| 7 | **PoRRegistry proof publisher** | 本次没有设置。 |
| 8 | **NAVOracle signer 的正式名单** | W2／W3 两颗目前都指向部署钱包，属暂时值。 |
| 9 | **`lpAdapter.setBridgeTarget(liquidityBridge, cashVault)`** | 依 `DeployW4` 注解，这属于 Curator 的初始参数设置而非部署步骤，脚本与本次都没有调用（现在 `LPAdapter.liquidityBridge()` = `0x0`）。 |
| 10 | **`AssetRegistry.setMetadataURI`** | 函数可用但本次没有写入任何 URI。 |
| 11 | **BscScan 原代码验证** | 本次没有跑 `forge verify-contract`（未设 `ETHERSCAN_API_KEY`）。若要验证 Vault，注意要验的是两颗 implementation，proxy 本身是 EIP-1167 样板。 |

---

## 同步更新的文件

- `docs/deployment-bsctestnet-2026-08-19-v5.md` — 开头加上“已作废／被本文档取代”标注
- `control-panel/config.js` / `control-panel/deployments.json` — 由 `Deploy` 阶段自动重写
- `control-panel/deployments-w3.json` / `deployments-w4.json` — 由对应阶段自动重写
  （`wN` 是**部署阶段**编号，不是世代编号，所以这一代沿用 w3／w4）
- `.env.testnet` — 更新为本代所有地址，并添加 `EARN_VAULT_IMPLEMENTATION`、
  `LP_VAULT_IMPLEMENTATION`、`VAULT_INSOLVENCY_LIB` 与三颗 Timelock 的 key；secrets 未动
- `offchain/scripts/testnet/addresses.bscTestnet.json` — **未更新**（仍是 v5 地址，见待办 #4）

> `control-panel/deployments*.json` 与 `.env.testnet` 都在 `.gitignore` 里（部署产物／secrets），
> 因此不会出现在 commit 里，但本机已同步到本代地址。

`script/Deploy.s.sol` 本次**未改动**；合约原代码、测试、CI 本次皆未改动。
