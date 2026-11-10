// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "../src/addition/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {HyperAccessControl} from "../src/governance/HyperAccessControl.sol";
import {GovernanceController} from "../src/addition/GovernanceController.sol";
import {NAVOracle} from "../src/asset-infrastructure/NAVOracle.sol";
import {IReservePSM} from "../src/interfaces/IReservePSM.sol";
import {CreationFeeAction, FeePaymentKind, ModuleId} from "../src/libs/Types.sol";

/// @dev Minimal registry fixture. Pool cash flow is covered by the separate real-pool suite.
contract DD01SecurityStateManagerMock {
    mapping(address => bool) public registeredVaults;

    function registerForTest(address vault) external {
        registeredVaults[vault] = true;
    }
}

/// @dev Admission calls still check the real role registry, so a caller cannot bypass the
///      controller merely by addressing this original-governor-shaped target through Timelock.
contract DD01SecurityPoolMock {
    HyperAccessControl public immutable accessControl;
    mapping(address => bool) public vaultWhitelisted;
    mapping(address => bool) public settlementWhitelisted;
    address public implementation;
    bytes public initializationData;

    constructor(HyperAccessControl accessControl_) {
        accessControl = accessControl_;
    }

    modifier onlyGovernor() {
        require(accessControl.hasRole(accessControl.GOVERNOR_ROLE(), msg.sender), "DD01_NOT_GOVERNOR");
        _;
    }

    function setVaultWhitelisted(address vault, bool allowed) external onlyGovernor {
        vaultWhitelisted[vault] = allowed;
    }

    function setSettlementWhitelisted(address settlement, bool allowed) external onlyGovernor {
        settlementWhitelisted[settlement] = allowed;
    }

    function upgradeToAndCall(address implementation_, bytes calldata data) external onlyGovernor {
        implementation = implementation_;
        initializationData = data;
    }
}

/// @dev Code identity fixture only: possessing the expected hash is not proof of safe policy.
contract DD01SecuritySuccessorMock {}

