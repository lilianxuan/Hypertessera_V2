# Adapter 通用资产退出及回款订单实现说明（2026-08-28）

对应文档：《Adapter 通用资产退出及回款订单修改方案》（2026-08-28）。

本次修改与《Audit Feedback V3》四项审计修复分属两次提交，互不依赖。审计修复见
`docs/audit-feedback-v3-response.md`。

> **这是不兼容的 ABI 变更。** `createSellOrder` 的签名完全改变，`sellOrders` 的返回结构改变，
> 整套 Rebalance 与 RWA Withdraw 接口被删除。前端、Indexer、控制台、链下 SDK 必须同版本升级；
> 现有已部署合约需重新部署。

---

## 一、原 Sell Order 的问题（我们确认全部成立）

原 `createSellOrder(amount)` / `executeSell(orderId)` 实际上并没有出售任何资产：
它只是通过 `_recallCapital` 从 **Allocator 自己的钱包** 扣取 USDT 转入 Adapter。由此产生：

- Allocator 被放进资金托管路径，必须持有 USDT 并授权 Adapter；
- 外部回款必须先进入 Allocator 钱包；
- 订单不记录退出资产、数量、交易对手，也不识别被退出的原投资头寸；
- 因此 `executeSell` 无法减少 `dealValue`，回款 USDT 与原投资估值在 `realAssets()` 中重复计入，
  直到 Data Provider 手动把该 Deal 写成 0；
- 没有付款状态、到期时间与退款机制；
- 函数名称与实际功能不符。

原 `test_sellProceedsAndStaleDealOverlapUntilDataProviderWritesDown` 这条测试就是把这个重复
计价的时间窗当作已知缺陷钉住的。它已改写为
`test_sellRetiresTheDealInTheSameCallAsThePayout`，断言重复计价的窗口现在根本不存在。

---

## 二、新的通用 Sell Order

放在 `BaseAdapter`，所有 Adapter 继承，是协议**唯一**的资产退出路径。

### 2.1 订单字段

```solidity
struct SellOrder {
    address exitAsset;          // 退出资产；address(0) = 无链上 Token（VALUE_RETURN 退出）
    uint256 exitAmount;         // 退出资产数量，按该 Token 自身精度
    uint256 proceeds;           // 应收回款，以 Adapter 的 asset() 计价
    address payer;              // 唯一被接受的付款地址
    address assetRecipient;     // 退出资产接收地址
    uint256 dealKey;            // 关联的投资头寸；仅当 hasDeal 为真时有意义
    bool    hasDeal;            // dealKey 为 0 是合法的 Buy key，所以有效性需要独立标志
    uint256 dealValueReduction; // 执行时冲减的 dealValue
    uint256 expiry;             // 到期时间
    SellOrderStatus status;
}

enum SellOrderStatus { NONE, CREATED, FUNDED, EXECUTED, CANCELLED, REFUNDED }
```

按方案要求 **不支持部分付款**：部分资产退出通过创建金额较小的独立 Sell Order 表达。

### 2.2 两类头寸标识

| 头寸类型 | 标识方式 | 退出时如何反映 |
|---|---|---|
| Deal 计价（`pendingDeposits` / `dealValue`） | `hasDeal = true`，`dealKey` 指向真实存活的 Deal | 执行时冲减 `dealValueReduction`，减到 0 则移出 `liveDealOrderIds` |
| Token 余额计价（RWAAdapter 的 NAV × balance） | `exitAsset` / `exitAmount` | Token 转出后余额下降，`realAssets()` 自行重新计价 |

两者可以并用：Token 余额计价的资产若仍有未清理的在途 Buy Deal，同一张 Sell Order 可以同时
设置 `hasDeal` 顺手清掉残留估值。

### 2.3 执行流程

```
Curator createSellOrder  →  CREATED（预留退出资产与 Deal 额度）
交易对手 fundSellOrder    →  FUNDED（回款直接进入 Adapter 并锁定）
Allocator executeSell     →  EXECUTED（冲减 Deal / 转出 Token，解除锁定）
```

**回款不经过 Allocator。** 交易对手用标准 ERC-20 授权后直接调用 `fundSellOrder(orderId)`，
Adapter 用余额差值校验实收金额（防止 fee-on-transfer 代币少付却被标记为 FUNDED）。
普通 ERC-20 直接转账不携带订单 ID、无法自动匹配，因此不予接受 —— 允许它就等于要求
Curator 按链上转账记录人工确认，安全性与自动化程度都更差。

