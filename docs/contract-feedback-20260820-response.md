# 合约修改建议 0820 — 客户回应

- 日期：2026-08-20
- 对应文档：《合约修改建议》0820 第二版，及其后续补充说明（订单取消方向调整，四条）；本次交付
  的设计方案见 `docs/superpowers/specs/2026-08-20-contract-feedback-0820-design.md`
- 范围：五项建议全部在本次交付中实现，其中第 2 项按补充说明改为“取消批量清理、统一由客户自主
  撤单”，并因此撤销 EIP-1167 克隆、恢复直接部署；本次交付**不执行**任何测试网部署

---

## 1. 删除 AdapterRegistry，并根据合约体积决定是否保留 EIP-1167 Clone

> 体积结论已被后续补充说明推翻：删除批量清理后不再超限，克隆已撤销。见下方“合约体积决策的实测结果”。

**客户诉求：** Adapter 由 Curator 直接选择、部署和配置，不再经过 AdapterRegistry 登记；不新增
AdapterFactory 来源校验、`adapter.vault()` 或 `adapter.asset()` 等额外验证；出现异常时由 Vault
Guardian 停止金库，停止后阻止 adapter 的运行即可。

**实现方式：**

- 整体删除 `AdapterRegistry`、`AdapterRegistryFactory` 及其接口、测试文件；`BaseVault`、
  `IBaseVault`、`IVaultRoles`、`VaultFactory` 中所有 `adapterRegistry` 存储、参数、准入检查一并
  删除。`bindGovernance` 从两个参数收窄为一个：
  ```solidity
  function bindGovernance(address vaultTimelock_) external;
  ```
  `addAdapter` 不再校验 Adapter 是否来自指定 AdapterFactory 或做 `adapter.vault()`/`adapter.asset()`
  一致性检查（`adapter.vault()` 指回本 Vault 的检查是删除 AdapterRegistry 之前就有的既有逻辑，
  未新增）。Adapter 的添加与移除完全由 Curator 直接负责，风险由 Curator 承担。
- Guardian 暂停后的“阻止 adapter 运行”落在 `BaseAdapter._onlyCurator` 与 `_onlyAllocator` 两个
  共享角色助手上，调用
  `IStateManager(IVaultRoles(vault).stateManager()).requireActive(vault)`：暂停期间下单
  （`createBuyOrder`/`createSellOrder`/`createRebalanceOrder`）、执行
  （`executeBuy`/`executeSell`/`executeRebalance`）、`clearDealValue`、`unfreezeAllocator`
  均会回滚；撤单（三个 `cancel*Order`）、`freezeAllocator`、`updateDealData`、
  `setStalenessWindow`/`setDataProvider` 在暂停期间仍可用。

**涉及文件：** `src/asset-management/vaults/BaseVault.sol`、`src/interfaces/IBaseVault.sol`、
`src/interfaces/IVaultRoles.sol`、`src/asset-management/vaults/VaultFactory.sol`、
`src/asset-management/adaptors/BaseAdapter.sol`、`script/Deploy.s.sol`、`offchain/`、
`control-panel/`（删除 AdapterRegistry 相关 ABI/类型/面板）。已删除文件：
`src/asset-management/vaults/AdapterRegistry.sol`、
`src/asset-management/vaults/AdapterRegistryFactory.sol`、`src/interfaces/IAdapterRegistry.sol`、
`src/interfaces/IAdapterRegistryFactory.sol`、`test/AdapterRegistryFactory.t.sol`。

**测试覆盖：** `test/BaseAdapter.t.sol` — Guardian 暂停后下单/执行/`clearDealValue`/
`unfreezeAllocator` 全部回滚，撤单/`freezeAllocator`/`updateDealData`/
`setStalenessWindow`/`setDataProvider` 暂停期间仍可用，解除暂停后下单与执行恢复；`addAdapter`
在无 Registry 场景下仍可由 Curator 正常添加任意 Adapter。

**遗留代价（刻意保留，供客户确认）：** Guardian 暂停期间，Allocator 仍可调用 `fundAdapter`
把资金划入 Adapter；资金进去之后无法被动用（下单与执行都已封死），但确实能进去。客户第一版
曾要求阻止“继续向 Adapter 划拨资金”，第二版把这句删掉，只保留“停止后可以阻止 adapter 的运行
即可”，因此本次严格按第二版实现，`BaseVault.fundAdapter`/`recallAdapter` 未加暂停检查。如果
客户认为这是缺口，加回来只是一行——详见下方“需要客户确认的两个问题”之 (b)。

