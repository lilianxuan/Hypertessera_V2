# Partial Queue Settlement & Protocol Creation Fees — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let EarnVault deposit/redeem requests be partially filled within a settlement cycle instead of all-or-nothing, and require a protocol-configured creation fee (native/governance-token/stablecoin) before `AssetRegistry.registerAsset` or `VaultFactory.deployVault` can create anything.

**Architecture:** Part A threads a new `RequestSettlement{requestId, settleAmount}` struct through `Settlement.submitBatch` → `BaseVault.settle()`, replacing flat `uint256[]` id arrays; a partially-filled redeem stays at its Queue FIFO head (not dequeued) while a partially-filled deposit always resolves in one transaction (accept + immediate refund of the rest). Part B adds a new `ProtocolFeeConfig` contract (pure Governor-set config, no custody) that `AssetRegistry`/`VaultFactory` each consult and then pull-and-forward funds directly to `RevenuePool` before doing any creation work.

**Tech Stack:** Solidity 0.8.24, Foundry (forge test), TypeScript offchain SDK (ethers).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-partial-settlement-and-creation-fees-design.md` — every task below implements a section of it; section refs (§A.x / §B.x) are cited per task.
- Part A scope is EarnVault's net-settlement path only (`BaseVault`, `Settlement`, `Types.sol`). `LiquidityEarnVault` gets signature parity only, no new partial-fill behavior (§A, Scope).
- A deposit request always resolves fully within the cycle it's touched (accept + immediate refund of the rest) — never left partially queued (§A.1).
- A redeem request may span multiple cycles; whatever isn't paid stays queued in its original FIFO position (§A.1).
- `Queue.sol` itself is not modified (§A.3).
- Fee amounts and the fee recipient (`RevenuePool`) are always protocol-configured (Governor-only) — a creator only picks which of `{Native, Governance, Stable}` to pay with, never the amount or recipient (§B.1).
- Both `AssetRegistry.registerAsset` and `VaultFactory.deployVault` stay fully permissionless — the fee gate adds a payment requirement, not an allowlist (§B.1).
- Run `forge test` after every task; it must be green before moving to the next task.
- No `Claude`/session references in commit messages (repo convention already followed on this branch).

---

## Part A — Partial queue settlement

### Task 1: BaseVault core — RequestSettlement-based settle(), partial deposit/redeem processing

**Files:**
- Modify: `src/libs/Types.sol`
- Modify: `src/asset-management/vaults/BaseVault.sol`
- Modify: `src/interfaces/IBaseVault.sol`
- Modify: `test/EarnVault.t.sol` (mechanical signature update only — new behavior tests are Task 4)

**Interfaces:**
- Produces: `struct RequestSettlement { uint256 requestId; uint256 settleAmount; }` in `Types.sol`, imported by `IBaseVault`/`BaseVault`/`ISettlement`/`Settlement` (Task 3).
- Produces: `IBaseVault.settle(uint256 cycleNumber, RequestSettlement[] calldata deposits, RequestSettlement[] calldata redeems, uint256 poolDistributedAssets) external returns (uint256[] memory fullyClearedRedeemIds)` — new signature, `LiquidityEarnVault.settle()` (Task 2) and `Settlement.submitBatch` (Task 3) both depend on it.
- Produces: `event DepositSettled(uint256 indexed requestId, uint256 originalAssets, uint256 settledAssets, uint256 refundedAssets, uint256 indexed cycleNumber, uint256 timestamp)`.
- Produces: `event RedeemSettled(uint256 indexed requestId, uint256 originalShares, uint256 settledSharesThisCycle, uint256 remainingShares, uint256 settledAssetsThisCycle, uint256 indexed cycleNumber, uint256 timestamp)`.
- Produces: `error InvalidSettleAmount(uint256 requestId)`.
- Produces: `RedeemRequestInternal.remainingShares` field (was implicit; now explicit and load-bearing for Task 4's multi-cycle tests).

- [ ] **Step 1: Add `RequestSettlement` to Types.sol**

Add to `src/libs/Types.sol`, in the "Structs" section (after `ProductParams`, before the `DepositRequestState` enum):

```solidity
/// @notice One request's per-cycle settlement instruction. `settleAmount` is in assets (USDT)
///         for a deposit, in shares for a redeem. A request may be settled for less than its
///         full remaining amount — see BaseVault.settle() (development-plan §8, partial
///         settlement extension 2026-08-05).
struct RequestSettlement {
    uint256 requestId;
    uint256 settleAmount;
}
```

- [ ] **Step 2: Update IBaseVault.sol — new settle() signature, events, error**

In `src/interfaces/IBaseVault.sol`:

Change the import line to pull in the new struct:
```solidity
import {CycleState, DepositRequestState, RedeemRequestState, RequestSettlement} from "../libs/Types.sol";
```

Replace the `settle` declaration:
```solidity
function settle(
    uint256 cycleNumber,
    RequestSettlement[] calldata deposits,
    RequestSettlement[] calldata redeems,
    uint256 poolDistributedAssets
) external returns (uint256[] memory fullyClearedRedeemIds);
```

Add two events (next to `RequestWrittenDown`):
```solidity
event DepositSettled(
    uint256 indexed requestId, uint256 originalAssets, uint256 settledAssets, uint256 refundedAssets,
    uint256 indexed cycleNumber, uint256 timestamp
);
event RedeemSettled(
    uint256 indexed requestId, uint256 originalShares, uint256 settledSharesThisCycle, uint256 remainingShares,
    uint256 settledAssetsThisCycle, uint256 indexed cycleNumber, uint256 timestamp
);
```

Add one error (next to `WriteDownIncreasesLiability`):
```solidity
error InvalidSettleAmount(uint256 requestId);
```

- [ ] **Step 3: Rewrite BaseVault's request struct, settle(), and the two `_process*` internals**

In `src/asset-management/vaults/BaseVault.sol`:

Update the import line:
```solidity
import {CycleState, ProductState, QueueType, ProductParams, DepositRequestState, RedeemRequestState, RequestSettlement} from "../../libs/Types.sol";
```

Add `remainingShares` to `RedeemRequestInternal` (keep every other field and `DepositRequestInternal` as-is):
```solidity
struct RedeemRequestInternal {
    address owner;
    uint256 shares;            // ORIGINAL requested shares — immutable after creation
    uint256 remainingShares;   // shares not yet paid; starts == shares, decremented per partial fill
    uint256 settledAssets;     // CUMULATIVE USDT reserved across however many cycles filled it
    uint256 queuePosition;
    uint256 cycleNumber;       // cycle of the most recent (partial or final) settlement
    RedeemRequestState state;
}
```

In `requestRedeem`, initialize the new field (the struct literal currently omits it — add it):
```solidity
_redeemRequests[requestId] = RedeemRequestInternal({
    owner:           owner,
    shares:          shares,
    remainingShares: shares,
    settledAssets:   0,
    queuePosition:   0,
    cycleNumber:     cn,
    state:           RedeemRequestState.QUEUED
});
```

Replace `settle()` and both `_process*` functions entirely:

```solidity
function settle(
    uint256 cycleNumber,
    RequestSettlement[] calldata deposits,
    RequestSettlement[] calldata redeems,
    uint256 poolDistributedAssets
) external virtual onlySettlementContract returns (uint256[] memory fullyClearedRedeemIds) {
    IStateManager(stateManager).requireActive(address(this));

    CycleSnapshot storage snap = cycleSnapshots[cycleNumber];
    if (!snap.initialized) revert SnapshotNotInitialized(cycleNumber);

    uint256 freeBefore = freeVaultUSDT();

    uint256 acceptedDepositTotal = _processDeposits(deposits, cycleNumber, snap.settlementPrice);
    (uint256 acceptedRedeemTotal, uint256[] memory clearedIds) =
        _processRedeems(redeems, cycleNumber, snap.settlementPrice);
    fullyClearedRedeemIds = clearedIds;

    if (acceptedRedeemTotal > acceptedDepositTotal + freeBefore) {
        revert InsufficientSettlementLiquidity(acceptedRedeemTotal, acceptedDepositTotal + freeBefore);
    }

    ProductParams memory params = IStateManager(stateManager).getParams(address(this));
    if (params.subscriptionCap != 0) {
        uint256 projectedAUM;
        if (acceptedDepositTotal >= acceptedRedeemTotal) {
            projectedAUM = snap.totalAssets + (acceptedDepositTotal - acceptedRedeemTotal);
        } else {
            uint256 netRedeem = acceptedRedeemTotal - acceptedDepositTotal;
            projectedAUM = netRedeem > snap.totalAssets ? 0 : snap.totalAssets - netRedeem;
        }
        if (projectedAUM > params.subscriptionCap) {
            revert SubscriptionCapExceeded(params.subscriptionCap, projectedAUM);
        }
    }

    emit CycleNetFlow(
        cycleNumber, acceptedDepositTotal, acceptedRedeemTotal,
        int256(acceptedDepositTotal) - int256(acceptedRedeemTotal)
    );
    emit SettlementProcessed(deposits.length, redeems.length, poolDistributedAssets, block.timestamp);
}

function _processDeposits(RequestSettlement[] calldata items, uint256 cycleNumber, uint256 settlementPrice)
    internal
    virtual
    returns (uint256 acceptedTotal)
{
    for (uint256 i = 0; i < items.length; i++) {
        uint256 rid = items[i].requestId;
        DepositRequestInternal storage req = _depositRequests[rid];
        if (req.state == DepositRequestState.SETTLED) revert RequestAlreadySettled(rid);
        if (req.state != DepositRequestState.PENDING) revert RequestNotFound(rid);

        uint256 settleAmount = items[i].settleAmount;
        if (settleAmount == 0 || settleAmount > req.assets) revert InvalidSettleAmount(rid);

        uint256 shares = Math.mulDiv(settleAmount, 1e18, settlementPrice);
        req.settledShares = shares;
        req.state = DepositRequestState.SETTLED;
        req.cycleNumber = cycleNumber;

        pendingDepositLiability -= req.assets;
        pendingDepositByOwner[req.owner] -= req.assets;
        acceptedTotal += settleAmount;

        _mintShares(address(this), shares); // held for claimDeposit

        uint256 refund = req.assets - settleAmount;
        if (refund > 0) {
            IERC20(usdt).safeTransfer(req.owner, refund);
        }
        emit DepositSettled(rid, req.assets, settleAmount, refund, cycleNumber, block.timestamp);
    }
}

