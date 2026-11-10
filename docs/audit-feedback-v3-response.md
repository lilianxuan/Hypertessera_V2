# Audit Feedback V3 实现说明（2026-08-28）

对应文档：

| # | 文档 | 本文对应章节 |
|---|---|---|
| 1 | 《HyperTessera Audit Feedback V3(中)》（2026-08-26，4 项） | 全文 |
| 2 | 《HyperTessera 审计问题 1 至问题 3 回复及修改方案》（2026-08-28） | 第一、二部分 |

审计第 4 项不在贵方回复文档覆盖范围内，按审计建议直接修复，见第三部分。

《Adapter 通用资产退出及回款订单修改方案》属于独立的架构重构（通用 Sell Order、删除 RWA
Withdraw Order 与 Rebalance 体系），不与本轮审计修复混在同一次提交，另行交付。

验证结果：`forge test` **1026 项全部通过**（本轮新增 12 项）。链下 SDK `tsc --noEmit` 通过。

> **这是不兼容的变更。** UnifiedPool 新增两个存储映射与两个 Governor 入口，
> `operatorTransfer` / `operatorTransferToRevenuePool` 的调用者角色改变，`claimRedeem` 的受理
> 条件与 `settledAssets` 的语义改变。现有已部署合约不会自动获得这些修改，需重新部署，
> 前端、Indexer、结算脚本必须同版本升级。

---

## 一、问题 1 与问题 2 —— UnifiedPool 挪用风险与恶意金库诈骗风险

### 1.1 采纳的方案

完全按贵方回复文档执行：**不限制 `deployVault()`**，改为由治理控制共享资金池的准入。

任何人仍可通过 `VaultFactory` 创建 Vault；通过 `VaultFactory` 创建只代表使用了标准合约，
不代表获得协议背书，也不再自动获得使用官方 UnifiedPool 的权限。

### 1.2 两类 Governor 白名单

`UnifiedPool` 新增两个映射与两个 GOVERNOR_ROLE 入口：

```solidity
mapping(address => bool) public vaultWhitelisted;
mapping(address => bool) public settlementWhitelisted;

function setVaultWhitelisted(address vault, bool allowed) external;      // GOVERNOR_ROLE
function setSettlementWhitelisted(address settlement, bool allowed) external; // GOVERNOR_ROLE
```

事件：`VaultWhitelistUpdated`、`SettlementWhitelistUpdated`。
错误：`VaultNotWhitelisted(address)`、`SettlementNotWhitelisted(address)`。

Settlement 白名单允许同时配置多个地址，以兼容不同 Settlement 合约及后续版本迁移。

原有的 `addVault` / `vaultConfigured` / `vaultActive` 保持不变，语义上区分为两层：
`addVault` 由 Vault 自己的 Owner 调用，表示“该 Vault 希望使用本池”；白名单由 Governor 调用，
表示“协议允许它使用”。两者都满足才能进入资金归属与划拨路径。

### 1.3 资金流入保持开放

`repayInterest()` 与 `repayPrincipal()` 继续允许任何地址调用，未加任何白名单检查。

理由与贵方文档一致：资金流入只增加实际资金及 `unattributedInterest` /
`unattributedPrincipal` 记录，不会自动增加任何 Vault 的 `pending`，也不会自动计入任何 Vault 的
`totalAssets()`。安全控制设置在后续的资金归属与资金转出环节。

### 1.4 严格限制资金归属

`attributeInterest()` 与 `attributePrincipal()` 现在同时检查：

| 检查 | 实现 |
|---|---|
| Vault 已在 StateManager 注册 | `_onlySettlementOperator` → `_onlyRegisteredVault`（原有） |
| 调用人是该 Vault 当前 Settlement 中的有效 Operator | `_onlySettlementOperator`（原有） |
| Vault 已 configured 且 active | `_requireConfiguredActive`（原有） |
| **Vault 位于 Governor 的 Vault 白名单** | `_requireApproved`（新增） |
| **Vault 当前使用的 Settlement 位于 Settlement 白名单** | `_requireApproved`（新增） |
| 归属金额不超过相应 unattributed 余额 | 原有 |

