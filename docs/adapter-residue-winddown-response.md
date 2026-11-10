# ERC-4626 虚拟份额残留导致 Adapter 无法移除（2026-09-02）

对应口头反馈（未列入 V4 报告）：

> `removeAdapter` 要求 adapter 的 `realAssets` 为 0，最好不要这样设计。新版本的 ERC4626
> 由于增加了虚拟份额，有收益的情况下会出现残留，导致无法 remove。

结论：**反馈成立，已修复。** 并且同一根因还卡住了一处更严重的入口，一并处理，见第二节。

验证结果：`forge test` **1033 项全部通过**（本轮新增 7 项）。

---

## 一、问题复现

`BaseAdapter` 继承 OpenZeppelin v5 的 `ERC4626`，其换算带虚拟资产与虚拟份额：

```solidity
_convertToShares(assets) = assets * (totalSupply + 10**offset) / (totalAssets + 1)
_convertToAssets(shares) = shares * (totalAssets + 1) / (totalSupply + 10**offset)
```

`BaseAdapter` 未 override `_decimalsOffset()`（即 offset = 0），且
`totalAssets()` 直接返回 `realAssets()`。

实测：金库注资 1_000 USDT，Adapter 随后产生 100 USDT 收益（+10%）：

| 读数 | 值 |
|---|---|
| `totalSupply()` | 1_000_000_000 |
| `realAssets()` | 1_100_000_000 |
| `previewRedeem(全部份额)` | 1_099_999_999（**向下取整，少 1**） |
| `previewWithdraw(realAssets())` | 1_000_000_001（**比现有份额多 1 份**） |

两个方向都取不干净：

- `withdraw(全部余额)` 需要 1_000_000_001 份，而金库只有 1_000_000_000 份 → 回滚。
- `redeem(全部份额)` 向下取整 → `totalSupply` 归零，但 Adapter 仍留下 **1 wei**。

于是 `realAssets()` 恒大于 0，`removeAdapter` 的
`if (IAdapter(adapter_).realAssets() != 0) revert AdapterStillHasAssets(adapter_);`
永远无法满足。

残留量约为 `ceil((totalAssets - totalSupply) / (totalSupply + 1))`，正常收益率下是 1 wei 量级；
但若 Adapter 收到大额直接转账（`totalAssets` 远大于 `totalSupply`），残留会成比例放大，
因此不宜用固定阈值容忍。

## 二、同一根因还卡住了最终周期（反馈未提及）

`_requireAssetsWoundDown()`（`BaseVault.sol:804`）用的是同一个精确零判断：

```solidity
uint256 held = IAdapter(adapters[i]).realAssets();
if (held != 0) revert AssetsNotWoundDown(adapters[i], held);
```

它由 `snapshotSettlementPrice` 在**最终周期**调用。也就是说，任何产生过收益的 Adapter
留下的残留，不只是让 `removeAdapter` 失败，还会让产品**永远无法为最终周期定价**，
卡在 SETTLING 无法进入 MATURING。这比 `removeAdapter` 被卡严重得多，
故一并修复。`test_windDownToVault_unblocksTheFinalCycleWindDownCheck` 固定了这条。

## 三、修复方案：让残留可回收，而不是放宽判断

我们**没有**采用“放宽 `realAssets() == 0` 判断”的做法，原因有二：

1. 残留量并非恒为 1 wei（见第一节末），固定阈值不安全；
2. 放弃残留等于丢弃真实资金，且 Adapter 移除后这笔钱不再计入
   `grossManagedAssets()`，会产生账实不符。

改为补上 ERC-4626 换算本身无法表达的那一步——**直接搬运余额，不做换算**：

### 3.1 `BaseAdapter.windDownToVault()`（新增，Allocator 调用）