function _processRedeems(RequestSettlement[] calldata items, uint256 cycleNumber, uint256 settlementPrice)
    internal
    returns (uint256 acceptedTotal, uint256[] memory fullyClearedIds)
{
    uint256[] memory cleared = new uint256[](items.length);
    uint256 clearedCount;

    for (uint256 i = 0; i < items.length; i++) {
        uint256 rid = items[i].requestId;
        RedeemRequestInternal storage req = _redeemRequests[rid];
        if (req.state != RedeemRequestState.QUEUED) revert RequestNotFound(rid);

        uint256 settleAmount = items[i].settleAmount; // shares
        if (settleAmount == 0 || settleAmount > req.remainingShares) revert InvalidSettleAmount(rid);

        uint256 assetsOut = Math.mulDiv(settleAmount, settlementPrice, 1e18);
        req.remainingShares -= settleAmount;
        req.settledAssets += assetsOut;
        req.cycleNumber = cycleNumber;

        reservedRedeemLiability += assetsOut;
        acceptedTotal += assetsOut;

        _burnShares(address(this), settleAmount);

        if (req.remainingShares == 0) {
            req.state = RedeemRequestState.SETTLED;
            cleared[clearedCount++] = rid;
        }
        emit RedeemSettled(rid, req.shares, settleAmount, req.remainingShares, assetsOut, cycleNumber, block.timestamp);
    }

    fullyClearedIds = new uint256[](clearedCount);
    for (uint256 i = 0; i < clearedCount; i++) {
        fullyClearedIds[i] = cleared[i];
    }
}
```

Remove the old `_processDeposits`/`_processRedeems`/`settle` bodies entirely (they're fully replaced above, not overloaded).

- [ ] **Step 4: Widen writeDownInsolvency's redeem eligibility (§A.7)**

In `_writeDownSettledRedeems`, change the eligibility guard from `state == SETTLED` only to also accept a still-`QUEUED` partially-filled redeem (nonzero `settledAssets`):

```solidity
function _writeDownSettledRedeems(uint256[] calldata ids, uint256[] calldata newAssets) internal {
    if (ids.length != newAssets.length) revert LengthMismatch();
    for (uint256 i = 0; i < ids.length; i++) {
        RedeemRequestInternal storage req = _redeemRequests[ids[i]];
        bool eligible = req.state == RedeemRequestState.SETTLED
            || (req.state == RedeemRequestState.QUEUED && req.settledAssets > 0);
        if (!eligible) revert RequestNotFound(ids[i]);
        if (newAssets[i] > req.settledAssets) revert WriteDownIncreasesLiability(ids[i]);
        uint256 haircut = req.settledAssets - newAssets[i];
        req.settledAssets = newAssets[i];
        reservedRedeemLiability -= haircut;
        emit RequestWrittenDown(ids[i], haircut, newAssets[i], block.timestamp);
    }
}
```

- [ ] **Step 5: Compile — expect widespread test-file errors**

Run: `forge build`
Expected: `src/` compiles clean. `test/EarnVault.t.sol`, `test/LiquidityEarnVault.t.sol`, `test/Settlement.t.sol` fail to compile (old `uint256[]` args against the new signature) — that's expected; fixed in the next step and in Tasks 2–3.

- [ ] **Step 6: Update EarnVault.t.sol for the new settle() signature — mechanical, zero behavior change**

In `test/EarnVault.t.sol`:

Add `RequestSettlement` to the Types import:
```solidity
import {ProductState, CycleState, PauseState, ProductParams, ModuleId, Tranche, RequestSettlement} from "../src/libs/Types.sol";
```

Add two bookkeeping mappings to `EarnVaultTest` (next to the other `address internal` fields):
```solidity
mapping(uint256 => uint256) internal _reqAssets; // requestId -> deposit's original assets
mapping(uint256 => uint256) internal _reqShares; // requestId -> redeem's original shares
```

In `_requestDeposit`, record the amount before returning:
```solidity
function _requestDeposit(address user, uint256 amount) internal returns (uint256) {
    vm.startPrank(user);
    usdt.approve(address(vault), amount);
    uint256 rid = vault.requestDeposit(amount, user);
    vm.stopPrank();
    _reqAssets[rid] = amount;
    return rid;
}
```

In `_advanceToCalculating`, capture and record the funder2 deposit's id (currently the return value is discarded):
```solidity
if (sm.totalSubscribed(address(vault)) < p.minRaiseAmount) {
    address funder = makeAddr("funder2");
    usdt.mint(funder, p.minRaiseAmount);
    vm.startPrank(funder);
    usdt.approve(address(vault), p.minRaiseAmount);
    uint256 fRid = vault.requestDeposit(p.minRaiseAmount, funder);
    vm.stopPrank();
    _reqAssets[fRid] = p.minRaiseAmount;
}
```

In `test_claimRedeem_after_settled_transfers_USDT`, record the redeem's shares right after it's created (immediately after the existing `uint256 redeemId = vault.requestRedeem(shares, alice);` line):
```solidity
uint256 redeemId = vault.requestRedeem(shares, alice);
vm.stopPrank();
_reqShares[redeemId] = shares;
```

Add three small conversion helpers next to `_arr` (bottom of the file):
```solidity
function _toDeposits(uint256[] memory ids) internal view returns (RequestSettlement[] memory out) {
    out = new RequestSettlement[](ids.length);
    for (uint256 i = 0; i < ids.length; i++) {
        out[i] = RequestSettlement({requestId: ids[i], settleAmount: _reqAssets[ids[i]]});
    }
}

function _toRedeems(uint256[] memory ids) internal view returns (RequestSettlement[] memory out) {
    out = new RequestSettlement[](ids.length);
    for (uint256 i = 0; i < ids.length; i++) {
        out[i] = RequestSettlement({requestId: ids[i], settleAmount: _reqShares[ids[i]]});
    }
}

function _rs1(uint256 id, uint256 amount) internal pure returns (RequestSettlement[] memory out) {
    out = new RequestSettlement[](1);
    out[0] = RequestSettlement({requestId: id, settleAmount: amount});
}

function _rs0() internal pure returns (RequestSettlement[] memory) {
    return new RequestSettlement[](0);
}
```

Update the `_settle`/`_settleDeposits`/`_settleRedeems` helpers — signatures unchanged (still take `uint256[] memory`), only the internal call to `vault.settle` changes:
```solidity
function _settle(uint256[] memory depIds, uint256[] memory redeemIds, uint256 poolDistributedAssets) internal {
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    vault.settle(cycleNumber, _toDeposits(depIds), _toRedeems(redeemIds), poolDistributedAssets);
    vm.stopPrank();
    _completeCycle();
}
```
(`_settleDeposits`/`_settleRedeems` bodies stay exactly as-is — they just call `_settle`.)

Update the 7 raw `.settle(...)` calls (everything else in the file goes through the helpers above and needs no change):

| Line (pre-edit) | Old | New |
|---|---|---|
| `test_settle_by_non_settlement_reverts` | `vault.settle(1, new uint256[](0), new uint256[](0), 0);` | `vault.settle(1, _rs0(), _rs0(), 0);` |
| `test_settle_revertsIfSnapshotNotInitialized` | `vault.settle(cycleNumber, _arr(rid), new uint256[](0), 0);` | `vault.settle(cycleNumber, _rs1(rid, 1_000e6), _rs0(), 0);` |
| `test_settle_insufficientLiquidity_reverts` | `vault.settle(cycleNumber, new uint256[](0), _arr(redeemId), 0);` | `vault.settle(cycleNumber, _rs0(), _rs1(redeemId, shares), 0);` (`shares` is already a local var in that test) |
| `test_writeDownInsolvency_unblocksSettlement` | `vault.settle(cycleNumber, _arr(funderRid), new uint256[](0), 0);` | `vault.settle(cycleNumber, _rs1(funderRid, 300e6), _rs0(), 0);` (300e6 is the post-write-down amount already asserted two lines above) |
| `test_settle_subscriptionCapExceeded_reverts` | `v.settle(cycle0, _arr(rid0), new uint256[](0), 0);` | `v.settle(cycle0, _rs1(rid0, 100e6), _rs0(), 0);` |
| (same test, 2nd settle) | `v.settle(cycle1, _arr(rid1), new uint256[](0), 0);` | `v.settle(cycle1, _rs1(rid1, 500e6), _rs0(), 0);` |
| `test_settle_reverts_when_vault_paused` | `vault.settle(cycleNumber, _arr(rid), new uint256[](0), 0);` | `vault.settle(cycleNumber, _rs1(rid, 1_000e6), _rs0(), 0);` |

- [ ] **Step 7: Run EarnVault.t.sol**

Run: `forge test --match-path test/EarnVault.t.sol -v`
Expected: all existing tests PASS (no behavior change — every settle in this file still fully accepts every id it's given, matching pre-change semantics exactly).

- [ ] **Step 8: Commit**

```bash
git add src/libs/Types.sol src/asset-management/vaults/BaseVault.sol src/interfaces/IBaseVault.sol test/EarnVault.t.sol
git commit -m "feat: support partial per-request settlement in BaseVault.settle()"
```

---

### Task 2: LiquidityEarnVault — signature parity, no behavior change

**Files:**
- Modify: `src/asset-management/vaults/LiquidityEarnVault.sol`
- Modify: `test/LiquidityEarnVault.t.sol`

**Interfaces:**
- Consumes: `RequestSettlement` (Types.sol, Task 1), `IBaseVault.settle` new signature (Task 1).
- Produces: nothing new consumed elsewhere — this is a leaf.

- [ ] **Step 1: Update the settle() override**

In `src/asset-management/vaults/LiquidityEarnVault.sol`, update the import:
```solidity
import {DepositRequestState, QueueType, RequestSettlement} from "../../libs/Types.sol";
```

Replace the `settle` signature and its deposit-processing loop (keep the bridging/distribution logic identical — only the input/iteration shape changes):

```solidity
function settle(
    uint256 cycleNumber,
    RequestSettlement[] calldata deposits,
    RequestSettlement[] calldata redeems,
    uint256 poolDistributedAssets
) external override onlySettlementContract nonReentrant returns (uint256[] memory) {
    IStateManager(stateManager).requireActive(address(this));

    if (redeems.length != 0) revert RedeemNotSupported();
    if (deposits.length > MAX_CYCLE_REQUESTS) {
        revert CycleRequestLimitExceeded(deposits.length, MAX_CYCLE_REQUESTS);
    }

    CycleSnapshot storage snap = cycleSnapshots[cycleNumber];
    if (!snap.initialized) revert SnapshotNotInitialized(cycleNumber);

    uint256 n = deposits.length;
    uint256 cycleTotalAssets;
    for (uint256 i = 0; i < n; i++) {
        DepositRequestInternal storage req = _depositRequests[deposits[i].requestId];
        if (req.state == DepositRequestState.SETTLED) revert RequestAlreadySettled(deposits[i].requestId);
        if (req.state != DepositRequestState.PENDING) revert RequestNotFound(deposits[i].requestId);
        if (deposits[i].settleAmount != req.assets) revert InvalidSettleAmount(deposits[i].requestId);
        cycleTotalAssets += req.assets;
    }

    if (n == 0 || cycleTotalAssets == 0) {
        cycleRecords[cycleNumber] = CycleRecord(0, 0, 0, true);
        emit CycleSettled(cycleNumber, 0, 0, 0, n, block.timestamp);
        return new uint256[](0);
    }

    for (uint256 i = 0; i < n; i++) {
        DepositRequestInternal storage req = _depositRequests[deposits[i].requestId];
        req.state = DepositRequestState.SETTLED;
        req.cycleNumber = cycleNumber;
        pendingDepositLiability -= req.assets;
        pendingDepositByOwner[req.owner] -= req.assets;
    }

    IERC20(usdt).forceApprove(liquidityBridge, cycleTotalAssets);
    uint256 cashBefore = IERC20(cashVault).balanceOf(address(this));
    ILiquidityBridge(liquidityBridge).bridgeDeposit(cycleTotalAssets, address(this), cashVault);
    uint256 cashReceived = IERC20(cashVault).balanceOf(address(this)) - cashBefore;

    uint256 cashDistributed;
    uint256 bonusDistributed;
    for (uint256 i = 0; i < n; i++) {
        DepositRequestInternal storage req = _depositRequests[deposits[i].requestId];
        uint256 cashOut;
        uint256 bonusOut;
        if (i == n - 1) {
            cashOut = cashReceived - cashDistributed;
            bonusOut = poolDistributedAssets - bonusDistributed;
        } else {
            cashOut = Math.mulDiv(cashReceived, req.assets, cycleTotalAssets);
            bonusOut = Math.mulDiv(poolDistributedAssets, req.assets, cycleTotalAssets);
        }
        cashDistributed += cashOut;
        bonusDistributed += bonusOut;

        if (cashOut > 0) IERC20(cashVault).safeTransfer(req.owner, cashOut);
        if (bonusOut > 0) IERC20(usdt).safeTransfer(req.owner, bonusOut);
    }

    cycleRecords[cycleNumber] = CycleRecord(cycleTotalAssets, cashDistributed, bonusDistributed, true);
    emit CycleSettled(cycleNumber, cycleTotalAssets, cashDistributed, bonusDistributed, n, block.timestamp);
    return new uint256[](0);
}
```

Add the new error next to the existing ones:
```solidity
error InvalidSettleAmount(uint256 requestId);
```
(This mirrors `IBaseVault.InvalidSettleAmount` but is declared locally since `LiquidityEarnVault` doesn't import all of `IBaseVault`'s errors directly — check whether `IBaseVault.InvalidSettleAmount` is already in scope via inheritance before adding a duplicate; if `BaseVault` already `is IBaseVault`, reference `IBaseVault.InvalidSettleAmount` instead of redeclaring.)

- [ ] **Step 2: Update test/LiquidityEarnVault.t.sol for the new signature**

Add `RequestSettlement` to the Types import:
```solidity
import {ProductState, CycleState, ProductParams, PauseState, RequestSettlement} from "../src/libs/Types.sol";
```

Add a bookkeeping mapping and record deposits in `_requestDeposit`, mirroring Task 1 Step 6:
```solidity
mapping(uint256 => uint256) internal _reqAssets;