创建时的检查：地址与金额有效、退出资产属于该 Adapter 认可的范围、可退出余额足够、
关联 Deal 真实存在且剩余价值足够、到期时间晚于当前时间。
既不交付 Token 又不冲减 Deal 的订单会被拒绝 —— 它什么也没退出，却仍会收走交易对手的钱。

### 2.4 各 Adapter 的可退出资产范围

`BaseAdapter` **默认拒绝一切 Token**（`_validateExitAsset` / `_deliverExitAsset` 直接 revert
`ExitAssetNotSupported`）。这是方案第五节“BaseAdapter 不得直接允许任意 Token 转出”的落地方式：
子 Adapter 不主动放开，就只能做无 Token 的 Deal-only 退出。

| Adapter | 可退出资产 |
|---|---|
| `RWAAdapter` | 仅构造时绑定的 `rwaToken` |
| `FirstPeriodAdapter` | Curator 配置的 `exitableAssets` 白名单（新增 `setExitableAsset`，Curator-class Timelock 门控；拒绝把 `asset()` 自身列入） |
| `LiquidityAdapter` | 不声明任何可退出资产，因此无法创建带 Token 的 Sell Order；LP→Cash 桥接流程完全未改 |

`FirstPeriodAdapter` 需要白名单而非固定绑定，是因为它的投资标的由 Curator 决定，可售集合
必须可配置；但仍然是显式白名单而非“任意 Token”。对 VALUE_RETURN 等无链上 Token 的投资，
用 `exitAsset == address(0)` 退出，只有 Deal 价值移动 —— Data Provider 不再需要另外把已退出的
Deal 更新为 0。

### 2.5 资产与 Deal 预留

```solidity
mapping(address token => uint256) public reservedExitAmount;
mapping(uint256 dealKey => uint256) public reservedDealValue;
```

创建订单时预留，执行、取消、退款时释放。可用量恒为
`实际余额 − 其他未完成订单预留量`、`Deal 剩余价值 − 其他订单已预留退出价值`。

这样可以防止：同一批 Token 被多个 Sell Order 重复出售；同一个 Deal 被多次全部退出；
订单付款后因资产已被其他订单转出而无法交付。

### 2.6 取消与退款

| 情形 | 调用者 | 结果 |
|---|---|---|
| CREATED 订单取消 | Curator 或 Guardian | 释放预留，转 `CANCELLED` |
| FUNDED 订单取消 | Curator 或 Guardian | **强制退款给原付款地址**，转 `REFUNDED` |
| 到期未执行 | **付款人自己** | 退款给原付款地址，转 `REFUNDED` |
| EXECUTED 订单 | —— | 不可取消、不可退款 |

FUNDED 订单不存在“取消但保留交易对手资金”这个选项。到期退款刻意不由 Curator 或 Allocator
把关：已经付款的交易对手必须能在不依赖违约方的前提下取回自己的钱。

退款与降风险型取消在 Vault 暂停时仍可执行 —— 停机不应把交易对手的钱困在合约里。

### 2.7 资产计价与 recall 上限

```solidity
uint256 public lockedProceeds;   // FUNDED 订单持有的交易对手资金
```

订单处于 FUNDED 状态时，Adapter 同时持有原投资资产和回款资产。若两者都计价，就是把同一笔
经济价值算了两次。因此 `lockedProceeds` 从 `realAssets()` 中扣除，直到 `executeSell` 把原头寸
退役后才开始计入。

价值变化路径：`原投资资产价值 → 锁定回款（不计价）→ Adapter 可用回款资产`。

`recallAdapter` 走 ERC-4626 `withdraw`，因此 `BaseAdapter._withdraw` 增加了硬上限：
可提取金额不得超过 `实际余额 − lockedProceeds`，否则 revert `ProceedsLocked`。

> 这条检查**不能**由继承来的 `maxWithdraw` 顶替。`maxWithdraw` 算的是份额价值
> （`convertToAssets(balanceOf(owner))`，由 `totalAssets()` 驱动），而这条算的是流动性。
> 持有存续 Deal 的 Adapter，份额价值远高于它能实际拿出的现金，所以一笔提取完全可能低于
> `maxWithdraw` 却仍在动锁定回款。测试 `test_recall_cannotTakeLockedProceeds` 就是构造这个
> 场景（份额价值 1_500e6，可用现金 500e6）钉住的。

