# HyperTessera — Function Reference

**Version:** W1 delivered (on-chain) · W2 delivered (on-chain) · W3 delivered (on-chain) · W4 delivered (on-chain) · RBAC redesign delivered (on-chain) · 2026-08 fee model + LiquidityEarnVault rewrite delivered (on-chain) · Partial queue settlement + protocol creation fees delivered (on-chain)
**Chain:** BNB Chain (chainId 97 testnet / mainnet TBD)
**About:** This document provides plain-language descriptions of every contract function for the client and operations team — who can call it, when to call it, what it does, and why it may fail. For full technical spec see `docs/development-plan.md`.

> **Role model (current):** Following the client-requested RBAC redesign, the protocol-global `HyperAccessControl` contract now administers only `GOVERNOR_ROLE` (protocol infrastructure upgrades and module-wide emergency pause). Every other role from earlier drafts of this document — Curator, Guardian, Allocator, Settlement Operator, Keeper — is now **Vault-local**: appointed by that specific Vault's own Owner through the `IVaultRoles` interface that every Vault implements. Asset-side roles — Issuer, Token Agent, Proof Publisher, Wrapper Controller — are now **per-asset**, tied to that asset's `AssetRegistry` owner. There is no longer a single global `ISSUER_ROLE`/`TOKEN_AGENT_ROLE`/`OPERATOR_ROLE`/etc. — each asset or Vault manages its own appointees independently.

---

## Table of Contents

