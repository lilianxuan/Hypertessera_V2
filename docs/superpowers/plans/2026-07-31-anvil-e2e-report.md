# Local anvil end-to-end test report — RBAC audit-fix branch

Executed against `feat/vault-local-rbac` per the handover doc
(`2026-07-31-anvil-e2e-handover.md`). Full stack (`Deploy` → `DeployW3` →
`DeployW4`) deployed fresh to a local anvil node and driven through its
lifecycle using the real off-chain `HyperTesseraSDK`/`KeeperBot`/
`SettlementOperator` classes — no test mocks.

## Bug found and fixed

`offchain/scripts/local/deploy.ts` deterministically failed with
`nonce has already been used` during the vault-local role-wiring step
(`setCurator`/`setGuardian`/`setAllocator`), reproduced identically across
two independent fresh-anvil attempts. Root cause: its ad hoc
`new JsonRpcProvider(RPC_URL)` used ethers' default request batching
(`batchMaxCount: 100`, 10ms stall), which races `eth_getTransactionCount`
ahead of prior sends even though each call is `await`ed sequentially.
`offchain/scripts/local/config.ts` already works around this exact class of
issue for the SDK's own provider (`batchMaxCount: 1, cacheTimeout: -1`);
`deploy.ts` never applied the same fix to its own. Fixed with the identical
one-line change; verified clean across two subsequent full redeploys.

## Regression check

`npm run local:test-plan` — 10/10 scenarios passed on the fresh deploy
(deploy sanity, role-gating negatives, guardian pause, full subscription +
settlement cycle, redemption + queue clearing, NAV deviation cap,
FUNDING_FAILED refund, adapter buy order, ReservePSM wrap/unwrap round trip,
LiquidityAdapter bridge access control).

## New coverage

Added `offchain/scripts/local/testSettlementTail.ts`, a standalone script
driving `lpVault` (untouched by the existing `runTestPlan.ts`) through the
new SETTLING → MATURING → CLAIMING → CLOSED tail. All steps passed:

1. **Keeper fallback removal** — revoked governor's Keeper grant via
   `setKeeper(governor, false)` (governor remained Owner); confirmed a
   Keeper-gated call (`openSubscription`) now reverts. Restored the grant
   and confirmed it works again.
2. **`threshold == 0` guard** — called `confirmFinalSettlement` against a
   freshly-generated address with no `setThreshold` ever called; confirmed
   it reverts with `SignatureValidationFailed` instead of accepting an
   empty signature array.
3. **Drive to SETTLING** — set short `ProductParams`, opened subscription,
   warped past `subscriptionEnd` → `finalizeSubscription` → OPERATING,
   warped past `maturityTimestamp` → `enterFinalSettlement` → SETTLING.
4. **SETTLING stuck without confirmation** — `KeeperBot.tick()` did **not**
   advance to MATURING and fired a `"final-settlement-pending"` alert
   (observed via `onAlert`), matching `keeperBot.ts`'s new branch.
5. **`confirmFinalSettlement` unblocks the transition** —
   `SettlementOperator.confirmFinalSettlement(vault, relayer)`, signed by
   both registered operator wallets (2-of-2, matching the demo deploy's
   `SETTLEMENT_THRESHOLD=2`), succeeded; `isFinalSettlementComplete` flipped
   to `true`; a subsequent `KeeperBot.tick()` advanced SETTLING → MATURING
   with **no** alert.
6. **`claimingEnd` gate** — warped past `claimingStart`, `KeeperBot.tick()`
   advanced MATURING → CLAIMING; `closeProduct` reverted with
   `ConditionNotMet("claimingEnd not reached")` (confirmed in the raw
   revert data) before `claimingEnd`; warped past it, `closeProduct`
   succeeded → CLOSED.

Final combined run — fresh deploy → `local:test-plan` (10/10) →
`testSettlementTail.ts` (all steps) against one shared deployment — passed
cleanly, confirming no cross-vault interference between the existing
subscription/settlement-cycle coverage (Cash/Note vaults) and the new
SETTLING-tail coverage (LP vault).

## Not covered

- `addAdapter`'s `realAssets()` check (fix 2) — already covered by a real
  Foundry test with a `RevertingRealAssetsAdapter`
  (`test/EarnVault.t.sol`); skipped here per the handover doc's guidance.
- `control-panel/` UI — out of scope per the handover doc.
