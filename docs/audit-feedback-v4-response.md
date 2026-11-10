# Audit Feedback V4 实现说明（2026-09-01）

对应文档：《HyperTessera Audit Feedback V4(中)》（2026-08-31，5 项）。

| # | 问题 | 等级 | 合约 | 处理 |
|---|---|---|---|---|
| 1 | Adapter 的 ERC-4626 份额可被任意人铸造/赎回 | High | `BaseAdapter.sol` | 按建议修复 |
| 2 | 恶意金库仍可绕过 V2-3 的同步铸造限制 | High | `LiquidityBridge.sol` | 按建议修复 |
| 3 | `executeBuy` 可动用托管中的对手方货款 | Medium | `BaseAdapter.sol` | 按建议修复 |
| 4 | `clearDealValue` / `updateDealData` 不检查预留 | — | `BaseAdapter.sol` | 按建议修复（两个场景分别处理） |
| 5 | 清算后 PENDING 存款永久无法取消 | — | `BaseVault.sol` | 主建议采纳；附带建议不采纳，理由见第五部分 |

验证结果：`forge test` **1027 项全部通过**（本轮新增 15 项）。每一项修复都做了变异验证：
把修复回退后，对应的新增测试必然失败，详见第六部分。

> **这是不兼容的变更。** `LiquidityBridge` 构造函数新增一个参数并新增一个存储映射，
> `BaseAdapter` 的四个 ERC-4626 入口改为仅金库可调用。现有已部署合约不会自动获得这些修改，
> 需重新部署；部署脚本、前端、Indexer、结算脚本必须同版本升级。
> 新增部署步骤：`LiquidityBridge.setBridgeWhitelisted()` 必须由 Governor 为桥两端的
> Vault 各调用一次，否则 `bridgeDeposit` 全部回滚。

---

## 一、问题 1 —— Adapter 的 ERC-4626 入口收归金库专用

### 1.1 修复

`BaseAdapter` 的 `deposit` / `mint` / `withdraw` / `redeem` 四个入口全部 override，
统一加 `_onlyVault()` 前置：

```solidity
function _onlyVault() internal view {
    if (msg.sender != vault) revert NotVault();
}
```

新增错误 `IAdapter.NotVault()`。

### 1.2 为什么四个入口都要关

份额层面是金库注入资本的通道，不是对外产品。四个入口只关一部分没有意义：

- **净值操纵**：份额按 `realAssets()` 定价，外部人可以在 deal 被上调估值之前铸造、
  之后赎回，把属于金库自身存款人的价值取走。
- **冻结清仓**：`BaseVault.removeAdapter` 要求 `realAssets() == 0`。外部人只要不主动赎回，
  哪怕只留一份灰尘级份额，金库就永远无法清仓。在每个 Adapter 各存一笔，即可永久冻结
  整个金库的退出能力。

第二点比第一点更严重，因为它不需要任何时机配合，一次性投入即可造成不可逆后果。

### 1.3 覆盖范围

三个具体 Adapter（`FirstPeriodAdapter`、`LiquidityAdapter`、`RWAAdapter`）均未 override
这四个入口，全部继承 `BaseAdapter` 的受限版本，无遗漏路径。

### 1.4 不影响金库自身

金库自己的注资与撤资路径完全不变，`test_erc4626_entryPoints_stillOpenToTheVault`
专门验证这一点：金库仍可 `deposit` 注资、`redeem` 撤资，撤资后 `realAssets()` 归零，
清仓路径重新可达。

---

## 二、问题 2 —— LiquidityBridge 改用 Governor 白名单

### 2.1 修复

`LiquidityBridge` 新增一个映射与一个 GOVERNOR_ROLE 入口，构造函数新增
`accessControl_` 参数：

```solidity
mapping(address vault => bool) public bridgeWhitelisted;

function setBridgeWhitelisted(address vault, bool allowed) external; // GOVERNOR_ROLE
```

事件：`BridgeWhitelistUpdated`。错误：`VaultNotWhitelisted(address)`、`NotGovernor()`。

`bridgeDeposit` 中桥的两端都要检查：

```solidity
if (!bridgeWhitelisted[fromVault]) revert VaultNotWhitelisted(fromVault);
if (!bridgeWhitelisted[toVault])   revert VaultNotWhitelisted(toVault);
```

