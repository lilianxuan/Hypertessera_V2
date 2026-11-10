// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DeployConfig} from "./DeployConfig.sol";
import {ClaimRegistry} from "../../src/asset-infrastructure/ClaimRegistry.sol";
import {NAVOracle} from "../../src/asset-infrastructure/NAVOracle.sol";
import {IProtocolFeeConfig} from "../../src/interfaces/IProtocolFeeConfig.sol";
import {Queue} from "../../src/asset-management/settlement/Queue.sol";
import {RevenuePool} from "../../src/asset-management/settlement/RevenuePool.sol";
import {UnifiedPool} from "../../src/asset-management/settlement/UnifiedPool.sol";
import {Settlement} from "../../src/asset-management/settlement/Settlement.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {StateManager} from "../../src/asset-management/StateManager.sol";
import {LiquidityBridge} from "../../src/asset-management/vaults/LiquidityBridge.sol";
import {VaultFactory} from "../../src/asset-management/vaults/VaultFactory.sol";
import {EarnVaultDeployer} from "../../src/asset-management/vaults/EarnVaultDeployer.sol";
import {LiquidityEarnVaultDeployer} from "../../src/asset-management/vaults/LiquidityEarnVaultDeployer.sol";
import {AdapterFactory} from "../../src/asset-management/adaptors/AdapterFactory.sol";
import {FeePaymentKind} from "../../src/libs/Types.sol";

