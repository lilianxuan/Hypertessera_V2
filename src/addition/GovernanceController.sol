// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "./TimelockController.sol";
import {IHyperAccessControl} from "../interfaces/IHyperAccessControl.sol";
import {IBaseVault} from "../interfaces/IBaseVault.sol";
import {INAVOracle} from "../interfaces/INAVOracle.sol";
import {IStateManager} from "../interfaces/IStateManager.sol";
import {IUnifiedPool} from "../interfaces/IUnifiedPool.sol";
import {IRevenuePool} from "../interfaces/IRevenuePool.sol";
import {IProtocolFeeConfig} from "../interfaces/IProtocolFeeConfig.sol";
import {IReservePSM} from "../interfaces/IReservePSM.sol";
import {ILiquidityBridge} from "../interfaces/ILiquidityBridge.sol";
import {CreationFeeAction, FeePaymentKind, ModuleId} from "../libs/Types.sol";

/// @dev Narrow interfaces avoid modifying any existing protocol interface or implementation.
interface IGovernancePoolUpgrade {
    function upgradeToAndCall(address implementation, bytes calldata initializationData) external payable;
    function reinitializeStateManager(address stateManager) external;
}

/// @title GovernanceController
/// @notice DD [01] 的协议治理入口：由标准 Timelock 调用，本合约承接原 Governor 权限。
/// @dev This is a non-upgradeable, non-custodial forwarding contract, not a new DAO or multisig.
///      Cactus is an ordinary signing wallet at this layer. Human approval remains in Cactus;
///      the blockchain enforces the configured timelock and this contract's explicit routes.
///
///      SECURITY BOUNDARY:
///      - Only the immutable Timelock may invoke state-changing functions.
///      - Protocol targets are immutable; there is no arbitrary call/delegatecall endpoint.
///      - There is no custom emergency pause, resume, voting, or signature-approval mechanism.
///      - Governor exclusivity is a deployment invariant: remove ALL other Governor holders.
///        HyperAccessControl is not enumerable, so this must be checked from full role history.
///      - DD [02] transfer caps/recipient restrictions and DD [03] NAV pricing changes are NOT
///        implemented in this DD [01] revision. Do not describe it as resolving those findings.
///      - Vault Owner / Curator / Allocator / Guardian / Operator roles are not migrated here.
contract GovernanceController {
    /// @notice Original protocol instances on one chain; zero disables an unused optional module.
    /// @dev StateManager and UnifiedPool are mandatory. Other modules may be omitted, in which
    ///      case their routes revert instead of silently forwarding to an unspecified address.
    struct Targets {
        address stateManager;
        address unifiedPool;
        address revenuePool;
        address protocolFeeConfig;
        address reservePSM;
        address liquidityBridge;
    }

    error NotTimelock(address caller);
    error NotContract(address target);
    error InvalidTimelock();
    error ModuleNotConfigured();
    error InvalidAddress();
    error InvalidAmount();
    error UnregisteredVault(address vault);
    error OracleNotManaged(address oracle);
    error OracleNotOwned(address oracle);
    error WrongCodeHash(address target, bytes32 expected, bytes32 actual);
    error InvalidSuccessor();
    error NotWrapperController(uint256 assetId);

    event ControllerConfigured(address indexed timelock, address indexed accessControl, address indexed unifiedPool);
    event ManagedOracleSet(address indexed oracle, bool allowed);
    event OracleOwnershipTransferred(address indexed oracle, address indexed newOwner);
    event GovernorMigrated(address indexed successor, bytes32 runtimeCodeHash);

    address public immutable timelock;
    IHyperAccessControl public immutable accessControl;
    IStateManager public immutable stateManager;
    IUnifiedPool public immutable unifiedPool;
    IRevenuePool public immutable revenuePool;
    IProtocolFeeConfig public immutable protocolFeeConfig;
    IReservePSM public immutable reservePSM;
    ILiquidityBridge public immutable liquidityBridge;

    /// @notice An oracle is manageable only when BOTH allowlisted here and actually owned here.
    mapping(address oracle => bool allowed) public managedOracles;

    /// @param timelock_ Standard, separately deployed TimelockController; never an EOA.
    /// @param accessControl_ Original HyperAccessControl; its Governor role is granted separately.
    /// @param targets Original protocol contracts. This constructor transfers no permissions.
    /// @param initialOracles Explicit oracle allowlist; ownership is transferred separately.
    constructor(address timelock_, address accessControl_, Targets memory targets, address[] memory initialOracles) {
        _requireContract(timelock_);
        _requireContract(accessControl_);
        _requireContract(targets.stateManager);
        _requireContract(targets.unifiedPool);
        if (TimelockController(payable(timelock_)).getMinDelay() == 0) revert InvalidTimelock();
        _checkOptional(targets.revenuePool);
        _checkOptional(targets.protocolFeeConfig);
        _checkOptional(targets.reservePSM);
        _checkOptional(targets.liquidityBridge);

        timelock = timelock_;
        accessControl = IHyperAccessControl(accessControl_);
        stateManager = IStateManager(targets.stateManager);
        unifiedPool = IUnifiedPool(targets.unifiedPool);
        revenuePool = IRevenuePool(targets.revenuePool);
        protocolFeeConfig = IProtocolFeeConfig(targets.protocolFeeConfig);
        reservePSM = IReservePSM(targets.reservePSM);
        liquidityBridge = ILiquidityBridge(targets.liquidityBridge);

        for (uint256 i; i < initialOracles.length; ++i) {
            _requireContract(initialOracles[i]);
            managedOracles[initialOracles[i]] = true;
            emit ManagedOracleSet(initialOracles[i], true);
        }
        emit ControllerConfigured(timelock_, accessControl_, targets.unifiedPool);
    }

    /// @dev TimelockController has no signing key. With the approved role configuration, its
    ///      calls originate from scheduled execute/executeBatch operations, not from personnel.
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Original UnifiedPool Governor operations -- DD [01] delay only
    // ---------------------------------------------------------------------

    /// @notice Forward a delayed third-party transfer to the original pool.
    /// @dev DD [02] caps, allowlists and fund-source accounting must be implemented before
    ///      claiming the shared-pool issue is resolved. This function alone adds only delay.
    function operatorTransfer(address vault, address recipient, uint256 amount, bytes32 referenceId)
        external
        onlyTimelock
    {
        _requireRegistered(vault);
        _requireRecipientAndAmount(recipient, amount);
        unifiedPool.operatorTransfer(vault, recipient, amount, referenceId);
    }

    /// @notice Forward a delayed transfer to the configured official protocol revenue pool.
    /// @dev No arbitrary revenue-pool parameter is exposed. Original pool/fee-source checks
    ///      remain in force. Confirmed-income accounting and shared caps are DD [02] scope.
    function operatorTransferToRevenuePool(address vault, uint256 amount, bytes32 referenceId) external onlyTimelock {
        _requireRegistered(vault);
        _requireModule(address(revenuePool));
        if (amount == 0) revert InvalidAmount();
        unifiedPool.operatorTransferToRevenuePool(vault, address(revenuePool), amount, referenceId);
    }

    /// @notice Change original pool admission only after a scheduled governance operation.
    function setVaultWhitelisted(address vault, bool allowed) external onlyTimelock {
        // Admission must be registered; removal must still work for invalid legacy entries.
        if (allowed) _requireRegistered(vault);
        else if (vault == address(0)) revert InvalidAddress();
        unifiedPool.setVaultWhitelisted(vault, allowed);
    }

    /// @notice Admit or remove a Settlement contract in the original pool.
    function setSettlementWhitelisted(address settlement, bool allowed) external onlyTimelock {
        if (allowed) _requireContract(settlement);
        else if (settlement == address(0)) revert InvalidAddress();
        unifiedPool.setSettlementWhitelisted(settlement, allowed);
    }

    /// @notice Upgrade only the fixed pool proxy, binding implementation and initialization
    ///         data into the Timelock proposal. The runtime hash is checked again at execution.
    /// @dev The controller cannot prove that a new implementation is safe. Review its full
    ///      code/storage/initialization and obtain the appropriate audit before scheduling.
    function upgradeUnifiedPool(address implementation, bytes32 expectedCodeHash, bytes calldata initializationData)
        external
        onlyTimelock
    {
        _requireCodeHash(implementation, expectedCodeHash);
        IGovernancePoolUpgrade(address(unifiedPool)).upgradeToAndCall(implementation, initializationData);
    }

    /// @notice Preserve the original one-shot deployment correction, to the fixed StateManager.
    /// @dev The pool's reinitializer(2) still prevents reuse; this is not an arbitrary SM setter.
    function reinitializePoolStateManager() external onlyTimelock {
        IGovernancePoolUpgrade(address(unifiedPool)).reinitializeStateManager(address(stateManager));
    }

    // ---------------------------------------------------------------------
    // Existing protocol configuration -- no new pause/restore system
    // ---------------------------------------------------------------------

    /// @notice Forward the existing one-shot factory initialization. The original contract
    ///         rejects a second assignment; this route does not relax that restriction.
    function setVaultFactory(address factory) external onlyTimelock {
        _requireContract(factory);
        stateManager.setVaultFactory(factory);
    }

    /// @notice Forward the EXISTING module pause/unpause functions through governance delay.
    /// @dev No new emergency state is added. Module pause is NOT a UnifiedPool transfer guard.
    ///      Existing Vault Guardian pause remains independent and is not routed here.
    function setModulePaused(ModuleId moduleId, bool paused) external onlyTimelock {
        if (paused) stateManager.pauseModule(moduleId);
        else stateManager.unpauseModule(moduleId);
    }

    /// @notice Forward the existing bridge admission setting; does not modify the bridge.
    function setBridgeWhitelisted(address vault, bool allowed) external onlyTimelock {
        _requireModule(address(liquidityBridge));
        // Admission must be registered; removal must also clear invalid legacy entries.
        if (allowed) _requireRegistered(vault);
        else if (vault == address(0)) revert InvalidAddress();
        liquidityBridge.setBridgeWhitelisted(vault, allowed);
    }

    /// @notice Update an existing protocol creation-fee amount.
    function setCreationFee(CreationFeeAction action, FeePaymentKind kind, uint256 amount) external onlyTimelock {
        _requireModule(address(protocolFeeConfig));
        protocolFeeConfig.setFee(action, kind, amount);
    }

    /// @notice Update a supported fee-payment token; original fee-config validation still applies.
    function setFeePaymentToken(FeePaymentKind kind, address token) external onlyTimelock {
        _requireModule(address(protocolFeeConfig));
        _requireContract(token);
        protocolFeeConfig.setPaymentToken(kind, token);
    }

    /// @notice Configure fee collection to the fixed, reviewed official RevenuePool only.
    function setFeeRevenuePool() external onlyTimelock {
        _requireModule(address(protocolFeeConfig));
        _requireModule(address(revenuePool));
        protocolFeeConfig.setRevenuePool(address(revenuePool));
    }

    /// @notice Configure a registered Vault's protocol-fee share and fixed revenue recipient.
    /// @dev Does not take Vault ownership or change any Vault-local business roles.
    function setVaultProtocolFeeConfig(address vault, uint16 protocolFeeShareBps) external onlyTimelock {
        _requireModule(address(revenuePool));
        _requireRegistered(vault);
        IBaseVault(vault).setProtocolFeeConfig(address(revenuePool), protocolFeeShareBps);
    }

    // ---------------------------------------------------------------------
    // Existing RevenuePool Governor operations
    // ---------------------------------------------------------------------

    /// @notice Withdraw already-held protocol income from the fixed revenue pool after delay.
    function withdrawRevenue(address recipient, uint256 amount) external onlyTimelock {
        _requireModule(address(revenuePool));
        _requireRecipientAndAmount(recipient, amount);
        revenuePool.withdraw(recipient, amount);
    }

    /// @notice Forward an existing ERC-20 sweep (including protocol fee shares).
    function withdrawRevenueToken(address token, address recipient, uint256 amount) external onlyTimelock {
        _requireModule(address(revenuePool));
        _requireContract(token);
        _requireRecipientAndAmount(recipient, amount);
        revenuePool.withdrawToken(token, recipient, amount);
    }

    /// @notice Forward the existing native-currency withdrawal; the controller holds no funds.
    function withdrawRevenueNative(address recipient, uint256 amount) external onlyTimelock {
        _requireModule(address(revenuePool));
        _requireRecipientAndAmount(recipient, amount);
        revenuePool.withdrawNative(recipient, amount);
    }

    /// @notice Preserve fee-source admission management on the original revenue pool.
    function setRevenueSource(address source, bool allowed) external onlyTimelock {
        _requireModule(address(revenuePool));
        if (source == address(0)) revert InvalidAddress();
        if (allowed) revenuePool.addAuthorizedSource(source);
        else revenuePool.removeAuthorizedSource(source);
    }

    /// @notice Forward the existing strategy-address reservation; it does not invest funds.
    function setRevenueYieldStrategy(address strategy) external onlyTimelock {
        _requireModule(address(revenuePool));
        _checkOptional(strategy);
        revenuePool.setYieldStrategy(strategy);
    }

    // ---------------------------------------------------------------------
    // ReservePSM compatibility: original deployment records msg.sender as controller
    // ---------------------------------------------------------------------

    /// @notice Create a wrapped asset using the existing Governor-only deployment entry.
    /// @dev ReservePSM records THIS contract as controllerOf(assetId), so the following three
    ///      dedicated routes preserve manageability. Existing assets' controllers do not change.
    function deployWrappedToken(
        uint256 assetId,
        IReservePSM.AssetMode mode,
        address underlyingToken,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        bool allowPartialUnwrap
    ) external onlyTimelock {
        _requireModule(address(reservePSM));
        reservePSM.deployWrappedToken(assetId, mode, underlyingToken, name, symbol, decimals, allowPartialUnwrap);
    }

    /// @notice Forward the existing global PSM pause/unpause, with the normal governance delay.
    function setReservePSMPaused(bool paused) external onlyTimelock {
        _requireModule(address(reservePSM));
        if (paused) reservePSM.pause();
        else reservePSM.unpause();
    }

    /// @notice Manage only wrapped assets actually created under this controller.
    function setWrapperAuthorizedSigner(uint256 assetId, address signer) external onlyTimelock {
        _requireWrapperControl(assetId);
        if (signer == address(0)) revert InvalidAddress();
        reservePSM.setAuthorizedSigner(assetId, signer);
    }

    /// @notice Forward an existing per-asset pause; never adds a fast emergency bypass.
    function setWrappedAssetPaused(uint256 assetId, bool paused) external onlyTimelock {
        _requireWrapperControl(assetId);
        if (paused) reservePSM.pauseAsset(assetId);
        else reservePSM.unpauseAsset(assetId);
    }

    // ---------------------------------------------------------------------
    // Optional NAVOracle OWNER management; price publication remains unchanged
    // ---------------------------------------------------------------------

    /// @notice Register/remove an explicit management target after governance delay.
    /// @dev Does not transfer ownership, alter a price, or migrate an Adapter binding.
    function setManagedOracle(address oracle, bool allowed) external onlyTimelock {
        if (allowed) _requireContract(oracle);
        else if (oracle == address(0)) revert InvalidAddress();
        managedOracles[oracle] = allowed;
        emit ManagedOracleSet(oracle, allowed);
    }

    /// @notice Change a signer on an explicitly managed and owned oracle after delay.
    function setOracleSigner(address oracle, address rwaToken, address signer) external onlyTimelock {
        _requireOracle(oracle);
        if (rwaToken == address(0) || signer == address(0)) revert InvalidAddress();
        INAVOracle(oracle).setSigner(rwaToken, signer);
    }

    /// @notice Remove a signer through the same delayed ownership route; no new emergency role.
    function removeOracleSigner(address oracle, address rwaToken) external onlyTimelock {
        _requireOracle(oracle);
        if (rwaToken == address(0)) revert InvalidAddress();
        INAVOracle(oracle).removeSigner(rwaToken);
    }

    /// @notice Forward the original deviation configuration, not a new pricing algorithm.
    function setOracleNAVDeviationMaxBps(address oracle, uint256 newBps) external onlyTimelock {
        _requireOracle(oracle);
        INAVOracle(oracle).setNAVDeviationMaxBps(newBps);
    }

    /// @notice Hand oracle ownership to another reviewed contract after the timelock.
    /// @dev EOAs are deliberately not accepted as the new Owner. A contract address alone is
    ///      not proof of safe governance; the proposed successor still requires review.
    function transferOracleOwnership(address oracle, address newOwner) external onlyTimelock {
        _requireOracle(oracle);
        _requireContract(newOwner);
        if (newOwner == address(this)) revert InvalidSuccessor();
        INAVOracle(oracle).transferOwnership(newOwner);
        emit OracleOwnershipTransferred(oracle, newOwner);
    }

    // ---------------------------------------------------------------------
    // Narrow governance succession, not arbitrary AccessControl administration
    // ---------------------------------------------------------------------

    /// @notice Replace THIS Governor with one reviewed contract in a delayed operation.
    /// @dev There is intentionally no general grantRole/revokeRole forwarding function. Grant
    ///      the successor first, then revoke this contract in the same transaction, preventing
    ///      a permissionless gap. Any other Governor holders still require separate discovery
    ///      and cleanup during initial handover. Optional Oracle ownership is migrated separately.
    function migrateGovernor(address successor, bytes32 expectedCodeHash) external onlyTimelock {
        if (successor == address(this)) revert InvalidSuccessor();
        _requireCodeHash(successor, expectedCodeHash);
        bytes32 role = accessControl.GOVERNOR_ROLE();
        accessControl.grantRole(role, successor);
        accessControl.revokeRole(role, address(this));
        emit GovernorMigrated(successor, expectedCodeHash);
    }

    // ---------------------------------------------------------------------
    // Local validation only -- no mutable target routing or arbitrary external calls
    // ---------------------------------------------------------------------

    function _requireRegistered(address vault) internal view {
        if (!stateManager.registeredVaults(vault)) revert UnregisteredVault(vault);
    }

    function _requireOracle(address oracle) internal view {
        if (!managedOracles[oracle]) revert OracleNotManaged(oracle);
        if (INAVOracle(oracle).owner() != address(this)) revert OracleNotOwned(oracle);
    }

    function _requireWrapperControl(uint256 assetId) internal view {
        _requireModule(address(reservePSM));
        if (reservePSM.controllerOf(assetId) != address(this)) revert NotWrapperController(assetId);
    }

    function _requireCodeHash(address target, bytes32 expected) internal view {
        _requireContract(target);
        bytes32 actual = target.codehash;
        if (actual != expected) revert WrongCodeHash(target, expected, actual);
    }

    function _requireContract(address target) internal view {
        if (target.code.length == 0) revert NotContract(target);
    }

    function _checkOptional(address target) internal view {
        if (target != address(0)) _requireContract(target);
    }

    function _requireModule(address target) internal pure {
        if (target == address(0)) revert ModuleNotConfigured();
    }

    function _requireRecipientAndAmount(address recipient, uint256 amount) internal pure {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
    }
}
