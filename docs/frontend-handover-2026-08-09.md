# 前端交接文件：ReservePSM 签名修复 + Target Generation 部署到 BSC Testnet

给工作台（`工作台/`）团队参考。涵盖这次的合约修复、新的 testnet 部署地址、以及需要你们接手做的事。

## 1. 合约修复：`ReservePSM.mintWithAuthorization` 的 documentId 签名绑定

`工作台/docs/workspaces-operations.md` 里「Legacy PSM 签名与提交保持禁用」提到的理由——「现有 onchain digest 没有覆盖 documentId 字段」——已经修复。

**修复前**：签名覆盖 `(assetId, amount, to, nonce, expiry, address(this), block.chainid)`，`documentId` 完全没被签进去，调用者可以把同一份签名搭配任意 `documentId` 提交。

**修复后**：签名覆盖 `(assetId, amount, to, nonce, expiry, documentId, address(this), block.chainid)`，`documentId` 是签名的一部分,不是调用者可以自由带入的旁路参数。

**影响你们的地方**：`mintWithAuthorization` 的函数签名（selector、参数顺序）完全没变,只是内部 digest 的组成变了。也就是说：
- ABI 不用重新生成（我们核对过，选择器没变）。
- 但如果你们或签名服务端曾经或打算自己组出这个 digest 来离线签名，必须同步加上 `documentId`,顺序是 `assetId, amount, to, nonce, expiry, documentId, address(this), block.chainid`（`abi.encode`，接 `toEthSignedMessageHash`）。
- 这代表 Legacy PSM 签名这个 Target-only 锁,在你们审查完这个新版逻辑后,理论上可以解锁了（见下方 §4）。

## 2. 新部署：Target generation 已上 BSC Testnet（Chain ID 97）

`main`（merge commit `9e61456`）是完整的 target generation（vault-local RBAC、per-vault Settlement、rwaToken-keyed NAVOracle、RWAAdapter、`ProtocolFeeConfig` 创建费机制等）。下面这组地址就是从这个 commit 部署的，全部合约已通过 `forge test`（含 documentId 回归测试）与本地端到端流程验证。

### 你们 `deployments.js` 要新增的 `target` profile 条目

```js
{
  chainId: 97,
  chainName: 'BNB Smart Chain Testnet',
  explorerUrl: 'https://testnet.bscscan.com',
  profile: 'target',
  sourceCommit: '9e61456', // main, PR #13 merge commit (feat/client-fixes-202608)
  addresses: {
    hyperAccessControl: '0x46788c9fa8ADE3CD8f6bfd57CA49a810c0CC6662',
    stateManager:        '0x99D0fc4EF73baFfED544794D125Ea6972Add5255',
    navOracle:           '0x7C223a0F80D94Fa39bbCec5Fe094eC8C541b1f94',
    mintBurnController:  '0xA4D2E0Ff7bbcf419C8D71956F1cf2a5914749c79',
    assetRegistry:       '0x4e68f984F25Fe976635E642df706E9C8C356BFF2',
    reservePSM:          '0x5B51F5d41739335Aef57A7b0cb91498f74Da1497',
    poRRegistry:         '0x2E2eDAEA7C7819776cF1eebAfC4EF4FF291E1e06',
    queue:               '0xAeF8054734b91105FCEb7307e88D772Bd6488c9C',
    revenuePool:         '0xbe77ac98939438CC6e3Cb01d7A749cc847cFDDfD',
    unifiedPool:         '0x20a7102920A163DA308432E599d71f5e5AFBA7f6',
    settlement:          '0x953B48E4F15C076a83986CB46af50A7a8384c600',
    vaultFactory:        '0x426DaAD15971d77D5f9c33a0f793350B18BEC6bF',
    adapterFactory:      '0x072979e9271458ac851A894e0A3B66462ED8c4ae',
    liquidityBridge:     '0xD340Ea95F151e916BC250d6c1fa247E9D4A19548',
    cashVault:           '0x9213701b8acED7120933304433F1d5A891f00318',
    noteVault:           '0xeCd80F452114226420194747E35120382dD43025',
    lpVault:             '0xfa49cD63aC256D0083df32593C11C7bEb8A815F5',
    cashAdapter:         '0xc70D9Ce321051274f049be112Ee2b8E77C34E8C4',
    noteAdapter:         '0xFe88419b72E8eBadaF3D3be84aD6A5C77e095ccb',
    lpAdapter:           '0xcE3DeD8C7C72B961294Ccb36f7530391139defBE',
  },
}
```

