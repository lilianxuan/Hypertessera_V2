# 客户十二份文档实现说明（2026-08-24 起，持续更新）

对应客户十二份文档：

| # | 文档 | 本文对应章节 |
|---|---|---|
| 1 | 《HyperTessera - Audit Feedback - CN - V1》（2026-08-17，10 项 + 3 个待确认问题） | 第一、四部分 |
| 2 | 《一年期产品最终周期结算与产品参数调整说明》 | 第二部分（**已被第十一部分取代**） |
| 3 | 《募集上限参数调整建议》 | 第三部分 |
| 4 | 《合约修改20260824》（totalSubscribed 记账边界） | 第六部分 |
| 5 | 《净募集额度修改方案》 | 第七部分 |
| 6 | 《writeDownInsolvency 最小化修改方案》（0826） | 第八部分 |
| 7 | 《合约修复20260825》（UnifiedPool 移除 Tranche） | 第九部分 |
| 8 | 《审计报告（一）回复》 | 第十部分 |
| 9 | 《HyperTessera 审计报告一反馈》 | 第十部分 |
| 10 | 《最终周期结算及最终兑付补充修改方案》 | 第十一部分 |
| 11 | 《HyperTessera Audit Feedback V2(中)》（11 项 + 2 个待确认问题） | 第十二部分 |
| 12 | 《审计报告（二）回复》 | 第十二部分 |

> **本文档的阅读顺序说明。** 第一至九部分按最初三轮文档撰写；第十至十二部分是其后新增轮次。
> 后轮次推翻了前轮次的两处结论，相关章节已就地加上 ⚠️ 更正标注并指向新章节，原文保留以便
> 对照贵方此前已阅读的版本：
>
> - **第一部分第 2 项（净值高估）已整体回退** —— 见第十部分。
> - **第二部分（最终周期结算）已被重新设计** —— 见第十一部分。
> - **第四部分问题 2（CLAIMING 期退出路径）当时答复"链上没有这条路径"，现已实现** —— 见第十一部分。

合并后对 `ProductParams` 的净效果：删除 `firstCycleStart`，其位置由
`subscriptionCapShare` 顶替，字段总数仍为 10。**这是不兼容的 ABI 变更**，`setProductParams`
与 `getParams` 的数据结构都会变，前端、链下系统、部署脚本必须同版本升级。现有已部署合约不会
自动获得这些修改，需在新版本合约重新部署后生效。

验证结果：`forge test` **1003 项全部通过**；链下单元测试 116 项、集成测试 15 项（对 anvil 实链）
全部通过；`npm run local:deploy` 全栈部署成功。

---

## 一、审计反馈十项

### 1. 缺少白名单校验（Critical）— 已修复

`UnifiedPool` 上所有授权都是“向 `vault` 询问它自己”——`owner()`、`settlement()`。这只有在
`vault` 确实是协议金库时才成立。现已在 `_onlyVaultOwner`、`_onlySettlementOperator`、
`distribute` 与 `addTrancheVault` 统一加入 `sm.registeredVaults(vault)` 校验，不通过则
`UnregisteredVault`。StateManager 的注册表只由唯一绑定的 VaultFactory 写入，是这里的权威来源。

覆盖测试：`test/UnifiedPool.t.sol::test_addTrancheVault_revertsForUnregisteredVault` /
`test_operatorTransfer_revertsForUnregisteredVault` /
`test_attributePrincipal_revertsForUnregisteredVault`——伪造合约自报 `owner=攻击者`、
`settlement=真实 Settlement`，在三个入口全部被拒。

### 2. 净值高估（High）— ~~已修复~~ **本项已整体回退，见第十部分**

> ⚠️ **更正（后轮次）。** 贵方在《审计报告（一）回复》中复核确认 `pending[vault]` 是该 Vault 对
> UnifiedPool 管理资产的**账面归属权益**，而非池内即时现金；`operatorTransfer` 只是资产形态由
> 现金转为外部投资头寸，并未消灭权益，因此**不应**在转出时扣减。本项的下述修改已全部撤销，
> 改为新增坏账函数 `UnifiedPool.writeDownPending`。以下原文保留仅供对照，**不代表当前实现**。

`operatorTransfer` / `operatorTransferToRevenuePool` 出金时同步扣减 `pending[vault]` 与
`totalPending`，不足则 `InsufficientPending`。

> **这是一个需要客户确认的取舍。** 审计给了两个方向，我们采用了“出金时扣减 pending”，因为它与
> `distribute` 对称，且能让账本恒等于池内现金。代价是**运营上 Operator 只能划出已归属给该金库
> 的金额**——未归属的入金必须先经 `attributeInterest` / `attributePrincipal` 归属，或由金库自己
> 走 `returnPrincipalToPool`。若客户的实际资金流需要在归属前就把钱划出池外，请告知，我们改用另
> 一方向（`attributePrincipal` 入金时不增加 `pending`）。

一个有价值的副产品：现在池内 USDT 恒等于
`totalPending + unattributedInterest + unattributedPrincipal`。任何金库的应收都不会超过背后的
现金，`distribute` 里的现金校验从主要防线降为纵深防御。
覆盖测试：`test_operatorTransfer_debitsPending`、`test_operatorTransfer_revertsBeyondPending`、
`test_ledgerStaysFullyCashBacked`。

### 3. 请求无法结算（Medium）— 已修复

`_writeDownPendingDeposits` 禁止把 PENDING 申购减记为 0，触发 `WriteDownToZero`。理由与审计一致：
`_processDeposits` 同时拒绝 `settleAmount == 0` 与 `settleAmount > req.assets`，减记到 0 之后没有
任何入参能结算它，且它一旦被纳入批次会让整批 revert。

REFUNDABLE 请求不受此限制，仍可减记到 0——它走的是领取而非结算，退 0 就是不退钱，没有僵尸状态。

覆盖测试：`test/EarnVault.t.sol::test_writeDownPendingDeposit_toZeroReverts` 与
`test_writeDownPendingDeposit_nonZeroSucceeds`。

### 4. 缺少暂停检查（Low）— 已修复

暂停冻结范围扩大到：`claimDeposit`、`claimRedeem`、`claimRefund`、`cancelRequest`、
`returnPrincipalToPool`、份额 `transfer` / `transferFrom`、`snapshotSettlementPrice`。加上原有的
新申购、新赎回、`settle` 与 LiquidityBridge 同步申购，暂停现在确实是“紧急冻结”。

**运营影响需要提前对客沟通**：暂停期间用户无法领取已结算的赎回款与退款，也无法转让份额。

覆盖测试：`test/EarnVault.t.sol` 中 `test_pause_blocks*` 共 7 项。

### 5. 扣减账本无募集期限制 — 已修复

`releaseSubscription` 加上与 `recordSubscription` 对称的 `SUBSCRIBING` 门槛：运营期取消申购在账本
上是 no-op，不再把 `_totalSubscribed` / `_subscribedByWallet` 减到真实募集累计值以下。
覆盖测试：`test/StateManager.t.sol::test_releaseSubscription_noOpOutsideSubscribing`。

### 6. 更换池子未处理旧池 pending — 已修复

`setUnifiedPool` 在切换前要求旧池对本金库的 `pending` 为 0，否则 `OldPoolPendingNotDrained`。运营
顺序变为：先把旧池余额 `distribute` 回金库，再换池。
覆盖测试：`test/EarnVault.t.sol::test_setUnifiedPool_revertsWhileOldPoolStillOwesThisVault`。

### 7. 传参未固定初始状态 — 已修复

`registerVault` 的签名改为 `registerVault(address vault)`，初始三层状态在合约内固定为
`CONFIGURING` / `ACCEPTING` / `ACTIVE`。同时 `IVaultFactory.VaultParams` 删除
`initialProduct` / `initialCycle` 两个字段。

> **这也是一个可回退的取舍。** 另一种做法是保留两个入参、只校验其取值必须是
> `CONFIGURING` + `ACCEPTING`，功能等价但 ABI 不变。我们选择了直接删除，理由是本次发布本来就要
> 破坏 `ProductParams` 的 ABI，而保留两个只能取唯一值的字段容易让前端误用。若客户希望保留字段
> 以减少前端改动面，请告知。

覆盖测试：`test/VaultFactory.t.sol::test_deploy_alwaysStartsInConfiguringAccepting`。

