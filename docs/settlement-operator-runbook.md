# Settlement Operator runbook

Operational rules for assembling and submitting `Settlement.submitBatch` instructions. These are
requirements the contracts do **not** enforce; getting them wrong either reverts the batch or —
in one case — silently misprices an LP entry.

Code: `offchain/src/settlementOperator.ts`. Contract: `src/asset-management/settlement/Settlement.sol`.

---

## 1. Put every vault that settles together in the same batch

`submitBatch` runs in two phases: it snapshots the settlement price for **every** vault in the
instruction, then settles them all. The phase split is what isolates each vault's performance fee
from capital arriving in the same cycle.

That isolation only covers vaults inside the batch. **If the LP Vault and the Cash Vault it bridges
into are submitted in separate batches, the isolation is gone** and the LP enters at a pre-fee
price — the exact defect the two-phase split was introduced to fix.

Splitting them has a second consequence now that the capacity cap of §5 exists. An LP-only batch
still bridges and still mints Cash shares, but the Cash Vault's own `settle()` — the only place the
cap is checked — never runs in that batch, so a breach does not revert it atomically. It surfaces at
the Cash Vault's next settlement instead and wedges that cycle in `CALCULATING` until the cap is
raised through the Timelock
(`test/SettlementOrdering.t.sol::test_capShare_calculatingOvershootIsCaughtLateAndWedgesTheCycle`).

**Rule: an LP Vault and its `cashVault()` must always appear in the same instruction.**

## 2. Order LP Vault before Cash Vault

The contract does not enforce ordering, deliberately — it would cost a type-probe per vault per
batch and would rule out future multi-tranche batches.

Ordering does **not** affect fee isolation or LP mint pricing; both come from the phase split and
are order-independent (`test/SettlementOrdering.t.sol::test_feeIsolationHoldsUnderReversedArrayOrder`
pins this). Ordering affects one thing only: whether the LP's bridged USDT has landed in time to
fund the Cash Vault's redemptions in the same cycle.

Get it wrong and the Cash Vault's `settle` reverts with `InsufficientSettlementLiquidity` — a
failed batch, not a mispriced one. Resubmit with the right order.

**Rule: `[LP Vault, Cash Vault]`.**

## 3. Do not bridge outside settlement

This rule has the weakest on-chain backing of the three.

`LiquidityBridge.bridgeDeposit` authorises the calling vault **or that vault's Allocator**
(`src/asset-management/settlement/LiquidityBridge.sol:52`). So the sync-deposit path into a Cash
Vault is not settlement-exclusive by authorisation: an Allocator passes the caller check at any
time.

A bridge that happens outside a settlement batch is priced against whatever the Cash Vault's live
share price is at that moment. If the Cash Vault has unaccrued performance fees, the LP is buying
in before they are taken and is diluted by them.

What actually stops this today is an ERC-20 allowance, not the authorisation check.
`LiquidityEarnVault.settle` (`src/asset-management/vaults/LiquidityEarnVault.sol:203`)
`forceApprove`s the bridge for exactly `cycleTotalAssets` and consumes the whole allowance inside
the same call, so between cycles the bridge holds zero allowance on the LP Vault and an off-cycle
`bridgeDeposit` reverts there. Confirmed against the deployed v3 generation on a fork.

Treat that as incidental, not as protection: it is a side effect of how `settle` sequences its
approval, and any change to that sequencing — a standing allowance, an approval hoisted out of the
loop — removes it silently with nothing failing.

**Rule: LP→Cash bridging happens only through `Settlement.submitBatch`. Allocators must not call
`bridgeDeposit` directly on a vault that participates in settlement.**

This is an operational rule rather than a contract check because gating `EarnVault.deposit` on
"must already be snapshotted" would also block the Allocator's legitimate rebalancing path. If the
rule proves too fragile in practice, the fix is a settlement-only bridge entry point, not a guard
on `deposit`.

## 4. Do not recall an adapter using `realAssets()` verbatim

`recallAdapter(adapter.realAssets())` **can revert with `ERC4626ExceededMaxWithdraw`.**

USDT that reaches an adapter outside the order book (a donation, a rounding remainder, a direct
transfer) raises the adapter's ERC-4626 share price. Redeeming the vault's entire share balance
then rounds down, stranding 1 unit — so `realAssets()` reads 1 higher than `maxWithdraw`.

