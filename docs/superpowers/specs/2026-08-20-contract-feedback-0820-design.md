# 合约修改建议 0820 — 设计方案

- 日期：2026-08-20
- 来源：客户《合约修改建议》0820 第二版（第一版第 1 条的 Guardian 条款已放宽，见 §2.4）
- 基线提交：`5b502fc`（回退 PR #26，保留 `ci.yml` 与 `script/check-sizes.sh`）
- 状态：待实现

---

## 1. 背景与总体判断

PR #26 针对《合约问题反馈 20260819》做了四项修复，并为解决 EIP-170 体积超限而把 Vault
改成 EIP-1167 克隆部署。客户在本次建议中给出了不同的修改方向：AdapterRegistry 整体删除
（而非新增更新函数）、到期清理改为无权限分批执行、白名单改为独立开关。这三点与 PR #26 的
实现路径不兼容，因此先整体回退，再按本方案重新实现。

回退已完成于 `5b502fc`，回退后 `forge test` 955 项全部通过。PR #26 中与本次反馈无关的两项
工具（CI 工作流、体积检查脚本）予以保留。

本方案共五项改动，其中第 1 项与第 2 项会改变 Vault 体积，第 4 项与第 5 项因合约不可升级而
需要重新部署。

---

## 2. 第 1 项：删除 AdapterRegistry

### 2.1 修改理由（客户原文摘要）

Adapter 由 Curator 直接选择、部署和配置，再经 AdapterRegistry 登记只会增加部署与操作复杂
度，并扩大 Vault 相关合约体积；AdapterRegistry 本身也无法证明 Adapter 来自官方
AdapterFactory，因此这层登记机制没有保留价值。

### 2.2 删除范围

以下文件整体删除：

- `src/asset-management/vaults/AdapterRegistry.sol`
- `src/asset-management/vaults/AdapterRegistryFactory.sol`
- `src/interfaces/IAdapterRegistry.sol`
- `src/interfaces/IAdapterRegistryFactory.sol`
- `test/AdapterRegistryFactory.t.sol`

以下位置移除 AdapterRegistry 相关参数、存储、绑定与准入检查：

| 位置 | 改动 |
| --- | --- |
| `BaseVault` | 删除 `adapterRegistry` 存储槽；`addAdapter` 中删除 `isAdapterAllowed` 准入检查；`bindGovernance(address,address)` 收窄为 `bindGovernance(address vaultTimelock_)`，一次性语义不变 |
| `IBaseVault` | 同步收窄 `bindGovernance` 签名，删除相关事件与错误 |
| `IVaultRoles` | 删除 `adapterRegistry()` 视图 |
| `VaultFactory` / `IVaultFactory` | 部署路径删除 registry 入参 |
| `script/Deploy.s.sol` | 删除 AdapterRegistry / AdapterRegistryFactory 的部署与接线 |
| `offchain/`、`control-panel/` | 删除对应 ABI、类型、配置项与操作面板 |

按客户明确要求，**不引入任何替代校验**：不校验 Adapter 是否来自 AdapterFactory，也不调用
`adapter.vault()` 或 `adapter.asset()` 做一致性检查。Adapter 的添加与移除由 Curator 直接
负责，风险由 Curator 承担。

### 2.3 Curator 的权限路径不变

`addAdapter` / `removeAdapter` 继续走 `_onlyCuratorDirectOrTimelock`：Vault 处于
CONFIGURING 时 Curator 可直接调用，此后必须经 VaultTimelock。本次不改动这一约束。

### 2.4 Guardian 暂停后阻止 Adapter 运行

客户第二版原文：“出现异常时，由 Vault Guardian 停止金库，停止后可以阻止 adapter 的运行
即可”。第一版中“保留取消订单和召回资金等风险处置能力”的要求已被客户主动删除，因此不再
为 cancel / recall 做例外处理。

当前实现的缺口：`BaseAdapter` 的下单、撤单、执行都只检查角色，不检查 Vault 的
`PauseState`。Guardian 暂停后，Curator 仍可下单、Allocator 仍可执行订单。

`BaseAdapter` 现有的角色助手与入口对应关系如下（已核对代码，非推测）：

| 助手 | 入口函数 |
| --- | --- |
| `_onlyCurator` | `createBuyOrder`、`createSellOrder`、`createRebalanceOrder`、`unfreezeAllocator` |
| `_onlyAllocator` | `executeBuy`、`executeSell`、`executeRebalance`、`clearDealValue` |
| `_onlyCuratorOrGuardian` | `cancelBuyOrder`、`cancelSellOrder`、`cancelRebalanceOrder` |
| `_onlyGuardian` | `freezeAllocator` |
| `_onlyDataProvider` | `updateDealData` |
| `_onlyCuratorDirectOrTimelock` | `setStalenessWindow`、`setDataProvider` |