---

## 2. 取消批量清理，统一由客户自主撤单

**客户诉求（0820 补充说明，第 1、4 项）：** 因 `cancelExpiredRequests` 导致合约体积增大且增加
运维难度，取消该函数，统一使用现有 `cancelRequest(uint256 requestId)` 作为客户自主取消入口，
仅允许原 request owner 或其授权 operator 调用；除普通周期结算期间和最终结算期间外，客户在其他
任何产品阶段均可自主取消尚未完成的申购或赎回请求。

**实现方式：** `sweepExpiredRequests(uint256 maxCount)` 及其 `SweepNotAllowed` 错误、
`ExpiredRequestSwept` 事件、`_sweepCursor` 游标整体删除。`cancelRequest` 的阶段闸门抽为
`_requireCancellable`：

```solidity
if (cs != CycleState.ACCEPTING || ps == ProductState.SETTLING) {
    revert CancelNotAllowed(requestId, ps, cs);
}
```

- `cycle != ACCEPTING`（普通周期结算期间）与 `product == SETTLING`（最终结算期间）禁止；
  `SUBSCRIBING` / `OPERATING` 的 ACCEPTING 窗口，以及 `MATURING` / `CLAIMING` / `CLOSED` 均放行。
- `SETTLING` 必须单列一条禁令，不能靠 cycle 判断兜住：`enterFinalSettlement` 要求
  `cycle == ACCEPTING`，且其后 `enterMaturing` / `enterClaiming` / `closeProduct` 都不改动 cycle，
  因此 `SETTLING → MATURING → CLAIMING → CLOSED` 全程 cycle 都读作 `ACCEPTING`。
- `CancelNotAllowed` 增加 `ProductState` 参数，使两个禁止阶段在 revert 中可区分。
- 调用者限制不变：仍是 `_checkOwnerOrOperator`，任何阶段都不对外开放。

**需要如实说明的一处：这次改动同时收紧了一个原有缺口。** 改动之前 `cancelRequest` 只检查
`cycle != ACCEPTING`，而 SETTLING 阶段 cycle 恰恰读作 `ACCEPTING`——也就是说**最终结算窗口此前
是可以撤单的**，任何持有人都能把一笔在途的赎回从最终结算批次里抽走。本次按贵方给出的规则将其
关闭。相应地，`MATURING` / `CLAIMING` / `CLOSED` 三个阶段此前对**完全未成交**的请求本就是可撤的
（同样因为 cycle 读作 `ACCEPTING`），并非全部锁死；真正被永久锁死的只有部分成交的赎回，见第 3 项。

**体积结果：** 本项改动净减少 `EarnVaultDeployer` 917 字节，是本次得以撤销 EIP-1167 克隆、恢复直接部署的直接原因，
详见下方“合约体积决策的实测结果”。

**涉及文件：** `src/asset-management/vaults/BaseVault.sol`、`src/interfaces/IBaseVault.sol`、
`offchain/src/sdk.ts`、`offchain/src/keeperBot.ts`、`offchain/src/indexer.ts`、
`offchain/scripts/runKeeper.ts`、`control-panel/index.html`、`control-panel/standalone.html`。

**测试覆盖：** `test/EarnVault.t.sol` — 允许的阶段（`OPERATING` 的 ACCEPTING 窗口、`MATURING`、
`CLAIMING`、`CLOSED`）各覆盖一次；两个禁止阶段各覆盖一次（`CALCULATING` 周期中、`SETTLING`
且分别在 `completeFinalSettlement` 之前与之后，确认最终结算确认与否都不放行，只有进入
`MATURING` 才重新开放）；赎回与申购各走一遍闸门；非持有人调用回滚 `NotOwnerOrOperator`，
已授权 operator 可代为撤单且退款仍进入原持有人。链下：`offchain/test/keeperBot.unit.test.ts`
清理相关用例整体删除，`offchain/test/indexer.unit.test.ts` 改为验证撤单路径下的部分成交区分。

---

## 3. 部分成交的赎回

