# NAVOracle / RWAAdapter Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vault-keyed `NAVOracle` with a standalone, token-keyed price oracle used by a
new `RWAAdapter`, and remove all now-dead vault-NAV wiring from `Types.sol`, `Deploy.s.sol`, and
the offchain SDK/Indexer/KeeperBot.

**Architecture:** `NAVOracle` becomes `mapping(rwaToken => PriceData)` with EIP-712-signed writes
and a single Oracle owner managing per-token signers — no `StateManager`/`IVaultRoles` dependency.
`RWAAdapter extends BaseAdapter`, adds immutable `rwaToken`/`navOracle`, and overrides
`realAssets()` to add `balanceOf(rwaToken) * price` (converted through decimals) on top of
`BaseAdapter`'s existing pending-deal sum. `AdapterFactory` gains a `deployRWAAdapter` entry point
mirroring `deployLiquidityAdapter`, backed by a new `RWAAdapterDeployer` bytecode-isolation
contract.

**Tech Stack:** Solidity 0.8.24, Foundry/forge-std, OpenZeppelin Contracts (`ECDSA`,
`MessageHashUtils`, `EIP712`, `Math`, `IERC20Metadata`), TypeScript/ethers v6 offchain SDK, Vitest.

## Global Constraints

- Solidity version: `pragma solidity 0.8.24;` for every new/edited `.sol` file (match existing files exactly).
- Import OpenZeppelin via the `@openzeppelin/` remapping (`@openzeppelin/=lib/openzeppelin-contracts/`), never a relative `lib/` path.
- `NAVOracle` must have **zero** dependency on `StateManager`, `IVaultRoles`, or any Vault reference (design principle, spec §"Design principles").
- `RWAAdapter` must never read or store `assetId`, and must never call `AssetRegistry` (spec §"Design principles").
- No on-chain staleness/freshness check anywhere in the new code (spec §"Design principles") — `updatedAt`/`dataTimestamp` are informational only.
- Settlement, Queue, UnifiedPool, RevenuePool, AssetRegistry stay untouched (spec §"Out of scope").
- `NAV_DEVIATION_MAX_BPS = 2000` stays a fixed contract constant — never settable per-token (spec §"Out of scope").
- Every new/rewritten contract keeps the file's existing `// SPDX-License-Identifier: MIT` header.
- Run `forge build` after every Solidity task and `forge test` (scoped to the touched test file, then the full suite at the end) before every commit — never commit on a red build.
- Run `cd offchain && npm run typecheck` after every offchain TypeScript task.
- This is an external-delivery repo with no live deployments — breaking ABI/enum-ordinal changes are made outright, not shimmed for backwards compatibility (per the spec's explicit instruction in §5).

---

## Task 1: `NAVOracle` / `INAVOracle` full rewrite — standalone, token-keyed, EIP-712

**Files:**
- Modify: `src/interfaces/INAVOracle.sol` (full rewrite, 115 lines → new interface)
- Modify: `src/asset-infrastructure/NAVOracle.sol` (full rewrite, 191 lines → new contract)
- Modify: `test/NAVOracle.t.sol` (full rewrite, 457 lines → new suite)

**Interfaces:**
- Produces: `INAVOracle.PriceData{price,dataTimestamp,updatedAt}`, `NAVOracle(address owner_)`,
  `updateNAV(address rwaToken, uint256 price, uint256 dataTimestamp, bytes calldata signature)`,
  `setSigner(address rwaToken, address signer)`, `removeSigner(address rwaToken)`,
  `transferOwnership(address newOwner)`, `getNAV(address rwaToken) view returns (uint256 price, uint256 updatedAt)`,
  `getPriceData(address rwaToken) view returns (PriceData memory)`, `signerOf(address rwaToken) view returns (address)`,
  `owner() view returns (address)`. These signatures are consumed by Task 2 (`RWAAdapter`), Task 3
  (`AdapterFactory`/deploy scripts), and Task 8 (offchain SDK).

- [ ] **Step 1: Rewrite `INAVOracle.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface INAVOracle {
    struct PriceData {
        uint256 price; // 1e18-scale: value of 1 whole rwaToken, denominated in 1 whole asset unit
        uint256 dataTimestamp; // off-chain source timestamp (not block.timestamp)
        uint256 updatedAt; // block.timestamp of last on-chain write
    }

    event NAVUpdated(
        address indexed rwaToken, uint256 price, uint256 dataTimestamp, uint256 updatedAt, address indexed signer
    );
    event SignerSet(address indexed rwaToken, address indexed signer);
    event SignerRemoved(address indexed rwaToken);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    error ZeroAddress();
    error Unauthorized();
    error UnauthorizedSigner(address recovered);
    error InvalidNAV();
    error FutureData(uint256 dataTimestamp);
    error NonMonotonicTimestamp(uint256 dataTimestamp, uint256 previous);
    error DeviationTooHigh(uint256 price, uint256 previousPrice);

    function updateNAV(address rwaToken, uint256 price, uint256 dataTimestamp, bytes calldata signature) external;

    function setSigner(address rwaToken, address signer) external;
    function removeSigner(address rwaToken) external;
    function transferOwnership(address newOwner) external;

    function getNAV(address rwaToken) external view returns (uint256 price, uint256 updatedAt);
    function getPriceData(address rwaToken) external view returns (PriceData memory);
    function signerOf(address rwaToken) external view returns (address);
    function owner() external view returns (address);
}
```

- [ ] **Step 2: Rewrite `NAVOracle.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {INAVOracle} from "../interfaces/INAVOracle.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title NAVOracle
/// @notice Standalone, token-keyed price oracle. Anyone may relay an `updateNAV` write as long as
///         it carries the registered signer's EIP-712 signature for that `rwaToken`. No Vault,
///         StateManager, or AssetRegistry dependency — RWAAdapter reads this by `rwaToken` address
///         only (NAVOracle/RWAAdapter redesign spec).
/// @dev    Downward price moves of any magnitude are accepted; only upward moves are capped at
///         `NAV_DEVIATION_MAX_BPS`. No on-chain staleness check — freshness is an off-chain concern.
contract NAVOracle is INAVOracle, EIP712 {
    using ECDSA for bytes32;

    uint16 public constant NAV_DEVIATION_MAX_BPS = 2000;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    bytes32 internal constant NAV_UPDATE_TYPEHASH =
        keccak256("NAVUpdate(address rwaToken,uint256 price,uint256 dataTimestamp)");

    address public owner;
    mapping(address rwaToken => PriceData) private _priceData;
    mapping(address rwaToken => address) private _signer;

    constructor(address owner_) EIP712("NAVOracle", "1") {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }

    function updateNAV(address rwaToken, uint256 price, uint256 dataTimestamp, bytes calldata signature)
        external
        override
    {
        if (rwaToken == address(0)) revert ZeroAddress();

        PriceData storage data = _priceData[rwaToken];

        bytes32 structHash = keccak256(abi.encode(NAV_UPDATE_TYPEHASH, rwaToken, price, dataTimestamp));
        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != _signer[rwaToken] || recovered == address(0)) revert UnauthorizedSigner(recovered);

        if (price == 0) revert InvalidNAV();
        if (dataTimestamp > block.timestamp) revert FutureData(dataTimestamp);

        if (data.dataTimestamp != 0 && dataTimestamp <= data.dataTimestamp) {
            revert NonMonotonicTimestamp(dataTimestamp, data.dataTimestamp);
        }

        if (data.price != 0 && price > data.price) {
            uint256 maxPrice = data.price * (BPS_DENOMINATOR + NAV_DEVIATION_MAX_BPS) / BPS_DENOMINATOR;
            if (price > maxPrice) revert DeviationTooHigh(price, data.price);
        }

        data.price = price;
        data.dataTimestamp = dataTimestamp;
        data.updatedAt = block.timestamp;

        emit NAVUpdated(rwaToken, price, dataTimestamp, block.timestamp, recovered);
    }

    function setSigner(address rwaToken, address signer) external override {
        _onlyOwner();
        if (rwaToken == address(0) || signer == address(0)) revert ZeroAddress();
        _signer[rwaToken] = signer;
        emit SignerSet(rwaToken, signer);
    }

    function removeSigner(address rwaToken) external override {
        _onlyOwner();
        _signer[rwaToken] = address(0);
        emit SignerRemoved(rwaToken);
    }

    function transferOwnership(address newOwner) external override {
        _onlyOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function getNAV(address rwaToken) external view override returns (uint256 price, uint256 updatedAt) {
        PriceData storage d = _priceData[rwaToken];
        return (d.price, d.updatedAt);
    }

    function getPriceData(address rwaToken) external view override returns (PriceData memory) {
        return _priceData[rwaToken];
    }

    function signerOf(address rwaToken) external view override returns (address) {
        return _signer[rwaToken];
    }
}
```

- [ ] **Step 3: Rewrite `test/NAVOracle.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {NAVOracle} from "../src/asset-infrastructure/NAVOracle.sol";
import {INAVOracle} from "../src/interfaces/INAVOracle.sol";

/// @title NAVOracle Tests
/// @notice Standalone, token-keyed oracle: single Owner manages per-rwaToken signers; updateNAV
///         is permissionless-relay, EIP-712-signed, validated for non-zero/future/monotonic/
///         upward-deviation-cap. No staleness/freshness surface, no Vault/StateManager coupling.
contract NAVOracleTest is Test {
    NAVOracle internal oracle;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer"); // permissionless relay caller
    address internal alice = makeAddr("alice"); // unprivileged
    address internal rwaToken = makeAddr("rwaToken");
    address internal rwaTokenB = makeAddr("rwaTokenB");

    uint256 internal signerPk = 0xA11CE;
    address internal signer;

    uint256 internal badPk = 0xBAD;
    address internal badSigner;

    uint256 internal constant ONE = 1e18; // price unity (1.0 asset per 1.0 rwaToken)

    bytes32 internal constant NAV_UPDATE_TYPEHASH =
        keccak256("NAVUpdate(address rwaToken,uint256 price,uint256 dataTimestamp)");

    function setUp() public {
        signer = vm.addr(signerPk);
        badSigner = vm.addr(badPk);

        oracle = new NAVOracle(owner);

        vm.prank(owner);
        oracle.setSigner(rwaToken, signer);

        vm.warp(1_000_000);
    }

    // -----------------------------------------------------------------------
    // Signing helpers — real EIP-712 domain matching NAVOracle's own.
    // -----------------------------------------------------------------------

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NAVOracle")),
                keccak256(bytes("1")),
                block.chainid,
                address(oracle)
            )
        );
    }

    function _sign(uint256 pk, address token, uint256 price, uint256 dataTimestamp)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(NAV_UPDATE_TYPEHASH, token, price, dataTimestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _push(uint256 pk, uint256 price, uint256 dataTimestamp) internal {
        bytes memory sig = _sign(pk, rwaToken, price, dataTimestamp);
        vm.prank(relayer);
        oracle.updateNAV(rwaToken, price, dataTimestamp, sig);
    }

    function _maxUp(uint256 base) internal view returns (uint256) {
        return base * (10_000 + oracle.NAV_DEVIATION_MAX_BPS()) / 10_000;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    function test_constructor_setsOwner() public view {
        assertEq(oracle.owner(), owner);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(INAVOracle.ZeroAddress.selector);
        new NAVOracle(address(0));
    }

    // -----------------------------------------------------------------------
    // Signer administration (single Oracle owner, per-token)
    // -----------------------------------------------------------------------

    function test_setSigner_ownerSucceeds() public {
        address newSigner = makeAddr("newSigner");
        vm.prank(owner);
        oracle.setSigner(rwaTokenB, newSigner);
        assertEq(oracle.signerOf(rwaTokenB), newSigner);
    }

    function test_setSigner_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(INAVOracle.Unauthorized.selector);
        oracle.setSigner(rwaToken, makeAddr("x"));
    }

    function test_setSigner_zeroSignerReverts() public {
        vm.prank(owner);
        vm.expectRevert(INAVOracle.ZeroAddress.selector);
        oracle.setSigner(rwaToken, address(0));
    }

    function test_setSigner_zeroTokenReverts() public {
        vm.prank(owner);
        vm.expectRevert(INAVOracle.ZeroAddress.selector);
        oracle.setSigner(address(0), signer);
    }

    function test_removeSigner_ownerSucceeds() public {
        vm.prank(owner);
        oracle.removeSigner(rwaToken);
        assertEq(oracle.signerOf(rwaToken), address(0));
    }

    function test_removeSigner_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(INAVOracle.Unauthorized.selector);
        oracle.removeSigner(rwaToken);
    }

    function test_removeSigner_thenUpdateReverts() public {
        vm.prank(owner);
        oracle.removeSigner(rwaToken);

        uint256 ts = block.timestamp;
        bytes memory sig = _sign(signerPk, rwaToken, ONE, ts);
        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.UnauthorizedSigner.selector);
        oracle.updateNAV(rwaToken, ONE, ts, sig);
    }

    function test_signerIsPerToken() public {
        // `signer` is authorised for `rwaToken`, not for `rwaTokenB`.
        uint256 ts = block.timestamp;
        bytes memory sig = _sign(signerPk, rwaTokenB, ONE, ts);
        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.UnauthorizedSigner.selector);
        oracle.updateNAV(rwaTokenB, ONE, ts, sig);
    }

    // -----------------------------------------------------------------------
    // transferOwnership
    // -----------------------------------------------------------------------

    function test_transferOwnership_ownerSucceeds() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        oracle.transferOwnership(newOwner);
        assertEq(oracle.owner(), newOwner);
    }

    function test_transferOwnership_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(INAVOracle.Unauthorized.selector);
        oracle.transferOwnership(alice);
    }

    function test_transferOwnership_zeroAddressReverts() public {
        vm.prank(owner);
        vm.expectRevert(INAVOracle.ZeroAddress.selector);
        oracle.transferOwnership(address(0));
    }

    // -----------------------------------------------------------------------
    // updateNAV: happy path
    // -----------------------------------------------------------------------

    function test_updateNAV_authorizedPushUpdatesPrice() public {
        uint256 price = ONE;
        uint256 ts = block.timestamp;

        bytes memory sig = _sign(signerPk, rwaToken, price, ts);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit INAVOracle.NAVUpdated(rwaToken, price, ts, block.timestamp, signer);
        vm.prank(relayer);
        oracle.updateNAV(rwaToken, price, ts, sig);

        (uint256 gotPrice, uint256 gotUpdatedAt) = oracle.getNAV(rwaToken);
        assertEq(gotPrice, price);
        assertEq(gotUpdatedAt, block.timestamp);
    }

    function test_getPriceData_returnsFullRecord() public {
        uint256 ts = block.timestamp;
        _push(signerPk, ONE, ts);

        INAVOracle.PriceData memory d = oracle.getPriceData(rwaToken);
        assertEq(d.price, ONE);
        assertEq(d.dataTimestamp, ts);
        assertEq(d.updatedAt, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // updateNAV: signer / payload / replay
    // -----------------------------------------------------------------------

    function test_updateNAV_unauthorizedSignerReverts() public {
        uint256 price = ONE;
        uint256 ts = block.timestamp;
        bytes memory sig = _sign(badPk, rwaToken, price, ts);

        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.UnauthorizedSigner.selector);
        oracle.updateNAV(rwaToken, price, ts, sig);
    }

    function test_updateNAV_tamperedPayloadReverts() public {
        uint256 price = ONE;
        uint256 ts = block.timestamp;
        bytes memory sig = _sign(signerPk, rwaToken, price, ts);

        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.UnauthorizedSigner.selector);
        oracle.updateNAV(rwaToken, price + 1, ts, sig);
    }

    /// @dev A signature valid on a different NAVOracle instance (different verifyingContract) must
    ///      not be replayable here — proves the EIP-712 domain binds to `address(oracle)`.
    function test_updateNAV_signatureFromDifferentOracleReverts() public {
        NAVOracle otherOracle = new NAVOracle(owner);
        vm.prank(owner);
        otherOracle.setSigner(rwaToken, signer);

        uint256 ts = block.timestamp;
        bytes32 structHash = keccak256(abi.encode(NAV_UPDATE_TYPEHASH, rwaToken, ONE, ts));
        bytes32 otherDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NAVOracle")),
                keccak256(bytes("1")),
                block.chainid,
                address(otherOracle)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", otherDomain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.UnauthorizedSigner.selector);
        oracle.updateNAV(rwaToken, ONE, ts, sig);
    }

    // -----------------------------------------------------------------------
    // updateNAV: deviation cap (upward only)
    // -----------------------------------------------------------------------

    function test_updateNAV_upwardDeviationBeyondCapReverts() public {
        _push(signerPk, ONE, block.timestamp);

        uint256 maxPrice = _maxUp(ONE);
        vm.warp(block.timestamp + 1);
        uint256 ts2 = block.timestamp; // monotonic, not in the future
        bytes memory sig = _sign(signerPk, rwaToken, maxPrice + 1, ts2);

        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.DeviationTooHigh.selector);
        oracle.updateNAV(rwaToken, maxPrice + 1, ts2, sig);
    }

    function test_updateNAV_upwardAtCapSucceeds() public {
        _push(signerPk, ONE, block.timestamp);
        vm.warp(block.timestamp + 1);
        uint256 maxPrice = _maxUp(ONE);
        _push(signerPk, maxPrice, block.timestamp);
        (uint256 gotPrice,) = oracle.getNAV(rwaToken);
        assertEq(gotPrice, maxPrice);
    }

    function test_updateNAV_downwardCorrectionSucceeds() public {
        _push(signerPk, 1.01e18, block.timestamp);
        vm.warp(block.timestamp + 1);
        _push(signerPk, 1.0001e18, block.timestamp);
        (uint256 gotPrice,) = oracle.getNAV(rwaToken);
        assertEq(gotPrice, 1.0001e18);
    }

    function test_updateNAV_largeDownwardDefaultLossSucceeds() public {
        _push(signerPk, 2e18, block.timestamp);
        vm.warp(block.timestamp + 1);
        _push(signerPk, 1, block.timestamp);
        (uint256 gotPrice,) = oracle.getNAV(rwaToken);
        assertEq(gotPrice, 1, "any-magnitude downward accepted");
    }

    function test_updateNAV_firstWriteSkipsDeviationCheck() public {
        // No previous price recorded yet — any magnitude is accepted on the first write.
        _push(signerPk, 1_000_000e18, block.timestamp);
        (uint256 gotPrice,) = oracle.getNAV(rwaToken);
        assertEq(gotPrice, 1_000_000e18);
    }

    // -----------------------------------------------------------------------
    // updateNAV: sanity / timestamp
    // -----------------------------------------------------------------------

    function test_updateNAV_zeroPriceReverts() public {
        uint256 ts = block.timestamp;
        bytes memory sig = _sign(signerPk, rwaToken, 0, ts);
        vm.prank(relayer);
        vm.expectRevert(INAVOracle.InvalidNAV.selector);
        oracle.updateNAV(rwaToken, 0, ts, sig);
    }

    function test_updateNAV_futureTimestampReverts() public {
        uint256 ts = block.timestamp + 1;
        bytes memory sig = _sign(signerPk, rwaToken, ONE, ts);
        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.FutureData.selector);
        oracle.updateNAV(rwaToken, ONE, ts, sig);
    }

    function test_updateNAV_nonMonotonicTimestampReverts() public {
        uint256 ts = block.timestamp;
        _push(signerPk, ONE, ts);
        bytes memory sig = _sign(signerPk, rwaToken, ONE, ts);
        vm.prank(relayer);
        vm.expectPartialRevert(INAVOracle.NonMonotonicTimestamp.selector);
        oracle.updateNAV(rwaToken, ONE, ts, sig);
    }

    function test_updateNAV_oldButMonotonicTimestampSucceeds() public {
        // No on-chain staleness check — an old-but-monotonic, non-future timestamp is accepted.
        uint256 ts = block.timestamp - 365 days;
        _push(signerPk, ONE, ts);
        (uint256 gotPrice,) = oracle.getNAV(rwaToken);
        assertEq(gotPrice, ONE);
    }

    function test_updateNAV_zeroTokenReverts() public {
        uint256 ts = block.timestamp;
        bytes memory sig = _sign(signerPk, address(0), ONE, ts);
        vm.prank(relayer);
        vm.expectRevert(INAVOracle.ZeroAddress.selector);
        oracle.updateNAV(address(0), ONE, ts, sig);
    }
}
```

- [ ] **Step 4: Build and run the NAVOracle suite**

Run: `forge build && forge test --match-path test/NAVOracle.t.sol -vv`
Expected: build succeeds, all tests in `NAVOracleTest` PASS. If `test_updateNAV_signatureFromDifferentOracleReverts` fails, double check `_domainSeparator()`'s field order matches OZ `EIP712`'s (`name, version, chainId, verifyingContract`) exactly.

- [ ] **Step 5: Commit**

```bash
git add src/interfaces/INAVOracle.sol src/asset-infrastructure/NAVOracle.sol test/NAVOracle.t.sol
git commit -m "feat: rewrite NAVOracle as standalone token-keyed EIP-712 oracle"
```

---

## Task 2: `RWAAdapter` — new contract

**Files:**
- Create: `src/asset-management/strategy/RWAAdapter.sol`
- Test: `test/RWAAdapter.t.sol`

**Interfaces:**
- Consumes: `BaseAdapter(IERC20 asset_, address vault_, uint256 defaultStalenessWindow_, string memory name_, string memory symbol_)` constructor and its `realAssets()` (returns pending-deal sum), `vault`, `dataProvider`, `pendingDeposits`, `liveDealOrderIds`, `clearDealValue(uint256)`, `updateDealData(uint256,uint256)` (all from Task-independent existing `BaseAdapter.sol`, unchanged); `INAVOracle.getNAV(address rwaToken) view returns (uint256 price, uint256 updatedAt)` from Task 1.
- Produces: `RWAAdapter(IERC20 asset_, address vault_, address rwaToken_, address navOracle_, uint256 dealDataStalenessWindow_)`, `rwaToken` and `navOracle` public immutables, `realAssets()` override, `error NAVUnavailable(address rwaToken)`. Consumed by Task 3 (`RWAAdapterDeployer`/`AdapterFactory`).

- [ ] **Step 1: Write the failing test — `test/RWAAdapter.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HyperAccessControl} from "../src/governance/HyperAccessControl.sol";
import {StateManager} from "../src/asset-management/StateManager.sol";
import {Queue} from "../src/asset-management/settlement/Queue.sol";
import {EarnVault} from "../src/asset-management/vaults/EarnVault.sol";
import {RWAAdapter} from "../src/asset-management/strategy/RWAAdapter.sol";
import {NAVOracle} from "../src/asset-infrastructure/NAVOracle.sol";
import {IAdapter} from "../src/interfaces/IAdapter.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("MockUSDT", "USDT") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Mints with a configurable decimals count, to exercise realAssets()'s decimals conversion.
contract MockRWAToken is ERC20 {
    uint8 internal immutable _decimals;
    constructor(uint8 decimals_) ERC20("Mock RWA Token", "mRWA") { _decimals = decimals_; }
    function decimals() public view override returns (uint8) { return _decimals; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract RWAAdapterTest is Test {
    HyperAccessControl internal ac;
    StateManager internal sm;
    Queue internal queue;
    EarnVault internal vault;
    MockUSDT internal usdt;
    NAVOracle internal navOracle;
    RWAAdapter internal adapter;
    MockRWAToken internal rwaToken;

    address internal governor = makeAddr("governor");
    address internal oracleOwner = makeAddr("oracleOwner");
    address internal vaultOwner = makeAddr("vaultOwner");
    address internal curator = makeAddr("curator");
    address internal allocator = makeAddr("allocator");
    address internal guardian = makeAddr("guardian");
    address internal destination = makeAddr("destination");

    uint256 internal signerPk = 0xA11CE;
    address internal signer;

    uint256 internal constant NOW = 1_000_000;
    uint256 internal constant STALENESS_WINDOW = 36 hours;

    bytes32 internal constant NAV_UPDATE_TYPEHASH =
        keccak256("NAVUpdate(address rwaToken,uint256 price,uint256 dataTimestamp)");

    function setUp() public {
        vm.warp(NOW);
        signer = vm.addr(signerPk);

        ac = new HyperAccessControl(governor);
        sm = new StateManager(address(ac));
        queue = new Queue(address(sm));
        usdt = new MockUSDT();
        rwaToken = new MockRWAToken(6); // same decimals as asset by default

        vault = new EarnVault("Test Vault", "tVLT", address(usdt), address(sm), address(queue), vaultOwner, address(0));

        vm.startPrank(vaultOwner);
        vault.setCurator(curator);
        vault.setGuardian(guardian);
        vault.setAllocator(allocator);
        vm.stopPrank();

        navOracle = new NAVOracle(oracleOwner);
        vm.prank(oracleOwner);
        navOracle.setSigner(address(rwaToken), signer);

        adapter = new RWAAdapter(usdt, address(vault), address(rwaToken), address(navOracle), STALENESS_WINDOW);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NAVOracle")),
                keccak256(bytes("1")),
                block.chainid,
                address(navOracle)
            )
        );
    }

    function _pushPrice(uint256 price, uint256 dataTimestamp) internal {
        bytes32 structHash = keccak256(abi.encode(NAV_UPDATE_TYPEHASH, address(rwaToken), price, dataTimestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        navOracle.updateNAV(address(rwaToken), price, dataTimestamp, abi.encodePacked(r, s, v));
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    function test_constructor_setsImmutables() public view {
        assertEq(adapter.rwaToken(), address(rwaToken));
        assertEq(adapter.navOracle(), address(navOracle));
        assertEq(adapter.vault(), address(vault));
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(IAdapter.ZeroAddress.selector);
        new RWAAdapter(usdt, address(vault), address(0), address(navOracle), STALENESS_WINDOW);
    }

    // -----------------------------------------------------------------------
    // realAssets — balance*price conversion
    // -----------------------------------------------------------------------

    function test_realAssets_zeroBalance_returnsZero() public view {
        assertEq(adapter.realAssets(), 0);
    }

    function test_realAssets_zeroBalance_noOracleCallNeeded() public {
        // No price ever set for rwaToken — must NOT revert when balance is zero.
        assertEq(adapter.realAssets(), 0);
    }

    function test_realAssets_sameDecimals_convertsBalanceTimesPrice() public {
        // rwaToken has 6 decimals (same as asset). price = 2e18 means 1 whole rwaToken == 2 whole asset units.
        rwaToken.mint(address(adapter), 1_000e6); // 1,000 whole rwaTokens
        _pushPrice(2e18, block.timestamp);

        assertEq(adapter.realAssets(), 2_000e6);
    }

    function test_realAssets_rwaTokenMoreDecimalsThanAsset_converts() public {
        MockRWAToken rwa18 = new MockRWAToken(18);
        vm.prank(oracleOwner);
        navOracle.setSigner(address(rwa18), signer);
        RWAAdapter adapter18 =
            new RWAAdapter(usdt, address(vault), address(rwa18), address(navOracle), STALENESS_WINDOW);

        rwa18.mint(address(adapter18), 1_000 ether); // 1,000 whole rwaTokens, 18 decimals
        bytes32 structHash = keccak256(abi.encode(NAV_UPDATE_TYPEHASH, address(rwa18), uint256(1e18), block.timestamp));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        navOracle.updateNAV(address(rwa18), 1e18, block.timestamp, abi.encodePacked(r, s, v));

        // 1,000 whole rwaTokens at price 1.0, asset has 6 decimals -> 1,000e6.
        assertEq(adapter18.realAssets(), 1_000e6);
    }

    function test_realAssets_balanceGreaterThanZero_noPriceSet_reverts() public {
        rwaToken.mint(address(adapter), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(RWAAdapter.NAVUnavailable.selector, address(rwaToken)));
        adapter.realAssets();
    }

    function test_realAssets_addsPendingDealValue() public {
        usdt.mint(address(vault), 1_000e6);
        vm.startPrank(address(vault));
        usdt.approve(address(adapter), 1_000e6);
        adapter.deposit(1_000e6, address(vault));
        vm.stopPrank();

        vm.prank(curator);
        uint256 orderId = adapter.createBuyOrder(500e6, destination, IAdapter.SettlementMode.VALUE_RETURN);
        vm.prank(allocator);
        adapter.executeBuy(orderId);

        rwaToken.mint(address(adapter), 100e6);
        _pushPrice(1e18, block.timestamp);

        // 500e6 pending (VALUE_RETURN deal, unresolved) + 100e6 token value at price 1.0.
        assertEq(adapter.realAssets(), 600e6);
    }

    function test_realAssets_clearDealValue_preventsDoubleCount() public {
        usdt.mint(address(vault), 1_000e6);
        vm.startPrank(address(vault));
        usdt.approve(address(adapter), 1_000e6);
        adapter.deposit(1_000e6, address(vault));
        vm.stopPrank();

        vm.prank(curator);
        uint256 orderId = adapter.createBuyOrder(1_000e6, address(adapter), IAdapter.SettlementMode.TOKEN_RETURN);
        vm.prank(allocator);
        adapter.executeBuy(orderId);

        // The RWA token has landed in the adapter — Allocator clears the pending-deal entry.
        rwaToken.mint(address(adapter), 1_000e6);
        vm.prank(allocator);
        adapter.clearDealValue(orderId);

        _pushPrice(1e18, block.timestamp);

        // Only the token's market value counts now — no leftover pending-deal double-count.
        assertEq(adapter.realAssets(), 1_000e6);
    }
}
```

- [ ] **Step 2: Run the test to confirm it fails to compile (RWAAdapter doesn't exist yet)**

Run: `forge build`
Expected: FAIL — `RWAAdapter.sol` not found.

- [ ] **Step 3: Write `src/asset-management/strategy/RWAAdapter.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaseAdapter} from "./BaseAdapter.sol";
import {INAVOracle} from "../../interfaces/INAVOracle.sol";

/// @title RWAAdapter
/// @notice BaseAdapter that values its RWA Token balance via a token-keyed NAVOracle price feed.
///         Never stores or reads an assetId, never calls AssetRegistry — the RWA Token may be
///         HyperTessera's own or issued by an external party (NAVOracle/RWAAdapter redesign spec).
contract RWAAdapter is BaseAdapter {
    address public immutable rwaToken;
    address public immutable navOracle;

    error NAVUnavailable(address rwaToken);

    constructor(
        IERC20 asset_,
        address vault_,
        address rwaToken_,
        address navOracle_,
        uint256 dealDataStalenessWindow_
    ) BaseAdapter(asset_, vault_, dealDataStalenessWindow_, "RWA Adapter Share", "rwaShare") {
        if (rwaToken_ == address(0) || navOracle_ == address(0)) revert ZeroAddress();
        rwaToken = rwaToken_;
        navOracle = navOracle_;
    }

    function realAssets() public view override returns (uint256) {
        uint256 pending = super.realAssets();
        uint256 balance = IERC20(rwaToken).balanceOf(address(this));
        if (balance == 0) return pending;

        (uint256 price,) = INAVOracle(navOracle).getNAV(rwaToken);
        if (price == 0) revert NAVUnavailable(rwaToken);

        return pending + _tokenValue(balance, price);
    }

    /// @dev Converts `balance` (rwaToken's own decimals) at `price` (1e18-scale, per one whole
    ///      rwaToken) into the Vault's accounting-asset smallest units.
    function _tokenValue(uint256 balance, uint256 price) internal view returns (uint256) {
        uint8 rwaDecimals = IERC20Metadata(rwaToken).decimals();
        uint8 assetDecimals = IERC20Metadata(asset()).decimals();
        // balance * price gives a value scaled by (10**rwaDecimals * 1e18); divide down to
        // 10**assetDecimals in one mulDiv to avoid intermediate overflow / precision loss.
        return Math.mulDiv(balance * price, 10 ** assetDecimals, 10 ** rwaDecimals * 1e18);
    }
}
```

- [ ] **Step 4: Run `forge build`**

Run: `forge build`
Expected: PASS — compiles cleanly. If `_tokenValue`'s `balance * price` overflows for the test's inputs, note this is expected to be safe for realistic token supplies (18-decimal token, 1e18-scale price, whole-token balances well under 2^256); do not add unnecessary overflow guards.

- [ ] **Step 5: Run the RWAAdapter suite**

Run: `forge test --match-path test/RWAAdapter.t.sol -vv`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/asset-management/strategy/RWAAdapter.sol test/RWAAdapter.t.sol
git commit -m "feat: add RWAAdapter valuing RWA token balances via NAVOracle"
```

---

## Task 3: `AdapterFactory` / `IAdapterFactory` / `AdapterDeployer` — `deployRWAAdapter`

**Files:**
- Modify: `src/interfaces/IAdapterFactory.sol`
- Modify: `src/asset-management/strategy/AdapterDeployer.sol`
- Modify: `src/asset-management/strategy/AdapterFactory.sol`
- Modify: `test/AdapterFactory.t.sol`

**Interfaces:**
- Consumes: `RWAAdapter(IERC20,address,address,address,uint256)` from Task 2.
- Produces: `IAdapterFactory.RWAAdapterParams{asset,vault,rwaToken,navOracle,dealDataStalenessWindow}`,
  `deployRWAAdapter(RWAAdapterParams calldata) external returns (address adapter)`. Consumed by
  Task 7 (`Deploy.s.sol`) and Task 8 (offchain SDK).

- [ ] **Step 1: Write the failing test section — append to `test/AdapterFactory.t.sol`**

Add this import alongside the existing ones:
```solidity
import {RWAAdapter} from "../src/asset-management/strategy/RWAAdapter.sol";
```

Add a `navOracle` field/setup and RWA test section (insert before the closing `}` of `AdapterFactoryTest`):
```solidity
    address internal navOracleStandIn = makeAddr("navOracle");
    address internal rwaTokenStandIn = makeAddr("rwaToken");

    function _rwaParams(address vault) internal view returns (IAdapterFactory.RWAAdapterParams memory) {
        return IAdapterFactory.RWAAdapterParams({
            asset: address(usdt),
            vault: vault,
            rwaToken: rwaTokenStandIn,
            navOracle: navOracleStandIn,
            dealDataStalenessWindow: 36 hours
        });
    }

    // -----------------------------------------------------------------------
    // deployRWAAdapter — permissionless
    // -----------------------------------------------------------------------

    function test_deployRWAAdapter_permissionless_anyCallerSucceeds() public {
        vm.prank(attacker);
        address adapter = factory.deployRWAAdapter(_rwaParams(cashVaultStandIn));
        assertTrue(factory.isAdapter(adapter));
    }

    function test_deployRWAAdapter_happyPath_setsImmutables() public {
        address adapter = factory.deployRWAAdapter(_rwaParams(cashVaultStandIn));

        assertTrue(factory.isAdapter(adapter));
        assertEq(RWAAdapter(adapter).rwaToken(), rwaTokenStandIn);
        assertEq(RWAAdapter(adapter).navOracle(), navOracleStandIn);
        assertEq(RWAAdapter(adapter).vault(), cashVaultStandIn);
    }

    function test_deployRWAAdapter_zeroRwaToken_reverts() public {
        IAdapterFactory.RWAAdapterParams memory params = _rwaParams(cashVaultStandIn);
        params.rwaToken = address(0);
        vm.expectRevert(IAdapterFactory.InvalidAdapterParams.selector);
        factory.deployRWAAdapter(params);
    }

    function test_deployRWAAdapter_zeroNavOracle_reverts() public {
        IAdapterFactory.RWAAdapterParams memory params = _rwaParams(cashVaultStandIn);
        params.navOracle = address(0);
        vm.expectRevert(IAdapterFactory.InvalidAdapterParams.selector);
        factory.deployRWAAdapter(params);
    }

    function test_isAdapter_trueForAllThreeTypes() public {
        address fpa = factory.deployAdapter(_params(cashVaultStandIn));
        address lqa = factory.deployLiquidityAdapter(_params(lpVaultStandIn));
        address rwa = factory.deployRWAAdapter(_rwaParams(noteVaultStandIn));

        assertTrue(factory.isAdapter(fpa));
        assertTrue(factory.isAdapter(lqa));
        assertTrue(factory.isAdapter(rwa));
    }
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `forge build`
Expected: FAIL — `IAdapterFactory.RWAAdapterParams` / `deployRWAAdapter` not found.

- [ ] **Step 3: Add `RWAAdapterParams` and `deployRWAAdapter` to `IAdapterFactory.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAdapterFactory {
    struct AdapterParams {
        address asset; // USDT
        address vault; // EarnVault this adapter serves
        uint256 stalenessWindow; // pendingDeposits staleness window; default 36h
    }

    struct RWAAdapterParams {
        address asset; // Vault's accounting asset
        address vault; // EarnVault this adapter serves, fixed at deploy
        address rwaToken; // RWA Token this adapter values, fixed at deploy
        address navOracle; // NAVOracle instance queried for rwaToken's price, fixed at deploy
        uint256 dealDataStalenessWindow; // BaseAdapter's existing pending-deal staleness window
    }

    event AdapterDeployed(address indexed adapter, address indexed vault, uint256 timestamp);

    error ZeroAddress();
    error InvalidAdapterParams();

    function deployAdapter(AdapterParams calldata params) external returns (address adapter);
    function deployLiquidityAdapter(AdapterParams calldata params) external returns (address adapter);
    function deployRWAAdapter(RWAAdapterParams calldata params) external returns (address adapter);

    function isAdapter(address adapter) external view returns (bool);
}
```

- [ ] **Step 4: Add `RWAAdapterDeployer` to `AdapterDeployer.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FirstPeriodAdapter} from "./FirstPeriodAdapter.sol";
import {LiquidityAdapter} from "./LiquidityAdapter.sol";
import {RWAAdapter} from "./RWAAdapter.sol";

/// @title FirstPeriodAdapterDeployer
/// @notice Isolates FirstPeriodAdapter's creation bytecode in its own contract so
///         AdapterFactory's own runtime bytecode stays under the EIP-170 size limit.
contract FirstPeriodAdapterDeployer {
    function deploy(address asset_, address vault_, uint256 stalenessWindow_) external returns (address) {
        return address(new FirstPeriodAdapter(IERC20(asset_), vault_, stalenessWindow_));
    }
}

/// @title LiquidityAdapterDeployer
/// @notice Isolates LiquidityAdapter's creation bytecode in its own contract so
///         AdapterFactory's own runtime bytecode stays under the EIP-170 size limit.
contract LiquidityAdapterDeployer {
    function deploy(address asset_, address vault_, uint256 stalenessWindow_) external returns (address) {
        return address(new LiquidityAdapter(IERC20(asset_), vault_, stalenessWindow_));
    }
}

/// @title RWAAdapterDeployer
/// @notice Isolates RWAAdapter's creation bytecode in its own contract so AdapterFactory's own
///         runtime bytecode stays under the EIP-170 size limit.
contract RWAAdapterDeployer {
    function deploy(address asset_, address vault_, address rwaToken_, address navOracle_, uint256 stalenessWindow_)
        external
        returns (address)
    {
        return address(new RWAAdapter(IERC20(asset_), vault_, rwaToken_, navOracle_, stalenessWindow_));
    }
}
```

- [ ] **Step 5: Wire `deployRWAAdapter` into `AdapterFactory.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAdapterFactory} from "../../interfaces/IAdapterFactory.sol";
import {FirstPeriodAdapterDeployer, LiquidityAdapterDeployer, RWAAdapterDeployer} from "./AdapterDeployer.sol";

contract AdapterFactory is IAdapterFactory {
    mapping(address adapter => bool) public override isAdapter;

    FirstPeriodAdapterDeployer public immutable fpaDeployer;
    LiquidityAdapterDeployer public immutable lqaDeployer;
    RWAAdapterDeployer public immutable rwaDeployer;

    constructor() {
        fpaDeployer = new FirstPeriodAdapterDeployer();
        lqaDeployer = new LiquidityAdapterDeployer();
        rwaDeployer = new RWAAdapterDeployer();
    }

    function _validateParams(AdapterParams calldata params) internal pure {
        if (params.asset == address(0) || params.vault == address(0)) {
            revert InvalidAdapterParams();
        }
    }

    function _validateRWAParams(RWAAdapterParams calldata params) internal pure {
        if (
            params.asset == address(0) || params.vault == address(0) || params.rwaToken == address(0)
                || params.navOracle == address(0)
        ) {
            revert InvalidAdapterParams();
        }
    }

    function deployAdapter(AdapterParams calldata params) external override returns (address adapter) {
        _validateParams(params);
        adapter = fpaDeployer.deploy(params.asset, params.vault, params.stalenessWindow);
        isAdapter[adapter] = true;
        emit AdapterDeployed(adapter, params.vault, block.timestamp);
    }

    function deployLiquidityAdapter(AdapterParams calldata params) external override returns (address adapter) {
        _validateParams(params);
        adapter = lqaDeployer.deploy(params.asset, params.vault, params.stalenessWindow);
        isAdapter[adapter] = true;
        emit AdapterDeployed(adapter, params.vault, block.timestamp);
    }

    function deployRWAAdapter(RWAAdapterParams calldata params) external override returns (address adapter) {
        _validateRWAParams(params);
        adapter = rwaDeployer.deploy(
            params.asset, params.vault, params.rwaToken, params.navOracle, params.dealDataStalenessWindow
        );
        isAdapter[adapter] = true;
        emit AdapterDeployed(adapter, params.vault, block.timestamp);
    }
}
```

- [ ] **Step 6: Build and run**

Run: `forge build && forge test --match-path test/AdapterFactory.t.sol -vv`
Expected: PASS. If `AdapterFactory`'s runtime bytecode now exceeds EIP-170 (24576 bytes), confirm `forge build` reports no size-limit error — the deployer-isolation pattern exists specifically to avoid this; if it does trip, double-check `RWAAdapter`'s creation bytecode isn't accidentally imported into `AdapterFactory.sol` itself.

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/IAdapterFactory.sol src/asset-management/strategy/AdapterDeployer.sol src/asset-management/strategy/AdapterFactory.sol test/AdapterFactory.t.sol
git commit -m "feat: add AdapterFactory.deployRWAAdapter"
```

---

## Task 4: `Types.sol` cleanup — delete `navToleranceBps` and `ModuleId.NAV_ORACLE`

**Files:**
- Modify: `src/libs/Types.sol`
- Modify: `test/LiquidityEarnVault.t.sol:156-170`
- Modify: `test/StateManager.t.sol:71-84,684-693`
- Modify: `test/Settlement.t.sol:107-121`
- Modify: `test/EarnVault.t.sol:889-903`
- Modify: `offchain/test/deployStack.ts:207-221`
- Modify: `offchain/scripts/local/runTestPlan.ts:50-63`
- Modify: `offchain/src/types.ts:26-37`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProductParams` with 10 fields (was 11, `navToleranceBps` removed); `ModuleId` enum with
  8 members (was 9, `NAV_ORACLE` removed, all later members' ordinals shift down by one).

- [ ] **Step 1: Remove `navToleranceBps` from `ProductParams` and `NAV_ORACLE` from `ModuleId` in `src/libs/Types.sol`**

In the `ModuleId` enum, remove the `NAV_ORACLE,` line:
```solidity
enum ModuleId {
    CASH_VAULT,
    NOTE_VAULT,
    LP_VAULT,
    SETTLEMENT,
    PSM_POOL,
    TOKENIZATION,
    REWARD,
    CLAIM_REGISTRY
}
```

In the `ProductParams` struct, remove the trailing `uint256 navToleranceBps;` line:
```solidity
struct ProductParams {
    uint256 subscriptionStart;
    uint256 subscriptionEnd;
    uint256 subscriptionCap;        // total raise cap in USDT (6-dec)
    uint256 walletSubscriptionCap;  // per-wallet cap in USDT (6-dec)
    uint256 minRaiseAmount;
    uint256 firstCycleStart;
    uint256 cycleDuration;          // seconds; e.g. 7 days or 365 days
    uint256 maturityTimestamp;
    uint256 claimingStart;
    uint256 feeParams;              // encoded fee parameters (reserved)
}
```

- [ ] **Step 2: Fix `test/LiquidityEarnVault.t.sol`, `test/StateManager.t.sol`, `test/Settlement.t.sol`, `test/EarnVault.t.sol` — remove `navToleranceBps` field from every `ProductParams({...})` literal**

In each of the four files, remove the trailing `,` from the `feeParams:` line and delete the
`navToleranceBps:` line immediately after it. Example (`test/LiquidityEarnVault.t.sol:167-168`,
same shape in the other three files, only indentation/whitespace differs):

Before:
```solidity
            feeParams:            0,
            navToleranceBps:      500
```
After:
```solidity
            feeParams:            0
```

- [ ] **Step 3: Fix `test/StateManager.t.sol` — swap the two generic module-pause tests off the deleted `NAV_ORACLE` member**

At `test/StateManager.t.sol:684-693`:

Before:
```solidity
    function test_modulePaused_default_false() public view {
        assertFalse(sm.modulePaused(ModuleId.NAV_ORACLE));
    }

    function test_pauseModule_unpauseModule() public {
        vm.prank(governor); sm.pauseModule(ModuleId.NAV_ORACLE);
        assertTrue(sm.modulePaused(ModuleId.NAV_ORACLE));
        vm.prank(governor); sm.unpauseModule(ModuleId.NAV_ORACLE);
        assertFalse(sm.modulePaused(ModuleId.NAV_ORACLE));
    }
```
After:
```solidity
    function test_modulePaused_default_false() public view {
        assertFalse(sm.modulePaused(ModuleId.PSM_POOL));
    }

    function test_pauseModule_unpauseModule() public {
        vm.prank(governor); sm.pauseModule(ModuleId.PSM_POOL);
        assertTrue(sm.modulePaused(ModuleId.PSM_POOL));
        vm.prank(governor); sm.unpauseModule(ModuleId.PSM_POOL);
        assertFalse(sm.modulePaused(ModuleId.PSM_POOL));
    }
```

- [ ] **Step 4: Build and run the full Solidity suite**

Run: `forge build && forge test`
Expected: build succeeds; every test file compiles and passes. Grep to confirm no stragglers:
`grep -rn "navToleranceBps\|ModuleId.NAV_ORACLE\|ModuleId\.NAV_ORACLE" src/ test/` must return nothing.

- [ ] **Step 5: Mirror the `ModuleId` ordinal shift in `offchain/src/types.ts`**

At `offchain/src/types.ts:26-37`:

Before:
```typescript
export enum ModuleId {
  CASH_VAULT = 0,
  NOTE_VAULT = 1,
  LP_VAULT = 2,
  SETTLEMENT = 3,
  NAV_ORACLE = 4,
  PSM_POOL = 5,
  TOKENIZATION = 6,
  REWARD = 7,
  CLAIM_REGISTRY = 8,
}
```
After:
```typescript
export enum ModuleId {
  CASH_VAULT = 0,
  NOTE_VAULT = 1,
  LP_VAULT = 2,
  SETTLEMENT = 3,
  PSM_POOL = 4,
  TOKENIZATION = 5,
  REWARD = 6,
  CLAIM_REGISTRY = 7,
}
```

- [ ] **Step 6: Remove `navToleranceBps` from the two offchain object literals**

At `offchain/test/deployStack.ts:219-220`, delete the `navToleranceBps: 500,` line (keep
`feeParams: 0,`). At `offchain/scripts/local/runTestPlan.ts:61-62`, delete the
`navToleranceBps: 500,` line (keep `feeParams: 0,`).

- [ ] **Step 7: Typecheck offchain**

Run: `cd offchain && npm run typecheck`
Expected: PASS with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/libs/Types.sol test/LiquidityEarnVault.t.sol test/StateManager.t.sol test/Settlement.t.sol test/EarnVault.t.sol offchain/src/types.ts offchain/test/deployStack.ts offchain/scripts/local/runTestPlan.ts
git commit -m "chore: delete dead navToleranceBps field and ModuleId.NAV_ORACLE"
```

---

## Task 5: `VaultTimelock.sol` — fix stale doc comment

**Files:**
- Modify: `src/governance/VaultTimelock.sol:61-67`

**Interfaces:** none (comment-only, no logic change).

- [ ] **Step 1: Edit the comment**

Before (`src/governance/VaultTimelock.sol:61-67`):
```solidity
    /// @param vault_ The Vault this Timelock is permanently bound to.
    /// @dev    Pre-seeds the whitelist for the fixed set of BaseVault/self targets known at deploy
    ///         time (角色权限与职责修改方案 §6.4). Adapter-specific and NAVOracle targets are not
    ///         known yet at this point — the Vault Owner whitelists those directly while the Vault
    ///         is still CONFIGURING (see `setAllowedAction`), mirroring the same
    ///         direct-during-CONFIGURING / Timelock-gated-after pattern used throughout the rest of
    ///         the Vault's own parameter surface.
    constructor(address vault_) {
```
After:
```solidity
    /// @param vault_ The Vault this Timelock is permanently bound to.
    /// @dev    Pre-seeds the whitelist for the fixed set of BaseVault/self targets known at deploy
    ///         time (角色权限与职责修改方案 §6.4). Adapter-specific targets are not known yet at this
    ///         point — the Vault Owner whitelists those directly while the Vault is still
    ///         CONFIGURING (see `setAllowedAction`), mirroring the same direct-during-CONFIGURING /
    ///         Timelock-gated-after pattern used throughout the rest of the Vault's own parameter
    ///         surface. NAVOracle is no longer Vault-governed at all (NAVOracle/RWAAdapter redesign).
    constructor(address vault_) {
```

- [ ] **Step 2: Build**

Run: `forge build`
Expected: PASS (comment-only change, no behavioral effect).

- [ ] **Step 3: Commit**

```bash
git add src/governance/VaultTimelock.sol
git commit -m "docs: fix stale NAVOracle whitelisting comment in VaultTimelock"
```

---

## Task 6: `script/Deploy.s.sol` — new `NAVOracle` constructor, delete `DemoNAVConsumer`/`_wireNAV`, add RWAAdapter demo wiring

**Files:**
- Modify: `script/Deploy.s.sol`
- Modify: `test/DeployW4.t.sol`

**Interfaces:**
- Consumes: `NAVOracle(address owner_)`, `NAVOracle.setSigner(address,address)` from Task 1;
  `IAdapterFactory.deployRWAAdapter(RWAAdapterParams)` from Task 3.

- [ ] **Step 1: `Deploy.run()` — change the `NAVOracle` constructor call, delete `DemoNAVConsumer`, add RWAAdapter demo wiring**

Delete the `DemoNAVConsumer` contract entirely (currently at the top of `script/Deploy.s.sol`,
just above `contract Deploy is Script`):
```solidity
/// @notice Minimal placeholder address used as a demo "vault" so NAVOracle.updateNAV is
///         exercisable. Testing scaffold only — real vaults arrive in W3. Implements just enough
///         of IVaultRoles (owner()) for NAVOracle's Owner-gated addAuthorizedSigner to accept it.
contract DemoNAVConsumer {
    address public owner;
    constructor(address owner_) { owner = owner_; }
}
```

Delete the `DemoNAVConsumer internal demoVault;` field declaration.

Add an `address internal rwaAdapter;` field declaration alongside the existing `sToken`/`jToken`
fields, and add an `AdapterFactory internal adapterFactory;` field declaration.

Change the constructor call site:
```solidity
nav = new NAVOracle(address(stub));
```
to:
```solidity
nav = new NAVOracle(governor);
```
(`governor` is already set earlier in `run()` via `governor = vm.addr(pk);`, before this line.)

Delete the line `demoVault = new DemoNAVConsumer(governor);`.

Immediately after the existing `psm.deployWrappedToken(...)` line and before `_grantDemoRoles();`,
add the RWAAdapter demo deployment (uses the existing `sToken` demo `RWAToken` as the stand-in RWA
Token, per spec §8):
```solidity
        // Local-devnet demo of the new RWA valuation path: sToken (already deployed above via
        // registerAsset) stands in for an externally-issued RWA Token.
        adapterFactory = new AdapterFactory();
        rwaAdapter = adapterFactory.deployRWAAdapter(
            IAdapterFactory.RWAAdapterParams({
                asset: address(usdt),
                vault: address(demoVaultPlaceholder()),
                rwaToken: sToken,
                navOracle: address(nav),
                dealDataStalenessWindow: 36 hours
            })
        );
```

This references a `vault` field the RWAAdapter needs even though no real Vault exists yet at this
deploy stage (`Deploy.run()` predates W3's real vaults). Since `RWAAdapter`'s `vault` immutable is
only read by `BaseAdapter`'s Curator/Allocator/Guardian gating (never called in this demo-only
step) and must be non-zero, reuse `governor` as the placeholder vault address — replace the
`demoVaultPlaceholder()` call above with `governor` directly:
```solidity
                vault: governor,
```
(Delete the `demoVaultPlaceholder()` line — it was a placeholder for exposition only, not real code; use `governor` inline as shown.)

Add the required imports at the top of `script/Deploy.s.sol` alongside the existing
`NAVOracle`/`IAdapter` imports:
```solidity
import {AdapterFactory} from "../src/asset-management/strategy/AdapterFactory.sol";
import {IAdapterFactory} from "../src/interfaces/IAdapterFactory.sol";
```

- [ ] **Step 2: `_grantDemoRoles()` — replace `nav.addAuthorizedSigner` with `nav.setSigner`**

Before:
```solidity
    function _grantDemoRoles() internal {
        address tokenAgent = block.chainid == 31337 ? ANVIL_4 : governor;
        address navSigner = block.chainid == 31337 ? ANVIL_5 : governor;

        mbc.setTokenAgent(1, tokenAgent);
        mbc.setTokenAgent(2, tokenAgent);
        nav.addAuthorizedSigner(address(demoVault), navSigner);
    }
```
After:
```solidity
    function _grantDemoRoles() internal {
        address tokenAgent = block.chainid == 31337 ? ANVIL_4 : governor;
        address navSigner = block.chainid == 31337 ? ANVIL_5 : governor;

        mbc.setTokenAgent(1, tokenAgent);
        mbc.setTokenAgent(2, tokenAgent);
        nav.setSigner(sToken, navSigner);
    }
```

- [ ] **Step 3: `_writeDeployments()` — drop the `navVault` key, add `RWAAdapter`**

Before:
```solidity
        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "navVault", address(demoVault));
        vm.serializeString(root, "addresses", addrs);
        string memory out = vm.serializeString(root, "roles", roles);
```
After:
```solidity
        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "addresses", addrs);
        string memory out = vm.serializeString(root, "roles", roles);
```
And add `vm.serializeAddress(a, "RWAAdapter", rwaAdapter);` alongside the other `vm.serializeAddress(a, ...)` calls in `_writeDeployments()` (before the `addrs` variable's final `vm.serializeAddress` call that captures the return value — insert it as one more line before that one, since `vm.serializeAddress` returns the accumulated JSON string only on its last call in the chain for a given namespace).

- [ ] **Step 4: `DeployW3._deploy` — change constructor call, delete `_wireNAV`**

Before:
```solidity
        NAVOracle navOracle          = new NAVOracle(address(stateManager));
```
After:
```solidity
        NAVOracle navOracle          = new NAVOracle(governor);
```

Delete the call site `_wireNAV(address(navOracle), governor, cashVault, noteVault, lpVault);` and
delete the `_wireNAV` function definition entirely:
```solidity
    function _wireNAV(address navOracleAddr, address dataProvider, address cv, address nv, address lv) internal {
        NAVOracle nav = NAVOracle(navOracleAddr);
        nav.addAuthorizedSigner(cv, dataProvider);
        nav.addAuthorizedSigner(nv, dataProvider);
        nav.addAuthorizedSigner(lv, dataProvider);
        nav.bootstrapNavTolerance(cv, 500);
        nav.bootstrapNavTolerance(nv, 500);
        nav.bootstrapNavTolerance(lv, 500);
    }
```

- [ ] **Step 5: Build**

Run: `forge build`
Expected: PASS.

- [ ] **Step 6: Fix `test/DeployW4.t.sol`'s now-broken NAVOracle wiring**

At `test/DeployW4.t.sol:79`, change:
```solidity
        navOracle = new NAVOracle(address(sm));
```
to:
```solidity
        navOracle = new NAVOracle(governor);
```

At `test/DeployW4.t.sol:158-163`, delete the vault-keyed wiring block entirely (NAVOracle is no
longer wired to Vaults):
```solidity
        navOracle.addAuthorizedSigner(cashVault, governor);
        navOracle.addAuthorizedSigner(noteVault, governor);
        navOracle.addAuthorizedSigner(lpVault, governor);
        navOracle.bootstrapNavTolerance(cashVault, 500);
        navOracle.bootstrapNavTolerance(noteVault, 500);
        navOracle.bootstrapNavTolerance(lpVault, 500);
```

At `test/DeployW4.t.sol:234-237`, delete the now-meaningless test entirely:
```solidity
    function test_navOracle_hasAuthorizedSignerForEachVault() public view {
        assertEq(navOracle.authorizedSigner(cashVault), governor);
        assertEq(navOracle.authorizedSigner(noteVault), governor);
        assertEq(navOracle.authorizedSigner(lpVault), governor);
    }
```

- [ ] **Step 7: Run the full Solidity suite**

Run: `forge build && forge test`
Expected: build succeeds, all tests pass, including `test/DeployW4.t.sol` and a local dry run of
the deploy scripts:
`forge script script/Deploy.s.sol --tc Deploy --rpc-url http://localhost:8545` against a running
`anvil` instance (start one with `anvil &` first if not already running) — confirms `Deploy.run()`
executes end-to-end without reverting.

- [ ] **Step 8: Commit**

```bash
git add script/Deploy.s.sol test/DeployW4.t.sol
git commit -m "feat: rewire Deploy.s.sol for standalone NAVOracle and RWAAdapter demo"
```

---

## Task 7: Offchain SDK/types/ABIs — `PriceData`, token-keyed NAV methods, `RWAAdapter` accessors

**Files:**
- Modify: `offchain/src/types.ts`
- Modify: `offchain/src/sdk.ts`
- Modify: `offchain/src/abis.ts`
- Modify: `control-panel/build-abis.sh`

**Interfaces:**
- Consumes: `NAVOracle`/`RWAAdapter` ABIs (regenerated from Task 1–3's Solidity), `AdapterFactory.deployRWAAdapter` from Task 3.
- Produces: `PriceData` type, `sdk.getNAV(rwaToken)`, `sdk.updateNAV(rwaToken,...)`,
  `sdk.signNAVUpdate(...)`, `sdk.rwaAdapter(address)`, `sdk.deployRWAAdapter(params, signer)`.
  Consumed by Task 8 (indexer) and Task 9 (integration tests).

- [ ] **Step 1: Replace `NAVData` with `PriceData` in `offchain/src/types.ts`**

Before (`offchain/src/types.ts:73-77`):
```typescript
export interface NAVData {
  nav: bigint; // 6-decimal; 1_000_000n = 1.0
  dataTimestamp: bigint;
  updatedAt: bigint;
}
```
After:
```typescript
export interface PriceData {
  price: bigint; // 1e18-scale: value of 1 whole rwaToken, denominated in 1 whole asset unit
  dataTimestamp: bigint;
  updatedAt: bigint;
}
```

- [ ] **Step 2: Add `"RWAAdapter"` to `ContractName` in `offchain/src/abis.ts`**

Before:
```typescript
  | "AdapterFactory"
  | "FirstPeriodAdapter"
  | "LiquidityAdapter";
```
After:
```typescript
  | "AdapterFactory"
  | "FirstPeriodAdapter"
  | "LiquidityAdapter"
  | "RWAAdapter";
```

- [ ] **Step 3: Add `"RWAAdapter"` to `control-panel/build-abis.sh`'s `CONTRACTS` array**

Before:
```bash
CONTRACTS=(HyperAccessControl VaultTimelock AdapterRegistry AssetRegistry RWAToken NAVOracle MintBurnController StubStateManager PoRRegistry ClaimRegistry ReservePSM WrappedAsset Queue RevenuePool UnifiedPool StateManager EarnVault LiquidityEarnVault LiquidityBridge VaultFactory Settlement AdapterFactory FirstPeriodAdapter LiquidityAdapter)
```
After:
```bash
CONTRACTS=(HyperAccessControl VaultTimelock AdapterRegistry AssetRegistry RWAToken NAVOracle MintBurnController StubStateManager PoRRegistry ClaimRegistry ReservePSM WrappedAsset Queue RevenuePool UnifiedPool StateManager EarnVault LiquidityEarnVault LiquidityBridge VaultFactory Settlement AdapterFactory FirstPeriodAdapter LiquidityAdapter RWAAdapter)
```

- [ ] **Step 4: Regenerate `control-panel/abis.json`/`abis.js`**

Run: `bash control-panel/build-abis.sh`
Expected: script exits 0 and prints a contract count one higher than before; `git diff --stat control-panel/abis.json control-panel/abis.js` shows both files changed.

- [ ] **Step 5: Update `offchain/src/sdk.ts`'s NAV methods to be token-keyed**

Add `rwaAdapter?: Address;` to the `HyperTesseraAddresses` interface, alongside the existing
`cashAdapter`/`noteAdapter`/`lpAdapter` fields (optional since not every deployment has one).

Replace `getNAV` (previously `offchain/src/sdk.ts:172-175`):
```typescript
async getNAV(rwaToken: Address): Promise<PriceData> {
  const raw = await this.navOracle.getPriceData(rwaToken);
  return { price: BigInt(raw.price), dataTimestamp: BigInt(raw.dataTimestamp), updatedAt: BigInt(raw.updatedAt) };
}
```

Delete `isNAVFresh` entirely (previously `offchain/src/sdk.ts:177-179`):
```typescript
async isNAVFresh(vault: Address): Promise<boolean> {
  return this.navOracle.isNAVFresh(vault);
}
```

Replace `updateNAV` (previously `offchain/src/sdk.ts:235-239`):
```typescript
/** NAV signing service uses this. */
async updateNAV(rwaToken: Address, price: bigint, dataTimestamp: bigint, sig: Hex, signer: Signer) {
  const tx = await this.navOracle.connect(signer).getFunction("updateNAV")(rwaToken, price, dataTimestamp, sig);
  return tx.wait();
}
```

Add a new EIP-712 signing helper near `updateNAV`:
```typescript
/** Off-chain NAV signing service uses this to produce the `sig` argument for `updateNAV`. */
async signNAVUpdate(rwaToken: Address, price: bigint, dataTimestamp: bigint, signer: Signer): Promise<Hex> {
  const domain = {
    name: "NAVOracle",
    version: "1",
    chainId: (await signer.provider!.getNetwork()).chainId,
    verifyingContract: await this.navOracle.getAddress(),
  };
  const types = {
    NAVUpdate: [
      { name: "rwaToken", type: "address" },
      { name: "price", type: "uint256" },
      { name: "dataTimestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, { rwaToken, price, dataTimestamp }) as unknown as Promise<Hex>;
}
```
(`signTypedData` is ethers v6's `Signer` method — confirm the concrete `Signer` implementations
used elsewhere in this file already support it; if the codebase's `Signer` type doesn't expose
`signTypedData` directly, cast through `TypedDataSigner`-compatible usage matching how other
ethers v6 signers in this repo are constructed — check `offchain/scripts/local/wallets.ts`'s
`deriveWallet` return type, which is an ethers `Wallet`, and `Wallet` implements `signTypedData`
natively, so no additional cast is needed.)

Add an `rwaAdapter` getter alongside the other module getters (near `navOracle`'s getter):
```typescript
get rwaAdapter(): Contract {
  return this.getContract("RWAAdapter", this.addresses.rwaAdapter!);
}
```

Add a `deployRWAAdapter` write method alongside other factory write methods:
```typescript
async deployRWAAdapter(
  params: { asset: Address; vault: Address; rwaToken: Address; navOracle: Address; dealDataStalenessWindow: bigint },
  signer: Signer,
): Promise<Address> {
  const tx = await this.adapterFactory.connect(signer).getFunction("deployRWAAdapter")(params);
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l: any) => { try { return this.adapterFactory.interface.parseLog(l); } catch { return null; } })
    .find((parsed: any) => parsed?.name === "AdapterDeployed");
  return log.args.adapter as Address;
}
```
(Mirror whatever pattern `deployAdapter`/`deployLiquidityAdapter` already use in this file for
extracting the deployed address from the `AdapterDeployed` event — if those methods already have a
shared helper for this, reuse it instead of duplicating the `receipt.logs.map(...).find(...)`
inline; check the surrounding ~30 lines of `sdk.ts` around the existing adapter-deploy methods
before finalizing this step.)

- [ ] **Step 6: Typecheck**

Run: `cd offchain && npm run typecheck`
Expected: PASS. Fix any remaining `NAVData` references reported by the compiler (search
`grep -rn "NAVData" offchain/src offchain/test offchain/scripts` — every hit must now read
`PriceData`).

- [ ] **Step 7: Commit**

```bash
git add offchain/src/types.ts offchain/src/sdk.ts offchain/src/abis.ts control-panel/build-abis.sh control-panel/abis.json control-panel/abis.js
git commit -m "feat: token-key the offchain NAV SDK surface and add RWAAdapter accessors"
```

---

## Task 8: `offchain/src/keeperBot.ts` — remove NAV-staleness alerting

**Files:**
- Modify: `offchain/src/keeperBot.ts`
- Modify: `offchain/test/keeperBot.integration.test.ts`

**Interfaces:** removes `checkNavFreshness`, the `"nav-stale"` `KeeperAlertType` member, and its
`tick()` call site. No replacement.

- [ ] **Step 1: Remove `"nav-stale"` from `KeeperAlertType`**

Before (`offchain/src/keeperBot.ts:5`):
```typescript
export type KeeperAlertType = "nav-stale" | "transition-error";
```
After:
```typescript
export type KeeperAlertType = "transition-error";
```

- [ ] **Step 2: Delete `checkNavFreshness` and its call site**

Delete the method (`offchain/src/keeperBot.ts:136-141`):
```typescript
private async checkNavFreshness(vault: Address): Promise<void> {
  const fresh = await this.sdk.isNAVFresh(vault);
  if (!fresh) {
    this.alert({ type: "nav-stale", vault, message: `NAV for vault ${vault} is stale (> 36h since last update)` });
  }
}
```

Update `tick()` (`offchain/src/keeperBot.ts:144-149`):
```typescript
async tick(): Promise<void> {
  for (const vault of this.options.vaults) {
    await this.driveVault(vault);
  }
}
```

- [ ] **Step 3: Remove the nav-staleness test case from `offchain/test/keeperBot.integration.test.ts`**

Delete the test at line 49 (`it("tick() raises a nav-stale alert once the 36h freshness window elapses", ...)`)
and its full body (through the matching closing `});`), and remove the setup comment at lines
30-31 referencing `checkNavFreshness`/nav staleness that no longer applies.

- [ ] **Step 4: Typecheck and run unit tests**

Run: `cd offchain && npm run typecheck && npm test`
Expected: PASS. (`npm test` excludes `*.integration.test.ts` per `package.json`'s script — the
integration suite itself is exercised in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add offchain/src/keeperBot.ts offchain/test/keeperBot.integration.test.ts
git commit -m "chore: remove NAV-staleness alerting from keeperBot"
```

---

## Task 9: `offchain/src/indexer.ts` — `navByVault` → `navByToken`

**Files:**
- Modify: `offchain/src/indexer.ts`

**Interfaces:** renames `NAVRecord` map key from vault to rwaToken; `onNAVUpdated(rwaToken, price,
dataTimestamp, updatedAt)`; `getLatestNAV(rwaToken)`.

- [ ] **Step 1: Rename the field, handler signature, and accessor**

Before (`offchain/src/indexer.ts:44-48`):
```typescript
export interface NAVRecord {
  nav: bigint;
  dataTimestamp: bigint;
  updatedAt: number; // block timestamp of the update, seconds
}
```
After:
```typescript
export interface NAVRecord {
  price: bigint;
  dataTimestamp: bigint;
  updatedAt: number; // block timestamp of the update, seconds
}
```

Before (line 55): `private readonly navByVault = new Map<Address, NAVRecord>();`
After: `private readonly navByToken = new Map<Address, NAVRecord>();`

Before (`offchain/src/indexer.ts:156-158`):
```typescript
private onNAVUpdated(vault: Address, nav: bigint, dataTimestamp: bigint, updatedAt: number) {
  this.navByVault.set(vault, { nav, dataTimestamp, updatedAt });
}
```
After:
```typescript
private onNAVUpdated(rwaToken: Address, price: bigint, dataTimestamp: bigint, updatedAt: number) {
  this.navByToken.set(rwaToken, { price, dataTimestamp, updatedAt });
}
```

Before (`offchain/src/indexer.ts:311-313`):
```typescript
/** Last indexed NAV reading for `vault`, or undefined if none has been backfilled/observed yet. */
getLatestNAV(vault: Address): NAVRecord | undefined {
  return this.navByVault.get(vault);
}
```
After:
```typescript
/** Last indexed NAV reading for `rwaToken`, or undefined if none has been backfilled/observed yet. */
getLatestNAV(rwaToken: Address): NAVRecord | undefined {
  return this.navByToken.get(rwaToken);
}
```

- [ ] **Step 2: Update the backfill and live-subscription wiring call sites**

At the two locations that wire `onNAVUpdated` to the `NAVUpdated` event (backfill ~line 232-236,
live subscription ~line 275-278), confirm the event argument order still matches the new
`(rwaToken, price, dataTimestamp, updatedAt)` signature — `NAVOracle`'s `NAVUpdated` event (Task 1)
is `event NAVUpdated(address indexed rwaToken, uint256 price, uint256 dataTimestamp, uint256
updatedAt, address indexed signer)`, so the handler wiring must destructure/pass exactly those
first four positional args (ignoring the trailing `signer`), matching ethers v6's event-listener
argument convention already used at these two call sites — no structural change needed beyond the
renamed parameter names from Step 1 if the wiring passes positional args through unchanged.

- [ ] **Step 3: Typecheck**

Run: `cd offchain && npm run typecheck`
Expected: PASS. Grep to confirm no stragglers: `grep -rn "navByVault\|NAVRecord" offchain/src offchain/test` — any remaining `.nav` field access (vs. `.price`) on a `NAVRecord` must be updated.

- [ ] **Step 4: Commit**

```bash
git add offchain/src/indexer.ts
git commit -m "refactor: rename indexer's navByVault to navByToken"
```

---

## Task 10: Offchain integration tests — update for renamed NAV surface

**Files:**
- Modify: `offchain/test/deployStack.ts:94,148-151,236`
- Modify: `offchain/test/indexer.integration.test.ts`
- Modify: `offchain/test/e2e.integration.test.ts`

**Interfaces:** consumes Task 1's `NAVOracle(owner)`/`setSigner`/`updateNAV` and Task 7's
`sdk.getNAV`/`sdk.updateNAV`/`sdk.signNAVUpdate`.

- [ ] **Step 1: Fix `deployStack.ts`'s NAVOracle deployment and wiring**

Before (`offchain/test/deployStack.ts:94`):
```typescript
const navOracle = await deploy("NAVOracle", governor, await ac.getAddress(), await sm.getAddress());
```
After:
```typescript
const navOracle = await deploy("NAVOracle", governor, governorAddr);
```
(`governorAddr` must already be in scope in this function — check the parameter/variable named
`governorAddr` used elsewhere in this same function for the exact identifier; if the file uses
`await governor.getAddress()` inline instead, use that same expression here for consistency.)

Before (`offchain/test/deployStack.ts:148-151`):
```typescript
for (const v of [cashVault, noteVault, lpVault]) {
  await (await (navOracle as any).connect(governor).addAuthorizedSigner(v, governorAddr)).wait();
  await (await (navOracle as any).connect(governor).bootstrapNavTolerance(v, 500)).wait();
}
```
After — delete this block entirely (NAVOracle is no longer vault-wired; nothing needs to replace
it here since this harness doesn't deploy a demo RWA Token/RWAAdapter and none of the three
integration test files this harness serves call `updateNAV` against a vault-keyed signer anymore
after Step 2/3 below rewrite them to use a token address instead).

Before (`offchain/test/deployStack.ts:236`): `navOracle: await navOracle.getAddress(),` — leave
this line unchanged; the `HyperTesseraAddresses.navOracle` field name is unaffected by the
vault-keying removal.

- [ ] **Step 2: Rewrite `offchain/test/indexer.integration.test.ts`'s NAV calls to be token-keyed**

Read the full file first (`Read offchain/test/indexer.integration.test.ts`) to find its current
setup — it needs a stand-in `rwaToken` address (any funded EOA works since `updateNAV` never reads
the token's own contract, only uses the address as a mapping key) and a signer authorised via
`navOracle.setSigner(rwaToken, signer)` instead of the deleted vault-keyed
`addAuthorizedSigner`/`bootstrapNavTolerance`.

Before (`offchain/test/indexer.integration.test.ts:77`):
```typescript
await sdk.updateNAV(stack.addresses.cashVault, nav, dataTimestamp, sig, governor);
```
After — introduce a stand-in token address (e.g. `const rwaToken = makeRandomAddress()` equivalent
already used elsewhere in this file's ethers-based setup, or `ethers.Wallet.createRandom().address`
if no existing helper fits) and wire a signer for it before this call:
```typescript
await (await navOracle.connect(governor).setSigner(rwaToken, governorAddr)).wait();
// ... build `sig` via sdk.signNAVUpdate(rwaToken, nav, dataTimestamp, governor) instead of the old vault-keyed digest ...
await sdk.updateNAV(rwaToken, nav, dataTimestamp, sig, governor);
```
Apply the same rewrite to the second call site at line 135 (`stack.addresses.noteVault` →
the same or another stand-in `rwaToken`).

Before (`offchain/test/indexer.integration.test.ts:89`):
```typescript
const logs = await indexer.getEvents(sdk.navOracle, "NAVUpdated");
```
After — leave this line unchanged (event name is unchanged); only update any subsequent assertions
in this test that destructure the log's `args` by the old field name `nav` to use `price` instead
(matching `INAVOracle.NAVUpdated`'s unchanged `(rwaToken, price, dataTimestamp, updatedAt, signer)`
shape — only the first indexed field's semantic meaning changed from vault to token, not its
position).

- [ ] **Step 3: Rewrite `offchain/test/e2e.integration.test.ts`'s NAV assertions**

Before (`offchain/test/e2e.integration.test.ts:100-102`):
```typescript
await sdk.updateNAV(stack.addresses.cashVault, nav, dataTimestamp, sig, governor);

expect(await sdk.isNAVFresh(stack.addresses.cashVault)).toBe(true);
```
After:
```typescript
await (await navOracle.connect(governor).setSigner(rwaToken, governorAddr)).wait();
await sdk.updateNAV(rwaToken, nav, dataTimestamp, sig, governor);

const { price } = await sdk.getNAV(rwaToken);
expect(price).toBe(nav);
```
(Introduce the same stand-in `rwaToken` address pattern as Step 2; `isNAVFresh` no longer exists
per Task 7 Step 5 — replace the freshness assertion with a plain value-read assertion as shown,
since the redesign explicitly removes on-chain freshness as a concept.)

- [ ] **Step 4: Run the integration suite**

Run: `cd offchain && npm run test:integration`
Expected: requires a local anvil instance with the freshly built contracts — start `anvil &` if not
already running, run `forge build` first so `out/` artifacts are current (deployStack.ts loads ABI
+ bytecode straight from `out/`), then run the command above. All three integration test files
PASS. If `test:integration` was already failing before this task due to the pre-existing
`AdapterFactory`/`accessControl`-param staleness noted during research (deployStack.ts's
`deployAdapter`/`deployLiquidityAdapter`/`AdapterFactory` constructor calls reference an
`accessControl` field and constructor arg that no longer exist on the current contracts), that is a
pre-existing issue unrelated to this plan — do not attempt to fix it here; note it to the user
instead of silently expanding this task's scope.

- [ ] **Step 5: Commit**

```bash
git add offchain/test/deployStack.ts offchain/test/indexer.integration.test.ts offchain/test/e2e.integration.test.ts
git commit -m "test: update offchain integration suite for token-keyed NAVOracle"
```

---

## Task 11: Local-devnet e2e wiring — `offchain/scripts/local/deploy.ts`

**Files:**
- Modify: `offchain/scripts/local/deploy.ts:103-137`
- Modify: `offchain/scripts/local/config.ts` (if it types the `demoNavConsumer`/`navOracleStub` shape)

**Interfaces:** consumes Task 6's `Deploy.s.sol` output JSON (`RWAAdapter` key added,
`navVault` key removed).

- [ ] **Step 1: Read the current `demoNavConsumer` typing**

Run: `grep -n "demoNavConsumer\|navOracleStub" offchain/scripts/local/config.ts`
Note the exact interface field(s) so Step 2's edit keeps the file typechecking.

- [ ] **Step 2: Replace the `navVault`-derived field with the new `RWAAdapter` demo address**

Before (`offchain/scripts/local/deploy.ts:125-137`):
```typescript
    assetRegistryModuleD: {
      note:
        "Module D (AssetRegistry/MintBurnController/ReservePSM/PoRRegistry/NAVOracle-stub) is deployed " +
        "standalone against StubStateManager, matching the confirmed 'D Asset Infra standalone module' " +
        "design (development-plan.md §7). It is NOT wired to the real vaults above — see TEST_PLAN.md.",
      stubStateManager: stage1.addresses.StubStateManager,
      navOracleStub: stage1.addresses.NAVOracle,
      demoNavConsumer: stage1.navVault,
      sToken: stage1.addresses.SToken,
      jToken: stage1.addresses.JToken,
      sTokenAssetId: 1,
      jTokenAssetId: 2,
    },
```
After:
```typescript
    assetRegistryModuleD: {
      note:
        "Module D (AssetRegistry/MintBurnController/ReservePSM/PoRRegistry/NAVOracle-stub) is deployed " +
        "standalone against StubStateManager, matching the confirmed 'D Asset Infra standalone module' " +
        "design (development-plan.md §7). It is NOT wired to the real vaults above — see TEST_PLAN.md.",
      stubStateManager: stage1.addresses.StubStateManager,
      navOracleStub: stage1.addresses.NAVOracle,
      demoRwaAdapter: stage1.addresses.RWAAdapter,
      sToken: stage1.addresses.SToken,
      jToken: stage1.addresses.JToken,
      sTokenAssetId: 1,
      jTokenAssetId: 2,
    },
```

Update `offchain/scripts/local/config.ts`'s matching interface field from `demoNavConsumer: string;`
to `demoRwaAdapter: string;` (Step 1 told you the exact current line), and its corresponding
assignment (previously `navOracleStub: raw.navOracleStub` block — add a sibling
`demoRwaAdapter: raw.assetRegistryModuleD.demoRwaAdapter` matching whatever destructuring pattern
that block already uses).

- [ ] **Step 3: Run the local e2e deploy script against a fresh anvil**

Run: `anvil &` (if not already running), then `forge build`, then
`cd offchain && npx tsx scripts/local/deploy.ts` (or whatever the existing `package.json` script
alias for this is — check `grep -n "local/deploy" offchain/package.json` first).
Expected: script completes without throwing, and the printed/written addresses JSON contains a
`demoRwaAdapter` address (not `undefined`).

- [ ] **Step 4: Typecheck**

Run: `cd offchain && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add offchain/scripts/local/deploy.ts offchain/scripts/local/config.ts
git commit -m "chore: point local-devnet e2e wiring at the RWAAdapter demo instead of DemoNAVConsumer"
```

---

## Final verification

- [ ] Run `forge build && forge test` — full Solidity suite green.
- [ ] Run `cd offchain && npm run typecheck && npm test` — full offchain unit suite green.
- [ ] Run `cd offchain && npm run test:integration` against a fresh `anvil` — integration suite
      green (or confirm any failure is the pre-existing, unrelated `AdapterFactory`/`accessControl`
      staleness flagged in Task 10 Step 4, not a regression from this plan).
- [ ] Grep the whole repo for remaining dead references: `grep -rn "navToleranceBps\|isNAVFresh\|addAuthorizedSigner\|bootstrapNavTolerance\|DemoNAVConsumer\|navByVault\|NAVData\b" src/ test/ offchain/ script/ control-panel/index.html control-panel/standalone.html` — expect zero hits in `src/`, `test/`, `script/`, and `offchain/`. `control-panel/index.html`/`standalone.html` will still show hits (see note below) — that is expected and out of scope.
- [ ] Report to the user: `control-panel/index.html` and `control-panel/standalone.html` contain a
      NAV-oracle admin panel section keyed on `deployments.navVault` and calling
      `nav.authorizedSigner(vault)` — both concepts this plan removes. The design spec's file-level
      change list does not include either HTML file, so this plan leaves them untouched per the
      "minimal diff" principle; flag to the user that this panel section will be non-functional
      after this plan lands, and ask whether a follow-up should update it.