### 8. 未校验金库参数即可开募 — 已修复

两层防护：

1. `setProductParams` 校验参数自洽性，不通过则 `InvalidProductParams(field)`：
   `subscriptionEnd > subscriptionStart`、`cycleDuration > 0`、
   `maturityTimestamp >= subscriptionEnd`、`claimingStart >= maturityTimestamp`、
   `claimingEnd >= claimingStart`。
2. `openSubscription` 要求参数确实设置过（内部 `_paramsSet` 标记），否则
   `ConditionNotMet("product params not set")`。

`walletSubscriptionCap`、`subscriptionCapShare`、`minRaiseAmount` 取 0 仍然合法，它们的语义就是
“不限额 / 无最低”。`subscriptionStart = 0` 也仍然合法，含义是“Keeper 一调用即可开募”——“从未配置”
由 `_paramsSet` 判定，不靠这个字段。

覆盖测试：`test/StateManager.t.sol::test_openSubscription_revertsWhenParamsNeverSet` 及
`test_setProductParams_rejects*` / `test_setProductParams_accepts*` 共 5 项。

### 9. 抢跑风险 — 已修复

`bindGovernance` 限定调用方必须是 StateManager 绑定的唯一 VaultFactory
（`IStateManager(stateManager).vaultFactory()`），`IStateManager` 相应新增 `vaultFactory()` getter。
不再依赖“部署与绑定在同一笔交易内”这个未被强制的前提。

一个连带的行为变化：若 `StateManager.setVaultFactory` 未指向该 VaultFactory 实例，
`deployVault` 现在会在 `bindGovernance` 这一步就 revert（此前是在最后的 `registerVault` 才失败）。
覆盖测试：`test/EarnVault.t.sol::test_bindGovernance_revertsForNonFactory`、
`test/VaultFactory.t.sol::test_deploy_reverts_if_factory_not_wired_in_stateManager`。

### 10. 字段未被使用（Info）— 已修复

删除 `RedeemRequestInternal.queuePosition`。该字段无任何外部读取路径，排队位置由 Queue 合约维护。

---

## 二、一年期产品最终周期结算（**已被第十一部分取代**）

> ⚠️ **更正（后轮次）。** 本部分描述的是第一轮实现：`enterFinalSettlement` 删除、最终周期由
> `completeCycle` 原子进入 `SETTLING`、并由 `confirmFinalSettlement` / `completeFinalSettlement`
> 二次确认后进入 `MATURING`。《最终周期结算及最终兑付补充修改方案》之后重新设计了这条路径：
> **最终周期改在 `SETTLING / CALCULATING` 执行**，重复确认链路（`confirmFinalSettlement` /
> `completeFinalSettlement` / `isFinalSettlementComplete` / `hashFinalSettlementConfirmation` /
> `enterMaturing`）**已从代码库删除**。当前实现见第十一部分；以下原文保留仅供对照。

### 删除 firstCycleStart

`ProductParams.firstCycleStart` 已删除。它此前唯一的作用是在
`finalizeSubscription` 里覆盖首个周期起点，而 Cycle 0 本来就在募集成功后立即进入 `CALCULATING`，
不等待该时间戳，所以它只增加理解成本、不产生可观察的调度效果。现在
`_cycleStart = block.timestamp`，周期起点统一由实际完成时间决定。

### 最终周期不会被跳过

问题根因：Cycle 0 的初始结算在 `subscriptionEnd` 之后的任意时刻完成，之后每个周期边界都被这段
延迟整体推后。一年期产品若 `cycleDuration` 也是一年，到期时最后一个周期还没到点，而旧的
`enterFinalSettlement` 会直接跳到 `SETTLING`，最终结算就整个被跳过。

改动：

1. **`startCycleCalculation` 增加第二个独立触发条件**：普通周期仍要求
   `now >= 周期实际起点 + cycleDuration`；只要 `now >= maturityTimestamp`，无论普通周期走了多少，
   都允许启动最终周期。产品不再需要把 `cycleDuration` 改成 364 天或人为加缓冲。
2. **删除 `enterFinalSettlement`**。`OPERATING → SETTLING` 改由最终周期的 `completeCycle`
   在同一笔交易内原子完成。这样最终周期结构上无法被跳过——SETTLING 只有这一条到达路径。
3. **不会重复执行最终周期**：判据是“完成时刻 `>= maturityTimestamp`”，因此到期前进入
   `CALCULATING`、到期后才完成的普通周期直接被视为最终周期，不会再起一轮。
4. **不会重新开放申赎**：cycle 归还 `ACCEPTING` 与 product 置为 `SETTLING` 在同一笔交易内发生，
   中间不存在任何一个区块处于“cycle 已开放、product 仍是 OPERATING”的状态。
5. **`completeFinalSettlement` 增加 `cycle == ACCEPTING` 前置校验**：最终周期仍在 `CALCULATING`
   时不允许确认最终结算，也就不可能进入 `MATURING`。

最终周期完全复用现有结算机制——到期 `totalAssets` / `totalSupply` 快照、High-Water Mark 业绩费、
按同一最终价格处理申赎——不引入第二套到期定价逻辑。**空申赎队列同样可以、也必须提交最终批次**，
这对一年期产品是常态；不提交会让产品永远卡在 `OPERATING` / `CALCULATING`。

调整后的状态路径：

```
认购成功：SUBSCRIBING → OPERATING/CALCULATING（Cycle 0）→ OPERATING/ACCEPTING
普通周期：OPERATING/ACCEPTING → OPERATING/CALCULATING → OPERATING/ACCEPTING
最终周期：OPERATING/ACCEPTING → （达到 maturityTimestamp）OPERATING/CALCULATING
        → （最终快照、业绩费、申赎结算完成，同一笔交易）SETTLING/ACCEPTING
        → （最终结算确认）MATURING
```

### KeeperBot

到期后不再优先跳 `SETTLING`，只负责启动下一个周期。新增 `final-cycle-pending` 告警：产品已到期且
最终周期处于 `CALCULATING` 时，说明在等 Settlement Operator 提交最终批次，链下会有明确提示。

覆盖测试：`test/StateManager.t.sol` 中 `test_finalCycle_*` 与 `test_completeCycle_*` 共 6 项，
`test/Settlement.t.sol` 中 `test_finalCycle_*` / `test_confirmFinalSettlement_*` 共 3 项，
`offchain/test/keeperBot.unit.test.ts` 中 OPERATING 分支 4 项。

---

## 三、募集上限参数调整

`subscriptionCapShare` 加入 `ProductParams`（顶替 `firstCycleStart` 的位置）。流程：

1. 产品处于 `CONFIGURING` 时，Curator 通过 `StateManager.setProductParams` 一次性提交全部产品
   参数，含 `subscriptionCapShare`。
2. StateManager 校验调用者确为该 Vault 的 Curator、产品仍在 `CONFIGURING`。
3. StateManager 保存参数后，调用 Vault 的 `initSubscriptionCapShare` 把上限写入 Vault。
4. Vault 的 `subscriptionCapShare` 继续是当前有效募集上限的权威数据，结算时据此检查。
5. `subscriptionCapShare = 0` 继续表示不设上限。

权限调整（与客户文档一致）：

- `initSubscriptionCapShare`：**仅该 Vault 绑定的 StateManager**，且**仅在 `CONFIGURING`**。
  产品离开 `CONFIGURING` 后 StateManager 再也无法修改该参数。
- `setSubscriptionCapShare`：**仅该 Vault 的 VaultTimelock**。此前它允许 Curator 在 `CONFIGURING`
  期直接调用，现已收紧——初始值统一走 `setProductParams`，后续调整统一走 Timelock。
- 其他 Vault 参数函数的权限未做任何放宽。

控制面板已更新：产品参数配置项改为 10 项含 `subscriptionCapShare`（份额单位，18 位小数）；
三个 Vault 分区各新增 `subscriptionCapShare()` 读取与 `setSubscriptionCapShare`（Timelock）操作。
**展示当前上限时请读取 Vault 的 `subscriptionCapShare()`**，而不是首次提交的产品参数——经 Timelock
修改后的值只反映在 Vault 上。