其他部署过程中产生、但不在你们 `HyperTesseraAddresses` 形状里的辅助地址（如果需要）：`adapterRegistry: 0x54E80B8908fC0B518c55A0a3184515E2B42C4572`、`protocolFeeConfig: 0xE503d21D9E667A251d2d85780eca3725BBcc3076`、`usdt (MockUSDT): 0xd2f8cD52993B0154C10A8f402335E5E124cb4eB6`。

`control-panel/abis.json`（=你们 vendored 的 `abis.target.json`）已核对过，`Settlement.confirmFinalSettlement`、`ProtocolFeeConfig` 等这次新增的合约/函数都在里面，应该不需要重新生成。

**新增的 `ProtocolFeeConfig` 机制**：`VaultFactory.deployVault` 和 `AssetRegistry.registerAsset` 现在都会查 `ProtocolFeeConfig.feeOf(...)` 决定要不要收创建费（Governor 可设，默认是 0，我们这次部署没有设定任何费用，所以目前调用都不用带 `msg.value`）。你们审查 Vault Creator / Asset Creator 这类 permissionless 流程时，记得带上这个费用检查逻辑，不然 Governor 之后改了费率,前端会调用失败却不知道为什么。

## 3. 角色/权限分配现况

Owner（三个 Vault 的最高权限）目前仍是部署钱包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`——这次**没有**转移 Owner,只转移了日常操作角色。

已经转给客户 ops 地址 `0x58f7E11AC4a1c9aa735215AF2dc897ac9f926367` 的权限：
- `HyperAccessControl.GOVERNOR_ROLE`（协议全局唯一的全局角色）
- 三个 Vault（Cash/Note/LP）的 Keeper、Curator、Guardian、Allocator
- `Settlement` 合约上三个 Vault 的 Settlement Operator（threshold 目前是 1）

**还留在部署钱包上、尚未转移的**：三个 Adapter（Cash/Note/LP，地址见 §2）的 Data Provider,目前还是 `0x425beB70...`。因为三个 Vault 都还在 `CONFIGURING` 状态,`setDataProvider` 在这个状态下只认 Curator 本人直接调用（没有 Owner/Timelock 后备路径）,而 Curator 现在是 ops 地址——所以这一步只能由 ops 地址自己调用 `IAdapter(cashAdapter/noteAdapter/lpAdapter).setDataProvider(<你们要指定的 data provider 地址>)` 来完成,我们这边已经没有权限代做了。

**这是 testnet 功能验证用的部署**，还没有把 Settlement Operator 拆成多把独立密钥做 M-of-N（threshold=1，单一 ops 地址即可通过）。要不要在正式使用前拆成多签,由你们决定。

## 4. 需要你们做的事

1. 把上面 §2 的 `target` profile 条目加进 `deployments.js`。
2. 走一次你们文件 `工作台/docs/workspaces-operations.md` §"更新部署地址与上游 provenance" 的审查流程,把这组地址、ABI、签名域对照部署 bytecode 复核一遍。
3. 复核完成后,以下三个 Target-only 锁可以考虑解锁（合约面已经没有阻碍,只差你们的审查/测试）：
   - **Vault Creator**：`VaultFactory.deployVault` 在这个 generation 已经是 permissionless（合约注释明写）。
   - **Wrapper Creator**：`ReservePSM.deployWrappedToken` 同样已经是 permissionless。
   - **Legacy PSM 签名**：本文件 §1 的 documentId 修复已经解决你们文件里记载的阻挡原因。
4. 用 ops 地址调用三个 Adapter 的 `setDataProvider`,指定你们实际要用的 data provider 签名地址（见 §3）。
5. 如果需要更严谨的 Settlement 多签,用 ops 地址调用 `Settlement.setOperator`/`setThreshold` 增加额外的 operator 并调高 threshold。

## 5. 全新测试用户零到一：完整闭环流程（发行资产 → Settlement）

这一节回答「一个全新测试用户从零开始，在网页端走完发行资产 → 创建 Vault → 配置角色/产品/模块/Timelock/Data Provider → 申购与 Allowance → 生命周期与 Settlement」这个完整闭环需要哪些步骤、每一步该调哪个方法。

**重要前提**：Target generation 的 `VaultFactory.deployVault` 和 `AssetRegistry.registerAsset` 都是 **permissionless**——任何地址都能自己发资产、自己建 Vault，成为该资产/Vault 的 Owner。所以「全新测试用户」不需要、也不应该用 §2 那三个已经把角色转给 ops 地址的 Cash/Note/LP Vault，而是应该自己走一遍下面全部流程,建出一个全新的第四个 Vault。

### Phase 1 — 发行资产

`AssetRegistry.registerAsset(bytes32 metadataHash, string name, string symbol, uint8 decimals, FeePaymentKind feeKind) → (uint256 assetId, address token)`

- 权限：permissionless，`msg.sender` 成为该资产的 owner。
- 会在同一笔交易内部署专属的 `RWAToken` 并注册进 `MintBurnController`。
- 会走 `ProtocolFeeConfig.feeOf(RegisterAsset, feeKind)` 创建费检查（目前费率 0，见 §2）；`feeKind = Native` 要求 `msg.value` 精确等于费用,`feeKind = Erc20` 会 `safeTransferFrom` 扣费代币。
- ✅ 有 SDK 封装：`sdk.registerAsset(metadataHash, name, symbol, decimals, feeKind, signer, { value })`，返回 `{ assetId, token }`（已从 `AssetRegistered` 事件解析）。

### Phase 2 — 创建 Vault

`VaultFactory.deployVault(VaultParams params) payable → address vault`

```solidity
struct VaultParams {
  VaultType vaultType;       // 只有 EARN / LP 两种；Cash vs Note 都是 EARN，靠 liquidityBridge 是否为 0 地址区分
  string name;
  string symbol;
  address usdt;
  address stateManager;
  address settlement;        // 部署时传 address(0)，后续再补
  address queue;
  address owner;              // address(0) 则 msg.sender 自动成为 Owner
  address adapterRegistry;    // 绑定后不可再换
  address liquidityBridge;    // Note 型 EarnVault 传 address(0)
  address cashVault;          // 只有 LP 型需要
  FeePaymentKind feeKind;
  ProductState initialProduct; // 正常传 CONFIGURING
  CycleState initialCycle;     // 正常传 ACCEPTING
}
```

- 权限：permissionless，调用者（或 `params.owner`）成为新 Vault 的 Owner。同样走 `ProtocolFeeConfig.feeOf(DeployVault, ...)` 创建费检查。
- 同一笔交易内会：① 部署该 Vault 专属的 `VaultTimelock` 并调用 `bindGovernance(timelock, adapterRegistry)`（一次性、不可重绑）；② 调 `StateManager.registerVault(vault, initialProduct, initialCycle)` 把 Vault 注册进状态机。
- **拿到新 Vault 地址的方式**：解析回执里的 `VaultDeployed(vaultType, vault, owner, timelock, name, symbol, timestamp)` 事件，没有单独的 getter。
- ✅ 有 SDK 封装：`sdk.deployVault(params, signer, { value })`，返回新 Vault 地址（已从 `VaultDeployed` 事件解析,不用自己 parse）。

### Phase 3 — 角色配置

角色是 **Vault 内部（per-vault）** 的，不是全局角色。`deployVault` 之后除了 Owner 以外全部是空的——**没有「Owner 兼任 Keeper」这种默认继承**，必须逐一显式设置：

```solidity
function transferOwnership(address newOwner) external   // Owner-only
function setCurator(address account) external            // Owner-only
function setGuardian(address account) external            // Owner-only
function setAllocator(address account) external           // Owner-only
function setKeeper(address account, bool approved) external // Owner-only，可设多个 Keeper
```

以上都是 **Owner 直接调用，不经过 Timelock**（不受 Phase 6 的 CONFIGURING 限制影响）。

Settlement Operator 不设在 Vault 上，而是设在 `Settlement` 合约：
- `sdk.setSettlementOperator(vault, operator, approved, signer)` — 需为该 Vault 的 Owner。✅ 有 SDK 封装（`sdk.ts:346`）。
- `sdk.setSettlementThreshold(vault, newThreshold, signer)` — 同上。✅ 有 SDK 封装（`sdk.ts:352`）。

✅ 都有 SDK 封装：`sdk.setCurator(vault, account, signer)`、`sdk.setGuardian(vault, account, signer)`、`sdk.setAllocator(vault, account, signer)`、`sdk.setKeeper(vault, account, approved, signer)`、`sdk.transferVaultOwnership(vault, newOwner, signer)`。

角色作用速查：Keeper 推进 Phase 9 生命周期状态机；Curator 设产品参数、挂 Adapter、设 Data Provider；Guardian 可暂停 Vault、冻结 Allocator、否决待执行的 Timelock 变更；Allocator 在 Adapter 上执行买卖/再平衡指令。

### Phase 4 — 产品参数配置

`StateManager.setProductParams(address vault, ProductParams params) external`

```solidity
struct ProductParams {
  uint256 subscriptionStart;
  uint256 subscriptionEnd;
  uint256 walletSubscriptionCap;  // 单钱包上限；0 = 不设上限
  uint256 minRaiseAmount;
  uint256 subscriptionCapShare;   // 金库募集上限（份额单位，18 位小数）；0 = 不设上限
  uint256 cycleDuration;          // 秒
  uint256 maturityTimestamp;
  uint256 claimingStart;
  uint256 claimingEnd;            // closeProduct() 门槛
  uint256 feeParams;
}
```

> **2026-08-24 变更（不兼容）**：`firstCycleStart` 已删除（它从未真正控制 Cycle 0 的起点），
> 其位置由 `subscriptionCapShare` 顶替。`setProductParams` 与 `getParams` 的 ABI 数据结构
> 因此改变，前端与链下系统必须同步更新。金库募集上限现在随产品参数一次性提交，由
> StateManager 写入 Vault；展示当前上限时请读取 Vault 的 `subscriptionCapShare()`，而不是
> 首次提交的产品参数——后续经 Timelock 修改的值只反映在 Vault 上。

- 权限：该 Vault 的 **Curator only**，且必须在 `ProductState.CONFIGURING` 阶段调用——过了这个阶段这条路径就设不了了。
- ✅ 有 SDK 封装：`sdk.setProductParams(vault, params, signer)`。

### Phase 5 — 模块（Adapter）配置

三步：部署 Adapter → 加入该 Vault 专属的 `AdapterRegistry` 白名单 → 挂到 Vault 上。

1. **部署**（`AdapterFactory`，均 permissionless，均 ✅ 有 SDK 封装）：
   - `deployAdapter(AdapterParams)` — Cash/Note 型 → `sdk.deployAdapter(params, signer)`
   - `deployLiquidityAdapter(AdapterParams)` — LP 型 → `sdk.deployLiquidityAdapter(params, signer)`
   - `deployRWAAdapter(RWAAdapterParams)` → `sdk.deployRWAAdapter(params, signer)`
2. **白名单**：`AdapterRegistry.setAdapterAllowed(adapter, allowed)` — 权限是该 registry 的 owner（一般是部署时指定的地址，未必是 Vault 自己的 Owner）。✅ `sdk.setAdapterAllowed(registry, adapter, allowed, signer)`。
3. **挂载到 Vault**：
   - Cash/Note：`BaseVault.addAdapter(adapter)` → ✅ `sdk.addAdapter(vault, adapter, signer)`
   - LP：`LiquidityEarnVault.setAdapter(adapter)`（一次性,重复调用会 revert）→ ✅ `sdk.setLPAdapter(vault, adapter, signer)`
   - 权限：`CONFIGURING` 阶段 Curator 直接调用；离开 CONFIGURING 后只能走 Timelock。且要求 Adapter 已在 ①② 完成白名单，且 `IAdapter(adapter).vault() == 该 Vault`。
   - LP 型额外需要 Curator 调 `LiquidityAdapter.setBridgeTarget(liquidityBridge, cashVault)` 才算配置完整 → ✅ `sdk.setBridgeTarget(adapter, liquidityBridge, cashVault, signer)`。

### Phase 6 — Timelock

`VaultFactory.deployVault` 时已经自动部署并 `bindGovernance` 绑定，**不需要额外初始化步骤**。

- 作用：Vault 离开 `CONFIGURING` 之后，Owner 类/Curator 类的参数变更（`setSettlement`、`setGate`、`addAdapter`、`setPerformanceFeeBps` 等）不能再直接调用，必须走 `scheduleParamChange(target, data)` → 等 delay（默认 48 小时，1 小时～30 天区间可调）→ `executeParamChange(changeId)`（permissionless，任何人可执行）。`cancelParamChange` 可由 Owner/Guardian/原提案人调用。
- **CONFIGURING 阶段** 这些同样的函数可以由 Owner/Curator **直接调用**——这也是为什么 Phase 3-5 都建议在开放申购之前做完。
- 如果 Phase 5 里挂载的是自定义 Adapter 的方法（比如某个 Adapter 专属的 setter），需要 Owner 在还处于 CONFIGURING 时额外调用 `setAllowedAction(target, selector, class, true)` 把它加进白名单，不然离开 CONFIGURING 后这个函数会永远排不上 Timelock 队列。
- ✅ Timelock 全部方法都有 SDK 封装：`sdk.vaultTimelockAddress(vault)`（读该 Vault 的 Timelock 地址）、`sdk.scheduleParamChange(timelock, target, data, signer)`（返回值已从 `ParamChangeScheduled` 事件解析出 `changeId`）、`sdk.executeParamChange(timelock, changeId, signer)`、`sdk.cancelParamChange(timelock, changeId, signer)`、`sdk.setAllowedAction(timelock, target, selector, actionClass, allowed, signer)`。

### Phase 7 — Data Provider 配置

`IAdapter(adapter).setDataProvider(address provider) external`

- Data Provider 是 **per-Adapter** 的（不是全局角色）。
- 权限：`CONFIGURING` 阶段该 Adapter 所属 Vault 的 **Curator 直接调用**；离开 CONFIGURING 后只能走 Timelock，且这个函数**默认不在** `VaultTimelock` 构造时预置的白名单里，必须在 Phase 6 里额外 `setAllowedAction` 才能在后续走 Timelock 改。
- `setStalenessWindow(uint256)` 走同样的权限模式。
- ✅ 都有 SDK 封装：`sdk.setDataProvider(adapter, provider, signer)`、`sdk.setAdapterStalenessWindow(adapter, window, signer)`。

### Phase 8 — 申购与 Allowance

ERC20 前置步骤 — ✅ 已在 `offchain/src/web3.ts` 里封装：
```ts
await ensureAllowance(usdtAddress, vaultAddress, amount, signer); // spender 必须是 Vault 合约本身，不是 VaultFactory 或其他地址
```
`ensureAllowance` 会先查当前 allowance，够用就什么都不做（返回 `null`），不够才发 `approve`。也可以单独用 `getAllowance`/`getBalance` 查询。

申购/赎回本体（`BaseVault`，ERC-7540 风格，均为自助式：可以是 `owner` 本人，或经 `setOperator(operator, approved)` 授权的 operator 代为发起；受 `ProductState`/`CycleState` 门槛限制，不需要额外角色）：

| 方法 | SDK 封装 |
|---|---|
| `requestDeposit(assets, owner)` | ✅ `sdk.requestDeposit(tranche, assets, owner, signer)`（`sdk.ts:490`，返回值已从 `DepositRequested` 事件解析出 `requestId`） |
| `claimDeposit(requestId, receiver)` | ✅ `sdk.claimDeposit(tranche, requestId, receiver, signer)`（`sdk.ts:496`） |
| `requestRedeem(shares, owner)` | ✅ `sdk.requestRedeem(tranche, shares, owner, signer)`（`sdk.ts:501`） |
| `claimRedeem(requestId, receiver)` | ✅ `sdk.claimRedeem(tranche, requestId, receiver, signer)`（`sdk.ts:507`） |
| `cancelRequest(requestId)` | ✅ `sdk.cancelRequest(tranche, requestId, signer)`（`sdk.ts:512`） |
| `claimRefund(requestId)` | ✅ `sdk.claimRefund(tranche, requestId, signer)`（`sdk.ts:517`） |
| `setOperator(operator, approved)` / `isOperator(...)` | ✅ `sdk.setVaultOperator(vault, operator, approved, signer)` / `sdk.isVaultOperator(vault, owner, operator)` |

`requestDeposit` 要求 Vault 处于 `SUBSCRIBING`，或 `OPERATING` 且当前 cycle 是 `ACCEPTING`（即 Phase 9 的 Keeper 已经推进过状态机）；`requestRedeem` 要求 `OPERATING`。

### Phase 9 — 生命周期与 Settlement

状态机（`ProductState`）：`CONFIGURING → SUBSCRIBING → (FUNDING_FAILED | OPERATING) → SETTLING → MATURING → CLAIMING → CLOSED`；每个 OPERATING 周期内还有子状态 `CycleState`：`ACCEPTING → CALCULATING → FULFILLING → COMPLETED → ACCEPTING`。

驱动状态机的方法全部在 `StateManager`，全部是**该 Vault 的 Keeper only**，且各自还有时间门槛：

| 转移 | 合约方法 | 门槛 | SDK 封装 |
|---|---|---|---|
| CONFIGURING→SUBSCRIBING | `openSubscription(vault)` | `now ≥ subscriptionStart` | ✅ `sdk.openSubscription(vault, signer)` |
| SUBSCRIBING→OPERATING/FUNDING_FAILED | `finalizeSubscription(vault)` | `now ≥ subscriptionEnd`；募够 `minRaiseAmount` 才进 OPERATING | ✅ `sdk.finalizeSubscription(vault, signer)` |
| ACCEPTING→CALCULATING | `startCycleCalculation(vault)` | `now ≥ cycleStart + cycleDuration`，**或** `now ≥ maturityTimestamp`（后者启动最终周期） | ✅ `sdk.startCycleCalculation(vault, signer)` |
| OPERATING→SETTLING | 无独立转换 | 最终周期的 `completeCycle` 在同一笔交易内完成 | 无（`enterFinalSettlement` 已于 2026-08-24 删除） |
| SETTLING→MATURING | `enterMaturing(vault)` | 需要 `Settlement.confirmFinalSettlement` 先跑完 | ✅ `sdk.enterMaturing(vault, signer)` |
| MATURING→CLAIMING | `enterClaiming(vault)` | `now ≥ claimingStart` | ✅ `sdk.enterClaiming(vault, signer)` |
| CLAIMING→CLOSED | `closeProduct(vault)` | `now ≥ claimingEnd` | ✅ `sdk.closeProduct(vault, signer)` |
| CALCULATING→…→ACCEPTING（周期内） | `completeCycle(vault)` | 只能由该 Vault 绑定的 `Settlement` 合约调用 | 无（`Settlement` 内部调用，不对外暴露） |

批量结算（Settlement 合约，**permissionless 中继**，安全性来自 M-of-N Operator 签名而非 `msg.sender` 权限）：
- `Settlement.submitBatch(instruction, signatures)` — ✅ `sdk.submitBatch(...)`
- `Settlement.confirmFinalSettlement(vault, signatures)` — ✅ `sdk.confirmFinalSettlement(...)`，会解锁 SETTLING→MATURING

配套读取方法（均有 SDK 封装）：`sdk.hashInstruction`、`sdk.hashFinalSettlementConfirmation`、`sdk.isFinalSettlementComplete`、`sdk.isOperator`、`sdk.threshold`、`sdk.isExecuted`。

**离线工具类**：
- `offchain/src/keeperBot.ts` 的 `KeeperBot` — 轮询并根据当前 `product` 状态自动调用对应的 `sdk.*` 转移方法，未到时间门槛的 revert 会被吞掉；SETTLING 阶段若结算未确认会触发 `final-settlement-pending` alert。前端如果要模拟/测试 Keeper 行为，可以直接跑这个类，不需要重新实现状态机推进逻辑。
- `offchain/src/settlementOperator.ts` 的 `SettlementOperator` — 组装 `SettlementInstruction`、收集 M-of-N 签名、调用 `submitBatch`/`confirmFinalSettlement` 的完整流程封装。

**完整参考脚本**：`offchain/scripts/local/testSettlementTail.ts`（本地 anvil,覆盖 Phase 4 之后到 CLOSED 的完整流程，用的就是真实 SDK/KeeperBot/SettlementOperator 类）。目前**没有**一个脚本覆盖 Phase 1-3（发行资产、建 Vault、配角色）这段——这几步目前只在 `script/Deploy.s.sol` 里以 Solidity 部署脚本的形式跑过，还没有对应的 TS/SDK 层复现,如果需要一份端到端 TS demo，我们可以另外补一版。

### 小结：权限 / 门槛速查表

| 步骤 | 权限门槛 |
|---|---|
| `AssetRegistry.registerAsset` | permissionless（仅创建费） |
| `VaultFactory.deployVault` | permissionless（仅创建费） |
| Vault 角色 setter（Curator/Guardian/Allocator/Keeper/Owner） | Owner only，直调，永不经 Timelock |
| `StateManager.setProductParams` | Curator only，仅 CONFIGURING |
| Adapter 部署（`AdapterFactory.*`） | permissionless |
| `AdapterRegistry.setAdapterAllowed` | registry owner only |
| `addAdapter`/`setAdapter` | Curator 直调（CONFIGURING）/ Timelock only（之后） |
| `setDataProvider`/`setStalenessWindow` | Curator 直调（CONFIGURING）/ Timelock only（之后） |
| `VaultTimelock.scheduleParamChange` | Owner 或 Curator，且该动作已列入白名单 |
| `VaultTimelock.executeParamChange` | 时间窗口打开后 permissionless |
| 申购/赎回四件套 | 自助式（owner/operator），受状态门槛限制 |
| 状态机转移（`openSubscription` 等七个） | 该 Vault Keeper only，另有时间门槛 |
| `completeCycle`/`completeFinalSettlement` | 仅该 Vault 绑定的 `Settlement` 合约可调 |
| `submitBatch`/`confirmFinalSettlement` | permissionless 中继，靠 M-of-N 签名把关 |
| `Settlement.setOperator`/`setThreshold` | Vault Owner only |
| `StateManager.pause` / `unpause` | Guardian only / Owner only |

## 6. 回应客户反馈（`HyperTessera_四大业务流程完整版`）：地址确认 + 补齐接口 + 统一浏览器端 SDK

客户那份 61 页的流程文档提了三件事：① 确认 BNB Testnet 最新合约地址/ABI；② 补齐文档里网页部署要用到、SDK 还缺的接口；③ 提供一个封装钱包连接/网络切换/权限识别/合约调用/签名/Allowance/交易状态/事件解析/错误处理的统一前端 Web3 SDK。三件事都已经在 `offchain/` 里做完。

### 6.1 地址/ABI 确认结果

- 用公开 BSC Testnet RPC（`cast code`）逐一查询了 §2 那 20 个 target generation 地址,全部有 bytecode,`unifiedPool` 的 bytecode 偏短是预期行为（它是 `ERC1967Proxy`,不是问题）。
- 重新跑了一遍 `control-panel/build-abis.sh`（`forge build` + 从 `out/` 重新生成）,跟仓库里现有的 `control-panel/abis.json` 做了逐字节 diff,**完全没有 drift**——ABI 是最新的。
- 文档里提到但之前 SDK 没封装的合约方法（`RWAToken.addToAddressList`、`ReservePSM.setAuthorizedSigner`、`Adapter.createBuyOrder` 等 29 个）,逐一 grep 确认合约里都已经实现,不存在文档写了但合约没做的情况。

结论：§2 那组地址和 ABI 可以直接用,不需要重新部署或重新生成 ABI。

### 6.2 补齐的 SDK 接口

`offchain/src/sdk.ts` 新增了一批方法,覆盖文档里各个流程要用到、之前没有 SDK 封装的合约调用：

- **资产后续管理**：`updateMetadataHash`、`transferAssetOwnership`、`deactivateAsset`
- **RWAToken 合规**：`setTransferPaths`、`addToAddressList`、`removeFromAddressList`、`isInList`、`getTransferPath`
- **PoRRegistry**：`setProofPublisher`、`publishReserveProof`、`getProof`、`getLatestProof`、`getProofCount`
- **NAVOracle 管理**：`setNAVSigner`、`removeNAVSigner`、`transferNAVOracleOwnership`、`setNAVDeviationMaxBps`、`navSignerOf`、`navDeviationMaxBps`
- **ReservePSM 管理**：`setPSMAuthorizedSigner`、`pauseReservePSM`/`unpauseReservePSM`（全局）、`pauseAsset`/`unpauseAsset`（单资产）、`wrapperControllerOf`
- **ProtocolFeeConfig**（新增只读封装,前端算注册费/建 Vault 费要用）：`creationFeeOf`、`paymentTokenOf`、`feeRevenuePool`
- **Vault 暂停**：`pauseVault`、`unpauseVault`
- **Adapter 订单簿**：`createBuyOrder`/`createSellOrder`/`createRebalanceOrder`（自动解析事件拿 `orderId`）、`cancelBuyOrder`/`cancelSellOrder`/`cancelRebalanceOrder`、`executeBuy`/`executeSell`/`executeRebalance`、`freezeAllocator`/`unfreezeAllocator`、`realAssets`、`updateDealData`、`clearDealValue`
- **募集失败退款**：`markRefundable`

用法跟之前补的那批一样,都是 `sdk.xxx(..., signer)` 的形式,写操作返回 receipt,有事件要解析的（订单类）自动帮你 parse 出 id。单元测试见 `offchain/test/sdk.unit.test.ts`。

### 6.3 统一浏览器端 Web3 SDK

**背景**：翻了一下你们仓库（`yyyypong/HyperTessear_web`）,发现工作台那边已经手动 vendor 了一份 `offchain/src/sdk.ts`/`types.ts`/`abis.ts` 到 `src/integrations/hypertessera/upstream/`,而且专门改写了 `abis.ts`（原本读本地文件的 Node 版本在 Vite 里打包不了,得改成 `import abisJson from "./abis.json"` 才行）,还配了一套手动 commit-pin 同步流程。这是可以从根上解决的——原因是 `sdk.ts` 顶层依赖的 `abis.ts` 用了 `node:fs`/`node:url`/`node:path`,浏览器打包器处理不了。

**改动**：把 ABI 加载拆成三层：

- `offchain/src/abis-registry.ts` —— 纯内存注册表（`getAbi`/`setAbis`/`abisLoaded`）,不依赖任何 Node API,浏览器打包安全。
- `offchain/src/abis-node.ts` —— Node 专用,读 `control-panel/abis.json` 落盘文件,`import` 它就会自动把 ABI 注册进去。
- `offchain/src/abis.ts` —— 对外的入口,重新导出 registry 的全部方法,并且在**检测到确实跑在 Node 里**（`process.versions.node` 存在）时自动 `import` 一次 `abis-node.ts`。检测不到（也就是浏览器环境）就什么都不做,只等你调用 `setAbis(...)`。

结果：`offchain/src/sdk.ts` 本身、以及所有 Node 端现有代码（脚本、测试、KeeperBot）**零改动**继续零配置可用；浏览器端只需要在用 SDK 之前调一次：

```ts
import { setAbis } from "@hypertessera/offchain"; // 或直接 import "offchain/src/abis.js" 里的 setAbis
import abisJson from "./abis.json"; // Vite/webpack 原生支持 JSON import,不需要你们再手写适配层
setAbis(abisJson);
```

之后就可以直接 `import { HyperTesseraSDK } from "@hypertessera/offchain"` 用真实包,**不再需要手动 vendor/同步 sdk.ts 副本**——你们 `docs/workspaces-operations.md` 里那套「更新部署地址与上游 provenance」的手动同步流程,ABI/SDK 这部分以后可以省掉,只需要跟 `deployments.js` 的地址部分保持同步。

**新增 `offchain/src/web3.ts`**,在 `HyperTesseraSDK` 之上补了文档要求的那几块能力（都是纯函数/小工具,不绑定 React,你们现有的 `WalletProvider`/`walletRunner.js` 可以直接换成调这些,或者继续包一层 hook）：

| 能力 | 导出的函数 |
|---|---|
| 钱包连接（EIP-6963,带 legacy `window.ethereum` fallback） | `discoverWallets`、`onWalletAnnounced`、`connectWallet`、`getConnectedAccounts`、`onAccountsChanged`、`onChainChanged` |
| 网络切换 | `switchNetwork`（比你们现在的 `requestChain` 多了一层：如果钱包里没有这条链（错误码 4902）,会自动 fallback 到 `wallet_addEthereumChain` 再重试,附带一个现成的 `BNB_TESTNET` 参数常量） |
| 签名/写入 | `createBrowserProvider`、`getWriteSigner`（跟你们 `walletRunner.js` 逻辑一致） |
| 权限识别 | `getVaultPermissions`（一次读出 owner/curator/guardian/allocator/isKeeper 并跟传入账户比对）、`getSettlementPermissions`、`isGovernor` |
| Allowance | `getAllowance`、`getBalance`、`ensureAllowance`（查询当前额度,不够才发 `approve`,够了直接返回 `null`,不用你们自己写「先查再判断要不要 approve」这段逻辑) |
| 交易状态 | `trackTransaction`——包一个 `TransactionResponse`,通过 `onStatus` 回调依次报告 `submitted -> pending -> confirmed/failed` |
| 事件解析 | `parseEventLogs`（从 receipt 里解出某个合约认识的全部事件）、`subscribeToEvent`（订阅/取消订阅） |
| 错误处理 | `decodeError`——把合约 revert 解成 `{name, args, message}`,常见错误（`NotOwner`/`NotCurator`/`Unauthorized`/`InsufficientAllowance` 等）自带一份人话文案,你们可以在这基础上扩充翻译表 |

单元测试见 `offchain/test/web3.unit.test.ts`（用 `happy-dom` 跑 DOM 相关部分,新增的唯一一个 devDependency）。

**范围之外**：不包含你们「Capability Adapter」（`legacy`/`target` 双 profile、`sdk/target` 桩层）那套设计,那是你们前端产品层面的架构决策,不是 SDK 该管的事——上面这些新方法/新模块只是补齐 SDK 本身的能力,你们的 adapter 层可以直接在这些方法上面接,不用改设计。