function _requestDeposit(address user, uint256 amount) internal returns (uint256) {
    vm.startPrank(user);
    usdt.approve(address(lpVault), amount);
    uint256 rid = lpVault.requestDeposit(amount, user);
    vm.stopPrank();
    _reqAssets[rid] = amount;
    return rid;
}
```

Change `_arr`/`_arr2`/`_arr3` to build `RequestSettlement[]` via the mapping (same names, new return type — every existing call site that passes their result as the *deposits* argument keeps compiling unchanged):
```solidity
function _arr(uint256 v) internal view returns (RequestSettlement[] memory a) {
    a = new RequestSettlement[](1);
    a[0] = RequestSettlement({requestId: v, settleAmount: _reqAssets[v]});
}

function _arr2(uint256 a, uint256 b) internal view returns (RequestSettlement[] memory arr) {
    arr = new RequestSettlement[](2);
    arr[0] = RequestSettlement({requestId: a, settleAmount: _reqAssets[a]});
    arr[1] = RequestSettlement({requestId: b, settleAmount: _reqAssets[b]});
}

function _arr3(uint256 a, uint256 b, uint256 c) internal view returns (RequestSettlement[] memory arr) {
    arr = new RequestSettlement[](3);
    arr[0] = RequestSettlement({requestId: a, settleAmount: _reqAssets[a]});
    arr[1] = RequestSettlement({requestId: b, settleAmount: _reqAssets[b]});
    arr[2] = RequestSettlement({requestId: c, settleAmount: _reqAssets[c]});
}
```

Replace every bare `new uint256[](0)` used as the *redeems* argument to `.settle(...)` with `new RequestSettlement[](0)` (7 call sites: lines with `test_settle_distributesCashTokenAndBonusProRata_noSharesMinted`, `test_settle_lastRequestAbsorbsRoundingRemainder`, `test_settle_cashTokenRemainderAbsorbedByLastRequest` (x2), `test_evictDepositRequest_curatorSucceeds_unblocksQueue`, `test_evictDepositRequest_revertsIfNotPending`, `test_settle_recordsCycleAndAllowsImmediateReopen`, `test_settle_reverts_when_vault_paused`, `test_settle_emptyBatch_recordsZeroCycleAndDoesNotRevert` (both args) — mechanically: every `new uint256[](0)` still present after the `_arr*` change becomes `new RequestSettlement[](0)`).

In `test_settle_revertsIfRedeemRequestsPassed`, change the hand-built fake redeem array:
```solidity
RequestSettlement[] memory fakeRedeems = new RequestSettlement[](1);
fakeRedeems[0] = RequestSettlement({requestId: 1, settleAmount: 1});
// ...
lpVault.settle(cycleNumber, _arr(rid), fakeRedeems, 0);
```

In `test_settle_revertsAboveMaxCycleRequests`, replace the manually-built `ids` array with a `RequestSettlement[]` built directly in the loop (this test doesn't use `_requestDeposit`, so it isn't covered by the mapping):
```solidity
uint256 max = lpVault.MAX_CYCLE_REQUESTS();
RequestSettlement[] memory items = new RequestSettlement[](max + 1);
for (uint256 i = 0; i < items.length; i++) {
    address u = address(uint160(1000 + i));
    usdt.mint(u, 1e6);
    vm.startPrank(u);
    usdt.approve(address(lpVault), 1e6);
    uint256 rid = lpVault.requestDeposit(1e6, u);
    vm.stopPrank();
    items[i] = RequestSettlement({requestId: rid, settleAmount: 1e6});
}
_advanceToCalculating();
uint256 cycleNumber = sm.currentCycleNumber(address(lpVault));

vm.startPrank(settlement);
lpVault.snapshotSettlementPrice(cycleNumber);
vm.expectRevert(abi.encodeWithSelector(LiquidityEarnVault.CycleRequestLimitExceeded.selector, items.length, max));
lpVault.settle(cycleNumber, items, new RequestSettlement[](0), 0);
vm.stopPrank();
```

- [ ] **Step 3: Write one new test — partial settleAmount reverts (scope-preservation check)**

```solidity
function test_settle_partialSettleAmount_reverts() public {
    uint256 rid = _requestDeposit(alice, 1_000e6);
    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(lpVault));

    RequestSettlement[] memory partial = new RequestSettlement[](1);
    partial[0] = RequestSettlement({requestId: rid, settleAmount: 500e6}); // less than the full 1_000e6

    vm.startPrank(settlement);
    lpVault.snapshotSettlementPrice(cycleNumber);
    vm.expectRevert(abi.encodeWithSelector(LiquidityEarnVault.InvalidSettleAmount.selector, rid));
    lpVault.settle(cycleNumber, partial, new RequestSettlement[](0), 0);
    vm.stopPrank();
}
```

(If Step 1 ended up referencing `IBaseVault.InvalidSettleAmount` instead of a local error, use that selector here instead.)

- [ ] **Step 4: Run tests**

Run: `forge test --match-path test/LiquidityEarnVault.t.sol -v`
Expected: all existing tests PASS, new test PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/asset-management/vaults/LiquidityEarnVault.sol test/LiquidityEarnVault.t.sol
git commit -m "fix: adapt LiquidityEarnVault.settle() to the shared RequestSettlement signature"
```

---

### Task 3: Settlement.sol — submitBatch reordering for conditional redeem dequeue

**Files:**
- Modify: `src/interfaces/ISettlement.sol`
- Modify: `src/asset-management/settlement/Settlement.sol`
- Modify: `test/Settlement.t.sol`

**Interfaces:**
- Consumes: `RequestSettlement` (Types.sol, Task 1), `IBaseVault.settle` returning `fullyClearedRedeemIds` (Task 1).
- Produces: `ISettlement.VaultSettlement{distribution, RequestSettlement[] deposits, RequestSettlement[] redeems}` — new field names/types, consumed by any future off-chain caller (Task 5 updates the TS side).

- [ ] **Step 1: Update ISettlement.sol**

Update the import and `VaultSettlement` struct:
```solidity
import {RequestSettlement} from "../libs/Types.sol";

struct VaultSettlement {
    Distribution distribution;
    RequestSettlement[] deposits;
    RequestSettlement[] redeems;
}
```

- [ ] **Step 2: Update Settlement.submitBatch's execution loop**

In `src/asset-management/settlement/Settlement.sol`, add the import:
```solidity
import {CycleState, ProductState, QueueType, RequestSettlement} from "../../libs/Types.sol";
```

Replace the execute loop body:
```solidity
for (uint256 i = 0; i < instruction.vaultSettlements.length; i++) {
    VaultSettlement calldata vs = instruction.vaultSettlements[i];
    address v = vs.distribution.vault;

    if (vs.deposits.length > 0) {
        queue.dequeue(v, QueueType.DEPOSIT, _depositIds(vs.deposits));
    }
    if (vs.distribution.amount > 0) unifiedPool.distribute(v, vs.distribution.amount);
    IBaseVault(v).snapshotSettlementPrice(instruction.cycleNumber);
    uint256[] memory clearedRedeemIds =
        IBaseVault(v).settle(instruction.cycleNumber, vs.deposits, vs.redeems, vs.distribution.amount);
    if (clearedRedeemIds.length > 0) {
        queue.dequeue(v, QueueType.REDEEM, clearedRedeemIds);
    }
    sm.completeCycle(v);
}
```