改法是把暂停检查放进前两个共享角色助手，而不是逐个入口添加：

```solidity
function _onlyCurator() internal view {
    if (IVaultRoles(vault).curator() != msg.sender) revert NotCurator();
    IStateManager(IVaultRoles(vault).stateManager()).requireActive(vault);
}

function _onlyAllocator() internal view {
    if (IVaultRoles(vault).allocator() != msg.sender) revert NotAllocator();
    if (allocatorFrozen) revert AllocatorIsFrozen();
    IStateManager(IVaultRoles(vault).stateManager()).requireActive(vault);
}
```

这两处覆盖了**下单与执行**，即资金真正流动的方向，也就是“阻止 adapter 的运行”。
`requireActive` 在 `PauseState != ACTIVE` 时回滚，语义已经现成。`_onlyAllocator` 中本就有
`allocatorFrozen` 冻结检查，此处添加暂停检查与既有模式一致。

由此产生的两个连带效果，都是想要的：

- **撤单在暂停期间仍然可用。** 三个 `cancel*Order` 走的是 `_onlyCuratorOrGuardian`，不在加固
  范围内。客户第二版虽已不再要求保留撤单能力，但保留它没有坏处 —— 暂停期间能撤掉未执行的
  订单，是收敛风险而不是扩大风险。
- **`unfreezeAllocator` 在暂停期间被一并阻断。** 它走 `_onlyCurator`，因此会被新检查覆盖。
  这是正确的：金库处于暂停状态时不应该能把 Allocator 解冻。而 `freezeAllocator` 走
  `_onlyGuardian`，不受影响，Guardian 随时可以冻结。

**刻意不加暂停检查的四个助手**，各有理由：

- `_onlyGuardian`、`_onlyCuratorOrGuardian` —— Guardian 必须能在暂停期间动作，正因为金库
  已暂停；撤单同理（见上）。
- `_onlyCuratorDirectOrTimelock` —— 事故期间可能需要修正错误配置（如陈旧度窗口、数据
  提供方）才能恢复。
- `_onlyDataProvider` —— 暂停期间冻结估值更新会让事故更难判断，而非更安全。

**`BaseVault` 一行都不改：`fundAdapter` 与 `recallAdapter` 均不加暂停检查。**

初稿曾为 `fundAdapter` 加一行，理由是“暂停期间不应再把 Vault 的 USDT 推入可疑 Adapter”。
该行已删除：客户第二版把"阻止 Curator 继续创建订单、Allocator 继续执行订单和向 Adapter
划拨资金"整句删去，只留"停止后可以阻止 adapter 的运行即可"。划拨资金不在诉求内，加了就是
越界。本项因此只修改 `BaseAdapter.sol` 一个源文件。

代价明确记录在此：Guardian 暂停期间，Allocator 仍可调用 `fundAdapter` 把资金划入 Adapter；
资金进去之后无法被动用（下单与执行都已封死），但确实进得去。若客户认为这是缺口，加回来
只是一行。

### 2.5 体积决策：直接部署 vs EIP-1167 克隆

回退后的基线体积（`forge build --sizes`，optimizer_runs 200，未启用 via_ir）：

| 合约 | 运行时字节 | 距 EIP-170 余量 |
| --- | --- | --- |
| `EarnVaultDeployer` | 24,347 | **229** |
| `LiquidityEarnVaultDeployer` | 23,414 | 1,162 |
| `EarnVault` | 22,515 | 2,061 |
| `VaultFactory` | 11,575 | 13,001 |

`EarnVaultDeployer` 的运行时字节码就是 `EarnVault` 的创建码，因此 Vault 每增加一行，
Deployer 就同步增长。删除 AdapterRegistry 会释放数百字节，第 2 项的 `sweepExpiredRequests`
则会增加数百字节，两者方向相反。

因此**不预设结论，由测量决定**。五项改动全部完成后运行 `script/check-sizes.sh`：

- 若 `EarnVaultDeployer` 与 `LiquidityEarnVaultDeployer` 均在 24,576 以内 —— 保留回退后
  恢复的直接部署方案，不再引入克隆。
- 若仍超限 —— 重新引入 PR #26 的 EIP-1167 方案：`VaultFactory` 克隆 `EarnVault` /
  `LiquidityEarnVault` 实现合约，Vault 改为 `initialize(...)` 并由 `initializer` 保证一次性，
  实现合约在构造时自锁；必要时再把 `writeDownInsolvency` 的数组遍历抽出为外部库
  `VaultInsolvency`。

