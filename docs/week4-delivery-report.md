# Week 4 Delivery Report — Settlement + Strategy (Adapter layer)

**Date:** 2026-07-14 · **Scope:** Phase 1, Week 4 (development-plan §3.4) · **Chain:** BNB Chain (USDT series)

This report covers (1) what was delivered this week, (2) how to test and validate it, and
(3) what is intentionally deferred. It is written to be self-contained for review.

---

## 1. What was delivered

### 1a. New contracts (W4 scope)

Module C completion (`Settlement`) plus the entire new Strategy/Adapter layer, per
development-plan §3.4:

| Module | Contract | Purpose |
|---|---|---|
| C — Settlement | **Settlement** | `submitBatch(instruction, signatures)` — M-of-N operator signature check, per-vault CycleState/cycleNumber validation, conservation check against `UnifiedPool.pending`, NAV freshness/deviation check against `NAVOracle`, then drives `Queue.dequeue` → `UnifiedPool.distribute` → `vault.settle` → `StateManager.completeCycle` per vault |
| Strategy | **BaseAdapter** *(abstract, ERC-4626)* | Vault's execution + position-ledger + valuation module. Curator/Allocator order book (buy/sell/rebalance); `TOKEN_RETURN`/`VALUE_RETURN` settlement modes fixed per order at creation; `pendingDeposits` auto-initializes at cost basis on `executeBuy`/`executeRebalance` (closes T+1/T+3 async-settlement gap); `clearDealValue` zeroes `TOKEN_RETURN` positions once the token settles at the Vault; `updateDealData` refreshes `VALUE_RETURN` positions permanently |
| Strategy | **FirstPeriodAdapter** | Concrete `BaseAdapter` for the Cash and Note EarnVaults — no overrides |
| Strategy | **LiquidityAdapter** | Concrete `BaseAdapter` for the LP EarnVault — adds the structural, automatic LP→Cash Cash-Token bridging leg (`setBridgeTarget`, `bridgeToCash`, `recallCashTokens`); `realAssets()` sums the on-chain-measurable Cash-Token leg with the inherited Recorded Position leg |
| Strategy | **AdapterFactory** | Deploys the vault-appropriate concrete adapter, mirroring `VaultFactory`'s Deployer-helper pattern (`FirstPeriodAdapterDeployer`/`LiquidityAdapterDeployer`) to stay under the EIP-170 size limit |
| B — Vault | **LiquidityEarnVault** *(extended)* | Adds `adapter` address + `setAdapter()` (GOVERNOR_ROLE, set-once) — wires the LP vault to its `LiquidityAdapter` |

### 1b. Design notes / spec-vs-code clarifications found during implementation

1. **"CURATOR_ROLE via Timelock" is not an on-chain `msg.sender == timelock` gate in this
   codebase.** The development plan's prose for several Curator-set parameters (e.g.
   `UnifiedPool.setCashServiceFeeBps`, `LiquidityAdapter.setBridgeTarget`) says "via Timelock," but
   the existing W2/W3 implementations gate these directly on `CURATOR_ROLE` — the Timelock is
   expected to be the operational holder of that role, not an on-chain intermediary the contract
   checks for. `LiquidityAdapter.setBridgeTarget` follows this same, already-established pattern
   (`_onlyCurator()`, no separate `timelock` constructor parameter).
2. **Cash vault share-price accessor.** `LiquidityAdapter.realAssets()`'s Cash-Token leg needs the
   Cash vault's 6-decimal share price. `BaseVault.sharePrice` is a public state variable (not part
   of `IBaseVault`), so `LiquidityAdapter.sol` declares a minimal local `ICashVaultSharePrice`
   interface (`function sharePrice() external view returns (uint256)`) rather than widening
   `IBaseVault`.
3. **`OrderDoesNotExist` detection.** The spec doesn't prescribe a mechanism; `BaseAdapter` checks
   `orderId >= nextBuyOrderId` (and the sell/rebalance equivalents) rather than inferring
   non-existence from zeroed struct fields, since a legitimately-created order could have a zero
   `amount`.