**客户诉求：** 已同意 PR #26 的处理方案：在 settling 阶段只退还未成交的份额，并将该请求提升为
SETTLED，使已成交部分仍可正常领取。

**实现方式（按 0820 补充说明第 3 项调整承载路径）：** 这套处理现在由 `cancelRequest` 承担，
不再需要批量清理。`_unwindQueuedRedeem` 遇到部分成交的赎回请求（`settledAssets > 0`）时，退还
`remainingShares`，状态置为 SETTLED 而非 CANCELLED，已成交部分仍可通过 `claimRedeem` 领取；
完全未成交（`settledAssets == 0`）的赎回置为 CANCELLED，锁定份额全额退回。

`cancelRequest` 原先那条 `remainingShares != shares` 的拒绝已删除。**这是本次唯一一处真正解除了
资金永久锁定的改动**：在此之前，一笔被部分成交过的赎回在任何产品阶段都无法撤销，只能等待后续
结算轮把它填满，而进入 SETTLING 之后不会再有常规结算轮，这笔请求就永久卡住了。

**涉及文件：** `src/asset-management/vaults/BaseVault.sol`（退款助手
`_unwindPendingDeposit` / `_unwindQueuedRedeem`）。`_unwindPendingDeposit` 的 `push` 参数一并
删除——批量清理是唯一需要“标记 REFUNDABLE 而不推送”的调用方，它删除后该分支成为死代码
（`markRefundable` / `claimRefund` 不经过此函数，不受影响）。

**测试覆盖：** `test/EarnVault.t.sol` — 部分成交赎回撤单后 `remainingShares` 已退还、
`claimRedeem` 仍可领取 `settledAssets` 且不会被重复支付；同一场景在 `MATURING` 阶段再覆盖一次；
完全未成交的赎回撤单后份额全额退回且 `claimRedeem` 回滚 `RequestNotSettled`。

---

## 4. 将白名单和转账路径设置为两个独立开关

**客户诉求：** 保留旧版本默认开放转账的行为，同时允许受监管 RWA 资产选择严格模式；白名单准入
和转账路径是两个独立维度，应通过显式开关分别控制，不应根据名单/路径是否为空推断启用状态；
路径模式开启但未配置有效路径时应禁止转账。

**实现方式：**

```solidity
bool public whitelistEnabled;      // 默认 false
bool public transferPathEnabled;   // 默认 false

function setWhitelistEnabled(bool enabled) external;      // Issuer
function setTransferPathEnabled(bool enabled) external;   // Issuer
function addToWhitelist(address[] calldata accounts) external;      // Issuer
function removeFromWhitelist(address[] calldata accounts) external; // Issuer
function isWhitelisted(address account) external view returns (bool);
```

`_checkTransfer(from, to)` 按四种组合执行（白名单关+路径关→全放行；白名单开+路径关→只查白
名单；白名单关+路径开→只查路径；白名单开+路径开→两者都要通过）。白名单使用独立的 `_whitelisted`
映射，刻意不复用转账路径的 `listId` 地址名单，避免两个维度重新耦合。`transferPathEnabled ==
true` 且当前配置零条路径时直接回滚（`NoTransferPathConfigured`），而不是像旧版那样放行——这正
是本次要修掉的“严格模式因无规则而意外全放行”的问题。`mint`/`burn` 不受这两个开关影响。开关状态
变化分别触发 `WhitelistEnabledSet`/`TransferPathEnabledSet` 事件。

**涉及文件：** `src/asset-infrastructure/RWAToken.sol`、`src/interfaces/IRWAToken.sol`。

**测试覆盖：** `test/RWAToken.t.sol` — 四种开关组合各一例（`test_whitelistOnly_checksBothSides`、
`test_pathOnly_noPathsConfigured_blocksAll`、`test_bothOn_requireWhitelistAndPath` 等）；严格
模式无路径时禁止转账；`test_mintBurn_unaffectedByWhitelist` 确认 mint/burn 不受影响；
`test_setTransferPathEnabled_revertsForNonIssuer`、`test_addToWhitelist_revertsForNonIssuer`、
`test_removeFromWhitelist_revertsForNonIssuer` 确认非 Issuer 调用开关/名单管理函数回滚。

