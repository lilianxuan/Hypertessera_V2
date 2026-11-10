// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EarnVault} from "./EarnVault.sol";

/// @title EarnVaultDeployer
/// @notice Isolates EarnVault's creation bytecode in its own contract so VaultFactory's
///         own runtime bytecode stays under the EIP-170 24,576-byte contract size limit.
contract EarnVaultDeployer {
    function deploy(
        string memory name_,
        string memory symbol_,
        address usdt_,
        address stateManager_,
        address queue_,
        address owner_,
        address liquidityBridge_
    ) external returns (address) {
        return address(new EarnVault(
            name_, symbol_, usdt_, stateManager_, queue_, owner_, liquidityBridge_
        ));
    }
}