- [Module A — Governance](#module-a--governance)
  - [HyperAccessControl](#hyperaccesscontrol)
  - [VaultTimelock](#vaulttimelock)
- [Module D — Asset Infrastructure](#module-d--asset-infrastructure)
  - [ProtocolFeeConfig](#protocolfeeconfig)
  - [AssetRegistry](#assetregistry)
  - [NAVOracle](#navoracle)
  - [MintBurnController](#mintburncontroller)
  - [RWAToken](#rwatoken)
  - [PoRRegistry](#porregistry)
  - [ClaimRegistry](#claimregistry)
- [Module D — Wrapped Assets](#module-d--wrapped-assets)
  - [ReservePSM](#reservepsm)
- [Module C — Settlement Infrastructure](#module-c--settlement-infrastructure)
  - [UnifiedPool](#unifiedpool)
  - [RevenuePool](#revenuepool)
  - [Queue](#queue)
  - [Settlement](#settlement)
- [Module B — Vault Infrastructure](#module-b--vault-infrastructure)
  - [StateManager](#statemanager)
  - [BaseVault (shared vault behavior + roles)](#basevault-shared-vault-behavior--roles)
  - [EarnVault](#earnvault)
  - [LiquidityEarnVault](#liquidityearnvault)
  - [LiquidityBridge](#liquiditybridge)
  - [VaultFactory](#vaultfactory)
- [Module E — Adapters (Strategy)](#module-e--adapters-strategy)
  - [BaseAdapter (shared adapter behavior)](#baseadapter-shared-adapter-behavior)
  - [LiquidityAdapter](#liquidityadapter)
  - [AdapterFactory](#adapterfactory)

---

## Module A — Governance

### HyperAccessControl

Protocol-wide role registry. It now manages a **single role**, `GOVERNOR_ROLE` — the protocol multisig that can upgrade shared infrastructure and pause/unpause a module protocol-wide. All the roles that used to live here (Curator, Guardian, Issuer, Token Agent, Operator, Keeper, Settlement, Allocator, Strategy, Data Provider, Compliance) have been moved out: Vault-level roles now live on each Vault itself (see [BaseVault](#basevault-shared-vault-behavior--roles)), and asset-level roles now live on `AssetRegistry`/its dependent contracts. `grantRole`/`revokeRole`/`hasRole`/`getRoleAdmin` still exist (inherited from OpenZeppelin's `AccessControl`) but they now only meaningfully manage `GOVERNOR_ROLE` — `GOVERNOR_ROLE` is configured as its own admin, so only a Governor can grant or revoke Governor status.

---

#### `grantRole(role, account)`

- **What it does:** Assigns `GOVERNOR_ROLE` to an address
- **Caller:** An existing `GOVERNOR_ROLE` holder (multisig)
- **When to use:** Adding a new Governor multisig signer, rotating a compromised key
- **Failure:** `account` is the zero address → revert; caller doesn't hold `GOVERNOR_ROLE` → standard access-control revert

---

#### `revokeRole(role, account)`

- **What it does:** Removes `GOVERNOR_ROLE` from an address
- **Caller:** An existing `GOVERNOR_ROLE` holder
- **When to use:** Staff changes, emergency revocation after key compromise
- **Failure:** Caller doesn't hold `GOVERNOR_ROLE` → revert

---

#### `hasRole(role, account)` *(read-only)*

- **What it does:** Checks whether an address holds `GOVERNOR_ROLE`
- **Returns:** `true` / `false`
- **When to use:** Frontend/ops tooling checking Governor status

---

#### `getRoleAdmin(role)` *(read-only)*

- **What it does:** Returns the admin role for the specified role
- **Returns:** Always `GOVERNOR_ROLE` — Governor is self-administering

---

### VaultTimelock

Each Vault gets its own `VaultTimelock`, deployed and permanently bound by `VaultFactory` at Vault creation — there is no longer a single protocol-wide `ProtocolTimelock`. It delay-queues sensitive parameter changes on that one Vault, split into two classes: **Owner-class** actions (e.g. rewiring Settlement/UnifiedPool/Gate, writing down an insolvency) and **Curator-class** actions (e.g. performance fee changes, adding/removing Adapters). Only a pre-approved `(target contract, function, class)` combination can be scheduled — this whitelist is pre-seeded at deploy time for the standard Vault management functions, and can be extended later only by the timelock acting on itself.

**Delay bounds:** minimum 1 hour, maximum 30 days, default 48 hours. Every scheduled change also expires 7 days after it becomes executable if nobody calls execute in time.

---

#### `scheduleParamChange(target, data)`

- **What it does:** Queues a parameter change (an ABI-encoded function call against `target`) to take effect after the Vault's configured delay
- **Caller:** That Vault's Owner (for an Owner-class action) or that Vault's Curator (for a Curator-class action)
- **Parameters:**
  - `target`: contract address to call once the delay elapses
  - `data`: ABI-encoded function call, including its 4-byte selector
- **Returns:** `changeId` — a unique identifier for later execution or cancellation
- **When to use:** Rewiring Settlement/UnifiedPool/Gate, adjusting performance fee, adding/removing an Adapter, or any other whitelisted change
- **Failure:**
  - `target` is the zero address → revert
  - Caller is neither that Vault's Owner nor Curator → revert
  - The `(target, function selector)` pair isn't whitelisted for the caller's class → revert, naming the target/selector

---

#### `executeParamChange(changeId)`

- **What it does:** Executes a previously-queued change once its delay has elapsed, as long as it hasn't expired
- **Caller:** Anyone (permissionless — typically automated by a keeper bot, but no special access needed)
- **Failure:**
  - Change doesn't exist → revert
  - Already executed or already cancelled → revert
  - Delay hasn't elapsed yet → revert ("too early")
  - More than 7 days have passed since it became executable → revert ("expired")
  - The underlying call to `target` itself reverts → the whole execution reverts

---

#### `cancelParamChange(changeId)`

- **What it does:** Cancels a queued change before it executes
- **Caller:** That Vault's Owner, that Vault's Guardian, or whoever originally proposed the change
- **When to use:** Mistake discovered after submission; Guardian intervening on a suspicious pending change
- **Failure:** Change doesn't exist, already executed, or already cancelled → revert; caller is none of Owner/Guardian/original proposer → revert

---

#### `setDelay(newDelay)`

- **What it does:** Updates this Vault's timelock delay
- **Caller:** The timelock contract itself only — i.e. this must be scheduled and executed through the normal `scheduleParamChange`/`executeParamChange` flow, not called directly
- **When to use:** Lengthening or shortening the standard 48-hour delay for a specific Vault
- **Failure:** Called directly by any other address → revert; new delay outside the 1 hour – 30 day bound → revert

---

#### `setAllowedAction(target, selector, class, allowed)`

- **What it does:** Adds or removes a `(target contract, function selector, action class)` combination from the whitelist that `scheduleParamChange` checks
- **Caller:** The timelock itself (via the normal schedule/execute flow), **or** that Vault's Owner directly while the Vault is still in the `CONFIGURING` lifecycle stage (a one-time bootstrap allowance so a new Vault can be wired up before its first parameter change needs a full delay cycle)
- **When to use:** Extending the set of parameter changes a Vault's Owner/Curator can queue
- **Failure:** Called by anyone else outside the bootstrap window → revert

---

#### `pendingChangeCount()` / `pendingChangesPaged(offset, limit)` *(read-only)*

- **What it does:** Enumerates the changeIds currently queued on this Timelock — scheduled and neither executed nor cancelled. `pendingChanges(changeId)` answers *"what is change X?"*; these answer *"what is queued on this Vault right now?"*, which was otherwise only recoverable by replaying `ParamChangeScheduled` / `ParamChangeExecuted` / `ParamChangeCancelled` and reconstructing the surviving set by hand
- **Returns:** `bytes32[]` of changeIds; pass each to `pendingChanges(changeId)` for its target, calldata, proposer and timing
- **When to use:** Any governance monitor or Vault dashboard. This is the highest-value read in the enumeration set — missing a queued change means missing a **pending privileged action**
- **Paging:** `pendingChangesPaged` clamps rather than reverts — an `offset` at or past the end returns an empty array and an overlong `limit` returns a short page, so you can page without reading `pendingChangeCount()` first
- **Note:** This is the exact live queue, so ordering is **not stable** — executing or cancelling swaps the last entry into the freed slot and pops. Pin a single `blockTag` across the count and the pages that follow it
- **Note:** An **expired** change is still listed. Expiry is a timestamp comparison, not a state transition, and nothing sweeps it — read `expiresAt` per entry to separate actionable changes from stale ones

---

#### `allowedActionCount()` / `allowedActionsPaged(offset, limit)` *(read-only)*

- **What it does:** Enumerates the `(target, selector, class)` tuples ever whitelisted on this Timelock, including the constructor's pre-seeded set. `isActionAllowed` is a triple-nested mapping and cannot be walked at all, so *"what is this Timelock permitted to do?"* — a security-review question — was answerable only by replaying every `setAllowedAction`
- **Returns:** `AllowedAction[]`, each `{address target, bytes4 selector, ActionClass class}`
- **Paging:** Clamps on the same terms as `pendingChangesPaged`
- **Note:** This index is **append-only**, unlike the pending-change index above: a tuple is recorded the first time it is allowed and never removed, so an index is stable forever and safe to cache across blocks. The cost of that stability is that **an entry is a candidate, not a permission** — `setAllowedAction(..., false)` leaves it listed. Callers **must** re-check every entry through `isActionAllowed(target, selector, class)` before treating it as currently permitted

---

## Module D — Asset Infrastructure

### ProtocolFeeConfig

**New (2026-08-05).** Pure configuration contract for protocol-level *creation* fees — the one-time fee charged when a new asset is registered (`AssetRegistry.registerAsset`) or a new Vault is deployed (`VaultFactory.deployVault`). It never custodies funds: both consumer contracts read the configured amount/recipient here and then pull/forward payment directly to `revenuePool()` themselves. Fees are keyed by `(CreationFeeAction, FeePaymentKind)` — action is `RegisterAsset` or `DeployVault`; payment kind is `Native` (the chain's native currency, e.g. BNB/ETH), `Governance` (protocol governance token, address TBD), or `Stable` (a designated stablecoin, independently configured from the protocol-wide USDT used elsewhere). Every `(action, kind)` amount may be set to `0` (no-op — no fee, no transfer). A creator only ever chooses *which* payment kind to use; the amount and recipient are always protocol-configured, never creator-specified.

---

#### `setFee(action, kind, amount)`

- **What it does:** Sets the creation-fee amount for a given `(action, kind)` combination
- **Caller:** `GOVERNOR_ROLE`
- **When to use:** Initial fee-table setup per chain/deployment, or adjusting fees over time
- **Failure:** Non-Governor caller → `NotGovernor`

---

#### `setPaymentToken(kind, token)`

- **What it does:** Sets the ERC-20 address backing the `Governance` or `Stable` payment kind (`Native` always uses the chain's native currency and has no configurable token)
- **Caller:** `GOVERNOR_ROLE`
- **When to use:** Wiring the governance token once it exists, or the chosen stablecoin for this deployment
- **Failure:** Non-Governor caller → `NotGovernor`; `kind == Native` → `NativeKindHasNoToken`; `token` is the zero address → `ZeroAddress`

---

#### `setRevenuePool(pool)`

- **What it does:** Sets the address every collected creation fee is forwarded to
- **Caller:** `GOVERNOR_ROLE`
- **Failure:** Non-Governor caller → `NotGovernor`; `pool` is the zero address → `ZeroAddress`

---

#### `feeOf(action, kind)` / `paymentTokenOf(kind)` / `revenuePool()` *(read-only)*

- **What it does:** Returns the configured fee amount for an `(action, kind)` pair (`0` if never set) / the ERC-20 address backing `Governance`/`Stable` (`address(0)` if unset, or always for `Native`) / the current fee-collection recipient

---

### AssetRegistry

The foundational, fully permissionless ledger for registering RWA assets. Anyone may register an asset — the registering address automatically becomes that asset's **owner**, which is also that asset's **Issuer** everywhere else in the system (`MintBurnController`, `PoRRegistry`, `RWAToken`'s transfer-path management all check "is this address `AssetRegistry.ownerOf(assetId)`" rather than any separate role grant). There is no Governor override anywhere in this contract — asset management is entirely delegated to each asset's own owner. Each asset receives a unique integer ID (starting from 1). The contract also deploys its own dedicated `MintBurnController` at construction, so that controller is immutable from day one with no wiring step. **New (2026-08-05):** registration is now gated behind a protocol creation fee (see [ProtocolFeeConfig](#protocolfeeconfig)) — this only adds a payment requirement, registration itself remains fully permissionless with no allowlist.

---

#### `registerAsset(metadataHash, name, symbol, decimals, feeKind, product)`

- **What it does:** Collects the configured creation fee (if any), then registers a new RWA asset, deploys a dedicated `RWAToken` contract for it, records the asset's on-chain product terms, and returns the new `assetId` and token address. Fee collection happens first — if payment fails, is short, or the chosen kind isn't configured, the entire call reverts and nothing is created
- **Caller:** Anyone — fully permissionless; the caller becomes the asset's owner/Issuer
- **Payable:** Must send exactly the `Native`-kind fee amount as `msg.value` when `feeKind == Native`; must send `0` otherwise
- **Parameters:**
  - `metadataHash`: `keccak256` hash of the asset's off-chain document (e.g. the deal/legal document), computed by the caller before submitting; the document itself is not stored on-chain, only this integrity anchor (retrieval URI, if published, is stored separately in `PoRRegistry`)
  - `name`, `symbol`, `decimals`: parameters for the new RWAToken ERC-20
  - `feeKind`: which of `Native` / `Governance` / `Stable` to pay the creation fee with (see [ProtocolFeeConfig](#protocolfeeconfig)) — for `Governance`/`Stable`, the caller must have pre-approved this contract to pull the fee token
  - `product`: a `ProductInfo` struct — `{productName, annualYieldRateBps, maturityTimestamp, issuer, underlyingAsset}` — recording the asset's core business terms on-chain. **`issuer` is ignored on input and always overwritten with `msg.sender`** — a caller cannot name someone else as issuer. `annualYieldRateBps` is a basis-points integer (`500` = 5.00% APY) and is `uint16`, so the largest expressible yield is **655.35% APY** (`65535` bps) — a `product` with a higher intended yield cannot be represented and must be rejected client-side before submission. `maturityTimestamp` is a Unix timestamp (`uint64`)
- **Returns:** `(assetId, token)` — auto-incrementing ID and deployed RWAToken address
- **When to use:** Onboard a new RWA asset; this is the single entry point that creates both the registry record, the on-chain token contract, and the recorded product terms
- **Event:** In addition to `AssetRegistered`, a separate `ProductInfoSet(assetId, issuer, productName, annualYieldRateBps, maturityTimestamp, underlyingAsset, timestamp)` event fires in the same transaction — kept as its own event rather than widening `AssetRegistered`, so existing indexers decoding `AssetRegistered` are unaffected
- **Note:** Product terms recorded here are **not currently updatable** — there is no `updateProductInfo` function. See `getProductInfo` below
- **Failure:**
  - `feeKind == Native` and `msg.value` doesn't exactly equal the configured fee → `IncorrectNativeFee`
  - `feeKind != Native` and `msg.value != 0` → `UnexpectedNativeValue`
  - `feeKind` is `Governance`/`Stable`, the fee is nonzero, and no payment token is configured for that kind → `PaymentTokenNotConfigured`
  - Fee transfer/pull fails (e.g. insufficient allowance/balance for `Governance`/`Stable`) → reverts (whole transaction, no asset created)

---

#### `feeConfig()` *(read-only)*

- **What it does:** Returns the address of the `ProtocolFeeConfig` instance this registry is wired to
- **When to use:** Confirming which fee table governs registration on this deployment

---

#### `tokenOf(assetId)` / `ownerOf(assetId)` *(read-only)*

- **What it does:** Returns the RWAToken contract address for a registered asset / returns that asset's current owner (Issuer)
- **When to use:** Look up the token contract, or check who is authorized to act as Issuer for an asset

---

#### `updateMetadataHash(assetId, newHash)`

- **What it does:** Updates the metadata hash for an asset
- **Caller:** That asset's owner
- **When to use:** After replacing asset documents (e.g. updated audit report)
- **Failure:** Asset was never registered → revert; non-owner caller → revert

---

#### `transferAssetOwnership(assetId, newOwner)`

- **What it does:** Transfers asset ownership (and, transitively, Issuer status) to another address
- **Caller:** Current owner
- **When to use:** Business restructuring, transferring asset management rights
- **Failure:** Non-owner caller → revert; `newOwner` is the zero address → revert

---

#### `deactivateAsset(assetId)`

- **What it does:** Deactivates an asset (`isActive` returns false); the record itself is never deleted
- **Caller:** That asset's owner **only** — there is no longer a Governor emergency-override path
- **When to use:** Asset maturity, compliance-driven delisting
- **Failure:** Non-owner caller → revert; asset already inactive → revert

---

#### `isActive(assetId)` *(read-only)*

- **What it does:** Checks whether an asset is active
- **Returns:** `true` / `false`

---

#### `getAsset(assetId)` *(read-only)*

- **What it does:** Returns full asset information (metadataHash, token, active, registeredAt, owner)

---

#### `getProductInfo(assetId)` *(read-only)*

- **What it does:** Returns the full `ProductInfo` struct recorded at registration — `{productName, annualYieldRateBps, maturityTimestamp, issuer, underlyingAsset}` — in a single call, rather than requiring the front end/SDK to reconstruct it from event logs
- **Returns:** Zero-valued struct if `assetId` was never registered
- **When to use:** Displaying product terms in front end/SDK, or any other on-chain contract needing to read another asset's yield/maturity/issuer without a separate off-chain lookup

---

#### `mintBurnController()` *(read-only)*

- **What it does:** Returns the address of the `MintBurnController` this registry deployed for itself at construction
- **When to use:** Confirming which controller instance governs mint/burn approvals for all assets under this registry

---

### NAVOracle

Standalone, token-keyed EIP-712 price oracle — keyed by `rwaToken` address, not by Vault. Anyone may relay an `updateNAV` write as long as it carries the registered signer's EIP-712 signature for that `rwaToken`. There is no Vault, StateManager, or AssetRegistry dependency here at all: `RWAAdapter` reads prices from this oracle by `rwaToken` address only, and the token being priced need not even be a HyperTessera-issued RWA Token. The oracle has a single `owner` (set at construction, transferable) who registers/rotates the authorized signer per token. There is no on-chain staleness/freshness check — that is an off-chain monitoring concern.

---

#### `updateNAV(rwaToken, price, dataTimestamp, signature)`

- **What it does:** Submits a new price reading for `rwaToken`
- **Caller:** Anyone (permissionless relay) — the EIP-712 `signature` must recover to that token's registered signer
- **Parameters:**
  - `rwaToken`: RWA Token address the reading is for
  - `price`: 1e18-scale value of one whole `rwaToken`, denominated in one whole asset unit
  - `dataTimestamp`: off-chain source timestamp (not block time)
  - `signature`: EIP-712 signature over `NAVUpdate(rwaToken, price, dataTimestamp)` by the token's registered signer
- **When to use:** Submitted by the RWA issuer's off-chain price feed whenever a new valuation is available
- **Failure:**
  - `rwaToken` is the zero address → revert (`ZeroAddress`)
  - Signature doesn't recover to the token's registered signer, or no signer is registered at all → revert (`UnauthorizedSigner`)
  - `price == 0` → revert (`InvalidNAV`)
  - `dataTimestamp` is in the future → revert (`FutureData`)
  - `dataTimestamp` is not strictly greater than the previous reading's → revert (`NonMonotonicTimestamp`)
  - Price moves upward by more than `navDeviationMaxBps` versus the last reading → revert (`DeviationTooHigh`); downward moves are never blocked, and the very first reading for a token is exempt

---

#### `setNAVDeviationMaxBps(newBps)`

- **What it does:** Updates the maximum allowed upward price-deviation, in basis points, that `updateNAV` will accept versus the previous reading. **Owner-configurable, no upper bound** (was a fixed 20% protocol constant before 2026-08)
- **Caller:** The oracle's `owner`
- **When to use:** Loosening/tightening the deviation guard as market conditions or asset volatility change
- **Failure:** Non-owner caller → revert; `newBps == 0` → `ZeroDeviationBps`

---

#### `setSigner(rwaToken, signer)` / `removeSigner(rwaToken)`

- **What it does:** Sets / clears the authorized signing address for a `rwaToken`
- **Caller:** The oracle's `owner`
- **When to use:** Key rotation, onboarding a new price feed for a token
- **Failure:** Non-owner caller → revert; (`setSigner`) `rwaToken` or `signer` is the zero address → revert

---

#### `transferOwnership(newOwner)`

- **What it does:** Transfers ownership of the oracle to a new address
- **Caller:** The oracle's current `owner`
- **Failure:** Non-owner caller → revert; `newOwner` is the zero address → revert

---

#### `getNAV(rwaToken)` / `getPriceData(rwaToken)` / `signerOf(rwaToken)` / `owner()` *(read-only)*

- **What it does:** Returns the latest `(price, updatedAt)` / the full `PriceData` struct (`price`, source `dataTimestamp`, on-chain `updatedAt`) / the token's currently registered signer / the oracle's owner

---

### MintBurnController

Controls RWA Token minting and burning with a two-step approval flow, scoped per `assetId`: that asset's Issuer (its `AssetRegistry` owner) initiates, and that asset's Token Agent (appointed by the Issuer) approves and executes. There is no longer a signature parameter on `initiate`/`approve` calls — authorization comes entirely from `msg.sender` matching the asset's Issuer or Token Agent.

---

#### `initiateMint(assetId, amount, to)`

- **What it does:** Initiates a mint request (step 1)
- **Caller:** That asset's Issuer
- **Parameters:**
  - `assetId`: RWA Token type to mint
  - `amount`: quantity to mint
  - `to`: recipient address
- **Returns:** `nonce` (request identifier for subsequent approval)
- **Failure:** Non-Issuer caller → revert; `amount == 0` → revert; asset is not active → revert

---

#### `approveMint(nonce)`

- **What it does:** Token Agent approves the mint (step 2); tokens are minted to the recipient immediately on approval
- **Caller:** That request's asset's Token Agent
- **Failure:** Non-Token-Agent caller → revert; request doesn't exist → revert; already executed → revert

---

#### `initiateBurn(assetId, amount, from)` / `approveBurn(nonce)`

- **What it does:** Two-step flow for burning RWA Tokens (symmetric to mint) — Issuer initiates, Token Agent approves and executes
- **Caller:** `initiateBurn` → that asset's Issuer; `approveBurn` → that asset's Token Agent
- **When to use:** Burning tokens when the underlying RWA matures or is redeemed
- **Failure:** `initiateBurn`: non-Issuer caller → revert; `amount == 0` → revert; `from`'s balance is insufficient → revert. `approveBurn`: non-Token-Agent caller → revert; request doesn't exist or already executed → revert

---

#### `setTokenAgent(assetId, agent)`

- **What it does:** Appoints (or replaces) the Token Agent for an asset
- **Caller:** That asset's Issuer
- **When to use:** Onboarding or rotating the address that co-signs mint/burn approvals for an asset
- **Failure:** Non-Issuer caller → revert; `agent` is the zero address → revert

---

### RWAToken

The RWA Token contract, implementing a lightweight ERC-1400 subset: ERC-1594 (controller mint/burn) + transfer path restriction. (ERC-1644 forced transfer was removed 2026-08-17 — see `controllerTransfer` below.) One contract is deployed per asset by `AssetRegistry.registerAsset`. Its `MintBurnController` is now fixed permanently at construction (no setter). Transfer-path and address-list management, previously handled by a global compliance role, is now gated to that specific asset's Issuer.

---

#### `transfer(to, amount)` / `transferFrom(from, to, amount)`

- **What it does:** Transfers RWA Tokens between addresses, subject to two independent gates — whitelist membership and transfer-path rules — controlled separately by `whitelistEnabled` and `transferPathEnabled` (see below). `mint`/`burn` are not subject to either gate
- **Caller:** Any holder (with sufficient allowance for `transferFrom`)
- **Failure:**
  - `whitelistEnabled == true` and either `from` or `to` is not whitelisted → `NotWhitelisted`
  - `transferPathEnabled == true` and no configured transfer path allows the `from → to` combination → `TransferRestricted`
  - `transferPathEnabled == true` and zero transfer paths are configured → `NoTransferPathConfigured` (strict mode with no rules blocks by default, rather than falling open)
  - Insufficient balance/allowance → revert

---

#### `setWhitelistEnabled(enabled)` / `setTransferPathEnabled(enabled)`

- **What it does:** Independently turns the whitelist gate and the transfer-path gate on or off. Both default to `false` at deployment (old default-open behavior). Whitelist membership (who may hold) and transfer-path rules (who may send to whom) are two orthogonal controls — neither switch is inferred from whether a list/path happens to be empty
- **Caller:** This asset's Issuer
- **Event:** `WhitelistEnabledSet(enabled, timestamp)` / `TransferPathEnabledSet(enabled, timestamp)`
- **Failure:** Non-Issuer caller → revert

---

#### `addToWhitelist(accounts[])` / `removeFromWhitelist(accounts[])`

- **What it does:** Batch-adds or batch-removes addresses from the whitelist, stored in a mapping dedicated to this gate (deliberately separate from the `listId` address lists used by transfer paths, so the two controls cannot be re-coupled by reusing storage)
- **Caller:** This asset's Issuer
- **When to use:** Maintaining who may hold the token when `whitelistEnabled == true`
- **Event:** `WhitelistUpdated(added, count, timestamp)`
- **Failure:** Non-Issuer caller → revert

---

#### `isWhitelisted(account)` *(read-only)*

- **What it does:** Returns whether an address is currently on the whitelist

---

#### `setTransferPaths(indexes[], fromListIds[], toListIds[])`

- **What it does:** Batch-configures transfer path rules; each path allows transfers from any address in `fromListId` to any address in `toListId`
- **Caller:** This asset's Issuer
- **When to use:** Define or update the full set of permitted sender/recipient combinations (up to 10 paths)
- **Failure:** Non-Issuer caller → revert; array lengths mismatch → revert; a path index is out of range → revert

---

#### `addToAddressList(listId, accounts[])` / `removeFromAddressList(listId, accounts[])`

- **What it does:** Batch-adds or batch-removes addresses from a single address list
- **Caller:** This asset's Issuer
- **When to use:** Adding KYC-cleared addresses to a list referenced by transfer paths; removing addresses on compliance breach or account deactivation
- **Failure:** Non-Issuer caller → revert

---

#### `isInList(listId, account)` *(read-only)*

- **What it does:** Returns whether an address is in a given list
- **When to use:** Check eligibility before executing a transfer

---

#### ~~`controllerTransfer(from, to, amount, data)`~~ — **REMOVED 2026-08-17**

- **Status:** No longer part of the contract. It was gated on `MintBurnController`, but that contract never called it, so forced transfer was unreachable on-chain. The client flow spec requires no forced transfer, so it was removed instead of being wired up. Entry kept so readers of older docs/ABIs know where it went.
- **Was:** Controller-forced transfer, bypassing transfer path restriction; caller `MintBurnController` only; intended for compliance requirements, court orders, emergency recovery.
- **Still supported:** ERC-1594 controller `mint`/`burn` (below) and transfer path restriction.

---

#### `mint(to, amount)` / `burn(from, amount)`

- **What it does:** Controller-only mint/burn (invoked internally by `MintBurnController.approveMint`/`approveBurn`)
- **Caller:** `MintBurnController` only
- **Failure:** Non-controller caller → revert; burn amount exceeds balance → revert

---

#### `balanceOf(account)` / `totalSupply()` *(read-only)*

- **What it does:** Returns the token balance of an account / total token supply (standard ERC-20)

---

## Module D — Wrapped Assets

### ReservePSM

Independent asset wrap/unwrap module, fully decoupled from Vault / Settlement / StateManager / USDT settlement. Converts a restricted asset into a freely-transferable Wrapped Token ERC-20, in one of two independent modes configured per asset:

- **Token Custody Mode** — the underlying is an on-chain ERC-20 held in custody by the PSM. `wrap` pulls it 1:1 and mints the Wrapped Token; `unwrap` burns the Wrapped Token and returns the underlying 1:1.
- **Document Proof Mode** — there is no on-chain underlying. Minting requires an off-chain signature from the asset's authorized signer; `unwrap` burns the holder's full balance and emits `ReleaseRequested` as the on-chain trigger for an off-chain release.

---

#### `deployWrappedToken(assetId, mode, underlyingToken, name, symbol, decimals, allowPartialUnwrap)`

- **What it does:** Configures an asset's mode and deploys its circulating Wrapped Token ERC-20. Callable once per `assetId`; the caller becomes that asset's **Wrapper Controller** (permissionless — first caller wins per `assetId`; this is not tied to `AssetRegistry` ownership)
- **Caller:** Anyone (permissionless)
- **Parameters:**
  - `mode`: `TOKEN_CUSTODY` or `DOCUMENT_PROOF`
  - `underlyingToken`: the on-chain ERC-20 to custody (`TOKEN_CUSTODY` only; must be `address(0)` for `DOCUMENT_PROOF`)
  - `name`, `symbol`, `decimals`: parameters for the new Wrapped Token ERC-20
  - `allowPartialUnwrap`: whether `unwrap` may release less than a holder's full balance (`TOKEN_CUSTODY` only; forced to `false` for `DOCUMENT_PROOF`, which is always full-balance-only)
- **When to use:** Call once per asset after `AssetRegistry.registerAsset`, before `wrap`/`mintWithAuthorization` can be used for that asset
- **Failure:** Asset already configured → `AssetAlreadyConfigured`; `TOKEN_CUSTODY` with zero `underlyingToken`, or `DOCUMENT_PROOF` with a non-zero `underlyingToken` → `ZeroAddress` / `WrongAssetMode`

---

#### `setAuthorizedSigner(assetId, signer)`

- **What it does:** Sets the off-chain signer authorized to approve `mintWithAuthorization` calls for a `DOCUMENT_PROOF` asset
- **Caller:** That asset's Wrapper Controller
- **Failure:** Non-controller caller → `NotWrapperController`; asset is not `DOCUMENT_PROOF` mode → `WrongAssetMode`

---

#### `wrap(assetId, amount, to)`

- **What it does:** `TOKEN_CUSTODY` only. Pulls `amount` of the underlying token from the caller and mints the same amount of Wrapped Token 1:1 to `to` (measured by actual balance delta, so fee-on-transfer/rebasing underlyings can't over-mint)
- **Caller:** Anyone (permissionless)
- **Failure:** Asset not configured → `AssetNotConfigured`; asset is `DOCUMENT_PROOF` mode → `WrongAssetMode`; PSM or asset paused → `GloballyPaused` / `AssetIsPaused`

---

#### `mintWithAuthorization(assetId, amount, to, nonce, expiry, signature, documentId)`

- **What it does:** `DOCUMENT_PROOF` only. Mints `amount` of Wrapped Token to `to` against an off-chain signature from the asset's authorized signer over `(assetId, amount, to, nonce, expiry, address(this), chainId)`; the `documentId` is recorded and appended to `to`'s pending document list
- **Caller:** Anyone holding a valid signature from the authorized signer
- **Failure:** Asset not `DOCUMENT_PROOF` mode → `WrongAssetMode`; signature expired → `SignatureExpired`; nonce already used → `NonceAlreadyUsed`; signer mismatch → `InvalidSigner`; PSM or asset paused → `GloballyPaused` / `AssetIsPaused`

---

#### `unwrap(assetId, amount, to)`

- **What it does:** Unified unwrap entry point. `TOKEN_CUSTODY`: burns the caller's Wrapped Token and releases the underlying 1:1 to `to` (full-balance-only unless `allowPartialUnwrap` was set). `DOCUMENT_PROOF`: always full-balance-only — burns the caller's balance and emits `ReleaseRequested` (once per pending `documentId`) as the signal for an off-chain release to `to`
- **Caller:** Anyone (permissionless) — always burns from `msg.sender`'s own balance
- **Failure:** Partial amount requested where not allowed → `PartialUnwrapNotAllowed`; amount exceeds balance → `IncompleteUnwrap`; PSM or asset paused → `GloballyPaused` / `AssetIsPaused`

---

#### `pause()` / `unpause()`

- **What it does:** Halts / resumes `wrap`, `mintWithAuthorization`, and `unwrap` across every asset
- **Caller:** `GOVERNOR_ROLE`

---

#### `pauseAsset(assetId)` / `unpauseAsset(assetId)`

- **What it does:** Halts / resumes `wrap`, `mintWithAuthorization`, and `unwrap` for a single asset
- **Caller:** That asset's Wrapper Controller
- **Failure:** Non-controller caller → `NotWrapperController`

---

#### `wrappedTokenOf(assetId)` / `assetModeOf(assetId)` / `assetConfig(assetId)` / `controllerOf(assetId)` / `pendingDocumentIds(assetId, holder)` *(read-only)*

- **What it does:** Returns the deployed Wrapped Token address / configured mode / full `AssetConfig` struct / that asset's Wrapper Controller / the list of `documentId`s currently backing a holder's `DOCUMENT_PROOF` balance

---

### PoRRegistry

On-chain ledger for Proof of Reserve documents. Append-only — records cannot be modified or deleted. Publishing rights are now scoped per asset, delegated by that asset's Issuer.

---

#### `publishReserveProof(assetId, documentHash, uri)`

- **What it does:** Publishes a reserve proof document (hash + URI)
- **Caller:** That asset's owner, or the address that owner has designated as its Proof Publisher
- **Parameters:**
  - `documentHash`: keccak256 hash of the document content (integrity anchor); the SDK's `computeDocumentHash` helper computes this from the raw document bytes (same helper used for `AssetRegistry.metadataHash`)
  - `uri`: document access URL (HTTP URL or IPFS URI)
- **When to use:** Periodic publishing of audit reports and reserve proofs
- **Failure:** Asset is not active → revert; caller is neither the asset's owner nor its designated publisher → revert

---

#### `setProofPublisher(assetId, publisher)`

- **What it does:** Delegates (or clears delegation of) publishing rights for an asset to another address
- **Caller:** That asset's owner
- **When to use:** Assigning a dedicated ops address to publish proofs on the owner's behalf; pass the zero address to revoke delegation and fall back to owner-only publishing
- **Failure:** Non-owner caller → revert

---

#### `getLatestProof(assetId)` / `getProof(assetId, index)` / `getProofCount(assetId)` *(read-only)*

- **What it does:** Returns the latest / a specific-index reserve proof / the total number of proofs published for an asset
- **Failure:** No proof exists yet for the asset → revert; index out of range → revert

---

### ClaimRegistry

Append-only bookkeeping record of Vault deposit/redeem requests left unclaimed past their grace period. This is a record-keeping module only — it does not move funds. Recording is gated to that Vault's own **Curator** (or the Vault contract itself) — **changed from Keeper to Curator** in the 2026-08 RBAC audit fixes, since claim registration is product-operations work, not automated state-advancement.

**`StateManager` is a constructor immutable** (RBAC G-08 — ClaimRegistry has no runtime configuration role at all), which is why it is deployed after StateManager in W3. The former Governor-gated `setStateManager(stateManager)` **no longer exists**.

---

#### `recordClaim(vault, owner, requestId, assets, kind)`

- **What it does:** Records that a deposit refund or redemption payout was left unclaimed for a given request
- **Caller:** That vault's Curator, or the vault contract itself
- **Parameters:**
  - `kind`: `DEPOSIT_REFUND` or `REDEEM_PAYOUT`
- **Returns:** `claimId`
- **When to use:** Ops sweep flagging stale unclaimed requests for follow-up
- **Failure:** `vault`/`owner` is the zero address → revert; caller is neither the vault's Curator nor the vault itself → revert; `StateManager` hasn't been wired yet → revert; `vault` isn't a registered vault → revert

---

#### `BaseVault.configureClaimRegistry(registry, gracePeriod)`

- **What it does:** Wires the ClaimRegistry address and the post-maturity grace period that `recordOverdueClaims` enforces. `registry == address(0)` disables registration
- **Caller:** That Vault's own `VaultTimelock` (OWNER action class; direct Owner call while still `CONFIGURING`)
- **When to use:** Post-deploy wiring, alongside `setSettlement` / `setUnifiedPool`

---

#### `BaseVault.recordOverdueClaims(requestIds)`

- **What it does:** Records requests still unclaimed past `maturityTimestamp + claimGracePeriod` into the Vault's ClaimRegistry. This is the on-chain caller `recordClaim` previously lacked (Audit Feedback V2 #11) — its `msg.sender == vault` branch was dead, leaving the backstop register dependent on the Curator acting by hand
- **Caller:** Anyone. The record moves no funds and changes no request state, so registration is deliberately permissionless
- **Scope:** Deposit requests in `SETTLED`/`REFUNDABLE` and redeem requests in `SETTLED` — exactly the states holding a balance the owner hasn't taken. Every other id in the batch (terminal, unsettled, non-existent) is skipped rather than reverting the batch
- **De-dup:** `claimRecorded[requestId]` makes repeat calls a no-op instead of a duplicate entry
- **Failure:** Registry not wired → `ClaimRegistryNotConfigured`; called before `maturityTimestamp + claimGracePeriod` → `ClaimGracePeriodNotElapsed(dueFrom)`

---

#### `getClaim(claimId)` / `getClaimsByVault(vault)` / `getClaimCount()` *(read-only)*

- **What it does:** Returns a specific claim record / all claim IDs recorded for a vault / the total number of claims recorded
- **Failure:** `getClaim` on a non-existent `claimId` → revert

---

## Module C — Settlement Infrastructure

### UnifiedPool

The ledger contract that tracks how much USDT the protocol owes each Vault (`pending[vault]`). Any address may deposit interest or principal into the pool, but that money now lands in a shared **unattributed pool** first (`unattributedInterest` / `unattributedPrincipal`) rather than being credited straight to a Vault — attributing it to a specific Vault's `pending` balance is a separate, permissioned step performed by that Vault's own Settlement Operator. `pending[vault]` remains a promissory note: the actual USDT balance held by the contract may not equal the sum of all pending amounts at any moment, and Settlement/distribution always verify sufficient cash on hand.

---

#### `addVault(vault)` / `deactivateVault(vault)` / `reactivateVault(vault)`

- **What it does:** Registers a Vault so it can receive attributions and distributions / stops it from receiving new inflows without clearing its existing pending balance / re-enables it
- **Caller:** That Vault's Owner — and `vault` must be registered in `StateManager`
- **When to use:** Once when a Vault first goes live; deactivate/reactivate for planned wind-down or reinstatement
- **Changed 2026-08-26 (《合约修复20260825》):** these were `addTrancheVault(tranche, vault)` / `deactivateTrancheVault` / `reactivateTrancheVault`. Fund pooling, receivable bookkeeping and settlement distribution were always keyed by Vault address; the tranche label never took part in fund math, authorization or settlement routing, so it only risked mis-registering a vault's type and limited product expansion. The `Tranche` enum, `vaultTranche`, `isTrancheVault` and `getTrancheVaults` are **removed**, and the events dropped their tranche field. Product type, if it needs displaying, lives in product params / the Indexer / frontend metadata
- **Failure:** `addVault`: `vault` is the zero address → revert; `vault` is not a StateManager-registered vault → `UnregisteredVault` (2026-08-24: every UnifiedPool entry point taking a `vault` argument checks this, because authority here is resolved by asking `vault` about itself); already configured → revert. `deactivateVault`/`reactivateVault`: vault not configured → revert; deactivating an already-inactive vault → revert (reactivating an already-active vault is a harmless no-op)

---

#### `writeDownPending(vault, amount, referenceId)`

- **What it does:** Writes down a Vault's `pending` receivable when an external investment takes a permanent loss, so the loss leaves the Vault's NAV
- **Caller:** That Vault's own `VaultTimelock` — recognizing a loss is a governance act and must pass through the delay queue, same as `BaseVault.writeDownInsolvency`
- **Why it exists (2026-08-26, 《HyperTessera 审计报告一反馈》):** `distribute` used to be the *only* path that reduced `pending`, and it reduces it against an actual payment. UnifiedPool's value is determined directly by `pending` (visible from `BaseVault.grossManagedAssets`), and the valuation/impairment machinery lives only in the Adapters — so a permanent loss on an externally-invested position had no way to reach the ledger and would have stayed in the share price forever
- **Failure:** `vault` not registered → `UnregisteredVault`; caller is not that Vault's VaultTimelock → `NotVaultTimelock`; `amount == 0` → revert

---

#### `repayInterest(amount)` / `repayPrincipal(amount)`

- **What it does:** Deposits USDT into the pool's shared unattributed interest / principal balance
- **Caller:** Anyone — fully permissionless; there is no longer a vault argument, and the funds are **not** credited to any specific Vault's `pending` by this call alone
- **When to use:** Each settlement cycle, ahead of attributing the funds to specific Vaults via `attributeInterest`/`attributePrincipal`
- **Failure:** `amount == 0` → revert

---

#### `attributeInterest(vault, amount)` / `attributePrincipal(vault, amount)`

- **What it does:** Moves previously-deposited unattributed interest/principal into a specific Vault's `pending` balance
- **Caller:** That Vault's Settlement Operator
- **When to use:** After `repayInterest`/`repayPrincipal` has topped up the shared pool, to earmark funds for a particular Vault ahead of settlement
- **Failure:** Non-operator caller → revert; `amount == 0` → revert; vault not configured or inactive → revert; requested amount exceeds what's currently unattributed → revert

---

#### `receiveVaultPrincipal(amount)`

- **What it does:** Pulls `amount` USDT from the calling (registered) Vault and credits it directly to that **same** vault's own pending balance (immediate self-attribution). **Renamed and generalized from `receiveNotePrincipal(targetVault, amount)`** — the old version could only route principal to a Note-tranche vault on the caller's behalf; this version has no `targetVault` argument at all, and any registered vault (not just Note-tranche) can call it to credit itself directly
- **Caller:** Any registered, Governor-whitelisted Vault contract, crediting only its own pending balance — typically invoked internally via `BaseVault.returnPrincipalToPool`
- **Failure:** Caller isn't a registered vault → revert; `amount == 0` → revert; caller vault isn't configured/active → revert; caller vault or its current `settlement()` isn't whitelisted → `VaultNotWhitelisted` / `SettlementNotWhitelisted`

---

#### `distribute(vault, amount)`

- **What it does:** Transfers USDT from `pending[vault]` out to the Vault contract
- **Caller:** That Vault's own bound Settlement contract only, which must additionally be on the Governor Settlement whitelist, with `vault` on the Governor Vault whitelist (审计反馈 V3 #1)
- **Failure:** Vault not configured → revert; vault not whitelisted → `VaultNotWhitelisted`; its Settlement not whitelisted → `SettlementNotWhitelisted`; `amount` exceeds `pending[vault]` → revert; pool doesn't hold enough cash → revert

---

#### `operatorTransfer(vault, recipient, amount, referenceId)` / `operatorTransferToRevenuePool(vault, revenuePool, amount, referenceId)`

- **What it does:** Transfers pool cash to a third-party recipient / to a RevenuePool (recording it there as a fee). Does **not** touch `pending[vault]` — `pending` is a claim on pool-*managed* assets, and moving cash into an authorised external position changes the form of those assets without extinguishing the claim
- **Caller:** `GOVERNOR_ROLE` — and `vault` must still be a StateManager-registered vault
- **Parameters:** `vault` — the accounting reference the transfer is booked against, for off-chain reconciliation; it is no longer what authorises the call. `referenceId` — an off-chain reference tag recorded in the emitted event
- **When to use:** Governance-directed cash movements tied to a specific Vault's position
- **Changed 2026-08-28 (审计反馈 V3 #1):** moved from that Vault's Settlement Operator to `GOVERNOR_ROLE`. These two are the only paths that take cash out of the pool without a matching ledger movement, so whoever can call them can drain the shared cash backing every Vault. A Settlement Operator key is an online per-Vault signing key; a stolen one must not reach here. The Operator keeps attribution, settlement signing and the normal settlement flow — everything that stays inside the ledger
- **Failure:** Non-Governor caller → `NotGovernor`; `vault` not registered → `UnregisteredVault`; recipient is the zero address → `InvalidRecipient`; `amount == 0` → `ZeroAmount`; recipient is one of that Vault's own Adapters → `RecipientIsVaultAdapter`

---

#### `setVaultWhitelisted(vault, allowed)` / `setSettlementWhitelisted(settlement, allowed)`

- **What it does:** Admits (or removes) a Vault from the shared pool / trusts (or untrusts) a Settlement contract for pool operations
- **Caller:** `GOVERNOR_ROLE`
- **When to use:** Every Vault that should use this pool needs both — itself whitelisted, and whatever Settlement it points at whitelisted. `attributeInterest`, `attributePrincipal`, `receiveVaultPrincipal` and `distribute` all check both
- **New 2026-08-28 (审计反馈 V3 #1/#2):** `VaultFactory.deployVault` stays permissionless on purpose — being built from the standard contracts is not protocol endorsement and must not by itself confer access to shared cash. Governance controls admission to the pool rather than who may create a Vault. Two lists rather than one because a whitelisted Vault can re-point `settlement()` at any time, which would otherwise let it swap in an attacker-controlled Settlement and appoint arbitrary Operators. Several Settlement addresses may be whitelisted at once so a new implementation rolls out alongside the old
- **Failure:** Non-Governor caller → `NotGovernor`; zero address → `ZeroAddress`

---

#### `pending(vault)` / `totalPending()` / `availableToDistribute(vault)` / `vaultConfigured(vault)` / `vaultActive(vault)` / `vaultWhitelisted(vault)` / `settlementWhitelisted(settlement)` *(read-only)*

- **What it does:** The current `pending` amount owed to a Vault / the sum of `pending` across all vaults / the smaller of `pending[vault]` and the pool's actual cash balance (an informational cap, not a reservation) / whether the vault has been registered / whether it is currently active for new inflows
- **Removed 2026-08-26:** `getTrancheVaults(tranche)`, `vaultTranche(vault)` and `isTrancheVault(tranche, vault)` — see `addVault`

---

### RevenuePool

Aggregates protocol revenue from all authorized sources. Unchanged by the RBAC redesign — still a flat, `GOVERNOR_ROLE`-administered allowlist of authorized fee sources, with Governor controlling withdrawals. **New (2026-08):** also accepts native currency directly (plain transfers via `receive()`) — this is where `AssetRegistry`/`VaultFactory` forward `Native`-kind creation fees (see [ProtocolFeeConfig](#protocolfeeconfig)) — and can hold/sweep arbitrary ERC-20s (e.g. Vault Shares minted here as protocol performance fee, see `BaseVault.setProtocolFeeConfig`), distinct from the original USDT-only `withdraw`.

---

#### `receiveFee(amount)`

- **What it does:** Records an incoming fee. The caller must have already transferred `amount` USDT to this contract — this call verifies the contract's balance covers the claim and updates `totalFeesReceived`; it does not itself pull funds
- **Caller:** Any address authorized by Governor (`authorizedSources`)
- **When to use:** `UnifiedPool.operatorTransferToRevenuePool` calls this automatically after transferring USDT in; other authorized product contracts may call it after being added as a source
- **Failure:** Caller not in `authorizedSources` → `UnauthorizedFeeSource`; contract's USDT balance is below `amount` → `InsufficientBalance`

---

#### `addAuthorizedSource(source)` / `removeAuthorizedSource(source)`

- **What it does:** Adds / removes an authorized fee-source address
- **Caller:** `GOVERNOR_ROLE`
- **Failure:** `addAuthorizedSource` with `source == address(0)` → `ZeroAddress`

---

#### `withdraw(recipient, amount)`

- **What it does:** Transfers `amount` USDT from RevenuePool to `recipient`
- **Caller:** `GOVERNOR_ROLE`
- **When to use:** Periodic transfer of protocol revenue to the operations wallet
- **Failure:** Contract's USDT balance is below `amount` → `InsufficientBalance`

---

#### `withdrawToken(token, to, amount)`

- **What it does:** Transfers `amount` of an arbitrary ERC-20 `token` held by RevenuePool to `to` — for sweeping Vault Shares (minted here as a share of each cycle's performance fee, see `BaseVault.setProtocolFeeConfig`) or any other non-USDT ERC-20; distinct from `withdraw`, which is USDT-specific
- **Caller:** `GOVERNOR_ROLE`
- **When to use:** Periodic sweep of accrued Vault Share fees to an operations/treasury wallet

---

#### `withdrawNative(to, amount)`

- **What it does:** Transfers `amount` of the chain's native currency (BNB/ETH) held by RevenuePool to `to`
- **Caller:** `GOVERNOR_ROLE`
- **When to use:** Periodic sweep of `Native`-kind creation fees (see [ProtocolFeeConfig](#protocolfeeconfig)) or any other native currency the pool has received
- **Failure:** Non-Governor caller → `NotGovernor`; underlying transfer fails → `NativeTransferFailed`

---

#### `receive()`

- **What it does:** Accepts plain native-currency transfers with no restriction — this is how `Native`-kind creation fees land in RevenuePool
- **Caller:** Anyone

---

#### `setYieldStrategy(strategy)`

- **What it does:** Records the address of a future yield-deployment strategy for idle funds. This is a **Phase 1 interface reservation only** — it is a no-op that does not move funds or call into `strategy`; a later phase will implement the actual deploy/recall logic
- **Caller:** `GOVERNOR_ROLE`

---

#### `authorizedSources(source)` / `totalFeesReceived()` / `yieldStrategy()` *(read-only)*

- **What it does:** Checks whether an address is an authorized fee source / returns cumulative fees received / returns the currently-recorded (currently unused) yield strategy address

---

#### `authorizedSourceCount()` / `authorizedSourcesPaged(offset, limit)` *(read-only)*

- **What it does:** Enumerates the addresses currently authorized to deposit fees. `authorizedSources(source)` answers *"may this address deposit fees?"*; these answer *"who may?"*, otherwise recoverable only by replaying `SourceAuthorized` / `SourceRevoked` and reconstructing the surviving set by hand
- **Paging:** Clamps rather than reverts — an `offset` at or past the end returns an empty array and an overlong `limit` returns a short page
- **Note:** The exact **live** set, not an "ever authorized" history — a revoked source leaves the list. Ordering is therefore **not stable**: `removeAuthorizedSource` swaps the last entry into the freed slot and pops. Pin a single `blockTag`

---

### Queue

Maintains on-chain FIFO queues used to validate ordering during settlement. Each vault has **two independent queues** — `QueueType.Deposit` and `QueueType.Redeem` — so deposit-request ordering and redeem-request ordering are tracked separately. Clearing calculations (which requests can be settled in this cycle) are performed off-chain; this contract only anchors and validates ordering on-chain. Cancelled slots are marked with a tombstone (`requestId = type(uint256).max`) rather than removed, so the queue array is never shifted.

> **Update (2026-07-01):** the LP Vault redesign removed USDT-based LP redemption entirely — LP Vault now holds and distributes Cash Tokens directly (see [LiquidityEarnVault](#liquidityearnvault)), so there is no longer a cross-vault priority rule to enforce here. The `priorityVault` / `PriorityViolation` mechanism described in earlier drafts of this document no longer exists. LP priority (where relevant) is enforced at the Settlement layer, not in Queue.

---

#### `enqueue(vault, queueType, requestId, owner, amount)`

- **What it does:** Appends a request to `vault`'s `queueType` queue and stores an `orderHash` (hash of `requestId`, `owner`, `amount`, and the enqueue timestamp) for later on-chain verification
- **Caller:** Must be `vault` itself, and `vault` must be a registered vault (checked via `StateManager`) — triggered automatically when a user calls `requestDeposit`/`requestRedeem`
- **Failure:** `vault` not registered → `UnregisteredVault`; caller isn't `vault` → `UnregisteredVault`

---

#### `dequeue(vault, queueType, requestIds[])`

- **What it does:** During settlement, removes processed requests from the front of `vault`'s `queueType` queue, one at a time, in the exact order passed in
- **Caller:** That vault's own bound Settlement contract
- **Failure:** Caller isn't that vault's Settlement contract → revert; tombstoned entries at the head are auto-skipped; if the next non-tombstoned head doesn't match the next `requestId` passed in → `OutOfOrderDequeue`

---

#### `remove(vault, queueType, requestId)`

- **What it does:** Marks a pending request as a tombstone in `vault`'s `queueType` queue (the slot stays in place; `dequeue` skips over it)
- **Caller:** Must be `vault` itself, and `vault` must be a registered vault — triggered automatically when a user calls `cancelRequest`
- **Failure:** Caller isn't `vault` → `UnregisteredVault`; `vault` not registered → `UnregisteredVault`; `requestId` not currently in the queue → `NotInQueue`

---

#### `peek(vault, queueType)` / `depth(vault, queueType)` / `isInQueue(vault, queueType, requestId)` *(read-only)*

- **What it does:** Returns the slot at the head of the queue (may be a tombstone) / the number of slots between head and tail (tombstones included) / whether a given request is currently queued (not tombstoned)

---

#### `verifyOrder(vault, queueType, requestId, owner, amount, timestamp)` *(read-only)*

- **What it does:** Recomputes the `orderHash` from the given parameters and compares it to the one stored at enqueue time, returning `true` if they match
- **When to use:** Off-chain verification that a request's recorded queue position matches its original enqueue parameters

---

### Settlement

Translates an operator-approved, off-chain-computed settlement batch into on-chain execution: dequeuing the FIFO requests, releasing pool cash, snapshotting each Vault's settlement price, minting/burning shares, and advancing each Vault's cycle. A single Settlement contract may serve many Vaults; each Vault's operator set and signature threshold is independent and managed entirely by that Vault's own Owner.

---

#### `submitBatch(instruction, signatures)`

- **What it does:** Executes a batch of vault settlements in one transaction — validates operator signatures and on-chain state per Vault, checks pool cash is sufficient, then for each Vault: dequeues every deposit request in the batch (deposits always fully resolve — see `BaseVault.settle`), releases pool funds, snapshots price, settles deposits/redemptions via `BaseVault.settle`, dequeues **only** the redeem ids `settle()` reports as `fullyClearedRedeemIds` (a partially-filled redeem is left at the Queue's FIFO head, untouched, for a future cycle — see 2026-08-05 partial settlement), and completes the cycle
- **Caller:** Anyone — permissionless; security comes from the M-of-N operator signature check performed independently for each Vault in the batch, not from `msg.sender`
- **When to use:** Every settlement cycle, once the off-chain FIFO-prefix selection for a batch — and, since 2026-08-05, each request's per-cycle accepted amount — has been computed and signed off by that Vault's designated operators
- **FIFO constraint:** within a single vault's redeem batch, `Queue.dequeue` is strict FIFO-from-head — if a redeem request is only partially filled, it must be the **last** redeem entry included for that vault in this batch; anything queued after it (even if fully cleared) can't also be included, or the batch reverts with `Queue.OutOfOrderDequeue`
- **Failure:**
  - This exact batch has already been executed → revert
  - Batch has passed its `validUntil` expiry → revert
  - Fewer valid operator signatures than that Vault's configured threshold, or the Vault has no threshold configured at all (an unconfigured Vault is never settleable — a zero threshold is rejected outright rather than treated as "no signatures needed") → revert
  - A Vault in the batch isn't currently in the `CALCULATING` cycle state, or the cycle number doesn't match → revert
  - A Vault's requested distribution exceeds what's actually available to it in `UnifiedPool` → revert
  - The batch's total distribution exceeds `UnifiedPool`'s actual cash balance → revert

---

#### ~~`confirmFinalSettlement(vault, signatures)`~~ — **removed 2026-08-26**

The whole duplicate-confirmation chain (`Settlement.confirmFinalSettlement`,
`hashFinalSettlementConfirmation`, `StateManager.completeFinalSettlement`,
`isFinalSettlementComplete`, `enterMaturing`) was deleted by
《最终周期结算及最终兑付补充修改方案》. The final batch is already protected by the same M-of-N
signature check as any other batch, so confirming it a second time was a redundant mechanism.
`SETTLING → MATURING` now happens atomically inside the final cycle's `completeCycle`, and that is
`SETTLING`'s only exit. See `StateManager.startCycleCalculation` / `completeCycle`.

---

#### `setOperator(vault, operator, approved)`

- **What it does:** Adds or removes an address from the set of signers authorized to co-sign that Vault's settlement batches
- **Caller:** That Vault's Owner
- **Failure:** Non-owner caller → revert; `operator` is the zero address → revert; removing an operator would drop the operator count below the vault's currently configured signature threshold → revert

---

#### `setThreshold(vault, newThreshold)`

- **What it does:** Sets the minimum number of operator signatures required to execute a settlement batch for a Vault
- **Caller:** That Vault's Owner
- **Failure:** Non-owner caller → revert; threshold is zero or exceeds the current operator count → revert

---

#### `operatorCount(vault)` / `operatorsPaged(vault, offset, limit)` *(read-only)*

- **What it does:** Enumerates a Vault's current settlement signers. `isOperator(vault, address)` answers *"is this address a signer?"*; these answer *"who are the signers?"*. The generated getter for the public `operatorsOf` mapping-to-array exposes no `.length`, and unlike `BaseVault.adapters` there is no `MAX_` constant bounding a probe, so the signer set was otherwise recoverable only by replaying `OperatorSet` logs
- **When to use:** Any settlement dashboard showing M-of-N status. `operatorCount` is the same figure `setThreshold` validates against
- **Paging:** `operatorsPaged` clamps rather than reverts — an `offset` at or past the end returns an empty array and an overlong `limit` returns a short page, so you can page without reading `operatorCount()` first
- **Note:** Ordering is **not stable** — revoking an operator swaps the last entry into the freed slot and pops. Pin a single `blockTag` across the count and the pages that follow it

---

#### `isOperator(vault, address)` / `threshold(vault)` / `executed(batchHash)` / `hashInstruction(instruction)` *(read-only)*

- **What it does:** Checks whether an address is an approved operator for a Vault / returns a Vault's signature threshold / checks whether a batch hash has already been executed / computes the hash of a settlement instruction for off-chain signing

---

## Module B — Vault Infrastructure

> **Redesign note (2026-07):** the Vault architecture no longer prices shares from an off-chain NAV push. Share price is now computed on-chain from `totalAssets()/totalSupply()`, snapshotted once per cycle. Settlement batches are net-settled against that snapshot, a Morpho-style performance fee (High-Water Mark) accrues automatically, external capital deployment is tracked through a pluggable Adapter system, and an on-chain insolvency write-down path exists for loss events. The sections below describe the current implementation; anything referencing `setSharePrice`, `navOracle` wiring on Vaults, or a `settle(... redeemAmounts[], distributedAssets, navSnapshot)` signature has been superseded.
>
> **Redesign note (2026-08-05):** `EarnVault`'s `settle()` no longer treats each deposit/redeem request as strictly all-or-nothing. See `BaseVault.settle` below for the full partial-settlement behavior; `LiquidityEarnVault` accepts partial deposit fills too, refunding the unaccepted remainder in the same call — see its `settle()` below.

### StateManager

The three-layer state machine that gates every Vault action. Each registered Vault has its own independent state made of three orthogonal layers:

- **Product state** — the overall lifecycle: `CONFIGURING → SUBSCRIBING → (FUNDING_FAILED | OPERATING) → SETTLING → MATURING → CLAIMING → CLOSED`
- **Cycle state** — the per-cycle micro-state while `OPERATING`: `ACCEPTING → CALCULATING → FULFILLING → COMPLETED → (back to ACCEPTING)`
- **Pause state** — an orthogonal emergency circuit-breaker: `ACTIVE | PAUSED_BY_GUARDIAN`, independent of product/cycle

Vaults call into StateManager on every state-sensitive action (deposit, redeem, settle) — it is the single source of truth other contracts defer to. Nearly every lifecycle transition here is now driven by that specific Vault's own Keeper (and pause/unpause by that Vault's own Guardian/Owner) rather than a global role — `HyperAccessControl`'s `GOVERNOR_ROLE` is only used for the one-time factory wiring and the protocol-wide module pause switch described below.

---

#### `setVaultFactory(factory)`

- **What it does:** Wires the one `VaultFactory` instance allowed to register new vaults
- **Caller:** `GOVERNOR_ROLE`, and only once ever — there is no re-wiring path
- **Failure:** Already set → revert; `factory` is the zero address → revert

---

#### `registerVault(vault)`

- **What it does:** Registers a Vault. Its initial three-layer state is fixed at `CONFIGURING` / `ACCEPTING` / `ACTIVE` — as of 2026-08-24 it is no longer taken from the caller, so the "single-direction from `CONFIGURING`" invariant cannot be bypassed at registration
- **Caller:** The wired `VaultFactory` only — called automatically as part of `VaultFactory.deployVault`
- **Failure:** Caller isn't the wired factory → revert; already registered → revert

---

#### `setProductParams(vault, params)`

- **What it does:** Sets a Vault's lifecycle and fee parameters — the 10 `ProductParams` fields, in order: `subscriptionStart`, `subscriptionEnd`, `walletSubscriptionCap`, `minRaiseAmount`, `subscriptionCapShare`, `cycleDuration`, `maturityTimestamp`, `claimingStart`, `claimingEnd` (the earliest point `closeProduct` may be called), and `feeParams`. It also writes `subscriptionCapShare` straight into the Vault, which stays the authoritative value settlement reads
- **Caller:** That Vault's Curator — there is no longer a Governor bootstrap path
- **When to use:** Once per Vault, before `openSubscription`
- **Failure:** Non-Curator caller → revert; product state is not `CONFIGURING` → revert; an unset or inconsistent parameter set → `InvalidProductParams(field)` (`subscriptionEnd ≤ subscriptionStart`, `cycleDuration == 0`, `maturityTimestamp < subscriptionEnd`, `claimingStart < maturityTimestamp`, `claimingEnd < claimingStart`). `walletSubscriptionCap`, `subscriptionCapShare` and `minRaiseAmount` may all be `0` — they mean uncapped / no minimum
- **Changed 2026-08-24:** `firstCycleStart` was removed (it never gated cycle 0, which starts as soon as the raise succeeds) and `subscriptionCapShare` took its slot. This is a breaking ABI change to both `setProductParams` and `getParams`

---

#### `openSubscription(vault)`

- **What it does:** Opens the fundraising window (`CONFIGURING → SUBSCRIBING`, requires `now ≥ subscriptionStart`)
- **Caller:** That Vault's Keeper. There is **no** implicit grant — the Owner is not automatically a Keeper and must explicitly call `setKeeper(account, true)` to grant itself or any other address Keeper access
- **When to use:** Driven automatically by the KeeperBot once `subscriptionStart` has been reached
- **Failure:** Product state isn't `CONFIGURING` → revert; `subscriptionStart` hasn't been reached yet → revert

---

#### `finalizeSubscription(vault)`

- **What it does:** Closes the initial fundraising window and routes the Vault into `OPERATING` if the raise met `minRaiseAmount`, otherwise into `FUNDING_FAILED`. **On a successful raise, this now also forces the Vault's cycle state straight into `CALCULATING`** (instead of leaving it at `ACCEPTING` as earlier versions did) — this immediately closes new subscribe/redeem requests for cycle 0, so Settlement can run its normal `snapshotSettlementPrice` → `settle` → `completeCycle` flow right away and mint shares for every subscriber from the initial raise at the standard zero-supply 1 USDT : 1 share price, rather than making that first cohort wait out an entire cycle duration before they see any shares
- **Caller:** That Vault's Keeper
- **When to use:** Driven automatically by the KeeperBot once `subscriptionEnd` has passed
- **Failure:** Non-Keeper caller → revert; product state isn't `SUBSCRIBING` → revert; `subscriptionEnd` hasn't been reached yet → revert

---

#### `startCycleCalculation(vault)`

- **What it does:** Closes a cycle's deposit/redeem window (`ACCEPTING → CALCULATING`)
- **Caller:** That Vault's Keeper
- **When to use:** Every cycle boundary. Two independent triggers: a **normal** cycle is due once `cycleDuration` has elapsed since the previous cycle actually completed; the product's **final** cycle is due as soon as `now ≥ maturityTimestamp`, regardless of how much of the normal cycle has run
- **Changed 2026-08-26 (《最终周期结算及最终兑付补充修改方案》):** when the final trigger fires, this call performs `OPERATING→SETTLING` **and** `ACCEPTING→CALCULATING` in the same transaction and marks the cycle final — the final cycle now runs in `SETTLING / CALCULATING`. There is no block in which the product is in `SETTLING` with no executable cycle, or a cycle is running while new business is still accepted
- **Why the second trigger (2026-08-24):** cycle 0's initial settlement completes at an arbitrary point after `subscriptionEnd`, and every later cycle boundary is offset by that delay. A one-year product with a one-year `cycleDuration` therefore reached maturity with its last cycle not yet due — and the old `enterFinalSettlement` jumped straight to `SETTLING`, skipping the final settlement entirely: no maturity price snapshot, no final performance fee, and pre-maturity queued requests never priced. Products no longer need `cycleDuration` shortened to 364 days to work around this
- **Failure:** Product state isn't `OPERATING`, or cycle state isn't `ACCEPTING` → revert; neither trigger is due yet → revert

---

#### `completeCycle(vault)`

- **What it does:** Atomically runs `CALCULATING → FULFILLING → COMPLETED → ACCEPTING`, increments the cycle number, and opens the next cycle's window. **If the cycle completes at or after `maturityTimestamp`** it *is* the product's final cycle, and the same transaction also moves the product `OPERATING → SETTLING` — the request cutoff
- **Caller:** That Vault's own bound Settlement contract only (called after settlement succeeds)
- **Why atomic (2026-08-24):** it leaves no block in which the cycle has reopened to `ACCEPTING` while the product still admits requests, so subscriptions and redemptions can never reopen after the maturity price snapshot
- **Changed 2026-08-26 — a normal cycle is no longer *promoted* to final:** a cycle that entered `CALCULATING` before maturity was priced on book value while positions were still open, so using it as the final liquidation price was wrong. Such a cycle now completes normally, moves the product atomically into `SETTLING`, and a **new final cycle is opened** to be priced after assets are actually recovered
- **Changed 2026-08-26 — the final `completeCycle` enters `MATURING` atomically.** This is `SETTLING`'s only exit; the old `confirmFinalSettlement` / `completeFinalSettlement` / `enterMaturing` chain is gone
- **Final pricing precondition:** before the final snapshot can be taken, every Adapter's `realAssets()` and the UnifiedPool `pending` must be zero — i.e. all positions realized or confirmed at zero recovery. If the book said 1,000,000 and 800,000 came back, the final price is struck on 800,000 and the shortfall is borne pro-rata by all share holders; no operating role is required to top it up
- **Failure:** Caller isn't that vault's Settlement contract → revert; cycle state isn't `CALCULATING` → revert

---

#### ~~`completeFinalSettlement(vault)` / `isFinalSettlementComplete(vault)` / `enterMaturing(vault)`~~ — **removed 2026-08-26**

Deleted by 《最终周期结算及最终兑付补充修改方案》 along with `Settlement.confirmFinalSettlement`
and `hashFinalSettlementConfirmation`. `SETTLING → MATURING` is no longer a separate confirmed
step: the final cycle's `completeCycle` performs it atomically, and it is `SETTLING`'s only exit.

---

#### `enterClaiming(vault)` / `closeProduct(vault)`

- **What it does:** Drives the tail of the end-of-life sequence — `MATURING → CLAIMING` (requires `now ≥ claimingStart`) `→ CLOSED`
- **Caller:** That Vault's Keeper
- **When to use:** Product maturity/wind-down flow, once per Vault lifetime
- **Removed 2026-08-24 — `enterFinalSettlement`:** there is no longer a Keeper transition into `SETTLING`. `OPERATING → SETTLING` happens inside the final cycle, so the final cycle can never be skipped. See `startCycleCalculation` and `completeCycle`
- **Removed 2026-08-26 — `enterMaturing`:** `SETTLING → MATURING` is now atomic inside the final `completeCycle`; there is no Keeper transition and no confirmation precondition
- **Note:** `CLOSED` stops new subscriptions, redemptions and settlement, but does **not** end claim rights — `BaseVault.claimFinal` and the ordinary claim paths stay open after it
- **Failure:**
  - Wrong current product state for the requested transition → revert
  - Time-gated transitions (`enterClaiming` needs `claimingStart`, `closeProduct` needs `claimingEnd`) called too early → revert

---

#### `pause(vault, reason)`

- **What it does:** Halts all fund-moving actions on a Vault regardless of its product/cycle state
- **Caller:** That Vault's Guardian **only** — there is no Governor path for this at all
- **When to use:** Emergency circuit-breaker on a suspected exploit or oracle failure for that specific Vault
- **What a pause freezes (widened 2026-08-24):** new deposit/redeem requests, settlement (`settle` and `snapshotSettlementPrice`), the LiquidityBridge sync deposit, **and** — newly — `claimDeposit`, `claimRedeem`, `claimRefund`, `cancelRequest`, `returnPrincipalToPool`, and share `transfer`/`transferFrom`. Previously a paused Vault still let settled redemptions be claimed, refunds be paid out, principal leave the Vault, and shares change hands freely, so a pause meant to stop withdrawals against a price the Guardian believes is wrong did not actually stop them
- **Failure:** Non-Guardian caller → revert; `reason` passed as the "active" (non-paused) value → revert; vault already paused → revert

---

#### `unpause(vault)`

- **What it does:** Resumes a paused Vault
- **Caller:** That Vault's Owner **only** — again, no Governor override
- **Failure:** Non-owner caller → revert; vault isn't currently paused → revert

---

#### `pauseModule(id)` / `unpauseModule(id)` / `modulePaused(id)` *(read-only)*

- **What it does:** Halts / resumes an entire protocol module (e.g. the NAV Oracle) across every Vault at once; `modulePaused` returns whether a given `ModuleId` (`CASH_VAULT`, `NOTE_VAULT`, `LP_VAULT`, `SETTLEMENT`, `NAV_ORACLE`, `PSM_POOL`, …) is currently flagged — separate from, and in addition to, per-Vault `pause`
- **Caller:** `GOVERNOR_ROLE` — unchanged from before; this remains the one place Governor still has direct operational reach into Vault-adjacent behavior
- **When to use:** A protocol-wide incident affecting a whole module (e.g. all Note Vaults) rather than a single Vault

---

#### `getState(vault)` / `getParams(vault)` / `totalSubscribed(vault)` / `subscribedByWallet(vault, wallet)` / `isVaultRegistered(vault)` / `currentCycleNumber(vault)` *(read-only)*

- **What it does:** Returns the current three-layer state / the configured `ProductParams` / cumulative amount subscribed during the initial raise window (total and per-wallet) / whether an address is a registered Vault / the current cycle number
- **Note:** `walletSubscriptionCap` only gates the initial `SUBSCRIBING` window — once a Vault reaches `OPERATING`, recurring per-cycle deposits are no longer capped by it. There is no total-raise cap at request time: `totalSubscribed` only feeds `finalizeSubscription`'s `minRaiseAmount` decision, and the Vault's capacity is enforced at settlement against `BaseVault.subscriptionCapShare`
- **What `totalSubscribed` / `subscribedByWallet` mean (clarified 2026-08-24):** a **subscription-window declaration tally**, not principal actually subscribed. They move only while the product is `SUBSCRIBING` — an `OPERATING`-phase deposit does not add and, symmetrically, an `OPERATING`-phase cancel does not subtract (the asymmetry that let a later cancel shrink a historical raise figure is fixed). `finalizeSubscription` is the last moment either can move, so the value is **frozen** for the rest of the product's life, on a failed raise too. They are never reconciled against settlement: a partially-filled request mints for the accepted amount and refunds the rest without adjusting them, so the tally can exceed the principal that actually entered the Vault. Anything needing real subscribed principal must read the Vault

---

#### `vaultCount()` / `vaultAt(index)` / `vaultsPaged(offset, limit)` *(read-only)*

- **What it does:** Enumerates every registered Vault in registration order. `isVaultRegistered(vault)` answers *"is this address a Vault?"*; these answer *"what are all the Vaults?"* — the same guarantee `AssetRegistry` gives for assets via `nextAssetId`/`getAsset`, so an integrator can list Vaults with `eth_call` alone instead of replaying `VaultRegistered` logs
- **When to use:** Any Vault directory, explorer, or dashboard that must discover Vaults it wasn't configured with. `VaultFactory.deployVault` is permissionless, so a hardcoded Vault list is always potentially stale
- **Paging:** `vaultsPaged` clamps rather than reverts — an `offset` at or past the end returns an empty array and an overlong `limit` returns a short page, so you can page without reading `vaultCount()` first. `vaultAt` *does* revert past the end (array bounds panic `0x32`)
- **Note:** The list is append-only and Vaults are never unregistered, so an index, once assigned, is stable forever. The list is not filtered by state — a `CLOSED` Vault stays in it; read `getProductState(vault)` per entry if you need to filter

---

#### `vaultsWithRole(account, offset, limit)` *(read-only)*

- **What it does:** Within the `[offset, offset+limit)` window of the Vault list, returns the Vaults on which `account` holds at least one Vault-local role, each paired with a bitmask of *which* roles. Answers *"which Vaults does this wallet manage?"* in one call, rather than one `IVaultRoles` probe per Vault per role
- **Returns:** `(address[] vaults, uint8[] roleMasks)` — equal length, and shorter than the window since Vaults where the account holds nothing are omitted. Bit `1 << uint8(VaultRole.X)` is set when the account holds role X, with `VaultRole` = `{OWNER, CURATOR, GUARDIAN, ALLOCATOR, KEEPER}` from `libs/Types.sol`. An account holding several roles on one Vault gets one entry with the bits unioned
- **Caller:** Anyone; pure read
- **Note:** `account == address(0)` always returns empty — a disconnected front end passes the zero address, and every *unset* role slot on a Vault also reads as `address(0)`, so matching it would wrongly report every Vault with no Curator as "curated by `0x0`"
- **Cost:** Five `IVaultRoles` calls per Vault in the window, so this is a paged scan, not an index. Keep the window small enough to stay inside the node's `eth_call` gas cap; there is no reverse index to look the account up in directly

---

### BaseVault (shared vault behavior + roles)

Abstract base shared by `EarnVault` and `LiquidityEarnVault` — an async ERC-4626 + ERC-7540 vault: deposits and redemptions are two-step (**request → settlement → claim**), share mint/burn only happens during `settle()`. Each Vault is its own ERC-20 share token, **and now also its own local role registry**, implementing `IVaultRoles`: it tracks its own Owner, Curator, Guardian, Allocator, and Keeper set directly, rather than deferring to `HyperAccessControl`. Every Vault also permanently binds to one `VaultTimelock` at deployment. **Adapters are added directly by the Curator (see `addAdapter` below) — there is no separate Adapter whitelist registry; the Curator alone is responsible for which Adapter implementations a Vault uses.**

**Vault-local roles:**

| Role | Set by | Typical responsibilities |
|---|---|---|
| Owner | Set at deploy; transferable by itself | Appoints all other roles; direct control while `CONFIGURING`; timelock-gated control afterward; unpauses the vault |
| Curator | Owner | Sets fee/adapter parameters, product params |
| Guardian | Owner | Pauses the vault in an emergency; can cancel a pending timelock change |
| Allocator | Owner | Bridges LP capital into the Cash vault |
| Keeper(s) | Owner | Drives day-to-day lifecycle transitions (subscription/cycle/maturity steps); membership is explicit only — the Owner must call `setKeeper(account, true)` to grant itself or anyone else Keeper access |

---

#### `bindGovernance(vaultTimelock)`

- **What it does:** One-time wiring of the Vault's own `VaultTimelock`
- **Caller:** The one `VaultFactory` wired into `StateManager` (`StateManager.vaultFactory()`) — called immediately after constructing the Vault, since the timelock's own constructor needs the Vault's address and so this can't live in the Vault's constructor
- **Changed 2026-08-24:** previously gated only on "not yet bound", which assumed the factory binds in the same transaction that deploys the Vault without enforcing it. Any non-atomic deploy window let anyone front-run the bind with a timelock they controlled and take over the Vault's governance
- **Failure:** Caller isn't StateManager's registered factory → `Unauthorized`; already bound → revert; `vaultTimelock` is the zero address → revert

---

#### `transferOwnership(newOwner)` / `setCurator(account)` / `setGuardian(account)` / `setAllocator(account)` / `setKeeper(account, approved)`

- **What it does:** Appoints/replaces the Vault's Owner / Curator / Guardian / Allocator, or adds/removes an address from the Keeper set
- **Caller:** That Vault's Owner
- **Failure:** Non-owner caller → revert; `transferOwnership` to the zero address → revert

---

#### `isKeeper(account)` / `owner()` / `curator()` / `guardian()` / `allocator()` / `vaultTimelock()` / `stateManager()` *(read-only)*

- **What it does:** Returns the Vault's currently configured role holders and bound infrastructure addresses; `isKeeper` returns `true` only for addresses explicitly approved via `setKeeper` — it does **not** return `true` for the Owner by default

---

#### `requestDeposit(assets, owner)` → `requestId`

- **What it does:** Locks `assets` USDT from the caller and creates a pending deposit request for `owner`
- **Caller:** `owner`, or an address `owner` has approved via `setOperator`
- **Failure:**
  - `assets == 0` → `ZeroAssets`
  - KYT gate blocks `owner` (if a gate is configured) → `GateBlocked`
  - Vault not in `SUBSCRIBING` or `OPERATING`+`ACCEPTING`, or paused → `VaultPausedError` / `WrongProductState`
  - Initial-raise per-wallet cap exceeded (only enforced during `SUBSCRIBING`) → `WalletCapExceeded`. There is no total-raise cap here — the queue may be oversubscribed, and `settle()` sizes each request

---

#### `claimDeposit(requestId, receiver)` → `shares`

- **What it does:** Transfers the shares minted for a settled deposit request to `receiver`
- **Caller:** Request owner or approved operator
- **Failure:** Request doesn't exist → revert; not yet settled → revert

---

#### `requestRedeem(shares, owner)` → `requestId`

- **What it does:** Locks `shares` from `owner` in the Vault and enqueues a redemption request (FIFO, via `Queue`)
- **Caller:** Request owner or approved operator
- **Failure:** `shares == 0` → `ZeroShares`; Vault not `SETTLING`, and not `OPERATING`+`ACCEPTING`, or paused → `VaultPausedError` / `WrongProductState` / `WrongCycleState`; insufficient share balance → revert

---

#### `cancelRequest(requestId)`

- **What it does:** Withdraws the caller's own still-open request. A `PENDING` deposit has its USDT pushed straight back to the request's owner and becomes `CANCELLED`. A `QUEUED` redeem gets back the shares the vault still holds on its behalf: a wholly unfilled one returns every locked share and becomes `CANCELLED`, while one already partially filled by a prior `settle()` returns only its `remainingShares` and is promoted to `SETTLED`, so the USDT reserved for the filled portion stays claimable through `claimRedeem`
- **Caller:** Request owner or approved operator — never permissionless, in any phase
- **Allowed phases (new, 2026-08-20):** open in every phase except the two in which a settlement round is, or may be, in flight over the request — an ordinary cycle being computed (`cycle != ACCEPTING`) and the final settlement window (`product == SETTLING`). It is therefore available during the `ACCEPTING` window of `SUBSCRIBING`/`OPERATING`, and again throughout `MATURING`, `CLAIMING` and `CLOSED`, where no settlement can run any more and the request would otherwise be locked in permanently
- **Why `SETTLING` needs its own clause:** the product enters `SETTLING` from `completeCycle`, which has already returned the cycle to `ACCEPTING`, so `cycle` reads `ACCEPTING` for the whole `SETTLING → MATURING → CLAIMING → CLOSED` tail. Gating on the cycle alone would leave the final settlement window open
- **Superseded behaviour:** before 2026-08-20 a partially-filled redeem could not be cancelled at all, in any phase — the only genuinely permanent lock-in on the request paths — and `SETTLING` was reachable because the cycle check alone admitted it. Both are fixed here
- **Failure:** Request doesn't exist / isn't in a cancellable state → `RequestNotFound`; caller is neither owner nor approved operator → `NotOwnerOrOperator`; phase is one of the two closed ones → `CancelNotAllowed(requestId, currentProduct, currentCycle)`

---

#### `claimRedeem(requestId, receiver)` → `assets`

- **What it does:** Transfers the USDT owed for a settled redemption to `receiver`
- **Caller:** Request owner or approved operator
- **Failure:** Request doesn't exist → revert; not yet settled → revert; **the Vault is paused → `VaultPausedError`** (2026-08-24)

---

#### `claimRefund(requestId)`

- **What it does:** Refunds a pending deposit's USDT after the product entered `FUNDING_FAILED` (the raise didn't reach `minRaiseAmount`)
- **Caller:** Anyone (pays out to the request's original owner, not the caller)
- **When to use:** Only after `markRefundable` has flagged the request
- **Failure:** Request doesn't exist → revert; not marked `REFUNDABLE` → revert

---

#### `markRefundable(requestIds[])`

- **What it does:** Flags a batch of still-pending deposit requests as refundable so investors can call `claimRefund`
- **Caller:** That Vault's Keeper
- **Failure:** Non-Keeper caller → revert; product state is not `FUNDING_FAILED` → revert

---

#### `snapshotSettlementPrice(cycleNumber)`

- **What it does:** Freezes this cycle's settlement price from the current `totalAssets()/totalSupply()`, once, before `settle()` runs. In the same transaction, it accrues the Morpho-style performance fee: if the price has risen above the stored High-Water Mark, `performanceFeeBps` of the profit is minted as new shares to `performanceFeeRecipient`, and the High-Water Mark ratchets up to the new price. If no `performanceFeeRecipient` is configured, that cycle's fee is skipped (forfeited, not deferred) and an event is emitted instead of reverting
- **Caller:** That Vault's own bound Settlement contract
- **When to use:** Called by Settlement immediately before `settle()` within `submitBatch`
- **Failure:** Caller isn't the vault's Settlement contract → `OnlySettlement`; this cycle was already snapshotted → `SnapshotAlreadyInitialized`

---

#### `settle(cycleNumber, deposits[], redeems[], poolDistributedAssets)` → `fullyClearedRedeemIds[]`

- **What it does:** Net-settles a batch of pending deposits and queued redemptions against `cycleNumber`'s price snapshot. **Rewritten (2026-08-05) to support partial per-request settlement** — a request no longer has to be entirely accepted or entirely rejected within one cycle:
  - **Deposits always resolve fully in the cycle they're touched.** Each `deposits[i]` names a `settleAmount` (assets) that may be less than the request's original amount; shares are minted for exactly `settleAmount`, and if `settleAmount` is less than the original, the untouched remainder is **refunded immediately, in the same transaction** — it never re-enters the queue or waits for a future cycle
  - **Redeems may span multiple cycles.** Each `redeems[i]` names a `settleAmount` (shares) that may be less than the request's remaining shares; whatever isn't paid out this cycle **stays queued, in its original FIFO position**, to be reconsidered (possibly partially again) in a future cycle. A redeem only becomes claimable once its full remaining balance has been paid across however many cycles that takes
  - Checks that accepted redemptions don't exceed accepted deposits plus the Vault's free USDT, and (if a non-zero `subscriptionCapShare` is configured) that the Vault's **subscription quota usage** stays within it. **Changed 2026-08-24:** the cap no longer compares against `totalAssets()`/`totalSupply()`. The Vault tracks `subscriptionCapUsedShares` — shares minted for real subscriptions less shares burned by real redemptions — and the check is simply `subscriptionCapUsedShares <= subscriptionCapShare`. Performance-fee shares are minted without consuming quota (no new money arrives behind them), though burning them does release quota, so the running total floors at zero rather than underflowing. The update is applied **once per batch on the net movement**, so a batch that subscribes and redeems in the same cycle is not rejected on an intermediate state that never existed at rest
- **Caller:** That Vault's own bound Settlement contract
- **Parameters:**
  - `deposits[]` / `redeems[]`: arrays of `{requestId, settleAmount}` — `settleAmount` is in assets (USDT) for a deposit entry, in shares for a redeem entry. Equal to the request's full remaining amount ⇒ full acceptance (the pre-2026-08-05 behavior); less than that ⇒ partial acceptance
  - `poolDistributedAssets`: recorded for the settlement event/audit trail (funds arriving from `UnifiedPool`/adapters are already reflected in `totalAssets()`, not moved by this call)
- **Returns:** `fullyClearedRedeemIds` — the subset of `redeems[]` whose full remaining balance was paid off this cycle. `Settlement.submitBatch` uses exactly this list to decide which redeem ids to dequeue — a partially-filled redeem is simply not in it, so it's left untouched at the Queue's FIFO head
- **FIFO constraint (deposits):** at most one deposit in the batch may be partially filled, and it must be the **last** `deposits[]` entry — checked directly in `settle()`, which reverts `PartialFillMustBeLast`. A request that isn't accepted at all is simply absent from the array and stays `PENDING`
- **FIFO constraint (redeems):** because `Queue.dequeue` is strict FIFO-from-head, if a redeem in this batch is only partially filled, it must be the **last** redeem entry included for this vault in the batch — anything queued after it (even if fully cleared) can't also be included, or the whole batch reverts with `Queue.OutOfOrderDequeue`
- **Events:** emits `DepositSettled(requestId, originalAssets, settledAssets, refundedAssets, cycleNumber, timestamp)` and `RedeemSettled(requestId, originalShares, settledSharesThisCycle, remainingShares, settledAssetsThisCycle, cycleNumber, timestamp)` for **every** processed request (not only partial ones), so the indexer/frontend has one uniform source of truth for original amount / this-cycle amount / remaining amount / cycle number
- **Failure:**
  - Vault paused → `VaultPausedError`
  - `cycleNumber` was never snapshotted → `SnapshotNotInitialized`
  - A request in the batch is not in the expected pending/queued state → `RequestNotFound` / `RequestAlreadySettled`
  - `settleAmount` is zero, or exceeds what's actually left on the request → `InvalidSettleAmount`
  - A partially-filled deposit isn't the last `deposits[]` entry → `PartialFillMustBeLast`
  - Accepted redemptions exceed accepted deposits + free USDT → `InsufficientSettlementLiquidity`
  - The batch's net subscription quota would exceed `subscriptionCapShare` → `SupplyCapExceeded(limit, actual)` — both in **share units** (as of 2026-08-24; this path previously reported AUM). A single minimum share unit over the cap rejects the whole batch
  - A partially-filled redeem isn't the last redeem entry in the batch (see FIFO constraint above) → `Queue.OutOfOrderDequeue`, surfaced through `Settlement.submitBatch`

---

#### `writeDownInsolvency(settledRedeemIds[])`

- **What it does:** Final liquidation path for **fixed-claim insolvency** — `grossManagedAssets()` (Vault USDT + UnifiedPool receivable + Σ Adapter `realAssets()`) has fallen below the Vault's total fixed liabilities. The caller submits only request ids; the contract computes the single uniform payout ratio itself
- **Caller:** That Vault's `VaultTimelock` **only**, always — there is no direct Owner/Curator/Governor path, regardless of lifecycle stage
- **Changed 2026-08-26 (《writeDownInsolvency 最小化修改方案》):** the signature dropped from six arrays to one.
  - `newSettledRedeemAssets[]` removed — **the caller can no longer supply written-down amounts**, only ids. The uniform ratio is `可用于赎回的资产 / reservedRedeemLiability`, computed in-function as a transient value: never stored, no getter, no event field, and not accepted from off-chain
  - `pendingDepositIds[]` / `newPendingDepositAssets[]` removed — PENDING subscriptions are unsettled, un-minted, never entered an Adapter, and remain fully refundable, so they are a **protected liability** and are never written down (《审计报告（一）回复》 §2)
  - `refundableDepositIds[]` / `newRefundableAssets[]` removed with `_writeDownRefundables` — REFUNDABLE is failed-raise principal awaiting refund and is likewise fully protected
- **Payout order:** PENDING protected in full → REFUNDABLE protected in full → remaining assets pay settled redemptions → the shortfall is written down at the uniform ratio → shares rank last. Because assets cannot even cover fixed liabilities at this point, share holders have nothing to draw on, so `claimFinal` is **permanently disabled** after a successful liquidation
- **Applicability is narrowed:** ordinary investment losses (fixed liabilities still covered) must flow through NAV and the share price instead — calling this reverts with `NotInsolvent`
- **Completeness checks:** `settledRedeemIds` must be **strictly ascending** (`IdsNotStrictlyAscending`, blocks duplicates), and the submitted original `settledAssets` must sum to exactly the pre-call `reservedRedeemLiability` (`IncompleteWriteDown`, blocks omissions). Together these make selective write-downs impossible
- **After liquidation** (`insolvencyLiquidated`, permanent): `claimFinal`, new subscriptions, new redemptions, new price snapshots/settlement, Adapter funding and `returnPrincipalToPool` are all **blocked**; PENDING cancel-and-refund, REFUNDABLE claims, `claimRedeem` at the written-down amount, recovering `remainingShares`, and Adapter/UnifiedPool asset recovery remain **allowed**
- **Failure:** Caller isn't the vault's timelock → revert; `reservedRedeemLiability == 0` → revert; not actually insolvent → `NotInsolvent`; Vault's actual USDT can't cover PENDING + REFUNDABLE → `ProtectedLiabilitiesUnbacked`; already liquidated once → `AlreadyLiquidated`

---

#### `claimFinal(shares, owner, receiver)`

- **What it does:** Burns shares at the frozen final settlement price and pays USDT straight from the Vault — the exit path for holders who **never submitted a redemption request**, and for users who cancelled an unsettled redemption and took their shares back
- **Caller:** The share owner, or an ERC-7540 operator they approved
- **Added 2026-08-26:** this is what V1 待确认问题 2 and Audit Feedback V2 #1 both asked for. Previously a holder who reached maturity without redeeming had no on-chain exit at all: `requestRedeem` is not permitted outside `OPERATING`, and the final-settlement chain only flipped a flag without settling any shares
- **When to use:** From `CLAIMING` onward. **Stays open after `CLOSED`** — `CLOSED` only stops new business, it does not end claim rights
- **Notes:** May be claimed in parts; rounded down uniformly so claim order never changes anyone's entitlement; paid only from `freeVaultUSDT()`, so it cannot encroach on subscription, settled-redemption or refund liabilities
- **Failure:** `shares == 0` → `ZeroShares`; caller is neither owner nor approved operator → revert; Vault paused → revert; the Vault has been liquidated → `VaultLiquidated`; product state is neither `CLAIMING` nor `CLOSED` → `WrongProductState`; final price never frozen → `FinalPriceNotSet`; insufficient free USDT → `InsufficientFreeUSDT`

---

#### `setOperator(operator, approved)` / `isOperator(owner, operator)` *(read-only)*

- **What it does:** ERC-7540 delegation — lets `owner` authorize `operator` to call `requestDeposit`/`claimDeposit`/`requestRedeem`/`cancelRequest`/`claimRedeem` on their behalf
- **When to use:** Custodial / smart-contract-wallet integrations where the acting address differs from the fund owner

---

#### `setSettlement(settlement)` / `setUnifiedPool(pool)` / `setGate(gate)`

- **What it does:** Wires the Vault's Settlement contract / UnifiedPool / optional KYT gate contract
- **Caller:** That Vault's Owner directly while still `CONFIGURING`; that Vault's own `VaultTimelock` (Owner-class, delay-queued) once past `CONFIGURING`
- **Failure:** Caller is neither the direct Owner (pre-launch) nor the vault's timelock (post-launch) → revert; `setUnifiedPool` with the zero address → revert; `setSettlement` while the current cycle is `CALCULATING` or `FULFILLING` → revert (rewiring Settlement mid-cycle is blocked; unlike earlier drafts, calling `setSettlement` a second time outside an active cycle is otherwise allowed)

---

#### `adapterCount()` / `adapters(index)` *(read-only)*

- **What it does:** Enumerates the Adapters currently attached to this Vault (at most `MAX_ADAPTERS` = 16). Solidity's generated getter for the public `adapters` array exposes no `.length`, so without `adapterCount()` a caller had to probe `adapters(0..15)` and read a revert as the end marker
- **Paging:** None needed — the list is bounded at 16
- **Note:** Ordering is **not stable**: `removeAdapter` is swap-and-pop, so a removal moves an unrelated Adapter's index. Pin a single `blockTag` across `adapterCount()` and every `adapters(i)` call to read a consistent snapshot. Contrast `AdapterFactory`'s adapter index, which is append-only and whose indices are stable forever

---

#### `addAdapter(adapter)` / `removeAdapter(adapter)`

- **What it does:** Registers (or de-registers) an external capital-deployment Strategy Adapter (`IAdapter`) the Vault deploys capital into, so its `realAssets()` (the current USD value of capital it has deployed on the Vault's behalf) is aggregated into `grossManagedAssets()`. A Vault can hold up to 16 adapters at once
- **Caller:** That Vault's Curator directly while still `CONFIGURING`; that Vault's own `VaultTimelock` (Curator-class, delay-queued) once past `CONFIGURING`
- **Failure:** Caller is neither the direct Curator (pre-launch) nor the vault's timelock (post-launch) → revert; `adapter` is the zero address → revert; `adapter`'s own `vault()` doesn't point back at this Vault → `AdapterNotFound`; already added → `AdapterAlreadyAdded`; Vault already has the maximum of 16 adapters → `AdapterLimitExceeded`; `adapter.realAssets()` reverts (adapter malformed) → admission blocked (`removeAdapter`: adapter not currently added → `AdapterNotFound`; adapter still reports non-zero `realAssets()` → `AdapterStillHasAssets`)
- **Note:** There is no separate Adapter-implementation whitelist registry — the Curator is directly responsible for which Adapter implementations are added. Neither an `AdapterFactory` provenance check nor an `adapter.asset()` cross-check is performed; admission relies on the Curator's own judgment

---

#### `setPerformanceFeeBps(bps)` / `setPerformanceFeeRecipient(recipient)`

- **What it does:** Configures the Morpho-style performance fee taken in `snapshotSettlementPrice` — `bps` of each cycle's profit-above-High-Water-Mark, minted as shares to `recipient`. **Cap raised (2026-08) from 500 bps (5%) to 10,000 bps (100%)** — now a technical ceiling only, not a product limit; the Curator may set anywhere in the full range
- **Caller:** That Vault's Curator directly while still `CONFIGURING`; that Vault's own `VaultTimelock` once past `CONFIGURING`
- **Failure:** `setPerformanceFeeBps` above 10,000 bps → `FeeTooHigh`; `setPerformanceFeeRecipient` to the zero address while a non-zero fee is configured → `InvalidFeeRecipient`

---

#### `setSubscriptionCapShare(capShare)` / `subscriptionCapShare()` *(read-only)*

- **What it does:** Sets the Vault's capacity cap, denominated in **share units** (`0` = unlimited). It limits `subscriptionCapUsedShares` — subscription shares minted less redemption shares burned — not `totalSupply()`, so neither NAV growth nor performance-fee issuance consumes headroom. `settle()` applies the batch's net movement and enforces the cap. `EarnVault.deposit` (the LiquidityBridge sync path) charges the quota at mint time and carries a cheaper fast-fail for batches that never call the Cash Vault's `settle()`; it stands down while that Vault's cycle is `CALCULATING`, where a mid-settlement overshoot is expected
- **Caller:** That Vault's own `VaultTimelock` only. **Changed 2026-08-24:** the *initial* cap is no longer set by a direct Curator call here — the Curator supplies it as `ProductParams.subscriptionCapShare` and `StateManager.setProductParams` pushes it in via `initSubscriptionCapShare` (StateManager-only, `CONFIGURING`-only). This removes the easily-forgotten second call that used to leave the cap at `0` (= unlimited) whenever a Curator missed it
- **When to use:** Whenever the product's capacity changes after configuration. Nothing caps the request queue, so an oversubscribed queue is normal — the Settlement Operator sizes each cycle's accepted total to fit the cap
- **Failure:** Caller is not the vault's timelock → revert. Setting it below the outstanding supply doesn't revert here — the next `settle()` reverts with `SupplyCapExceeded` instead
- **Reading it:** always read the Vault's `subscriptionCapShare()`, not the `ProductParams` that seeded it — a later Timelock change is only reflected in the Vault

---

#### `setProtocolFeeConfig(revenuePool, protocolFeeShareBps)`

- **What it does:** **New (2026-08).** Configures this Vault's split of the performance fee between the protocol (`RevenuePool`) and the Curator's own `performanceFeeRecipient`. When `snapshotSettlementPrice` accrues a performance fee, `protocolFeeShareBps` of the total `feeShares` mints to `revenuePool`, and the remainder mints to `performanceFeeRecipient` (subtraction-based split — no independent rounding on either side, so the two never drift apart by a rounding error). If `revenuePool == performanceFeeRecipient`, it's a single mint; if either side's computed share is zero, only the other side is minted
- **Caller:** `GOVERNOR_ROLE` (protocol-wide Governor, via `StateManager.accessControl()`) — **not** that Vault's own Curator/Owner; the protocol's cut of a Vault's fees is a protocol-level decision, independent of that Vault's own management
- **When to use:** Once per Vault to wire the protocol's revenue share; adjustable later — a config change only affects cycles that haven't yet snapshotted, no retroactive recompute
- **Failure:** Non-Governor caller → `Unauthorized`; `protocolFeeShareBps` above 10,000 → `FeeTooHigh`; nonzero `protocolFeeShareBps` with `revenuePool == address(0)` → `InvalidFeeRecipient`

---

#### `returnPrincipalToPool(amount)`

- **What it does:** **New (2026-08).** Sends `amount` of this Vault's own free USDT to its configured `UnifiedPool`, crediting this Vault's own pending balance there (via `UnifiedPool.receiveVaultPrincipal`) for later Settlement-directed distribution
- **Caller:** That Vault's own Settlement Operator (per that Vault's bound Settlement contract's operator set)
- **Failure:** Non-operator caller → `Unauthorized`; `UnifiedPool` not wired → `UnifiedPoolNotSet`; `amount == 0` → `ZeroAssets`; `amount` exceeds `freeVaultUSDT()` → `InsufficientFreeUSDT`

---

#### `revenuePool()` / `protocolFeeShareBps()` *(read-only)*

- **What it does:** Returns this Vault's currently configured protocol fee-split recipient and share (both set via `setProtocolFeeConfig`)

---

#### `totalAssets()` / `grossManagedAssets()` / `freeVaultUSDT()` / `convertToShares(assets)` / `convertToAssets(shares)` / `balanceOf(account)` *(read-only)*

- **What it does:** `grossManagedAssets` sums the Vault's own USDT balance, its `UnifiedPool` receivable, and every registered Adapter's `realAssets()`; `totalAssets` subtracts pending-deposit, reserved-redeem, and refundable liabilities from that gross figure (this is the number the share price is derived from); `freeVaultUSDT` is the Vault's own USDT balance minus those same liabilities (the USDT actually available to fund redemptions right now); `convertToShares`/`convertToAssets` apply the current on-chain price (`totalAssets() / totalSupply()`, or 1:1 if supply is zero)
- **Failure:** Any of these revert with `AccountingInsolvent` if liabilities exceed the corresponding assets figure (see `writeDownInsolvency` above for the recovery path)

---

### EarnVault

The concrete Cash and Note tranche vault — a single contract parameterized by `cycleDuration` at deploy time (7 days for Cash, 365 days for Note). Adds one function on top of `BaseVault`:

---

#### `deposit(assets, receiver)` → `shares`

- **What it does:** Synchronous ERC-4626 deposit — immediately pulls USDT and mints shares at the current on-chain price, bypassing the async request/settle/claim flow. Only meaningful on the Cash tranche (Note tranche is deployed with `liquidityBridge = address(0)`, so this always reverts there)
- **Caller:** The Vault's configured `liquidityBridge` address only
- **When to use:** Called by `LiquidityBridge.bridgeDeposit` when the LP Vault routes USDT into the Cash Vault
- **Failure:** Caller is not `liquidityBridge` → `OnlyLiquidityBridge`; `assets == 0` → `ZeroAssets`; Vault not active → `VaultPausedError`

---

### LiquidityEarnVault

The LP tranche vault. **Rewritten (2026-08-04)** from a share-minting LP vault into a repeating, no-share-mint, cyclical product: `claimDeposit`, `requestRedeem`, and `claimRedeem` are all disabled (always revert `ActionDisabled`) — there is no LP Vault share token in circulation, ever, and no async claim step. Instead, `settle()` is a single-transaction, atomic, dust-free pro-rata distribution: each cycle's accepted deposits are bridged to the Cash Vault in one call, and the resulting Cash Tokens plus a `UnifiedPool`-sourced USDT bonus are split pro-rata across that cycle's requests and paid out immediately, in the same transaction as settlement. There is no async claim because there's nothing left to claim afterward.

---

#### `setAdapter(adapter)`

- **What it does:** One-time wiring of the LP Vault's single `LiquidityAdapter`; internally delegates to `addAdapter`, registering it into `BaseVault.adapters[]` so its `realAssets()` is included in `grossManagedAssets()` — inherits `addAdapter`'s full gating and whitelist check
- **Caller:** That Vault's Curator directly while still `CONFIGURING`; that Vault's own `VaultTimelock` once past `CONFIGURING`
- **Failure:** Already set → `AdapterAlreadySet`; any of `addAdapter`'s underlying failure conditions → revert

---

#### `settle(cycleNumber, deposits[], redeems[], poolDistributedAssets)` → `uint256[]` *(always empty)*

- **What it does:** Single-transaction cyclical pro-rata distribution — no shares are ever minted for this vault. For each accepted deposit in `deposits[]`: the combined USDT across the whole batch is bridged to `cashVault` in one call via `LiquidityBridge`, and the resulting Cash Tokens plus `poolDistributedAssets` (a USDT bonus, already sitting in the vault) are split pro-rata across the batch by each request's accepted `settleAmount`. The **last request in array order** absorbs the integer-division remainder for both outputs, so the vault is left holding zero dust of either asset. A request may be accepted for less than it asked for; the unaccepted remainder is refunded to its owner in this same transaction. Either way every request resolves fully here — there's no partial-fill/claim step for this vault type
- **Caller:** That Vault's own bound Settlement contract
- **Parameters:**
  - `deposits[]`: `{requestId, settleAmount}` entries — `settleAmount` must satisfy `0 < settleAmount <= ` that request's original deposited amount; anything outside that range reverts the whole call. A smaller amount is a partial acceptance and the difference is refunded to the request owner immediately (unlike `EarnVault`, nothing stays queued — see `BaseVault.settle`). Only the **last** entry may be partial; an earlier partial reverts `PartialFillMustBeLast`
  - `redeems[]`: must always be empty — this vault has no redeem queue
- **Returns:** Always an empty array (the shared `IBaseVault.settle` return shape exists purely for interface parity with `EarnVault`; there's nothing to report since redemptions aren't supported here)
- **Empty batch:** `deposits.length == 0` (or the batch's total accepted assets is zero) is not an error — it records a zero `CycleRecord` and completes the cycle normally
- **Failure:**
  - Vault paused → `VaultPausedError`
  - Any `redeems[]` entry present → `RedeemNotSupported`
  - Batch exceeds `MAX_CYCLE_REQUESTS` (200) → `CycleRequestLimitExceeded`
  - `cycleNumber` was never snapshotted → `SnapshotNotInitialized`
  - A request isn't `PENDING`, or `settleAmount` is zero or above its original amount → `RequestAlreadySettled` / `RequestNotFound` / `InvalidSettleAmount`
  - A partially-filled deposit isn't the last `deposits[]` entry → `PartialFillMustBeLast`

---

#### `evictDepositRequest(requestId)`

- **What it does:** **New (2026-08-04).** Curator-only unblock for a stuck FIFO deposit queue: if a `PENDING` request's owner can't receive tokens (e.g. a blocklisted USDT address), it would otherwise permanently brick `settle()`'s single-transaction, all-accepted-or-nothing distribution for every request queued behind it (`Queue.dequeue` enforces strict FIFO head order). This marks the stuck request `REFUNDABLE` instead — reusing the same `claimRefund` path as a `FUNDING_FAILED` refund — and tombstones its Queue slot so the FIFO head can advance past it
- **Caller:** That Vault's Curator
- **When to use:** Ops intervention when a queued depositor's address can't receive the LP Vault's payout tokens
- **Failure:** Non-Curator caller → revert; request isn't `PENDING` → `RequestNotFound`

---

#### `liquidityBridge()` / `cashVault()` / `adapter()` / `cycleRecords(cycleNumber)` / `MAX_CYCLE_REQUESTS` *(read-only)*

- **What it does:** Returns the wired LiquidityBridge address, Cash Vault address, LiquidityAdapter address / a completed cycle's `(acceptedTotalAssets, cashTokenDistributed, bonusUsdtDistributed, completed)` record / the fixed per-cycle request-count cap (200)

---

### LiquidityBridge

A single, stateless utility contract shared across vaults, with no custody of its own — it moves USDT from one vault to another using the sync deposit surface, and returns the resulting shares directly to the source vault.

---

#### `bridgeDeposit(assets, fromVault, toVault)` → `shares`

- **What it does:** Pulls `assets` USDT from `fromVault`, deposits it into `toVault` synchronously (`toVault.deposit`), and delivers the resulting shares back to `fromVault` — so `fromVault` ends up holding `toVault`'s shares rather than USDT
- **Caller:** `fromVault` itself (this is how `LiquidityEarnVault`'s deposit settlement calls it internally), or `fromVault`'s own Allocator
- **When to use:** Routing LP Vault subscriptions into the Cash Vault
- **Failure:** `assets == 0` → `ZeroAssets`; `fromVault`/`toVault` is the zero address → `ZeroAddress`; caller is neither `fromVault` nor that vault's Allocator → `CallerNotAuthorized`

---

### VaultFactory

Deploys and registers a new Vault in a single transaction, now **fully permissionless**: the constructing address (or an address it names) becomes the new Vault's Owner, and no protocol role is required at all. Vaults are deployed directly, each by its own small deployer contract: `VaultFactory` is constructed with the addresses of `earnDeployer` and `lpDeployer`, and `deployVault` calls `deploy(...)` on the appropriate one, which runs the Vault's constructor. A deployer's runtime bytecode *is* its Vault's creation code, so this couples deployer size to Vault size and puts a hard EIP-170 ceiling on how large a Vault can grow — splitting the two Vault kinds across two deployers is what keeps each within it. An EIP-1167 minimal-proxy design was carried briefly (2026-08-20) because `EarnVaultDeployer` had overshot that ceiling by 516 bytes; deleting `sweepExpiredRequests` and its dead refund branch cut the deployer by 917 bytes and direct deployment was restored, since a clone's `initialize(...)` costs ~900 bytes of Vault runtime code that a constructor does not. **New (2026-08-05):** deployment is now gated behind a protocol creation fee (see [ProtocolFeeConfig](#protocolfeeconfig)) — this only adds a payment requirement, deployment itself remains fully permissionless with no allowlist.

---

#### `deployVault(params)` → `vault`

- **What it does:** Collects the configured creation fee (if any), then deploys an `EarnVault` (Cash or Note, by `cycleDuration`) or `LiquidityEarnVault` per `params.vaultType` through the corresponding Deployer contract (`earnDeployer` / `lpDeployer` — a Deployer's runtime code *is* its Vault's creation code, and splitting the two kinds apart is what keeps each under EIP-170), wiring `usdt`/`stateManager`/`queue`/`liquidityBridge` (and `cashVault` for the LP tranche); deploys a dedicated `VaultTimelock` for it and binds it via `bindGovernance`; and registers the Vault in `StateManager`, whose initial state is fixed at `CONFIGURING`/`ACCEPTING` (as of 2026-08-24 `initialProduct`/`initialCycle` are no longer `VaultParams` fields). Fee collection happens first — if payment fails, is short, or the chosen kind isn't configured, the entire call reverts and no Vault is created. There is no `navOracle` to wire — the Vault prices its own shares on-chain. `settlement`, `unifiedPool`, and any Adapters are wired separately afterward via `setSettlement`/`setUnifiedPool`/`addAdapter` (or `setAdapter` for the LP tranche) once those contracts exist
- **Caller:** Anyone — permissionless; the new Vault's Owner is `params.owner` if set, otherwise the calling address
- **Payable:** Must send exactly the `Native`-kind fee amount as `msg.value` when `params.feeKind == Native`; must send `0` otherwise
- **Parameters:** `VaultParams` includes an explicit `owner` field (zero address ⇒ caller becomes owner), and (**new, 2026-08-05**) a `feeKind` field — which of `Native` / `Governance` / `Stable` to pay the creation fee with (for `Governance`/`Stable`, the caller must have pre-approved this contract to pull the fee token). The old `accessControl` field has been removed entirely, since Vaults no longer defer to `HyperAccessControl`; there is no `adapterRegistry` field — Adapters are added directly by the Curator after deployment via `addAdapter`
- **Returns:** The new Vault's address
- **Event:** `VaultDeployed` reports the Vault's Owner and its newly-deployed `VaultTimelock` address; `VaultCreationFeeCollected` reports the fee action/kind/amount/payer
- **Failure:**
  - `params.feeKind == Native` and `msg.value` doesn't exactly equal the configured fee → `IncorrectNativeFee`
  - `params.feeKind != Native` and `msg.value != 0` → `UnexpectedNativeValue`
  - `params.feeKind` is `Governance`/`Stable`, the fee is nonzero, and no payment token is configured for that kind → `PaymentTokenNotConfigured`
  - Unknown `vaultType` → `InvalidVaultType`
  - **`StateManager.setVaultFactory` has not been wired to point at this specific `VaultFactory` instance** — in that case the whole transaction reverts partway through (at `BaseVault.bindGovernance`, which as of 2026-08-24 is itself gated on being StateManager's registered factory), even though the fee was already collected and the Vault deployed earlier in the same transaction

---

#### `feeConfig()` *(read-only)*

- **What it does:** Returns the address of the `ProtocolFeeConfig` instance this factory is wired to
- **When to use:** Confirming which fee table governs Vault deployment on this instance

---

## Module E — Adapters (Strategy)

Adapters are how a Vault's Curator/Allocator deploy vault capital into an off-chain or on-chain strategy position and later recall it. Each Adapter is permanently bound to exactly one Vault at deployment, and every role check it performs is resolved dynamically against that Vault's own `IVaultRoles` — so if the Vault later rotates its Curator/Allocator/Guardian, the Adapter automatically respects the new holder.

Deploying an Adapter (via `AdapterFactory`) is fully permissionless and, by itself, grants no authority over any Vault — a Vault's Curator must still separately call that Vault's `addAdapter` before the Adapter can actually receive capital. There is no separate Adapter-implementation whitelist registry; the Curator alone decides which implementations to add, and bears the risk of that choice.

The Curator/Allocator split is a two-step control: the **Curator authorizes** an order's amount, destination, and settlement mode; the **Allocator executes** it exactly as authorized (only choosing which order and when — never the amount or destination). A Guardian can freeze all Allocator execution in an emergency; only the Curator can lift that freeze.

---

### BaseAdapter (shared adapter behavior)

Abstract base shared by `FirstPeriodAdapter` (used for Cash/Note vaults) and `LiquidityAdapter` (used for the LP vault). Each Adapter is itself an ERC-4626-style vault whose share price is driven by an off-chain-informed valuation ledger rather than a raw token balance.

---

#### `createBuyOrder(amount, destination, mode)`

- **What it does:** Declares intent to deploy vault capital to `destination` — no funds move yet
- **Caller:** That Vault's Curator
- **Parameters:** `mode` — `TOKEN_RETURN` (the destination eventually delivers an on-chain token that will represent the position) or `VALUE_RETURN` (the destination never tokenizes; its value is reported manually via `updateDealData` instead)
- **Returns:** `orderId`, which is also the position's **deal key**

---

#### `createSellOrder(exitAsset, exitAmount, proceeds, payer, assetRecipient, dealKey, hasDeal, dealValueReduction, expiry)`

- **What it does:** Authorizes an asset exit and the proceeds expected for it. Reserves the exit asset and the deal value it will consume, so no other order can promise the same thing. No funds move yet
- **Caller:** That Vault's Curator
- **Parameters:**
  - `exitAsset` / `exitAmount`: the token handed over. `address(0)` means the position has no on-chain token (a `VALUE_RETURN` deal) and only `dealValue` moves
  - `proceeds`: the receivable, in this Adapter's `asset()`. Must be paid **in full** before execution — partial payment is deliberately unsupported; a partial exit is a smaller, separate order
  - `payer`: the only address whose payment this order accepts
  - `dealKey` / `hasDeal` / `dealValueReduction`: the Deal-priced position being unwound and how much of its `dealValue` is written off on execution. `dealKey` 0 is a real buy key, hence the separate `hasDeal` flag
  - `expiry`: must be in the future. Past it the order cannot execute and the payer can refund themselves
- **Returns:** `orderId`
- **Replaced 2026-08-28 (Adapter 通用资产退出及回款订单修改方案):** the old `createSellOrder(amount)` never sold anything — it pulled the proceeds out of the **Allocator's own wallet**, putting a human role in the custody path and requiring it to hold and approve USDT, and recorded neither what was exited nor from which position, so `dealValue` never fell and the returned cash could be counted on top of the original valuation. This also replaces the deleted RWA Withdraw and Rebalance order books
- **Failure:** Non-Curator caller or Vault paused → revert; `exitAsset` not one this Adapter accepts → `ExitAssetNotSupported`; more than is free after other orders' reservations → `InsufficientExitAsset` / `InsufficientDealValue`; `dealKey` not live → `DealNotLive`; `expiry` not in the future → `ExpiryNotInFuture`; neither a token nor a deal named (it would exit nothing yet still take money) → `ZeroAmount`

---

#### `fundSellOrder(orderId)`

- **What it does:** Pays a Sell Order's `proceeds` into the Adapter and marks the order `FUNDED`. The received amount is locked: excluded from `realAssets()` and from what `recallAdapter` may take, until the exit asset is actually delivered
- **Caller:** That order's declared `payer`, having approved the Adapter for `proceeds` first
- **Why an entry point rather than a plain transfer:** a bare ERC-20 transfer carries no order id, so it cannot be matched automatically; accepting one would leave a Curator confirming payments by hand off chain
- **Failure:** Caller isn't the `payer` → `NotOrderPayer`; order isn't `CREATED` → `WrongSellOrderStatus`; past `expiry` → `SellOrderExpired`; less arrived than expected (fee-on-transfer) → `ProceedsNotReceived`

---

#### `cancelBuyOrder(orderId)` / `cancelSellOrder(orderId)`

- **What it does:** Withdraws a not-yet-executed order. A `CREATED` Sell Order just releases its reservations; a `FUNDED` one **refunds the payer and ends `REFUNDED`** — cancelling while keeping the counterparty's money is not possible at any price
- **Caller:** That Vault's Curator or Guardian
- **Available while the Vault is paused:** standing down a reservation and returning a payment both reduce exposure, and a halt must not trap a counterparty's money
- **Failure:** Order already executed, already cancelled, or already refunded → revert

---

#### `refundSellOrder(orderId)`

- **What it does:** Returns a funded-but-unexecuted order's proceeds to the payer and frees its reservations
- **Caller:** That order's `payer`, and only after `expiry` — deliberately **not** gated on the Curator or Allocator, so a counterparty who has paid can recover without depending on the party that failed to deliver. Works while the Vault is paused
- **Failure:** Caller isn't the `payer` → `NotOrderPayer`; order isn't `FUNDED` → `WrongSellOrderStatus`; not yet past `expiry` → `SellOrderNotExpired`

---

#### `executeBuy(orderId)` / `executeSell(orderId)`

- **What it does:** Executes a previously Curator-authorized order exactly as specified. `executeBuy` deploys capital to the destination and opens the deal at cost. `executeSell` writes off `dealValueReduction` from the linked deal and/or delivers `exitAsset` to `assetRecipient` **in the same call**, releases the reservations, and unlocks the proceeds as ordinary Adapter capital
- **Caller:** That Vault's Allocator
- **Why the retirement is in the same call:** the exited value stops being counted the instant the counterparty receives it, so the proceeds and the original valuation can never overlap — and the Data Provider no longer has to separately mark an exited deal down to zero
- **Failure:** Allocator frozen or Vault paused → revert; Sell Order not `FUNDED` → `WrongSellOrderStatus`; past `expiry` → `SellOrderExpired`; Buy order doesn't exist, cancelled, or already executed → revert

---

#### `setExitableAsset(token, allowed)` *(FirstPeriodAdapter only)*

- **What it does:** Allows or disallows `token` as a Sell Order exit asset
- **Caller:** That Vault's Curator directly while `CONFIGURING`; that Vault's own `VaultTimelock` afterwards — widening what the Adapter may part with is a risk-parameter change
- **Why an explicit allowlist:** `BaseAdapter` refuses **every** token by default, so a Sell Order can never become a way to walk an unrelated token out of an Adapter. `RWAAdapter` needs no equivalent (it is bound to one token at construction); `LiquidityAdapter` declares none, so only token-free (Deal-only) exits work against it
- **Failure:** Wrong caller → revert; `token` is this Adapter's own `asset()` → `ExitAssetNotSupported` (that is the proceeds currency and the Vault's capital)

---

#### `reservedExitAmount(token)` / `reservedDealValue(dealKey)` / `lockedProceeds()` *(read-only)*

- **What they do:** How much of `token` / of a deal's value is spoken for by unsettled Sell Orders, and how much counterparty money is held for `FUNDED` orders
- **When to use:** Before creating an order, to see what is actually free. `lockedProceeds` is also the ceiling `recallAdapter` respects

---

#### `freezeAllocator()`

- **What it does:** Immediately halts all `executeBuy`/`executeSell` calls for this Adapter, without needing to cancel every individually pending order
- **Caller:** That Vault's Guardian
- **When to use:** Emergency response to a suspected compromised Allocator or bad strategy data

---

#### `unfreezeAllocator()`

- **What it does:** Lifts a Guardian-imposed Allocator freeze
- **Caller:** That Vault's Curator only — deliberately asymmetric: only Curator can lift a freeze the Guardian imposed

---

#### `realAssets()` *(read-only)*

- **What it does:** Returns the Adapter's total tracked deployed-capital value, backing this Adapter's ERC-4626 share pricing (and, transitively, the Vault's `grossManagedAssets`)
- **Failure:** If any live **`VALUE_RETURN`** position's tracked value hasn't been refreshed within its configured staleness window, this reverts rather than returning a stale number — refresh via `updateDealData`. `TOKEN_RETURN` positions are **exempt** from the staleness check (Audit Feedback V2 #6): they have no refresh path at all, so enforcing it froze pricing, settlement and `removeAdapter` for any delivery slower than the window. Retire a resolved `TOKEN_RETURN` position via `clearDealValue`
- **Excludes locked proceeds:** while a Sell Order sits `FUNDED` the Adapter holds both the original position and the payment for it; counting both would value the same economic thing twice, so `lockedProceeds` is subtracted until `executeSell` retires the position (Adapter 方案 §八)

---

#### `updateDealData(orderId, newValue)`

- **What it does:** Refreshes the off-chain-reported value of a `VALUE_RETURN` **buy** position (one that never tokenizes on-chain)
- **Note:** With the Rebalance order book removed (2026-08-28) there is one id sequence writing the deal ledger, so the disjoint-keyspace split Audit Feedback V2 #2 introduced is no longer needed. A deal's key is simply its buy `orderId`
- **Caller:** This Adapter's configured Data Provider
- **When to use:** Periodic mark-to-market updates for off-chain positions
- **Failure:** Non-Data-Provider caller → revert; order wasn't executed, or isn't in `VALUE_RETURN` mode → revert

---

#### `clearDealValue(orderId)`

- **What it does:** Clears the placeholder tracked value for a `TOKEN_RETURN` position once it has resolved into an actual on-chain token elsewhere (so it stops being double-counted via this ledger)
- **Caller:** That Vault's Allocator
- **Failure:** Allocator execution frozen → revert; order wasn't executed, or isn't in `TOKEN_RETURN` mode → revert

---

> **[REMOVED 2026-08-28] `createRebalanceOrder` / `executeRebalance` / `cancelRebalanceOrder` / `updateRebalanceDealData` / `clearRebalanceDealValue`, and `createRWAWithdrawOrder` / `cancelRWAWithdrawOrder` / `executeRWAWithdraw`.**
>
> The Rebalance book was only ever `source -> Adapter -> destination` in USDT. It required `source` to have approved this Adapter, which an external counterparty or most contracts simply cannot do; it opened a new Deal without retiring the old one, so both were counted; and it had none of the minimum-output, slippage or deadline machinery a real atomic swap needs. A Sell Order followed by a Buy Order does the whole job with the old position actually retired — within one Adapter directly, across two via `recallAdapter` + `fundAdapter`. An Adapter that genuinely needs an atomic DEX swap should implement a purpose-built one (in/out token, minimum output, deadline, router) rather than reuse a generic transfer pair.
>
> The RWA Withdraw book could move RWA out with **no payment at all**, sidestepping the Sell Order's pay-first rule, and left two books competing for the same token balance. RWA now exits through `createSellOrder` with `exitAsset == rwaToken`; `realAssets()` re-prices off the smaller balance on its own. A no-proceeds emergency migration, if ever needed, belongs in a purpose-built Governance mechanism, not the ordinary business flow.

---

#### `setStalenessWindow(window)`

- **What it does:** Sets the default staleness window applied to newly-recorded tracked positions
- **Caller:** That Vault's Curator directly while still `CONFIGURING`; that Vault's own `VaultTimelock` once past `CONFIGURING`
- **Failure:** Caller is neither the direct Curator (pre-launch) nor the vault's timelock (post-launch) → revert

---

#### `setDataProvider(provider)`

- **What it does:** Sets/rotates the address permitted to call `updateDealData`
- **Caller:** That Vault's Curator directly while still `CONFIGURING`; that Vault's own `VaultTimelock` once past `CONFIGURING`
- **Failure:** Caller is neither the direct Curator (pre-launch) nor the vault's timelock (post-launch) → revert

---

### LiquidityAdapter

The LP vault's single Adapter — the inherited Curator/Allocator order book, used for any RWA legs the LP vault holds directly, plus the bridge-target wiring the vault reads.

> **[REVISED 2026-08-17 — bridging leg removed]** `bridgeToCash`, `recallCashTokens`, and `cashTokenBalance` were deleted. They were gated on `msg.sender == vault`, but the 2026-08-04 LP Vault rewrite made `LiquidityEarnVault._bridgeDeposits()` call `ILiquidityBridge.bridgeDeposit` directly, so nothing could ever reach them. `cashTokenBalance` was their only writer, which left this Adapter's `realAssets()` cash leg permanently zero; that override is gone too and `BaseAdapter.realAssets()` is now inherited unchanged. `setBridgeTarget` stays — the LP Vault reads `liquidityBridge()` / `cashVault()` from it.

---

#### `setBridgeTarget(newLiquidityBridge, newCashVault)`

- **What it does:** Wires (or rewires) the `LiquidityBridge` contract and destination Cash Vault recorded on this Adapter, which the LP Vault reads when bridging
- **Caller:** That Vault's Curator directly while still `CONFIGURING`; that Vault's own `VaultTimelock` once past `CONFIGURING`
- **When to use:** Required before the LP Vault's first settle
- **Failure:** Either address is the zero address → revert; the named Cash Vault isn't a registered vault → revert

---

#### `realAssets()` *(read-only)*

- **What it does:** Returns this Adapter's total value — the Cash Token leg (valued live via the Cash Vault's own share price) plus the inherited off-chain/RWA leg from `BaseAdapter`
- **Failure:** Same staleness-based revert as `BaseAdapter.realAssets()` if the RWA leg's tracked value is stale

---

### AdapterFactory

A permissionless deployer, mirroring `VaultFactory`'s pattern — deploying an Adapter here is necessary but not sufficient to make it live for a Vault; the target Vault's Curator must still separately whitelist and add it (see the module introduction above).

---

#### `deployAdapter(params)` → `adapter`

- **What it does:** Deploys a `FirstPeriodAdapter` bound to `params.vault` — used for Cash/Note tranche vaults
- **Caller:** Anyone — fully permissionless
- **Parameters:** `params.asset` (USDT), `params.vault` (the Vault this Adapter will serve), `params.stalenessWindow` (default position staleness window, e.g. 36 hours)
- **Failure:** `params.asset` or `params.vault` is the zero address → revert

---

#### `deployLiquidityAdapter(params)` → `adapter`

- **What it does:** Deploys a `LiquidityAdapter` bound to `params.vault` — used for the LP tranche vault; its bridge target starts unset and must be wired separately via `setBridgeTarget`
- **Caller:** Anyone — fully permissionless
- **Failure:** `params.asset` or `params.vault` is the zero address → revert

---

#### `isAdapter(adapter)` *(read-only)*

- **What it does:** Checks whether this factory deployed a given Adapter address
- **Note:** This is purely local bookkeeping ("did this factory deploy this address") — it does not indicate whether a Vault has actually whitelisted or added the Adapter

---

#### `adapterCount()` / `adapterAt(index)` / `adaptersPaged(offset, limit)` *(read-only)*

- **What it does:** Enumerates every Adapter this factory has deployed, in deployment order. `isAdapter` answers *"did this factory deploy that address?"*; these answer *"what has this factory deployed?"*, so an integrator can list Adapters with `eth_call` alone instead of crawling `AdapterDeployed` logs over a bounded block window
- **When to use:** Any Adapter directory or explorer. A log crawl has to pick a lookback window and silently loses everything deployed before it
- **Paging:** `adaptersPaged` clamps rather than reverts — an `offset` at or past the end returns an empty array and an overlong `limit` returns a short page, so you can page without reading `adapterCount()` first. `adapterAt` *does* revert past the end (array bounds panic `0x32`)
- **Note:** The list is **append-only** — this factory never removes an entry — so an index, once assigned, is stable forever and safe to cache across blocks

---

#### `adapterCountForVault(vault)` / `adaptersForVaultPaged(vault, offset, limit)` *(read-only)*

- **What it does:** The same index sliced by the Vault each Adapter was deployed for, so *"which Adapters exist for this Vault?"* needs no log filtering at all
- **Paging:** Clamps on the same terms as `adaptersPaged`
- **Note:** Append-only, like the global index. This lists what the factory **deployed for** a Vault, which is **not** the same set as what the Vault **currently uses** — Adapters are admitted to a Vault separately via `BaseVault.addAdapter`, so read `BaseVault.adapters` / `adapterCount()` for the active set

---

*Document updated continuously.*