229 字节的余量意味着克隆方案很可能仍然需要，但这必须由脚本给出答案，不能靠估计。

---

## 3. 第 2 项：到期未结算请求改为无权限分批清理

### 3.1 接口

```solidity
function sweepExpiredRequests(uint256 maxCount) external nonReentrant returns (uint256 processed);
```

- **无角色检查。** 退款对象与金额完全由链上请求记录决定，是确定性操作，不需要限制调用者。
- **允许的产品状态：** SETTLING、MATURING、CLAIMING、CLOSED。
- **不检查暂停状态。** 这是退款路径，而现有的 `claimDeposit` / `claimRedeem` /
  `claimRefund` 同样不检查暂停。若此处检查，会出现“暂停期间可以领取已结算的钱、却不能取回
  未结算的钱”这种不一致。
- 返回本次实际处理的请求数，调用方据此判断是否需要再来一批。

### 3.2 游标：在 requestId 空间上推进

> **本节于实施前修订。** 初稿写的是“队列头本身就是游标，不需要新增游标存储”，该前提被代码
> 证伪：`Queue.remove`（`Queue.sol:123-137`）只把槽位写成 `TOMBSTONE`，**不推进 `queueHead`**；
> `peek`（`Queue.sol:143`）直接返回 `_slots[vault][qt][queueHead]`，**不跳过墓碑**（跳过逻辑
> `_skipTombstones` 只在 `dequeue` 内部调用）。照初稿实现的循环会在第二轮 peek 到墓碑，并在
> `IQueue.remove` 处以 `NotInQueue` 回滚。

改为在 BaseVault 侧维护一个只增不减的 `_sweepCursor`，在 **requestId 空间**上推进：requestId
由 `nextRequestId` 从 1 单调递增，且申购与赎回**共用同一个 id 空间**，因此一个游标一趟即可
覆盖两个队列，处理顺序仍与入队顺序一致。

每次调用从 `_sweepCursor` 走到 `nextRequestId`，遇到 PENDING 申购或 QUEUED 赎回就退款并计入
`processed`，其余（已 SETTLED / CLAIMED / CANCELLED）直接越过；`processed` 达到 `maxCount`
即停下并落盘游标。重复调用天然接着走，不会重复处理。

代价是一个存储槽。考虑到 `EarnVaultDeployer` 的字节码余量本就紧张，这笔开销计入 §2.5 的体积
测量。

### 3.3 共用退款助手

把 `cancelRequest` 中的两段退款逻辑抽出，与清理函数共用，避免同一套负债/队列/额度更新出现
两份实现：

- `_unwindPendingDeposit(uint256 requestId)` —— 退还 PENDING 申购的 USDT，扣减
  `pendingDepositLiability` 与 `pendingDepositByOwner`，调用
  `StateManager.releaseSubscription` 释放认购额度，从队列移除。
- `_unwindQueuedRedeem(uint256 requestId)` —— 退还 QUEUED 赎回的 `remainingShares`，从队列
  移除，终态按 §4 处理。

两者都把资金/份额退还给**请求的原 owner**，而非 `msg.sender` —— 这是无权限调用能够安全成立
的前提。

### 3.4 事件

```solidity
event ExpiredRequestSwept(
    uint256 indexed requestId,
    address indexed owner,
    QueueType queueType,
    uint256 returnedAmount,
    uint256 timestamp
);
```

### 3.5 “为 Curator 增加清理操作接口”的理解

客户原文同时写了两句：“合约端为 Curator 增加一个到期请求清理操作接口，由 Curator 设置单批
最大处理数量并实际调用”，以及“同时保留该函数的无权限调用属性”。

在无权限函数之上再加一个仅限 Curator 的包装函数，会消耗字节码（本项目字节码正紧张）却不带来
任何安全收益 —— 任何人都能绕过包装直接调用被包装的函数。因此本方案将其理解为**运维接口**：
在 control-panel、Workbench 与 keeperBot 中为 Curator 提供“批量大小 + 执行”的操作入口，调用
的仍是同一个无权限函数。这是本方案对该句的解读，若客户确实要求链上包装函数，需要回改。

---

## 4. 第 3 项：部分成交的赎回

客户已同意 PR #26 的处理方案，原样重新实现。

部分成交的赎回请求仍处于 QUEUED，但已累计 `settledAssets`（前序 cycle 中已成交部分的 USDT
已被预留），同时 `remainingShares < shares`。到期清理时：