覆盖测试：`test/EarnVault.t.sol` 中 `test_initSubscriptionCapShare_*` /
`test_setSubscriptionCapShare_*` 共 6 项，`test/StateManager.t.sol::test_setProductParams_pushesCapIntoVault`，
以及原有的 `test_settle_supplyCapExceeded_reverts`（改为经产品参数注入上限）。

---

## 四、三个待确认问题的答复

### 问题 1：减记对象的正当性

审计的观察是准确的：`writeDownInsolvency` 减记的三类对象——待结算申购、待领赎回、待退款——都是
尚未入场或已实质离场的资金，而真正在场承担投资风险的份额持有人不被触及；减记额度完全由链下传入，
链上没有 pro-rata 公平性约束；事件也不记录被减记的 owner。

本次我们只修复了其中确定是缺陷的一点（减记到 0 造成僵尸请求，见 1.3）。其余三点是产品设计决策，
需要客户定夺，我们不擅自改动：

1. **被减记的用户是否通过链下补偿？** 若是，链上的减记就是账面对齐、链下另行结算，当前设计成立，
   但建议在对客文件中写明。若否，则减记范围确实需要重新界定。
2. **是否应把减记范围收窄到在场份额持有人（即只由净值承担）？** 技术上可行：份额持有人通过
   `totalAssets` 下降自动承担亏损，无需任何减记调用；待结算申购与待退款资金从未参与 adapter 投资，
   完全不减记也不会造成账实不符——只要亏损额度在份额持有人权益范围内。当亏损超过份额持有人全部
   权益时，才必须触及其他三类。若客户认可这个方向，我们可以把 `writeDownInsolvency` 改为**先耗尽
   份额持有人权益、仅在不足时才减记其余三类**，并对每一类内部强制 pro-rata。
3. **事件是否补充 owner？** 建议补充，成本极低。`RequestWrittenDown` 增加 `address indexed owner`
   一个字段即可，链下可据此逐户追溯。我们等客户确认后一并实现（会改变事件 ABI）。

### 问题 2：CLAIMING 期持有到期未赎回者的退出路径（**已实现，见第十一部分**）

> ⚠️ **更正（后轮次）。** 本节当时的答复是“确认：目前链上没有这条路径”，并请贵方在两个方向中
> 选择。贵方在《审计报告（一）回复》中明确选择**由用户直接从 Vault 领取，不由链下发钱**，该路径
> 已实现为 `BaseVault.claimFinal`（第十一部分）。它同时覆盖 Audit Feedback V2 #1「申购永久锁定」。

**确认：目前链上没有这条路径。** `requireOperable` 在 CLAIMING 期不放行 `requestRedeem`，
`confirmFinalSettlement` / `completeFinalSettlement` 只置位标记、不结算任何剩余份额，因此持有份额
到期、且从未主动发起赎回的投资者，在 CLAIMING 期既无法发起赎回，也没有可领取的 SETTLED 请求。

本次《最终周期结算》的改动**没有覆盖这个缺口**：最终周期结算的是**到期前已经进入队列**的申购和赎回，
对从未发起赎回的持有人不产生任何请求。

需要客户明确二者之一：

- **若由链下直接发钱**：请在对客文件中写明，并说明链上份额在什么条件下作废/回收，否则份额仍在流通、
  净值仍在账面上，与链下已兑付的事实脱节。
- **若需要链上路径**：有两种实现方向，我们可以按客户选择实现：
  1. **CLAIMING 期重新放行 `requestRedeem` + 一次最终清算批次**——改动小，但需要 Operator 再跑一轮
     结算，且要处理“清算价格如何确定”（沿用最终周期快照价即可）。
  2. **最终周期强制结算全部份额持有人**——到期时按最终价格把所有在外份额转为可领取的 USDT 债权。
     语义最干净，但需要遍历持有人，链上无法枚举 ERC-20 持有人，必须由链下传入名单并做完整性校验，
     实现复杂度明显更高。

我们的建议是方向 1。

### 问题 3：tranche 分层是否为计划中但未实现的功能

确认审计的判断：`_trancheVaults` / `isTrancheVault` / `vaultTranche` 目前只是分类标签。
`distribute`、`attributeInterest` / `attributePrincipal`、`writeDownInsolvency` 与净值计算都不区分
tranche，不存在差异化利率分配、本金返还优先级或亏损吸收顺序。

按当前架构，分层实际上是通过**多个独立金库 + 各自的产品参数与 Adapter 配置**实现的，而不是通过
UnifiedPool 内的分层逻辑。若客户确实需要合约层面的优先/劣后（例如 Cash 优先于 LP 吸收亏损），
这是一项独立的功能开发，需要单独立项——请告知是否纳入后续排期。

---

## 五、需要客户注意的其他事项

### 同步更新的内容

已随本次改动更新：合约与接口、`script/Deploy.s.sol` 与 `StubStateManager`、Foundry 测试、
SDK 类型与方法、KeeperBot、链下脚本与测试、`control-panel/abis.json` + `abis.js` +
`index.html` + `standalone.html`、以及 `docs/function-reference.md`、
`docs/frontend-handover-2026-08-09.md`、`docs/offchain-operations-runbook.md`、
`docs/settlement-operator-runbook.md`、`docs/development-plan.md` 中受影响的条目。

`docs/function-reference.md` 是当前合约行为的权威说明；`docs/development-plan.md` 是原始规划文档，
仅在受本次改动直接影响的条目上做了标注。

**2026-08-26 补充同步**：`docs/function-reference.md` 已随第十至十二部分整体校订 —— 新增
`UnifiedPool.writeDownPending`、`BaseVault.claimFinal`、`configureClaimRegistry` /
`recordOverdueClaims`、`RWAAdapter` 的三个 RWA 转出函数、`updateRebalanceDealData` /
`clearRebalanceDealValue`；更正 `writeDownInsolvency` 的签名、
`realAssets` 的时效规则、`startCycleCalculation` / `completeCycle` 的最终周期行为；并把已删除的
`confirmFinalSettlement` / `completeFinalSettlement` / `isFinalSettlementComplete` /
`enterMaturing` / `addTrancheVault` 系列 / `ClaimRegistry.setStateManager` 标注为已移除。

---

## 六、totalSubscribed 记账边界统一（《合约修改20260824》）

贵方指出的三点观察都成立，我们按“统一定义与生命周期”的要求处理如下。

### 已修复的不一致

运营期取消申购此前仍会减少 `_totalSubscribed` / `_subscribedByWallet`，而运营期申购从未计入，
导致取消操作能够回头改写历史募集数据。`releaseSubscription` 现已加上与 `recordSubscription`
对称的募集期门槛：运营期取消在账本上是 no-op。（这与审计反馈第 5 项是同一处修复，见 1.5。）

### 统一后的定义

`totalSubscribed` / `subscribedByWallet` 是**募集期申报统计**，不是实际认购本金。三条性质：

1. **只在 `SUBSCRIBING` 期双向变动**：募集期内申购加、取消减；运营期申购不加、运营期取消不减。
2. **募集完成后冻结**：`finalizeSubscription` 是这两个映射最后一次可能变动的时刻。此后
   `totalSubscribed(vault)` 永远报告募集窗口内申报的金额——募集失败（`FUNDING_FAILED`）后的
   退款同样不会改写它。
3. **不与结算对账**：部分结算按实际接受金额铸造份额并退回剩余资金，不调整这两个值，因此该统计
   可能高于真正进入金库的本金。**需要实际认购本金的场合必须读金库，不能读这个字段。**

链上唯一消费者是 `finalizeSubscription` 的 `minRaiseAmount` 判定。该定义已写入
`StateManager.recordSubscription` 的代码注释与 `docs/function-reference.md`，以免后续再被误用。

覆盖测试：`test/StateManager.t.sol::test_totalSubscribed_frozenAfterRaiseCloses`（募集期内双向
变动、募集完成后申购与取消均不影响）、`test_totalSubscribed_frozenAfterFundingFailed`、
`test_releaseSubscription_noOpOutsideSubscribing`。

---

## 七、净募集额度（《净募集额度修改方案》）

### 修改内容

BaseVault 新增内部字段 `subscriptionCapUsedShares`，表示当前已占用的募集额度。按贵方要求：
初始值 0、不按周期清零、无设置函数、不加入 ProductParams、不新增事件与查询接口（合约体积考虑）。