Add a small local helper (near the other internal helpers):
```solidity
function _depositIds(RequestSettlement[] calldata items) internal pure returns (uint256[] memory ids) {
    ids = new uint256[](items.length);
    for (uint256 i = 0; i < items.length; i++) {
        ids[i] = items[i].requestId;
    }
}
```

- [ ] **Step 3: Update test/Settlement.t.sol — one-line helper change**

Add `RequestSettlement` to the Types import:
```solidity
import {ProductState, CycleState, PauseState, ProductParams, Tranche, QueueType, RequestSettlement} from "../src/libs/Types.sol";
```

In `_instruction`, change the `VaultSettlement` construction:
```solidity
ISettlement.VaultSettlement[] memory vs = new ISettlement.VaultSettlement[](1);
vs[0] = ISettlement.VaultSettlement({
    distribution: dist,
    deposits: new RequestSettlement[](0),
    redeems: new RequestSettlement[](0)
});
```
(Every one of the file's 36 references goes through this single helper — no other call site needs editing.)

- [ ] **Step 4: Integration test — client's worked example through the real submitBatch path**

Add to `test/Settlement.t.sol` a variant instruction builder that carries real deposit/redeem entries (the existing `_instruction` always passes empty arrays):
```solidity
function _instructionWithRequests(
    ISettlement.Distribution memory dist,
    RequestSettlement[] memory deposits,
    RequestSettlement[] memory redeems
) internal view returns (ISettlement.SettlementInstruction memory instr) {
    ISettlement.VaultSettlement[] memory vs = new ISettlement.VaultSettlement[](1);
    vs[0] = ISettlement.VaultSettlement({distribution: dist, deposits: deposits, redeems: redeems});
    instr = ISettlement.SettlementInstruction({
        vaultSettlements: vs,
        cycleNumber: sm.currentCycleNumber(address(vault)),
        validUntil: block.timestamp + 3600
    });
}

function _rs1(uint256 id, uint256 amount) internal pure returns (RequestSettlement[] memory out) {
    out = new RequestSettlement[](1);
    out[0] = RequestSettlement({requestId: id, settleAmount: amount});
}
```

```solidity
function test_submitBatch_partialDeposit_coversRedeem_dequeuesOnlyRedeem() public {
    // Bob deposits, settles, redeems in full via a first (empty-fee) submitBatch cycle.
    uint256 bobAssets = 350_000e6;
    address bob = makeAddr("bob");
    usdt.mint(bob, bobAssets);
    uint256 bobRid = _requestDeposit(bob, bobAssets);
    _advanceToOperating();
    _advanceToCalculating();

    ISettlement.Distribution memory dist0 = ISettlement.Distribution({vault: address(vault), amount: 0});
    _submit(_instructionWithRequests(dist0, _rs1(bobRid, bobAssets), new RequestSettlement[](0)), operator1Pk);

    vm.prank(bob); vault.claimDeposit(bobRid, bob);
    uint256 bobShares = vault.balanceOf(bob);
    vm.startPrank(bob);
    vault.approve(address(vault), bobShares);
    uint256 redeemId = vault.requestRedeem(bobShares, bob);
    vm.stopPrank();

    // Alice's 400k deposit request is next; only enough to cover bob's redeem is accepted.
    uint256 aliceRequested = 400_000e6;
    usdt.mint(alice, aliceRequested);
    uint256 aliceRid = _requestDeposit(alice, aliceRequested);
    _advanceToCalculating();

    uint256 redeemAssets = bobShares * 1e6 / 1e18; // 1:1 price in this test — matches _assetsFor in EarnVault.t.sol
    ISettlement.Distribution memory dist1 = ISettlement.Distribution({vault: address(vault), amount: 0});
    uint256 aliceBalBefore = usdt.balanceOf(alice);

    _submit(
        _instructionWithRequests(dist1, _rs1(aliceRid, redeemAssets), _rs1(redeemId, bobShares)),
        operator1Pk
    );

    // Alice: partial accept + immediate refund of the untouched portion — never re-queued.
    assertEq(usdt.balanceOf(alice), aliceBalBefore + (aliceRequested - redeemAssets));
    assertFalse(queue.isInQueue(address(vault), QueueType.DEPOSIT, aliceRid));

    // Bob's redeem: fully cleared this cycle, dequeued.
    assertFalse(queue.isInQueue(address(vault), QueueType.REDEEM, redeemId));
    vm.prank(bob);
    uint256 bobAssetsOut = vault.claimRedeem(redeemId, bob);
    assertEq(bobAssetsOut, redeemAssets);
}
```

- [ ] **Step 5: Run tests**

Run: `forge test --match-path test/Settlement.t.sol -v`
Expected: all existing tests PASS unchanged, plus the new integration test.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/ISettlement.sol src/asset-management/settlement/Settlement.sol test/Settlement.t.sol
git commit -m "feat: Settlement.submitBatch only dequeues fully-cleared redeem requests"
```

---

### Task 4: New partial-settlement behavior tests (EarnVault)

**Files:**
- Modify: `test/EarnVault.t.sol` (new tests appended to the "snapshotSettlementPrice / settle" section)

**Interfaces:**
- Consumes: everything from Tasks 1 and 3 (`RequestSettlement`, `DepositSettled`/`RedeemSettled` events, `InvalidSettleAmount`, `fullyClearedRedeemIds` return value).

- [ ] **Step 1: Partial deposit — accept + immediate refund, no re-queue**

```solidity
function test_settle_partialDeposit_refundsRemainderImmediately() public {
    uint256 requested = 400_000e6;
    uint256 accepted = 350_000e6;
    uint256 rid = _requestDeposit(alice, requested);
    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));

    uint256 balBefore = usdt.balanceOf(alice);
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    vm.expectEmit(true, true, false, true, address(vault));
    emit IBaseVault.DepositSettled(rid, requested, accepted, requested - accepted, cycleNumber, block.timestamp);
    vault.settle(cycleNumber, _rs1(rid, accepted), _rs0(), 0);
    vm.stopPrank();

    // Refunded immediately — no claimRefund step, no re-queue.
    assertEq(usdt.balanceOf(alice), balBefore + (requested - accepted));
    assertEq(vault.pendingDepositLiability(), 0);
    assertEq(vault.pendingDepositByOwner(alice), 0);

    vm.prank(alice);
    uint256 shares = vault.claimDeposit(rid, alice);
    assertEq(shares, _sharesFor(accepted));
}
```

- [ ] **Step 2: Partial redeem — stays queued across cycles, FIFO order preserved**

```solidity
function test_settle_partialRedeem_staysQueuedAcrossCycles() public {
    uint256 assets = 3_000e6;
    uint256 rid = _requestDeposit(alice, assets);
    _advanceToCalculating();
    _settleDeposits(_arr(rid));
    vm.prank(alice); vault.claimDeposit(rid, alice);

    uint256 shares = vault.balanceOf(alice);
    vm.startPrank(alice);
    vault.approve(address(vault), shares);
    uint256 redeemId = vault.requestRedeem(shares, alice);
    vm.stopPrank();

    // Cycle 1: pay out 1/3 of the shares only.
    uint256 firstChunk = shares / 3;
    _advanceToCalculating();
    uint256 cycle1 = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycle1);
    vault.settle(cycle1, _rs0(), _rs1(redeemId, firstChunk), 0);
    vm.stopPrank();
    _completeCycle();

    // Still not claimable — the request is not fully cleared.
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IBaseVault.RequestNotSettled.selector, redeemId));
    vault.claimRedeem(redeemId, alice);

    // Cycle 2: pay out the rest.
    uint256 remaining = shares - firstChunk;
    _advanceToCalculating();
    uint256 cycle2 = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycle2);
    vault.settle(cycle2, _rs0(), _rs1(redeemId, remaining), 0);
    vm.stopPrank();
    _completeCycle();

    uint256 balBefore = usdt.balanceOf(alice);
    vm.prank(alice);
    uint256 assetsOut = vault.claimRedeem(redeemId, alice);
    assertEq(assetsOut, _assetsFor(shares)); // cumulative across both cycles
    assertEq(usdt.balanceOf(alice), balBefore + assetsOut);
}
```

- [ ] **Step 3: Client's worked example — deposit head covers redeem demand, excess refunded**

```solidity
function test_settle_clientExample_depositCoversRedeem_excessRefunded() public {
    // Bob acquires shares, then queues a 350k redeem.
    uint256 bobAssets = 350_000e6;
    uint256 bobRid = _requestDeposit(bob, bobAssets);
    _advanceToCalculating();
    _settleDeposits(_arr(bobRid));
    vm.prank(bob); vault.claimDeposit(bobRid, bob);
    uint256 bobShares = vault.balanceOf(bob);
    vm.startPrank(bob);
    vault.approve(address(vault), bobShares);
    uint256 redeemId = vault.requestRedeem(bobShares, bob);
    vm.stopPrank();

    // Alice's 400k deposit request is next in the queue.
    uint256 aliceRequested = 400_000e6;
    usdt.mint(alice, aliceRequested);
    uint256 aliceRid = _requestDeposit(alice, aliceRequested);

    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));
    uint256 redeemAssets = _assetsFor(bobShares); // == 350_000e6 at the stable 1:1 price in this test

    uint256 aliceBalBefore = usdt.balanceOf(alice);
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    // Accept exactly enough of alice's deposit to cover bob's redeem; refund the rest immediately.
    uint256[] memory cleared =
        vault.settle(cycleNumber, _rs1(aliceRid, redeemAssets), _rs1(redeemId, bobShares), 0);
    vm.stopPrank();

    assertEq(cleared.length, 1);
    assertEq(cleared[0], redeemId); // bob's redeem fully cleared this cycle

    // Alice: partial accept + immediate refund of the untouched 50k.
    assertEq(usdt.balanceOf(alice), aliceBalBefore + (aliceRequested - redeemAssets));
    vm.prank(alice);
    uint256 aliceShares = vault.claimDeposit(aliceRid, alice);
    assertEq(aliceShares, _sharesFor(redeemAssets));

    // Bob: fully paid, claimable now.
    vm.prank(bob);
    uint256 bobAssetsOut = vault.claimRedeem(redeemId, bob);
    assertEq(bobAssetsOut, redeemAssets);
}
```

- [ ] **Step 4: InvalidSettleAmount reverts — deposit and redeem, zero and over-limit**

```solidity
function test_settle_deposit_zeroSettleAmount_reverts() public {
    uint256 rid = _requestDeposit(alice, 1_000e6);
    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    vm.expectRevert(abi.encodeWithSelector(IBaseVault.InvalidSettleAmount.selector, rid));
    vault.settle(cycleNumber, _rs1(rid, 0), _rs0(), 0);
    vm.stopPrank();
}