- 只退还未成交的 `remainingShares`；
- 若 `settledAssets > 0`，将请求置为 **SETTLED**（而非 CANCELLED），使已成交部分仍可通过
  `claimRedeem` 正常领取；
- 若 `settledAssets == 0`（完全未成交），置为 CANCELLED。

若统一置为 CANCELLED，`claimRedeem` 只接受 SETTLED，那笔已预留的 USDT 将永久无法领取。

`cancelRequest` 现有的边界不变：它仍然拒绝部分成交的赎回（`remainingShares != shares` 时
回滚），因为用户主动取消不应处理这种混合终态；分批清理则必须处理。

---

## 5. 第 4 项：白名单与转账路径改为两个独立开关

### 5.1 状态与接口

```solidity
bool public whitelistEnabled;      // 默认 false
bool public transferPathEnabled;   // 默认 false

mapping(address => bool) private _whitelisted;

function setWhitelistEnabled(bool enabled) external;      // Issuer
function setTransferPathEnabled(bool enabled) external;   // Issuer
function addToWhitelist(address[] calldata accounts) external;      // Issuer
function removeFromWhitelist(address[] calldata accounts) external; // Issuer
function isWhitelisted(address account) external view returns (bool);
```

白名单使用**独立的 `_whitelisted` 映射**，刻意不复用 `listId` 地址名单 —— 准入（谁可以持有）
与路径方向（谁可以转给谁）是两个正交维度，混用会让两个开关重新耦合。

开关状态变化时触发事件（`WhitelistEnabledSet` / `TransferPathEnabledSet`）。

### 5.2 校验规则

`transfer` / `transferFrom` 调用统一的 `_checkTransfer(from, to)`：

| whitelistEnabled | transferPathEnabled | 行为 |
| --- | --- | --- |
| false | false | 全部放行（与旧版本默认行为一致） |
| true | false | 只检查收发双方均在白名单 |
| false | true | 只检查转账路径 |
| true | true | 白名单与路径必须同时通过 |

**严格模式下未配置路径时禁止转账：** `transferPathEnabled == true` 且
`transferPathCount == 0` 时回滚，而不是像现在这样直接放行。否则开启严格模式反而会因为没有
规则而意外全放行 —— 这正是本次反馈要修掉的问题。

`mint` / `burn` 不受上述检查影响，否则无法对已撤销白名单的地址执行销毁。

### 5.3 部署影响

`RWAToken` 不是可升级合约。测试网需要部署包含上述开关的新版 Token；若已有余额与业务配置，
还需完成余额迁移，以及前端、SDK 与部署地址的更新。**本次交付不执行测试网部署**，只提供合约、
测试与文档。

---

## 6. 第 5 项：产品核心信息写入 AssetRegistry

### 6.1 数据结构

```solidity
struct ProductInfo {
    string  productName;
    uint16  annualYieldRateBps;   // 500 = 年化 5%
    uint64  maturityTimestamp;    // Unix 时间戳
    address issuer;
    string  underlyingAsset;      // 底层资产名称或说明
}

mapping(uint256 assetId => ProductInfo) private _productInfo;

function getProductInfo(uint256 assetId) external view returns (ProductInfo memory);
```

`annualYieldRateBps` 用 `uint16`（上限 655.35%），`maturityTimestamp` 用 `uint64`，两者与
`address issuer` 可打包进同一个存储槽；两个 `string` 各占独立槽位。

### 6.2 registerAsset 扩展

`registerAsset` 增加一个 `ProductInfo calldata product` 结构体入参（用结构体而非平铺参数，
避免九个参数导致 stack too deep）。

**`issuer` 强制写入 `msg.sender`**，忽略调用方传入的值，避免登记任意地址冒充发行人。

### 6.3 事件：新增而非扩展

注册成功时**新增**一个事件，而不是加宽现有的 `AssetRegistered`：

```solidity
event ProductInfoSet(
    uint256 indexed assetId,
    address indexed issuer,
    string  productName,
    uint16  annualYieldRateBps,
    uint64  maturityTimestamp,
    string  underlyingAsset,
    uint256 timestamp
);
```

加宽 `AssetRegistered` 会改变其 ABI，导致既有 indexer 解码失败。新增事件在同一笔交易中触发，
信息完整，且对既有消费方零影响。

### 6.4 不实现更新接口

客户原文：“上述产品核心条款原则上应在注册后保持不变；如果业务上确实允许修改，应增加仅限
Issuer 调用的更新接口，并记录修改前后的内容及对应事件。”

