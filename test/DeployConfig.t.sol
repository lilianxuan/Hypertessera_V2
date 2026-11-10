// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployConfig} from "../script/deploy/DeployConfig.sol";
import {DeployVault} from "../script/deploy/DeployVault.s.sol";

/// @dev Exposes DeployConfig's internal helpers so the env-handling rules can be asserted
///      directly. The four stage scripts differ only in what they deploy — every one of them
///      reads its inputs through these helpers, so covering them covers all four.
contract DeployConfigHarness is DeployConfig {
    function profileIsDemo() external view returns (bool) { return _isDemo(); }
    function deployerKey() external view returns (uint256) { return _deployerKey(); }
    function requiredAddr(string memory n) external view returns (address) { return _requiredAddr(n); }
    function requiredUint(string memory n) external view returns (uint256) { return _requiredUint(n); }
    function roleAddr(string memory n, address anvilAcct, address deployer) external view returns (address) {
        return _roleAddr(n, anvilAcct, deployer);
    }
}

/// @title DeployConfigTest
/// @notice The deploy profile is what keeps a production deployment from silently pointing every
///         role at the deploy wallet, so it is asserted rather than assumed.
///
/// @dev    Deliberately ONE test function. `vm.setEnv` mutates the forge process's environment,
///         which is shared by every test in the run — split across several functions these
///         assertions race each other and fail at random. Kept sequential instead.
contract DeployConfigTest is Test {
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    DeployConfigHarness internal cfg;

    address internal deployer = makeAddr("deployer");
    address internal anvilAcct = makeAddr("anvilAcct");
    address internal named = makeAddr("named");

    function setUp() public {
        cfg = new DeployConfigHarness();
    }

    function test_deployProfileRules() public {
        // --- Profile parsing -------------------------------------------------------------
        // An unset or empty DEPLOY_PROFILE must mean demo, never production: the local and
        // testnet flows never set it, and the whole fallback behaviour hangs off this.
        vm.setEnv("DEPLOY_PROFILE", "");
        assertTrue(cfg.profileIsDemo(), "empty profile should be demo");

        vm.setEnv("DEPLOY_PROFILE", "demo");
        assertTrue(cfg.profileIsDemo(), "demo profile");

        vm.setEnv("DEPLOY_PROFILE", "staging");
        vm.expectRevert("deploy: DEPLOY_PROFILE must be 'demo' or 'production'");
        cfg.profileIsDemo();

        // --- Missing variables name themselves -------------------------------------------
        vm.setEnv("DEPLOY_PROFILE", "demo");
        vm.expectRevert("deploy: missing required env var HT_TEST_ABSENT_ADDR");
        cfg.requiredAddr("HT_TEST_ABSENT_ADDR");

        vm.expectRevert("deploy: missing required env var HT_TEST_ABSENT_UINT");
        cfg.requiredUint("HT_TEST_ABSENT_UINT");

        // --- Demo profile: roles fall back -------------------------------------------------
        vm.chainId(97);
        assertEq(cfg.roleAddr("HT_TEST_ROLE_A", anvilAcct, deployer), deployer, "off-Anvil fallback is the deployer");

        vm.chainId(31337);
        assertEq(cfg.roleAddr("HT_TEST_ROLE_A", anvilAcct, deployer), anvilAcct, "on Anvil, the Anvil account");

        vm.setEnv("HT_TEST_ROLE_A", vm.toString(named));
        assertEq(cfg.roleAddr("HT_TEST_ROLE_A", anvilAcct, deployer), named, "an explicit address always wins");

        // --- Production profile: nothing falls back ----------------------------------------
        // This is the reason the profile exists. A forgotten variable must abort the deploy, not
        // quietly hand the role to the deploy wallet.
        vm.setEnv("DEPLOY_PROFILE", "production");
        vm.expectRevert("deploy: missing required env var HT_TEST_ROLE_B");
        cfg.roleAddr("HT_TEST_ROLE_B", anvilAcct, deployer);

        assertEq(cfg.roleAddr("HT_TEST_ROLE_A", anvilAcct, deployer), named, "an explicit address is accepted");

        // Anvil's account 0 is a publicly known key; falling back to it on a real network would
        // hand the protocol to whoever noticed.
        vm.setEnv("TEST_PK", "0");
        vm.setEnv("PRIVATE_KEY", "0");
        vm.expectRevert("deploy: production profile requires TEST_PK or PRIVATE_KEY (no Anvil fallback)");
        cfg.deployerKey();

        vm.setEnv("DEPLOY_PROFILE", "demo");
        assertEq(cfg.deployerKey(), ANVIL_PK0, "demo still bootstraps off Anvil account 0");
    }
}

