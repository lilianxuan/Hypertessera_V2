# Subscription Cap 重构 — 实施回复

回复贵方文档《HyperTessera | Subscription Cap 重构提案》（三页，修改 1–3）。

| | |
|---|---|
| 分支 | `feat/subscription-cap-share` |
| Pull Request | [#21](https://github.com/alliancechuan/hyperTessera/pull/21) |
| 提交 | `e1f211d`（修改 1）、`e4f87c1`（修改 2+3）、`6f49714`（命名清理）、`13a8e7a`（FIFO 金额语义） |
| 测试 | 955 通过 / 0 失败（`main` 基线 925） |
| 链下 | `npm run typecheck` 无错误；单元测试 105/105 |

三项修改**全部实施**。有三处实现与提案原文存在偏离：第 1 处是等价改写，第 2、3 处是有意保留的设计取舍。第 4 处（FIFO 语义）在初稿中列为偏离，现已补充实现，改列为已实现。全部在第三节逐条说明。

---

## 一、实施内容

### 修改 1 — `subscriptionCap` 改为 `subscriptionCapShare`

- Vault 新增 `subscriptionCapShare`（share 计价，`0` 表示不设上限），代表允许的最大总 share supply。
- 由 `setSubscriptionCapShare` 设置：产品处于 CONFIGURING 时 Curator 直接调用，之后经 `VaultTimelock`。该 selector 已写入 Timelock 构造器的 CURATOR 类白名单，因此**上线后仍可调整**（迁移与应急上调都走这条路）。
- `settle()` 在本期存入铸股、赎回销股、业绩报酬铸股与 LP Bridge 铸股**全部落地之后**检查：

  ```
  totalAssets() <= subscriptionCapShare × settlementPrice / 1e18
  ```

  超限时整批 revert，错误为 `SupplyCapExceeded(limit, actual)`。
- 业绩报酬**无需额外修正项**。`snapshotSettlementPrice` 在计算价格之前先执行 `supply += feeShares`，因此 `settlementPrice` 已是除权后价格，快照的 assets / supply / price 三者自洽 —— 这使得上述 AUM 形式与 `totalSupply() <= subscriptionCapShare` **精确等价**。
- LP Bridge 铸出的 Cash shares 同样计入。旧实现从桥入之前的快照重建 AUM，完全看不到这部分，这是原设计的实质缺口。
- `EarnVault.deposit()`（LiquidityBridge 专用同步入金路径）另设一道 share 形式的关口，覆盖「批次只含 LP Vault、Cash Vault 的 `settle()` 不会被调用」的场景。

### 修改 2 — Cash / Note FIFO 部分接受与退款（含 Cycle 0）

- `StateManager.recordSubscription` 不再因超出募资总额上限而整笔拒绝认购。超额认购现在进入队列，由结算环节定量。
- 每户配额 `walletSubscriptionCap` 保持不变，仍在请求时生效。
- 募资进度 `_totalSubscribed` 继续记账 —— `finalizeSubscription` 依赖它与 `minRaiseAmount` 比较，决定进入 OPERATING 还是 FUNDING_FAILED。
- SUBSCRIBING 期间排队金额不设上限，为有意设计；用户在结算前可随时通过 `cancelRequest` 取回。
- Cycle 0 与常规周期走同一条结算路径，`settle()` 既有的部分接受与退款机制直接适用；零供应量时结算价为 1 USDT/share，与提案一致。
- 结算时的 FIFO 语义由合约强制：一个批次内至多一笔部分成交，且必须是最后一笔，否则以 `PartialFillMustBeLast` 拒绝。未被接受的订单不出现在批次中，保持 PENDING。
- `ProductParams.subscriptionCap` 至此无任何读取方，已删除。**结构体字段数由 11 变为 10**，链下类型定义、脚本与控制面板的位置参数列表均已同步。

### 修改 3 — LP FIFO 部分接受与退款

- `_validateDeposits` 的可结算条件改为 `0 < settleAmount <= request.assets`，与提案原文一致。
- Cash Token 与 UnifiedPool 奖励的 pro-rata 分配权重改为按 `settleAmount` 计算（原按申购原额）。此项必须同步修改：若沿用原额权重，部分成交单不在数组末位时会超额分配并在 Cash Token 转账处失败，位于末位时则被余数分支掩盖而静默错分。
- 未接受部分在同一次 `settle()` 调用内退款给申购人。此项亦为必需：负债已按申购原额扣减，差额若滞留将成为无归属的 vault 资金。
- 每笔请求补发 `DepositSettled(requestId, originalAssets, settledAssets, refundedAssets, cycleNumber, timestamp)`，链下索引器无需改动即可追踪退款。
- 同样受上述 FIFO 金额语义约束：前序 LP order 必须全额桥接，只有末位一笔可部分桥接。
- 效果：桥入总额可精确落在 Cash Vault 的 redeemGap 上。此前一笔大于缺口的 LP order 只能整笔超额桥入或整笔拒绝，而队列的严格 FIFO 又不允许跳过它。

### 共同约束

| 提案约束 | 状态 |
|---|---|
| Note Vault 不涉及 LP Bridge，使用相同的 `subscriptionCapShare × Note settlementPrice` 上限 | 已实现。Note Vault 未覆写 `settle()`，继承同一检查 |
| Cash / LP batch 顺序固定为 `[LP, Cash]` | 见偏离 2 |
| 任何最终 cap 检查失败都应使整个 batch 原子 revert | 见偏离 3 |

---

## 二、逐条对照

| 提案条目 | 状态 |
|---|---|
| 以 share 数量定义发行上限，每期按结算价换算 AUM | 已实现 |
| `maxAUM = subscriptionCapShare × settlementPrice / 1e18` | 已实现，公式原样 |
| Cash Vault 在 LP Bridge、deposit、redeem 全部处理后再检查 | 已实现 |
| Curator 设置 `subscriptionCapShare` | 已实现 |
| 最终 total supply 须含 deposit mint、performance fee mint、LP Bridge mint | 已实现，三者均计入 |
| `subscriptionCapShare` 仅作为最终 settlement 的上限 | 已实现 |
| Cycle 0 结算价 1 USDT/share | 已实现 |
| Cash / Note 临界订单部分接受、未接受部分退款、后续订单保持 pending | 已实现 |
| LP 可结算条件改为 `0 < settleAmount <= request.assets` | 已实现，原文照做 |
| LP 临界订单部分桥接、余数退款、后续 pending | 已实现 |
| Note Vault 使用相同上限 | 已实现 |
| `projectedAUMAfterSettlement` 的计算方式 | 偏离 1（等价改写） |
| batch 顺序固定为 `[LP, Cash]` | 偏离 2 |
| cap 检查失败使整批原子 revert | 偏离 3 |
| 每次 settlement 按 maxAUM 剩余额度严格处理 FIFO | 已实现（形态由合约强制，额度数值由链下决定，见第三节偏离 4） |

---

## 三、与提案原文的四处差异

### 偏离 1 — `projectedAUMAfterSettlement` 改为读取实时状态

**提案原文**：`projectedAUMAfterSettlement = 期初 Cash AUM + 接受的 Cash deposits + LP Bridge 转入 USDT - 接受的 Cash redeems`

**实际实现**：在 `settle()` 末尾直接读取实时 `totalAssets()`。

**原因**：两者数学上完全等价 —— 该时点上本期的存入铸股、赎回销股、报酬铸股与桥入均已落地，实时值即为终值。但重建式需要把桥入金额作为参数一路传进 `settle()`（当前它不是参数），且正确性依赖「每一项都没漏算」；读取实时状态不依赖任何加总假设，也不依赖批次内的执行顺序。

**影响**：无。数值结果相同，且边界测试同时断言了 AUM 口径与 share 口径在临界点一致。

---

### 偏离 2 — `[LP, Cash]` 顺序未在链上强制

**提案原文**：Cash / LP batch 顺序固定为 `[LP, Cash]`，保证 LP Bridge 先到账。

**实际实现**：该顺序作为结算运维规则记载于《Settlement Operator runbook》§1、§2，合约不强制。

**原因**：

1. `Settlement` 合约对 vault 类型完全无感知，仅依赖 `IBaseVault` 接口。要识别哪一项是 LP Vault，只能对每个 vault 逐一探测 `cashVault()` 并捕获失败 —— 每笔结算的永久 gas 成本，且把通用结算层耦合到一个具体 vault 类型上，同时排除未来多 tranche 批次的可能。
2. **顺序错误不会造成静默损失。** 费用隔离与 LP 铸股定价均来自两阶段拆分，与数组顺序无关（已有测试 `test_feeIsolationHoldsUnderReversedArrayOrder` 固化）。顺序只决定桥入 USDT 是否赶得上为 Cash 赎回供资 —— 顺序错误时 Cash 的 `settle()` 以 `InsufficientSettlementLiquidity` revert，是一次失败的批次而非一次错误的定价。

**影响**：错误顺序仍会导致整批失败，只是错误类型不同。运维手册已将其列为签署批次前的检查项。

---

### 偏离 3 — 原子回滚在 Cash Vault 参与该批次时成立

**提案原文**：任何最终 cap 检查失败都应使整个 batch 原子 revert。

**实际实现**：当 Cash Vault 在批次内时成立。若提交只含 LP Vault 的批次，且此时 Cash Vault 已处于 CALCULATING，桥入铸股不会被当场拒绝。

**cap 不会因此失效。** `StateManager` 中周期状态仅有三处写入，且 `completeCycle` 仅可由 `Settlement` 调用 —— 处于 CALCULATING 的 Vault 必须经过一次 `settle()` 才能结束本周期，而那次结算会以已包含桥入资金的终态执行 cap 检查。

**原因**：`EarnVault.deposit()` 的关口在本 Vault 处于 CALCULATING 时让路，是因为桥入发生在本周期赎回销股**之前**。而「LP 桥入资金为 Cash 赎回供资」正是该桥存在的目的，净赎回周期中的短暂超额属于正常现象；若无条件拦截，将例行性地拒绝合法批次。

**影响**：这是一个活性代价而非正确性缺口 —— 超额会在 Cash Vault 的该次结算中被发现，该周期停留在 CALCULATING，直至经 Timelock 上调 cap 后方可结束。此行为已由测试 `test_capShare_calculatingOvershootIsCaughtLateAndWedgesTheCycle` 固化，并写入运维手册 §1 作为「拆分批次」的第二项后果。

---

### 偏离 4 — FIFO 语义已补充实现，仅额度数值仍由链下决定

**提案原文**：每次 settlement 按 maxAUM 剩余额度严格处理 FIFO：前序订单全额接受；临界订单部分接受；未接受部分退款；后续订单继续保持 pending。

**初稿状态**：该项在本文档初稿中列为偏离 —— 当时合约只保证被结算请求的**集合**是 FIFO 前缀（`Queue.dequeue` 强制按队列头部顺序出队），但不约束**金额**。对队列前三笔给出 50% / 100% / 100% 可以通过当时的全部检查，这违反了「前序订单全额接受」。

**现已补充实现**（提交 `13a8e7a`）。合约现在保证三件事：

1. **集合是 FIFO 前缀** —— `Queue.dequeue` 越序即 revert（`OutOfOrderDequeue`）。
2. **金额符合前缀语义** —— `settle()` 拒绝任何非末位的部分成交，错误为 `PartialFillMustBeLast(requestId)`。由于数组顺序即队列顺序，且未被接受的请求根本不出现在数组中，「至多一笔部分成交且其后不再成交」等价于「只有最后一项可以部分成交」。Cash / Note 与 LP 两条路径均已加入该检查。
3. **终态不超上限** —— `SupplyCapExceeded`。

此项使存入侧与赎回侧行为一致：部分成交的赎回本就不进入 `fullyClearedRedeemIds`、不出队、停留在队列头部，其后任何赎回出队都会触发 `OutOfOrderDequeue`；存入侧此前没有对应机制，是因为存入请求的 id 在批次开始时即一次性全部出队。

**仍在链下的部分**：剩余额度对应的**具体数值**。结算 Operator 在同一批次中需同时满足数个相互耦合的约束 —— cap 余量、`InsufficientSettlementLiquidity`（接受赎回不得超过接受申购加自由 USDT）、`UnifiedPool.availableToDistribute`、以及将 LP 桥入量对准 Cash 的 redeemGap。这些约束跨越同一批次中的两个 Vault，逐 Vault 的链上规则看不到另一个 Vault 的状态。此外，链上确定性定量会移除现有的退款失败缓解手段（申购人地址被冻结时，将该请求改为全额接受或移出批次）。

**影响**：提案描述的「前序全额接受 / 临界订单部分接受 / 未接受部分退款 / 后续订单保持 pending」四项语义现已全部由合约强制，违反即 revert。Operator 保留的裁量权仅限于「接受不超过额度上限的多少」—— 例如为满足赎回供资约束而少接受一些 —— 但无法违反 FIFO 顺序或上述金额语义。

**贵方提案中的两个算例均符合该规则**：Cycle 0 例中 Carol 为批次内最后一笔且部分接受、Dave 不在批次内；LP 例中 Bob 为最后一笔且部分桥接。

---

## 四、部署前须知

1. **`subscriptionCapShare` 默认为 `0`，即不设上限。** 部署脚本中没有设置该值的步骤，Curator 必须在开放认购前显式设置一次，否则上限形同虚设。
2. **`ProductParams` 已由 11 个字段变为 10 个。** 所有构造该结构体的调用方需同步，包括控制面板的位置参数输入。仓库内的链下代码与面板已同步。
3. **`control-panel/standalone.html` 需重新打包。** 该文件是 `bundle.sh` 的发布产物，内联了旧的 ABI 形状；打包过程需要外网访问，建议在部署时与 `config.js` 一并重新生成。
4. 本次修改涉及 `StateManager`，而 Vault 与 StateManager 的绑定在构造时确定、不可变更，因此需要全量重新部署。

---

## 五、小结

提案的三项修改及其共同约束已全部实施，其中 FIFO 语义在本文档初稿之后补充了链上强制。

仍与提案原文存在差异的是两处设计取舍：

- **偏离 2**（`[LP, Cash]` 顺序不在链上强制）—— 强制需要对每个 vault 逐一探测类型，成本永久且会排除未来多 tranche 批次，而顺序错误本就会导致批次失败，不会造成静默损失。
- **偏离 3**（原子回滚在 Cash Vault 参与批次时成立）—— 无条件拦截会例行性拒绝合法的净赎回批次；cap 本身不会失效，代价是活性而非正确性。

我方建议维持这两处现状。若贵方认为需要调整，请告知，我们会评估具体方案与影响。
