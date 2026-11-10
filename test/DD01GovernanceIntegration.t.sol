// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {GovernanceController} from "../src/governance/GovernanceController.sol";
import {HyperAccessControl} from "../src/governance/HyperAccessControl.sol";
import {StateManager} from "../src/asset-management/StateManager.sol";
import {UnifiedPool} from "../src/asset-management/settlement/UnifiedPool.sol";
import {RevenuePool} from "../src/asset-management/settlement/RevenuePool.sol";
import {Settlement} from "../src/asset-management/settlement/Settlement.sol";
import {Queue} from "../src/asset-management/settlement/Queue.sol";
import {EarnVault} from "../src/asset-management/vaults/EarnVault.sol";
import {LiquidityBridge} from "../src/asset-management/vaults/LiquidityBridge.sol";
import {ProtocolFeeConfig} from "../src/asset-infrastructure/ProtocolFeeConfig.sol";
import {NAVOracle} from "../src/asset-infrastructure/NAVOracle.sol";
import {ReservePSM} from "../src/wrapped-assets/ReservePSM.sol";
import {IUnifiedPool} from "../src/interfaces/IUnifiedPool.sol";
import {IBaseVault} from "../src/interfaces/IBaseVault.sol";
import {IStateManager} from "../src/interfaces/IStateManager.sol";
import {IRevenuePool} from "../src/interfaces/IRevenuePool.sol";
import {IProtocolFeeConfig} from "../src/interfaces/IProtocolFeeConfig.sol";
import {ILiquidityBridge} from "../src/interfaces/ILiquidityBridge.sol";
import {INAVOracle} from "../src/interfaces/INAVOracle.sol";
import {IReservePSM} from "../src/interfaces/IReservePSM.sol";
import {CreationFeeAction, FeePaymentKind, ModuleId} from "../src/libs/Types.sol";