`_requireApproved` 两项检查缺一不可：白名单内的 Vault 随时可以把 `settlement()` 指向别处，
只查 Vault 会让它换上攻击者控制的 Settlement 再自任 Operator。

`receiveVaultPrincipal()` 同样增加了这两项检查。

**这条就是堵住问题 2 的地方**：未获批准的 Vault 无法增加 `pending`，
也就无法虚增 `totalAssets()` 与 Share 价格，恶意金库无法制造高净值假象。

### 1.5 保持现有 Vault 划拨规则

`distribute()` 按 `pending` 与实际可用现金处理、并向对应 Vault 转账的算术完全未改，
仅增加准入检查：目标 Vault 在 Vault 白名单内，且其当前 Settlement 在 Settlement 白名单内。

### 1.6 第三方转账改为 Governor-only

```solidity
function operatorTransfer(address vault, address recipient, uint256 amount, bytes32 referenceId) external;         // 原 Settlement Operator → 现 GOVERNOR_ROLE
function operatorTransferToRevenuePool(address vault, address revenuePool, uint256 amount, bytes32 referenceId) external; // 原 Settlement Operator → 现 GOVERNOR_ROLE
```

这两个函数是唯一“把现金移出池子而不减少任何账面记录”的路径，谁能调用它们，谁就能取走支撑
所有 Vault 的共享现金。Settlement Operator 是每个 Vault 各自持有的在线签名密钥，不应触及此处。

`vault` 参数保留：转账仍需记在某个 Vault 的头寸下供链下对账，只是它不再是授权依据。
`_onlyRegisteredVault(vault)` 仍然执行，避免记账引用写成任意地址。
`RecipientIsVaultAdapter` 的防重复计价检查保持不变。

Settlement Operator 保留的权限：资金归属（`attributeInterest` / `attributePrincipal`）、
结算签名及正常结算流程。即使单个 Operator 私钥被盗，也无法把 UnifiedPool 资金转往第三方。

### 1.7 存储布局

新增两个映射，`__gap` 由 50 缩减为 48，合约保留槽位总量不变。本池为全新部署，
不存在需要保留的既有代理存储布局。

### 1.8 部署脚本

`Deploy.s.sol` 的 W3 阶段在 `addVault` 之后写入三个 Vault 的白名单；W4 阶段在
`setSettlement` 之后写入 Settlement 白名单（归属与划拨检查的是 Vault **当前的**
`settlement()`，所以必须等 Settlement 合约存在后才能配置）。

---

## 二、问题 3 —— 部分成交的赎回请求在清算后无法领取

### 2.1 `settledAssets` 的定义调整

由“跨周期累计已预留金额”改为：**已经成交并形成兑付义务、但用户尚未领取的稳定币金额**。
每次部分成交继续累加，用户领取后清零。

`reservedRedeemLiability` 始终等于全部未领取 `settledAssets` 之和，这一不变量在成交、
领取、减记三条路径上都成立。

### 2.2 `claimRedeem()` 的受理条件

现在接受两类请求：

- 已全部成交的 `SETTLED` 请求；
- `QUEUED` 且 `settledAssets > 0` 的部分成交请求。

领取处理顺序（状态与负债先于转账，杜绝重复领取与重入）：

1. 记录并清零本次 `settledAssets`；
2. 等额减少 `reservedRedeemLiability`；
3. 按下表更新请求状态；
4. 向 `receiver` 转账。

领取后的状态：

| 情形 | 结果 |
|---|---|
| `QUEUED`，仍有 `remainingShares`，正常经营期 | 保持 `QUEUED`，**原 FIFO 位置不变**；后续再次成交后可再次领取 |
| `QUEUED`，仍有 `remainingShares`，已破产清算 | 同一笔交易内退出赎回队列、返还并清零 `remainingShares`、请求置为 `CLAIMED` |
| `remainingShares == 0` | 转为 `CLAIMED` |

因此同一赎回请求可以多次部分成交、多次领取。

### 2.3 破产清算后的处理