**部署影响：** `RWAToken` 不可升级，测试网需要重新部署包含上述开关的新版 Token；若已有余额与
业务配置，还需完成余额迁移，以及前端、SDK 与部署地址的更新。本次交付不执行测试网部署。

---

## 5. 将产品核心信息同步写入 AssetRegistry

**客户诉求：** 在资产注册时同步记录产品名称、收益率（基点整数）、到期日（Unix 时间戳）、发行
人（强制为注册交易的 `msg.sender`）、投资标的；新增 `getProductInfo` 查询接口；注册成功时触发
包含核心信息的事件；产品核心条款原则上注册后保持不变，如业务上确实允许修改，需增加仅限
Issuer 调用的更新接口。

**实现方式：**

```solidity
struct ProductInfo {
    string  productName;
    uint16  annualYieldRateBps;   // 500 = 年化 5%
    uint64  maturityTimestamp;    // Unix 时间戳
    address issuer;               // 始终为注册者；输入值被忽略
    string  underlyingAsset;
}

function registerAsset(
    bytes32 metadataHash,
    string calldata name,
    string calldata symbol,
    uint8 decimals,
    FeePaymentKind feeKind,
    ProductInfo calldata product
) external payable returns (uint256 assetId, address token);

function getProductInfo(uint256 assetId) external view returns (ProductInfo memory);
```

`registerAsset` 由五参数扩展为六参数，新增的 `product` 用结构体而非九个平铺参数，避免
stack-too-deep。`issuer` 字段在写入前被强制覆盖为 `msg.sender`，调用方传入的值被忽略，避免登
记任意地址冒充发行人。注册成功时新增 `ProductInfoSet(assetId, issuer, productName,
annualYieldRateBps, maturityTimestamp, underlyingAsset, timestamp)` 事件，与既有的
`AssetRegistered` 在同一笔交易中触发——**新增事件而非加宽 `AssetRegistered`**，因为加宽会改变
其 ABI，导致既有 indexer 解码失败。

**涉及文件：** `src/asset-infrastructure/AssetRegistry.sol`、`src/interfaces/IAssetRegistry.sol`。

**测试覆盖：** `test/AssetRegistry.t.sol` — `test_registerAsset_storesProductInfo`（
`getProductInfo` 往返一致，`ProductInfoSet` 与 `AssetRegistered` 同时触发）、
`test_registerAsset_issuerForcedToSender`（传入他人地址无效，始终记为 `msg.sender`）。

**部署影响：** 见第 3 部分“重新部署的影响”。

---

## 需要客户确认的两个问题

### (a) 第 5 项“产品核心条款是否允许修改”

客户原文：“上述产品核心条款原则上应在注册后保持不变；如果业务上确实允许修改，应增加仅限
Issuer 调用的更新接口，并记录修改前后的内容及对应事件。”

这是一个**有条件**的要求——默认立场是“注册后保持不变”，更新接口取决于“业务上确实允许修改”这
一尚未确认的前提。因此本次**没有实现** `updateProductInfo`：现在加进去等于替客户把他自己写下的
不可变默认改成可变，是本次交付主动做出的决定而非遗漏。

请确认：产品核心条款（`productName`、`annualYieldRateBps`、`maturityTimestamp`、
`underlyingAsset`）注册后是否需要允许修改？若需要，将补一个仅限 Issuer 调用、记录修改前后内容
并触发事件的接口。由于 `AssetRegistry` 本身就需要因本次改动重新部署（见下方“重新部署的影
响”），这次一并加入 `updateProductInfo` 的成本，与放到下一次改动再加入，并无本质差别——不会
因为这次没做而在下次多付出部署成本。

### (b) 第 1 项 Guardian 暂停范围——资金仍可划入已暂停的 Vault

客户第一版曾要求 Guardian 暂停后“阻止 Curator 继续创建订单、Allocator 继续执行订单和向
Adapter 划拨资金”；第二版把“划拨资金”这句删掉，只保留“出现异常时，由 Vault Guardian 停止金
库，停止后可以阻止 adapter 的运行即可”。本次严格按第二版实现，把暂停检查放进
`BaseAdapter._onlyCurator`/`_onlyAllocator`，覆盖下单与执行这两个资金真正流动的方向。

