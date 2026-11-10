# Week 3 Delivery Report — Vault Infrastructure (Module B) + StateManager

**Date:** 2026-07-07 · **Scope:** Phase 1, Week 3 (development-plan §3.3) · **Chain:** BNB Chain (USDT series)

This report covers (1) what was delivered this week, (2) how to test and validate it, and
(3) what is intentionally deferred. It is written to be self-contained for review.

---

## 1. What was delivered

### 1a. New contracts (W3 scope)

Five core contracts completing **Module B (tranche vaults)**, plus the **StateManager**
implementation that was deferred from W1 as a W3 prerequisite gate, plus two small helper
contracts required to keep `VaultFactory` deployable (see §1c):

| Module | Contract | Purpose |
|---|---|---|
| B — Vault | **StateManager** | Three-layer (Product × Cycle × Pause) state machine gating every Vault action; named lifecycle functions (`openSubscription` → `closeProduct`, `completeCycle`); orthogonal Guardian/Governor pause |
| B — Vault | **BaseVault** *(abstract)* | Shared ERC-4626 + ERC-7540 async vault base — request/settle/claim flow, KYT gate, FIFO queue wiring, `FUNDING_FAILED` refund path, settlement-gated mint/burn |
| B — Vault | **EarnVault** | Concrete Cash/Note tranche, parameterized by `cycleDuration` (7 days / 365 days); adds synchronous `deposit()` for LiquidityBridge on the Cash tranche |
| B — Vault | **LiquidityEarnVault** | LP tranche; overrides `settle()` to bridge USDT → Cash Vault; overrides `setSharePrice()` to accept `navOracle` or Settlement; `distributeCashTokens` exit/maturity payout |
| B — Vault | **LiquidityBridge** | Stateless utility — `bridgeDeposit(assets, fromVault, toVault)` moves USDT between vaults via the synchronous deposit path, no share custody |
| B — Vault | **VaultFactory** | Deploys + registers a Vault in one call; `GOVERNOR_ROLE`-gated |

### 1b. Consistency fixes across W1–W4 specs and contracts

The W3 planning pass found and fixed **23 cross-contract consistency issues** surfaced by a full
holistic spec review (missing storage slots, wrong role gating, duplicate getters, stale
restatements) — see `docs/development-plan.md` changelog for the full list. Highlights:

| Contract | Fix |
|---|---|
| `BaseVault` | Added missing `queue` storage slot, `setSettlement()`, `requireOperable` gate on `requestDeposit` |
| `LiquidityBridge` | Redesigned as a generic utility (`bridgeDeposit(assets, fromVault, toVault)`); removed share-custody model from the original draft |
| `LiquidityEarnVault` | Fixed `setSharePrice` access (was Nav-oracle-only, contradicted Settlement being the LP price updater) |
| `VaultFactory` | Added missing `queue`/`liquidityBridge` fields to `VaultParams` |
| `NAVOracle` | Added `bootstrapNavTolerance()` (Governor-gated, pre-first-NAV only) — `setNavTolerance` is Timelock-gated (48h delay), impractical at first deploy |
| `Queue` (W2/W4) | Fixed `verifyOrder` missing `vault` parameter |

### 1c. Bugs found and fixed before deployment

A code-level review of the new Vault contracts (access control, state-machine correctness,
fund-safety) surfaced two fund-safety issues and one deploy blocker, all fixed before the testnet
deployment below:

1. **Guardian pause didn't stop fund movement.** `BaseVault.settle()`, `LiquidityEarnVault.settle()`,
   and `EarnVault`'s synchronous `deposit()` only checked role membership, not StateManager's pause
   state — so a Guardian emergency pause did not actually stop settlement or LiquidityBridge sync
   deposits. Fixed: all three now call `StateManager.requireActive()`.