**统一减记规则保持不变。** `writeDownInsolvency()` 的清偿顺序、统一比例、
“必须列出全部未领取赎回款、id 严格升序、原始金额之和必须精确等于
`reservedRedeemLiability`”这三项完整性检查全部保持原样。它原本就同时接受
`SETTLED` 与 `QUEUED` 条目，所以部分成交请求本来就被完整纳入减记，无需修改。

`writeDownInsolvency()` 的职责保持有限：只做统一减记、更新赎回负债、设置破产清算状态，
不在该函数内批量返还 Share，避免 Gas 过高。订单由用户自行领取或解除。

**有减记款的部分成交请求**：用户调用 `claimRedeem()` 时，在同一笔交易内支付并清零减记后的
`settledAssets`、减少 `reservedRedeemLiability`、移出赎回队列、返还并清零
`remainingShares`、置为终态。

**没有减记款的请求**（`settledAssets == 0` 但仍有 `remainingShares`）：通过
`cancelRequest()` 解除。`cancelRequest` 在 `insolvencyLiquidated == true` 后跳过
`_requireCancellable()`，不再要求 Cycle 必须为 `ACCEPTING`，也不受产品处于 `SETTLING` 的限制
—— 清算后不会再发生新的 Settlement 批次，保留这道门槛只会让订单被永久锁死，而这正是审计
所描述的陷阱（清算恰在 `CALCULATING` 时执行，该周期永久停在 `CALCULATING` 且无法拨回
`ACCEPTING`）。

清算后返还 Share 仅用于解除锁定和清理订单状态，不代表这些 Share 仍具有最终兑付价值；
现有清偿顺序及清算后禁止 `claimFinal()` 的规则保持不变。

### 2.4 取消剩余订单

`_unwindQueuedRedeem()` 的既有行为已经符合要求，未作修改：返还全部 `remainingShares`
并退出队列；仍有未领取款时请求转为 `SETTLED`（保留领取权），没有未领取款时转为
`CANCELLED`。取消剩余订单不影响已经形成的兑付款领取权。

### 2.5 接口与事件

- `IBaseVault` 新增 `RedeemRequest` 结构与 `getRedeemRequest(uint256)` 读接口。
  这是必需的：`state` 本身不再能判断“是否可领取”，前端必须读到 `settledAssets`
  与 `remainingShares` 才能同时显示“现在可领取多少”和“还有多少在排队”。
- 新增事件 `RedeemPartiallyClaimed(requestId, receiver, assets, remainingShares, timestamp)`
  与 `RedeemLiquidationExit(requestId, receiver, assets, sharesReturned, timestamp)`。
  两者都与既有的 `RedeemClaimed` **并列发出**，而不是取代它 —— 现有事件参数保持不变，
  既有 Indexer 的 `RedeemClaimed` 处理逻辑不需要改动即可继续收到每一笔付款。
- `recordOverdueClaims()` 现在也把 `QUEUED` 且 `settledAssets > 0` 的请求登记到
  ClaimRegistry —— 排队中的请求同样可能持有用户未领取的余额。
- ABI 已重新生成并同步至 `control-panel/abis.json` / `abis.js`（链下 SDK 与控制台共用同一份）。

### 2.6 前端与 Indexer 须知

- 对 `QUEUED` 且 `settledAssets > 0` 的请求显示领取按钮。
- 展示可领取金额（`settledAssets`）与剩余 Share（`remainingShares`）。
- 部分领取后仍显示“排队中”；**不要把一次部分领取判断为整笔订单完成**。
- 清算后显示“领取减记款并取回剩余 Share”（`claimRedeem`）或“解除订单”（`cancelRequest`）。
- 清算退出后将请求移出待处理队列。

`offchain/src/sdk.ts` 已增加 `getRedeemRequest()` 与 `RedeemRequestView` 类型，
`claimRedeem()` 的文档注释已写明上述语义。

### 2.7 测试覆盖

对照贵方文档第五节的十一条要求：