需要明确说明的后果：**Guardian 暂停期间，Allocator 仍可调用 `BaseVault.fundAdapter` 把 Vault
的 USDT 划入 Adapter。** 资金进去之后确实无法被动用——下单（`createBuyOrder` 等）与执行
（`executeBuy` 等）都已被暂停检查封死，资金在 Adapter 里动弹不得——但资金本身能够进得去这一
事实没有改变。

如果客户认为这是一个需要堵上的缺口（即回到第一版的立场），修改是一行代码：在
`BaseVault.fundAdapter` 里加一行 `IStateManager(stateManager).requireActive(address(this))`。
请确认是否需要加回。

---

## 合约体积决策的实测结果

方案约定的规则是贵方给出的：“若符合 EIP-170 限制则恢复直接部署，若仍超限则继续保留 Clone
方案”。这条规则被套用了两次，因为中途删除了批量清理，前提发生了变化。

**第一次（含批量清理）：** 五项改动完成后实测 `EarnVaultDeployer` 25,092 字节，超限 516 字节，
按规则保留 EIP-1167 克隆。

**第二次（删除批量清理后）：** `EarnVaultDeployer` 实测 24,175 字节，较第一次净减少 917 字节
——删除 `sweepExpiredRequests` 本身释放 842 字节，`_unwindPendingDeposit` 随之去掉 `push` 参数
与 REFUNDABLE 死分支再释放一部分，放宽后的 `cancelRequest` 回吃一小部分。净额超出 516 字节的
缺口，前提不再成立，因此按同一条规则**恢复直接部署，撤销 EIP-1167 克隆**。

| 合约 | 运行时字节 | 距 24,576 上限余量 |
| --- | --- | --- |
| `EarnVaultDeployer` | 24,175 | 401 |
| `LiquidityEarnVaultDeployer` | 23,242 | 1,334 |
| `EarnVault` | 22,343 | 2,233 |
| `LiquidityEarnVault` | 21,263 | 3,313 |
| `VaultFactory` | 11,475 | 13,101 |

`script/check-sizes.sh` 全部 44 个合约符合 EIP-170。

**为什么克隆本身也占体积。** 克隆方案下 Vault 没有构造函数，构造逻辑要搬进运行时码的
`initialize(...)` 并加一次性 `initializer` 守卫，`EarnVault` 因此从 23,260 涨到 24,179——约 900
字节。也就是说撤销克隆不仅去掉了 `Clones` 依赖和一层实现合约，Vault 自身也随之瘦身。撤销后
`test/helpers/VaultDeploy.sol` 与两项克隆初始化测试一并删除，测试重新走 `new EarnVault(...)`。

**401 字节余量是一个持续约束：** `EarnVaultDeployer` 的运行时字节码就是 `EarnVault` 的创建码，
两者一一耦合，这是结构性上限。今后任何在 `EarnVault` / `BaseVault` 上新增的外部函数，都必须先跑
`script/check-sizes.sh` 确认不会再次超限，才能合并；再次超限时，恢复克隆仍然是可用的退路。

---

## 重新部署的影响

`RWAToken` 与 `AssetRegistry` 均不可升级，本次改动（第 4、5 项）之后测试网需要重新部署两者。
连带影响：

- 已有余额需要迁移到新版 `RWAToken`；前端、SDK、部署地址与 ABI 需同步更新。
- **`MintBurnController` 是在 `AssetRegistry` 构造函数内部 `new` 出来的**（`address
  immutable mintBurnController`，无 setter），因此**重新部署 `AssetRegistry` 会连带产生一个
  全新的 `MintBurnController` 实例**——既有资产在旧 `MintBurnController` 上的登记关系不会自动
  迁移到新实例，需要在新 `AssetRegistry` 上重新完成资产注册（`registerAsset` 本身就会在新
  `MintBurnController` 上调用 `registerToken`）。

Vault 侧（`EarnVault`/`LiquidityEarnVault`/`VaultFactory`）不受此次不可升级性影响——它们本就
是新部署的合约，不存在“迁移已有 Vault”的问题。

**本次交付不执行任何测试网部署**，只提供合约、测试与文档；部署与迁移是独立的后续步骤。

---

## 两个容易让集成方意外的接口形状