**增加额度**——只在实际结算并铸造 shares 后：普通申购按实际铸造份额计入；部分结算只计入实际接受
部分；Liquidity Bridge 入金铸股在 `EarnVault.deposit` 铸造时即计入目标金库；取消、退款、未结算
请求不计入；领取 shares 不重复计入。

**释放额度**——只在实际结算并销毁 shares 后：按本次实际销毁份额减少；部分赎回只释放实际销毁部分；
取消与未结算赎回不释放；**所有实际销毁的 shares 均释放额度，包括业绩费 shares**；最低减至 0，
避免下溢（业绩费份额铸造时未占用额度，其赎回销毁时的释放量可能超过账面占用，因此必须取零下界）。

**按批次净额更新**：`settle()` 内先处理申购与赎回，再一次性执行
`结算后占用 = 结算前占用 + 实际铸造 − 实际销毁`（取零下界）并检查上限，避免同批次先申购后赎回
造成的中间状态误判。

**上限检查**：删除原基于 `totalSupply`、结算价格与 `maxAUM` 的判断，改为
`subscriptionCapUsedShares <= subscriptionCapShare`。同步修改 `BaseVault.settle()`（最终权威
检查）与 `EarnVault.deposit()`（Liquidity Bridge 快速检查）。`CALCULATING` 状态沿用现有延后检查
规则；`subscriptionCapShare = 0` 继续表示无限额；复用现有 `SupplyCapExceeded`，未新增错误类型。

### 一处接口影响

`SupplyCapExceeded(limit, actual)` 在 `settle()` 路径上此前以 **USDT（AUM）**单位报告，现在两个
参数统一为**份额单位**。`EarnVault.deposit()` 路径本来就是份额单位，不变。链下解析该错误的逻辑
需要相应调整。

### 保持不变

业绩费计算及铸造、价格快照与 High-Water Mark、ERC-20 `totalSupply`、申赎请求/取消/领取、
FIFO 队列与状态机、`subscriptionCapShare` 的设置权限，均未修改。

### 验收要求对照

| 验收要求 | 覆盖测试 |
|---|---|
| 利息和业绩费增发不占用募集额度 | `test_settle_interestInflowConsumesNoQuota`、`test_settle_performanceFeeSharesDoNotConsumeQuota` |
| 实际申购正确增加额度 | `test_settle_supplyCapExceeded_reverts`、`test_settle_zeroCapShareImposesNoLimit` |
| 实际赎回正确释放额度 | `test_settle_burningFeeSharesReleasesQuotaAndFloorsAtZero` |
| 同批次按照申赎净额检查 | `test_settle_capCheckedOnBatchNetNotIntermediate` |
| 部分结算按实际处理数量统计 | `test_settle_partialFill_chargesOnlyTheAcceptedPart` |
| 超过上限 1 个最小 share 单位即整笔回退 | `test_settle_capShare_oneWeiOver_reverts` |
| `subscriptionCapShare = 0` 时不限制 | `test_settle_zeroCapShareImposesNoLimit` |
| 业绩费、价格快照和申赎结果与修改前一致 | 原有 992 项测试全部通过，未修改相关逻辑 |

Liquidity Bridge 路径另有 `test/SettlementOrdering.t.sol::test_capShare_catchesLpBridgeInflow`
与 `test_capShare_calculatingOvershootIsCaughtLateAndWedgesTheCycle` 两项覆盖。

---

## 八、writeDownInsolvency 最小化改造（0826）

按贵方方案重写，函数名、Vault Timelock 权限、`grossManagedAssets` 口径、
`InsolvencyWrittenDown` / `RequestWrittenDown` 事件与 `claimRedeem` 领取路径均保留。

### 适用边界

仅在**固定债权资不抵债**时可调用：`grossManagedAssets < 全部固定负债`。若固定负债仍能全额覆盖，
属于普通投资亏损，只通过 NAV 与 share 价格反映，调用直接 `NotInsolvent` 回退。不增加 ProductState
或 CycleState 限制——该情况可能在产品运行中途发生。

### 清偿顺序

PENDING 申购全额保护 → REFUNDABLE 退款全额保护 → 剩余资产偿付已结算赎回 → 不足部分按**统一比例**
减记 → shares 排在最后。此时资产连固定负债都无法覆盖，份额持有人没有可分配资产，因此清算成功后
**永久禁止 `claimFinal`**。

### 接口变化

`writeDownInsolvency(uint256[] settledRedeemIds)` —— 由原来的四个数组减为**一个**：

- 删除 `refundableDepositIds` / `newRefundableAssets` 与 `_writeDownRefundables`；
- 删除 `newSettledRedeemAssets`——**调用者只能提交 Request ID，不能提交减记金额**；
- PENDING 通道在上一轮已删除，保持不变。

### 统一比例由合约计算

```
可用于赎回的资产 = grossManagedAssets − (pendingDepositLiability + refundableLiability)
统一偿付比例     = 可用于赎回的资产 / reservedRedeemLiability
```

该比例只是函数执行期间的临时变量：不写入 storage、不加 getter、不写入事件、不允许链下传入。

### 防止遗漏或重复

- `settledRedeemIds` 必须**严格递增**（`IdsNotStrictlyAscending`），杜绝重复；
- 本次处理的全部原始 `settledAssets` 合计必须**等于调用前的 `reservedRedeemLiability`**
  （`IncompleteWriteDown`），杜绝遗漏。

两项合起来保证：所有尚未领取的固定赎回债权都被处理，任何用户不能被跳过或重复提交，且全部适用同一比例。

### 前置与完成检查

调用前：Vault Timelock、`reservedRedeemLiability > 0`、确实资不抵债、Vault 实际持有的 USDT 足以覆盖
PENDING 与 REFUNDABLE（`ProtectedLiabilitiesUnbacked`）、尚未执行过清算（`AlreadyLiquidated`）。
执行后：PENDING 与 REFUNDABLE 金额不变、减记后固定负债不超过 `grossManagedAssets`。

### 清算后的限制

新增一个永久标识 `insolvencyLiquidated`，在必要入口检查：

- **禁止**：`claimFinal`、新申购、新赎回、新的价格快照/结算、向 Adapter 调拨、`returnPrincipalToPool`；
- **允许**：PENDING 取消并全额退款、REFUNDABLE 全额领取、已结算赎回按减记后金额 `claimRedeem`、
  部分结算赎回取回 `remainingShares`、Adapter 与 UnifiedPool 正常回收资产。

不修改 ProductState / CycleState，不新增事件，不新增 `referenceId` 或比例字段——减记前金额可由
`haircut + newAssets` 还原，统一比例可由链下自行计算。

### 资产追回

完全在链下处理：追回资金不进入 Vault、不计入 `grossManagedAssets`、不新增链上追偿合约或登记/领取函数。
若追回资金进入 Vault，会抬高 `freeVaultUSDT` 与 NAV，份额持有人可能通过链上路径抢先取走，被减记的
固定债权人反而无法优先受偿。

### 验收对照

| 验收标准 | 覆盖测试 |
|---|---|
| 普通投资亏损不能调用 | `test_writeDownInsolvency_revertsWhenFixedClaimsStillCovered` |
| 所有赎回 Request 使用同一比例 | `test_writeDownInsolvency_appliesOneUniformRatioToEveryClaim` |
| 调用者不能提交减记后金额 | 接口层面已无该参数 |
| Request 缺失时回退 | `test_writeDownInsolvency_revertsOnOmittedRequest` |
| Request 重复或顺序错误时回退 | `test_writeDownInsolvency_revertsOnRepeatedOrUnsortedIds` |
| PENDING 与 REFUNDABLE 不被减记 | `test_writeDownInsolvency_leavesProtectedClassesWhole`、`test_writeDownInsolvency_cannotTouchPendingDeposits` |
| 减记后继续通过原 `claimRedeem` 领取 | `test_writeDownInsolvency_afterLiquidationOnlyUnwindIsAllowed` |
| 成功减记后 `claimFinal` 永久禁止 | 同上 |
| 只能执行一次 | `test_writeDownInsolvency_cannotRunTwice` |

---

## 九、UnifiedPool 移除 Tranche 分类（合约修复20260825）

资金归集、应收记账与结算分配本来就以 Vault 地址为单位，tranche 从未参与资金计算、权限校验或结算
路由，保留它只会造成金库类型登记错误并限制产品扩展。

