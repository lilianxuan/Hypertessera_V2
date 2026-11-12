// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "../src/addition/TimelockController.sol";
import {GovernanceController} from "../src/addition/GovernanceController.sol";
import {IStateManager} from "../src/interfaces/IStateManager.sol";

interface IDD01AccessControlBinding {
    function ac() external view returns (address);
}

interface IDD01StateManagerBinding {
    function sm() external view returns (address);
}

interface IDD01SettlementTokenBinding {
    function usdt() external view returns (address);
}

/// @title DeployDD01Governance
/// @notice 仅部署标准时间锁和治理控制器，输出后续 Cactus 管理交易的数据。
/// @dev No private key is read by this script. Foundry signing, if separately authorized,
///      must be supplied by the caller's normal wallet tooling. A simulation is NOT deployment.
///      This script never grants Governor, removes an existing Governor, transfers Oracle
///      ownership, or changes any original protocol setting. Those steps are separate and
///      require verified receipts plus complete role-history reconciliation.
contract DeployDD01Governance is Script {
    uint256 public constant INITIAL_DELAY = 1 days;

    error WrongChain(uint256 expected, uint256 actual);
    error InvalidWalletConfiguration();
    error WrongBinding(address target, address expected, address actual);

    function run() external returns (TimelockController timelock, GovernanceController controller) {
        uint256 expectedChainId = vm.envUint("GOVERNANCE_CHAIN_ID");
        if (block.chainid != expectedChainId) revert WrongChain(expectedChainId, block.chainid);

        address deployer = vm.envAddress("GOVERNANCE_DEPLOYER");
        address governorWallet = vm.envAddress("GOVERNANCE_WALLET");
        address guardianWallet = vm.envAddress("GOVERNANCE_GUARDIAN_WALLET");
        if (
            deployer == address(0) || governorWallet == address(0) || guardianWallet == address(0)
                || governorWallet == guardianWallet
        ) revert InvalidWalletConfiguration();

        address accessControl = vm.envAddress("GOVERNANCE_ACCESS_CONTROL");
        GovernanceController.Targets memory targets = GovernanceController.Targets({
            stateManager: vm.envAddress("GOVERNANCE_STATE_MANAGER"),
            unifiedPool: vm.envAddress("GOVERNANCE_UNIFIED_POOL"),
            revenuePool: vm.envOr("GOVERNANCE_REVENUE_POOL", address(0)),
            protocolFeeConfig: vm.envOr("GOVERNANCE_FEE_CONFIG", address(0)),
            reservePSM: vm.envOr("GOVERNANCE_RESERVE_PSM", address(0)),
            liquidityBridge: vm.envOr("GOVERNANCE_LIQUIDITY_BRIDGE", address(0))
        });
        address[] memory noOracles = new address[](0);
        address[] memory initialOracles = vm.envOr("GOVERNANCE_NAV_ORACLES", ",", noOracles);

        // Public read-only checks run BEFORE either deployment. They catch mixed-chain or
        // mixed-project addresses without changing the original contracts or their storage.
        _checkBindings(accessControl, targets);

        address[] memory wallets = new address[](1);
        wallets[0] = governorWallet;

        // admin=0: only the Timelock itself is an administrator. The deployer has no bootstrap
        // administrator. The proposer keeps OZ's standard canceller permission.
        vm.startBroadcast(deployer);
        timelock = new TimelockController(INITIAL_DELAY, wallets, wallets, address(0));
        controller = new GovernanceController(address(timelock), accessControl, targets, initialOracles);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("Timelock (verify deployment receipt)", address(timelock));
        console2.log("GovernanceController (verify deployment receipt)", address(controller));
        console2.log("INITIAL_DELAY seconds", INITIAL_DELAY);

        // Configure Guardian cancellation through the same normal time delay BEFORE handover.
        // These are unsigned transaction payloads only; the script does not send them.
        bytes memory grantCanceller =
            abi.encodeWithSignature("grantRole(bytes32,address)", timelock.CANCELLER_ROLE(), guardianWallet);
        bytes32 salt = keccak256(abi.encode("DD01_GUARDIAN_SETUP", block.chainid, address(timelock), guardianWallet));
        console2.log("Cactus: schedule Guardian canceller, target Timelock:");
        console2.logBytes(
            abi.encodeCall(timelock.schedule, (address(timelock), 0, grantCanceller, bytes32(0), salt, INITIAL_DELAY))
        );
        console2.log("Cactus: after delay, execute Guardian canceller, target Timelock:");
        console2.logBytes(abi.encodeCall(timelock.execute, (address(timelock), 0, grantCanceller, bytes32(0), salt)));

        console2.log("Separate original-ACL transaction: grant Governor to Controller:");
        console2.logBytes(
            abi.encodeWithSignature("grantRole(bytes32,address)", keccak256("GOVERNOR_ROLE"), address(controller))
        );
        console2.log("Then reconcile ALL old Governor holders and revoke/renounce each; no handover is performed here.");
    }

    function _checkBindings(address accessControl, GovernanceController.Targets memory targets) internal view {
        // StateManager exposes accessControl(), while the other modules expose ac().
        address actualACL = IStateManager(targets.stateManager).accessControl();
        if (actualACL != accessControl) revert WrongBinding(targets.stateManager, accessControl, actualACL);
        _checkACL(targets.unifiedPool, accessControl);
        address actualSM = IDD01StateManagerBinding(targets.unifiedPool).sm();
        if (actualSM != targets.stateManager) revert WrongBinding(targets.unifiedPool, targets.stateManager, actualSM);
        if (targets.revenuePool != address(0)) {
            _checkACL(targets.revenuePool, accessControl);
            // Pool transfers call RevenuePool.receiveFee(), which measures its own USDT.
            // Reject a different settlement token before either new contract is deployed.
            address expectedToken = IDD01SettlementTokenBinding(targets.unifiedPool).usdt();
            address actualToken = IDD01SettlementTokenBinding(targets.revenuePool).usdt();
            if (actualToken != expectedToken) revert WrongBinding(targets.revenuePool, expectedToken, actualToken);
        }
        if (targets.protocolFeeConfig != address(0)) _checkACL(targets.protocolFeeConfig, accessControl);
        if (targets.reservePSM != address(0)) _checkACL(targets.reservePSM, accessControl);
        if (targets.liquidityBridge != address(0)) {
            _checkACL(targets.liquidityBridge, accessControl);
            actualSM = IDD01StateManagerBinding(targets.liquidityBridge).sm();
            if (actualSM != targets.stateManager) {
                revert WrongBinding(targets.liquidityBridge, targets.stateManager, actualSM);
            }
        }
    }

    function _checkACL(address target, address expected) internal view {
        address actual = IDD01AccessControlBinding(target).ac();
        if (actual != expected) revert WrongBinding(target, expected, actual);
    }
}