/// @title DeployPlatform — stage 2 of 3: shared infrastructure, no Vaults
/// @notice Deploys everything a Vault needs to exist but that is NOT specific to any one Vault:
///         the state machine, the shared pool, the queue, the factories, and the Settlement
///         contract. It deliberately creates no Vault — each Vault is deployed on its own, later,
///         by `DeployVault.s.sol`, as many times as the protocol needs.
///
///         Usage (prefer `script/deploy.sh`, which chains the stages):
///           forge script script/deploy/DeployPlatform.s.sol --tc DeployPlatform \
///             --rpc-url <rpc> --broadcast [--legacy --slow]
///
///         Inputs (env), all required:
///           HYPER_ACCESS_CONTROL, REVENUE_POOL, USDT, PROTOCOL_FEE_CONFIG   (stage 1 output)
///
///         Output: control-panel/deployments-platform.json
///
/// @dev    `PROTOCOL_FEE_CONFIG` is the instance stage 1 built for `AssetRegistry`; `VaultFactory`
///         reuses it rather than deploying its own, so the protocol has exactly one fee table.
///
/// @dev    `NAVOracle`, `Queue`, `ClaimRegistry` and `UnifiedPool` are deployed HERE and not reused
///         from stage 1. Each binds its StateManager exactly once with no setter — at construction
///         for Queue and ClaimRegistry (G-08: no runtime configuration role), in `initialize()`
///         for UnifiedPool — so an instance built against stage 1's `StubStateManager` rejects
///         every Vault registered against the real one (`enqueue` / `receiveVaultPrincipal` revert
///         `UnregisteredVault`). That is precisely what silently broke the v3 testnet generation.
///         `reinitializeStateManager` exists only to repair deployments that already shipped and
///         is deliberately not called here.
///
/// @dev    `Settlement` and `AdapterFactory` belong to this stage, not to a Vault's:
///         `Settlement(stateManager, unifiedPool, queue)` and `AdapterFactory()` take no Vault
///         argument, and one Settlement serves every Vault. Per-Vault settlement configuration —
///         binding, the operator set and the threshold — is `Settlement`'s own per-Vault state and
///         is written by `DeployVault.s.sol`.
contract DeployPlatform is DeployConfig {
    struct Inputs {
        address governor;
        address accessControl;
        address revenuePool;
        address usdt;
        address feeConfig;
    }

    address internal stateManagerAddr;
    address internal unifiedPoolAddr;
    address internal claimRegistryAddr;
    address internal navOracleAddr;
    address internal queueAddr;
    address internal liquidityBridgeAddr;
    address internal vaultFactoryAddr;
    address internal settlementAddr;
    address internal adapterFactoryAddr;

    function run() external {
        uint256 pk = _deployerKey();
        _logProfile("platform");

        Inputs memory in_ = Inputs({
            governor: vm.addr(pk),
            accessControl: _requiredAddr("HYPER_ACCESS_CONTROL"),
            revenuePool: _requiredAddr("REVENUE_POOL"),
            usdt: _requiredAddr("USDT"),
            feeConfig: _requiredAddr("PROTOCOL_FEE_CONFIG")
        });

        vm.startBroadcast(pk);
        _deploy(in_);
        vm.stopBroadcast();

        _writeOutput();
    }

    function _deploy(Inputs memory in_) internal {
        StateManager stateManager   = new StateManager(in_.accessControl);
        ClaimRegistry claimRegistry = new ClaimRegistry(address(stateManager));
        NAVOracle navOracle         = new NAVOracle(in_.governor, 2000);
        Queue queue                 = new Queue(address(stateManager));
        LiquidityBridge liqBridge   = new LiquidityBridge(in_.usdt, address(stateManager), in_.accessControl);
        unifiedPoolAddr = _deployUnifiedPool(in_.usdt, address(stateManager), in_.accessControl, in_.revenuePool);
        VaultFactory vaultFactory   = _newVaultFactory(address(stateManager), in_.feeConfig);

        stateManager.setVaultFactory(address(vaultFactory));

        // One Settlement serves every Vault. Admitting it to the pool is protocol-wide state
        // (审计反馈 V3 #1), so it happens once, here — not on every Vault deploy.
        Settlement settlement = new Settlement(address(stateManager), unifiedPoolAddr, address(queue));
        UnifiedPool(unifiedPoolAddr).setSettlementWhitelisted(address(settlement), true);

        AdapterFactory adapterFactory = new AdapterFactory();

        // Fees payable in the stable settlement token. Protocol-wide, and without it any product
        // configured with FeePaymentKind.Stable has no token to charge in.
        IProtocolFeeConfig(in_.feeConfig).setPaymentToken(FeePaymentKind.Stable, in_.usdt);

        stateManagerAddr    = address(stateManager);
        claimRegistryAddr   = address(claimRegistry);
        navOracleAddr       = address(navOracle);
        queueAddr           = address(queue);
        liquidityBridgeAddr = address(liqBridge);
        vaultFactoryAddr    = address(vaultFactory);
        settlementAddr      = address(settlement);
        adapterFactoryAddr  = address(adapterFactory);
    }

    /// @dev UUPS: implementation behind an ERC1967Proxy, initialized in one shot against the real
    ///      StateManager. Extracted from `_deploy` to stay under the stack limit.
    function _deployUnifiedPool(address usdt_, address sm_, address ac_, address revenuePool_)
        internal
        returns (address pool)
    {
        pool = address(
            new ERC1967Proxy(
                address(new UnifiedPool()), abi.encodeCall(UnifiedPool.initialize, (usdt_, sm_, ac_))
            )
        );
        // Authorise UnifiedPool to call RevenuePool.receiveFee.
        RevenuePool(payable(revenuePool_)).addAuthorizedSource(pool);
    }

    /// @dev Deployed independently (not `new`'d inside VaultFactory's own constructor) to avoid
    ///      transitively embedding EarnVault/LiquidityEarnVault's full creation bytecode into
    ///      VaultFactory's init code — see VaultFactory.sol's storage-section comment.
    function _newVaultFactory(address stateManager_, address feeConfig_) internal returns (VaultFactory) {
        EarnVaultDeployer earnDeployer = new EarnVaultDeployer();
        LiquidityEarnVaultDeployer lpDeployer = new LiquidityEarnVaultDeployer();
        return new VaultFactory(stateManager_, address(earnDeployer), address(lpDeployer), feeConfig_);
    }

    function _writeOutput() internal {
        string memory a = "addresses";
        vm.serializeAddress(a, "StateManager",    stateManagerAddr);
        vm.serializeAddress(a, "UnifiedPool",     unifiedPoolAddr);
        vm.serializeAddress(a, "ClaimRegistry",   claimRegistryAddr);
        vm.serializeAddress(a, "NAVOracle",       navOracleAddr);
        vm.serializeAddress(a, "Queue",           queueAddr);
        vm.serializeAddress(a, "LiquidityBridge", liquidityBridgeAddr);
        vm.serializeAddress(a, "VaultFactory",    vaultFactoryAddr);
        vm.serializeAddress(a, "Settlement",      settlementAddr);
        string memory addrs = vm.serializeAddress(a, "AdapterFactory", adapterFactoryAddr);

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        string memory out = vm.serializeString(root, "addresses", addrs);

        vm.writeJson(out, "./control-panel/deployments-platform.json");
    }
}