退出价格与原账面价值的差额，在 `executeSell` 执行时体现为投资盈亏，且只体现一次。

---

## 三、删除 RWA Withdraw Order

从 `RWAAdapter` 删除：`rwaWithdrawOrders`、`nextRwaWithdrawOrderId`、
`createRWAWithdrawOrder()`、`cancelRWAWithdrawOrder()`、`executeRWAWithdraw()`、
`RWAWithdrawOrderCreated` / `RWAWithdrawOrderExecuted` / `RWAWithdrawn` 三个事件、
`InsufficientRWABalance` 错误，以及对应接口、测试与文档。

删除理由（与方案一致）：它可以在完全没有回款的情况下直接转出 RWA，绕过 Sell Order
“先付款、后交付”的规则；同一种 RWA 存在两套订单和状态；两套订单需要共享资产预留，
显著增加复杂度；无回款转出会导致 RWA 余额下降却没有对应回款和 Deal 处理。

RWA 退出统一为：`交易对手支付 USDT → RWAAdapter 锁定 USDT → Allocator 执行 Sell →
RWA Token 转给交易对手`，`realAssets()` 按剩余余额与 NAV 自行重新计算。

如未来确实需要无回款的紧急资产迁移，应另行设计 Governance 级紧急迁移机制，不纳入本次
普通业务流程。

---

## 四、删除 Rebalance 体系

从 `BaseAdapter` / `IAdapter` 删除：`createRebalanceOrder()`、`executeRebalance()`、
`cancelRebalanceOrder()`、`rebalanceOrders`、`nextRebalanceOrderId`、
`updateRebalanceDealData()`、`clearRebalanceDealValue()`、`_recallCapitalFrom()`、
`REBALANCE_DEAL_KEY_BASE`、`_rebalanceDealKey()`、`_isRebalanceDealKey()`、
Buy Deal 与 Rebalance Deal 的 Key 判断逻辑、相关事件，以及对应接口、测试与文档。

删除后 Deal 生命周期统一为：**Buy 创建 Deal → 持续计价 → Sell 减少或关闭 Deal**。
由于只剩一条 id 序列写入 Deal 账本，Audit Feedback V2 #2 引入的双 keyspace 偏移不再需要，
`dealKey` 就是 Buy 订单的 `orderId`。

### 替代流程

**同一 Adapter 内再平衡**：Sell Order 退出旧资产 → 回款成为 Adapter 可用资金 →
Buy Order 投入新目标。资金路径 `旧资产 → Adapter 回款资产 → 新投资资产`，全程不出 Adapter。
测试：`test_rebalanceViaSellThenBuy_retiresOldDealAndOpensNew`，断言旧 Deal 归零且
`realAssets()` 只有一份头寸的价值。

**不同 Adapter 之间再平衡**：原 Adapter 执行 Sell Order → `recallAdapter()` 调回 Vault →
`fundAdapter()` 调入目标 Adapter → 目标 Adapter 执行 Buy Order。

**部分再平衡**：用较小金额的 Sell Order 退出部分旧资产、冲减部分旧 Deal 价值，剩余回款留在
Adapter 或调回 Vault。

**原子 Swap 例外**：未来某个 Adapter 若需接入 DEX 做原子兑换，应由该子 Adapter 实现专用
Swap（输入/输出 Token、输入金额、最小输出、滑点限制、交易截止时间、指定 Router），
不应继续用通用转账对模拟原子兑换 —— 原 Rebalance 恰恰一项都没有。

---

## 五、验收要求逐条对照

