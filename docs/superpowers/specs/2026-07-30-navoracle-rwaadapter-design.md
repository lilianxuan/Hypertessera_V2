# NAVOracle / RWAAdapter Redesign

Source: client doc "NAV Oracle 与 RWAAdapter 修改方案" (RWA Token valuation path), built on top
of `alliancechuan/hyperTessera#12` (vault-local and asset-local RBAC).

## Background

The current `NAVOracle` is a vault-keyed NAV record/validate module: `mapping(vault => NAVData)`,
gated by `StateManager`/`IVaultRoles`, with a per-vault signer and NAV tolerance. It is already
disconnected from the live valuation path — `BaseVault.totalAssets()` sums `Adapter.realAssets()`
only, never reads `NAVOracle`.

The new business path: a Vault holds a specific RWA Token through an Adapter, and valuation reads
that token's on-chain balance plus an independent price from an Oracle keyed by *token*, not by
*vault*. RWA Tokens may be HyperTessera's own (`RWAToken`, has an `assetId`) or issued by an
external party with no `AssetRegistry` entry at all — so the new Oracle and Adapter must not
require or read an `assetId`.

## Design principles

- Minimal diff: touch only `NAVOracle`, the new `RWAAdapter`, `AdapterFactory`/`IAdapterFactory`,
  and dead `Vault`/`StateManager`/`Types` fields; corresponding offchain SDK/Indexer/KeeperBot;
  deploy scripts.
- `NAVOracle` is fully independent — no `StateManager`, no `IVaultRoles`, no Vault reference.
- `RWAAdapter` does not store or read `assetId`; it never calls `AssetRegistry`.
- No on-chain staleness/freshness check. Whether a price is "too old" is an off-chain/product
  concern (signer process, frontend, monitoring) — not enforced by the contract.
- Settlement is untouched: not wired to `NAVOracle` or `RWAAdapter.realAssets()`.

## 1. Valuation flow

1. `BaseVault.grossManagedAssets()` (unchanged) loops `adapters[]`, calling `IAdapter(adapter).realAssets()`.
2. For a `RWAAdapter`: `realAssets()` reads `IERC20(rwaToken).balanceOf(address(this))`.
3. It calls `NAVOracle.getNAV(rwaToken)` for the current price + `updatedAt`.
4. It converts `balance * price` through `rwaToken.decimals()`, the Vault's `asset().decimals()`,
   and the Oracle's fixed 1e18 price scale, into the Vault's accounting-asset units.
5. It adds any still-in-transit `BaseAdapter` pending-deal value (existing mechanism, see §3) and
   returns the sum to `BaseVault`.

`realAssets()` is `view`; `eth_call` reads are free, on-chain calls that invoke it as part of a
transaction (e.g. `grossManagedAssets()` from `snapshotSettlementPrice`) pay gas for the read as
usual.

## 2. NAVOracle — full rewrite of `src/asset-infrastructure/NAVOracle.sol` / `INAVOracle.sol`

Independent, per-`rwaToken`-keyed price oracle with a single Oracle-owner admin.

### Storage

```solidity
struct PriceData {
    uint256 price;         // 1e18-scale: value of 1 whole rwaToken, denominated in 1 whole asset unit
    uint256 dataTimestamp; // off-chain source timestamp
    uint256 updatedAt;     // block.timestamp of last on-chain write
}

address public owner;                                    // single Oracle admin (mutable)
mapping(address rwaToken => PriceData) private _priceData;
mapping(address rwaToken => address) private _signer;
```

### Admin (owner-gated; `owner` set in constructor, transferable)

- `setSigner(address rwaToken, address signer)`
- `removeSigner(address rwaToken)`
- `transferOwnership(address newOwner)`

Decision: single Oracle owner manages the authorized signer for every `rwaToken` it serves (not
per-token self-registration, not a delegated per-token controller layer).

### Write path — EIP-712