function test_settle_deposit_settleAmountExceedsRequest_reverts() public {
    uint256 rid = _requestDeposit(alice, 1_000e6);
    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    vm.expectRevert(abi.encodeWithSelector(IBaseVault.InvalidSettleAmount.selector, rid));
    vault.settle(cycleNumber, _rs1(rid, 1_000e6 + 1), _rs0(), 0);
    vm.stopPrank();
}

function test_settle_redeem_settleAmountExceedsRemaining_reverts() public {
    uint256 rid = _requestDeposit(alice, 1_000e6);
    _advanceToCalculating();
    _settleDeposits(_arr(rid));
    vm.prank(alice); vault.claimDeposit(rid, alice);

    uint256 shares = vault.balanceOf(alice);
    vm.startPrank(alice);
    vault.approve(address(vault), shares);
    uint256 redeemId = vault.requestRedeem(shares, alice);
    vm.stopPrank();

    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    vm.expectRevert(abi.encodeWithSelector(IBaseVault.InvalidSettleAmount.selector, redeemId));
    vault.settle(cycleNumber, _rs0(), _rs1(redeemId, shares + 1), 0);
    vm.stopPrank();
}
```

- [ ] **Step 5: writeDownInsolvency haircuts a partially-filled, still-QUEUED redeem**

```solidity
function test_writeDownInsolvency_haircutsPartiallyFilledRedeem() public {
    uint256 assets = 1_000e6;
    uint256 rid = _requestDeposit(alice, assets);
    _advanceToCalculating();
    _settleDeposits(_arr(rid));
    vm.prank(alice); vault.claimDeposit(rid, alice);

    uint256 shares = vault.balanceOf(alice);
    vm.startPrank(alice);
    vault.approve(address(vault), shares);
    uint256 redeemId = vault.requestRedeem(shares, alice);
    vm.stopPrank();

    // Partially settle the redeem (half), leaving it QUEUED with settledAssets > 0.
    uint256 half = shares / 2;
    _advanceToCalculating();
    uint256 cycleNumber = sm.currentCycleNumber(address(vault));
    vm.startPrank(settlement);
    vault.snapshotSettlementPrice(cycleNumber);
    vault.settle(cycleNumber, _rs0(), _rs1(redeemId, half), 0);
    vm.stopPrank();
    _completeCycle();

    uint256 reservedBefore = vault.reservedRedeemLiability();
    assertGt(reservedBefore, 0);

    // Governance haircuts the partially-filled redeem's already-reserved liability.
    _scheduleAndExecute(governor, abi.encodeCall(
        IBaseVault.writeDownInsolvency,
        (
            new uint256[](0), new uint256[](0),
            _arr(redeemId), _arr(reservedBefore / 2),
            new uint256[](0), new uint256[](0)
        )
    ));

    assertEq(vault.reservedRedeemLiability(), reservedBefore / 2);
}
```

- [ ] **Step 6: Run tests**

Run: `forge test --match-path test/EarnVault.t.sol -v`
Expected: all PASS, including the 7 new tests above.

- [ ] **Step 7: Commit**

```bash
git add test/EarnVault.t.sol
git commit -m "test: cover partial deposit/redeem settlement, incl. client's worked example"
```

---

### Task 5: Offchain SDK — mechanical type updates for the new instruction shape

**Files:**
- Modify: `offchain/src/types.ts`
- Modify: `offchain/src/settlementOperator.ts`
- Modify: `offchain/src/sdk.ts`

**Interfaces:**
- Consumes: `ISettlement.VaultSettlement{deposits, redeems}` shape from Task 3 (must match field names/order for ABI encoding to line up).
- Produces: `RequestSettlement` TS type, used by any future off-chain matching-algorithm work (explicitly out of scope here — see Step 3 note).

- [ ] **Step 1: Update types.ts**

In `offchain/src/types.ts`, replace the `VaultSettlement` interface and add `RequestSettlement`:
```typescript
export interface RequestSettlement {
  requestId: bigint;
  settleAmount: bigint; // assets for a deposit, shares for a redeem
}

export interface VaultSettlement {
  distribution: Distribution; // distribution.amount == poolDistributedAssets
  deposits: RequestSettlement[];
  redeems: RequestSettlement[];
}
```

- [ ] **Step 2: Update settlementOperator.ts**

`VaultCalcInput` and `assembleInstruction` currently pass through plain id lists; update them to the new shape while preserving today's "always full accept" behavior (the actual partial-fill decision algorithm is out of scope — see Step 3):

```typescript
export interface VaultCalcInput {
  vault: Address;
  amount: bigint;
  deposits: RequestSettlement[];
  redeems: RequestSettlement[];
}
```
```typescript
assembleInstruction(cycleNumber: bigint, vaults: VaultCalcInput[]): SettlementInstruction {
  const vaultSettlements: VaultSettlement[] = vaults.map((v) => ({
    distribution: { vault: v.vault, amount: v.amount },
    deposits: v.deposits,
    redeems: v.redeems,
  }));
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + this.options.validitySeconds);
  return { vaultSettlements, cycleNumber, validUntil };
}
```
Update the import line to include `RequestSettlement`.

- [ ] **Step 3: Update sdk.ts's instructionToTuple**

```typescript
function instructionToTuple(instruction: SettlementInstruction) {
  return {
    vaultSettlements: instruction.vaultSettlements.map((vs) => ({
      distribution: vs.distribution,
      deposits: vs.deposits.map((d) => ({ requestId: d.requestId, settleAmount: d.settleAmount })),
      redeems: vs.redeems.map((r) => ({ requestId: r.requestId, settleAmount: r.settleAmount })),
    })),
    cycleNumber: instruction.cycleNumber,
    validUntil: instruction.validUntil,
  };
}
```

**Note (not a step — scope boundary):** this task only keeps the TS layer compiling and structurally correct against the new on-chain ABI. It does not implement the actual off-chain logic for *deciding* how much of a request to accept (the "拆单受理" matching algorithm from the client's example) — every existing caller of `assembleInstruction` still needs to pass full-amount `RequestSettlement`s to preserve today's all-or-nothing behavior. Building the real partial-fill matching algorithm is a separate follow-up that needs its own design pass (it's a Company-side business-logic decision, not specified by the client's feedback at the level of "which request gets split by how much").

- [ ] **Step 4: Type-check**

Run: `cd offchain && npm run build` (or the repo's equivalent `tsc --noEmit` script — check `offchain/package.json` for the exact script name)
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add offchain/src/types.ts offchain/src/settlementOperator.ts offchain/src/sdk.ts
git commit -m "chore: update offchain SDK types for the RequestSettlement instruction shape"
```

---

### Task 6: Full-suite check for Part A

- [ ] **Step 1: Run the full Foundry suite**

Run: `forge test`
Expected: all tests pass (605+ pre-existing plus the new ones from Task 4).

- [ ] **Step 2: If anything outside the files touched above fails**

Grep for any other `.settle(` or `VaultSettlement`/`depositRequestIds`/`redeemRequestIds` reference this plan didn't anticipate:
Run: `grep -rn "depositRequestIds\|redeemRequestIds" src test script`
Expected: no matches (all renamed to `deposits`/`redeems` in Tasks 1–3). Fix any stragglers found, following the same pattern as Task 3.

---

## Part B — Protocol creation fees

### Task 7: ProtocolFeeConfig — new contract, pure configuration

**Files:**
- Create: `src/interfaces/IProtocolFeeConfig.sol`
- Create: `src/asset-infrastructure/ProtocolFeeConfig.sol`
- Create: `test/ProtocolFeeConfig.t.sol`
- Modify: `src/libs/Types.sol` (add the two new enums)

**Interfaces:**
- Produces: `enum CreationFeeAction { RegisterAsset, DeployVault }`, `enum FeePaymentKind { Native, Governance, Stable }` in `Types.sol` — consumed by Tasks 9 and 10.
- Produces: `IProtocolFeeConfig{feeOf, paymentTokenOf, revenuePool}` — consumed by Tasks 9 and 10.

- [ ] **Step 1: Add the two enums to Types.sol**

Add to `src/libs/Types.sol`, after the `QueueType` enum:
```solidity
/// @notice Protocol creation-fee gate: which action is being paid for.
enum CreationFeeAction { RegisterAsset, DeployVault }

/// @notice Protocol creation-fee gate: which rail the creator pays with. `Native` is the
///         chain's native currency (BNB/ETH); `Governance`/`Stable` are Governor-configured
///         ERC-20 addresses (see ProtocolFeeConfig).
enum FeePaymentKind { Native, Governance, Stable }
```

- [ ] **Step 2: Write IProtocolFeeConfig.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CreationFeeAction, FeePaymentKind} from "../libs/Types.sol";

/// @title IProtocolFeeConfig
/// @notice Pure configuration for protocol-level creation fees (AssetRegistry.registerAsset,
///         VaultFactory.deployVault). Never custodies funds — callers collect and forward fees
///         directly to `revenuePool()` themselves. Governor-configurable per deployment/network;
///         every (action, payment kind) amount may be set to 0.
interface IProtocolFeeConfig {
    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event FeeSet(CreationFeeAction indexed action, FeePaymentKind indexed kind, uint256 amount, uint256 timestamp);
    event PaymentTokenSet(FeePaymentKind indexed kind, address token, uint256 timestamp);
    event RevenuePoolSet(address oldPool, address newPool, uint256 timestamp);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error NotGovernor();
    error NativeKindHasNoToken();

    // -----------------------------------------------------------------------
    // Mutating functions — Governor only
    // -----------------------------------------------------------------------