### 2.2 为什么原有的 registeredVaults 校验不够

贵方的判断正确。V2-3 加的 `sm.registeredVaults()` 双重校验，前提是
`registeredVaults` 内均为可信金库，而这个前提在 V3 之后不成立：按 V3 第 1/2 项的结论，
`deployVault` 保持无权限开放，任何人创建的 Vault 都会被登记。

因此登记只说明“这个地址是官方 VaultFactory 造出来的”，不构成任何信任表述。
攻击者用自己的 Vault 作 `fromVault`，可以轻易通过自调用检查，直达
`IEarnVault(toVault).deposit`，在真实金库内同步铸造份额，完全绕过 `requestDeposit`
异步流程。

### 2.3 两端都要白名单，而不是只管来源

- **来源端**：`bridgeDeposit` 的调用权限是从 `fromVault` 自身读出来的
  （`msg.sender == fromVault` 或 `IVaultRoles(fromVault).allocator()`），
  攻击者控制的合约可以随意回答，所以来源必须由治理指定。
- **目标端**：接受同步铸造是目标 Vault 自身设计的属性，不应由任何一个已登记的来源
  单方面强加。

### 2.4 与既有校验的关系

`registeredVaults` 检查保留在白名单检查之前，作为同一不变量更便宜、更窄的表述，
两者并存。语义分层与 V3 在 `UnifiedPool` 上的处理一致：登记表示“用了标准合约”，
白名单表示“协议允许它做这件事”。

### 2.5 部署影响

`script/Deploy.s.sol` 已同步更新：构造 `LiquidityBridge` 时传入 `accessControl`，
并在部署收尾处为实际发生桥接的 LP → Cash 两端各调用一次
`setBridgeWhitelisted`。**重新部署时必须执行这一步，否则桥全线不可用。**

---

## 三、问题 3 —— `_deployCapital` 以自由余额为上限

### 3.1 修复

按建议在 `_deployCapital` 内以 `balanceOf(this) - lockedProceeds` 为上限：

```solidity
function _deployCapital(uint256 amount, address destination) internal {
    uint256 balance = IERC20(asset()).balanceOf(address(this));
    uint256 locked = lockedProceeds;
    uint256 free = balance > locked ? balance - locked : 0;
    if (amount > free) revert ProceedsLocked(amount, free);
    ...
}
```

复用既有错误 `ProceedsLocked(requested, free)`，与 `_withdraw` 中同一约束的报错保持一致。

### 3.2 影响范围

`_deployCapital` 全协议只有一个调用者，即 `executeBuy`（`BaseAdapter.sol:430`），
因此该上限只作用于审计指出的路径，不影响其他资金流。

### 3.3 说明

托管中的货款对投放的限制，与它对 `_withdraw` 的限制完全相同。Sell Order 处于 FUNDED 期间，
Adapter 同时持有待售头寸与买家货款；把这笔钱投出去既构成双计，也违背“先付款后交货”的
托管承诺——对手方正是基于这个承诺才付的款。

上限是**自由余额，不是全部余额**：自由资本照常投放，只有超出部分被拒。
`test_executeBuy_ceilingIsFreeBalanceNotWholeBalance` 验证这一点——
自由额 400e6 之上多一个单位即回滚，恰好 400e6 正常通过，托管的 1_000e6 分文未动。

---

## 四、问题 4 —— 两个场景分别处理

完全按贵方建议的分情形处理执行。

### 4.1 `clearDealValue` 场景：`executeSell` 改为饱和扣减

```solidity
uint256 applied = d.dealValue < o.dealValueReduction ? d.dealValue : o.dealValueReduction;
uint256 newValue = d.dealValue - applied;
```

账目退场是既成事实：`clearDealValue` 之后头寸已改由代币余额计价，这里本就没有东西可冲销。
若保留检查性减法，会在此下溢回滚，让一笔对手方**已经付款**的卖单除了等待过期退款之外
无路可走。

`DealValueReducedBySell` 事件改为记录实际冲销的 `applied` 而非声明值，
使链下账目与链上实际扣减一致。

### 4.2 `updateDealData` 场景：在源头加守卫

```solidity
uint256 reserved = reservedDealValue[orderId];
if (newValue < reserved) revert DealValueBelowReserved(orderId, newValue, reserved);
```

新增错误 `IAdapter.DealValueBelowReserved(dealKey, newValue, reserved)`。

