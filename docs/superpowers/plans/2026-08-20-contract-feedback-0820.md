# 合约修改建议 0820 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按客户《合约修改建议 0820》第二版实现五项改动：删除 AdapterRegistry、Guardian 暂停加固、到期请求无权限分批清理（含部分成交处理）、RWAToken 白名单/路径双开关、AssetRegistry 产品核心信息上链。

**Architecture:** 先删除 AdapterRegistry 释放 Vault 字节码，再实现两个与 Vault 解耦的独立合约改动（AssetRegistry、RWAToken），最后实现占用 Vault 字节码的清理函数；全部完成后由 `script/check-sizes.sh` 决定是否需要重新引入 EIP-1167 克隆部署。

**Tech Stack:** Solidity 0.8.24、Foundry（forge test / forge build --sizes）、TypeScript + vitest（offchain）、原生 JS（control-panel）

**Spec:** `docs/superpowers/specs/2026-08-20-contract-feedback-0820-design.md`

**基线提交：** `edaa384`（分支 `revert-26-feedback-0820`）。回退 PR #26 后 `forge test` 955 项全部通过。

## Global Constraints

- Solidity 版本固定 `0.8.24`；`foundry.toml` 的 `optimizer_runs = 200`，**不启用 `via_ir`**。
- EIP-170 运行时字节码上限 **24,576** 字节。基线余量：`EarnVaultDeployer` 229 字节、`LiquidityEarnVaultDeployer` 1,162 字节。每完成一个任务都要跑一次 `script/check-sizes.sh`。
- 文档一律简体中文（大陆用词，引号用 “”）。代码注释与提交信息沿用所在文件/历史的既有语言习惯（本仓库合约注释为英文）。
- 所有类型在文件作用域声明，放在 `src/libs/Types.sol`（本仓库既有约定）。
- 不引入新的第三方依赖。
- 本次交付**不执行测试网部署**。
- `hyperTessera-web/` 是嵌套的独立 git 仓库，其改动不属于本仓库的提交范围（见 Task 8 说明）。

---

## File Structure

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `src/asset-management/vaults/AdapterRegistry.sol` | 删除 | 1 |
| `src/asset-management/vaults/AdapterRegistryFactory.sol` | 删除 | 1 |
| `src/interfaces/IAdapterRegistry.sol` | 删除 | 1 |
| `src/interfaces/IAdapterRegistryFactory.sol` | 删除 | 1 |
| `test/AdapterRegistryFactory.t.sol` | 删除 | 1 |
| `src/asset-management/vaults/BaseVault.sol` | 去 registry；清理函数与共享退款助手 | 1, 5 |
| `src/interfaces/IBaseVault.sol` | 同步签名、事件、错误 | 1, 5 |
| `src/interfaces/IVaultRoles.sol` | 删除 `adapterRegistry()` | 1 |
| `src/asset-management/vaults/VaultFactory.sol` / `src/interfaces/IVaultFactory.sol` | 部署路径去 registry | 1 |
| `src/asset-management/adaptors/BaseAdapter.sol` | 两个角色助手加暂停检查 | 2 |
| `src/asset-infrastructure/AssetRegistry.sol` / `src/interfaces/IAssetRegistry.sol` | ProductInfo 存储、注册、查询、更新 | 3 |
| `src/asset-infrastructure/RWAToken.sol` / `src/interfaces/IRWAToken.sol` | 白名单与路径双开关 | 4 |
| `script/Deploy.s.sol` | 去 registry 部署与接线；registerAsset 新签名 | 1, 3 |
| `offchain/src/**`, `control-panel/**` | SDK、keeperBot、ABI、操作面板 | 8 |
| `docs/**` | 接口文档与客户回应文档 | 9 |

---

## Task 1: 删除 AdapterRegistry

**Files:**
- Delete: `src/asset-management/vaults/AdapterRegistry.sol`, `src/asset-management/vaults/AdapterRegistryFactory.sol`, `src/interfaces/IAdapterRegistry.sol`, `src/interfaces/IAdapterRegistryFactory.sol`, `test/AdapterRegistryFactory.t.sol`
- Modify: `src/asset-management/vaults/BaseVault.sol:136`（存储槽）、`:165-175`（`bindGovernance`）、`:949-952`（`addAdapter`）
- Modify: `src/interfaces/IBaseVault.sol:225-227`
- Modify: `src/interfaces/IVaultRoles.sol:30`
- Modify: `src/asset-management/vaults/VaultFactory.sol:68,97`；`src/interfaces/IVaultFactory.sol:27`
- Modify: `script/Deploy.s.sol`（11 处，见 Step 6）
- Test: `test/DeployW4.t.sol`, `test/EarnVault.t.sol`, `test/LiquidityAdapter.t.sol`, `test/SettlementOrdering.t.sol`, `test/VaultAdapterFunding.t.sol`, `test/VaultFactory.t.sol`, `test/VaultTimelock.t.sol`

**Interfaces:**
- Produces: `IBaseVault.bindGovernance(address vaultTimelock_)` —— 单参数版本，Task 2 与 Task 5 均不再触碰它。
- Produces: `VaultParams` 结构体不再含 `adapterRegistry` 字段；Task 8 的 SDK 类型据此更新。

- [ ] **Step 1: 写失败测试 —— 任意 Adapter 均可被 Curator 添加**

在 `test/VaultAdapterFunding.t.sol` 中新增（该文件已有 vault + adapter 的 setUp）：

```solidity
/// @notice AdapterRegistry 删除后，Curator 添加 Adapter 不再需要任何登记前置。
function test_addAdapter_noRegistryGate() public {
    // 全新的、从未在任何 registry 登记过的 Adapter
    address fresh = address(/* 按本文件 setUp 里既有的 Adapter 构造方式新建一个 */);

    vm.prank(curator);
    vault.addAdapter(fresh);

    assertTrue(vault.isAdapter(fresh));
}
```

> **注意：Adapter 的构造方式照抄本文件 setUp，不要自拟。** `RWAAdapter` 的实际构造函数是
> `(IERC20 asset_, address vault_, address rwaToken_, address navOracle_, uint256 stalenessWindow_)`，
> 与 `BaseAdapter` 的形参顺序不同。先读该测试文件的 setUp 再写。

- [ ] **Step 2: 运行，确认失败**

Run: `forge test --match-test test_addAdapter_noRegistryGate -vv`
Expected: FAIL —— `AdapterNotAllowed`（当前仍有 registry 准入检查）。

- [ ] **Step 3: 删除四个源文件与一个测试文件**

```bash
git rm src/asset-management/vaults/AdapterRegistry.sol \
       src/asset-management/vaults/AdapterRegistryFactory.sol \
       src/interfaces/IAdapterRegistry.sol \
       src/interfaces/IAdapterRegistryFactory.sol \
       test/AdapterRegistryFactory.t.sol
```

- [ ] **Step 4: 改 `BaseVault.sol`**

删除 import：`import {IAdapterRegistry} from "../../interfaces/IAdapterRegistry.sol";`

删除存储槽（第 138 行）：`address public override adapterRegistry;`

`bindGovernance` 收窄为：