| 方案第十二节要求 | 落地方式 |
|---|---|
| 外部回款不经过 Allocator | `fundSellOrder` 由 `payer` 直接调用；`test_sellOrder_counterpartyPaysAdapterDirectly_allocatorNeverHoldsProceeds` 断言 Allocator 余额为 0 |
| Allocator 不需持有或授权 USDT | `_recallCapital` / `_recallCapitalFrom` 已删除，Adapter 不再从 `msg.sender` 拉款 |
| 未足额付款不能执行 Sell Order | `executeSell` 要求 `status == FUNDED`；`test_executeSell_beforePayment_reverts` |
| Sell Order 必须识别真实投资头寸 | 既无 Token 又无 Deal 的订单被拒；`test_createSellOrder_neitherTokenNorDeal_reverts` |
| Deal 计价资产必须关联真实 Deal | `DealNotLive` 检查 |
| Token 余额计价资产必须限制为子 Adapter 认可的 Token | `_validateExitAsset` 默认全拒；`test_createSellOrder_unlistedToken_reverts`、`test_rwaSell_rejectsAnyTokenButRwaToken` |
| 同一资产和 Deal 不能重复预留 | `reservedExitAmount` / `reservedDealValue`；`test_createSellOrder_tokenReservationBlocksOverselling`、`test_createSellOrder_dealReservationBlocksASecondFullExit`、`test_rwaSell_reservationBlocksASecondOrderOverTheSameTokens` |
| Sell 执行后自动减少 Deal 价值或通过 Token 余额变化反映退出 | `test_executeSell_reducesDealValue_noDoubleCounting`、`test_rwaSell_paymentFirstThenDelivery_andRealAssetsFollowsBalance` |
| 锁定回款不能被提前调回 Vault | `_withdraw` 的 `ProceedsLocked` 上限；`test_recall_cannotTakeLockedProceeds` |
| 过期未执行订单能够退款 | `refundSellOrder`；`test_refundSellOrder_afterExpiry_byPayerAlone` |
| 退款只能返回原付款地址 | `_refundSellOrder` 只转给 `o.payer` |
| 付款至执行期间不会重复计算资产 | `lockedProceeds` 排除在 `realAssets()` 外；`test_executeSell_reducesDealValue_noDoubleCounting` 逐阶段断言 |
| RWAAdapter 不再保留普通 RWA Withdraw Order | 整套已删除 |
| RWA Token 正常退出统一使用 Sell Order | `test_rwaSell_*` 系列 |
| 合约不再要求 Rebalance source 地址授权 Adapter | Rebalance 已删除 |
| 合约不再保留通用 Rebalance 订单体系 | 同上 |
| 同一 Adapter 再平衡可通过 Sell + Buy 完成 | `test_rebalanceViaSellThenBuy_retiresOldDealAndOpensNew` |
| 不同 Adapter 再平衡可通过 Sell + recallAdapter + fundAdapter + Buy 完成 | 各环节均有独立覆盖（`test_recall_cannotTakeLockedProceeds` 覆盖 recall 侧，`VaultAdapterFunding` 覆盖 fundAdapter/recallAdapter） |
| 删除后不影响现有 LP 至 Cash Vault 桥接流程 | `LiquidityAdapter` 未改；`LiquidityBridge` / `LiquidityEarnVault` 测试全绿 |

---

## 六、链下与前端

- `offchain/src/sdk.ts`：`createSellOrder` 改为参数对象；新增 `fundSellOrder`、
  `refundSellOrder`、`reservedExitAmount`、`reservedDealValue`、`lockedProceeds`、
  `setExitableAsset`；删除 `createRebalanceOrder`、`executeRebalance`、
  `cancelRebalanceOrder`、`updateRebalanceDealData`、`clearRebalanceDealValue`。
- `control-panel/`：Adapter 面板改为新的 Sell Order 表单，删除 Rebalance 条目；
  ABI 已重新生成（`abis.json` / `abis.js`）并重新打包 `standalone.html`。
- `docs/module-e-event-whitelist-proposal.md`：事件白名单已更新。
  Indexer 必须把 `SellOrderFunded` 当作独立阶段处理 —— **已创建 ≠ 已付款，已付款 ≠ 已交付**。
  `OrderCancelled` 的 `orderType` 现在只有 0=buy、1=sell。

> **仍待同步：`hyperTessera-web/`**（前端 Workbench）在本仓库中被 `.gitignore` 排除，是独立
> 的工作副本，本次未改动。它的
> `src/workspaces/sdk/currentAdapter.js`、`src/workspaces/components/AllocatorOrderBook.jsx`、
> `src/workspaces/core/curatorOrders.js`、`src/integrations/hypertessera/upstream/`（vendored SDK
> 与 ABI）以及 `src/i18n/{en,zh-CN}.js` 都引用了已删除的 Rebalance / RWA Withdraw 接口，
> 需要在其自身仓库中同版本升级，否则将无法与新合约交互。

---

## 七、验证

`forge test` 全部通过；`offchain` 包 `tsc --noEmit` 通过；ABI 已重新生成并与控制台、链下 SDK 同步。