2. **Subscription cap permanently blocked deposits after the initial raise.** `subscriptionCap` /
   `walletSubscriptionCap` were re-enforced on every recurring per-cycle deposit during `OPERATING`,
   but the running totals are never decremented on settlement (only on cancellation) — so once the
   cap was hit once, no vault could ever accept deposits again. Fixed: the cap now only gates the
   initial `SUBSCRIBING` raise window, as originally intended.
3. **`VaultFactory` exceeded the EIP-170 24,576-byte contract size limit** (25,452 bytes measured)
   because it inlined the full creation bytecode of both `EarnVault` and `LiquidityEarnVault` —
   this would have reverted on deploy to any real chain. Fixed by splitting vault construction into
   two dedicated helper contracts, `EarnVaultDeployer` and `LiquidityEarnVaultDeployer`, which
   `VaultFactory` delegates to; its own runtime size is now ~2.1 KB.

(A minor checks-effects-interactions ordering issue in `LiquidityEarnVault._processLPDeposits` was
also tightened, though not separately exploitable given the current access control.)

### 1d. Test suite

**15 test suites · 409 tests · 0 failures**

| Suite | Tests | Notes |
|---|---|---|
| `StateManagerTest` | 56 | full lifecycle, cycle transitions, subscription caps (incl. regression test for fix #2), pause/unpause, module gates |
| `EarnVaultTest` | 30 | request/settle/claim flow, share price, refund path, sync deposit guard, pause regression test for fix #1 |
| `VaultFactoryTest` | 14 | EARN/LP deploy, StateManager registration, access guard, multi-vault |
| `LiquidityBridgeTest` | 8 | access control (ALLOCATOR + fromVault), bridgeDeposit happy/sad paths |
| *(11 W1/W2 suites)* | 301 | unchanged from Week 2 |

### 1e. Live preview deployment — BNB testnet (chainId 97)

Deployed alongside the existing W1/W2 instance on the same chain:

| Contract | Address |
|---|---|
| StateManager | `0x2a9bb2053dD14b36652f1F6Bc2511b3Eb31b1DCd` |
| NAVOracle (W3 instance) | `0x009F0F9507E4e3Fda5159e85fa2f6c19875A3154` |
| LiquidityBridge | `0x7800eBf939427bA561d2d7Ff5Bf6393730A9E101` |
| VaultFactory | `0x63089ad3826ee02f95819e4c0d10C1080a131a0D` |
| CashVault (EarnVault, 7-day cycle) | `0xe0FDa7F2572c5B98D3B82DB50685A8F3685D20ea` |
| NoteVault (EarnVault, 365-day cycle) | `0xf95F69488393d73D0cDbFB40e6D6B3494b832242` |
| LPVault (LiquidityEarnVault) | `0x6AAAaAe6c30997D7c36E4297b0e44B3eC6126335` |

> **Why a second NAVOracle?** `bootstrapNavTolerance()` is new in W3 — the already-deployed W1/W2
> NAVOracle instance predates it and would revert if called. Rather than reuse an incompatible
> instance, `DeployW3` deploys its own NAVOracle. The W1/W2 NAVOracle and its demo vault are
> untouched.

All three vaults are registered in StateManager (`CONFIGURING` / `ACCEPTING` / `ACTIVE`, cycle 0)
and NAV tolerance is bootstrapped at 500 bps. Governor role continues to be held by the same wallet
used since W1 (`0x425beB70d264362E4eb7953C4f7aFBDe01145538`) — no new grant needed.

### 1f. Control panel

The wallet console (`control-panel/index.html` / `standalone.html`) was extended with full W3
coverage:

- New module cards: StateManager (full lifecycle + pause), NAVOracle (W3 instance), CashVault,
  NoteVault, LPVault, LiquidityBridge, VaultFactory (read-only surface)
- New dropdown input types for `ProductState` / `CycleState` / pause reason selection
- `build-abis.sh` updated to export ABIs for `StateManager`, `EarnVault`, `LiquidityEarnVault`,
  `LiquidityBridge`, `VaultFactory`

`VaultFactory.deployVault`'s 13-field struct parameter is not exposed as a form in the UI (the three
vaults above were deployed via the `DeployW3` script) — its read-only getters are exposed instead.