/// @title DD01GovernanceSecurityTest
/// @notice Exercises the real AccessControl and standard OZ Timelock around the new router.
///         Cactus is one configured on-chain wallet, not an on-chain multisignature algorithm.
///         Seven days is the INITIAL configured delay; standard OZ governance can update it.
///         No custom pause, DAO, DD [02] limits or DD [03] price logic is asserted here.
contract DD01GovernanceSecurityTest is Test {
    uint256 internal constant DELAY = 7 days;
    uint256 internal constant START = 1_800_000_000;

    HyperAccessControl internal ac;
    TimelockController internal tl;
    DD01SecurityStateManagerMock internal sm;
    DD01SecurityPoolMock internal pool;
    GovernanceController internal controller;
    NAVOracle internal oracle;
    DD01SecuritySuccessorMock internal successor;

    address internal cactus = makeAddr("DD01 Cactus protocol wallet");
    address internal guardian = makeAddr("DD01 Cactus cancellation wallet");
    address internal attacker = makeAddr("DD01 outsider");
    address internal vault = makeAddr("DD01 registered fixture vault");
    address internal token = makeAddr("DD01 RWA token");
    address internal signer = makeAddr("DD01 NAV signer");
    uint256 internal saltCounter;

    function setUp() public {
        vm.warp(START);
        ac = new HyperAccessControl(cactus);
        tl = _newTimelock(DELAY);
        sm = new DD01SecurityStateManagerMock();
        sm.registerForTest(vault);
        pool = new DD01SecurityPoolMock(ac);
        oracle = new NAVOracle(cactus, 2_000);
        successor = new DD01SecuritySuccessorMock();

        address[] memory initialOracles = new address[](1);
        initialOracles[0] = address(oracle);
        controller = new GovernanceController(address(tl), address(ac), _targets(), initialOracles);

        // Configure the real role handoff. Existing product-local roles are not changed.
        vm.startPrank(cactus);
        ac.grantRole(ac.GOVERNOR_ROLE(), address(controller));
        ac.revokeRole(ac.GOVERNOR_ROLE(), cactus);
        oracle.transferOwnership(address(controller));
        vm.stopPrank();

        // Keep OZ's proposer cancellation authority. Add the Guardian through a genuine
        // delayed self-admin operation; both the proposing wallet and Guardian may cancel.
        address[] memory targets = new address[](1);
        targets[0] = address(tl);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);
        payloads[0] = abi.encodeCall(tl.grantRole, (tl.CANCELLER_ROLE(), guardian));
        bytes32 salt = keccak256("DD01 initial self administration");
        vm.prank(cactus);
        tl.scheduleBatch(targets, values, payloads, bytes32(0), salt, DELAY);
        vm.warp(START + DELAY);
        vm.prank(cactus);
        tl.executeBatch(targets, values, payloads, bytes32(0), salt);
    }

    function _targets() internal view returns (GovernanceController.Targets memory) {
        return GovernanceController.Targets({
            stateManager: address(sm),
            unifiedPool: address(pool),
            revenuePool: address(0),
            protocolFeeConfig: address(0),
            reservePSM: address(0),
            liquidityBridge: address(0)
        });
    }

    function _newTimelock(uint256 delay) internal returns (TimelockController) {
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        proposers[0] = cactus;
        executors[0] = cactus;
        return new TimelockController(delay, proposers, executors, address(0));
    }

    function _nextSalt() internal returns (bytes32) {
        return bytes32(++saltCounter);
    }

    function _schedule(address target, bytes memory data) internal returns (bytes32 salt, bytes32 id) {
        salt = _nextSalt();
        id = tl.hashOperation(target, 0, data, bytes32(0), salt);
        vm.prank(cactus);
        tl.schedule(target, 0, data, bytes32(0), salt, DELAY);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(cactus);
        tl.execute(target, 0, data, bytes32(0), salt);
    }

    // Foundry warp changes the timestamp within a test transaction. Read it through Vm
    // to avoid via-IR CSE of Solidity block.timestamp across successive cheatcode warps.
    function _delayed(address target, bytes memory data) internal {
        (bytes32 salt,) = _schedule(target, data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(target, data, salt);
    }

    function _expectNotReady(bytes32 id) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                id,
                bytes32(uint256(1) << uint8(TimelockController.OperationState.Ready))
            )
        );
    }

    function _expectUnauthorized(address account, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role));
    }

    function testInitialRoleConfigurationAndGovernorExclusivity() public view {
        assertEq(tl.getMinDelay(), DELAY);
        assertTrue(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(tl)));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), cactus));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), guardian));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(this)));
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), cactus));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), cactus));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), guardian));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), cactus));
        assertFalse(tl.hasRole(tl.PROPOSER_ROLE(), guardian));
        assertFalse(tl.hasRole(tl.EXECUTOR_ROLE(), guardian));
        assertTrue(ac.hasRole(ac.GOVERNOR_ROLE(), address(controller)));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), cactus));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(tl)));
    }

    function testUnscheduledExecutionReverts() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        bytes32 salt = _nextSalt();
        bytes32 id = tl.hashOperation(address(controller), 0, data, bytes32(0), salt);
        _expectNotReady(id);
        _execute(address(controller), data, salt);
        assertFalse(pool.vaultWhitelisted(vault));
    }

    function testSevenDayBoundaryAndExecutedReplay() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        uint256 scheduledAt = vm.getBlockTimestamp();
        (bytes32 salt, bytes32 id) = _schedule(address(controller), data);
        assertEq(tl.getTimestamp(id), scheduledAt + DELAY);
        vm.warp(scheduledAt + DELAY - 1);
        _expectNotReady(id);
        _execute(address(controller), data, salt);
        assertFalse(pool.vaultWhitelisted(vault));
        vm.warp(scheduledAt + DELAY);
        _execute(address(controller), data, salt);
        assertTrue(pool.vaultWhitelisted(vault));
        assertTrue(tl.isOperationDone(id));
        _expectNotReady(id);
        _execute(address(controller), data, salt);
    }

    function testScheduleBelowConfiguredDelayReverts() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, DELAY - 1, DELAY));
        vm.prank(cactus);
        tl.schedule(address(controller), 0, data, bytes32(0), _nextSalt(), DELAY - 1);
    }

    function testUnauthorizedActorsCannotScheduleOrExecute() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        bytes32 salt = _nextSalt();
        _expectUnauthorized(attacker, tl.PROPOSER_ROLE());
        vm.prank(attacker);
        tl.schedule(address(controller), 0, data, bytes32(0), salt, DELAY);
        _expectUnauthorized(guardian, tl.PROPOSER_ROLE());
        vm.prank(guardian);
        tl.schedule(address(controller), 0, data, bytes32(0), salt, DELAY);
        (salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _expectUnauthorized(attacker, tl.EXECUTOR_ROLE());
        vm.prank(attacker);
        tl.execute(address(controller), 0, data, bytes32(0), salt);
        _expectUnauthorized(guardian, tl.EXECUTOR_ROLE());
        vm.prank(guardian);
        tl.execute(address(controller), 0, data, bytes32(0), salt);
        assertFalse(pool.vaultWhitelisted(vault));
    }

    function testGuardianCancelsWaitingAndReadyOperations() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (bytes32 waitingSalt, bytes32 waitingId) = _schedule(address(controller), data);
        vm.prank(guardian);
        tl.cancel(waitingId);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _expectNotReady(waitingId);
        _execute(address(controller), data, waitingSalt);

        (bytes32 readySalt, bytes32 readyId) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        assertTrue(tl.isOperationReady(readyId));
        vm.prank(guardian);
        tl.cancel(readyId);
        _expectNotReady(readyId);
        _execute(address(controller), data, readySalt);
        assertFalse(pool.vaultWhitelisted(vault));
    }

    function testCancelledOperationMustWaitAgainWhenRescheduled() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (bytes32 salt, bytes32 id) = _schedule(address(controller), data);
        vm.prank(guardian);
        tl.cancel(id);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(cactus);
        tl.schedule(address(controller), 0, data, bytes32(0), salt, DELAY);
        _expectNotReady(id);
        _execute(address(controller), data, salt);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(controller), data, salt);
        assertTrue(pool.vaultWhitelisted(vault));
    }

    function testUnassignedPersonnelCannotCancelAndDoneCannotBeCancelled() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (bytes32 salt, bytes32 id) = _schedule(address(controller), data);
        _expectUnauthorized(attacker, tl.CANCELLER_ROLE());
        vm.prank(attacker);
        tl.cancel(id);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(controller), data, salt);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector,
                id,
                bytes32(
                    (uint256(1) << uint8(TimelockController.OperationState.Waiting))
                        | (uint256(1) << uint8(TimelockController.OperationState.Ready))
                )
            )
        );
        vm.prank(guardian);
        tl.cancel(id);
    }

    function testProposerRetainsStandardCancellationAuthority() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (bytes32 salt, bytes32 id) = _schedule(address(controller), data);
        vm.prank(cactus);
        tl.cancel(id);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _expectNotReady(id);
        _execute(address(controller), data, salt);
        assertFalse(pool.vaultWhitelisted(vault));
    }

    function testCancellationRoleRevocationUsesDelayedSelfAdministration() public {
        // Optional future role changes must wait; the primary fixture retains both cancellers.
        bytes memory revoke = abi.encodeCall(tl.revokeRole, (tl.CANCELLER_ROLE(), cactus));
        (bytes32 revokeSalt, bytes32 revokeId) = _schedule(address(tl), revoke);
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), cactus));
        _expectNotReady(revokeId);
        _execute(address(tl), revoke, revokeSalt);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(tl), revoke, revokeSalt);
        assertFalse(tl.hasRole(tl.CANCELLER_ROLE(), cactus));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), guardian));

        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (, bytes32 id) = _schedule(address(controller), data);
        _expectUnauthorized(cactus, tl.CANCELLER_ROLE());
        vm.prank(cactus);
        tl.cancel(id);
        vm.prank(guardian);
        tl.cancel(id);
        assertFalse(tl.isOperationPending(id));
    }

    function testChangingScheduledCalldataDoesNotAuthorizeNewOperation() public {
        bytes memory original = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        bytes memory changed = abi.encodeCall(controller.setVaultWhitelisted, (vault, false));
        (bytes32 salt, bytes32 originalId) = _schedule(address(controller), original);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        bytes32 changedId = tl.hashOperation(address(controller), 0, changed, bytes32(0), salt);
        assertNotEq(originalId, changedId);
        _expectNotReady(changedId);
        _execute(address(controller), changed, salt);
        _execute(address(controller), original, salt);
        assertTrue(pool.vaultWhitelisted(vault));
    }

    function testChangingScheduledTargetDoesNotAuthorizeNewOperation() public {
        bytes memory data = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        bytes32 changedId = tl.hashOperation(address(pool), 0, data, bytes32(0), salt);
        _expectNotReady(changedId);
        _execute(address(pool), data, salt);
        assertFalse(pool.vaultWhitelisted(vault));
    }

    function _twoCallBatch()
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory data)
    {
        targets = new address[](2);
        targets[0] = address(controller);
        targets[1] = address(controller);
        values = new uint256[](2);
        data = new bytes[](2);
        data[0] = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        data[1] = abi.encodeCall(controller.setSettlementWhitelisted, (address(successor), true));
    }

    function testBatchCannotExecuteEarlyAndExecutesOnlyAfterFullDelay() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _twoCallBatch();
        bytes32 salt = _nextSalt();
        bytes32 id = tl.hashOperationBatch(targets, values, data, bytes32(0), salt);
        vm.prank(cactus);
        tl.scheduleBatch(targets, values, data, bytes32(0), salt, DELAY);
        _expectNotReady(id);
        vm.prank(cactus);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.prank(cactus);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
        assertTrue(pool.vaultWhitelisted(vault));
        assertTrue(pool.settlementWhitelisted(address(successor)));
        _expectNotReady(id);
        vm.prank(cactus);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
    }

    function testGuardianCanCancelWholeBatch() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _twoCallBatch();
        bytes32 salt = _nextSalt();
        bytes32 id = tl.hashOperationBatch(targets, values, data, bytes32(0), salt);
        vm.prank(cactus);
        tl.scheduleBatch(targets, values, data, bytes32(0), salt, DELAY);
        vm.prank(guardian);
        tl.cancel(id);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _expectNotReady(id);
        vm.prank(cactus);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
        assertFalse(pool.vaultWhitelisted(vault));
        assertFalse(pool.settlementWhitelisted(address(successor)));
    }

    function testBatchAndSingleOperationIdsCannotBeInterchanged() public {
        bytes memory payload = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        (bytes32 salt,) = _schedule(address(controller), payload);
        address[] memory targets = new address[](1);
        targets[0] = address(controller);
        uint256[] memory values = new uint256[](1);
        bytes[] memory data = new bytes[](1);
        data[0] = payload;
        vm.warp(vm.getBlockTimestamp() + DELAY);
        bytes32 batchId = tl.hashOperationBatch(targets, values, data, bytes32(0), salt);
        _expectNotReady(batchId);
        vm.prank(cactus);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
        _execute(address(controller), payload, salt);
        assertTrue(pool.vaultWhitelisted(vault));
    }

    function testBatchCannotBeSplitIntoIndividuallyExecutableCalls() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory data) = _twoCallBatch();
        bytes32 salt = _nextSalt();
        vm.prank(cactus);
        tl.scheduleBatch(targets, values, data, bytes32(0), salt, DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        bytes32 singleId = tl.hashOperation(targets[0], 0, data[0], bytes32(0), salt);
        _expectNotReady(singleId);
        _execute(targets[0], data[0], salt);
        assertFalse(pool.vaultWhitelisted(vault));
    }

    function testTimelockRoleAdministrationItselfMustWait() public {
        bytes32 role = tl.EXECUTOR_ROLE();
        _expectUnauthorized(cactus, tl.DEFAULT_ADMIN_ROLE());
        vm.prank(cactus);
        tl.grantRole(role, attacker);
        bytes memory data = abi.encodeCall(tl.grantRole, (role, attacker));
        (bytes32 salt, bytes32 id) = _schedule(address(tl), data);
        _expectNotReady(id);
        _execute(address(tl), data, salt);
        assertFalse(tl.hasRole(role, attacker));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(tl), data, salt);
        assertTrue(tl.hasRole(role, attacker));
    }

    function testStandardDelayChangesRequireScheduledSelfCall() public {
        // Standard Timelock is intentionally not described as a permanent seven-day floor.
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, cactus));
        vm.prank(cactus);
        tl.updateDelay(0);
        _delayed(address(tl), abi.encodeCall(tl.updateDelay, (8 days)));
        assertEq(tl.getMinDelay(), 8 days);
    }

    function testTimelockCannotDirectlyGrantGovernor() public {
        bytes memory data = abi.encodeCall(ac.grantRole, (ac.GOVERNOR_ROLE(), attacker));
        (bytes32 salt,) = _schedule(address(ac), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _expectUnauthorized(address(tl), ac.GOVERNOR_ROLE());
        _execute(address(ac), data, salt);
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), attacker));
    }

    function testBatchGovernorGrantBypassRevertsEveryEarlierEffect() public {
        address[] memory targets = new address[](2);
        targets[0] = address(controller);
        targets[1] = address(ac);
        uint256[] memory values = new uint256[](2);
        bytes[] memory data = new bytes[](2);
        data[0] = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        data[1] = abi.encodeCall(ac.grantRole, (ac.GOVERNOR_ROLE(), attacker));
        bytes32 salt = _nextSalt();
        bytes32 id = tl.hashOperationBatch(targets, values, data, bytes32(0), salt);
        vm.prank(cactus);
        tl.scheduleBatch(targets, values, data, bytes32(0), salt, DELAY);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _expectUnauthorized(address(tl), ac.GOVERNOR_ROLE());
        vm.prank(cactus);
        tl.executeBatch(targets, values, data, bytes32(0), salt);
        assertFalse(pool.vaultWhitelisted(vault));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), attacker));
        assertFalse(tl.isOperationDone(id));
    }

    function testEveryExplicitRouteRejectsDirectPersonnelCalls() public {
        bytes[] memory calls = _restrictedCalls();
        for (uint256 i; i < calls.length; ++i) {
            _assertDirectCallRejected(cactus, calls[i]);
            _assertDirectCallRejected(guardian, calls[i]);
            _assertDirectCallRejected(attacker, calls[i]);
        }
    }

    function _assertDirectCallRejected(address caller, bytes memory payload) internal {
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(controller).call(payload);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(GovernanceController.NotTimelock.selector, caller));
    }

    function _restrictedCalls() internal view returns (bytes[] memory calls) {
        calls = new bytes[](28);
        calls[0] = abi.encodeCall(controller.operatorTransfer, (vault, attacker, 1, bytes32(0)));
        calls[1] = abi.encodeCall(controller.operatorTransferToRevenuePool, (vault, 1, bytes32(0)));
        calls[2] = abi.encodeCall(controller.setVaultWhitelisted, (vault, true));
        calls[3] = abi.encodeCall(controller.setSettlementWhitelisted, (address(successor), true));
        calls[4] =
            abi.encodeCall(controller.upgradeUnifiedPool, (address(successor), address(successor).codehash, bytes("")));
        calls[5] = abi.encodeCall(controller.reinitializePoolStateManager, ());
        calls[6] = abi.encodeCall(controller.setVaultFactory, (address(successor)));
        calls[7] = abi.encodeCall(controller.setModulePaused, (ModuleId(0), true));
        calls[8] = abi.encodeCall(controller.setBridgeWhitelisted, (vault, true));
        calls[9] = abi.encodeCall(controller.setCreationFee, (CreationFeeAction(0), FeePaymentKind(0), 1));
        calls[10] = abi.encodeCall(controller.setFeePaymentToken, (FeePaymentKind(0), address(successor)));
        calls[11] = abi.encodeCall(controller.setFeeRevenuePool, ());
        calls[12] = abi.encodeCall(controller.setVaultProtocolFeeConfig, (vault, uint16(1)));
        calls[13] = abi.encodeCall(controller.withdrawRevenue, (attacker, 1));
        calls[14] = abi.encodeCall(controller.withdrawRevenueToken, (address(successor), attacker, 1));
        calls[15] = abi.encodeCall(controller.withdrawRevenueNative, (attacker, 1));
        calls[16] = abi.encodeCall(controller.setRevenueSource, (attacker, true));
        calls[17] = abi.encodeCall(controller.setRevenueYieldStrategy, (address(successor)));
        calls[18] = abi.encodeCall(
            controller.deployWrappedToken, (1, IReservePSM.AssetMode(0), address(successor), "N", "S", uint8(6), false)
        );
        calls[19] = abi.encodeCall(controller.setReservePSMPaused, (true));
        calls[20] = abi.encodeCall(controller.setWrapperAuthorizedSigner, (1, signer));
        calls[21] = abi.encodeCall(controller.setWrappedAssetPaused, (1, true));
        calls[22] = abi.encodeCall(controller.setManagedOracle, (address(oracle), true));
        calls[23] = abi.encodeCall(controller.setOracleSigner, (address(oracle), token, signer));
        calls[24] = abi.encodeCall(controller.removeOracleSigner, (address(oracle), token));
        calls[25] = abi.encodeCall(controller.setOracleNAVDeviationMaxBps, (address(oracle), 2_000));
        calls[26] = abi.encodeCall(controller.transferOracleOwnership, (address(oracle), address(successor)));
        calls[27] = abi.encodeCall(controller.migrateGovernor, (address(successor), address(successor).codehash));
    }

    function testNoGenericCallDelegatecallGrantOrFallbackEntry() public {
        bytes[] memory unknown = new bytes[](4);
        unknown[0] = abi.encodeWithSignature(
            "execute(address,bytes)", address(ac), abi.encodeCall(ac.grantRole, (ac.GOVERNOR_ROLE(), attacker))
        );
        unknown[1] = abi.encodeWithSignature("delegatecall(address,bytes)", address(successor), bytes(""));
        unknown[2] = abi.encodeWithSignature("grantRole(bytes32,address)", ac.GOVERNOR_ROLE(), attacker);
        unknown[3] = hex"ffffffff";
        for (uint256 i; i < unknown.length; ++i) {
            vm.prank(cactus);
            (bool ok,) = address(controller).call(unknown[i]);
            assertFalse(ok);
        }
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), attacker));
        // Even an actually scheduled unknown selector cannot use a fallback forwarding path.
        (bytes32 salt,) = _schedule(address(controller), unknown[0]);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(Errors.FailedCall.selector);
        _execute(address(controller), unknown[0], salt);
    }

    function testControllerRejectsNativeCustody() public {
        vm.deal(cactus, 1 ether);
        vm.prank(cactus);
        (bool ok,) = address(controller).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(controller).balance, 0);
    }

    function testGovernorSuccessionGrantsThenRevokesInOneDelayedExecution() public {
        bytes memory data =
            abi.encodeCall(controller.migrateGovernor, (address(successor), address(successor).codehash));
        (bytes32 salt, bytes32 id) = _schedule(address(controller), data);
        _expectNotReady(id);
        _execute(address(controller), data, salt);
        assertTrue(ac.hasRole(ac.GOVERNOR_ROLE(), address(controller)));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(successor)));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(controller), data, salt);
        assertTrue(ac.hasRole(ac.GOVERNOR_ROLE(), address(successor)));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(controller)));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(tl)));
    }

    function testGovernorSuccessionWrongHashLeavesOriginalAuthorityIntact() public {
        bytes32 wrongHash = keccak256("DD01 wrong successor runtime");
        bytes memory data = abi.encodeCall(controller.migrateGovernor, (address(successor), wrongHash));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernanceController.WrongCodeHash.selector, address(successor), wrongHash, address(successor).codehash
            )
        );
        _execute(address(controller), data, salt);
        assertTrue(ac.hasRole(ac.GOVERNOR_ROLE(), address(controller)));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(successor)));
    }

    function testGovernorSuccessionRechecksRuntimeHashAtExecution() public {
        bytes32 originalHash = address(successor).codehash;
        bytes memory data = abi.encodeCall(controller.migrateGovernor, (address(successor), originalHash));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.etch(address(successor), hex"60006000f3");
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(
                GovernanceController.WrongCodeHash.selector,
                address(successor),
                originalHash,
                address(successor).codehash
            )
        );
        _execute(address(controller), data, salt);
        assertTrue(ac.hasRole(ac.GOVERNOR_ROLE(), address(controller)));
    }

    function testGovernorSuccessionRejectsEOAAndSelf() public {
        bytes memory data = abi.encodeCall(controller.migrateGovernor, (attacker, attacker.codehash));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, attacker));
        _execute(address(controller), data, salt);
        data = abi.encodeCall(controller.migrateGovernor, (address(controller), address(controller).codehash));
        (salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(GovernanceController.InvalidSuccessor.selector);
        _execute(address(controller), data, salt);
    }

    function testUpgradeBindsExactImplementationAndInitializationBytes() public {
        bytes memory initialization = abi.encodeWithSignature("initializeV3(uint256)", 42);
        bytes memory data = abi.encodeCall(
            controller.upgradeUnifiedPool, (address(successor), address(successor).codehash, initialization)
        );
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(controller), data, salt);
        assertEq(pool.implementation(), address(successor));
        assertEq(pool.initializationData(), initialization);
    }

    function testOracleOwnerCallsNeedBothAllowlistAndActualOwnership() public {
        NAVOracle unlisted = new NAVOracle(address(this), 2_000);
        unlisted.transferOwnership(address(controller));
        bytes memory data = abi.encodeCall(controller.setOracleSigner, (address(unlisted), token, signer));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.OracleNotManaged.selector, address(unlisted)));
        _execute(address(controller), data, salt);

        NAVOracle unowned = new NAVOracle(attacker, 2_000);
        _delayed(address(controller), abi.encodeCall(controller.setManagedOracle, (address(unowned), true)));
        data = abi.encodeCall(controller.setOracleSigner, (address(unowned), token, signer));
        (salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.OracleNotOwned.selector, address(unowned)));
        _execute(address(controller), data, salt);
    }

    function testAllowedAndOwnedOracleSignerAndDeviationChangesWait() public {
        bytes memory data = abi.encodeCall(controller.setOracleSigner, (address(oracle), token, signer));
        (bytes32 salt, bytes32 id) = _schedule(address(controller), data);
        _expectNotReady(id);
        _execute(address(controller), data, salt);
        assertEq(oracle.signerOf(token), address(0));
        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(controller), data, salt);
        assertEq(oracle.signerOf(token), signer);
        _delayed(address(controller), abi.encodeCall(controller.setOracleNAVDeviationMaxBps, (address(oracle), 1_000)));
        assertEq(oracle.navDeviationMaxBps(), 1_000);
        _delayed(address(controller), abi.encodeCall(controller.removeOracleSigner, (address(oracle), token)));
        assertEq(oracle.signerOf(token), address(0));
    }

    function testRemovedOracleCannotBeManagedEvenWhenStillOwned() public {
        _delayed(address(controller), abi.encodeCall(controller.setManagedOracle, (address(oracle), false)));
        assertEq(oracle.owner(), address(controller));
        bytes memory data = abi.encodeCall(controller.setOracleSigner, (address(oracle), token, signer));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.OracleNotManaged.selector, address(oracle)));
        _execute(address(controller), data, salt);
    }

    function testOracleOwnershipTransferRejectsEOAAndSelfAndLosesOldControl() public {
        bytes memory data = abi.encodeCall(controller.transferOracleOwnership, (address(oracle), attacker));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, attacker));
        _execute(address(controller), data, salt);
        data = abi.encodeCall(controller.transferOracleOwnership, (address(oracle), address(controller)));
        (salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(GovernanceController.InvalidSuccessor.selector);
        _execute(address(controller), data, salt);
        _delayed(
            address(controller),
            abi.encodeCall(controller.transferOracleOwnership, (address(oracle), address(successor)))
        );
        assertEq(oracle.owner(), address(successor));
        data = abi.encodeCall(controller.setOracleSigner, (address(oracle), token, signer));
        (salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.OracleNotOwned.selector, address(oracle)));
        _execute(address(controller), data, salt);
    }

    function testConstructorRejectsMissingMandatoryContracts() public {
        address[] memory oracles = new address[](0);
        GovernanceController.Targets memory targets = _targets();
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, address(0)));
        new GovernanceController(address(0), address(ac), targets, oracles);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, address(0)));
        new GovernanceController(address(tl), address(0), targets, oracles);
        targets.stateManager = address(0);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, address(0)));
        new GovernanceController(address(tl), address(ac), targets, oracles);
        targets = _targets();
        targets.unifiedPool = address(0);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, address(0)));
        new GovernanceController(address(tl), address(ac), targets, oracles);
    }

    function testConstructorRejectsEOATargetAndOracle() public {
        GovernanceController.Targets memory targets = _targets();
        address[] memory oracles = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, cactus));
        new GovernanceController(cactus, address(ac), targets, oracles);
        targets.revenuePool = attacker;
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, attacker));
        new GovernanceController(address(tl), address(ac), targets, oracles);
        targets = _targets();
        oracles = new address[](1);
        oracles[0] = attacker;
        vm.expectRevert(abi.encodeWithSelector(GovernanceController.NotContract.selector, attacker));
        new GovernanceController(address(tl), address(ac), targets, oracles);
    }

    function testConstructorRejectsZeroDelayTimelock() public {
        TimelockController zeroDelay = _newTimelock(0);
        address[] memory oracles = new address[](0);
        vm.expectRevert(GovernanceController.InvalidTimelock.selector);
        new GovernanceController(address(zeroDelay), address(ac), _targets(), oracles);
    }

    function testOptionalModulesCanBeOmittedButCannotBeCalled() public {
        bytes memory data = abi.encodeCall(controller.withdrawRevenue, (attacker, 1));
        (bytes32 salt,) = _schedule(address(controller), data);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        vm.expectRevert(GovernanceController.ModuleNotConfigured.selector);
        _execute(address(controller), data, salt);
    }
}
