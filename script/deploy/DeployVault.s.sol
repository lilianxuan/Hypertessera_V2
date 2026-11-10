// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DeployConfig} from "./DeployConfig.sol";
import {UnifiedPool} from "../../src/asset-management/settlement/UnifiedPool.sol";
import {Settlement} from "../../src/asset-management/settlement/Settlement.sol";
import {AdapterFactory} from "../../src/asset-management/adaptors/AdapterFactory.sol";
import {LiquidityBridge} from "../../src/asset-management/vaults/LiquidityBridge.sol";
import {VaultFactory} from "../../src/asset-management/vaults/VaultFactory.sol";
import {LiquidityEarnVault} from "../../src/asset-management/vaults/LiquidityEarnVault.sol";
import {IVaultFactory} from "../../src/interfaces/IVaultFactory.sol";
import {IBaseVault} from "../../src/interfaces/IBaseVault.sol";
import {IAdapter} from "../../src/interfaces/IAdapter.sol";
import {IAdapterFactory} from "../../src/interfaces/IAdapterFactory.sol";
import {IStateManager} from "../../src/interfaces/IStateManager.sol";
import {FeePaymentKind} from "../../src/libs/Types.sol";

/// @dev The BaseVault constructor bindings this script reads back when adopting a Vault someone
///      else deployed. They are public state on BaseVault but not all are on `IBaseVault`.
interface IVaultBindings {
    function usdt() external view returns (address);
    function stateManager() external view returns (address);
    function queue() external view returns (address);
    function owner() external view returns (address);
    function vaultTimelock() external view returns (address);
    function settlement() external view returns (address);
}

