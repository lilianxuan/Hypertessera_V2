# Week 5 Delivery Report — Module E (off-chain layer) + Net Settlement Conversion

**Date:** 2026-07-23 · **Scope:** Phase 1, Week 5 (development-plan §3.5, §8) · **Chain:** BNB Chain (USDT series)

This report covers (1) what was delivered this week, (2) how to test and validate it, (3) code-review
findings from PR #7 and how they were resolved, and (4) what is intentionally deferred. Companion to
`week1`–`week4-delivery-report.md`.

This report's scope grew mid-week: what started as the Module E off-chain delivery (§3.5) also ended up
carrying a protocol-level conversion to net settlement (§8, client feedback) plus a small set of
delivery-audit follow-ups, since all of it landed together in the same PR (#7). Both are covered below.

---

## 1. What was delivered

### 1a. `offchain/` — TypeScript SDK, OnChainEventIndexer, KeeperBot, SettlementOperator

Per development-plan §3.5, all four Module E components (§2 module map, source deliverables #23–26):

| Component               | File                                 | Purpose                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SDK**                 | `offchain/src/sdk.ts`                | `HyperTesseraSDK` — typed `ethers.Contract` access to every W1–W4 module, plus the curated read/write methods spec'd in §3.1.2 (state context, NAV, role checks, RWA balances, lifecycle transitions, mint/burn), extended through W2–W4 and adapted for net settlement (see §1c)          |
| **OnChainEventIndexer** | `offchain/src/indexer.ts`            | Subscribes to the event whitelist (`docs/module-e-event-whitelist-proposal.md`); reconstructs the on-chain dual-FIFO (deposit/redeem) queue, pending-deposit set, and NAV in memory; `getClearingList(vault)` / `getPendingDeposits(vault)` feed SettlementOperator's off-chain calc input |
| **KeeperBot**           | `offchain/src/keeperBot.ts`          | Drives `ProductState`/`CycleState` transitions every tick (treating on-chain "not due yet" reverts as a no-op, not an error); NAV freshness alerts; exponential-backoff retry for genuine failures                                                                                         |
| **SettlementOperator**  | `offchain/src/settlementOperator.ts` | Assembles the client's per-vault calc input into a `SettlementInstruction`, collects M-of-N operator signatures over its hash (matching `Settlement.sol`'s `ECDSA`/`toEthSignedMessageHash` scheme), submits via `submitBatch`, retries with backoff                                       |

Package is plain ESM TypeScript (`ethers` v6 the only runtime dependency); ABIs are read directly
from `control-panel/abis.json` at runtime so the SDK and the control panel can never drift from
each other or from the compiled contracts.

### 1b. Net settlement conversion (development-plan §8, client feedback)

Per four change-request docs from the client, the settlement model was converted from **gross
settlement** (`sum(redeemAmounts) == distributedAssets`, every redeem funded from a fresh pool
distribution) to **net settlement**: deposits net against redeems each cycle, only the shortfall pulls
from `UnifiedPool`, and unfilled requests carry to the next cycle. This touched `BaseVault`,
`UnifiedPool`, `Settlement`, `Queue`, and `Types.sol`.

Alongside it:
- **On-chain dynamic share pricing.** Removed the `NAVOracle`→Vault share-price push; `BaseVault` now
  prices shares from `totalAssets()/totalSupply()` directly, with a Morpho-style performance fee +
  high-water mark computed once per cycle in `snapshotSettlementPrice()`.
- **Dual deposit/redeem FIFO queues** in `Queue.sol`, and multi-vault-per-tranche support in
  `UnifiedPool`.
- **`ReservePSM` rewritten** to be fully decoupled from Vault/Settlement/StateManager, with two
  independent modes: Token Custody Mode (wrap/unwrap against a custodied token) and Document Proof
  Mode (mint against an off-chain document reference, tracked via `documentIdOf`).
- **`UnifiedPool` made UUPS upgradeable** (client-confirmed 2026-07-16) — `Initializable` +
  `UUPSUpgradeable`, deployed behind an `ERC1967Proxy`, `GOVERNOR_ROLE`-gated upgrades.
- Small fixes folded in: `MintBurnController`'s `TOKENIZATION` module-pause gate was removed (mint/burn
  is scoped outside the state machine — see §3 item 3 on why this needs client confirmation);
  `Constants.sol` stripped of unused business constants.

### 1c. Delivery-audit follow-ups (not client-requested)

Found while auditing `docs/development-plan.md` against the delivered codebase; called out separately
for review before merging into the reviewed line of work:

- **`ClaimRegistry`** — Phase 1 on-chain claim-record contract, previously scoped in the development
  plan but never implemented.