| # | 要求 | 覆盖 |
|---|---|---|
| 1 | 部分成交后立即领取 | `test_claimRedeem_partialClaimStaysQueuedAndCanClaimAgain` |
| 2 | 领取后剩余 Share 保持原 FIFO 位置 | 同上（断言状态仍为 `QUEUED`、`remainingShares` 正确，未重新入队） |
| 3 | 同一请求再次成交、再次领取 | 同上（第二周期成交后二次领取） |
| 4 | 同一笔资金不能重复领取 | `test_claimRedeem_cannotBeClaimedTwice`；同上测试中“无新成交时领取应 revert” |
| 5 | 取消后正确返还 Share 并保留未领取款 | `test_cancelRequest_afterLiquidationIgnoresCycleState` |
| 6 | CALCULATING 期间执行清算后仍能领取减记款 | `test_claimRedeem_partiallyFilledIsPaidAfterLiquidation`（夹具刻意在 `CALCULATING` 时清算） |
| 7 | 清算后正确返还剩余 Share 并退出队列 | 同上 |
| 8 | 减记金额为零时仍能解除订单 | `test_cancelRequest_afterLiquidationIgnoresCycleState` |
| 9 | 多用户适用相同减记比例 | 同上第 6 条（部分成交者与全额成交者按同一比例，断言两笔金额相等）；既有 `test_writeDownInsolvency_appliesOneUniformRatioToEveryClaim` |
| 10 | 每次成交、领取、减记后赎回负债保持准确 | 上述测试逐步断言 `reservedRedeemLiability` |
| 11 | 部分领取不影响 Vault 净资产和 Share 价格 | 领取只把已计入 `reservedRedeemLiability` 的现金付出，`totalAssets()` 的负债项等额减少；既有净值测试未受影响（1026 项全绿） |

### 2.8 保持不变的部分

正常 FIFO 顺序、Settlement 批次结构、部分成交计算方式、已成交 Share 的烧毁规则、
赎回请求状态枚举、`writeDownInsolvency()` 的统一减记比例与清偿顺序、
正常 Cycle 的结算价格与 Share 价格计算 —— 全部未改。

---

## 三、问题 4 —— `addAdapter` 修复不完全

**已按审计建议修复。**

审计指出的问题成立：`LiquidityEarnVault` 的单适配器守卫读的是 `adapter` 字段，
而在此之前只有 `setAdapter()` 会写入它。因此在项目正式调用 `setAdapter` 之前，
`addAdapter()` 可以被反复调用，把一个又一个 Adapter 追加进 `adapters[]`，
每一个的 `realAssets()` 都会进入 `grossManagedAssets()`。

修复：`addAdapter()` 自身写入 `adapter`，任一入口的首次准入即同时锁死两个入口。
`setAdapter()` 保留为部署脚本与运维手册使用的具名入口，行为与 `addAdapter()` 完全一致。

```solidity
function addAdapter(address adapter_) public override {
    if (adapter != address(0)) revert AdapterAlreadySet();
    super.addAdapter(adapter_);
    adapter = adapter_;
}

function setAdapter(address adapter_) external {
    addAdapter(adapter_);
}
```

测试：`test_liquidityEarnVault_addAdapter_armsTheSingleAdapterGuard` ——
经 `addAdapter` 准入首个 Adapter 后，`adapter()` 已被写入，
再经 `addAdapter` 或 `setAdapter` 追加第二个均 revert `AdapterAlreadySet`，
`adapterCount()` 保持为 1。

---

## 四、运维须知

新版本部署后，除既有步骤外还必须执行：

1. Governor 对每个应当使用 UnifiedPool 的 Vault 调用 `setVaultWhitelisted(vault, true)`；
2. Governor 对 Settlement 合约调用 `setSettlementWhitelisted(settlement, true)`；
3. 上述两步缺失时，`attributeInterest` / `attributePrincipal` /
   `receiveVaultPrincipal` / `distribute` 会分别以 `VaultNotWhitelisted` 或
   `SettlementNotWhitelisted` 失败。

Settlement 合约升级时，先把新 Settlement 加入白名单，再切换各 Vault 的 `setSettlement`，
最后按需移除旧地址 —— 白名单支持多地址并存正是为此。

第三方转账与 RevenuePool 转账现在需要 Governor 签名，结算 Operator 的日常脚本不再包含这两个
调用，请相应更新 `settlement-operator-runbook.md` 对应的操作流程。
