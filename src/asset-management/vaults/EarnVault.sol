// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseVault} from "./BaseVault.sol";
import {IEarnVault} from "../../interfaces/IEarnVault.sol";
import {IStateManager} from "../../interfaces/IStateManager.sol";
import {CycleState} from "../../libs/Types.sol";

/// @title EarnVault
/// @notice Unified Cash / Note tranche vault parameterized by cycleDuration.
///         - Cash tranche: cycleDuration = 7 days; exposes sync ERC-4626 deposit for LiquidityBridge.
///         - Note tranche: cycleDuration = 365 days; no sync deposit; liquidityBridge = address(0).
///         (development-plan §3.3.1 — EarnVault)
contract EarnVault is BaseVault, IEarnVault {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    address public liquidityBridge; // set once at deploy; only caller allowed on sync deposit

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
        address liquidityBridge_   // address(0) for Note tranche
    ) BaseVault(name_, symbol_, usdt_, stateManager_, queue_, owner_) {
        liquidityBridge = liquidityBridge_;
    }

    // -----------------------------------------------------------------------
    // Sync ERC-4626 deposit (Cash tranche — LiquidityBridge only)
    // -----------------------------------------------------------------------

    /// @inheritdoc IEarnVault
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (msg.sender != liquidityBridge) revert OnlyLiquidityBridge(msg.sender);
        if (assets == 0) revert ZeroAssets();
        _requireActive();

        // Price the mint BEFORE the incoming USDT lands. Converting afterwards counts `assets`
        // in totalAssets() while totalSupply() is still unchanged, which inflates the price per
        // share for this call only and under-mints the depositor against its own money
        // (1_000 USDT / 1_000e18 shares + a 100 USDT deposit mints 90.909e18 instead of 100e18,
        // handing the difference to existing holders).
        shares = convertToShares(assets);

        IERC20(usdt).safeTransferFrom(msg.sender, address(this), assets);
        _mintShares(receiver, shares);

        // A bridged subscription is a real subscription, so it charges the quota at mint time —
        // the same way a settled deposit request does. Without this the LP tranche's inflow
        // would consume capacity that nothing ever accounted for
        // (净募集额度修改方案 §2 "Liquidity Bridge 入金铸股").
        uint256 used = subscriptionCapUsedShares + shares;
        subscriptionCapUsedShares = used;

        // Fast-fail layer for the subscription cap. settle()'s end-of-batch check is the
        // authoritative one; this only rejects the obvious overshoot earlier and cheaper.
        // It stands down while a cycle calculation is open on THIS vault (CALCULATING — which
        // means a calculation is open here, not that this vault is in any particular batch: the
        // keeper advances each vault independently via StateManager.startCycleCalculation).
        // During that window the bridge inflow lands before the cycle's redeem burns, so a
        // momentary overshoot is expected and rejecting it would be a false positive.
        // Standing down cannot let the cap escape: `s.cycle` is written only by
        // finalizeSubscription, startCycleCalculation and completeCycle — no admin override — and
        // completeCycle is onlyVaultSettlement, so a CALCULATING vault must be settled through
        // Settlement.submitBatch before its cycle can complete, and that settle() runs the
        // authoritative check against a quota figure that already includes this mint.
        // The cost is that such an overshoot is caught late and non-atomically: the offending
        // batch cannot be rolled back, so this vault's cycle wedges in CALCULATING until the cap
        // is raised via the Timelock. A liveness cost, not a soundness hole.
        uint256 capShare = subscriptionCapShare;
        if (
            capShare != 0
            && used > capShare
            && IStateManager(stateManager).getCycleState(address(this)) != CycleState.CALCULATING
        ) {
            revert SupplyCapExceeded(capShare, used);
        }

        emit SyncDeposit(receiver, assets, shares, block.timestamp);
    }

}