4. **`lpBonus` in `VaultSettlement`.** Carried through the struct and included in the hashed
   `SettlementInstruction` (so it's covered by the M-of-N signature), but no on-chain function
   consumes it in Phase 1 — the spec text doesn't wire it to a vault call, so `Settlement.sol`
   doesn't invent one.

### 1c. Test suite

**24 test suites · 493 tests · 0 failures**

| Suite | Tests | Notes |
|---|---|---|
| `SettlementTest` | 20 | all four `submitBatch` validation steps (signature/state/conservation/oracle), happy-path deposit+redeem cycles against a real `EarnVault`, operator/threshold management |
| `BaseAdapterTest` | 34 | full Curator/Allocator order-book lifecycle (buy/sell/rebalance) via `FirstPeriodAdapter`, `TOKEN_RETURN`/`VALUE_RETURN` mode enforcement, staleness, ERC-4626 capital sourcing |
| `LiquidityAdapterTest` | 13 | `setBridgeTarget`/`bridgeToCash`/`recallCashTokens` access control and happy paths, mixed Cash-Token + RWA-order `realAssets()`, `LiquidityEarnVault.setAdapter` wiring |
| `AdapterFactoryTest` | 8 | GOVERNOR_ROLE gating, independent multi-vault deploys, `isAdapter` bookkeeping for both adapter types |
| `DeployW4Test` | 9 | full W1→W4 wiring smoke test — role grants, vault registration, operator set, NAV signer, `isAdapter`, `lpVault.adapter()`, KYT gate still `address(0)` |
| *(19 W1–W3 suites)* | 409 | unchanged from Week 3 |

Run:

```bash
forge test -vv
```

Expected: `24 test suites … 493 tests passed, 0 failed`.

### 1d. Deploy wiring (`DeployW4`)

`script/Deploy.s.sol` gains `contract DeployW4 is Script`, following the same env-var-driven
pattern as `DeployW3`:

```bash
forge script script/Deploy.s.sol --tc DeployW4 --rpc-url <rpc> --broadcast [--legacy]
```

Required env vars: `HYPER_ACCESS_CONTROL`, `STATE_MANAGER`, `QUEUE`, `UNIFIED_POOL`, `NAV_ORACLE`,
`USDT`, `CASH_VAULT`, `NOTE_VAULT`, `LP_VAULT`, `SETTLEMENT_OPERATORS` (comma-separated),
`SETTLEMENT_THRESHOLD`, `DATA_PROVIDER_SIGNER`.

Deploy sequence: `Settlement` → grant `SETTLEMENT_ROLE` → add operators/threshold →
`AdapterFactory` → deploy `FirstPeriodAdapter` for Cash/Note + `LiquidityAdapter` for LP →
`LiquidityEarnVault.setAdapter` → grant `DATA_PROVIDER_ROLE` → `setSettlement` on all three vaults
(deferred from W3, per `VaultFactory`'s own comment). Writes
`control-panel/deployments-w4.json`.

**Not called by `DeployW4`:** `lpAdapter.setBridgeTarget(liquidityBridge, cashVault)` — this is
Curator's own initial parameter configuration (client feedback 2026-07-10, §3.4.1
`LiquidityAdapter`), not a `GOVERNOR_ROLE` deploy step. It must run once, via Timelock/Curator,
before the first LP `settle()` cycle — `bridgeToCash` reverts `BridgeTargetNotSet` until then.

This week's deploy wiring was validated both against a local Foundry test (`test/DeployW4.t.sol`,
replicating the script's logic against a full W1→W4 local deploy) and against a live BNB testnet
broadcast alongside the existing W1–W3 instance (chainId 97):

| Contract | Address |
|---|---|
| Settlement | `0x11df11aC61D5Aa880Fd17A0cf50Be0C22277916c` |
| AdapterFactory | `0x4514Cf0cacEeC515596c0F0EF13eB1290D482860` |
| CashAdapter (FirstPeriodAdapter, Cash vault) | `0x19643C2CFE2CE3AEAabD28e6ffC58A6c2A3bb7f4` |
| NoteAdapter (FirstPeriodAdapter, Note vault) | `0x7ddFB27c9AC47265Fd861A092050c0041A54067c` |
| LPAdapter (LiquidityAdapter, LP vault) | `0xeEdBb2E9Baae30f450a9D2Ce35286d7CcF132ba1` |

Confirmed on-chain post-deploy: `SETTLEMENT_ROLE` granted to `Settlement`; the deployer is a
registered operator with `threshold() == 1`; `AdapterFactory.isAdapter` true for all three
adapters; `DATA_PROVIDER_ROLE` granted; `settlement()` now returns the `Settlement` address on
all three vaults (previously `address(0)`).

**One known gap from this specific broadcast:** the on-chain LP vault (`LPVault`,
`0x6AAA...6335`) was deployed in W3, before this session added `LiquidityEarnVault.setAdapter` —
its bytecode doesn't have that function, so `LPVault.setAdapter(lpAdapter)` cannot succeed against
this particular instance. The redeploy used a scoped variant of the script that omits only that
one call (everything else matches `DeployW4` exactly); `LPAdapter` is deployed and fully
functional, it just isn't wired to `LPVault.adapter()` on this testnet instance yet. This resolves
itself the next time the LP vault is redeployed with current bytecode (e.g. alongside a future W5
full-stack refresh) — `DeployW4` itself (the committed, deliverable script) still includes the
`setAdapter` call unconditionally, since it's written for a fresh vault that has the function.

---

## 2. How to test & validate

### 2a. Automated unit tests (primary validation)

```bash
git submodule update --init --recursive
forge test -vv
```

Single-suite runs:

```bash
forge test --match-contract SettlementTest -vvv
forge test --match-contract BaseAdapterTest -vvv
forge test --match-contract LiquidityAdapterTest -vvv
forge test --match-contract AdapterFactoryTest -vvv
forge test --match-contract DeployW4Test -vvv
```

### 2b. Control panel

`control-panel/index.html` (and the single-file `standalone.html` build) gained five new module
cards: **Settlement (W4)**, **AdapterFactory (W4)**, **CashAdapter**, **NoteAdapter**, and
**LPAdapter** — order-book actions (`createBuyOrder`/`executeBuy`/etc.), `clearDealValue`/
`updateDealData`, LP bridging (`setBridgeTarget`/`bridgeToCash`/`recallCashTokens`), and
Settlement's operator/threshold management and `isOperator`/`executed` reads. As with
`VaultFactory.deployVault` in W3, the struct-taking functions (`Settlement.submitBatch`,
`AdapterFactory.deployAdapter`/`deployLiquidityAdapter`) aren't exposed as forms — the panel is a
read/write console for already-deployed instances, not a struct builder.
`control-panel/config.js` and `abis.js`/`abis.json` are regenerated and committed for the live
testnet addresses above.

### 2c. Manual walkthrough (once deployed)

1. **Settlement happy path.** After a vault reaches `CALCULATING` (via `StateManager.startCycleCalculation`), Issuer calls `UnifiedPool.repayInterest`/`repayPrincipal` to fund `pending[vault]`, SettlementOperator(s) sign a `SettlementInstruction`, and any relayer calls `Settlement.submitBatch(instruction, signatures)`. Confirm `pending[vault]` decreases, queued redeem requests are dequeued, and the vault's cycle rolls `CALCULATING → ACCEPTING` with `cycleNumber` incremented.
2. **Adapter order flow.** Curator calls `FirstPeriodAdapter.createBuyOrder(amount, destination, mode)`; Allocator calls `executeBuy(orderId)` — confirm USDT lands at `destination` and `pendingDeposits[orderId]` is set at cost basis immediately. For `TOKEN_RETURN` orders, once the token settles at the Vault, call `clearDealValue(orderId)` and confirm the position drops out of `realAssets()`.
3. **LP bridging.** After Curator calls `LiquidityAdapter.setBridgeTarget(liquidityBridge, cashVault)`, Settlement (or the LP vault itself) calls `bridgeToCash(amount)` — confirm Cash Tokens land in the adapter's balance and `realAssets()` reflects `cashTokenBalance * cashVault.sharePrice() / 1e6`.

---

## 3. Deferred / out of scope this week

- **`LPVault.adapter()` wiring on the live testnet instance.** As detailed in §1d, the deployed
  `LPAdapter` isn't wired to the existing (pre-session) `LPVault` since that vault's bytecode
  predates `setAdapter`. **[RESOLVED 2026-07-14 — Company decision]** deferred to W5, bundled
  with the full-stack testnet refresh rather than a standalone LP-vault-only redeploy now.
- **Off-chain layer (SDK, `OnChainEventIndexer`, `KeeperBot`, `SettlementOperator` signing
  service)** — W5 scope per the delivery schedule (§2.5); this week is on-chain contracts only.
- **`createRebalanceOrder`/`executeRebalance` multi-destination target-weight allocation**
  (`addInvestableAsset`/`setAssetTargetWeight`) remains **[DEFERRED to Phase 2]** per the resolved
  §7 item — only the per-order `source`/`destination` rebalance primitive ships in Phase 1, which
  is delivered this week.
- **UnifiedPool UUPS upgradeability** — carried over from the W2/W3 reports as an open item; not
  addressed this week since it doesn't block Settlement's non-upgradeable integration.

---

## 4. Items for client confirmation

| # | Item | Status |
|---|---|---|
| 1 | **LP vault redeploy** — the live `LPVault` predates `setAdapter`. | **Resolved** — deferred to W5 full-stack refresh |
| 2 | **UnifiedPool UUPS proxy** — carried over from W2/W3; confirm whether upgradeability is required before W5 off-chain integration locks in current ABIs. | **Resolved 2026-07-16** — client confirmed upgradeability is required. `UnifiedPool` is now `Initializable` + `UUPSUpgradeable` (constructor disables initializers; `initialize()` replaces constructor args; `_authorizeUpgrade` gated to `GOVERNOR_ROLE`), deployed behind an `ERC1967Proxy`. All deploy scripts and tests updated to construct via proxy. |
