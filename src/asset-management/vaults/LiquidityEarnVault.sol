// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaseVault} from "./BaseVault.sol";
import {ILiquidityBridge} from "../../interfaces/ILiquidityBridge.sol";
import {IStateManager} from "../../interfaces/IStateManager.sol";
import {IQueue} from "../../interfaces/IQueue.sol";
import {DepositRequestState, QueueType, RequestSettlement} from "../../libs/Types.sol";

/// @title LiquidityEarnVault
/// @notice LP tranche vault. Extends BaseVault.
///         On deposit: investor USDT stays in this vault's own balance and is booked as
///         pendingDepositLiability. Nothing is bridged at request time.
///         On settle: bridging and distribution both happen inside the same transaction —
///         _flipDepositsToSettled (shrink liabilities) → _bridgeDeposits (send exactly
///         cycleTotalAssets USDT to CashVault via LiquidityBridge, receive Cash Tokens) →
///         _distribute (transfer the full received Cash Token amount, plus the UnifiedPool
///         USDT bonus, out to the investors). The vault therefore never holds Cash Tokens
///         across a transaction boundary — its Cash Token balance is zero before and after
///         settle (asserted in test/LiquidityEarnVault.t.sol).
///
///         Invariant note: the liability decrement and the bridged-out USDT amount are both
///         exactly cycleTotalAssets, so settle removes equal amounts from gross managed assets
///         and from liabilities. There is no at-rest Cash Token holding for grossManagedAssets()
///         to value, so `gross >= liabilities` is preserved by construction — an omission here
///         is not a valuation bug.
///         (development-plan §3.3.1, §8 — LiquidityEarnVault)
contract LiquidityEarnVault is BaseVault {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    address public liquidityBridge;
    address public cashVault;
    address public adapter; // the single LiquidityAdapter registered into BaseVault.adapters[]

    uint256 public constant MAX_CYCLE_REQUESTS = 200;

    struct CycleRecord {
        uint256 acceptedTotalAssets;
        uint256 cashTokenDistributed;
        uint256 bonusUsdtDistributed;
        bool completed;
    }
    mapping(uint256 => CycleRecord) public cycleRecords;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event CashTokensReceived(address indexed fromBridge, uint256 assets, uint256 cashShares, uint256 timestamp);
    event CycleSettled(
        uint256 indexed cycleNumber,
        uint256 acceptedTotalAssets,
        uint256 cashTokenDistributed,
        uint256 bonusUsdtDistributed,
        uint256 requestCount,
        uint256 timestamp
    );
    event DepositRequestEvicted(uint256 indexed requestId, address indexed owner, uint256 assets, uint256 timestamp);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroCashVault();
    error ZeroLiquidityBridge();
    error AdapterAlreadySet();
    error ActionDisabled();
    error RedeemNotSupported();
    error CycleRequestLimitExceeded(uint256 count, uint256 max);

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(
        string memory name_,
        string memory symbol_,
        address usdt_,
        address stateManager_,
        address queue_,
        address owner_,
        address liquidityBridge_,
        address cashVault_
    ) BaseVault(name_, symbol_, usdt_, stateManager_, queue_, owner_) {
        if (liquidityBridge_ == address(0)) revert ZeroLiquidityBridge();
        if (cashVault_ == address(0)) revert ZeroCashVault();
        liquidityBridge = liquidityBridge_;
        cashVault       = cashVault_;
    }

    // -----------------------------------------------------------------------
    // Adapter wiring — Vault Curator (direct while CONFIGURING, VaultTimelock after — enforced
    // by addAdapter itself), set once. Registers into BaseVault.adapters[] so
    // grossManagedAssets() aggregates it like any other Adapter.
    // -----------------------------------------------------------------------

    /// @dev `setAdapter` enforces a single adapter, but `addAdapter` is inherited and public, so
    ///      it could be called directly to append more — each one's `realAssets()` then feeds
    ///      `grossManagedAssets()`, and the `adapter` field disagrees with the `adapters` array.
    ///      Moving the constraint into `addAdapter` makes it hold at every entry point
    ///      (Audit Feedback V2 #9).
    ///
    ///      The guard reads `adapter`, so it only bites once something has written it — and until
    ///      审计反馈 V3 #4 only `setAdapter` did. `addAdapter` could therefore be called
    ///      repeatedly, appending adapter after adapter to `adapters[]`, right up until the
    ///      project got round to calling `setAdapter`. Writing `adapter` here closes the window:
    ///      the first admission through either entry point arms the guard for both.
    function addAdapter(address adapter_) public override {
        if (adapter != address(0)) revert AdapterAlreadySet();
        super.addAdapter(adapter_);
        adapter = adapter_;
    }

    /// @notice Retained as the named entry point for the deploy scripts and runbooks; identical
    ///         to `addAdapter` since 审计反馈 V3 #4 made that one write `adapter` too.
    function setAdapter(address adapter_) external {
        addAdapter(adapter_);
    }

    // -----------------------------------------------------------------------
    // No-share-mint product — old share-based claim/redeem/settle surface disabled.
    // Task 8 replaces settle() with the real cyclical pro-rata implementation.
    // -----------------------------------------------------------------------

    function claimDeposit(uint256, address) external pure override returns (uint256) {
        revert ActionDisabled();
    }

    function requestRedeem(uint256, address) external pure override returns (uint256) {
        revert ActionDisabled();
    }

    function claimRedeem(uint256, address) external pure override returns (uint256) {
        revert ActionDisabled();
    }

    // -----------------------------------------------------------------------
    // Curator-only eviction — unblocks the FIFO deposit queue if a PENDING request's owner
    // cannot receive tokens (e.g. a blocklisted USDT address), which would otherwise
    // permanently brick settle()'s single-transaction, all-or-nothing distribution for every
    // request queued behind it (Queue.dequeue enforces strict FIFO head order, so a stuck head
    // slot blocks everything after it). Reuses the existing REFUNDABLE/claimRefund path
    // (inherited from BaseVault) so the evicted owner can still recover their principal, and
    // Queue's tombstone mechanism (Queue.remove) so the FIFO head can advance past the evicted
    // slot on the next dequeue without violating strict ordering.
    // -----------------------------------------------------------------------

    function evictDepositRequest(uint256 requestId) external {
        _onlyCurator();
        DepositRequestInternal storage req = _depositRequests[requestId];
        if (req.state != DepositRequestState.PENDING) revert RequestNotFound(requestId);

        uint256 assets = req.assets;
        req.state = DepositRequestState.REFUNDABLE;
        pendingDepositLiability -= assets;
        pendingDepositByOwner[req.owner] -= assets;
        refundableLiability += assets;
        IQueue(queue).remove(address(this), QueueType.DEPOSIT, requestId);

        emit DepositRequestEvicted(requestId, req.owner, assets, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // settle() — single-transaction cyclical pro-rata distribution. No shares are ever
    // minted for this vault; instead, accepted deposits' combined USDT is bridged to
    // cashVault in one call and the resulting Cash Tokens, plus a UnifiedPool-provided
    // USDT bonus, are split pro-rata across the batch's requests. The last request (by
    // array order) absorbs the integer-division remainder for both outputs so the vault
    // is left holding zero dust.
    // -----------------------------------------------------------------------

    function settle(
        uint256 cycleNumber,
        RequestSettlement[] calldata deposits,
        RequestSettlement[] calldata redeems,
        uint256 poolDistributedAssets
    ) external override onlySettlementContract nonReentrant returns (uint256[] memory) {
        _requireActive();

        if (redeems.length != 0) revert RedeemNotSupported();
        if (deposits.length > MAX_CYCLE_REQUESTS) {
            revert CycleRequestLimitExceeded(deposits.length, MAX_CYCLE_REQUESTS);
        }

        if (!cycleSnapshots[cycleNumber].initialized) revert SnapshotNotInitialized(cycleNumber);

        uint256 cycleTotalAssets = _validateDeposits(deposits);

        if (deposits.length == 0 || cycleTotalAssets == 0) {
            cycleRecords[cycleNumber] = CycleRecord(0, 0, 0, true);
            emit CycleSettled(cycleNumber, 0, 0, 0, deposits.length, block.timestamp);
            return new uint256[](0);
        }

        // Effects before external calls: flip every accepted request to SETTLED and shrink
        // liabilities up front (checks-effects-interactions + the nonReentrant guard above cover
        // the "no partial distribution across a revert" requirement).
        _flipDepositsToSettled(deposits, cycleNumber);

        // The bridged Cash Token amount is passed straight through rather than held in a local:
        // settle() is at the stack-depth limit for the non-viaIR pipeline.
        (uint256 cashDistributed, uint256 bonusDistributed) = _distribute(
            deposits, cycleTotalAssets, _bridgeDeposits(cycleTotalAssets), poolDistributedAssets, cycleNumber
        );

        cycleRecords[cycleNumber] = CycleRecord(cycleTotalAssets, cashDistributed, bonusDistributed, true);
        emit CycleSettled(cycleNumber, cycleTotalAssets, cashDistributed, bonusDistributed, deposits.length, block.timestamp);
        return new uint256[](0);
    }

    /// @dev Bridges cycleTotalAssets of USDT out via liquidityBridge and returns the Cash Token
    ///      amount actually received back (measured by balance diff, not an assumed 1:1).
    function _bridgeDeposits(uint256 cycleTotalAssets) internal returns (uint256 cashReceived) {
        IERC20(usdt).forceApprove(liquidityBridge, cycleTotalAssets);
        uint256 cashBefore = IERC20(cashVault).balanceOf(address(this));
        ILiquidityBridge(liquidityBridge).bridgeDeposit(cycleTotalAssets, address(this), cashVault);
        cashReceived = IERC20(cashVault).balanceOf(address(this)) - cashBefore;
    }

    /// @dev Validates every deposit request is PENDING and settled for a non-zero amount no
    ///      greater than its original request (only the final entry may be partially filled),
    ///      and sums the accepted total.
    function _validateDeposits(RequestSettlement[] calldata deposits) internal view returns (uint256 cycleTotalAssets) {
        uint256 n = deposits.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 rid = deposits[i].requestId;
            uint256 settleAmount = deposits[i].settleAmount;
            DepositRequestInternal storage req = _depositRequests[rid];
            if (req.state == DepositRequestState.SETTLED) revert RequestAlreadySettled(rid);
            if (req.state != DepositRequestState.PENDING) revert RequestNotFound(rid);
            if (settleAmount == 0 || settleAmount > req.assets) revert InvalidSettleAmount(rid);
            // FIFO prefix semantics: at most one partial fill per batch, and nothing accepted
            // after it. `deposits` is in queue order — Settlement hands this same array to
            // Queue.dequeue, which reverts unless the ids come off the queue head in order — so
            // "nothing accepted after the partial" reduces to "only the final entry may be
            // partial". A request that is not accepted at all is absent from the array entirely
            // and stays PENDING.
            if (settleAmount < req.assets && i != n - 1) revert PartialFillMustBeLast(rid);
            cycleTotalAssets += settleAmount;
        }
    }

    /// @dev Flips every accepted request to SETTLED and shrinks liabilities.
    function _flipDepositsToSettled(RequestSettlement[] calldata deposits, uint256 cycleNumber) internal {
        uint256 n = deposits.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 rid = deposits[i].requestId;
            DepositRequestInternal storage req = _depositRequests[rid];
            req.state = DepositRequestState.SETTLED;
            req.cycleNumber = cycleNumber;
            pendingDepositLiability -= req.assets;
            pendingDepositByOwner[req.owner] -= req.assets;
        }
    }

    /// @dev Weighting by settleAmount is defensive rather than observable: _validateDeposits only
    ///      lets the final entry be partial, so every earlier entry has settleAmount == req.assets
    ///      and the last one takes the remainder branch. Keep it — the two diverge the moment that
    ///      rule is relaxed, and req.assets weights over-draw when they do.
    /// @dev Splits cashReceived and poolDistributedAssets pro-rata (by settleAmount) across the
    ///      batch's requests; the last request (by array order) absorbs the integer-division
    ///      remainder for both. Any unaccepted remainder of a partially filled request is
    ///      refunded to its owner here — _flipDepositsToSettled has already shrunk the liability
    ///      by the full req.assets, so leaving it behind would become unowned vault USDT.
    function _distribute(
        RequestSettlement[] calldata deposits,
        uint256 cycleTotalAssets,
        uint256 cashReceived,
        uint256 poolDistributedAssets,
        uint256 cycleNumber
    ) internal returns (uint256 cashDistributed, uint256 bonusDistributed) {
        uint256 n = deposits.length;
        for (uint256 i = 0; i < n; i++) {
            DepositRequestInternal storage req = _depositRequests[deposits[i].requestId];
            // Scoped so cashOut/bonusOut leave the stack before the refund below: this loop is
            // at the stack-depth limit for the non-viaIR pipeline.
            {
                uint256 cashOut;
                uint256 bonusOut;
                if (i == n - 1) {
                    // Last request absorbs the integer-division remainder for both outputs.
                    cashOut = cashReceived - cashDistributed;
                    bonusOut = poolDistributedAssets - bonusDistributed;
                } else {
                    cashOut = Math.mulDiv(cashReceived, deposits[i].settleAmount, cycleTotalAssets);
                    bonusOut = Math.mulDiv(poolDistributedAssets, deposits[i].settleAmount, cycleTotalAssets);
                }
                cashDistributed += cashOut;
                bonusDistributed += bonusOut;

                if (cashOut > 0) IERC20(cashVault).safeTransfer(req.owner, cashOut);
                if (bonusOut > 0) IERC20(usdt).safeTransfer(req.owner, bonusOut);
            }

            uint256 refund = req.assets - deposits[i].settleAmount;
            if (refund > 0) IERC20(usdt).safeTransfer(req.owner, refund);
            emit DepositSettled(
                deposits[i].requestId, req.assets, deposits[i].settleAmount, refund, cycleNumber, block.timestamp
            );
        }
    }
}
