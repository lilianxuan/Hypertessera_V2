// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "../src/addition/TimelockController.sol";
import {DeployDD01Governance} from "../script/DeployDD01Governance.s.sol";
import {GovernanceController} from "../src/addition/GovernanceController.sol";
import {HyperAccessControl} from "../src/governance/HyperAccessControl.sol";
import {StateManager} from "../src/asset-management/StateManager.sol";
import {UnifiedPool} from "../src/asset-management/settlement/UnifiedPool.sol";
import {RevenuePool} from "../src/asset-management/settlement/RevenuePool.sol";
import {LiquidityBridge} from "../src/asset-management/vaults/LiquidityBridge.sol";
import {ProtocolFeeConfig} from "../src/asset-infrastructure/ProtocolFeeConfig.sol";
import {ReservePSM} from "../src/wrapped-assets/ReservePSM.sol";
import {NAVOracle} from "../src/asset-infrastructure/NAVOracle.sol";

/// @dev Token identity, rather than balances, is relevant to deployment preflight.
contract DD01DeploymentToken is ERC20 {
    constructor() ERC20("DD01 deployment settlement token", "DEPUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @dev Exposes only the script's existing read-only preflight. These tests do not broadcast
///      or duplicate the binding checks in a mock implementation.
contract DD01DeploymentPreflightHarness is DeployDD01Governance {
    function validate(address accessControl, GovernanceController.Targets memory targets) external view {
        _checkBindings(accessControl, targets);
    }
}

/// @title DD01GovernanceDeploymentTest
/// @notice Uses the original concrete protocol modules and a real initialized pool proxy.
///         Only ONE test sets environment variables and calls run(). All other tests call
///         the read-only harness, avoiding parallel tests competing over environment state.
/// @dev forge test runs this entirely in its local EVM. It does not use an RPC, private key,
///      forge script --broadcast, or a network transaction. The script's broadcast cheatcode
///      changes the local creation sender only; this suite is not deployment evidence.
contract DD01GovernanceDeploymentTest is Test {
    HyperAccessControl internal ac;
    StateManager internal sm;
    UnifiedPool internal pool;
    RevenuePool internal revenue;
    LiquidityBridge internal bridge;
    ProtocolFeeConfig internal fees;
    ReservePSM internal psm;
    NAVOracle internal oracle;
    DD01DeploymentToken internal token;
    DD01DeploymentPreflightHarness internal preflight;

    address internal cactus = makeAddr("DD01 deployment Cactus governor");
    address internal guardian = makeAddr("DD01 deployment Cactus guardian");
    address internal deployer = makeAddr("DD01 deployment sender");
    address internal otherGovernor = makeAddr("DD01 other protocol governor");

    function setUp() public {
        ac = new HyperAccessControl(cactus);
        sm = new StateManager(address(ac));
        token = new DD01DeploymentToken();
        pool = _newPool(address(sm), address(ac), address(token));
        revenue = new RevenuePool(address(token), address(ac));
        bridge = new LiquidityBridge(address(token), address(sm), address(ac));
        fees = new ProtocolFeeConfig(address(ac), address(revenue));
        psm = new ReservePSM(address(ac));
        oracle = new NAVOracle(cactus, 2_000);
        preflight = new DD01DeploymentPreflightHarness();
    }

    function _newPool(address stateManager, address accessControl, address settlementToken)
        internal
        returns (UnifiedPool)
    {
        UnifiedPool implementation = new UnifiedPool();
        return UnifiedPool(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(UnifiedPool.initialize, (settlementToken, stateManager, accessControl))
                )
            )
        );
    }

    function _targets() internal view returns (GovernanceController.Targets memory) {
        return GovernanceController.Targets({
            stateManager: address(sm),
            unifiedPool: address(pool),
            revenuePool: address(revenue),
            protocolFeeConfig: address(fees),
            reservePSM: address(psm),
            liquidityBridge: address(bridge)
        });
    }

    function _expectWrongBinding(address target, address expected, address actual) internal {
        vm.expectRevert(abi.encodeWithSelector(DeployDD01Governance.WrongBinding.selector, target, expected, actual));
    }

    function testRunLocallyDeploysOnlyNewContractsAndDoesNotPerformRoleHandover() public {
        // These are public deployment inputs. This is the suite's only env-writing test.
        vm.setEnv("GOVERNANCE_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("GOVERNANCE_DEPLOYER", vm.toString(deployer));
        vm.setEnv("GOVERNANCE_WALLET", vm.toString(cactus));
        vm.setEnv("GOVERNANCE_GUARDIAN_WALLET", vm.toString(guardian));
        vm.setEnv("GOVERNANCE_ACCESS_CONTROL", vm.toString(address(ac)));
        vm.setEnv("GOVERNANCE_STATE_MANAGER", vm.toString(address(sm)));
        vm.setEnv("GOVERNANCE_UNIFIED_POOL", vm.toString(address(pool)));
        vm.setEnv("GOVERNANCE_REVENUE_POOL", vm.toString(address(revenue)));
        vm.setEnv("GOVERNANCE_FEE_CONFIG", vm.toString(address(fees)));
        vm.setEnv("GOVERNANCE_RESERVE_PSM", vm.toString(address(psm)));
        vm.setEnv("GOVERNANCE_LIQUIDITY_BRIDGE", vm.toString(address(bridge)));
        vm.setEnv("GOVERNANCE_NAV_ORACLES", vm.toString(address(oracle)));

        DeployDD01Governance deployment = new DeployDD01Governance();
        uint256 senderNonceBefore = vm.getNonce(deployer);
        (TimelockController timelock, GovernanceController controller) = deployment.run();

        assertGt(address(timelock).code.length, 0);
        assertGt(address(controller).code.length, 0);
        assertEq(uint256(vm.getNonce(deployer)), senderNonceBefore + 2);
        assertEq(timelock.getMinDelay(), 7 days);
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), cactus));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), guardian));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), cactus));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), cactus));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), cactus));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));

        assertEq(controller.timelock(), address(timelock));
        assertEq(address(controller.accessControl()), address(ac));
        assertEq(address(controller.stateManager()), address(sm));
        assertEq(address(controller.unifiedPool()), address(pool));
        assertEq(address(controller.revenuePool()), address(revenue));
        assertEq(address(controller.protocolFeeConfig()), address(fees));
        assertEq(address(controller.reservePSM()), address(psm));
        assertEq(address(controller.liquidityBridge()), address(bridge));
        assertTrue(controller.managedOracles(address(oracle)));

        // run() prints unsigned setup payloads; it must not quietly change original authority.
        assertTrue(ac.hasRole(ac.GOVERNOR_ROLE(), cactus));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(controller)));
        assertFalse(ac.hasRole(ac.GOVERNOR_ROLE(), address(timelock)));
        assertEq(oracle.owner(), cactus);
        assertEq(sm.vaultFactory(), address(0));
        assertEq(address(pool.sm()), address(sm));
        assertEq(address(pool.ac()), address(ac));
        assertEq(fees.revenuePool(), address(revenue));
        assertFalse(psm.globalPaused());
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian));

        bytes memory grantCanceller = abi.encodeCall(timelock.grantRole, (timelock.CANCELLER_ROLE(), guardian));
        bytes32 salt = keccak256(abi.encode("DD01_GUARDIAN_SETUP", block.chainid, address(timelock), guardian));
        bytes32 setupId = timelock.hashOperation(address(timelock), 0, grantCanceller, bytes32(0), salt);
        assertFalse(timelock.isOperation(setupId));
    }

    function testPreflightReadsRealStateManagerAccessControlGetter() public {
        assertEq(sm.accessControl(), address(ac));
        // The original StateManager has no ac() getter. This fails under the old helper and
        // proves success is not coming from a mock that happens to implement both selectors.
        (bool hasIncorrectGetter,) = address(sm).staticcall(abi.encodeWithSignature("ac()"));
        assertFalse(hasIncorrectGetter);
        preflight.validate(address(ac), _targets());
    }

    function testPreflightRejectsStateManagerFromDifferentACL() public {
        HyperAccessControl otherACL = new HyperAccessControl(otherGovernor);
        StateManager otherSM = new StateManager(address(otherACL));
        GovernanceController.Targets memory targets = _targets();
        targets.stateManager = address(otherSM);
        _expectWrongBinding(address(otherSM), address(ac), address(otherACL));
        preflight.validate(address(ac), targets);
    }

    function testPreflightRejectsPoolFromDifferentStateManager() public {
        StateManager otherSM = new StateManager(address(ac));
        UnifiedPool otherPool = _newPool(address(otherSM), address(ac), address(token));
        GovernanceController.Targets memory targets = _targets();
        targets.unifiedPool = address(otherPool);
        _expectWrongBinding(address(otherPool), address(sm), address(otherSM));
        preflight.validate(address(ac), targets);
    }

    function testPreflightRejectsRevenuePoolSettlementTokenMismatch() public {
        DD01DeploymentToken differentToken = new DD01DeploymentToken();
        RevenuePool otherRevenue = new RevenuePool(address(differentToken), address(ac));
        GovernanceController.Targets memory targets = _targets();
        targets.revenuePool = address(otherRevenue);
        _expectWrongBinding(address(otherRevenue), address(token), address(differentToken));
        preflight.validate(address(ac), targets);
    }

    function testPreflightPermitsOmittedOptionalModules() public {
        GovernanceController.Targets memory targets = GovernanceController.Targets({
            stateManager: address(sm),
            unifiedPool: address(pool),
            revenuePool: address(0),
            protocolFeeConfig: address(0),
            reservePSM: address(0),
            liquidityBridge: address(0)
        });
        preflight.validate(address(ac), targets);
    }
}