```solidity
    /// @notice One-time wiring of this Vault's VaultTimelock, called by VaultFactory in the same
    ///         transaction that constructs this Vault (VaultTimelock's own constructor needs this
    ///         Vault's address, so it cannot be a constructor arg here).
    function bindGovernance(address vaultTimelock_) external override {
        if (vaultTimelock != address(0)) revert GovernanceAlreadyBound();
        if (vaultTimelock_ == address(0)) revert ZeroAddress();
        vaultTimelock = vaultTimelock_;
    }
```

`addAdapter` 删掉准入检查这一行（其余检查全部保留）：

```solidity
        if (!IAdapterRegistry(adapterRegistry).isAdapterAllowed(adapter_)) revert AdapterNotAllowed(adapter_);
```

- [ ] **Step 5: 改三个接口文件**

`src/interfaces/IVaultRoles.sol` —— 删除第 30 行 `function adapterRegistry() external view returns (address);`

`src/interfaces/IBaseVault.sol` —— 把注释与签名改为单参数，并删除 `error AdapterNotAllowed(address adapter);`（`addAdapter` 已不再抛出它；用 `grep -rn "AdapterNotAllowed" src/ test/` 确认无残留引用）：

```solidity
    /// @notice One-time wiring of this Vault's VaultTimelock, called by VaultFactory in the same
    ///         transaction that constructs this Vault.
    function bindGovernance(address vaultTimelock_) external;
```

`src/interfaces/IVaultFactory.sol` —— 从 `VaultParams` 结构体删除第 27 行 `address adapterRegistry;`

- [ ] **Step 6: 改 `VaultFactory.sol` 与 `script/Deploy.s.sol`**

`VaultFactory.sol`：删除第 68 行 `if (params.adapterRegistry == address(0)) revert ZeroAddress();`，第 97 行改为 `IBaseVault(vault).bindGovernance(timelock);`

`script/Deploy.s.sol` 逐处清理：

- 删除第 24、25 行两个 import。
- 删除第 289、290 行两个状态变量 `adapterRegistryFactoryAddr` / `adapterRegistryAddr`。
- 删除第 328-333 行 AdapterRegistryFactory / AdapterRegistry 的部署与注释块。
- 第 337-339 行三个 `_deployXxxVault(...)` 调用去掉 `address(adapterRegistry)` 实参。
- 删除第 357、358 行两次赋值。
- 第 399、411、423 行三个内部函数签名去掉 `address adapterRegistry` 形参；第 404、416、428 行的 `VaultParams` 字面量去掉 `adapterRegistry:` 字段。
- 删除第 443、444 行两次 `vm.serializeAddress`。
- 删除第 573-579 行整段（读取三个 vault 的 registry 并 `setAdapterAllowed`）及其上方注释。

- [ ] **Step 7: 修测试文件**

七个测试文件里删除 AdapterRegistry 的构造、`setAdapterAllowed` 调用与 `VaultParams.adapterRegistry` 字段。定位：

```bash
grep -rn "adapterRegistry\|AdapterRegistry" test/*.sol
```

原本断言 `AdapterNotAllowed` 的用例（若有）直接删除 —— 该错误已不存在。

- [ ] **Step 8: 运行全量测试与体积检查**

Run: `forge test`
Expected: 全部通过（原 955 项减去 `AdapterRegistryFactory.t.sol` 的用例数，加上 Step 1 的新用例）。

Run: `script/check-sizes.sh`
Expected: 无超限；记录 `EarnVaultDeployer` 的新余量，供 Task 7 对比。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(contracts): 删除 AdapterRegistry，Adapter 由 Curator 直接添加

按《合约修改建议0820》第 1 项：AdapterRegistry 无法证明 Adapter 来自官方
AdapterFactory，登记机制只增加部署与操作复杂度，故整体删除。
按客户明确要求不引入任何替代校验。bindGovernance 收窄为单参数。"
```

---

## Task 2: Guardian 暂停后阻止 Adapter 运行

**Files:**
- Modify: `src/asset-management/adaptors/BaseAdapter.sol:65-72`（两个角色助手）——**本任务只改这一个源文件**
- Test: `test/BaseAdapter.t.sol`

**Interfaces:**
- Consumes: Task 1 的 `bindGovernance(address)`（本任务不触碰）。
- Produces: 无新接口；仅收紧既有入口的前置条件。

**背景（已核对代码，非推测）：** `_onlyCurator` 覆盖 `createBuyOrder` / `createSellOrder` / `createRebalanceOrder` / `unfreezeAllocator`；`_onlyAllocator` 覆盖 `executeBuy` / `executeSell` / `executeRebalance` / `clearDealValue`。三个 `cancel*Order` 走 `_onlyCuratorOrGuardian`，`freezeAllocator` 走 `_onlyGuardian`，二者**不在**加固范围内。

- [ ] **Step 1: 写失败测试**

在 `test/BaseAdapter.t.sol` 新增。`stateManager.pause(vault, PauseState.PAUSED_BY_GUARDIAN)` 需由该 vault 的 guardian 调用 —— 按该文件 setUp 里既有的 guardian 变量命名调整：

```solidity
function test_pausedVault_blocksOrderCreationAndExecution() public {
    vm.prank(guardian);
    stateManager.pause(address(vault), PauseState.PAUSED_BY_GUARDIAN);

    vm.prank(curator);
    vm.expectRevert();
    adapter.createSellOrder(1_000e6);

    vm.prank(allocator);
    vm.expectRevert();
    adapter.executeSell(existingSellOrderId);
}

function test_pausedVault_stillAllowsCancelAndFreeze() public {
    vm.prank(curator);
    uint256 orderId = adapter.createSellOrder(1_000e6);

    vm.prank(guardian);
    stateManager.pause(address(vault), PauseState.PAUSED_BY_GUARDIAN);

    // 撤单走 _onlyCuratorOrGuardian，暂停期间仍可用 —— 收敛风险
    vm.prank(curator);
    adapter.cancelSellOrder(orderId);

    // Guardian 冻结 Allocator 也必须可用
    vm.prank(guardian);
    adapter.freezeAllocator();
}