- `addTrancheVault(Tranche, vault)` → **`addVault(vault)`**；
- `deactivateTrancheVault` / `reactivateTrancheVault` → **`deactivateVault` / `reactivateVault`**；
- 保留 `vaultConfigured`、`vaultActive`、`pending[vault]`；
- 取消 `vaultTranche`、`isTrancheVault`、`getTrancheVaults`；
- 事件删除 tranche 字段：`TrancheVaultAdded/Deactivated/Reactivated` →
  `VaultAdded/VaultDeactivated/VaultReactivated`；`InterestRepaid` 去掉 tranche。

**升级兼容**：经贵方确认，产品尚未正式上线、当前仅在测试网运行，本次连同 UnifiedPool 一起全新部署，
因此原 tranche 的三个存储槽**已直接删除**，不保留占位——没有既有代理存储布局需要迁就。`__gap` 相应
由 47 增至 50，保持本合约预留的存储足迹不变，使这次部署之后的后续升级仍可正常追加字段。

`Tranche` 枚举在 `src/libs/Types.sol` 中已无任何引用，一并删除。产品类型如需展示，由产品参数、
Indexer 或前端元数据维护。


---

## 十、pending 会计口径回退与坏账函数（《审计报告（一）回复》《HyperTessera 审计报告一反馈》）

### 10.1 撤销第一部分第 2 项的修改

贵方复核确认：`pending[vault]` 表示该 Vault 在 UnifiedPool 管理资产中的**账面归属权益**，而不是
UnifiedPool 合约地址当前持有的即时 USDT 现金余额。`operatorTransfer` /
`operatorTransferToRevenuePool` 是把闲置现金配置到经授权的第三方协议或 RWA 资产，属于资产形态
由“现金”向“外部投资头寸”的转换，并未消灭 Vault 对相应管理资产的权益。

据此，第一部分第 2 项“出金时扣减 `pending`”的修改**已全部撤销**：

- `operatorTransfer` / `operatorTransferToRevenuePool` 不再扣减 `pending[vault]` 与 `totalPending`；
- 相应的 `InsufficientPending` 校验一并移除；
- 原本断言扣减语义的测试已作废并重写。

协议在设计上允许管理资产规模与即时可用现金不一致：`distribute` 按 `pending[vault]` 与 UnifiedPool
可用 USDT 的**较小值**执行，仅按实际支付金额扣账本，未满足部分继续留在队列等待外部资产回款。
这属于预期的流动性等待，而非净值高估。

### 10.2 新增坏账函数 `UnifiedPool.writeDownPending`

贵方在《审计报告一反馈》中指出：回复里说“永久损失应通过估值及减值机制调整”，但 UnifiedPool 内
`pending` 的减少**有且仅有 `distribute` 一条路径**，估值/减值机制只存在于 Adapter，而 UnifiedPool
的价值直接由 `pending` 决定（从 Vault 的 `totalAssets` 计算可见）。因此外部投资发生永久损失后，
损失会永远留在净值里。

已按建议新增：

```
UnifiedPool.writeDownPending(address vault, uint256 amount, bytes32 referenceId)
```

- **权限**：该 Vault 的 **VaultTimelock**，与 `BaseVault.writeDownInsolvency` 一致 —— 确认损失是
  治理行为，且必须经延时队列。
- **语义**：外部投资永久损失时下调该 Vault 的账面应收，使 `grossManagedAssets()` 反映真实价值。
- 与 `distribute` 的区别：`distribute` 是**已付款**导致的应收减少，`writeDownPending` 是**确认损失**
  导致的应收减少，两者不可互相替代。

### 10.3 `operatorTransfer` 禁止转入本 Vault 自己的 Adapter

贵方同时提醒：池内资金不能通过 `operatorTransfer` 转到本 Vault 的 Adapter 去盈利，只能走第三方，
否则 Adapter 的 `realAssets()` 与 Vault 的 `pending` 会同时计入 `totalAssets`，形成双算。

已加校验：`operatorTransfer` 的收款地址若是该 Vault 已注册的 Adapter，直接回退。

### 10.4 `writeDownInsolvency` 完全移除 PENDING 申购减记路径

贵方《审计报告（一）回复》第 2 条与待确认问题 1 的结论一致：PENDING 申购尚未结算、未铸份额、
从未进入 Adapter，是用户仍可全额取消退款的**受保护负债**，不应承担投资组合亏损。

已删除 `_writeDownPendingDeposits` 及其在 `writeDownInsolvency` 中的入口。普通投资损失只通过 NAV
与份额价格下降，由实际在场的份额持有人承担。（这也使第一部分第 3 项“减记到 0 形成僵尸请求”的
修复在 PENDING 通道上不再有适用对象。）

### 10.5 《审计报告（一）回复》其余三点的处置

**（1）风险等级重分类。** 贵方建议将“净值高估”从 High 风险漏洞调整为**设计说明 / 会计口径确认**。
我们接受该定性：`pending[vault]` 的口径已按 10.1 回退，并在 `UnifiedPool` 与
`BaseVault.grossManagedAssets` 的代码注释、以及 `docs/function-reference.md` 中写明
“`pending` 是账面归属权益、不等于池内即时现金”，以消除歧义。“投资转出—回款—结算—减值”四段
链路的测试已补齐（`test/UnifiedPool.t.sol` 的 `writeDownPending` 相关用例与账本恒等式用例）。

**（2）待确认问题 3 —— Tranche 仅为分类标签。** 贵方确认 Cash / Note / LP 在当前业务设计中仅用于
链上登记、查询、事件展示及链下识别，**不代表合约内置结构化分层**；各类别之间是否存在差异化收益
分配、本金偿还优先级或亏损吸收顺序，由链下按产品条款计算，再由 Settlement Operator 通过多签结算
结果归属至对应 Vault；UnifiedPool 只负责记录各 Vault 应收金额与执行资金划转，不在链上验证分配
顺序。因此**链上没有 Tranche 瀑布属于既定业务设计，而非功能遗漏**。

这一确认与《合约修复20260825》的结论一致：既然标签不参与任何链上计算，保留它只会造成登记错误并
限制产品扩展，故本轮直接删除（第九部分）。分层信息如需展示，由产品参数、Indexer 或前端元数据维护。

**（3）事件补充字段的请求 —— 已被后续文档取代，未实现。** 贵方在待确认问题 1 中提出，减记相关事件
应补充记录 request owner、减记前后金额、统一减记比例、原因及执行者，以便审计追溯；我们在第四部分
问题 1 第 3 点也回复“建议补充，等客户确认后一并实现”。

其后《writeDownInsolvency 最小化修改方案》（0826）明确要求**不新增事件、不新增 `referenceId` 或
比例字段**，我们据此执行（第八部分）。当前可追溯性依靠：

- `RequestWrittenDown(requestId, haircut, newAmount, timestamp)` —— 减记前金额可由 `haircut + newAmount` 还原；
- `requestId` 可反查 owner（`getDepositRequest` / `getRedeemRequest`）；
- 统一比例可由链下按 `可用于赎回的资产 / reservedRedeemLiability` 自行计算；
- 执行者恒为该 Vault 的 VaultTimelock，且必经延时队列，链上有完整调用记录。

**两份文档在此点上要求相反。经贵方确认，采信较晚的《writeDownInsolvency 最小化修改方案》（0826）：
减记相关事件不作扩充，维持现状。** 第四部分问题 1 第 3 点“建议补充 owner 字段”的提议就此作废，
不再列为待办。


---

## 十一、最终周期与最终兑付重新设计（《最终周期结算及最终兑付补充修改方案》）

**本部分取代第二部分。** 与第二部分的实现相比，改动的是最终周期在**哪个状态**执行、以及份额
持有人如何在到期后拿回本金。

### 11.1 最终周期改在 `SETTLING / CALCULATING` 执行

- 到期时 `startCycleCalculation` 在**同一笔交易内**完成 `OPERATING→SETTLING` 与
  `ACCEPTING→CALCULATING`，并标记该 Cycle 为 final。产品不会出现“已进入 SETTLING 却没有可执行
  Cycle”或“Cycle 已启动但仍接受新业务”的中间态。