contract DD01IntegrationToken is ERC20 {
    constructor() ERC20("Integration settlement token", "ITUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Only a deployment fixture: registration and all authorization logic live in the real
///      StateManager. The tests do not duplicate its registry or Governor checks in a mock.
contract DD01RegistrationFactory {
    StateManager public immutable sm;

    constructor(StateManager sm_) {
        sm = sm_;
    }

    function register(address vault) external {
        sm.registerVault(vault);
    }
}

contract DD01PoolUpgradeV3 is UnifiedPool {
    uint256 public integrationMarker;

    function initializeUpgrade(uint256 marker) external reinitializer(3) {
        _onlyGovernor();
        integrationMarker = marker;
    }
}

contract DD01PoolRevertingUpgrade is UnifiedPool {
    error DD01InitializationRejected();

    function initializeAndReject() external reinitializer(3) {
        _onlyGovernor();
        pending[msg.sender] = 777;
        revert DD01InitializationRejected();
    }
}

contract DD01NotUUPSImplementation {
    function unrelated() external pure returns (uint256) {
        return 42;
    }
}

/// @notice End-to-end DD [01] regression tests using the existing protocol contracts.
/// @dev The fixture grants Governor to the new controller and revokes the known original
///      Governor. It does NOT claim this is production role-history discovery, a DD [02]
///      transfer-cap fix, or a change to DD [03] price publication and freshness semantics.
contract DD01GovernanceIntegrationTest is Test {
    uint256 internal constant DELAY = 7 days;
    uint256 internal constant OLD_DOC_ID = 100;
    uint256 internal constant NEW_DOC_ID = 101;
    bytes32 internal constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    HyperAccessControl internal ac;
    StateManager internal sm;
    UnifiedPool internal pool;
    RevenuePool internal revenue;
    ProtocolFeeConfig internal fees;
    NAVOracle internal oracle;
    ReservePSM internal psm;
    LiquidityBridge internal bridge;
    GovernanceController internal controller;
    TimelockController internal timelock;
    DD01IntegrationToken internal token;
    DD01RegistrationFactory internal factory;
    EarnVault internal vault;
    Settlement internal settlement;

    address internal oldGovernor = makeAddr("DD01 original governor");
    address internal vaultOwner = makeAddr("DD01 independent vault owner");
    address internal operator = makeAddr("DD01 settlement operator");
    address internal proposer = makeAddr("DD01 Cactus proposer");
    address internal executor = makeAddr("DD01 executor");
    address internal recipient = makeAddr("DD01 external recipient");
    address internal payer = makeAddr("DD01 principal payer");
    uint256 internal nonce;

    function setUp() public {
        vm.warp(100 days);
        ac = new HyperAccessControl(oldGovernor);
        token = new DD01IntegrationToken();
        sm = new StateManager(address(ac));
        revenue = new RevenuePool(address(token), address(ac));
        // Start from a different fee recipient so setFeeRevenuePool has an observable effect.
        fees = new ProtocolFeeConfig(address(ac), oldGovernor);
        oracle = new NAVOracle(oldGovernor, 2_000);
        psm = new ReservePSM(address(ac));
        bridge = new LiquidityBridge(address(token), address(sm), address(ac));

        UnifiedPool implementation = new UnifiedPool();
        pool = UnifiedPool(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(UnifiedPool.initialize, (address(token), address(sm), address(ac)))
                )
            )
        );
        Queue queue = new Queue(address(sm));
        settlement = new Settlement(address(sm), address(pool), address(queue));
        vault = new EarnVault(
            "DD01 actual EarnVault", "DD01V", address(token), address(sm), address(queue), vaultOwner, address(bridge)
        );
        factory = new DD01RegistrationFactory(sm);

        vm.startPrank(oldGovernor);
        sm.setVaultFactory(address(factory));
        revenue.addAuthorizedSource(address(pool));
        // Assets created before the handover retain their independent Wrapper Controller.
        psm.deployWrappedToken(
            OLD_DOC_ID, IReservePSM.AssetMode.DOCUMENT_PROOF, address(0), "Old document", "OLD", 6, false
        );
        vm.stopPrank();
        factory.register(address(vault));

        vm.startPrank(vaultOwner);
        vault.setSettlement(address(settlement));
        vault.setUnifiedPool(address(pool));
        settlement.setOperator(address(vault), operator, true);
        pool.addVault(address(vault));
        vm.stopPrank();
        vm.startPrank(oldGovernor);
        pool.setVaultWhitelisted(address(vault), true);
        pool.setSettlementWhitelisted(address(settlement), true);
        vm.stopPrank();

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        timelock = new TimelockController(DELAY, proposers, executors, address(0));
        address[] memory oracles = new address[](1);
        oracles[0] = address(oracle);
        controller = new GovernanceController(
            address(timelock),
            address(ac),
            GovernanceController.Targets({
                stateManager: address(sm),
                unifiedPool: address(pool),
                revenuePool: address(revenue),
                protocolFeeConfig: address(fees),
                reservePSM: address(psm),
                liquidityBridge: address(bridge)
            }),
            oracles
        );

        vm.startPrank(oldGovernor);
        oracle.transferOwnership(address(controller));
        ac.grantRole(ac.GOVERNOR_ROLE(), address(controller));
        ac.revokeRole(ac.GOVERNOR_ROLE(), oldGovernor);
        vm.stopPrank();
    }

    function _schedule(bytes memory payload) internal returns (bytes32 salt, bytes32 id) {
        salt = bytes32(++nonce);
        id = timelock.hashOperation(address(controller), 0, payload, bytes32(0), salt);
        vm.prank(proposer);
        timelock.schedule(address(controller), 0, payload, bytes32(0), salt, DELAY);
    }

    function _execute(bytes memory payload, bytes32 salt) internal {
        vm.prank(executor);
        timelock.execute(address(controller), 0, payload, bytes32(0), salt);
    }

    function _delayed(bytes memory payload) internal {
        (bytes32 salt,) = _schedule(payload);
        vm.warp(block.timestamp + DELAY);
        _execute(payload, salt);
    }

    function _seedPoolClaim(uint256 amount) internal {
        token.mint(payer, amount);
        vm.startPrank(payer);
        token.approve(address(pool), amount);
        pool.repayPrincipal(amount);
        vm.stopPrank();
        vm.prank(operator);
        pool.attributePrincipal(address(vault), amount);
    }

    function _assertNotReady(bytes memory payload, bytes32 salt) internal {
        bytes32 id = timelock.hashOperation(address(controller), 0, payload, bytes32(0), salt);
        bytes32 ready = bytes32(uint256(1) << uint8(TimelockController.OperationState.Ready));
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, ready));
        _execute(payload, salt);
    }

    function test_RealModulesRejectOldGovernorAfterHandover() public {
        bytes32 role = ac.GOVERNOR_ROLE();
        assertTrue(ac.hasRole(role, address(controller)));
        assertFalse(ac.hasRole(role, oldGovernor));
        assertFalse(ac.hasRole(role, address(timelock)));

        vm.startPrank(oldGovernor);
        vm.expectRevert(IUnifiedPool.NotGovernor.selector);
        pool.operatorTransfer(address(vault), recipient, 1, bytes32(0));
        vm.expectRevert(IUnifiedPool.NotGovernor.selector);
        pool.operatorTransferToRevenuePool(address(vault), address(revenue), 1, bytes32(0));
        vm.expectRevert(IRevenuePool.NotGovernor.selector);
        revenue.withdraw(recipient, 1);
        vm.expectRevert(IProtocolFeeConfig.NotGovernor.selector);
        fees.setFee(CreationFeeAction.DeployVault, FeePaymentKind.Stable, 1);
        vm.expectRevert(IStateManager.NotGovernor.selector);
        sm.pauseModule(ModuleId.SETTLEMENT);
        vm.expectRevert(ILiquidityBridge.NotGovernor.selector);
        bridge.setBridgeWhitelisted(address(vault), true);
        vm.expectRevert(IReservePSM.NotGovernor.selector);
        psm.pause();
        vm.expectRevert(INAVOracle.Unauthorized.selector);
        oracle.setSigner(address(token), recipient);
        vm.expectRevert(IBaseVault.Unauthorized.selector);
        vault.setProtocolFeeConfig(address(revenue), 1_000);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, oldGovernor, role)
        );
        ac.grantRole(role, oldGovernor);
        vm.stopPrank();
    }

    function test_RealPoolTransfersRequireFullSevenDaysAndPreserveExistingLedger() public {
        _seedPoolClaim(1_000e6);
        bytes memory thirdParty = abi.encodeCall(
            GovernanceController.operatorTransfer, (address(vault), recipient, 75e6, keccak256("third party"))
        );
        bytes memory income = abi.encodeCall(
            GovernanceController.operatorTransferToRevenuePool, (address(vault), 25e6, keccak256("income"))
        );
        (bytes32 a,) = _schedule(thirdParty);
        (bytes32 b,) = _schedule(income);
        vm.warp(block.timestamp + DELAY - 1);
        _assertNotReady(thirdParty, a);
        _assertNotReady(income, b);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(address(revenue)), 0);
        vm.warp(block.timestamp + 1);
        _execute(thirdParty, a);
        _execute(income, b);
        assertEq(token.balanceOf(recipient), 75e6);
        assertEq(token.balanceOf(address(revenue)), 25e6);
        assertEq(revenue.totalFeesReceived(), 25e6);
        assertEq(token.balanceOf(address(pool)), 900e6);
        // This is a compatibility assertion, NOT a DD [02] accounting/cap remediation.
        assertEq(pool.pending(address(vault)), 1_000e6);
        assertEq(pool.totalPending(), 1_000e6);
        assertEq(vault.grossManagedAssets(), 1_000e6);
    }

    function test_TimelockCannotBypassControllerAndCallPoolDirectly() public {
        _seedPoolClaim(10e6);
        bytes memory payload =
            abi.encodeCall(UnifiedPool.operatorTransfer, (address(vault), recipient, 1e6, bytes32(0)));
        bytes32 salt = keccak256("direct pool bypass");
        bytes32 id = timelock.hashOperation(address(pool), 0, payload, bytes32(0), salt);
        vm.prank(proposer);
        timelock.schedule(address(pool), 0, payload, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(executor);
        vm.expectRevert(IUnifiedPool.NotGovernor.selector);
        timelock.execute(address(pool), 0, payload, bytes32(0), salt);
        assertFalse(timelock.isOperationDone(id));
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_DelayedConfigurationRoutesReachActualFeeBridgeAndStateModules() public {
        _delayed(
            abi.encodeCall(
                GovernanceController.setCreationFee, (CreationFeeAction.DeployVault, FeePaymentKind.Stable, 11e6)
            )
        );
        _delayed(abi.encodeCall(GovernanceController.setFeePaymentToken, (FeePaymentKind.Stable, address(token))));
        _delayed(abi.encodeCall(GovernanceController.setFeeRevenuePool, ()));
        _delayed(abi.encodeCall(GovernanceController.setBridgeWhitelisted, (address(vault), true)));
        _delayed(abi.encodeCall(GovernanceController.setModulePaused, (ModuleId.SETTLEMENT, true)));
        assertEq(fees.feeOf(CreationFeeAction.DeployVault, FeePaymentKind.Stable), 11e6);
        assertEq(fees.paymentTokenOf(FeePaymentKind.Stable), address(token));
        assertEq(fees.revenuePool(), address(revenue));
        assertTrue(bridge.bridgeWhitelisted(address(vault)));
        assertTrue(sm.modulePaused(ModuleId.SETTLEMENT));
        _delayed(abi.encodeCall(GovernanceController.setModulePaused, (ModuleId.SETTLEMENT, false)));
        assertFalse(sm.modulePaused(ModuleId.SETTLEMENT));
    }

    function test_DelayedVaultFeeUsesOriginalTwoArgumentABIAndKeepsLocalOwner() public {
        _delayed(abi.encodeCall(GovernanceController.setVaultProtocolFeeConfig, (address(vault), uint16(2_500))));
        assertEq(vault.revenuePool(), address(revenue));
        assertEq(uint256(vault.protocolFeeShareBps()), 2_500);
        assertEq(vault.owner(), vaultOwner);
    }

    function test_DelayedPoolAdmissionChangesConstrainActualSettlementOperator() public {
        _delayed(abi.encodeCall(GovernanceController.setVaultWhitelisted, (address(vault), false)));
        assertFalse(pool.vaultWhitelisted(address(vault)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IUnifiedPool.VaultNotWhitelisted.selector, address(vault)));
        pool.attributePrincipal(address(vault), 1);

        _delayed(abi.encodeCall(GovernanceController.setVaultWhitelisted, (address(vault), true)));
        _delayed(abi.encodeCall(GovernanceController.setSettlementWhitelisted, (address(settlement), false)));
        assertFalse(pool.settlementWhitelisted(address(settlement)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IUnifiedPool.SettlementNotWhitelisted.selector, address(settlement)));
        pool.attributePrincipal(address(vault), 1);
    }

    function test_ExistingOneShotFactoryRestrictionIsNotRelaxedByController() public {
        DD01RegistrationFactory otherFactory = new DD01RegistrationFactory(sm);
        bytes memory payload = abi.encodeCall(GovernanceController.setVaultFactory, (address(otherFactory)));
        (bytes32 salt, bytes32 id) = _schedule(payload);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(IStateManager.VaultFactoryAlreadySet.selector);
        _execute(payload, salt);
        assertEq(sm.vaultFactory(), address(factory));
        assertFalse(timelock.isOperationDone(id));
    }

    function test_LegacyInvalidPoolAdmissionsCanBeRevokedButNotReadmittedAfterDelay() public {
        // Rebuild the real modules before handover, so historical bad entries are seeded by
        // an actual Governor through the original Pool API, not by bypassing the new controller.
        ac = new HyperAccessControl(oldGovernor);
        sm = new StateManager(address(ac));
        UnifiedPool implementation = new UnifiedPool();
        pool = UnifiedPool(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(UnifiedPool.initialize, (address(token), address(sm), address(ac)))
                )
            )
        );
        address unregisteredVault = address(token); // Contract code exists, but it is not a Vault.
        address legacySettlementEOA = makeAddr("DD01 legacy mistaken Settlement EOA");
        vm.startPrank(oldGovernor);
        pool.setVaultWhitelisted(unregisteredVault, true);
        pool.setSettlementWhitelisted(legacySettlementEOA, true);
        vm.stopPrank();
        assertFalse(sm.registeredVaults(unregisteredVault));
        assertEq(legacySettlementEOA.code.length, 0);

        address[] memory noOracles = new address[](0);
        controller = new GovernanceController(
            address(timelock),
            address(ac),
            GovernanceController.Targets({
                stateManager: address(sm),
                unifiedPool: address(pool),
                revenuePool: address(0),
                protocolFeeConfig: address(0),
                reservePSM: address(0),
                liquidityBridge: address(0)
            }),
            noOracles
        );
        bytes32 role = ac.GOVERNOR_ROLE();
        vm.startPrank(oldGovernor);
        ac.grantRole(role, address(controller));
        ac.revokeRole(role, oldGovernor);
        vm.stopPrank();
        assertFalse(ac.hasRole(role, oldGovernor));

        bytes memory revokeVault = abi.encodeCall(GovernanceController.setVaultWhitelisted, (unregisteredVault, false));
        bytes memory revokeSettlement =
            abi.encodeCall(GovernanceController.setSettlementWhitelisted, (legacySettlementEOA, false));
        (bytes32 vaultSalt,) = _schedule(revokeVault);
        (bytes32 settlementSalt,) = _schedule(revokeSettlement);
        vm.warp(block.timestamp + DELAY - 1);
        _assertNotReady(revokeVault, vaultSalt);
        _assertNotReady(revokeSettlement, settlementSalt);
        assertTrue(pool.vaultWhitelisted(unregisteredVault));
        assertTrue(pool.settlementWhitelisted(legacySettlementEOA));
        vm.warp(block.timestamp + 1);
        _execute(revokeVault, vaultSalt);
        _execute(revokeSettlement, settlementSalt);
        assertFalse(pool.vaultWhitelisted(unregisteredVault));
        assertFalse(pool.settlementWhitelisted(legacySettlementEOA));

        // Relaxing cleanup validation must not relax admission: the same invalid entries still
        // fail after a fully elapsed proposal, and failed proposals must not be marked done.
        bytes memory admitVault = abi.encodeCall(GovernanceController.setVaultWhitelisted, (unregisteredVault, true));
        bytes memory admitSettlement =
            abi.encodeCall(GovernanceController.setSettlementWhitelisted, (legacySettlementEOA, true));
        (bytes32 admitVaultSalt, bytes32 admitVaultId) = _schedule(admitVault);
        (bytes32 admitSettlementSalt, bytes32 admitSettlementId) = _schedule(admitSettlement);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.UnregisteredVault.selector, unregisteredVault));
        _execute(admitVault, admitVaultSalt);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, legacySettlementEOA));
        _execute(admitSettlement, admitSettlementSalt);
        assertFalse(pool.vaultWhitelisted(unregisteredVault));
        assertFalse(pool.settlementWhitelisted(legacySettlementEOA));
        assertFalse(timelock.isOperationDone(admitVaultId));
        assertFalse(timelock.isOperationDone(admitSettlementId));
    }

    function test_LegacyUnregisteredBridgeAdmissionCanBeRevokedButNotReadded() public {
        // Recreate a pre-handover deployment: the original Bridge allowed any nonzero
        // address. Seed its historical entry using a real Governor, then remove that role.
        ac = new HyperAccessControl(oldGovernor);
        sm = new StateManager(address(ac));
        UnifiedPool implementation = new UnifiedPool();
        pool = UnifiedPool(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(UnifiedPool.initialize, (address(token), address(sm), address(ac)))
                )
            )
        );
        bridge = new LiquidityBridge(address(token), address(sm), address(ac));
        address unregisteredVault = address(token);
        vm.prank(oldGovernor);
        bridge.setBridgeWhitelisted(unregisteredVault, true);
        assertFalse(sm.registeredVaults(unregisteredVault));

        address[] memory noOracles = new address[](0);
        controller = new GovernanceController(
            address(timelock),
            address(ac),
            GovernanceController.Targets({
                stateManager: address(sm),
                unifiedPool: address(pool),
                revenuePool: address(0),
                protocolFeeConfig: address(0),
                reservePSM: address(0),
                liquidityBridge: address(bridge)
            }),
            noOracles
        );
        bytes32 role = ac.GOVERNOR_ROLE();
        vm.startPrank(oldGovernor);
        ac.grantRole(role, address(controller));
        ac.revokeRole(role, oldGovernor);
        vm.stopPrank();
        assertFalse(ac.hasRole(role, oldGovernor));

        bytes memory revoke = abi.encodeCall(GovernanceController.setBridgeWhitelisted, (unregisteredVault, false));
        (bytes32 revokeSalt,) = _schedule(revoke);
        // Read the VM clock across warps; viaIR may reuse block.timestamp within a call.
        vm.warp(vm.getBlockTimestamp() + DELAY - 1);
        _assertNotReady(revoke, revokeSalt);
        assertTrue(bridge.bridgeWhitelisted(unregisteredVault));
        vm.warp(vm.getBlockTimestamp() + 1);
        _execute(revoke, revokeSalt);
        assertFalse(bridge.bridgeWhitelisted(unregisteredVault));

        // Legacy cleanup is permitted, but new admission and zero-address removal remain
        // invalid even when their proposals have satisfied the complete seven-day delay.
        bytes memory readmit = abi.encodeCall(GovernanceController.setBridgeWhitelisted, (unregisteredVault, true));
        bytes memory revokeZero = abi.encodeCall(GovernanceController.setBridgeWhitelisted, (address(0), false));
        (bytes32 readmitSalt, bytes32 readmitId) = _schedule(readmit);
        (bytes32 zeroSalt, bytes32 zeroId) = _schedule(revokeZero);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.UnregisteredVault.selector, unregisteredVault));
        _execute(readmit, readmitSalt);
        vm.expectRevert(GovernanceController.InvalidAddress.selector);
        _execute(revokeZero, zeroSalt);
        assertFalse(bridge.bridgeWhitelisted(unregisteredVault));
        assertFalse(bridge.bridgeWhitelisted(address(0)));
        assertFalse(timelock.isOperationDone(readmitId));
        assertFalse(timelock.isOperationDone(zeroId));
    }

    function test_DelayedOracleOwnerManagementReachesOriginalOracle() public {
        assertEq(oracle.owner(), address(controller));
        _delayed(abi.encodeCall(GovernanceController.setOracleSigner, (address(oracle), address(token), recipient)));
        assertEq(oracle.signerOf(address(token)), recipient);
        _delayed(abi.encodeCall(GovernanceController.setOracleNAVDeviationMaxBps, (address(oracle), 1_500)));
        assertEq(oracle.navDeviationMaxBps(), 1_500);
        _delayed(abi.encodeCall(GovernanceController.removeOracleSigner, (address(oracle), address(token))));
        assertEq(oracle.signerOf(address(token)), address(0));
    }

    function test_NewPSMWrappedAssetRemainsManageableByDedicatedRoutes() public {
        _delayed(
            abi.encodeCall(
                GovernanceController.deployWrappedToken,
                (NEW_DOC_ID, IReservePSM.AssetMode.DOCUMENT_PROOF, address(0), "New document", "NEW", uint8(6), false)
            )
        );
        assertEq(psm.controllerOf(NEW_DOC_ID), address(controller));
        assertGt(psm.wrappedTokenOf(NEW_DOC_ID).code.length, 0);
        _delayed(abi.encodeCall(GovernanceController.setWrapperAuthorizedSigner, (NEW_DOC_ID, recipient)));
        _delayed(abi.encodeCall(GovernanceController.setWrappedAssetPaused, (NEW_DOC_ID, true)));
        (,,,, address signer, bool paused) = psm.assetConfig(NEW_DOC_ID);
        assertEq(signer, recipient);
        assertTrue(paused);
        _delayed(abi.encodeCall(GovernanceController.setWrappedAssetPaused, (NEW_DOC_ID, false)));
        (,,,,, paused) = psm.assetConfig(NEW_DOC_ID);
        assertFalse(paused);
    }

    function test_LegacyPSMWrapperControllerDoesNotMoveWithGovernor() public {
        assertEq(psm.controllerOf(OLD_DOC_ID), oldGovernor);
        vm.prank(oldGovernor);
        psm.setAuthorizedSigner(OLD_DOC_ID, recipient);
        (,,,, address signer,) = psm.assetConfig(OLD_DOC_ID);
        assertEq(signer, recipient);
        bytes memory payload = abi.encodeCall(GovernanceController.setWrappedAssetPaused, (OLD_DOC_ID, true));
        (bytes32 salt, bytes32 id) = _schedule(payload);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotWrapperController.selector, OLD_DOC_ID));
        _execute(payload, salt);
        assertFalse(timelock.isOperationDone(id));
        assertEq(psm.controllerOf(OLD_DOC_ID), oldGovernor);
    }

    function test_DelayedRevenueWithdrawalsReachOriginalCustodyContract() public {
        token.mint(address(revenue), 80e6);
        _delayed(abi.encodeCall(GovernanceController.withdrawRevenue, (recipient, 30e6)));
        _delayed(abi.encodeCall(GovernanceController.withdrawRevenueToken, (address(token), recipient, 20e6)));
        vm.deal(address(revenue), 2 ether);
        uint256 beforeNative = recipient.balance;
        _delayed(abi.encodeCall(GovernanceController.withdrawRevenueNative, (recipient, 1 ether)));
        assertEq(token.balanceOf(recipient), 50e6);
        assertEq(token.balanceOf(address(revenue)), 30e6);
        assertEq(recipient.balance, beforeNative + 1 ether);
        assertEq(address(controller).balance, 0);
    }

    function test_OriginalPoolUpgradeRejectsFormerGovernor() public {
        DD01PoolUpgradeV3 next = new DD01PoolUpgradeV3();
        vm.prank(oldGovernor);
        vm.expectRevert(IUnifiedPool.NotGovernor.selector);
        pool.upgradeToAndCall(address(next), "");
    }

    function test_DelayedUUPSUpgradeBindsImplementationHashAndFullInitializationData() public {
        _seedPoolClaim(500e6);
        DD01PoolUpgradeV3 next = new DD01PoolUpgradeV3();
        DD01PoolUpgradeV3 unscheduled = new DD01PoolUpgradeV3();
        bytes memory init = abi.encodeCall(DD01PoolUpgradeV3.initializeUpgrade, (123));
        bytes memory payload =
            abi.encodeCall(GovernanceController.upgradeUnifiedPool, (address(next), address(next).codehash, init));
        (bytes32 salt, bytes32 id) = _schedule(payload);
        vm.warp(block.timestamp + DELAY);
        // Neither another implementation nor altered init arguments has the scheduled hash.
        _assertNotReady(
            abi.encodeCall(
                GovernanceController.upgradeUnifiedPool, (address(unscheduled), address(unscheduled).codehash, init)
            ),
            salt
        );
        _assertNotReady(
            abi.encodeCall(
                GovernanceController.upgradeUnifiedPool,
                (address(next), address(next).codehash, abi.encodeCall(DD01PoolUpgradeV3.initializeUpgrade, (124)))
            ),
            salt
        );
        _execute(payload, salt);
        assertTrue(timelock.isOperationDone(id));
        assertEq(DD01PoolUpgradeV3(address(pool)).integrationMarker(), 123);
        assertEq(pool.pending(address(vault)), 500e6);
        assertEq(address(pool.usdt()), address(token));
        assertEq(address(pool.ac()), address(ac));
        assertEq(address(pool.sm()), address(sm));
        assertEq(vm.load(address(pool), IMPLEMENTATION_SLOT), bytes32(uint256(uint160(address(next)))));
    }

    function test_UUPSCodeChangedAfterSchedulingIsRejectedAtExecution() public {
        DD01PoolUpgradeV3 next = new DD01PoolUpgradeV3();
        bytes32 expected = address(next).codehash;
        bytes memory payload =
            abi.encodeCall(GovernanceController.upgradeUnifiedPool, (address(next), expected, bytes("")));
        (bytes32 salt, bytes32 id) = _schedule(payload);
        bytes32 oldImplementation = vm.load(address(pool), IMPLEMENTATION_SLOT);
        DD01NotUUPSImplementation different = new DD01NotUUPSImplementation();
        vm.etch(address(next), address(different).code);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernanceController.WrongCodeHash.selector, address(next), expected, address(next).codehash
            )
        );
        _execute(payload, salt);
        assertEq(vm.load(address(pool), IMPLEMENTATION_SLOT), oldImplementation);
        assertFalse(timelock.isOperationDone(id));
    }

    function test_NonUUPSUpgradeFailureBubblesAndDoesNotCompleteProposal() public {
        DD01NotUUPSImplementation bad = new DD01NotUUPSImplementation();
        bytes memory payload =
            abi.encodeCall(GovernanceController.upgradeUnifiedPool, (address(bad), address(bad).codehash, bytes("")));
        (bytes32 salt, bytes32 id) = _schedule(payload);
        bytes32 oldImplementation = vm.load(address(pool), IMPLEMENTATION_SLOT);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(bad)));
        _execute(payload, salt);
        assertEq(vm.load(address(pool), IMPLEMENTATION_SLOT), oldImplementation);
        assertFalse(timelock.isOperationDone(id));
    }

    function test_RevertingUpgradeInitializationRollsBackProxyStorageAndProposal() public {
        DD01PoolRevertingUpgrade bad = new DD01PoolRevertingUpgrade();
        bytes memory payload = abi.encodeCall(
            GovernanceController.upgradeUnifiedPool,
            (address(bad), address(bad).codehash, abi.encodeCall(DD01PoolRevertingUpgrade.initializeAndReject, ()))
        );
        (bytes32 salt, bytes32 id) = _schedule(payload);
        bytes32 oldImplementation = vm.load(address(pool), IMPLEMENTATION_SLOT);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(DD01PoolRevertingUpgrade.DD01InitializationRejected.selector);
        _execute(payload, salt);
        assertFalse(timelock.isOperationDone(id));
        assertEq(vm.load(address(pool), IMPLEMENTATION_SLOT), oldImplementation);
        assertEq(pool.pending(address(controller)), 0);
        assertEq(address(pool.ac()), address(ac));
        // Failed initialization must not consume the original proxy's initializer version.
        DD01PoolUpgradeV3 good = new DD01PoolUpgradeV3();
        _delayed(
            abi.encodeCall(
                GovernanceController.upgradeUnifiedPool,
                (address(good), address(good).codehash, abi.encodeCall(DD01PoolUpgradeV3.initializeUpgrade, (999)))
            )
        );
        assertEq(DD01PoolUpgradeV3(address(pool)).integrationMarker(), 999);
    }
}