/// @title DeployVault — stage 3: one Vault, run once per Vault
/// @notice Deploys (or adopts) a single Vault and does every piece of wiring that Vault needs:
///         pool admission, Settlement binding and its operator set, the strategy Adapter, the
///         claim registry, the liquidity-bridge whitelist, and the four Vault-local roles.
///
///         Run it once per Vault, whenever a Vault is needed. It reuses the shared contracts from
///         the platform stage and never redeploys them, so adding the protocol's fourth or tenth
///         Vault costs exactly one run of this script.
///
///         Usage (prefer `script/deploy.sh --vault <kind>`):
///           VAULT_KIND=cash forge script script/deploy/DeployVault.s.sol --tc DeployVault \
///             --rpc-url <rpc> --broadcast [--legacy --slow]
///
///         Inputs (env), always required:
///           VAULT_KIND       cash | note | lp
///           STATE_MANAGER, QUEUE, UNIFIED_POOL, SETTLEMENT, ADAPTER_FACTORY, VAULT_FACTORY,
///           CLAIM_REGISTRY   (platform stage output)
///           USDT             (core stage output)
///           SETTLEMENT_OPERATORS, SETTLEMENT_THRESHOLD, DATA_PROVIDER_SIGNER
///
///         Inputs (env), required per kind — each kind checks only what it actually uses:
///           cash             LIQUIDITY_BRIDGE
///           note             (nothing further)
///           lp               LIQUIDITY_BRIDGE, CASH_VAULT
///
///         Inputs (env), required under `production`:
///           VAULT_CURATOR, VAULT_KEEPER, VAULT_GUARDIAN, VAULT_ALLOCATOR
///
///         Inputs (env), optional:
///           VAULT            an already-deployed Vault to adopt instead of deploying a new one
///           VAULT_LABEL      names this Vault in the address book (default: VAULT_KIND)
///           VAULT_NAME, VAULT_SYMBOL          ERC-20 name/symbol (default: per kind)
///           CLAIM_GRACE_PERIOD                default 30 days
///           ADAPTER_STALENESS_WINDOW          default 36 hours
///
///         Output: control-panel/deployments-vault-<label>.json — a new file per Vault, so an
///         existing Vault's record is never overwritten.
///
/// @dev    The deployer takes Curator on itself first and hands it over last: `setAdapter` /
///         `addAdapter` / `setDataProvider` are Curator-gated and broadcast by this script's own
///         caller, so the configured Curator can only be installed once that wiring is done.
///
/// @dev    Adopt mode expects a Vault still in CONFIGURING, which is what `VaultFactory` leaves
///         behind. Past that point the Owner-class setters route through the Vault's own
///         VaultTimelock and cannot be sent directly, so a live Vault has to be wired through its
///         timelock instead of through this script.
///
/// @dev    What this script still does NOT set, by design: `ProductParams` (including
///         `subscriptionCapShare`, where 0 means UNLIMITED) and `LiquidityAdapter.setBridgeTarget`.
///         Both are the Curator's product decisions — see the deployment handbook's go-live list.
contract DeployVault is DeployConfig {
    uint256 internal constant DEFAULT_CLAIM_GRACE_PERIOD = 30 days;
    uint256 internal constant DEFAULT_STALENESS_WINDOW = 36 hours;

    enum Kind {
        Cash,
        Note,
        LP
    }

    struct Shared {
        address stateManager;
        address queue;
        address unifiedPool;
        address settlement;
        address adapterFactory;
        address vaultFactory;
        address claimRegistry;
        address usdt;
        address liquidityBridge; // zero for the note kind
        address cashVault; // lp kind only
    }

    struct Roles {
        address curator;
        address keeper;
        address guardian;
        address allocator;
        address dataProvider;
        address[] operators;
        uint256 threshold;
    }

    Kind internal kind;
    string internal label;
    address internal vaultAddr;
    address internal adapterAddr;
    bool internal adopted;

    function run() external {
        uint256 pk = _deployerKey();
        address deployer = vm.addr(pk);
        kind = _kind();
        label = vm.envOr("VAULT_LABEL", _kindName());
        _logProfile(string.concat("vault:", label));

        Shared memory sh = _shared();
        Roles memory roles = _roles(deployer);

        vm.startBroadcast(pk);

        vaultAddr = _resolveVault(sh, deployer);
        _bootstrapCurator(deployer);
        _admitToPool(sh);
        _bindSettlement(sh, roles);
        adapterAddr = _deployAdapter(sh);
        _wireAdapter(sh, roles);
        _configureClaimRegistry();
        _whitelistForBridge(sh);
        _grantRoles(roles);

        vm.stopBroadcast();

        _writeOutput(sh);
    }

    // --- Inputs ------------------------------------------------------------------------------

    function _kind() internal view returns (Kind) {
        bytes32 h = keccak256(bytes(vm.envOr("VAULT_KIND", string(""))));
        if (h == keccak256("cash")) return Kind.Cash;
        if (h == keccak256("note")) return Kind.Note;
        if (h == keccak256("lp")) return Kind.LP;
        revert("deploy: VAULT_KIND must be 'cash', 'note' or 'lp'");
    }

    function _kindName() internal view returns (string memory) {
        if (kind == Kind.Cash) return "cash";
        if (kind == Kind.Note) return "note";
        return "lp";
    }

    /// @dev Each kind reads only the shared addresses it actually uses. A note Vault does not
    ///      touch the liquidity bridge and must not be blocked on one being configured, and only
    ///      an lp Vault needs a cash Vault to bridge into.
    function _shared() internal view returns (Shared memory sh) {
        sh.stateManager   = _requiredAddr("STATE_MANAGER");
        sh.queue          = _requiredAddr("QUEUE");
        sh.unifiedPool    = _requiredAddr("UNIFIED_POOL");
        sh.settlement     = _requiredAddr("SETTLEMENT");
        sh.adapterFactory = _requiredAddr("ADAPTER_FACTORY");
        sh.vaultFactory   = _requiredAddr("VAULT_FACTORY");
        sh.claimRegistry  = _requiredAddr("CLAIM_REGISTRY");
        sh.usdt           = _requiredAddr("USDT");

        if (kind != Kind.Note) sh.liquidityBridge = _requiredAddr("LIQUIDITY_BRIDGE");
        if (kind == Kind.LP) sh.cashVault = _requiredAddr("CASH_VAULT");
    }

    function _roles(address deployer) internal view returns (Roles memory r) {
        r.curator      = _roleAddr("VAULT_CURATOR", ANVIL_1, deployer);
        r.keeper       = _roleAddr("VAULT_KEEPER", deployer);
        r.guardian     = _roleAddr("VAULT_GUARDIAN", ANVIL_2, deployer);
        r.allocator    = _roleAddr("VAULT_ALLOCATOR", deployer);
        r.dataProvider = _requiredAddr("DATA_PROVIDER_SIGNER");
        r.operators    = vm.envAddress("SETTLEMENT_OPERATORS", ",");
        r.threshold    = _requiredUint("SETTLEMENT_THRESHOLD");

        require(r.operators.length > 0, "deploy: SETTLEMENT_OPERATORS is empty");
        require(
            r.threshold > 0 && r.threshold <= r.operators.length,
            "deploy: SETTLEMENT_THRESHOLD must be between 1 and the operator count"
        );
    }

    // --- Vault -------------------------------------------------------------------------------

    /// @dev `VAULT` adopts a Vault that already exists — one created from a wallet or the control
    ///      panel, or left half-wired by an interrupted run. Everything downstream is identical.
    function _resolveVault(Shared memory sh, address deployer) internal returns (address) {
        address existing = vm.envOr("VAULT", address(0));
        if (existing == address(0)) return _deployNewVault(sh);

        adopted = true;
        _assertAdoptable(existing, sh, deployer);
        return existing;
    }

    /// @dev Adopting a Vault wired to a different StateManager/Queue/token would leave a
    ///      deployment that looks complete and reverts on the first real settlement, so every
    ///      binding is checked before anything is broadcast against it.
    function _assertAdoptable(address v, Shared memory sh, address deployer) internal view {
        require(
            IStateManager(sh.stateManager).registeredVaults(v),
            "deploy: VAULT is not registered in this STATE_MANAGER (wrong vault, or wrong platform)"
        );
        require(IVaultBindings(v).owner() == deployer, "deploy: VAULT owner is not the deploy wallet");
        require(IVaultBindings(v).stateManager() == sh.stateManager, "deploy: VAULT.stateManager mismatch");
        require(IVaultBindings(v).queue() == sh.queue, "deploy: VAULT.queue mismatch");
        require(IVaultBindings(v).usdt() == sh.usdt, "deploy: VAULT.usdt mismatch");
    }

    /// @dev `addAdapter` / `setAdapter` / `setDataProvider` below are Curator-gated and broadcast
    ///      by this wallet, so the deployer makes itself Curator for the duration of the wiring and
    ///      hands the role over in `_grantRoles` at the end. `setCurator` is Owner-gated, and the
    ///      Owner is this wallet — checked up front for an adopted Vault.
    function _bootstrapCurator(address deployer) internal {
        IBaseVault(vaultAddr).setCurator(deployer);
    }

    function _deployNewVault(Shared memory sh) internal returns (address) {
        return VaultFactory(sh.vaultFactory).deployVault(
            IVaultFactory.VaultParams({
                vaultType: kind == Kind.LP ? IVaultFactory.VaultType.LP : IVaultFactory.VaultType.EARN,
                name: vm.envOr("VAULT_NAME", _defaultName()),
                symbol: vm.envOr("VAULT_SYMBOL", _defaultSymbol()),
                usdt: sh.usdt,
                stateManager: sh.stateManager,
                settlement: address(0), // bound below, once the Vault exists
                queue: sh.queue,
                owner: address(0), // msg.sender becomes Owner
                liquidityBridge: sh.liquidityBridge,
                cashVault: sh.cashVault,
                feeKind: FeePaymentKind.Native
            })
        );
    }

    function _defaultName() internal view returns (string memory) {
        if (kind == Kind.Cash) return "HyperTessera Cash Earn";
        if (kind == Kind.Note) return "HyperTessera Note Earn";
        return "HyperTessera Liquidity Earn";
    }

    function _defaultSymbol() internal view returns (string memory) {
        if (kind == Kind.Cash) return "htCASH";
        if (kind == Kind.Note) return "htNOTE";
        return "htLP";
    }

    // --- Wiring ------------------------------------------------------------------------------

    /// @dev `addVault` is the Vault Owner opting in; `setVaultWhitelisted` is the protocol
    ///      admitting it (审计反馈 V3 #1/#2). `addVault` reverts `VaultAlreadyConfigured` on a
    ///      second call, so an adopted or re-run Vault skips it and still gets whitelisted.
    function _admitToPool(Shared memory sh) internal {
        UnifiedPool pool = UnifiedPool(sh.unifiedPool);
        if (!pool.vaultConfigured(vaultAddr)) pool.addVault(vaultAddr);
        pool.setVaultWhitelisted(vaultAddr, true);
    }

    function _bindSettlement(Shared memory sh, Roles memory r) internal {
        IBaseVault(vaultAddr).setSettlement(sh.settlement);

        Settlement settlement = Settlement(sh.settlement);
        for (uint256 i = 0; i < r.operators.length; i++) {
            settlement.setOperator(vaultAddr, r.operators[i], true);
        }
        settlement.setThreshold(vaultAddr, r.threshold);
    }

    function _deployAdapter(Shared memory sh) internal returns (address) {
        IAdapterFactory.AdapterParams memory p = IAdapterFactory.AdapterParams({
            asset: sh.usdt,
            vault: vaultAddr,
            stalenessWindow: vm.envOr("ADAPTER_STALENESS_WINDOW", DEFAULT_STALENESS_WINDOW)
        });
        AdapterFactory f = AdapterFactory(sh.adapterFactory);
        return kind == Kind.LP ? f.deployLiquidityAdapter(p) : f.deployAdapter(p);
    }

    function _wireAdapter(Shared memory sh, Roles memory r) internal {
        // LiquidityEarnVault.setAdapter registers the LiquidityAdapter into BaseVault.adapters[]
        // internally; a plain Adapter needs addAdapter called explicitly so grossManagedAssets()
        // aggregates its realAssets().
        if (kind == Kind.LP) {
            LiquidityEarnVault(vaultAddr).setAdapter(adapterAddr);
        } else {
            IBaseVault(vaultAddr).addAdapter(adapterAddr);
        }

        // Wire UnifiedPool so grossManagedAssets() also counts this Vault's pool receivable.
        IBaseVault(vaultAddr).setUnifiedPool(sh.unifiedPool);

        // Data Provider is per-Adapter (set by that Vault's Curator), not a global role.
        IAdapter(adapterAddr).setDataProvider(r.dataProvider);
    }

    function _configureClaimRegistry() internal {
        // Signature is (address,uint256). The 2026-08-29 generation first sent this as
        // (address,uint64); the selector did not match and all three calls reverted during gas
        // estimation. Encoding it here removes the chance of repeating that.
        IBaseVault(vaultAddr).configureClaimRegistry(
            _requiredAddr("CLAIM_REGISTRY"), vm.envOr("CLAIM_GRACE_PERIOD", DEFAULT_CLAIM_GRACE_PERIOD)
        );
    }

    /// @dev Bridge admission is separate from pool admission and from StateManager registration:
    ///      `deployVault` is permissionless, so being registered says only that the VaultFactory
    ///      built it, not that it is trusted (审计反馈 V4 #2). Each Vault whitelists itself, so the
    ///      LP → Cash leg is complete once both ends have been deployed by this script.
    function _whitelistForBridge(Shared memory sh) internal {
        if (kind == Kind.Note) return;
        LiquidityBridge(sh.liquidityBridge).setBridgeWhitelisted(vaultAddr, true);
    }

    /// @dev Last, and Curator last of all — every Curator-gated call above is broadcast by the
    ///      deployer, so handing Curator over any earlier aborts this script with `Unauthorized()`.
    ///      Keeper is additive; revoking the deploy wallet's own grant is part of the handover
    ///      checklist in the handbook, not of bring-up.
    function _grantRoles(Roles memory r) internal {
        IBaseVault(vaultAddr).setKeeper(r.keeper, true);
        IBaseVault(vaultAddr).setGuardian(r.guardian);
        IBaseVault(vaultAddr).setAllocator(r.allocator);
        IBaseVault(vaultAddr).setCurator(r.curator);
    }

    // --- Output ------------------------------------------------------------------------------

    function _writeOutput(Shared memory sh) internal {
        string memory v = "vault";
        vm.serializeString(v, "label", label);
        vm.serializeString(v, "kind", _kindName());
        vm.serializeBool(v, "adopted", adopted);
        vm.serializeAddress(v, "vault", vaultAddr);
        vm.serializeAddress(v, "adapter", adapterAddr);
        vm.serializeAddress(v, "timelock", IVaultBindings(vaultAddr).vaultTimelock());
        vm.serializeAddress(v, "settlement", sh.settlement);
        string memory entry = vm.serializeAddress(v, "cashVault", sh.cashVault);

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        string memory out = vm.serializeString(root, "vault", entry);

        // One file per Vault: a new Vault never rewrites an existing Vault's record.
        vm.writeJson(out, string.concat("./control-panel/deployments-vault-", label, ".json"));
    }
}