- **`ProductInfo.issuer` 是一个被合约刻意忽略的输入字段。** 调用 `registerAsset` 时无论
  `product.issuer` 传什么，链上记录的 `issuer` 永远是本笔交易的 `msg.sender`。前端/SDK 如果
  把这个字段做成可编辑输入框，需要说明它不生效，或者干脆不展示为可填项。
- **撤销一笔部分成交的赎回之后，界面必须继续显示“可领取”。** 完全未成交的撤单与部分成交的撤单
  在链上留下的形状完全一样——都是 `tombstoned`、`remainingShares = 0`、`claimed = false`——但后者
  的 `settledAssets` 仍然可以 `claimRedeem` 领走。链下靠 `RedeemRecord.cancelledButSettled`
  区分（见 `docs/offchain-indexer-guide.md` §4）。漏掉这个判断，用户不会去点 claim，那笔 USDT 就
  一直躺在合约里——资金不会丢，只是没人告诉他。

---

## SETTLING 阶段的两道闸门

SETTLING 阶段有两道方向相反、互不替代的闸门，都不能以“另一个已经管住了”为由删掉：

1. **请求截止**（下一节恢复的 0819 第 4 项）：`requireOperable` 拒绝 SETTLING，挡住截止之后
   **新进来**的赎回。
2. **撤单禁止**（本次第 2 项）：`cancelRequest` 在 `product == SETTLING` 时回滚，保护截止之前
   **已经排队**、最终结算批次仍可能正常成交的赎回，不被持有人中途抽走。

按贵方给出的规则，第二道闸门在整个 SETTLING 阶段一律生效，不区分 `isFinalSettlementComplete`
是否已为真——即便最终结算已确认完成，也要等 Keeper 调用 `enterMaturing` 推进到 MATURING，撤单
才重新开放。这比按结算确认与否放行更简单，也省下一次 `isFinalSettlementComplete` 读取；
代价是 `completeFinalSettlement` 与 `enterMaturing` 之间存在一个短暂的不可撤单窗口。

---

## 补充说明：0819 第 4 项修复（SETTLING 请求截止）的回退与恢复

需要向贵方如实说明一处我方自己造成的回归，以及本分支的修正。

**发生了什么。** 0819 反馈的四项修复由 PR #26（`436614f`）一并交付。该 PR 后来因为对 0820 文档
（即本文档对应的这一版建议）采取的方案未被采纳而被整体回退。但 PR #26 是一个把多项互不相关的改
动压缩在一起的 squash commit，整体回退把其中**未被撤回的 0819 第 4 项修复也一并退掉了**。分支
终审时发现了这一点，本分支将其单独恢复。

**被退掉的行为缺陷。** 回退之后，`requireOperable` 又重新放行 SETTLING，于是 `enterFinalSettlement`
之后 `requestRedeem` 仍可继续入队；而 `startCycleCalculation` 要求 OPERATING，SETTLING 之后不可能
再开出新的计算周期，这些份额因此永远无法被任何结算周期成交。相应的测试当时也被一并退回，反而把
这个旧行为重新固化成了断言。

**本次恢复的内容（仅这两处守卫，不含 PR #26 的其他任何改动）：**

1. `StateManager.requireOperable` 收紧为仅 OPERATING + ACCEPTING，拒绝 SETTLING。SETTLING 由此成
   为硬性的请求截止点：申购侧的 `requireSubscribable` 与赎回侧的 `requireOperable` 同时关闭。
2. `StateManager.enterFinalSettlement` 增加 `cycle == ACCEPTING` 的要求，即上一轮常规结算批次必须
   已经完成。若允许从 CALCULATING 进入，会留下一个 `completeCycle` 永远无法触发的半程批次。

截止之前已排队、最终结算之后仍未成交的请求，由持有人自己调 `cancelRequest` 取回（申购的 USDT
直接推回，赎回的 `remainingShares` 直接退还）——进入 MATURING 之后撤单窗口永久开放，不存在过期
作废。已结算的请求不受影响，仍走原有的 `claimDeposit` / `claimRedeem` 路径。

需要贵方注意的接口影响：**赎回请求的最后入队时刻从“最终结算完成”提前到了 `enterFinalSettlement`
被调用的那一刻**。前端与 SDK 在 SETTLING 阶段应停止展示赎回入口，否则用户会看到交易回滚
（`WrongProductState(OPERATING, SETTLING)`）。