- 最终 `completeCycle` 原子进入 `MATURING`，**`SETTLING` 仅此一条出口**。
- **到期前进入 `CALCULATING`、到期后才完成的普通周期不再被提升为最终周期**：它用的是尚未退出的
  账面估值定价。该周期正常完成后原子进入 `SETTLING` 并**新开一个 final Cycle**，由后者在资产实际
  回收后定价。这避免把到期前快照当作最终清算价，也避免事后改变已签名批次的用途。

### 11.2 最终定价前置条件：实际回收后再定价

生成最终快照前要求**全部 Adapter 的 `realAssets()` 与 UnifiedPool 的 `pending` 均为零** —— 即所有
头寸都已变现或已确认为零回收。账面 100 万、实际回收 80 万时，最终价格按 80 万计算，差额由全体
份额持有人按份额承担，**不要求任何运营角色补足**。

### 11.3 份额直接最终领取 `BaseVault.claimFinal`

```
BaseVault.claimFinal(uint256 shares, address owner, address receiver) returns (uint256 assets)
```

- 按冻结的**唯一最终价格**销毁份额领取 USDT；
- 适用于**从未提交过赎回申请**的持有人，以及取消未结算赎回后取回份额的用户；
- `CLAIMING` 起开放，**`CLOSED` 之后继续开放** —— CLOSED 只停止新增业务，不终止领取权；
- 允许分次领取；统一向下取整，领取先后不影响各自权益；
- 仅从 `freeVaultUSDT()` 支付，不侵占申购、已结算赎回与退款负债。

这正是第四部分问题 2 所缺的那条路径，也覆盖 Audit Feedback V2 #1「最后一个周期申购结算成
Share 后无法赎回」。

### 11.4 删除重复确认链路

`confirmFinalSettlement` / `hashFinalSettlementConfirmation` / `completeFinalSettlement` /
`isFinalSettlementComplete` / `enterMaturing` **已从代码库删除**。最终批次本身已由 M-of-N 签名
保护，再确认一次属于重复机制。

### 11.5 最终批次禁止申购结算

新增 `DepositsNotAllowedInFinalBatch`：到期申购会按清算后价格铸份额却已无可投资标的，这些请求
留在队列由用户自行取消取回。

---

## 十二、Audit Feedback V2 十一项 + 《审计报告（二）回复》

### 12.1 逐项处理结果

| # | 风险等级 | 问题 | 处理 |
|---|---|---|---|
| 1 | High | 申购永久锁定 | ✅ 由 `claimFinal` 覆盖（第十一部分，与 V1 待确认问题 2 同根因） |
| 2 | High | BaseAdapter 订单覆盖 | ✅ `pendingDeposits` 键区分订单类型 |
| 3 | High | LiquidityBridge 可伪造金库铸份额 | ✅ 校验 `fromVault` / `toVault` 均为注册金库 |
| 4 | High | RWAToken 无法转出 | ✅ 新增 RWA 转出订单簿 |
| 5 | High | HWM 未初始化 | ✅ 构造函数初始化 `feeHighWaterMark = 1e6` |
| 6 | Medium | TOKEN_RETURN 订单无法更新时效 | ✅ 时效检查仅对 VALUE_RETURN 执行 |
| 7 | Medium | 签名可跨实例/跨链重放 | ✅ `batchHash` 纳入 `address(this)` 与 `chainid` |
| 8 | Low | `deployWrappedToken` 抢注 | ✅ 增加 Governor 校验 |
| 9 | Low | 单一 adapter 约束可绕过 | ✅ `LiquidityEarnVault` override `addAdapter` |
| 10 | Info | `Queue.dequeue` 缺校验 | ✅ 补 `_onlyRegisteredVault` |
| 11 | Info | `recordClaim` 无链上调用方 | ✅ 由 `BaseVault.recordOverdueClaims` 触发 |

> **说明：#2、#4、#6、#11 是后一轮补做的。** 上一轮提交（PR #29）只处理了 #1、#3、#5、#7、#8、
> #9、#10 七项，并在 PR 描述中列出“尚未处理：#2、#4、#6、#11”，但**未写入本文档**，导致贵方从
> 交付文档上看不到这四项的状态。这是我们的文档疏漏，本次一并补齐。

### 12.2 #2 订单覆盖 —— `pendingDeposits` 键区分订单类型

`buyOrder` 与 `rebalanceOrder` 使用两个独立自增序列（`nextBuyOrderId` / `nextRebalanceOrderId`），
但 `executeBuy` 与 `executeRebalance` 都以**原始 orderId** 为键写入 `pendingDeposits` 并
`liveDealOrderIds.push(orderId)`。两个序列都从 0 开始，因此**首个 buy 单与首个 rebalance 单必然
冲突**：后执行者覆盖先执行者的估值，同一个键被 push 两次，`realAssets()` 对它重复累加。

按贵方建议为键引入订单类型区分：

```
buy       deal key = orderId
rebalance deal key = REBALANCE_DEAL_KEY_BASE + orderId    // 2**128
```

订单号自 0 连续自增，永远达不到 2**128，两个键空间不可能相交。`_liveTokenReturnDealValue()` 同步
跳过 rebalance 键（该函数的语义本就是“已执行的 TOKEN_RETURN **买单**”）。

`updateDealData(orderId)` / `clearDealValue(orderId)` 的签名与语义**不变**，仍然只作用于买单，
链下 SDK 与控制面板无需改动。

覆盖测试：`test/BaseAdapter.t.sol::test_executeRebalance_doesNotCollideWithSameNumberedBuyOrder`
（断言买单估值不被覆盖、rebalance 估值独立可读、`realAssets()` 恰好各计一次）。

#### 连带补上：rebalance deal 的刷新 / 清算入口

贵方的建议只要求键区分类型。但键分开之后，`updateDealData` / `clearDealValue` 仍然只经
`buyOrders[orderId]` 解析订单，**rebalance deal 因此没有任何刷新或退场路径** —— 声明为
VALUE_RETURN 的 rebalance 单会在超过时效窗口后卡住 `realAssets()`，与 #6 是同一种失效方式，
只是换了订单类型。经贵方确认，本轮一并补上（**纯加法，不破坏任何现有 ABI**）：

```
updateRebalanceDealData(uint256 orderId, uint256 newValue)   // 该 Adapter 的 Data Provider
clearRebalanceDealValue(uint256 orderId)                     // 该 Vault 的 Allocator
```

- 与买单侧一一对应：`updateRebalanceDealData` 仅接受 VALUE_RETURN 单，
  `clearRebalanceDealValue` 仅接受 TOKEN_RETURN 单，权限与失败模式完全一致；
- 新增两个独立事件 `RebalanceDealDataUpdated` / `RebalanceDealValueCleared`，
  与买单侧的 `DealDataUpdated` / `DealValueCleared` 区分，避免链下按 orderId 误配；
- 现有 `updateDealData` / `clearDealValue` 的签名、语义、事件**均未改动**。

**同时修正一处连带的口径不一致：** `_liveTokenReturnDealValue()` 原本只统计买单。该函数的作用是把
「已交割但尚未 `clearDealValue` 的在途订单成本」从 `RWAAdapter.realAssets` 中扣除，防止订单成本与
Token 市值重复计算。rebalance 单同样可以声明 TOKEN_RETURN 并交割 Token，却被排除在外，会在交割到
清算之间的窗口内产生与买单相同的重复计算。现已改为**按订单声明的 mode 统计，不区分买单与
rebalance 单**。

覆盖测试：`test/BaseAdapter.t.sol` 中 `test_updateRebalanceDealData_*` /
`test_clearRebalanceDealValue_*` 共 7 项，其中
`test_updateRebalanceDealData_doesNotTouchSameNumberedBuyOrder` 断言刷新 rebalance 单不会动到
同号买单，`test_updateRebalanceDealData_refreshesAndClearsStaleness` 断言刷新后
`realAssets()` 从回退恢复为正常返回。

链下 SDK 已同步新增 `updateRebalanceDealData` / `clearRebalanceDealValue` 两个方法。

### 12.3 #4 RWAToken 无法转出 —— 新增受控转出订单簿

