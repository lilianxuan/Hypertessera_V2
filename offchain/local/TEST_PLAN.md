# Local devnet test plan

**Scope.** End-to-end validation of the full on-chain stack (Modules A-D + Strategy, W1-W4) driven
through Module E (SDK/OnChainEventIndexer/KeeperBot/SettlementOperator) against a real local
`anvil` chain — not another `forge test` pass (that's already covered: 494 Solidity unit tests).
This plan exercises cross-contract integration paths, multi-actor role separation, and the
off-chain/on-chain boundary the way the Company will actually operate the system.

**Setup.** See `scripts/local/deploy.ts` — runs `Deploy` → `DeployW3` → `DeployW4` against
`anvil` on `127.0.0.1:8545`, distinct signer per role (`scripts/local/wallets.ts`, extending
`script/Deploy.s.sol`'s own `ANVIL_1..7` convention), writes `local/addresses.json`. Executor:
`scripts/local/runTestPlan.ts`.

**Role map** (mirrors `script/Deploy.s.sol::_grantDemoRoles`, extended for Settlement/investors):

| Role | Account index | Notes |
|---|---|---|
| Governor | 0 | Deployer; also real-vault NAV signer + KEEPER_ROLE (per `DeployW3`'s wiring) |
| Curator | 1 | Also ALLOCATOR_ROLE |
| Guardian | 2 | |
| Issuer | 3 | Also OPERATOR_ROLE (BVI SPV) |
| Token Agent | 4 | |
| Data Provider | 6 | `BaseAdapter.updateDealData` caller |
| Compliance | 7 | |
| Investor 1 / 2 | 8, 11 | |
| Settlement Operator 1 / 2 | 9, 10 | M-of-N threshold = 2 |

---

## Scenarios

Each scenario is implemented as one function in `runTestPlan.ts`, run sequentially (later
scenarios depend on earlier ones' on-chain state — this models one continuous product lifecycle,
not isolated cases). A scenario fails loudly (throws) rather than silently continuing.

1. **Deploy sanity** — every address in `local/addresses.json` has code; role grants
   (`hasRole`) match the table above; `AdapterFactory.isAdapter` true for all three adapters;
   `LiquidityEarnVault.adapter()` wired; all three vaults `settlement()` == deployed `Settlement`.
2. **Role-gating negative checks** — a non-Curator cannot call `UnifiedPool.setCashServiceFeeBps`;
   a non-Keeper cannot call `StateManager.openSubscription`; a non-Governor cannot
   `HyperAccessControl.grantRole`. Each must revert.
3. **Guardian pause blocks subscription** — Guardian pauses the Cash vault before subscription
   opens; `requestDeposit` reverts; Guardian unpauses; deposit then succeeds.
4. **Full subscription + settlement cycle (Cash vault)** — two investors `requestDeposit`;
   KeeperBot drives `CONFIGURING -> SUBSCRIBING -> OPERATING -> CALCULATING`; NAV signed by
   Governor; SettlementOperator assembles a 2-of-2 signed batch and submits; both investors
   `claimDeposit`; indexer's `getPendingDeposits` empties.
5. **Redemption + queue clearing (Cash vault)** — one investor `requestRedeem`s part of their
   shares; indexer's `getClearingList` shows the queued request; KeeperBot advances the cycle;
   SettlementOperator includes the redeem in the batch (`Queue.dequeue` FIFO); investor
   `claimRedeem`s USDT back; indexer's `getClearingList` empties.
6. **NAV deviation cap** — attempt an `updateNAV` upward move beyond `NAV_DEVIATION_MAX_BPS`
   (2000 bps / 20%); reverts `DeviationTooHigh`. A downward move of the same magnitude succeeds.
7. **FUNDING_FAILED refund (Note vault)** — Note vault's `minRaiseAmount` set
   high enough that a token deposit can't meet it; KeeperBot's `finalizeSubscription` moves the
   product to `FUNDING_FAILED`; investor calls `claimRefund` and gets USDT back.
8. **Adapter buy order + clearDealValue (Cash vault)** — Curator `createBuyOrder` (VALUE_RETURN
   mode, destination = Issuer wallet as a stand-in RWA counterparty); Allocator `executeBuy`;
   `realAssets()` reflects the deployed capital; Data Provider `updateDealData` revalues it;
   confirms `pendingDeposits` state.
9. **ReservePSM standalone round trip (Module D)** — against the standalone Module D deployment
   (`local/addresses.json`'s `assetRegistryModuleD`, matching the confirmed "D Asset Infra
   standalone module" design, development-plan.md §7): Operator `confirmLock`s a lock for the S
   Token asset, wrapped balance increases; `burnOnRedeem` burns it back down and emits
   `ReserveReleased`.
11. **LiquidityAdapter bridge target wiring** — confirms `setBridgeTarget` wiring from deploy
    (`liquidityBridge()`/`cashVault()` getters). The LP vault reads these when bridging deposits
    to the Cash vault via `LiquidityBridge` during its own settle cycle; driving a full bridge is
    out of scope for this pass (see §3 below).

---

## Not covered

- **LP vault → Cash vault full bridge execution.** The LP vault bridges its own deposits via
  `LiquidityBridge.bridgeDeposit` — driving a full successful bridge requires the LP vault's own
  internal settle-cycle call path (not a standalone demo call), out of scope for this pass. See
  scenario 11.
- **RWAToken ERC-1400 transfer-path / MintBurnController dual-sig flows.** Already covered
  exhaustively by `forge test` (`RWAToken.t.sol`, `MintBurnController.t.sol`); not re-derived here.
- **Adapter rebalance orders, sell orders.** Scenario 8 exercises the buy-order path only; sell/
  rebalance follow the same order-book pattern and are covered in `forge test`
  (`BaseAdapterTest`).

## Running

```bash
cd offchain
npx tsx scripts/local/runTestPlan.ts
```

Requires the local devnet already deployed (`scripts/local/deploy.ts`) and `anvil` still running
on `127.0.0.1:8545`.
