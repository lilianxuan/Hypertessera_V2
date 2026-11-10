// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LiquidityEarnVault} from "./LiquidityEarnVault.sol";

/// @title LiquidityEarnVaultDeployer
/// @notice Isolates LiquidityEarnVault's creation bytecode in its own contract so
///         VaultFactory's own runtime bytecode stays under the EIP-170 size limit.
contract LiquidityEarnVaultDeployer {
    function deploy(
        string memory name_,
        string memory symbol_,
        address usdt_,
        address stateManager_,
        address queue_,
        address owner_,
        address liquidityBridge_,
        address cashVault_
    ) external returns (address) {
        return address(new LiquidityEarnVault(
            name_, symbol_, usdt_, stateManager_, queue_, owner_, liquidityBridge_, cashVault_
        ));
    }
}
