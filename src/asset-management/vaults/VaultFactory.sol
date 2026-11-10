// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IVaultFactory} from "../../interfaces/IVaultFactory.sol";
import {IStateManager} from "../../interfaces/IStateManager.sol";
import {IBaseVault} from "../../interfaces/IBaseVault.sol";
import {EarnVaultDeployer} from "./EarnVaultDeployer.sol";
import {LiquidityEarnVaultDeployer} from "./LiquidityEarnVaultDeployer.sol";
import {VaultTimelock} from "../../governance/VaultTimelock.sol";
import {CreationFeeAction, FeePaymentKind} from "../../libs/Types.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IProtocolFeeConfig} from "../../interfaces/IProtocolFeeConfig.sol";

/// @title VaultFactory
/// @notice Deploys and registers HyperTessera vault contracts, plus that Vault's own dedicated
///         VaultTimelock, in a single call. Permissionless — anyone may deploy a Vault; the
///         caller (or `params.owner`, if set) becomes its Owner. Must itself be the official
///         factory wired into StateManager via `StateManager.setVaultFactory`.
///         (development-plan §3.3.1 — VaultFactory; 角色权限与职责修改方案 §5, §12.1 G-56)
contract VaultFactory is IVaultFactory {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    address public stateManager;

    IProtocolFeeConfig internal immutable _feeConfig;

    // Vault construction is isolated in dedicated deployer contracts, deployed independently and
    // wired in here by address (rather than `new`'d inline), for two reasons: (1) keeps
    // VaultFactory's own runtime bytecode under the EIP-170 24,576-byte limit, and (2) `new X()`
    // embeds X's full creation bytecode into the CALLER's init code — since each deployer's own
    // `deploy()` in turn does `new EarnVault(...)`/`new LiquidityEarnVault(...)`, `new`-ing the
    // deployers inline here would transitively embed the full Vault contracts' creation bytecode
    // into VaultFactory's init code too, pushing it over the EIP-3860 49,152-byte max-initcode
    // limit. Deploying the two helpers as their own top-level transactions first avoids that.
    EarnVaultDeployer public immutable earnDeployer;
    LiquidityEarnVaultDeployer public immutable lpDeployer;

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

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
        _feeConfig   = IProtocolFeeConfig(feeConfig_);
    }

    // -----------------------------------------------------------------------
    // Deploy
    // -----------------------------------------------------------------------

    /// @inheritdoc IVaultFactory
    function deployVault(VaultParams calldata params) external payable returns (address vault) {
        _collectCreationFee(CreationFeeAction.DeployVault, params.feeKind);

        address owner_ = params.owner == address(0) ? msg.sender : params.owner;

        if (params.vaultType == VaultType.EARN) {
            vault = earnDeployer.deploy(
                params.name,
                params.symbol,
                params.usdt,
                params.stateManager,
                params.queue,
                owner_,
                params.liquidityBridge   // address(0) for Note tranche
            );
        } else if (params.vaultType == VaultType.LP) {
            vault = lpDeployer.deploy(
                params.name,
                params.symbol,
                params.usdt,
                params.stateManager,
                params.queue,
                owner_,
                params.liquidityBridge,
                params.cashVault
            );
        } else {
            revert InvalidVaultType(uint8(params.vaultType));
        }

        address timelock = address(new VaultTimelock(vault));
        IBaseVault(vault).bindGovernance(timelock);

        // Register in StateManager (VaultFactory must be the wired official factory). The initial
        // three-layer state is fixed inside StateManager — CONFIGURING / ACCEPTING / ACTIVE — and
        // is deliberately not a deploy parameter (审计反馈 2026-08-17 #7).
        IStateManager(params.stateManager).registerVault(vault);

        // Wire settlement if provided (can be address(0) at W3 — set post-W4)
        // Settlement is set via vault.setSettlement() after W4 deployment

        emit VaultDeployed(params.vaultType, vault, owner_, timelock, params.name, params.symbol, block.timestamp);
    }

    function _collectCreationFee(CreationFeeAction action, FeePaymentKind kind) internal {
        uint256 fee = _feeConfig.feeOf(action, kind);
        if (kind == FeePaymentKind.Native) {
            if (msg.value != fee) revert IncorrectNativeFee(fee, msg.value);
            if (fee > 0) {
                (bool ok,) = _feeConfig.revenuePool().call{value: fee}("");
                if (!ok) revert FeeTransferFailed();
            }
        } else {
            if (msg.value != 0) revert UnexpectedNativeValue();
            if (fee > 0) {
                address token = _feeConfig.paymentTokenOf(kind);
                if (token == address(0)) revert PaymentTokenNotConfigured(kind);
                IERC20(token).safeTransferFrom(msg.sender, _feeConfig.revenuePool(), fee);
            }
        }
        emit VaultCreationFeeCollected(action, kind, fee, msg.sender, block.timestamp);
    }

    /// @inheritdoc IVaultFactory
    function feeConfig() external view returns (address) {
        return address(_feeConfig);
    }
}