function test_pausedVault_blocksUnfreezeAllocator() public {
    vm.prank(guardian);
    adapter.freezeAllocator();

    vm.prank(guardian);
    stateManager.pause(address(vault), PauseState.PAUSED_BY_GUARDIAN);

    // unfreezeAllocator 走 _onlyCurator，因此被一并阻断 —— 暂停中不应解冻
    vm.prank(curator);
    vm.expectRevert();
    adapter.unfreezeAllocator();
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `forge test --match-test "test_pausedVault" -vv`
Expected: 两个"应回滚"的用例 FAIL（调用意外成功）；"应放行"的用例已经 PASS。

- [ ] **Step 3: 改 `BaseAdapter.sol` 两个助手**

```solidity
    /// @dev Also blocks while the Vault is paused: a Guardian halt must stop the adapter from
    ///      operating. Covers createBuy/Sell/RebalanceOrder and unfreezeAllocator. Cancellation
    ///      goes through _onlyCuratorOrGuardian and stays available on purpose — cancelling an
    ///      unexecuted order during an incident reduces exposure rather than adding to it.
    function _onlyCurator() internal view {
        if (IVaultRoles(vault).curator() != msg.sender) revert NotCurator();
        IStateManager(IVaultRoles(vault).stateManager()).requireActive(vault);
    }

    /// @dev Same pause gate as _onlyCurator; covers executeBuy/Sell/Rebalance and clearDealValue.
    function _onlyAllocator() internal view {
        if (IVaultRoles(vault).allocator() != msg.sender) revert NotAllocator();
        if (allocatorFrozen) revert AllocatorIsFrozen();
        IStateManager(IVaultRoles(vault).stateManager()).requireActive(vault);
    }
```

`IStateManager` 与 `IVaultRoles` 该文件已 import，无需新增。

> **`BaseVault` 不改。** `fundAdapter` / `recallAdapter` 都**不加**暂停检查。客户第二版把
> “阻止 Curator 继续创建订单、Allocator 继续执行订单和向 Adapter 划拨资金”整句删掉，只留
> “停止后可以阻止 adapter 的运行即可”。划拨资金因此不在诉求内，本任务不越界。

- [ ] **Step 4: 运行测试**

Run: `forge test --match-test "test_pausedVault" -vv`
Expected: 四个用例全部 PASS。

Run: `forge test`
Expected: 全部通过。若有既有用例因新检查失败，说明它在暂停状态下调用了下单/执行 —— 逐个确认是测试的前置状态不合理（改测试）还是本改动误伤（改实现）。

Run: `script/check-sizes.sh`
Expected: 无超限。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(contracts): Guardian 暂停后阻止 Adapter 运行

按《合约修改建议0820》第 1 项末段。暂停检查放进 BaseAdapter 的
_onlyCurator / _onlyAllocator 两个共享助手，覆盖下单与执行。
撤单与 freezeAllocator 走其他助手，暂停期间保持可用。

只改 BaseAdapter：客户第二版已删去“向 Adapter 划拨资金”一句，只保留“阻止
adapter 的运行即可”，因此 BaseVault.fundAdapter/recallAdapter 均不加检查。"
```

---

## Task 3: AssetRegistry 产品核心信息上链

**Files:**
- Modify: `src/interfaces/IAssetRegistry.sol:33`（事件区）、`:73-79`（`registerAsset`）
- Modify: `src/asset-infrastructure/AssetRegistry.sol:70-100`（`registerAsset`）、末尾（视图与更新函数）
- Modify: `script/Deploy.s.sol`、`test/AssetRegistry.t.sol`、`test/MintBurnController.t.sol`、`test/PoRRegistry.t.sol`、`test/RWAToken.t.sol`（`registerAsset` 调用点）
- Test: `test/AssetRegistry.t.sol`

**Interfaces:**
- Produces: `struct ProductInfo`（声明于 `src/interfaces/IAssetRegistry.sol` 内，与既有 `AssetInfo` 同处）
- Produces: `registerAsset(bytes32,string,string,uint8,FeePaymentKind,ProductInfo) returns (uint256,address)`
- Produces: `getProductInfo(uint256) returns (ProductInfo memory)`
- Produces: `event ProductInfoSet(...)` —— Task 8 的 ABI 与 indexer 据此更新。

- [ ] **Step 1: 写失败测试**

在 `test/AssetRegistry.t.sol` 新增：

```solidity
function _sampleProduct() internal pure returns (IAssetRegistry.ProductInfo memory) {
    return IAssetRegistry.ProductInfo({
        productName: "30-day T-Bill Note",
        annualYieldRateBps: 500,          // 年化 5%
        maturityTimestamp: 1790000000,
        issuer: address(0),               // 由合约强制覆盖为 msg.sender
        underlyingAsset: "US Treasury Bill"
    });
}

function test_registerAsset_storesProductInfo() public {
    vm.prank(alice);
    (uint256 id,) = registry.registerAsset(
        keccak256("meta"), "T", "T", 6, FeePaymentKind.Native, _sampleProduct()
    );

    IAssetRegistry.ProductInfo memory p = registry.getProductInfo(id);
    assertEq(p.productName, "30-day T-Bill Note");
    assertEq(p.annualYieldRateBps, 500);
    assertEq(p.maturityTimestamp, 1790000000);
    assertEq(p.underlyingAsset, "US Treasury Bill");
}

/// @notice issuer 必须是注册交易的 msg.sender，避免调用者登记任意地址冒充发行人。
function test_registerAsset_issuerForcedToSender() public {
    IAssetRegistry.ProductInfo memory p = _sampleProduct();
    p.issuer = bob; // 试图冒充

    vm.prank(alice);
    (uint256 id,) = registry.registerAsset(keccak256("m"), "T", "T", 6, FeePaymentKind.Native, p);

    assertEq(registry.getProductInfo(id).issuer, alice);
}

/// @notice 既有的 AssetRegistered 事件不得加宽，否则既有 indexer 解码失败。
function test_registerAsset_emitsBothEvents() public {
    vm.expectEmit(true, true, false, false);
    emit IAssetRegistry.ProductInfoSet(1, alice, "", 0, 0, "", 0);
    vm.prank(alice);
    registry.registerAsset(keccak256("m"), "T", "T", 6, FeePaymentKind.Native, _sampleProduct());
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `forge test --match-path test/AssetRegistry.t.sol -vv`
Expected: 编译失败 —— `ProductInfo` 未声明、`registerAsset` 参数个数不符。

- [ ] **Step 3: 改 `IAssetRegistry.sol`**

在 `AssetInfo` 附近新增结构体（`uint16` + `uint64` + `address` = 30 字节，打包进同一存储槽）：

```solidity
    /// @notice On-chain product terms recorded at registration. Kept as its own struct rather
    ///         than appended to AssetInfo so getAsset()'s ABI return shape is unchanged and
    ///         existing front ends keep decoding positionally.
    struct ProductInfo {
        string  productName;
        uint16  annualYieldRateBps;   // 500 == 5.00% APY
        uint64  maturityTimestamp;    // Unix seconds
        address issuer;               // always the registrant; ignored on input
        string  underlyingAsset;
    }
```

新增两个事件：

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

`registerAsset` 增加第六个参数，并新增一个查询函数声明：

```solidity
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

- [ ] **Step 4: 改 `AssetRegistry.sol`**

新增存储（放在 `metadataURIOf` 之后）：

```solidity
    mapping(uint256 assetId => ProductInfo) private _productInfo;
```

`registerAsset` 在 `emit AssetRegistered(...)` **之前**插入（`AssetRegistered` 本身一字不改）：

```solidity
        ProductInfo memory p = product;
        p.issuer = msg.sender; // forced — a caller must not be able to name someone else as issuer
        _productInfo[assetId] = p;

        emit ProductInfoSet(
            assetId, msg.sender, p.productName, p.annualYieldRateBps,
            p.maturityTimestamp, p.underlyingAsset, block.timestamp
        );
```

在视图区新增：

```solidity
    /// @inheritdoc IAssetRegistry
    function getProductInfo(uint256 assetId) external view override returns (ProductInfo memory) {
        return _productInfo[assetId];
    }
```

- [ ] **Step 5: 更新全部 `registerAsset` 调用点**

```bash
grep -rn "registerAsset(" test/ script/ --include="*.sol"
```

`script/Deploy.s.sol`、`test/AssetRegistry.t.sol`、`test/MintBurnController.t.sol`、`test/PoRRegistry.t.sol`、`test/RWAToken.t.sol` 各调用点补上第六个实参。测试里用一个贴近真实的产品信息，不要留空串：

```solidity
IAssetRegistry.ProductInfo({
    productName: "Test Note",
    annualYieldRateBps: 500,
    maturityTimestamp: 1790000000,
    issuer: address(0),
    underlyingAsset: "US Treasury Bill"
})
```

- [ ] **Step 6: 运行测试与体积检查**

Run: `forge test`
Expected: 全部通过。

Run: `script/check-sizes.sh`
Expected: 无超限（`AssetRegistry` 基线 10,109 字节，余量充裕）。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(contracts): AssetRegistry 注册时同步记录产品核心信息

按《合约修改建议0820》第 5 项：产品名称、收益率（基点）、到期日、
发行人、投资标的写入链上，新增 getProductInfo。issuer 强制为 msg.sender。

产品条款注册后不可变 —— 客户原文的默认要求是“注册后保持不变”，更新接口
是有条件的（“如果业务上确实允许修改”）。未收到该确认前不实现，避免削弱
客户明确表述的不可变性。

新增 ProductInfoSet 事件而非加宽 AssetRegistered —— 后者会改变
既有事件的 ABI，导致现有 indexer 解码失败。"
```

---

## Task 4: RWAToken 白名单与转账路径双开关

**Files:**
- Modify: `src/interfaces/IRWAToken.sol`（事件、错误、函数声明）
- Modify: `src/asset-infrastructure/RWAToken.sol:50-100`（状态与校验）、`:125-140`（`transfer`/`transferFrom`）、`:175-215`（管理函数区）
- Test: `test/RWAToken.t.sol`

**Interfaces:**
- Produces: `whitelistEnabled()`, `transferPathEnabled()`, `setWhitelistEnabled(bool)`, `setTransferPathEnabled(bool)`, `addToWhitelist(address[])`, `removeFromWhitelist(address[])`, `isWhitelisted(address)`
- Produces: `event WhitelistEnabledSet(bool,uint256)`, `event TransferPathEnabledSet(bool,uint256)`, `event WhitelistUpdated(bool,uint256,uint256)`, `error NotWhitelisted(address)`, `error NoTransferPathConfigured()`

- [ ] **Step 1: 写失败测试 —— 四种开关组合 + 严格模式空路径**

在 `test/RWAToken.t.sol` 新增。该文件 setUp 已备好 `issuer` / `alice` / `bob` / `controller`：

```solidity
function _mintTo(address to, uint256 amt) internal {
    vm.prank(controller);
    token.mint(to, amt);
}

/// @notice 两个开关都关 —— 保留旧版本默认开放转账的行为。
function test_bothOff_allTransfersPass() public {
    _mintTo(alice, 100);
    vm.prank(alice);
    token.transfer(bob, 10);
    assertEq(token.balanceOf(bob), 10);
}

function test_whitelistOnly_checksBothSides() public {
    _mintTo(alice, 100);
    vm.prank(issuer);
    token.setWhitelistEnabled(true);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IRWAToken.NotWhitelisted.selector, alice));
    token.transfer(bob, 10);

    address[] memory both = new address[](2);
    both[0] = alice; both[1] = bob;
    vm.prank(issuer);
    token.addToWhitelist(both);

    vm.prank(alice);
    token.transfer(bob, 10);
    assertEq(token.balanceOf(bob), 10);
}

/// @notice 严格路径模式但未配置任何路径 —— 必须禁止转账，而不是意外全放行。
function test_pathOnly_noPathsConfigured_blocksAll() public {
    _mintTo(alice, 100);
    vm.prank(issuer);
    token.setTransferPathEnabled(true);

    vm.prank(alice);
    vm.expectRevert(IRWAToken.NoTransferPathConfigured.selector);
    token.transfer(bob, 10);
}

function test_bothOn_requireWhitelistAndPath() public {
    _mintTo(alice, 100);

    address[] memory both = new address[](2);
    both[0] = alice; both[1] = bob;
    vm.startPrank(issuer);
    token.addToWhitelist(both);
    token.setWhitelistEnabled(true);
    token.setTransferPathEnabled(true);
    vm.stopPrank();

    // 白名单已过，但还没有路径规则
    vm.prank(alice);
    vm.expectRevert(IRWAToken.NoTransferPathConfigured.selector);
    token.transfer(bob, 10);

    // 配置 list 1 -> list 2 的路径，并把 alice/bob 各自入列
    address[] memory a = new address[](1); a[0] = alice;
    address[] memory b = new address[](1); b[0] = bob;
    uint8[] memory idx = new uint8[](1); idx[0] = 0;
    uint8[] memory from = new uint8[](1); from[0] = 1;
    uint8[] memory to = new uint8[](1); to[0] = 2;
    vm.startPrank(issuer);
    token.addToAddressList(1, a);
    token.addToAddressList(2, b);
    token.setTransferPaths(idx, from, to);
    vm.stopPrank();

    vm.prank(alice);
    token.transfer(bob, 10);
    assertEq(token.balanceOf(bob), 10);
}

/// @notice mint/burn 不受普通转账检查影响，否则无法对已撤销白名单的地址执行销毁。
function test_mintBurn_unaffectedByWhitelist() public {
    vm.prank(issuer);
    token.setWhitelistEnabled(true);

    vm.prank(controller);
    token.mint(alice, 100);          // alice 不在白名单

    vm.prank(controller);
    token.burn(alice, 100);
    assertEq(token.balanceOf(alice), 0);
}

function test_setSwitches_onlyIssuer() public {
    vm.prank(attacker);
    vm.expectRevert(IRWAToken.NotIssuer.selector);
    token.setWhitelistEnabled(true);
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `forge test --match-path test/RWAToken.t.sol -vv`
Expected: 编译失败 —— 开关函数与错误类型均未声明。

- [ ] **Step 3: 改 `IRWAToken.sol`**

```solidity
    event WhitelistEnabledSet(bool enabled, uint256 timestamp);
    event TransferPathEnabledSet(bool enabled, uint256 timestamp);
    event WhitelistUpdated(bool added, uint256 count, uint256 timestamp);

    error NotWhitelisted(address account);
    error NoTransferPathConfigured();

    function whitelistEnabled() external view returns (bool);
    function transferPathEnabled() external view returns (bool);
    function setWhitelistEnabled(bool enabled) external;
    function setTransferPathEnabled(bool enabled) external;
    function addToWhitelist(address[] calldata accounts) external;
    function removeFromWhitelist(address[] calldata accounts) external;
    function isWhitelisted(address account) external view returns (bool);
```

- [ ] **Step 4: 改 `RWAToken.sol`**

新增状态（放在转账路径状态区之后）：

```solidity
    /// @dev Whitelist (who may hold) and transfer paths (who may send to whom) are two orthogonal
    ///      controls. The whitelist deliberately does NOT reuse a `listId` — sharing storage would
    ///      re-couple the two switches that this design exists to separate. Both default to false,
    ///      preserving the pre-existing open-transfer behaviour.
    bool public override whitelistEnabled;
    bool public override transferPathEnabled;
    mapping(address account => bool) private _whitelisted;
```

用统一的 `_checkTransfer` 替换 `_checkTransferPath`：

```solidity
    function _checkTransfer(address from, address to) internal view {
        if (whitelistEnabled) {
            if (!_whitelisted[from]) revert NotWhitelisted(from);
            if (!_whitelisted[to]) revert NotWhitelisted(to);
        }
        if (!transferPathEnabled) return;

        // Strict mode with no rules must block, not fall open — falling open is precisely the
        // bug this switch was introduced to fix.
        uint8 count = transferPathCount;
        if (count == 0) revert NoTransferPathConfigured();
        for (uint8 i = 0; i < count; ++i) {
            TransferPath storage p = _transferPaths[i];
            if (_addressLists[p.fromListId][from] && _addressLists[p.toListId][to]) return;
        }
        revert TransferRestricted(from, to);
    }
```

`transfer` 与 `transferFrom` 里的 `_checkTransferPath(...)` 调用改为 `_checkTransfer(...)`；`mint` / `burn` 不动。

管理函数区新增：

```solidity
    /// @inheritdoc IRWAToken
    function setWhitelistEnabled(bool enabled) external override {
        _onlyIssuer();
        whitelistEnabled = enabled;
        emit WhitelistEnabledSet(enabled, block.timestamp);
    }

    /// @inheritdoc IRWAToken
    function setTransferPathEnabled(bool enabled) external override {
        _onlyIssuer();
        transferPathEnabled = enabled;
        emit TransferPathEnabledSet(enabled, block.timestamp);
    }

    /// @inheritdoc IRWAToken
    function addToWhitelist(address[] calldata accounts) external override {
        _onlyIssuer();
        for (uint256 i = 0; i < accounts.length; ++i) {
            _whitelisted[accounts[i]] = true;
        }
        emit WhitelistUpdated(true, accounts.length, block.timestamp);
    }

    /// @inheritdoc IRWAToken
    function removeFromWhitelist(address[] calldata accounts) external override {
        _onlyIssuer();
        for (uint256 i = 0; i < accounts.length; ++i) {
            _whitelisted[accounts[i]] = false;
        }
        emit WhitelistUpdated(false, accounts.length, block.timestamp);
    }

    /// @inheritdoc IRWAToken
    function isWhitelisted(address account) external view override returns (bool) {
        return _whitelisted[account];
    }
```

- [ ] **Step 5: 运行测试**

Run: `forge test --match-path test/RWAToken.t.sol -vv`
Expected: 全部 PASS。

Run: `forge test`
Expected: 全部通过。既有的 `transferPathCount == 0 时放行` 类用例现在只在 `transferPathEnabled == false` 下成立 —— 若有用例断言"开了路径但没配规则也放行"，它测的正是本次要修掉的缺陷，改成断言回滚。

Run: `script/check-sizes.sh`
Expected: 无超限（`RWAToken` 基线 4,202 字节）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(contracts): RWAToken 白名单与转账路径改为两个独立开关

按《合约修改建议0820》第 4 项：whitelistEnabled 与 transferPathEnabled
默认均关闭，保留旧版本默认开放转账的行为；四种组合按规则执行。
白名单使用独立映射而非复用 listId，使准入与路径方向真正解耦。
严格路径模式下未配置路径时禁止转账，而非意外放行。mint/burn 不受影响。

RWAToken 不可升级，测试网需重新部署新版 Token（本次不执行部署）。"
```

---

## Task 5: 到期请求无权限分批清理 + 部分成交处理

**Files:**
- Modify: `src/asset-management/vaults/BaseVault.sol:472-511`（`cancelRequest` 抽出助手）、末尾新增 `sweepExpiredRequests`
- Modify: `src/interfaces/IBaseVault.sol`（事件、错误、函数声明）
- Test: `test/EarnVault.t.sol`

**Interfaces:**
- Consumes: Task 1 的 `bindGovernance(address)`。Task 2 只改 `BaseAdapter.sol`，与本任务不冲突。
- Produces: `sweepExpiredRequests(uint256 maxCount) returns (uint256 processed)`、`event ExpiredRequestSwept(...)`、`error SweepNotAllowed(ProductState)` —— Task 8 的 keeperBot 与操作面板据此对接。

> ### 执行前必读：两条已裁定的计划修正
>
> **修正一 —— 游标不能用 `Queue.peek`。** 设计文档 §3.2 曾写“队列头本身就是游标”，该前提被
> 代码证伪：`Queue.remove`（`Queue.sol:123-137`）只把槽位写成 `TOMBSTONE`，**不推进
> `queueHead`**；而 `peek`（`Queue.sol:143`）直接返回 `_slots[vault][qt][queueHead]`，**不跳过
> 墓碑**。照原设计写出的循环会在第二轮 peek 到墓碑，并在 `IQueue.remove` 处以 `NotInQueue`
> 回滚。
>
> 改为在 BaseVault 侧维护 `uint256 private _sweepCursor;`，在 **requestId 空间**上推进：
> requestId 由 `nextRequestId` 从 1 单调递增，且申购与赎回**共用同一个 id 空间**，因此一个游标
> 一趟即可覆盖两个队列，顺序仍与入队顺序一致。游标只增不减，绝不重置。
>
> **修正二 —— 不新增 `getRedeemRequest`。** BaseVault 只有 `getDepositRequest`，没有赎回侧的
> 访问器。客户没有要求它，而 `EarnVault` 所在的 Deployer 字节码余量只有 229 字节，新增公开
> 视图有可能直接决定"直接部署还是克隆"。因此**用行为断言代替状态断言**：
>
> - 部分成交被清理后应为 SETTLED —— 断言 `claimRedeem` 成功且付出 `settledAssets`；
> - 完全未成交被清理后应为 CANCELLED —— 断言 `claimRedeem` 以 `RequestNotSettled` 回滚，
>   且份额已退回。
>
> 这样测的是用户实际能不能拿到钱，比读一个枚举更贴近本条建议要解决的问题。

- [ ] **Step 1: 写失败测试**

在 `test/EarnVault.t.sol` 新增。**下列代码是行为规格，不是可直接粘贴的字面量** —— 该文件实际
可用的辅助函数是 `_requestDeposit(address,uint256)`、`_settleRedeems`、`_advanceToCalculating`、
`_completeCycle`、`_addAdapter`，**没有** `_requestDepositAs` / `_advanceToSettling` /
`_requestRedeemAs` / `_settleRedeemPartially`，也**没有** `carol`（只有 `alice`、`bob`）。
先读 setUp 与既有辅助函数，再用它们把下面的场景搭出来；推进到 SETTLING 用
`grep -n "SETTLING\|enterFinalSettlement" test/EarnVault.t.sol` 定位既有写法。部分成交通过
`_settleRedeems` 传入小于全额的 `RequestSettlement.settleAmount` 构造。

```solidity
/// @notice 无权限：任意地址都能代为清理，退款进原 owner 而非 msg.sender。
function test_sweep_permissionless_refundsOriginalOwner() public {
    _requestDepositAs(alice, 1_000e6);
    _advanceToSettling();

    uint256 before = usdt.balanceOf(alice);
    address stranger = makeAddr("stranger");

    vm.prank(stranger);
    uint256 processed = vault.sweepExpiredRequests(10);

    assertEq(processed, 1);
    assertEq(usdt.balanceOf(alice), before + 1_000e6);
    assertEq(usdt.balanceOf(stranger), 0);
}

/// @notice maxCount 小于队列深度时分批推进，重复调用不重复处理。
function test_sweep_batchesAndDoesNotDoubleProcess() public {
    _requestDepositAs(alice, 100e6);
    _requestDepositAs(bob, 100e6);
    _requestDepositAs(carol, 100e6);
    _advanceToSettling();

    assertEq(vault.sweepExpiredRequests(2), 2);
    assertEq(vault.sweepExpiredRequests(2), 1);
    assertEq(vault.sweepExpiredRequests(2), 0);
}

/// @notice OPERATING 阶段不允许清理。
function test_sweep_revertsInOperating() public {
    _requestDepositAs(alice, 100e6);
    vm.expectRevert();
    vault.sweepExpiredRequests(10);
}

/// @notice 部分成交的赎回：只退未成交份额，已成交部分仍可 claimRedeem，且不会被重复支付。
function test_sweep_partiallyFilledRedeem_promotedToSettled() public {
    uint256 reqId = _requestRedeemAs(alice, 1_000e18);
    _settleRedeemPartially(reqId, 400e18);   // 成交 400，剩 600
    _advanceToSettling();

    uint256 sharesBefore = vault.balanceOf(alice);
    vault.sweepExpiredRequests(10);

    // 未成交的 600 份额已退还
    assertEq(vault.balanceOf(alice), sharesBefore + 600e18);
    // 提升为 SETTLED 而非 CANCELLED —— 否则那笔已预留的 USDT 永远无法领取。
    // 用 claimRedeem 能否成功来断言，不新增状态访问器。
    uint256 usdtBefore = usdt.balanceOf(alice);
    vm.prank(alice);
    uint256 assets = vault.claimRedeem(reqId, alice);
    assertGt(assets, 0);
    assertEq(usdt.balanceOf(alice), usdtBefore + assets);

    // 不会被重复支付
    vm.prank(alice);
    vm.expectRevert();
    vault.claimRedeem(reqId, alice);
}

/// @notice 完全未成交的赎回置为 CANCELLED —— 份额全额退回，且无款可领。
function test_sweep_unfilledRedeem_cancelled() public {
    uint256 sharesBefore = vault.balanceOf(alice);
    uint256 reqId = _requestRedeemAs(alice, 1_000e18);
    _advanceToSettling();

    vault.sweepExpiredRequests(10);

    assertEq(vault.balanceOf(alice), sharesBefore);   // 份额全额退回
    vm.prank(alice);
    vm.expectRevert();                                 // 未成交，无 settledAssets 可领
    vault.claimRedeem(reqId, alice);
}
```

四个允许状态各覆盖一次（MATURING / CLAIMING / CLOSED 与 SETTLING 同理），照 `test_sweep_permissionless_refundsOriginalOwner` 复制，只替换推进函数。

- [ ] **Step 2: 运行，确认失败**

Run: `forge test --match-test "test_sweep" -vv`
Expected: 编译失败 —— `sweepExpiredRequests` 未声明。

- [ ] **Step 3: 抽出共享退款助手**

在 `BaseVault.sol` 新增两个内部函数，把 `cancelRequest` 里的对应逻辑搬进来。注意两处都退给 `req.owner`，不是 `msg.sender` —— 这是无权限调用能安全成立的前提：

```solidity
    /// @dev Unwinds a PENDING deposit back to its owner: liability, per-owner tally, queue slot,
    ///      and the StateManager subscription allowance all have to move together.
    function _unwindPendingDeposit(uint256 requestId, DepositRequestInternal storage dep) internal {
        dep.state = DepositRequestState.CANCELLED;
        pendingDepositLiability -= dep.assets;
        pendingDepositByOwner[dep.owner] -= dep.assets;
        IQueue(queue).remove(address(this), QueueType.DEPOSIT, requestId);
        IStateManager(stateManager).releaseSubscription(address(this), dep.owner, dep.assets);
        IERC20(usdt).safeTransfer(dep.owner, dep.assets);
    }

    /// @dev Unwinds a QUEUED redeem, returning only the shares the vault still holds on its
    ///      behalf. A partially-filled request already had its filled portion burned and its USDT
    ///      reserved in a prior settle(), so it is promoted to SETTLED rather than CANCELLED —
    ///      claimRedeem only accepts SETTLED, and marking it CANCELLED would strand that USDT
    ///      permanently.
    function _unwindQueuedRedeem(uint256 requestId, RedeemRequestInternal storage red) internal {
        uint256 returned = red.remainingShares;
        red.remainingShares = 0;
        red.state = red.settledAssets > 0 ? RedeemRequestState.SETTLED : RedeemRequestState.CANCELLED;
        IQueue(queue).remove(address(this), QueueType.REDEEM, requestId);
        if (returned > 0) _transferShares(address(this), red.owner, returned);
    }
```

改写 `cancelRequest` 调用这两个助手。**`cancelRequest` 现有的两条边界不得放宽**：仅 `CycleState.ACCEPTING` 可取消；部分成交的赎回（`remainingShares != red.shares`）仍然回滚。

- [ ] **Step 4: 实现 `sweepExpiredRequests`**

```solidity
    /// @notice Return funds/shares on requests that will never settle, in repeatable batches.
    /// @dev    Permissionless on purpose: who gets refunded and how much is fully determined by
    ///         the on-chain request record, so there is nothing for a role check to protect.
    ///         Not gated on PauseState either — this is a refund path, and claimDeposit /
    ///         claimRedeem / claimRefund are likewise ungated; blocking it while paused would
    ///         mean settled money stays claimable while unsettled money does not.
    ///
    ///         The cursor walks requestId space rather than the queue: Queue.remove only
    ///         tombstones a slot without advancing queueHead, and peek does not skip tombstones,
    ///         so the queue head cannot serve as a cursor here. Ids are monotonic from 1 and
    ///         shared by both queues, so one cursor covers deposits and redeems in enqueue order.
    /// @return processed Number of requests unwound in this call; keep calling while it is non-zero.
    function sweepExpiredRequests(uint256 maxCount) external nonReentrant returns (uint256 processed) {
        ProductState ps = IStateManager(stateManager).getProductState(address(this));
        if (ps != ProductState.SETTLING && ps != ProductState.MATURING &&
            ps != ProductState.CLAIMING && ps != ProductState.CLOSED) {
            revert SweepNotAllowed(ps);
        }

        uint256 cursor = _sweepCursor;
        if (cursor == 0) cursor = 1; // requestIds start at 1
        uint256 end = nextRequestId;

        while (cursor < end && processed < maxCount) {
            DepositRequestInternal storage dep = _depositRequests[cursor];
            RedeemRequestInternal storage red = _redeemRequests[cursor];

            if (dep.owner != address(0) && dep.state == DepositRequestState.PENDING) {
                uint256 amount = dep.assets;
                address o = dep.owner;
                _unwindPendingDeposit(cursor, dep);
                emit ExpiredRequestSwept(cursor, o, QueueType.DEPOSIT, amount, block.timestamp);
                unchecked { ++processed; }
            } else if (red.owner != address(0) && red.state == RedeemRequestState.QUEUED) {
                uint256 amount = red.remainingShares;
                address o = red.owner;
                _unwindQueuedRedeem(cursor, red);
                emit ExpiredRequestSwept(cursor, o, QueueType.REDEEM, amount, block.timestamp);
                unchecked { ++processed; }
            }

            unchecked { ++cursor; }
        }

        _sweepCursor = cursor;
    }
```

新增存储槽（放在 `nextRequestId` 附近）：

```solidity
    /// @dev Monotonic sweep position in requestId space. Never reset — resetting would re-walk
    ///      already-unwound requests. Zero means "not started"; requestIds begin at 1.
    uint256 private _sweepCursor;
```

> **游标推进的一个后果，必须有测试覆盖：** 游标只增不减，因此 `maxCount` 用尽时游标停在
> 已处理位置之后，下一批从那里继续；而**跳过的请求（已 SETTLED / CLAIMED / CANCELLED）
> 也会被游标越过**，不会再被检查。这是正确的 —— 它们不需要清理 —— 但要有一个用例断言
> "已 SETTLED 的申购/赎回被跳过且状态不变"。

在 `IBaseVault.sol` 声明：

```solidity
    event ExpiredRequestSwept(
        uint256 indexed requestId,
        address indexed owner,
        QueueType queueType,
        uint256 returnedAmount,
        uint256 timestamp
    );

    error SweepNotAllowed(ProductState current);

    function sweepExpiredRequests(uint256 maxCount) external returns (uint256 processed);
```

- [ ] **Step 5: 运行测试**

Run: `forge test --match-test "test_sweep" -vv`
Expected: 全部 PASS。

Run: `forge test`
Expected: 全部通过。

- [ ] **Step 6: 体积检查（关键节点）**

Run: `script/check-sizes.sh`
Expected: 记录 `EarnVaultDeployer` / `LiquidityEarnVaultDeployer` 的最终数值。这是 Task 7 的输入。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(contracts): 到期请求改为无权限分批清理，部分成交赎回提升为 SETTLED

按《合约修改建议0820》第 2、3 项。sweepExpiredRequests(maxCount) 任何
地址均可调用，允许在 SETTLING/MATURING/CLAIMING/CLOSED 执行；队列头即
游标，无需额外游标存储。退款一律进原 request owner。

部分成交的赎回只退未成交的 remainingShares 并提升为 SETTLED —— 若置为
CANCELLED，claimRedeem 只接受 SETTLED，已预留的 USDT 将永久无法领取。

cancelRequest 与清理函数共用 _unwindPendingDeposit / _unwindQueuedRedeem，
cancelRequest 自身的两条边界（仅 ACCEPTING、拒绝部分成交）保持不变。"
```

---

## Task 6: 体积决策 —— 直接部署 vs EIP-1167 克隆

**Files:**
- 视测量结果而定；若需克隆，参照 `git show 436614f -- src/asset-management/vaults/` 取回 PR #26 的实现

**Interfaces:**
- Consumes: Task 1-5 全部完成后的字节码体积。

- [ ] **Step 1: 测量**

Run: `script/check-sizes.sh 2048`
记录 `EarnVaultDeployer`、`LiquidityEarnVaultDeployer` 的运行时字节数与余量。

- [ ] **Step 2: 分支决策**

**若两个 Deployer 均 < 24,576：** 保留回退后恢复的直接部署方案，本任务到此结束，无代码改动。在 Task 9 的回应文档中写明实测数值。

**若任一超限：** 重新引入 PR #26 的 EIP-1167 方案。参考实现在 `436614f`：

```bash
git show 436614f -- src/asset-management/vaults/VaultFactory.sol \
                    src/asset-management/vaults/VaultInsolvency.sol \
                    src/asset-management/vaults/EarnVault.sol \
                    src/asset-management/vaults/LiquidityEarnVault.sol
```

要点（照搬，不要重新设计）：
1. `VaultFactory` 用 OpenZeppelin `Clones` 克隆 `EarnVault` / `LiquidityEarnVault` 实现合约；删除两个 Deployer。
2. Vault 去构造参数，改 `initialize(...)`，由 `initializer` 保证一次性；实现合约自身在构造时锁定。Factory 在同一笔交易内克隆并初始化，不留未初始化的可观测状态。
3. 若 `initialize` 把构造逻辑搬进运行时码后 `EarnVault` 本身超限，把 `writeDownInsolvency` 的数组遍历抽出为外部库 `VaultInsolvency`（delegatecall，读写 Vault 自身存储，事件仍以 Vault 地址触发）。

注意与本次的差异：PR #26 的 `VaultFactory` 仍带 `adapterRegistry` 参数，取回时必须按 Task 1 去掉。

- [ ] **Step 3: 验证**

Run: `forge test`
Run: `script/check-sizes.sh`
Expected: 全部通过，无合约超限。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore(contracts): 记录体积测量结果 / 按需恢复 EIP-1167 克隆部署"
```

提交信息按实际走的分支改写，并写明实测字节数。

---

## Task 7: 链下 SDK 与 keeperBot

**Files:**
- Modify: `offchain/src/types.ts`, `offchain/src/sdk.ts`, `offchain/src/abis-registry.ts`, `offchain/src/web3.ts`, `offchain/src/indexer.ts`
- Modify: `offchain/src/keeperBot.ts`
- Modify: `offchain/scripts/local/deploy.ts`, `offchain/scripts/testnet/config.ts`, `offchain/scripts/fork/config.ts`, `offchain/scripts/fork/runForkE2E.ts`
- Test: `offchain/test/sdk.unit.test.ts`, `offchain/test/keeperBot.unit.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `VaultParams`（无 `adapterRegistry`）、Task 3 的 `registerAsset` 六参数与 `ProductInfo`、Task 4 的开关函数、Task 5 的 `sweepExpiredRequests`。

- [ ] **Step 1: 同步 ABI 注册表**

Run: `forge build`

`offchain/src/abis-registry.ts` 是**手工维护**的：文件顶部是 `ContractName` 联合类型，下面是各合约的 ABI 常量。从 `ContractName` 删除 `"AdapterRegistry"`（以及若存在的 `"AdapterRegistryFactory"`），删掉对应的 ABI 常量与导出映射条目，再把 `AssetRegistry`、`RWAToken`、`EarnVault`、`LiquidityEarnVault`、`VaultFactory` 五个合约的 ABI 从 `out/<Contract>.sol/<Contract>.json` 的 `.abi` 字段更新过来。

删除条目后 `npx tsc --noEmit` 会指出所有仍在引用 `"AdapterRegistry"` 的位置 —— 按它的报错逐个清理，比 grep 可靠。

- [ ] **Step 2: 写失败测试**

在 `offchain/test/sdk.unit.test.ts` 新增：`registerAsset` 传入 productInfo 时编码出六个参数；`getProductInfo` 解码往返一致；`setWhitelistEnabled` / `setTransferPathEnabled` 存在于 SDK 表面。

在 `offchain/test/keeperBot.unit.test.ts` 新增：清理循环在 `processed == maxCount` 时继续调用、在 `processed == 0` 时停止、在 `processed < maxCount` 时也停止。

- [ ] **Step 3: 运行，确认失败**

Run: `cd offchain && npm test`
Expected: 新用例 FAIL。

- [ ] **Step 4: 实现**

`types.ts`：删除 `adapterRegistry` 相关类型；新增 `ProductInfo` 接口（字段与 Solidity 结构体逐一对应：`productName: string`、`annualYieldRateBps: number`、`maturityTimestamp: bigint`、`issuer: string`、`underlyingAsset: string`）。

`sdk.ts`：删除 AdapterRegistry 方法；`registerAsset` 增加 `product` 参数；新增 `getProductInfo`、`setWhitelistEnabled`、`setTransferPathEnabled`、`addToWhitelist`、`removeFromWhitelist`、`isWhitelisted`、`sweepExpiredRequests`。

`keeperBot.ts`：新增清理循环，`maxCount` 可配：

```ts
async function sweepExpired(vault: string, maxCount: number): Promise<number> {
  let total = 0;
  for (;;) {
    const processed = await sdk.sweepExpiredRequests(vault, maxCount);
    total += processed;
    if (processed < maxCount) return total;  // 队列已排空
  }
}
```

`indexer.ts`：订阅新事件 `ExpiredRequestSwept`、`ProductInfoSet`、`WhitelistEnabledSet`、`TransferPathEnabledSet`、`WhitelistUpdated`；删除 AdapterRegistry 事件。

四个 scripts 文件删除 registry 接线，`registerAsset` 调用补第六参。

- [ ] **Step 5: 运行测试**

Run: `cd offchain && npm test`
Expected: 全部通过。

Run: `cd offchain && npx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(offchain): SDK/keeperBot/indexer 同步合约改动

删除 AdapterRegistry；registerAsset 增加产品信息参数；新增白名单与
路径开关、getProductInfo；keeperBot 增加到期请求
分批清理循环（processed < maxCount 即视为队列排空）。"
```

---

## Task 8: control-panel 操作面板

**Files:**
- Modify: `control-panel/abis.js`, `control-panel/abis.json`, `control-panel/index.html`, `control-panel/standalone.html`, `control-panel/config.js`

**Interfaces:**
- Consumes: Task 7 的 ABI 与 SDK 表面。

- [ ] **Step 1: 同步 ABI**

`abis.json` / `abis.js` 由 `control-panel/build-abis.sh` 从 `out/` 产物生成，不要手工改。先从该脚本的合约清单里删掉 `AdapterRegistry` 与 `AdapterRegistryFactory`，再执行：

```bash
forge build && control-panel/build-abis.sh
```

`abis.js` 的内容是 `window.HT_ABIS = {...};`，由脚本自动写出。

- [ ] **Step 2: 改面板**

- 删除 AdapterRegistry 面板及其配置项。
- Issuer 面板新增：白名单开关（两个 toggle）、白名单地址批量增删。
- 资产注册表单新增五个产品信息字段：产品名称（文本）、年化收益率（基点，整数，提示"500 = 5%"）、到期日（日期选择器，提交时转 Unix 秒）、投资标的（文本）。**发行人不做输入框** —— 合约强制取 `msg.sender`，给输入框会误导用户。
- Curator 面板新增"到期请求清理"：批量大小输入框 + 执行按钮，调用 `sweepExpiredRequests(maxCount)`，展示返回的 `processed` 并提示是否需要继续。

`standalone.html` 是提交进仓库的构建产物，按 `control-panel/bundle.sh` 重新生成，不要手工改。

- [ ] **Step 3: 验证**

在本地起 control-panel，对着 `offchain/scripts/local/deploy.ts` 部署的本地链走一遍：注册一个带产品信息的资产、开关白名单、执行一次清理。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(control-panel): 同步合约改动的操作面板

删除 AdapterRegistry 面板；新增白名单/路径开关、产品信息注册表单、
到期请求分批清理入口。发行人字段不设输入框（合约强制取 msg.sender）。"
```

---

## Task 9: 文档

**Files:**
- Modify: `docs/function-reference.md`
- Create: `docs/contract-feedback-20260820-response.md`

- [ ] **Step 1: 更新接口文档**

`docs/function-reference.md`：删除 AdapterRegistry 全节；更新 `bindGovernance`、`registerAsset`；新增 `sweepExpiredRequests`、`getProductInfo`、四个白名单/开关函数。

- [ ] **Step 2: 写客户回应文档**

`docs/contract-feedback-20260820-response.md`，简体中文，逐条回应五项建议。每条写：客户诉求、实现方式、涉及文件、测试覆盖。另外必须写清三件事：

1. **第 2 项的接口理解** —— "为 Curator 增加清理操作接口"实现为运维接口（control-panel / keeperBot 的批量大小 + 执行入口），链上仍是单一的无权限函数；在无权限函数之上加 Curator 包装不带来安全收益，因为任何人都能绕过包装直接调用。若客户确实要求链上包装函数，需要回改。
2. **体积决策的实测结果** —— 写明 Task 6 测得的字节数，以及最终采用直接部署还是克隆。
3. **重新部署的影响** —— `RWAToken` 与 `AssetRegistry` 均不可升级，测试网需重新部署；特别提示 `MintBurnController` 是在 `AssetRegistry` 构造函数内部 `new` 出来的，**重新部署 AssetRegistry 会连带产生一个新的 MintBurnController**，既有资产的登记关系不会自动迁移。本次交付不执行部署。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "docs: 合约修改建议0820 接口文档更新与客户回应"
```

---

## Task 10: 收尾验证

- [ ] **Step 1: 全量验证**

```bash
forge test
script/check-sizes.sh
cd offchain && npm test && npx tsc --noEmit
```

Expected: 三项全绿，无合约超限。

- [ ] **Step 2: 核对五项建议逐条落地**

对照 `docs/superpowers/specs/2026-08-20-contract-feedback-0820-source.md`（客户原文）逐条打勾。

- [ ] **Step 3: 开 PR**

```bash
git push -u origin revert-26-feedback-0820
gh pr create --title "revert PR #26 + 按《合约修改建议0820》实现五项改动" --body-file docs/contract-feedback-20260820-response.md
```

---

## 遗留事项（不在本计划范围）

- **`hyperTessera-web/`** 是嵌套的独立 git 仓库，含 `AdapterRegistryPanel.jsx`、`adapterRegistryManage.js`、`currentAdapter.js` 及自己的 ABI 快照 `abis.target.json`。同样的改动需要在该仓库单独提交，不属于本仓库的 PR。
- **测试网重新部署** —— `RWAToken`、`AssetRegistry`（及连带的 `MintBurnController`）需要重新部署，含余额迁移与地址/ABI 更新。按客户确认的时间另行安排。