/// @dev Exposes DeployVault's input resolution without running a broadcast.
contract DeployVaultHarness is DeployVault {
    function sharedFor(string memory kindName) external returns (Shared memory) {
        vm.setEnv("VAULT_KIND", kindName);
        kind = _kind();
        return _shared();
    }
}

/// @title DeployVaultInputsTest
/// @notice Each Vault kind must validate only the shared addresses it actually uses. A Note vault
///         blocked on a LiquidityBridge it never touches, or an LP vault that silently deploys
///         with no Cash vault to bridge into, are both deployment-time failures this pins down.
///
/// @dev    One test function, for the same `vm.setEnv` reason as DeployConfigTest above.
contract DeployVaultInputsTest is Test {
    DeployVaultHarness internal h;

    address internal shared = makeAddr("shared");
    address internal bridge = makeAddr("bridge");
    address internal cash = makeAddr("cash");

    function setUp() public {
        h = new DeployVaultHarness();
        vm.setEnv("DEPLOY_PROFILE", "demo");
        // Everything every kind needs.
        for (uint256 i = 0; i < 8; i++) {
            vm.setEnv(_alwaysRequired(i), vm.toString(shared));
        }
        vm.setEnv("LIQUIDITY_BRIDGE", "");
        vm.setEnv("CASH_VAULT", "");
    }

    function _alwaysRequired(uint256 i) internal pure returns (string memory) {
        string[8] memory names = [
            "STATE_MANAGER", "QUEUE", "UNIFIED_POOL", "SETTLEMENT",
            "ADAPTER_FACTORY", "VAULT_FACTORY", "CLAIM_REGISTRY", "USDT"
        ];
        return names[i];
    }

    function test_perKindRequiredInputs() public {
        // --- note: needs neither the bridge nor a cash vault ---------------------------------
        DeployVault.Shared memory n = h.sharedFor("note");
        assertEq(n.stateManager, shared);
        assertEq(n.liquidityBridge, address(0), "a note vault must not demand a LiquidityBridge");
        assertEq(n.cashVault, address(0), "a note vault must not demand a CashVault");

        // --- cash: needs the bridge, not a cash vault ----------------------------------------
        vm.expectRevert("deploy: missing required env var LIQUIDITY_BRIDGE");
        h.sharedFor("cash");

        vm.setEnv("LIQUIDITY_BRIDGE", vm.toString(bridge));
        DeployVault.Shared memory c = h.sharedFor("cash");
        assertEq(c.liquidityBridge, bridge);
        assertEq(c.cashVault, address(0), "a cash vault must not demand another CashVault");

        // --- lp: needs both -------------------------------------------------------------------
        vm.expectRevert("deploy: missing required env var CASH_VAULT");
        h.sharedFor("lp");

        vm.setEnv("CASH_VAULT", vm.toString(cash));
        DeployVault.Shared memory l = h.sharedFor("lp");
        assertEq(l.liquidityBridge, bridge);
        assertEq(l.cashVault, cash, "an lp vault bridges into a named cash vault");

        // --- an unknown kind is refused, not silently treated as one of the three -------------
        vm.expectRevert("deploy: VAULT_KIND must be 'cash', 'note' or 'lp'");
        h.sharedFor("senior");
    }
}