Concretely: after `fundAdapter(100_000e6)` plus `7_500e6` arriving directly,
`realAssets() == 107_500e6` but `maxWithdraw == 107_499_999_999`.

**Rule: recall `maxWithdraw`, or `realAssets() - 1`, not `realAssets()`.** Any Allocator automation
that reads `realAssets()` and passes it straight to `recallAdapter` will fail intermittently — only
once dust exists, which is why it will pass testing and fail later.

## 5. Size the accepted deposits against `subscriptionCapShare`

Each Vault carries a share-denominated capacity cap, `subscriptionCapShare` (`0` = unlimited).
`settle()` checks it **at the end of the cycle**, against the Vault's live `totalAssets()` versus
`subscriptionCapShare * settlementPrice / 1e18`. Because the check reads real end-of-settle state,
everything that moved in the cycle counts: this batch's deposit mints and redeem burns, the
performance-fee mint, and — under the `[LP, Cash]` order — the LP Bridge's inflow and the Cash shares
minted against it.

Nothing gates this at request time any more, so the queue can hold more than the Vault can take.
Sizing is the operator's job: accept the FIFO prefix that fits, fill the marginal order partially,
and leave the rest `PENDING` for a later cycle. That shape is enforced — `settle()` reverts
`PartialFillMustBeLast` unless every deposit but the last is a full accept, which is the deposit-side
equivalent of the `OutOfOrderDequeue` guard the redeem queue already had. `settleAmount` is chosen **off-chain** — there is no
on-chain helper that computes the amount that fits.

Get it wrong and the whole batch reverts with `SupplyCapExceeded(limit, actual)` — both in AUM on
this path
(`test/SettlementOrdering.t.sol::test_capShare_catchesLpBridgeInflow` pins the bridge-inflow case,
which the old request-time cap never saw). Resubmit with a smaller accepted total.

**Rule: the accepted total must leave the Vault's end-of-settle state within `subscriptionCapShare`.**

---

## Why this matters — measured

Both figures are from `test/SettlementOrdering.t.sol`, comparing behaviour before and after the
two-phase split plus the `EarnVault.deposit` pricing fix.

**Self-dilution alone.** Cash Vault holding 1,000 USDT against 1,000e18 shares; LP bridges in 100
USDT. `deposit` used to pull the USDT in before calling `convertToShares`, so the deposit inflated
the price it was then charged:

| | Cash Token minted to LP |
|---|---|
| before | `90.909090909090909090e18` |
| correct | `100e18` |

9.09% of the entry handed to existing holders.

**Full cycle, with fees.** Cash Vault at 1,100 USDT / 1,000e18 shares, high-water mark 1.0, 10%
performance fee; LP bridges 220 USDT:

| | before | after |
|---|---|---|
| LP position value | 186.38 USDT | 220.00 USDT |
| Cash Vault `feeAssets` | 15.333266 USDT | 10.000000 USDT |
| `settlementPrice` | 1.118285 | 1.090000 |

The LP was losing 33.62 USDT per cycle (15.3%), and the loss was not burned — it accrued to the
Cash Vault's existing holders and its fee recipient. Left unaddressed this is a standing subsidy
from LP holders to Cash holders, repeated every cycle.

After the fix the price `deposit` reads is exactly the cycle's `snapshot.settlementPrice`, so the
LP enters at the same post-fee price the Cash Vault settles its own redemptions at.

---

## Final cycle (2026-08-24)

The product's **final** cycle is an ordinary settlement batch, not a special one — but it is the
batch that generates the maturity price snapshot, charges the last performance fee, and prices every
request queued before maturity. It is also what moves the product `OPERATING → SETTLING`, inside
`completeCycle`. There is no longer a Keeper transition into `SETTLING`, so until this batch lands
the product cannot mature at all.

- Once `now >= maturityTimestamp`, the Keeper calls `startCycleCalculation` regardless of how much
  of `cycleDuration` has elapsed, and the KeeperBot raises a `final-cycle-pending` alert while the
  batch is outstanding.
- **Submit the batch even when both queues are empty.** An empty batch is valid and is the normal
  case for a one-year product: it still snapshots the maturity price and completes the cycle. Not
  submitting it wedges the product in `OPERATING`/`CALCULATING` indefinitely.