一张存活的卖单已经按某个价格向对手方作出了冲销 `reserved` 的承诺。在其之下重估，
要么让该单搁浅（无可冲销），要么更糟——让它按旧价成交、把减值差额转嫁给金库。
所以 Data Provider 必须先撤单再重估。

守卫是可解除的：撤单或退款会经 `_releaseSellReservations` 释放预留，
`reservedDealValue` 归零后即可任意重估。`test_updateDealData_cannotRevalueBelowAReservedSellOrder`
覆盖了完整闭环：低于预留回滚 → 等于预留通过 → 向上重估通过 → 撤单后释放 → 可任意重估。

---

## 五、问题 5 —— 存款分支加清算豁免；附带建议不采纳

### 5.1 采纳的部分

主建议按原文执行，存款分支与赎回分支对称：

```solidity
if (!insolvencyLiquidated) _requireCancellable(requestId);
_unwindPendingDeposit(requestId, dep);
```

问题描述与我们的复核完全一致，此处不再复述。补充一点：矛盾的核心在于
`writeDownInsolvency` 执行前专门校验 `cash >= pendingDepositLiability + refundableLiability`
并据此声明 PENDING 类“protected in full”，随后却关闭了它唯一的支付通道；
而同为受保护债权的 REFUNDABLE 类走 `claimRefund` 完全不受影响。修复后两类受保护债权
在清算后的待遇一致。

取消退款走的是本就为该类预留的资金，不会侵蚀清算的减记池：`gross` 与
`pendingDepositLiability` 同额下降，`writeDownInsolvency` 建立的
`gross >= protected + reservedRedeem` 不变量得以保持。测试对
`reservedRedeemLiability` 不变与该不变量都做了断言。

`LiquidityEarnVault` 未 override `cancelRequest`，直接继承本修复；
它额外的 `evictDepositRequest` 出口保持不变。

豁免范围严格限定在清算：普通的 CALCULATING 周期仍然关闭取消窗口，
因为此时确实可能有结算轮次正在处理该请求。
`test_cancelRequest_pendingDepositStillBlockedWhileMerelyCalculating` 固定了这条边界。

### 5.2 不采纳的部分：不为 `writeDownInsolvency` 补充 `cs == ACCEPTING` 前置

**这条建议会导致协议在最需要恢复路径时彻底砖化，方向与其意图相反。**

理由如下。清算恰恰是在金库资不抵债时才被调用的，而资不抵债的典型发现方式，
就是运营方尝试结算时 `settle()` 回滚：

1. `snapshotSettlementPrice` 调用 `totalAssets()`，后者在
   `gross < liabilities` 时 `revert AccountingInsolvent()`（`BaseVault.sol:419`）。
2. 此时周期已经处于 CALCULATING（`startCycleCalculation` 已执行）。
3. 退出 CALCULATING 的**唯一**写入者是 `StateManager.completeCycle`，
   而它是 `onlyVaultSettlement`，只能经由 `Settlement.submitBatch → settle` 到达——
   但第 1 步已经证明这条路走不通。
4. 于是周期永久停在 CALCULATING。

若此时 `writeDownInsolvency` 要求 `cs == ACCEPTING`，则唯一的恢复入口在唯一需要它的
场景下不可达：无法清算、无法结算、无法重开周期，全部债权连同受保护的 PENDING 与
REFUNDABLE 一起永久锁死。这比该建议想要防范的情形严重得多。

同时，加上这条前置对第 5 项要解决的问题也没有帮助：5.1 的修复已经完整解除了
PENDING 存款的死锁，且不依赖清算发生在哪个周期状态。`writeDownInsolvency` 保持对
周期状态无前置，正是它作为最后手段的恢复路径应有的性质——它必须能在系统已经卡死的
任何状态下执行。

上述推理不是纸面分析，`test_writeDownInsolvency_mustStayReachableWhileTheCycleIsWedged`
在链上逐步复现了它：金库资不抵债且周期处于 CALCULATING 时，
（1）`snapshotSettlementPrice` 以 `AccountingInsolvent` 回滚；
（2）`startCycleCalculation` 无法重开周期，周期确实卡死在 CALCULATING；
（3）`writeDownInsolvency` 从这个状态执行成功，随后各债权人确实拿到了钱。
若加上 `cs == ACCEPTING` 前置，第（3）步——全金库唯一的出口——将直接回滚。