    function setFee(CreationFeeAction action, FeePaymentKind kind, uint256 amount) external;
    function setPaymentToken(FeePaymentKind kind, address token) external;
    function setRevenuePool(address pool) external;

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    function feeOf(CreationFeeAction action, FeePaymentKind kind) external view returns (uint256);
    function paymentTokenOf(FeePaymentKind kind) external view returns (address);
    function revenuePool() external view returns (address);
}
```

- [ ] **Step 3: Write ProtocolFeeConfig.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IProtocolFeeConfig} from "../interfaces/IProtocolFeeConfig.sol";
import {IHyperAccessControl} from "../interfaces/IHyperAccessControl.sol";
import {CreationFeeAction, FeePaymentKind} from "../libs/Types.sol";

/// @title ProtocolFeeConfig
/// @notice Governor-controlled fee table for AssetRegistry/VaultFactory creation fees. See
///         IProtocolFeeConfig for the custody model (none — pure config).
contract ProtocolFeeConfig is IProtocolFeeConfig {
    IHyperAccessControl public immutable ac;

    mapping(CreationFeeAction => mapping(FeePaymentKind => uint256)) private _fees;
    mapping(FeePaymentKind => address) private _paymentTokens; // Native unused (always address(0))
    address public override revenuePool;

    constructor(address ac_, address revenuePool_) {
        if (ac_ == address(0) || revenuePool_ == address(0)) revert ZeroAddress();
        ac = IHyperAccessControl(ac_);
        revenuePool = revenuePool_;
    }

    function _onlyGovernor() internal view {
        if (!ac.hasRole(ac.GOVERNOR_ROLE(), msg.sender)) revert NotGovernor();
    }

    function setFee(CreationFeeAction action, FeePaymentKind kind, uint256 amount) external override {
        _onlyGovernor();
        _fees[action][kind] = amount;
        emit FeeSet(action, kind, amount, block.timestamp);
    }

    function setPaymentToken(FeePaymentKind kind, address token) external override {
        _onlyGovernor();
        if (kind == FeePaymentKind.Native) revert NativeKindHasNoToken();
        if (token == address(0)) revert ZeroAddress();
        _paymentTokens[kind] = token;
        emit PaymentTokenSet(kind, token, block.timestamp);
    }

    function setRevenuePool(address pool) external override {
        _onlyGovernor();
        if (pool == address(0)) revert ZeroAddress();
        address old = revenuePool;
        revenuePool = pool;
        emit RevenuePoolSet(old, pool, block.timestamp);
    }

    function feeOf(CreationFeeAction action, FeePaymentKind kind) external view override returns (uint256) {
        return _fees[action][kind];
    }

    function paymentTokenOf(FeePaymentKind kind) external view override returns (address) {
        return _paymentTokens[kind];
    }
}
```

- [ ] **Step 4: Write test/ProtocolFeeConfig.t.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {HyperAccessControl} from "../src/governance/HyperAccessControl.sol";
import {ProtocolFeeConfig} from "../src/asset-infrastructure/ProtocolFeeConfig.sol";
import {IProtocolFeeConfig} from "../src/interfaces/IProtocolFeeConfig.sol";
import {CreationFeeAction, FeePaymentKind} from "../src/libs/Types.sol";

contract ProtocolFeeConfigTest is Test {
    HyperAccessControl internal ac;
    ProtocolFeeConfig internal cfg;

    address internal governor = makeAddr("governor");
    address internal attacker = makeAddr("attacker");
    address internal revPool = makeAddr("revPool");
    address internal govToken = makeAddr("govToken");

    function setUp() public {
        ac = new HyperAccessControl(governor);
        cfg = new ProtocolFeeConfig(address(ac), revPool);
    }

    function test_constructor_setsRevenuePool() public view {
        assertEq(cfg.revenuePool(), revPool);
    }

    function test_defaults_zeroFeeAndUnsetTokens() public view {
        assertEq(cfg.feeOf(CreationFeeAction.RegisterAsset, FeePaymentKind.Native), 0);
        assertEq(cfg.feeOf(CreationFeeAction.DeployVault, FeePaymentKind.Stable), 0);
        assertEq(cfg.paymentTokenOf(FeePaymentKind.Governance), address(0));
        assertEq(cfg.paymentTokenOf(FeePaymentKind.Stable), address(0));
    }

    function test_setFee_governorSucceeds() public {
        vm.prank(governor);
        cfg.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Native, 1 ether);
        assertEq(cfg.feeOf(CreationFeeAction.RegisterAsset, FeePaymentKind.Native), 1 ether);
    }

    function test_setFee_nonGovernorReverts() public {
        vm.prank(attacker);
        vm.expectRevert(IProtocolFeeConfig.NotGovernor.selector);
        cfg.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Native, 1 ether);
    }

    function test_setPaymentToken_governorSucceeds() public {
        vm.prank(governor);
        cfg.setPaymentToken(FeePaymentKind.Governance, govToken);
        assertEq(cfg.paymentTokenOf(FeePaymentKind.Governance), govToken);
    }

    function test_setPaymentToken_nativeKindReverts() public {
        vm.prank(governor);
        vm.expectRevert(IProtocolFeeConfig.NativeKindHasNoToken.selector);
        cfg.setPaymentToken(FeePaymentKind.Native, govToken);
    }

    function test_setPaymentToken_zeroAddressReverts() public {
        vm.prank(governor);
        vm.expectRevert(IProtocolFeeConfig.ZeroAddress.selector);
        cfg.setPaymentToken(FeePaymentKind.Stable, address(0));
    }

    function test_setPaymentToken_nonGovernorReverts() public {
        vm.prank(attacker);
        vm.expectRevert(IProtocolFeeConfig.NotGovernor.selector);
        cfg.setPaymentToken(FeePaymentKind.Governance, govToken);
    }

    function test_setRevenuePool_governorSucceeds() public {
        address newPool = makeAddr("newPool");
        vm.prank(governor);
        cfg.setRevenuePool(newPool);
        assertEq(cfg.revenuePool(), newPool);
    }

    function test_setRevenuePool_nonGovernorReverts() public {
        vm.prank(attacker);
        vm.expectRevert(IProtocolFeeConfig.NotGovernor.selector);
        cfg.setRevenuePool(makeAddr("newPool"));
    }
}
```

- [ ] **Step 5: Run tests**

Run: `forge test --match-path test/ProtocolFeeConfig.t.sol -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/libs/Types.sol src/interfaces/IProtocolFeeConfig.sol src/asset-infrastructure/ProtocolFeeConfig.sol test/ProtocolFeeConfig.t.sol
git commit -m "feat: add ProtocolFeeConfig, Governor-controlled creation-fee table"
```

---

### Task 8: RevenuePool — accept native currency

**Files:**
- Modify: `src/interfaces/IRevenuePool.sol`
- Modify: `src/asset-management/settlement/RevenuePool.sol`
- Modify: `test/RevenuePool.t.sol`

**Interfaces:**
- Produces: `RevenuePool.receive()` (payable), `RevenuePool.withdrawNative(address to, uint256 amount)` — consumed by Task 9/10's `_collectCreationFee` (Native-kind forwarding).

- [ ] **Step 1: Update IRevenuePool.sol**

Add one event and one function:
```solidity
event NativeWithdrawn(address indexed to, uint256 amount, uint256 timestamp);
error NativeTransferFailed();
```
```solidity
/// @notice Transfer `amount` of native currency to `to`. Access: GOVERNOR_ROLE.
function withdrawNative(address to, uint256 amount) external;
```

- [ ] **Step 2: Update RevenuePool.sol**

```solidity
receive() external payable {}

/// @inheritdoc IRevenuePool
function withdrawNative(address to, uint256 amount) external override {
    _onlyGovernor();
    if (to == address(0)) revert ZeroAddress();
    (bool ok,) = to.call{value: amount}("");
    if (!ok) revert NativeTransferFailed();
    emit NativeWithdrawn(to, amount, block.timestamp);
}
```

- [ ] **Step 3: Write tests**

Add to `test/RevenuePool.t.sol`:
```solidity
function test_receive_acceptsNativeCurrency() public {
    (bool ok,) = address(revPool).call{value: 1 ether}("");
    assertTrue(ok);
    assertEq(address(revPool).balance, 1 ether);
}

function test_withdrawNative_governorSucceeds() public {
    vm.deal(address(this), 1 ether);
    (bool ok,) = address(revPool).call{value: 1 ether}("");
    assertTrue(ok);

    address recipient = makeAddr("nativeRecipient");
    vm.prank(governor);
    revPool.withdrawNative(recipient, 1 ether);
    assertEq(recipient.balance, 1 ether);
    assertEq(address(revPool).balance, 0);
}

function test_withdrawNative_nonGovernorReverts() public {
    vm.deal(address(this), 1 ether);
    (bool ok,) = address(revPool).call{value: 1 ether}("");
    assertTrue(ok);

    vm.prank(attacker);
    vm.expectRevert(IRevenuePool.NotGovernor.selector);
    revPool.withdrawNative(makeAddr("nativeRecipient"), 1 ether);
}
```
(Check `test/RevenuePool.t.sol`'s existing `setUp()` for the exact names of `revPool`/`governor`/`attacker` — reuse whatever the file already declares rather than introducing new ones; add `import {IRevenuePool} from "../src/interfaces/IRevenuePool.sol";` if not already imported.)

- [ ] **Step 4: Run tests**

Run: `forge test --match-path test/RevenuePool.t.sol -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/IRevenuePool.sol src/asset-management/settlement/RevenuePool.sol test/RevenuePool.t.sol
git commit -m "feat: RevenuePool accepts and sweeps native currency"
```

---

### Task 9: AssetRegistry — fee-gated registerAsset

**Files:**
- Modify: `src/interfaces/IAssetRegistry.sol`
- Modify: `src/asset-infrastructure/AssetRegistry.sol`
- Modify: `test/AssetRegistry.t.sol`
- Modify: `test/RWAToken.t.sol`, `test/PoRRegistry.t.sol`, `test/MintBurnController.t.sol` (mechanical call-site updates only — these files test unrelated behavior and don't need new fee tests)
- Modify: `script/Deploy.s.sol` (deploy `ProtocolFeeConfig` before `AssetRegistry`, wire it in; see Task 11 for the full deploy-script task — this step only touches the two `registerAsset` call sites so `Deploy.s.sol` keeps compiling)

**Interfaces:**
- Consumes: `IProtocolFeeConfig` (Task 7), `IHyperAccessControl` (existing), `CreationFeeAction`/`FeePaymentKind` (Task 7).
- Produces: `AssetRegistry(address feeConfig_)` constructor — consumed by every test file and `Deploy.s.sol` that instantiates `AssetRegistry`.

- [ ] **Step 1: Update IAssetRegistry.sol**

Add the import:
```solidity
import {FeePaymentKind, CreationFeeAction} from "../libs/Types.sol";
```

Change `registerAsset`'s signature:
```solidity
function registerAsset(
    bytes32 metadataHash,
    string calldata name,
    string calldata symbol,
    uint8 decimals,
    FeePaymentKind feeKind
) external payable returns (uint256 assetId, address token);
```

Add event and errors:
```solidity
event AssetCreationFeeCollected(
    CreationFeeAction indexed action, FeePaymentKind indexed kind, uint256 amount, address indexed payer, uint256 timestamp
);