- `confirmFinalSettlement` comes **after** this batch, not instead of it. It is rejected while the
  final cycle is still `CALCULATING`.

## Moving cash out of UnifiedPool is no longer yours (2026-08-28)

`operatorTransfer` and `operatorTransferToRevenuePool` are **`GOVERNOR_ROLE`-only** as of
审计反馈 V3 #1. Drop them from operator scripts entirely; an operator key calling either now
reverts `NotGovernor`.

They are the only two paths that take cash out of the pool without a matching ledger movement, so
whoever can call them can drain the shared cash backing every Vault. An operator key is an online
per-Vault signing key, and a stolen one must not reach that. Ask the Governor to execute these.

What you keep: attribution (`attributeInterest` / `attributePrincipal`), settlement signing, and
the whole normal settlement flow — everything that stays inside the ledger.

## Both whitelists must be in place before you can attribute (2026-08-28)

`attributeInterest`, `attributePrincipal`, `receiveVaultPrincipal` and `distribute` now require
the Governor to have called **both**:

- `setVaultWhitelisted(vault, true)`
- `setSettlementWhitelisted(vault.settlement(), true)`

Missing either reverts `VaultNotWhitelisted` or `SettlementNotWhitelisted`. Check both before a
batch against a newly deployed Vault, and re-check after any `setSettlement` change — the check
reads the Vault's *current* `settlement()`, so re-pointing a Vault at a Settlement that was never
whitelisted silently blocks its attribution until the Governor adds it.

Inflows are unaffected: `repayInterest` / `repayPrincipal` stay permissionless. They only add cash
and an unattributed record; nothing reaches a Vault's `pending` until you attribute it.

## Capacity is a quota, not a supply cap (2026-08-24)

`subscriptionCapShare` limits `subscriptionCapUsedShares` — subscription shares minted less
redemption shares burned — **not** `totalSupply()`. Two consequences when sizing a batch:

- Performance-fee shares do not consume capacity, so a well-performing vault's headroom no longer
  shrinks every cycle. `totalSupply()` can legitimately sit above `subscriptionCapShare`.
- The check runs **once per batch on the net movement**, so a cycle that accepts 1,000 shares of
  subscriptions and burns 1,000 shares of redemptions is neutral — you no longer need to keep the
  intermediate (deposits-only) state under the cap.

`SupplyCapExceeded(limit, actual)` now reports both figures in **share units** on the `settle()`
path too; it previously reported AUM there. A single minimum share unit over the cap rejects the
whole batch.

Quota usage has no getter (deliberately — the vault's bytecode is near the EIP-170 ceiling), so
track it off-chain from `DepositSettled` / `RedeemSettled` if you need to project headroom.

## Checklist

Before signing a batch:

- [ ] Every LP Vault in the batch is accompanied by its `cashVault()`
- [ ] LP Vaults are ordered before the Cash Vaults they bridge into
- [ ] No Allocator has bridged into a participating Cash Vault since its last settlement
- [ ] `distribution.amount` per vault is within `UnifiedPool.availableToDistribute`
- [ ] The batch's **net** share movement leaves each Cash Vault's quota usage within its `subscriptionCapShare` (read the live cap from the Vault, not from `ProductParams`; fee shares don't count toward usage)
- [ ] If a vault has passed `maturityTimestamp`, its final-cycle batch is submitted — an empty one if both queues are empty
- [ ] Every vault in the batch is `vaultWhitelisted`, and its current `settlement()` is `settlementWhitelisted`

## Partial settlement on the LP Vault

`LiquidityEarnVault._validateDeposits` accepts any `settleAmount` in `0 < settleAmount <= req.assets`,
so an LP deposit request can be filled for less than it asked for. Only the last entry in the batch
may be partial — see §5. The unaccepted remainder is
refunded to the request owner inside the same `settle()` call — nothing re-queues, and the request
resolves fully either way. The Cash Token and UnifiedPool bonus split is weighted by `settleAmount`,
not by the original request size, and each request emits
`DepositSettled(requestId, originalAssets, settledAssets, refundedAssets, cycleNumber, timestamp)`.

Operationally this means the bridged total can be landed **exactly** on the Cash Vault's redemption
gap: accept the FIFO prefix in full, size the marginal order to whatever is still missing, and let
its remainder refund. Previously the bridged total had to overshoot the gap or the batch had to be
rejected whole.