其自身的安全性由与周期状态无关的四道校验保证，均已存在且未改动：
仅 `vaultTimelock` 可调用、一次性（`AlreadyLiquidated`）、
必须确实资不抵债（`NotInsolvent`）、必须完整提交全部未领取赎回请求
（`IdsNotStrictlyAscending` + `IncompleteWriteDown`）。

如贵方仍认为需要限制执行时机，我们建议改为在 `submitBatch` 侧处理，
而非在恢复路径上加锁；请告知后我们再评估。

---

## 六、变异验证

每一项修复都逐条回退后重跑对应测试，确认新增测试确实捕获该缺陷：

| 回退的修复 | 失败的测试 | 失败形态 |
|---|---|---|
| `deposit` 去掉 `_onlyVault()` | `test_erc4626_entryPoints_rejectEveryoneButTheVault` | 预期回滚未发生 |
| `_deployCapital` 去掉上限 | `test_executeBuy_cannotDeployEscrowedSellProceeds`、`test_executeBuy_ceilingIsFreeBalanceNotWholeBalance` | 预期回滚未发生 |
| `executeSell` 恢复检查性减法 | `test_executeSell_survivesTheDealBeingRetiredFirst` | **算术下溢 panic 0x11**——与审计描述的形态完全一致 |
| `updateDealData` 去掉预留守卫 | `test_updateDealData_cannotRevalueBelowAReservedSellOrder` | 预期回滚未发生 |
| `bridgeDeposit` 去掉白名单检查 | 3 项桥接测试 | 预期回滚未发生 |
| 存款分支恢复无条件 `_requireCancellable` | `test_cancelRequest_pendingDepositStillExitsAfterLiquidation` | **`CancelNotAllowed(6, 3, 1)`**——即 OPERATING + CALCULATING 的永久拒绝 |

## 七、新增测试清单（15 项）

`test/BaseAdapter.t.sol`（6 项）

- `test_erc4626_entryPoints_rejectEveryoneButTheVault`
- `test_erc4626_entryPoints_stillOpenToTheVault`
- `test_executeBuy_cannotDeployEscrowedSellProceeds`
- `test_executeBuy_ceilingIsFreeBalanceNotWholeBalance`
- `test_executeSell_survivesTheDealBeingRetiredFirst`
- `test_updateDealData_cannotRevalueBelowAReservedSellOrder`

`test/LiquidityBridge.t.sol`（6 项）

- `test_bridgeDeposit_registeredButUnadmittedFromVault_reverts`
- `test_bridgeDeposit_unadmittedToVault_reverts`
- `test_setBridgeWhitelisted_onlyGovernor`
- `test_setBridgeWhitelisted_zeroAddress_reverts`
- `test_setBridgeWhitelisted_emitsAndIsRevocable`
- `test_constructor_rejectsZeroAccessControl`

`test/EarnVault.t.sol`（3 项，第三项为不采纳附带建议的依据）

- `test_cancelRequest_pendingDepositStillExitsAfterLiquidation`
- `test_cancelRequest_pendingDepositStillBlockedWhileMerelyCalculating`
- `test_writeDownInsolvency_mustStayReachableWhileTheCycleIsWedged`

## 八、接口变更汇总

**`ILiquidityBridge`**

- 构造函数：`LiquidityBridge(usdt, stateManager, accessControl)`——新增第三个参数
- 新增 `setBridgeWhitelisted(address vault, bool allowed)`
- 新增 `bridgeWhitelisted(address vault) view returns (bool)`
- 新增事件 `BridgeWhitelistUpdated(address indexed vault, bool allowed, uint256 timestamp)`
- 新增错误 `VaultNotWhitelisted(address)`、`NotGovernor()`

**`IAdapter`**

- 新增错误 `NotVault()`、`DealValueBelowReserved(uint256 dealKey, uint256 newValue, uint256 reserved)`
- `deposit` / `mint` / `withdraw` / `redeem` 仅金库可调用（行为变更，签名不变）
- `DealValueReducedBySell` 事件的第三个字段改为实际冲销值（语义变更，签名不变）

**`BaseVault`**

- `cancelRequest` 的存款分支在 `insolvencyLiquidated` 为真时跳过周期状态检查（行为变更，签名不变）
