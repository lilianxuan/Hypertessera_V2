// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {DeployConfig} from "./DeployConfig.sol";
import {KYTDepositGateway} from "../../src/compliance/KYTDepositGateway.sol";
import {IBaseVault} from "../../src/interfaces/IBaseVault.sol";
import {IStateManager} from "../../src/interfaces/IStateManager.sol";
import {IVaultRoles} from "../../src/interfaces/IVaultRoles.sol";
import {ProductState} from "../../src/libs/Types.sol";

/// @dev BaseVault public state this script reads back. `usdt` and `gate` are public variables
///      rather than `IBaseVault` functions, so they are reached through a minimal interface
///      instead of widening the audited interface.
interface IVaultGateBindings {
    function usdt() external view returns (address);
    function gate() external view returns (address);
    function stateManager() external view returns (address);
}

/// @title DeployKYTGateway — optional module, run per Vault, after that Vault is live
/// @notice Deploys one `KYTDepositGateway` in front of one Vault and (while that Vault is still
///         CONFIGURING) installs it as the Vault's gate, turning KYT on for subscriptions.
///
///         This is an ADD-ON, not a deployment stage. The platform and the Vault are deployed and
///         verified first; this script is run afterwards, only for Vaults that need pre-deposit
///         Chainalysis screening, and it deploys nothing else. Vaults without it keep subscribing
///         exactly as before (`gate == address(0)`).
///
///         One Gateway per Vault: the Vault address is `immutable` on the Gateway, matching the
///         signature the client's spec fixes (`requestDeposit(amount, owner)`, no vault argument).
///
///         Usage (prefer `script/deploy.sh --kyt <vault-label>`):
///           KYT_VAULT=0x… KYT_ORACLE=0x… forge script script/deploy/DeployKYTGateway.s.sol \
///             --tc DeployKYTGateway --rpc-url <rpc> --broadcast [--legacy --slow]
///
///         Inputs (env), required:
///           KYT_VAULT        the Vault this Gateway fronts
///           KYT_ORACLE       the account allowed to submit screening results (`fulfill`)
///
///         Inputs (env), required under `production`:
///           KYT_ADMIN        configures `oracle` / `validityPeriod`; use a multi-sig
///
///         Inputs (env), optional:
///           KYT_VALIDITY_PERIOD   seconds a screening request stays fulfillable (default 1 hour,
///                                 contract bounds: 5 minutes … 7 days)
///           KYT_LABEL             names this Gateway in the address book (default: the Vault label
///                                 supplied by deploy.sh, else "kyt")
///           KYT_SET_GATE          "false" to deploy the Gateway without installing it (see below)
///
///         Output: control-panel/deployments-kyt-<label>.json — one file per Gateway, so an
///         existing Gateway's record is never overwritten.
///
/// @dev    `setGate` is `_onlyOwnerDirectOrTimelock`: the Owner may call it directly ONLY while
///         the Vault is CONFIGURING. Past that point it must go through that Vault's own
///         VaultTimelock, which this script cannot drive (schedule → wait out the delay →
///         execute). So for a Vault that has already opened subscription the script deploys the
///         Gateway, prints the exact timelock calldata, and stops short of installing it — it does
///         not fail, because deploying ahead of the governance action is the normal sequence.
///
/// @dev    What this script does NOT do, by design: grant `vault.setOperator(gateway, true)` for
///         any owner (each owner does that themselves), and it does not start the screening
///         listener. See docs/kyt-deposit-gateway.md §5 and §9.
contract DeployKYTGateway is DeployConfig {
    uint64 internal constant DEFAULT_VALIDITY_PERIOD = 1 hours;

    function run() external {
        uint256 pk = _deployerKey();
        address deployer = vm.addr(pk);

        address vault = _requiredAddr("KYT_VAULT");
        address oracle = _requiredAddr("KYT_ORACLE");
        address admin = _roleAddr("KYT_ADMIN", ANVIL_7, deployer);
        uint64 validityPeriod = uint64(vm.envOr("KYT_VALIDITY_PERIOD", uint256(DEFAULT_VALIDITY_PERIOD)));
        string memory label = vm.envOr("KYT_LABEL", string("kyt"));

        _logProfile(string.concat("kyt:", label));

        // Refuse to front something that is not a Vault of this deployment. Without this a typo in
        // KYT_VAULT yields a Gateway pointing at nothing, which only surfaces when the first
        // subscription reverts.
        address stateManager = IVaultGateBindings(vault).stateManager();
        require(
            IStateManager(stateManager).registeredVaults(vault),
            "deploy: KYT_VAULT is not a registered Vault of this deployment"
        );

        address existingGate = IVaultGateBindings(vault).gate();
        require(existingGate == address(0), "deploy: KYT_VAULT already has a gate installed");

        vm.startBroadcast(pk);

        KYTDepositGateway gateway = new KYTDepositGateway(vault, oracle, admin, validityPeriod);

        // The Gateway caches the settlement token from the Vault; a mismatch would mean it is
        // pointed at the wrong Vault entirely.
        require(gateway.asset() == IVaultGateBindings(vault).usdt(), "deploy: gateway asset != vault usdt");

        bool wantGate = _envBoolOr("KYT_SET_GATE", true);
        bool configuring = IStateManager(stateManager).getProductState(vault) == ProductState.CONFIGURING;
        bool ownedByDeployer = IVaultRoles(vault).owner() == deployer;
        bool installed = false;

        if (wantGate && configuring && ownedByDeployer) {
            IBaseVault(vault).setGate(address(gateway));
            installed = true;
        }

        vm.stopBroadcast();

        _report(vault, address(gateway), installed, wantGate, configuring, ownedByDeployer);
        _writeOutput(label, vault, address(gateway), oracle, admin, validityPeriod, installed);
    }

    /// @dev `vm.envOr` has no bool overload that tolerates an empty value, and a network file may
    ///      legitimately carry a bare `KYT_SET_GATE=` line.
    function _envBoolOr(string memory name, bool fallbackValue) internal view returns (bool) {
        string memory raw = vm.envOr(name, string(""));
        if (bytes(raw).length == 0) return fallbackValue;
        bytes32 h = keccak256(bytes(raw));
        if (h == keccak256("false") || h == keccak256("0")) return false;
        return true;
    }

    /// @dev When the gate could not be installed directly, print the calldata the Vault's own
    ///      VaultTimelock needs. Leaving the operator to hand-assemble a selector is how the
    ///      2026-08-29 generation shipped three reverting `configureClaimRegistry` calls.
    function _report(
        address vault,
        address gateway,
        bool installed,
        bool wantGate,
        bool configuring,
        bool ownedByDeployer
    ) internal view {
        console2.log("  KYTDepositGateway:", gateway);
        console2.log("  vault:            ", vault);

        if (installed) {
            console2.log("  gate installed:    yes (vault was CONFIGURING)");
            return;
        }

        if (!wantGate) {
            console2.log("  gate installed:    no (KYT_SET_GATE=false)");
        } else if (!configuring) {
            console2.log("  gate installed:    no (vault has left CONFIGURING; route via VaultTimelock)");
        } else if (!ownedByDeployer) {
            console2.log("  gate installed:    no (deploy wallet is not this vault's Owner)");
        }

        console2.log("  setGate calldata:  ");
        console2.logBytes(abi.encodeWithSelector(IBaseVault.setGate.selector, gateway));
        console2.log("  -> vaultTimelock.scheduleParamChange(vault, <calldata>), wait out delay, executeParamChange(id)");
    }

    function _writeOutput(
        string memory label,
        address vault,
        address gateway,
        address oracle,
        address admin,
        uint64 validityPeriod,
        bool installed
    ) internal {
        string memory k = "kyt";
        vm.serializeString(k, "label", label);
        vm.serializeAddress(k, "vault", vault);
        vm.serializeAddress(k, "gateway", gateway);
        vm.serializeAddress(k, "oracle", oracle);
        vm.serializeAddress(k, "admin", admin);
        vm.serializeUint(k, "validityPeriod", validityPeriod);
        string memory entry = vm.serializeBool(k, "gateInstalled", installed);

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        string memory out = vm.serializeString(root, "kyt", entry);

        vm.writeJson(out, string.concat("./control-panel/deployments-kyt-", label, ".json"));
    }
}