---

## 2. How to test & validate

### 2a. Automated unit tests (primary validation)

```bash
git submodule update --init --recursive
forge test -vv
```

Expected: `15 test suites … 409 tests passed, 0 failed`. Run a single suite, e.g.:

```bash
forge test --match-contract StateManagerTest -vvv
forge test --match-contract EarnVaultTest -vvv
forge test --match-contract LiquidityBridgeTest -vvv
```

### 2b. Manual validation via the control panel

Open `control-panel/index.html` (or `standalone.html`) in a browser, connect MetaMask to BNB
testnet (chainId 97).

Suggested W3 walkthrough (builds on the W1/W2 walkthrough):

1. **Check registration** — StateManager card → `getState(CashVault)` → `(CONFIGURING, ACCEPTING, ACTIVE, 0)`.
2. **Configure and open subscription** — GOVERNOR calls `setProductParams(CashVault, ...)`, then
   KEEPER calls `openSubscription(CashVault)`.
3. **Subscribe** — any wallet calls `CashVault.requestDeposit(assets, owner)` (approve USDT first).
4. **Finalize and settle** — after `subscriptionEnd`, KEEPER calls `finalizeSubscription` →
   `OPERATING`; NAV signer pushes NAV via the NAVOracle (W3) card; SETTLEMENT (currently the
   deployer, pending W4) calls `settle(...)` to mint shares; investor calls `claimDeposit`.
5. **Pause check** — GUARDIAN calls `StateManager.pause(CashVault, PAUSED_BY_GUARDIAN)`; confirm
   `settle()` and any further `requestDeposit`/`requestRedeem` now revert with `VaultPausedError`;
   GOVERNOR calls `unpause` to resume.
6. **LP bridge flow** — investor requests deposit into LPVault; on settlement, LPVault's `settle()`
   routes the USDT to CashVault via `LiquidityBridge.bridgeDeposit` and the LP Vault ends up holding
   Cash Tokens (Cash Vault shares) instead of USDT.

---

## 3. Deferred / out of scope this week

- **Settlement (`submitBatch`)** — still **W4 scope**. `settlement` is wired to `address(0)` on all
  three vaults at deploy; `SETTLEMENT_ROLE` is temporarily held by the deployer for testing
  `settle()` calls manually until the real Settlement contract lands.
- **RevenuePool yield strategy (Phase 2)** — Phase 1 (`yieldStrategy` reserved slot, `address(0)`)
  shipped in W2; actual DeFi integration remains a later-phase deliverable per the client's
  confirmed proposal.
- **UnifiedPool UUPS upgradeability** — carried over from the W2 report as an open item; current
  implementation is non-upgradeable. Confirm before this becomes load-bearing for W4 wiring.
- **`VaultFactory.deployVault` UI form** — not exposed in the control panel (13-field struct
  parameter); the three delivered vaults were deployed via the `DeployW3` script instead.
- **Formal testnet/mainnet audited deployment** — the W5 milestone. The BNB testnet addresses above
  are a functional preview deploy for client testing, not the audited release.

---

## 4. Items for client confirmation

| # | Item | Status |
|---|---|---|
| 1 | **Settlement contract design (W4)** — `submitBatch` batching rules, NAV snapshot source, and how `SETTLEMENT_ROLE` is handed off from the current manual-testing deployer address. | Open, needed before W4 |
| 2 | **UnifiedPool UUPS proxy** — carried over from W2; confirm whether upgradeability is required before it's wired into W4 Settlement flows. | Open |
| 3 | **RevenuePool yield strategy timing** — confirm target quarter for Phase 2 DeFi integration (AAVE/Compound-style), since the interface slot is already reserved. | Open, non-blocking |