`updateNAV(address rwaToken, uint256 price, uint256 dataTimestamp, bytes calldata signature)`,
permissionless relay (anyone may submit; `signature` must be the registered signer's).

- Domain: `{name: "NAVOracle", version: "1", chainId: block.chainid, verifyingContract: address(this)}`.
- Typed struct: `NAVUpdate(address rwaToken, uint256 price, uint256 dataTimestamp)`.
- Recovered signer must equal `_signer[rwaToken]` and be non-zero.
- Validation (re-keyed by `rwaToken`, otherwise same rules as today):
  - `price != 0`
  - `dataTimestamp <= block.timestamp` (not future)
  - `dataTimestamp` strictly greater than the token's previous accepted `dataTimestamp` (skipped on first write)
  - Upward-only deviation cap: fixed `NAV_DEVIATION_MAX_BPS = 2000` (20%) constant, applied only
    when `price > previous price`; downward moves of any size pass. First write skips this check.
- **Removed** entirely from the current contract: `STALENESS_PERIOD`, `isNAVFresh`,
  `StateManager`/`ModuleId.NAV_ORACLE` pause gate, `navTolerance` / `setNavTolerance` /
  `bootstrapNavTolerance`, all `IVaultRoles`/vault-owner/vault-curator gating.

### Reads

- `getNAV(address rwaToken) external view returns (uint256 price, uint256 updatedAt)`
- `getPriceData(address rwaToken) external view returns (PriceData memory)`
- `signerOf(address rwaToken) external view returns (address)`

### Errors / events

- Errors: `ZeroAddress`, `Unauthorized`, `UnauthorizedSigner(address recovered)`, `InvalidNAV`,
  `FutureData(uint256)`, `NonMonotonicTimestamp(uint256, uint256)`, `DeviationTooHigh(uint256, uint256)`.
- Events: `NAVUpdated(address indexed rwaToken, uint256 price, uint256 dataTimestamp, uint256 updatedAt, address indexed signer)`,
  `SignerSet(address indexed rwaToken, address indexed signer)`, `SignerRemoved(address indexed rwaToken)`,
  `OwnershipTransferred(address indexed oldOwner, address indexed newOwner)`.

## 3. RWAAdapter — new `src/asset-management/strategy/RWAAdapter.sol`

Extends `BaseAdapter` (reuses its ERC-4626 share accounting, Curator order book, Allocator
execution, freeze, and — critically — the existing `pendingDeposits` / `liveDealOrderIds` /
`clearDealValue` pending-value machinery, which already implements exactly what the doc's §6
"clear pending value once the token has arrived" requirement needs).

- Constructor adds two immutables — `rwaToken`, `navOracle` — on top of `BaseAdapter`'s existing
  `asset`, `vault`, `defaultStalenessWindow`. No `assetId` parameter; never calls `AssetRegistry`.
- `realAssets()` override:

  ```solidity
  function realAssets() public view override returns (uint256) {
      uint256 pending = super.realAssets(); // BaseAdapter's existing live pending-deal sum
      uint256 balance = IERC20(rwaToken).balanceOf(address(this));
      if (balance == 0) return pending;
      (uint256 price, ) = INAVOracle(navOracle).getNAV(rwaToken);
      if (price == 0) revert NAVUnavailable(rwaToken);
      return pending + _tokenValue(balance, price);
  }
  ```

  `_tokenValue` converts `balance` (rwaToken's own decimals) and `price` (1e18-scale, per one
  whole rwaToken) into the Vault's accounting-asset smallest units, using
  `IERC20Metadata(rwaToken).decimals()` and `IERC20Metadata(asset()).decimals()`, via
  `Math.mulDiv` (order chosen to avoid intermediate overflow).

- New error: `NAVUnavailable(address rwaToken)` — thrown when `balance > 0` but the Oracle has no
  price for that token.
- No on-chain staleness check on the price itself; `updatedAt` from `getNAV` is informational only
  (frontend/Indexer/monitoring).
- Everything else (buy/sell/rebalance orders, `updateDealData`, `clearDealValue`,
  `freezeAllocator`, `setStalenessWindow`, `setDataProvider`) is inherited unchanged. A typical
  RWA acquisition uses `SettlementMode.TOKEN_RETURN` (destination = the `RWAAdapter` itself); once
  the token lands, the Allocator calls the existing `clearDealValue(orderId)` to zero the pending
  entry, preventing the "order cost + token market value" double-count the doc flags.

## 4. AdapterFactory / IAdapterFactory

```solidity
struct RWAAdapterParams {
    address asset;                    // Vault's accounting asset
    address vault;                    // serves exactly one Vault, fixed at deploy
    address rwaToken;                 // fixed at deploy
    address navOracle;                // fixed at deploy
    uint256 dealDataStalenessWindow;  // BaseAdapter's existing pending-deal staleness window
}

function deployRWAAdapter(RWAAdapterParams calldata params) external returns (address adapter);
```

- Permissionless, matching the already-current `deployAdapter`/`deployLiquidityAdapter` pattern —
  no `accessControl` param (already removed from `IAdapterFactory` by the prior RBAC PR) and no
  `assetId` param.
- Validates all five fields non-zero; records `isAdapter[adapter] = true` as a source-of-origin
  record only (as today) — actual Vault admission still goes through the existing
  `AdapterRegistry` whitelist + `BaseVault.addAdapter` (Curator-direct while `CONFIGURING`,
  `VaultTimelock`-gated after), unchanged.
- New `RWAAdapterDeployer` helper contract, mirroring `FirstPeriodAdapterDeployer` /
  `LiquidityAdapterDeployer`, to keep `RWAAdapter`'s creation bytecode out of `AdapterFactory`'s
  own runtime bytecode (`AdapterFactory` is already close to the EIP-170 size limit per its
  existing structure).

## 5. Vault / StateManager / Types cleanup

- `BaseVault` / `EarnVault` / `LiquidityEarnVault`: **no code changes** — none of them currently
  declare a `navOracle` field, setter, or event; nothing to remove.
- `src/libs/Types.sol`: delete `navToleranceBps` from `ProductParams`; delete `NAV_ORACLE` from
  `ModuleId`. Neither is read anywhere in `StateManager` or `Settlement` today (confirmed by
  search) — deleted outright, not deprecated, per this being an external-delivery repo with no
  live deployments requiring ABI/enum-ordinal stability.
- `src/asset-management/StateManager.sol`: no changes — `modulePaused`/`_modulePaused` are generic
  over `ModuleId`; nothing hardcodes the `NAV_ORACLE` ordinal.
- `src/governance/VaultTimelock.sol`: fix one stale doc comment referencing future
  "Adapter-specific and NAVOracle targets" whitelisting (NAVOracle is no longer vault-governed at
  all, so that half of the comment is now inaccurate) — comment-only, no logic change.

## 6. AdapterDeployer / new deployer contract

`src/asset-management/strategy/AdapterDeployer.sol` gains an `RWAAdapterDeployer` contract
alongside the existing two, with a `deploy(...)` method taking the five `RWAAdapterParams` fields
and returning `address(new RWAAdapter(...))`.

## 7. Offchain (`offchain/src/`)

- `types.ts`: `NAVData` → `PriceData { price: bigint; dataTimestamp: bigint; updatedAt: bigint }`.
- `sdk.ts`:
  - `getNAV(rwaToken: Address): Promise<PriceData>` (was `getNAV(vault)`).
  - `updateNAV(rwaToken, price, dataTimestamp, sig, signer)` (was keyed by `vault`).
  - Remove `isNAVFresh`.
  - Add `signNAVUpdate(rwaToken, price, dataTimestamp, signer): Promise<Hex>` — EIP-712
    `Signer.signTypedData` helper matching the on-chain domain/struct, for the off-chain NAV
    signing service.
  - Add `rwaAdapter(address)` contract getter and `deployRWAAdapter(params, signer)` write method
    wrapping `AdapterFactory.deployRWAAdapter`.
  - Add `"RWAAdapter"` to `ContractName` in `types.ts`/`abis.ts`.
- `keeperBot.ts`: delete `checkNavFreshness`, the `"nav-stale"` `KeeperAlertType` member, and its
  call site in `tick()`. No replacement — no NAV-freshness concept remains.
- `indexer.ts`: `navByVault` → `navByToken` (rename `NAVRecord` map and `onNAVUpdated` signature to
  `(rwaToken, price, dataTimestamp, updatedAt)`); `getLatestNAV(vault)` → `getLatestNAV(rwaToken)`.
- `abis.json`: regenerated via `control-panel/build-abis.sh` after `forge build` picks up
  `NAVOracle`, `INAVOracle`, `RWAAdapter`, `AdapterFactory`'s new function.

## 8. Deploy scripts (`script/Deploy.s.sol`)

- `NAVOracle` constructor changes from `NAVOracle(address stateManager)` to
  `NAVOracle(address owner_)`. Both existing call sites (`DeployW1`-equivalent section and
  `DeployW3._deploy`) pass `governor` instead of `address(stub)` / `address(stateManager)`.
- Delete `DemoNAVConsumer` — it only existed to satisfy the old `IVaultRoles.owner()` check for
  vault-scoped `addAuthorizedSigner`; no longer needed.
- Delete `DeployW3._wireNAV` (per-vault signer/tolerance wiring) — replaced by per-token
  `NAVOracle.setSigner(rwaToken, signer)`.
- Add a small local-devnet demo step: deploy one `RWAAdapter` via `AdapterFactory.deployRWAAdapter`
  wired to the existing demo `sToken` (`RWAToken`, already deployed by `registerAsset` in the W1
  section) as a stand-in RWA Token, with `NAVOracle.setSigner(sToken, dataProviderSigner)` — gives
  the local e2e wiring one concrete example of the new path without inventing new demo
  infrastructure.

## 9. Testing

- `test/NAVOracle.t.sol`: rewritten — token-keyed storage, EIP-712 signature construction/replay
  rejection (wrong chainId/oracle/token all rejected), fixed deviation cap, monotonic-timestamp,
  no staleness/freshness surface.
- New `test/RWAAdapter.t.sol`: `realAssets()` balance×price conversion across differing
  rwaToken/asset decimals, `NAVUnavailable` revert when balance > 0 and no price set, pending value
  cleared via inherited `clearDealValue` once token balance lands (no double count), inherited
  order-book/freeze behavior smoke-tested via `BaseAdapter`'s existing test patterns.
- `offchain/test/`: update `indexer.integration.test.ts` / `keeperBot.integration.test.ts` /
  `e2e.integration.test.ts` for the renamed events/methods/types; remove the nav-staleness test
  case from `keeperBot.integration.test.ts`.

## File-level change list

| File | Change |
|---|---|
| `src/asset-infrastructure/NAVOracle.sol` | Full rewrite: token-keyed, standalone, EIP-712, fixed deviation cap |
| `src/interfaces/INAVOracle.sol` | Full rewrite to match |
| `src/asset-management/strategy/RWAAdapter.sol` | New |
| `src/asset-management/strategy/AdapterDeployer.sol` | Add `RWAAdapterDeployer` |
| `src/asset-management/strategy/AdapterFactory.sol` | Add `deployRWAAdapter` |
| `src/interfaces/IAdapterFactory.sol` | Add `RWAAdapterParams`, `deployRWAAdapter` |
| `src/libs/Types.sol` | Delete `navToleranceBps`, `ModuleId.NAV_ORACLE` |
| `src/governance/VaultTimelock.sol` | Fix stale doc comment (no logic change) |
| `script/Deploy.s.sol` | New `NAVOracle` constructor call sites; delete `DemoNAVConsumer`/`_wireNAV`; add RWAAdapter demo wiring |
| `test/NAVOracle.t.sol` | Rewritten |
| `test/RWAAdapter.t.sol` | New |
| `offchain/src/types.ts` | `NAVData` → `PriceData` |
| `offchain/src/sdk.ts` | Token-keyed NAV methods, EIP-712 signing helper, RWAAdapter accessors |
| `offchain/src/keeperBot.ts` | Remove NAV-staleness alerting |
| `offchain/src/indexer.ts` | `navByVault` → `navByToken` |
| `offchain/src/abis.ts` | Add `"RWAAdapter"` |
| `offchain/test/*.integration.test.ts` | Update for renamed surface |
| `control-panel/abis.json` | Regenerated |

## Out of scope (explicitly, per doc)

- `Settlement`, `Queue`, `UnifiedPool`, `RevenuePool` — untouched.
- `AssetRegistry` — `RWAAdapter`/`NAVOracle` never call it.
- Per-token NAV tolerance configurability — the deviation cap is a fixed contract constant, not
  settable (no more per-vault Curator-set tolerance).
- Any on-chain staleness/freshness enforcement.