error IncorrectNativeFee(uint256 expected, uint256 provided);
error UnexpectedNativeValue();
error FeeTransferFailed();
error PaymentTokenNotConfigured(FeePaymentKind kind);
```

Add a view for the wired fee config:
```solidity
function feeConfig() external view returns (address);
```

- [ ] **Step 2: Update AssetRegistry.sol**

Add imports:
```solidity
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IProtocolFeeConfig} from "../interfaces/IProtocolFeeConfig.sol";
import {CreationFeeAction, FeePaymentKind} from "../libs/Types.sol";
```
Add `using SafeERC20 for IERC20;` at the top of the contract body.

Add storage and update the constructor:
```solidity
IProtocolFeeConfig public immutable override feeConfig;

constructor(address feeConfig_) {
    if (feeConfig_ == address(0)) revert ZeroAddress();
    feeConfig = IProtocolFeeConfig(feeConfig_);
    nextAssetId = 1;
    mintBurnController = address(new MintBurnController(address(this)));
}
```

Update `registerAsset`:
```solidity
function registerAsset(
    bytes32 metadataHash,
    string calldata name,
    string calldata symbol,
    uint8 decimals,
    FeePaymentKind feeKind
)
    external
    payable
    override
    returns (uint256 assetId, address token)
{
    _collectCreationFee(CreationFeeAction.RegisterAsset, feeKind);

    assetId = nextAssetId;
    nextAssetId = assetId + 1;

    RWAToken rwaToken = new RWAToken(address(this), assetId, name, symbol, decimals, mintBurnController);
    token = address(rwaToken);

    _assets[assetId] = AssetInfo({
        metadataHash: metadataHash,
        token: token,
        active: true,
        registeredAt: block.timestamp,
        owner: msg.sender
    });

    IMintBurnController(mintBurnController).registerToken(assetId, token);

    emit AssetRegistered(assetId, msg.sender, token, metadataHash, block.timestamp);
}

function _collectCreationFee(CreationFeeAction action, FeePaymentKind kind) internal {
    uint256 fee = feeConfig.feeOf(action, kind);
    if (kind == FeePaymentKind.Native) {
        if (msg.value != fee) revert IncorrectNativeFee(fee, msg.value);
        if (fee > 0) {
            (bool ok,) = feeConfig.revenuePool().call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
    } else {
        if (msg.value != 0) revert UnexpectedNativeValue();
        if (fee > 0) {
            address token = feeConfig.paymentTokenOf(kind);
            if (token == address(0)) revert PaymentTokenNotConfigured(kind);
            IERC20(token).safeTransferFrom(msg.sender, feeConfig.revenuePool(), fee);
        }
    }
    emit AssetCreationFeeCollected(action, kind, fee, msg.sender, block.timestamp);
}
```

- [ ] **Step 3: Update every AssetRegistry constructor call site (mechanical)**

Each of `test/AssetRegistry.t.sol:32`, `test/RWAToken.t.sol:26`, `test/PoRRegistry.t.sol:29`, `test/MintBurnController.t.sol:34` deploys via `new AssetRegistry()`. Since these test files aren't exercising the fee path, deploy a `ProtocolFeeConfig` with a throwaway `revenuePool` in each `setUp()` and pass it in — e.g. in `test/AssetRegistry.t.sol`:

```solidity
import {HyperAccessControl} from "../src/governance/HyperAccessControl.sol";
import {ProtocolFeeConfig} from "../src/asset-infrastructure/ProtocolFeeConfig.sol";
// ...
HyperAccessControl internal ac;
ProtocolFeeConfig internal feeConfig;
// ...
function setUp() public {
    ac = new HyperAccessControl(governor);
    feeConfig = new ProtocolFeeConfig(address(ac), makeAddr("revPool"));
    registry = new AssetRegistry(address(feeConfig));
}
```
Apply the same pattern (new `ac`/`feeConfig` locals, updated `setUp`) to `test/RWAToken.t.sol`, `test/PoRRegistry.t.sol`, `test/MintBurnController.t.sol` — check each file's existing `setUp()` first in case it already declares a `HyperAccessControl ac` (reuse it if so, rather than declaring a second one).

- [ ] **Step 4: Update every `registerAsset(...)` call site (mechanical)**

All defaults are zero-fee, so every existing call just needs `FeePaymentKind.Native` appended (msg.value stays 0, matching `fee == 0`):
- `test/AssetRegistry.t.sol`: 12 call sites (lines 38, 61, 68, 74, 80, 86, 90, 96, 98, 121, 368, 397 per the pre-edit line numbers) — append `, FeePaymentKind.Native` as the 5th argument to each.
- `test/RWAToken.t.sol:30`, `test/PoRRegistry.t.sol:33,163`, `test/MintBurnController.t.sol:41,43` — same.
- `script/Deploy.s.sol:142-143` — same (also needs `Deploy.s.sol`'s `AssetRegistry` construction updated per Task 11; if Task 11 hasn't run yet, temporarily construct a local `ProtocolFeeConfig` inline here so the script keeps compiling, then let Task 11 replace it with the real wiring).

Add `import {FeePaymentKind} from "../src/libs/Types.sol";` (or extend an existing Types import) to every test file touched.

- [ ] **Step 5: Write new fee-path tests in test/AssetRegistry.t.sol**

```solidity
function test_registerAsset_zeroFee_native_succeeds() public {
    vm.prank(alice);
    (uint256 id,) = registry.registerAsset(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Native);
    assertEq(id, 1);
}

function test_registerAsset_nativeFee_exactValue_succeeds() public {
    vm.prank(governor);
    feeConfig.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Native, 1 ether);

    vm.deal(alice, 1 ether);
    vm.prank(alice);
    registry.registerAsset{value: 1 ether}(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Native);
    assertEq(feeConfig.revenuePool().balance, 1 ether);
}

function test_registerAsset_nativeFee_wrongValue_reverts() public {
    vm.prank(governor);
    feeConfig.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Native, 1 ether);

    vm.deal(alice, 2 ether);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.IncorrectNativeFee.selector, 1 ether, 0.5 ether));
    registry.registerAsset{value: 0.5 ether}(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Native);
}

function test_registerAsset_stableFee_pullsExactAmount() public {
    MockERC20Fee stable = new MockERC20Fee();
    vm.startPrank(governor);
    feeConfig.setPaymentToken(FeePaymentKind.Stable, address(stable));
    feeConfig.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Stable, 100e6);
    vm.stopPrank();

    stable.mint(alice, 100e6);
    vm.startPrank(alice);
    stable.approve(address(registry), 100e6);
    registry.registerAsset(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Stable);
    vm.stopPrank();

    assertEq(stable.balanceOf(feeConfig.revenuePool()), 100e6);
    assertEq(stable.balanceOf(alice), 0);
}

function test_registerAsset_stableFee_insufficientAllowance_revertsWholeTx() public {
    MockERC20Fee stable = new MockERC20Fee();
    vm.startPrank(governor);
    feeConfig.setPaymentToken(FeePaymentKind.Stable, address(stable));
    feeConfig.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Stable, 100e6);
    vm.stopPrank();

    stable.mint(alice, 100e6); // no approve
    vm.prank(alice);
    vm.expectRevert();
    registry.registerAsset(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Stable);

    assertEq(registry.nextAssetId(), 1); // nothing was created
}

function test_registerAsset_unconfiguredGovernanceToken_reverts() public {
    vm.prank(governor);
    feeConfig.setFee(CreationFeeAction.RegisterAsset, FeePaymentKind.Governance, 1);
    // paymentTokenOf(Governance) still address(0) — never configured.

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IAssetRegistry.PaymentTokenNotConfigured.selector, FeePaymentKind.Governance));
    registry.registerAsset(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Governance);
}

function test_registerAsset_stillPermissionless_withZeroFee() public {
    // No allowlist added by the fee gate — any address can still register at zero fee.
    vm.prank(attacker);
    (uint256 id,) = registry.registerAsset(META_HASH_1, NAME, SYMBOL, DECIMALS, FeePaymentKind.Native);
    assertEq(id, 1);
}
```

Add a minimal mintable ERC-20 test double near the top of the file (mirrors the `MockUSDT` pattern used elsewhere in the repo's tests):
```solidity
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProtocolFeeConfig} from "../src/asset-infrastructure/ProtocolFeeConfig.sol";
import {IProtocolFeeConfig} from "../src/interfaces/IProtocolFeeConfig.sol";
import {CreationFeeAction, FeePaymentKind} from "../src/libs/Types.sol";

contract MockERC20Fee is ERC20 {
    constructor() ERC20("MockFeeToken", "FEE") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
```

- [ ] **Step 6: Run tests**

Run: `forge test --match-path "test/AssetRegistry.t.sol" -v && forge test --match-path "test/RWAToken.t.sol" -v && forge test --match-path "test/PoRRegistry.t.sol" -v && forge test --match-path "test/MintBurnController.t.sol" -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/IAssetRegistry.sol src/asset-infrastructure/AssetRegistry.sol test/AssetRegistry.t.sol test/RWAToken.t.sol test/PoRRegistry.t.sol test/MintBurnController.t.sol
git commit -m "feat: gate AssetRegistry.registerAsset behind a protocol creation fee"
```

---

### Task 10: VaultFactory — fee-gated deployVault

**Files:**
- Modify: `src/interfaces/IVaultFactory.sol`
- Modify: `src/asset-management/vaults/VaultFactory.sol`
- Modify: `test/VaultFactory.t.sol`, `test/DeployW4.t.sol` (mechanical `VaultParams` field addition)

**Interfaces:**
- Consumes: `IProtocolFeeConfig` (Task 7).
- Produces: `VaultParams.feeKind` field — every `VaultParams({...})` literal repo-wide must add it.

- [ ] **Step 1: Update IVaultFactory.sol**

Add the import:
```solidity
import {FeePaymentKind, CreationFeeAction} from "../libs/Types.sol";
```

Add `feeKind` to `VaultParams` (after `cashVault`, before `initialProduct`):
```solidity
struct VaultParams {
    VaultType    vaultType;
    string       name;
    string       symbol;
    address      usdt;
    address      stateManager;
    address      settlement;
    address      queue;
    address      owner;
    address      adapterRegistry;
    address      liquidityBridge;
    address      cashVault;
    FeePaymentKind feeKind;
    ProductState initialProduct;
    CycleState   initialCycle;
}
```

Update `deployVault`:
```solidity
function deployVault(VaultParams calldata params) external payable returns (address vault);
```

Add event and errors:
```solidity
event VaultCreationFeeCollected(
    CreationFeeAction indexed action, FeePaymentKind indexed kind, uint256 amount, address indexed payer, uint256 timestamp
);

error IncorrectNativeFee(uint256 expected, uint256 provided);
error UnexpectedNativeValue();
error FeeTransferFailed();
error PaymentTokenNotConfigured(FeePaymentKind kind);
```

Add a view:
```solidity
function feeConfig() external view returns (address);
```

- [ ] **Step 2: Update VaultFactory.sol**

Add imports and storage:
```solidity
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IProtocolFeeConfig} from "../../interfaces/IProtocolFeeConfig.sol";
import {ProductState, CycleState, CreationFeeAction, FeePaymentKind} from "../../libs/Types.sol";
```
```solidity
using SafeERC20 for IERC20;