这是一个**有条件**的要求 —— 默认立场是“注册后保持不变”，更新接口取决于“业务上确实允许
修改”这一尚未确认的前提。因此本次**不实现** `updateProductInfo`：现在加进去等于替客户把
不可变改成可变，削弱了他自己写下的默认约束。

在回应文档中把这一点单独提出来问客户；若确认允许修改，再补一个仅限 Issuer 调用、
记录修改前后内容并触发事件的接口。由于 AssetRegistry 本就要重新部署，这次一并加入的
成本与下次加入没有本质差别。

### 6.5 部署影响

`AssetRegistry` 不可升级，加入新参数与查询接口后需要重新部署。注意 `MintBurnController` 是在
`AssetRegistry` 构造函数内部 `new` 出来的，因此**重新部署 AssetRegistry 会连带产生一个新的
MintBurnController**，所有既有资产的登记关系不会自动迁移。同样，本次交付不执行测试网部署。

---

## 7. 链下与前端范围

| 范围 | 内容 |
| --- | --- |
| `offchain/src` | `sdk.ts`、`types.ts`、`abis-registry.ts`、`web3.ts`：删除 AdapterRegistry；新增 `sweepExpiredRequests`、白名单开关、产品信息读写 |
| `offchain/src/keeperBot.ts` | 新增到期清理循环：按批调用 `sweepExpiredRequests(maxCount)` 直至 `processed == 0` |
| `offchain/scripts` | `local/deploy.ts`、`testnet/config.ts`、`fork/config.ts` 移除 registry 接线 |
| `offchain/test` | 对应单元测试 |
| `control-panel` | `abis.js` / `abis.json` 重新生成；`index.html` 与 `standalone.html` 删除 AdapterRegistry 面板，新增白名单开关、产品信息表单、到期清理（批量大小 + 执行） |
| `docs/function-reference.md` | 同步接口变更 |
| `docs/contract-feedback-20260820-response.md` | 新建，简体中文，逐条回应五项建议 |

`hyperTessera-web/` 是**嵌套的独立 git 仓库**（含 `AdapterRegistryPanel.jsx`、
`adapterRegistryManage.js` 及自己的 ABI 快照），其改动会落在该仓库自己的提交中，不属于本仓库
的 PR。

---

## 8. 测试策略

Foundry：

- **第 1 项** —— 删除后 `addAdapter` 仍可由 Curator 正常添加任意 Adapter；Guardian 暂停后
  下单（三个 `create*Order`）、执行（三个 `execute*`）、`clearDealValue`、`unfreezeAllocator`
  全部回滚；撤单（三个 `cancel*Order`）、`freezeAllocator`、`updateDealData`、
  `setStalenessWindow` / `setDataProvider` 在暂停期间仍可用；解除暂停后下单与执行恢复。
  `BaseVault` 未改动，`fundAdapter` / `recallAdapter` 不在本项范围内。
- **第 2 项** —— 无权限地址可调用；`maxCount` 小于队列深度时分批推进且不重复处理；四个允许
  的产品状态各覆盖一次，OPERATING 下回滚；退款进入原 owner 而非 `msg.sender`。
- **第 3 项** —— 部分成交赎回被清理后状态为 SETTLED，`remainingShares` 已退还，
  `claimRedeem` 仍可领取 `settledAssets` 且不会被重复支付；完全未成交的赎回置为 CANCELLED；
  已 SETTLED 的申购份额仍归原 owner。
- **第 4 项** —— 四种开关组合各一例；严格模式无路径时禁止转账；mint/burn 不受影响；
  非 Issuer 调用开关回滚。
- **第 5 项** —— `issuer` 被强制为 `msg.sender`（传入他人地址无效）；`getProductInfo` 往返
  一致；`ProductInfoSet` 与既有 `AssetRegistered` 同时触发。
- **体积** —— `script/check-sizes.sh` 纳入 CI，作为 §2.5 决策的依据。

链下：vitest 单元测试覆盖新增 SDK 方法与 keeperBot 清理循环。

---

## 9. 实现顺序

1. 第 1 项（删除 AdapterRegistry + 暂停加固）—— 释放字节码，为后续腾出空间。
2. 第 5 项（AssetRegistry 产品信息）—— 与 Vault 完全解耦，独立。
3. 第 4 项（RWAToken 双开关）—— 同样与 Vault 解耦。
4. 第 2、3 项（分批清理 + 部分成交）—— 共用退款助手，一并实现。
5. 运行 `script/check-sizes.sh`，据结果决定是否重新引入 EIP-1167 克隆。
6. 链下、前端、文档同步。