```solidity
function windDownToVault() external override {
    _onlyAllocator();

    uint256 liveDeals = liveDealOrderIds.length;
    uint256 locked = lockedProceeds;
    if (liveDeals != 0 || locked != 0) revert AdapterNotWoundDown(liveDeals, locked);

    uint256 assets = IERC20(asset()).balanceOf(address(this));
    uint256 shares = balanceOf(vault);
    if (shares > 0) _burn(vault, shares);
    if (assets > 0) IERC20(asset()).safeTransfer(vault, assets);

    emit WoundDownToVault(assets, shares, block.timestamp);
}
```

无换算即无取整，`realAssets()` 精确归零。份额一并销毁，Adapter 留在干净的空状态。

两个前置条件各自守住一件真实存在的东西，不是记账上的讲究：

- **`liveDealOrderIds.length == 0`**：存活的 deal 是尚未退场的头寸，
  若允许带着它移除 Adapter，该头寸的价值会从 `grossManagedAssets()` 中凭空消失。
- **`lockedProceeds == 0`**：这是买方为某张尚未交割的 Sell Order 托管的货款，
  不属于金库，不得被搬走。

### 3.2 权限与落点

用 Allocator 而非金库自身，与 `BaseVault.recallAdapter` 一致——这是最后一次回收资金，
属于资金调度而非治理行为；`removeAdapter` 仍归 Curator/Timelock，角色划分不变。
资金落点恒为 `vault`，与调用者无关，因此该权限无法被用于改变资金去向。

入口放在 Adapter 而不是在 `BaseVault` 上新增 `recallAdapterAll`：后者会让
`EarnVaultDeployer` 达到 24_711 字节、超出 EIP-170 上限 135 字节而无法部署
（该 deployer 目前仅剩 291 字节余量，CI 的 `check-sizes.sh` 与 W3 部署都会因此失败）。
Allocator 本来就直接调用 Adapter 上的 `executeBuy` / `clearDealValue` 等函数，
放在这里也更贴合既有用法。

**`grossManagedAssets()` 不变**：同一笔 USDT 只是从“通过 Adapter 的 `realAssets()` 计入”
变为“作为金库自身余额计入”。`test_windDownToVault_emptiesAProfitableAdapterAndAllowsRemoval`
对此做了断言。

### 3.3 两处精确零判断保持不变

`removeAdapter` 与 `_requireAssetsWoundDown` 的 `!= 0` 判断**一个字都没有改**。
它们本身是对的——防止带着真实头寸移除 Adapter；此前的问题是它们无法被满足，
而不是判断本身过严。修复补上了满足它们的手段。

## 四、新增测试（7 项，均在 `test/EarnVault.t.sol`）

- `test_erc4626Residue_recallAloneCanNeverEmptyAProfitableAdapter`
  —— 复现缺陷本身：两个方向都取不干净，`removeAdapter` 永久失败
- `test_windDownToVault_emptiesAProfitableAdapterAndAllowsRemoval`
  —— 修复后精确归零、`grossManagedAssets()` 不变、可成功移除
- `test_windDownToVault_unblocksTheFinalCycleWindDownCheck`
  —— 第二节的最终周期入口
- `test_windDownToVault_refusesWhileADealIsLive`
- `test_windDownToVault_refusesWhileProceedsAreEscrowed`
- `test_windDownToVault_onlyAllocator`

变异验证：去掉 `windDownToVault` 的两个前置条件后，两项拒绝测试均失败。

## 五、接口变更

**`IAdapter`**

- 新增 `windDownToVault()`
- 新增事件 `WoundDownToVault(uint256 assets, uint256 sharesBurned, uint256 timestamp)`
- 新增错误 `AdapterNotWoundDown(uint256 liveDeals, uint256 lockedProceeds)`

`IBaseVault` 无变更。

**运营流程变化**：清退 Adapter 或推进最终周期前，最后一步改为由 Allocator 调用
Adapter 的 `windDownToVault()`（而非用 `recallAdapter` 反复逼近余额）。
调用前需先退场所有 deal（`clearDealValue` 或 `executeSell`）并结清所有已托管的 Sell Order。