`RWAAdapter` 此前只实现 `realAssets` / `_tokenValue` 用于按 `balance × NAV` 估值，自身及基类
`BaseAdapter` **没有任何转移 `rwaToken` 的函数** —— `_deployCapital` / `_recallCapital` 操作的都是
`asset()`（USDT）。因此 RWA Token 一旦交割进 Adapter 即被永久锁定，且因为始终计入 `realAssets()`，
`BaseVault.removeAdapter` 的 `realAssets() == 0` 前置条件也永远无法满足。

按贵方建议增加受控转出路径，**沿用现有订单簿的“Curator 授权 / Allocator 执行”分权**：

```
createRWAWithdrawOrder(uint256 amount, address destination)  // 该 Vault 的 Curator
cancelRWAWithdrawOrder(uint256 orderId)                      // Curator 或 Guardian
executeRWAWithdraw(uint256 orderId)                          // 该 Vault 的 Allocator
```

- 与 `createBuyOrder` 同样拒绝 `destination == address(this)` 与零地址；
- `executeRWAWithdraw` 携带与 `executeBuy` 相同的 Allocator 冻结与暂停闸门（`_onlyAllocator`）；
- 余额不足时 `InsufficientRWABalance(requested, available)`；
- **目的地由 Curator 决定，Allocator 只能按已授权的订单执行** —— 不引入“单一角色即可把 RWA 转到
  任意地址”的新信任面。

资金回流路径：RWA 转给交易对手方 → 对手方支付 USDT → 走既有的 `createSellOrder` /
`executeSell` 回到 Adapter 与 Vault。

覆盖测试：`test/RWAAdapter.t.sol` 中 `test_createRWAWithdrawOrder_*` /
`test_executeRWAWithdraw_*` 共 8 项，其中
`test_executeRWAWithdraw_movesTokensOut_andLetsRealAssetsReachZero` 直接断言转出后
`realAssets()` 归零，即 `removeAdapter` 的前置条件重新可满足。

### 12.4 #6 TOKEN_RETURN 订单时效检查

`realAssets` 此前对 `liveDealOrderIds` 中**所有**条目无差别执行
`block.timestamp - updatedAt > stalenessWindow` 的回退检查，但 `updateDealData` 只允许刷新
VALUE_RETURN 订单，TOKEN_RETURN 订单的 `updatedAt` 仅在 `executeBuy` 时设置一次。因此
TOKEN_RETURN 订单在“已执行、token 未交割”的等待期内既无法刷新、也无法 `clearDealValue`
（后者要求 token 已到），等待期一旦长于时效窗口，`realAssets` 就会回退，连带
`grossManagedAssets` / 定价 / 结算 / 申赎全部瘫痪，且 `removeAdapter` 同样无法执行。

按贵方建议，时效检查**仅对 VALUE_RETURN 订单执行**，TOKEN_RETURN 跳过：VALUE_RETURN 的价值只能
从 `updateDealData` 得知，过期即表示报告值无依据；TOKEN_RETURN 的最终依据是链上可读的 token 余额，
不依赖链下刷新。

该规则按**订单声明的 mode** 判定，不区分买单与 rebalance 单：声明为 VALUE_RETURN 的 rebalance 单
仍然受时效约束。

覆盖测试：`test/BaseAdapter.t.sol::test_realAssets_staleTokenReturnEntry_doesNotRevert`、
`test_realAssets_staleValueReturnRebalance_reverts`，以及改为 VALUE_RETURN 的原
`test_realAssets_staleEntry_reverts`。

### 12.5 #11 `recordClaim` 无链上调用方

`ClaimRegistry.recordClaim` 的授权本身正确（叠加了 `registeredVaults` 校验），但全代码库无任何
合约调用它，`msg.sender == vault` 分支因 Vault 不主动调用而失效，实际只有 curator 能手动登记。

按贵方建议由 BaseVault 在到期宽限期后触发登记：

```
configureClaimRegistry(address registry, uint256 gracePeriod)  // 该 Vault 的 VaultTimelock
recordOverdueClaims(uint256[] calldata requestIds)             // 无权限限制
```

- **接线方式**：`claimRegistry` 与 `claimGracePeriod` 由 `configureClaimRegistry` 于部署后写入，
  与 `setSettlement` / `setUnifiedPool` 一致。**不走构造函数**：ClaimRegistry 在 W3 与 StateManager
  一同部署、早于三个 Vault，把它塞进 `VaultFactory.DeployParams` 会为一个记账钩子再破坏一次该 ABI。
  该选择器已加入 VaultTimelock 的 OWNER 类白名单。
- **触发条件**：`block.timestamp >= maturityTimestamp + claimGracePeriod`，否则
  `ClaimGracePeriodNotElapsed(dueFrom)`；未接线时 `ClaimRegistryNotConfigured`。
- **登记范围**：申购请求处于 `SETTLED` 或 `REFUNDABLE`、赎回请求处于 `SETTLED` —— 恰好是“存在
  未被领走的余额”的三种状态。其余状态（终态、已领取、尚未结算、不存在）逐条**跳过**而非回退整批。
- **去重**：新增 `claimRecorded[requestId]` 标记，重复调用是 no-op 而不是重复写入 —— 这也是贵方
  同时提到的“记录无去重”一并处理。
- **无权限限制**：该记录是只增不减的记账，不移动任何资金、不改变任何请求状态，因此任何人都可以
  把逾期请求推进登记表。这正是为了消除“完全依赖 curator 作为”这一点。

覆盖测试：`test/EarnVault.t.sol` 中 `test_recordOverdueClaims_*` 共 5 项（未接线回退、宽限期未到
回退、Vault 自身成功登记、幂等、无未领余额者跳过）。

### 12.6 两个待确认问题 —— 依《审计报告（二）回复》确认为既定设计，未作修改

**问题 1：EarnVault 同步 deposit 无周期/快照约束。** 贵方确认业务上不存在两套独立定价机制：
`EarnVault` 的同步 `deposit` 并非面向用户开放的另一条申购渠道，而是 **LP Vault 在周期结算中经
LiquidityBridge 把本周期已接受资金注入 Cash Vault 的内部执行步骤**。Settlement 在同一批次中先完成
LP Vault 与 Cash Vault 的价格快照，由 Cash Vault 在 LP 资金进入前计提上一周期业绩费、增发 fee
shares，形成唯一的费后结算价格；LP Vault 按该费后快照价获得 Cash Token，Cash 的申购与赎回也使用
同一价格。同步与异步的区别只在资金路径与执行方式，不在定价基准。

**问题 2：RWAAdapter 的 `realAssets` 中定值与浮动值相减。** 贵方确认

```
realAssets = pending − min(_liveTokenReturnDealValue(), tokenValue) + tokenValue
```

的实际含义是**取“原始订单成本”与“Token 当前市值”中的较大值**，目前做法符合设计，未作修改。

### 12.7 对已部署环境的影响

本部分的 #2、#4、#6、#11 四项修复**晚于 BSC Testnet v8 一代**（commit `c4d4b90`，2026-08-26 部署）。
v8 链上合约不含这四项修复，需重新部署一代方可生效。#11 与 `configureClaimRegistry` 还引入了
VaultTimelock 白名单的新条目，属于构造期写入，同样只能通过重新部署获得。

合约体积影响（`forge build --sizes`，0 violation）：

```
EarnVaultDeployer            23,447 bytes   （余量 1,129，v8 为 2,325）
LiquidityEarnVaultDeployer   23,143 bytes   （余量 1,433，v8 为 2,433）
EarnVault                    21,669 bytes   （余量 2,907）
LiquidityEarnVault           21,287 bytes   （余量 3,289）
```

`EarnVaultDeployer` 的余量因 #11 减少约 1,200 字节，仍为正。后续再往 `BaseVault` 加代码前必须先跑
`forge build --sizes`。

---

## 附录 A：来源文档逐项覆盖对照表

本表列出十二份来源文档中的**每一个可执行条目**及其去向，供贵方逐条核对。
状态含义：✅ 已实现 ／ ↩️ 已实现后又按贵方要求回退 ／ 📋 确认为既定设计、未改代码。

### A.1 《HyperTessera - Audit Feedback - CN - V1》（2026-08-17）