IProtocolFeeConfig public immutable override feeConfig;
```

Update the constructor:
```solidity
constructor(address stateManager_, address earnDeployer_, address lpDeployer_, address feeConfig_) {
    if (
        stateManager_ == address(0) || earnDeployer_ == address(0) || lpDeployer_ == address(0)
            || feeConfig_ == address(0)
    ) {
        revert ZeroAddress();
    }
    stateManager = stateManager_;
    earnDeployer = EarnVaultDeployer(earnDeployer_);
    lpDeployer   = LiquidityEarnVaultDeployer(lpDeployer_);
    feeConfig    = IProtocolFeeConfig(feeConfig_);
}
```

Update `deployVault` — fee collection first, everything else unchanged:
```solidity
function deployVault(VaultParams calldata params) external payable override returns (address vault) {
    _collectCreationFee(CreationFeeAction.DeployVault, params.feeKind);

    if (params.adapterRegistry == address(0)) revert ZeroAddress();
    address owner_ = params.owner == address(0) ? msg.sender : params.owner;

    if (params.vaultType == VaultType.EARN) {
        vault = earnDeployer.deploy(
            params.name, params.symbol, params.usdt, params.stateManager, params.queue, owner_, params.liquidityBridge
        );
    } else if (params.vaultType == VaultType.LP) {
        vault = lpDeployer.deploy(
            params.name, params.symbol, params.usdt, params.stateManager, params.queue, owner_,
            params.liquidityBridge, params.cashVault
        );
    } else {
        revert InvalidVaultType(uint8(params.vaultType));
    }

    address timelock = address(new VaultTimelock(vault));
    IBaseVault(vault).bindGovernance(timelock, params.adapterRegistry);

    IStateManager(params.stateManager).registerVault(vault, params.initialProduct, params.initialCycle);

    emit VaultDeployed(params.vaultType, vault, owner_, timelock, params.name, params.symbol, block.timestamp);
}

function _collectCreationFee(CreationFeeAction action, FeePaymentKind kind) internal {
    uint256 fee = feeConfig.feeOf(action, kind);
    if (kind == FeePaymentKind.Native) {
        if (msg.value != fee) revert IncorrectNativeFee(fee, msg.value);
        if (fee > 0) {
            (bool ok,) = feeConfig.revenuePool().call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
    } else {
        if (msg.value != 0) revert UnexpectedNativeValue();
        if (fee > 0) {
            address token = feeConfig.paymentTokenOf(kind);
            if (token == address(0)) revert PaymentTokenNotConfigured(kind);
            IERC20(token).safeTransferFrom(msg.sender, feeConfig.revenuePool(), fee);
        }
    }
    emit VaultCreationFeeCollected(action, kind, fee, msg.sender, block.timestamp);
}
```

- [ ] **Step 3: Update every VaultParams literal and VaultFactory construction (mechanical)**

`test/VaultFactory.t.sol`:
- `_newVaultFactory` gains a `ProtocolFeeConfig` and passes it: deploy `HyperAccessControl ac` (file already has one — reuse it) and `ProtocolFeeConfig feeConfig = new ProtocolFeeConfig(address(ac), makeAddr("revPool"));`, then `return new VaultFactory(sm_, address(earnDeployer), address(lpDeployer), address(feeConfig));`. Store `feeConfig` on a contract field if later tests need to configure fees; otherwise a local is fine since defaults are all zero.
- All 3 `VaultParams({...})` literals (`baseEarnParams`, `baseNoteParams`, `baseLPParams`) add `feeKind: FeePaymentKind.Native,` (any position matching the struct's field order — after `cashVault`, before `initialProduct`).
- Import `FeePaymentKind` from `Types.sol` and `ProtocolFeeConfig` from its source file.

`test/DeployW4.t.sol`: same two changes — find its `VaultFactory` construction site and add `feeKind: FeePaymentKind.Native,` to its 3 `VaultParams({...})` literals.

- [ ] **Step 4: Write new fee-path tests in test/VaultFactory.t.sol**

```solidity
function test_deployVault_zeroFee_native_succeeds() public {
    IVaultFactory.VaultParams memory p = baseEarnParams;
    address vault = factory.deployVault(p);
    assertTrue(vault != address(0));
}

function test_deployVault_nativeFee_exactValue_succeeds() public {
    vm.prank(governor);
    feeConfig.setFee(CreationFeeAction.DeployVault, FeePaymentKind.Native, 1 ether);

    vm.deal(address(this), 1 ether);
    factory.deployVault{value: 1 ether}(baseEarnParams);
    assertEq(feeConfig.revenuePool().balance, 1 ether);
}

function test_deployVault_nativeFee_wrongValue_reverts() public {
    vm.prank(governor);
    feeConfig.setFee(CreationFeeAction.DeployVault, FeePaymentKind.Native, 1 ether);

    vm.deal(address(this), 1 ether);
    vm.expectRevert(abi.encodeWithSelector(IVaultFactory.IncorrectNativeFee.selector, 1 ether, 0));
    factory.deployVault(baseEarnParams);
}

function test_deployVault_stableFee_pullsExactAmountAndDeploys() public {
    MockERC20Fee stable = new MockERC20Fee();
    vm.startPrank(governor);
    feeConfig.setPaymentToken(FeePaymentKind.Stable, address(stable));
    feeConfig.setFee(CreationFeeAction.DeployVault, FeePaymentKind.Stable, 50e6);
    vm.stopPrank();

    stable.mint(address(this), 50e6);
    stable.approve(address(factory), 50e6);

    IVaultFactory.VaultParams memory p = baseEarnParams;
    p.feeKind = FeePaymentKind.Stable;
    address vault = factory.deployVault(p);

    assertTrue(vault != address(0));
    assertEq(stable.balanceOf(feeConfig.revenuePool()), 50e6);
}
```
(Add the `feeConfig` field to `VaultFactoryTest` if Step 3 kept it local to `_newVaultFactory` — promote it to a contract field so these new tests can call `feeConfig.setFee`/`setPaymentToken`. Add a `MockERC20Fee` test double matching Task 9's, plus the `CreationFeeAction`/`FeePaymentKind` import.)

- [ ] **Step 5: Run tests**

Run: `forge test --match-path "test/VaultFactory.t.sol" -v && forge test --match-path "test/DeployW4.t.sol" -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/IVaultFactory.sol src/asset-management/vaults/VaultFactory.sol test/VaultFactory.t.sol test/DeployW4.t.sol
git commit -m "feat: gate VaultFactory.deployVault behind a protocol creation fee"
```

---

### Task 11: Deploy.s.sol wiring + full-suite check + control-panel sync

**Files:**
- Modify: `script/Deploy.s.sol`
- Modify: `control-panel/index.html`

- [ ] **Step 1: Wire ProtocolFeeConfig into Deploy.s.sol**

Deploy `ProtocolFeeConfig` before `AssetRegistry` and `VaultFactory` (it needs `ac` and `revenuePool`, both already constructed earlier in the script per the existing order at lines ~133-147):

```solidity
ProtocolFeeConfig feeConfig = new ProtocolFeeConfig(address(ac), address(revenuePool));
registry = new AssetRegistry(address(feeConfig));
```

Update the two `registerAsset` calls (from Task 9 Step 4) to pass `FeePaymentKind.Native` (zero-fee default, matches every other test/deploy site).

Update `_newVaultFactory`:
```solidity
function _newVaultFactory(address stateManager_) internal returns (VaultFactory) {
    EarnVaultDeployer earnDeployer = new EarnVaultDeployer();
    LiquidityEarnVaultDeployer lpDeployer = new LiquidityEarnVaultDeployer();
    return new VaultFactory(stateManager_, address(earnDeployer), address(lpDeployer), address(feeConfig));
}
```
(If `feeConfig` isn't in scope at the call site, thread it through as a parameter instead of a closure — match whatever scoping pattern the rest of `Deploy.s.sol` already uses for `registry`/`revenuePool`.)

Add `import {ProtocolFeeConfig} from "../src/asset-infrastructure/ProtocolFeeConfig.sol";` and `import {FeePaymentKind} from "../src/libs/Types.sol";`.

Any `IVaultFactory.VaultParams({...})` literals in `Deploy.s.sol` need `feeKind: FeePaymentKind.Native,` added (same mechanical change as Task 10 Step 3).

- [ ] **Step 2: Full suite**

Run: `forge test`
Expected: all tests pass (Part A's + Part B's, plus everything pre-existing).

Run: `forge build`
Expected: `Deploy.s.sol` compiles clean.

- [ ] **Step 3: Sync control-panel/index.html**

Per this branch's existing convention (see the 2026-08-04 spec's control-panel task), add the new/changed entry points to `control-panel/index.html`'s hand-maintained function registry:
- `AssetRegistry.registerAsset` — new `feeKind` param, now `payable`.
- `VaultFactory.deployVault` — new `feeKind` field on `VaultParams`, now `payable`.
- `ProtocolFeeConfig.setFee` / `setPaymentToken` / `setRevenuePool` (Governor-only) — new entries.
- `RevenuePool.withdrawNative` — new entry.
- `BaseVault.settle` — signature changed from flat id arrays to `RequestSettlement[]`; update its registry entry's ABI/param description.

Check the existing entries for `registerAsset`/`deployVault`/`settle`/`RevenuePool.withdrawToken` to match the file's established format exactly (parameter descriptions, role labels).

- [ ] **Step 4: Commit**

```bash
git add script/Deploy.s.sol control-panel/index.html
git commit -m "chore: wire ProtocolFeeConfig into Deploy.s.sol, sync control panel"
```