- **`IAdapter`/`BaseAdapter.freezeAllocator`/`unfreezeAllocator`** — closes a real gap: Guardian's
  documented right to freeze an Allocator had no corresponding pause check in Adapter execution.
- **`RevenuePool.yieldStrategy`** — no-op reserved slot per the existing Phase 2 deferral.

### 1d. Local devnet tooling

A reproducible local test setup for the full stack: a deploy script (`offchain/scripts/local/deploy.ts`)
that drives the real `Deploy` → `DeployW3` → `DeployW4` forge scripts against a local Anvil node with
role separation across 12 dedicated accounts, a test plan (`offchain/local/TEST_PLAN.md`), and a runner
(`offchain/scripts/local/runTestPlan.ts`) exercising 11 integration scenarios end to end via the Module E
SDK/indexer/KeeperBot/SettlementOperator (role-gating, Guardian pause, full subscription + settlement,
redemption + queue clearing, NAV deviation cap, `FUNDING_FAILED` refund, Adapter buy orders, ReservePSM
standalone round trip, KeeperBot NAV-stale alerts, LiquidityAdapter access control).

Running this surfaced a real bug in `script/Deploy.s.sol`: `DeployW3` deployed a fresh `StateManager` +
`NAVOracle` but reused an earlier stage's `Queue`, still bound to the old `StubStateManager`. Since
`Queue.sm` is immutable, every real vault's `enqueue`/`dequeue` reverted `UnregisteredVault`. Fixed by
having `DeployW3` deploy its own `Queue` alongside `NAVOracle`.

### 1e. Docs

`docs/development-plan.md` sections describing the pre-net-settlement ReservePSM/BaseVault/Settlement
design are marked as superseded by §8 (historical spec text kept intact for reference), role tables that
referenced removed APIs (`confirmLock`, `setReserveAddress`, `credit`) were corrected, and a stale
duplicate `StateManager` row was removed. `docs/module-e-event-whitelist-proposal.md` is a
Developer-proposed starting event whitelist for client review.

---

## 2. Test suite

**23 TypeScript tests** (`offchain/test/`), all passing:

| Suite                             | Tests | Notes                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settlementOperator.unit.test.ts` | 7     | Pure-logic checks on `assembleInstruction`, `collectSignatures`, `submit`, and the full `run` pipeline (no chain)                                                                                                                                                                                             |
| `e2e.integration.test.ts`         | 6     | Full local-anvil integration run: deploys the entire W1–W4 stack, drives a full subscription cycle end to end — `requestDeposit` → `KeeperBot` cycle advance → NAV update → `SettlementOperator` (assemble → sign → `submitBatch`) → `vault.settle` → `claimDeposit` — then confirms indexer view transitions |
| `indexer.integration.test.ts`     | 6     | Dedicated `OnChainEventIndexer` coverage: NAV tracking, dual-FIFO queue snapshot, settlement-decode, generic event-query escape hatch                                                                                                                                                                         |
| `keeperBot.integration.test.ts`   | 4     | Dedicated `KeeperBot` coverage beyond incidental exercise via the e2e test                                                                                                                                                                                                                                    |

```bash
cd offchain
npm install
npm run typecheck
npm test                  # unit only, no chain
npm run test:integration  # spins up anvil (needs `anvil` on PATH)
npm run test:all
```

**Solidity: 572/572 tests passing, 0 failures** (24 test suites), including 10 new tests added
resolving §3's findings.

```bash
forge test -vv
```

`offchain/README.md` documents the package layout and usage; `test/deployStack.ts` and
`offchain/local/TEST_PLAN.md` are runnable references for driving the SDK interactively against a
throwaway Anvil instance outside the automated suites.

---

## 3. Deferred / out of scope

- **BNB testnet redeploy.** The live testnet `LPVault` still predates `LiquidityEarnVault.setAdapter()`
  (carried over from the W4 report) — resolution remains bundled with a future full-stack testnet
  refresh. Everything in this report was built and integration-tested against a local Anvil deploy of
  the current contract bytecode, a superset of what's live on testnet today.
- **Persistent storage for `OnChainEventIndexer`.** In-memory only — the reconstruction logic is
  storage-agnostic and can be backed by a database without changing the event-handling logic.
- **Event-variable whitelist final sign-off.** `docs/module-e-event-whitelist-proposal.md` is a
  Developer-proposed starting list per client instruction (2026-07-16); client review/amendment is
  still open (§5.4).
- **client calc engine.** `SettlementOperator` takes the client's per-vault calc input
  (`VaultCalcInput`) as a parameter — computing reward/LP-yield/bonus/redemption amounts, and now also
  loss-allocation amounts for `writeDownInsolvency` (§3, item 1), is a client responsibility per
  §5.1/§6, out of scope for this package.