| 条目 | 状态 | 章节 |
|---|---|---|
| 1 缺少白名单校验（Critical） | ✅ | 第一部分 第 1 项 |
| 2 净值高估（High） | ↩️ 已回退 | 第一部分 第 2 项 → **10.1** |
| 3 请求无法结算（Medium） | ✅（PENDING 通道后续整体删除） | 第一部分 第 3 项 → 10.4 |
| 4 缺少暂停检查（Low） | ✅ | 第一部分 第 4 项 |
| 5 扣减账本无募集期限制 | ✅ | 第一部分 第 5 项 / 第六部分 |
| 6 更换池子未处理旧池 pending | ✅ | 第一部分 第 6 项 |
| 7 传参未固定初始状态 | ✅ | 第一部分 第 7 项 |
| 8 未校验金库参数即可开募 | ✅ | 第一部分 第 8 项 |
| 9 抢跑风险 | ✅ | 第一部分 第 9 项 |
| 10 字段未被使用（Info） | ✅ | 第一部分 第 10 项 |
| 待确认问题 1 减记对象正当性 | ✅ | 第四部分问题 1 → 第八部分、10.4 |
| 待确认问题 2 CLAIMING 期退出路径 | ✅ | 第四部分问题 2 → **第十一部分 11.3** |
| 待确认问题 3 tranche 是否为未实现功能 | 📋 既定设计 | 第四部分问题 3 → 第九部分、10.5(2) |

### A.2 《一年期产品最终周期结算与产品参数调整说明》

| 条目 | 状态 | 章节 |
|---|---|---|
| 删除 `firstCycleStart` | ✅ | 第二部分「删除 firstCycleStart」 |
| 最终周期不会被跳过 | ✅（实现方式已于后轮次重做） | 第二部分「最终周期不会被跳过」→ **第十一部分** |

### A.3 《募集上限参数调整建议》

| 条目 | 状态 | 章节 |
|---|---|---|
| `subscriptionCapShare` 并入 `ProductParams` | ✅ | 第三部分 |
| `initSubscriptionCapShare` 仅 StateManager + 仅 CONFIGURING | ✅ | 第三部分 |
| `setSubscriptionCapShare` 收紧为仅 VaultTimelock | ✅ | 第三部分 |

### A.4 《合约修改20260824》（totalSubscribed 记账边界）

| 条目 | 状态 | 章节 |
|---|---|---|
| 运营期取消不再改写募集账本 | ✅ | 6.1 |
| `totalSubscribed` 统一定义为募集期申报统计 | ✅ | 6.2 |

### A.5 《净募集额度修改方案》

| 条目 | 状态 | 章节 |
|---|---|---|
| 新增 `subscriptionCapUsedShares` | ✅ | 7.1 |
| 业绩费增发不占额度、销毁释放额度并取零下界 | ✅ | 7.1 |
| 按批次净额检查 | ✅ | 7.1 |
| `SupplyCapExceeded` 参数改为份额单位 | ✅（接口影响已标注） | 7.2 |

### A.6 《writeDownInsolvency 最小化修改方案》（0826）

| 条目 | 状态 | 章节 |
|---|---|---|
| 签名减为 `writeDownInsolvency(uint256[] settledRedeemIds)` | ✅ | 第八部分 |
| 统一比例由合约计算、不落 storage / 事件 / 入参 | ✅ | 第八部分 |
| 适用边界收紧为固定债权资不抵债 | ✅ | 第八部分 |
| ids 严格递增 + 合计等于 `reservedRedeemLiability` | ✅ | 第八部分 |
| 清算后 `insolvencyLiquidated` 限制集 | ✅ | 第八部分 |
| 不新增事件 / `referenceId` / 比例字段 | ✅ | 第八部分、10.5(3) |
| 资产追回完全链下 | ✅ | 第八部分 |

### A.7 《合约修复20260825》（UnifiedPool 移除 Tranche）

| 条目 | 状态 | 章节 |
|---|---|---|
| `addTrancheVault` → `addVault` | ✅ | 第九部分 |
| `deactivate/reactivateTrancheVault` → 通用接口 | ✅ | 第九部分 |
| 取消 `vaultTranche` / `isTrancheVault` / `getTrancheVaults` | ✅ | 第九部分 |
| 事件删除 tranche 字段 | ✅ | 第九部分 |
| 尚未正式部署 → 直接删除存储槽 | ✅ | 第九部分 |

### A.8 《审计报告（一）回复》

| 条目 | 状态 | 章节 |
|---|---|---|
| 第 1 条 pending 会计口径（撤销扣减） | ↩️ 已按此回退 | 10.1 |
| 第 1 条 风险等级重分类为设计说明 | ✅ 接受 | 10.5(1) |
| 第 2 条 PENDING 完全排除在减记之外 | ✅ | 10.4 |
| 待确认问题 1 非在场用户不承担普通投资损失 | ✅ | 10.4 / 第八部分 |
| 待确认问题 1 事件补充 owner / 比例 / 执行者 | 📋 经确认采信 0826 方案，不扩充 | **10.5(3)** |
| 待确认问题 2 CLAIMING 期由用户直接从 Vault 领取 | ✅ | 11.3 |
| 待确认问题 3 Tranche 仅为分类标签 | 📋 既定设计 | 10.5(2) |

### A.9 《HyperTessera 审计报告一反馈》

| 条目 | 状态 | 章节 |
|---|---|---|
| 增加坏账函数以调整 UnifiedPool 价值 | ✅ `writeDownPending` | 10.2 |
| Pool 资金不得经 `operatorTransfer` 进入本 Vault 的 adapter | ✅ | 10.3 |

### A.10 《最终周期结算及最终兑付补充修改方案》

| 条目 | 状态 | 章节 |
|---|---|---|
| 最终周期改在 `SETTLING / CALCULATING` 执行 | ✅ | 11.1 |
| 到期后完成的普通周期不再被提升为最终周期 | ✅ | 11.1 |
| 最终定价前置：Adapter `realAssets` 与 pending 归零 | ✅ | 11.2 |
| 新增 `claimFinal`，CLOSED 后仍可领取 | ✅ | 11.3 |
| 删除重复确认链路 | ✅ | 11.4 |
| 最终批次禁止申购结算 | ✅ | 11.5 |

### A.11 《HyperTessera Audit Feedback V2(中)》

| 条目 | 状态 | 章节 |
|---|---|---|
| 1 申购永久锁定（High） | ✅ | 12.1 / 11.3 |
| 2 订单覆盖（High） | ✅ | **12.2** |
| 3 任意人可伪造金库铸造份额（High） | ✅ | 12.1 |
| 4 RWAToken 无法转出（High） | ✅ | **12.3** |
| 5 HWM 未初始化（High） | ✅ | 12.1 |
| 6 订单无法更新时间（Medium） | ✅ | **12.4** |
| 7 签名复用（Medium） | ✅ | 12.1 |
| 8 抢注风险（Low） | ✅ | 12.1 |
| 9 唯一性约束可绕过（Low） | ✅ | 12.1 |
| 10 缺少校验（Info） | ✅ | 12.1 |
| 11 `recordClaim` 无链上调用方（Info） | ✅ | **12.5** |
| 待确认问题 1 同步 deposit 定价 | 📋 既定设计 | 12.6 |
| 待确认问题 2 `realAssets` 取值方式 | 📋 既定设计 | 12.6 |
| （连带发现）rebalance deal 无刷新/清算入口 | ✅ 本轮一并补上 | **12.2 末尾** |

### A.12 《审计报告（二）回复》

| 条目 | 状态 | 章节 |
|---|---|---|
| 第 1 条 V2 #1 与 V1 CLAIMING 缺口同根因，按同一方案覆盖 | ✅ | 12.1 / 11.3 |
| 待确认 1 同步 deposit 非第二套定价机制 | 📋 确认 | 12.6 |
| 待确认 2 `realAssets` 取较大值符合设计 | 📋 确认 | 12.6 |

### A.13 此前两项待定，现已定案

| 事项 | 定案 | 章节 |
|---|---|---|
| rebalance deal 的刷新 / 清算入口 | ✅ 本轮补上 `updateRebalanceDealData` / `clearRebalanceDealValue`（纯加法，不破坏现有 ABI），并连带修正 `_liveTokenReturnDealValue` 的统计口径 | 12.2 末尾 |
| 减记事件字段扩充 | 📋 采信较晚的 0826 方案，**不扩充事件**；第四部分问题 1 第 3 点的提议作废 | 10.5(3) |

**本文档目前没有待贵方回复的未决事项。**
