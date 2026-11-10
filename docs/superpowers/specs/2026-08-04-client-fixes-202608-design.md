# Client Feedback 2026-08 — Design Spec

Source: client fee-model memo (`HyperTessera 收费模式.md`) and code-change memo
(`代码修改202608.pdf`), 2026-08-04.

Branch: `feat/client-fixes-202608` (off `feat/vault-local-rbac`).

This spec bundles seven independent work items requested by the client. They
are implemented and committed in stages on one branch, in the order listed
under "Sequencing" at the end.

---

## A. Fee model overhaul (BaseVault + RevenuePool)

**Files:** `src/asset-management/vaults/BaseVault.sol`,
`src/asset-management/settlement/RevenuePool.sol`,
`src/interfaces/IBaseVault.sol`, `src/interfaces/IRevenuePool.sol`.

### A.1 Remove the 500 bps performance fee cap

`MAX_PERFORMANCE_FEE_BPS = 500` (BaseVault.sol:96) becomes `10_000`. This is
now a technical ceiling only, not a product limit — Curator may set
`performanceFeeBps` anywhere in `0–10_000` via the existing
`setPerformanceFeeBps` (Curator-direct-or-timelock gated, unchanged).

### A.2 Protocol fee split configuration

New BaseVault storage:

- `address revenuePool` — protocol fee receiver for this vault.
- `uint16 protocolFeeShareBps` — protocol's share of total performance fee,
  range `0–10_000`.

New Governor-only setter (separate from Curator's fee functions — Curator has
no authority over protocol split or `revenuePool`):

```solidity
function setProtocolFeeConfig(address _revenuePool, uint16 _protocolFeeShareBps) external onlyGovernor {
    if (_protocolFeeShareBps > 10_000) revert FeeTooHigh();
    if (_protocolFeeShareBps > 0 && _revenuePool == address(0)) revert InvalidFeeRecipient();
    revenuePool = _revenuePool;
    protocolFeeShareBps = _protocolFeeShareBps;
}
```

Config change only affects cycles that have not yet snapshotted — no
retroactive recompute of past `CycleSnapshot`s.

Guard to (re)confirm exists in `setPerformanceFeeBps`: nonzero
`performanceFeeBps` requires `performanceFeeRecipient != address(0)` already
set. Add the check if missing.

### A.3 feeHighWaterMark initialization

Already correct: `snapshotSettlementPrice` initializes `feeHighWaterMark` to
`1_000_000` (1e18-scale, i.e. share price 1 USDT) on the first snapshot when
`_totalShares == 0`. No change — just confirm precision matches
`settlementPrice`'s 1e18 scale (survey confirmed this).

### A.4 Fee split + mint logic

In `snapshotSettlementPrice`, after computing `feeShares` as today:

```solidity
uint256 protocolFeeShares = feeShares * protocolFeeShareBps / 10_000;
uint256 recipientFeeShares = feeShares - protocolFeeShares; // subtraction avoids rounding drift
```

Both must be derived from the same `feeShares` computed once per cycle — no
independent recomputation for each side.

Mint optimization (BaseVault mints Vault Shares directly — never calls
`RevenuePool.receiveFee`):

- `protocolFeeShares == 0`: mint `recipientFeeShares` to
  `performanceFeeRecipient` only.
- `recipientFeeShares == 0`: mint `protocolFeeShares` to `revenuePool` only.
- `revenuePool == performanceFeeRecipient` (and both nonzero): single mint of
  `feeShares` to that shared address.
- Otherwise: two mints.

If neither side has shares (fee forfeited this cycle per existing
`PerformanceFeeSkipped` path), no change to that path.

### A.5 New event

```solidity
event PerformanceFeeDistributed(
    uint256 indexed cycleNumber,
    uint256 feeAssets,
    uint256 feeShares,
    uint256 protocolFeeShares,
    uint256 recipientFeeShares,
    address revenuePool,
    address performanceFeeRecipient
);
```

Emitted once per cycle whenever `feeShares > 0`.

### A.6 RevenuePool: generic ERC-20 withdraw

New Governor-only function for sweeping Vault Shares (and any other
ERC-20 the pool holds) out of RevenuePool:

```solidity
function withdrawToken(address token, address to, uint256 amount) external onlyGovernor {
    IERC20(token).safeTransfer(to, amount);
}
```

Distinct from the existing `withdraw` (USDT-specific sweep) — keep both;
`withdraw` stays as-is for the existing USDT path unless it's trivially
mergeable (check during implementation, don't force a merge if it complicates
the existing call sites).

### A.7 USDT vs Vault Share accounting split

Confirm (survey already indicates this holds): BaseVault minting Vault
Shares to `revenuePool` never touches `receiveFee`/`totalFeesReceived`.
`totalFeesReceived` stays USDT-only, credited only through the existing
`authorizedSources` + `receiveFee` path. Vault Share balances held by
RevenuePool are read via each vault's own `balanceOf(revenuePool)` — no
duplicate bookkeeping added to RevenuePool.

### A.8 Interface / tooling sync

Update `IBaseVault` (new storage getters, `setProtocolFeeConfig`, new event,
new errors if any), `IRevenuePool` (`withdrawToken`), frontend ABI, indexer
event parsing (new `PerformanceFeeDistributed`), and the deploy-time fee-init
script if one exists.

---

## B. ClaimRegistry.recordClaim: Keeper → Curator

**File:** `src/asset-infrastructure/ClaimRegistry.sol:46`,
`src/interfaces/IClaimRegistry.sol`.

Change:

```solidity
// before
if (msg.sender != vault && !IVaultRoles(vault).isKeeper(msg.sender)) revert NotKeeper();
// after
if (msg.sender != vault && IVaultRoles(vault).curator() != msg.sender) revert UnauthorizedClaimRecorder();
```

Rename `IClaimRegistry.NotKeeper` → `UnauthorizedClaimRecorder` (this is a
distinct error type from `IVaultRoles.NotKeeper`, which is untouched — no
collision, just a naming coincidence today).

No new roles or authorization tables. `curator()` continues to be set only
via `BaseVault.setCurator` by the Vault Owner. `BaseVault.setKeeper` has no
bearing on ClaimRegistry after this change (it never gates anything there
once the swap lands).

Update `IClaimRegistry` doc comment (currently says "vault's own Keeper, or
vault itself"), unit tests, and any docs referencing the old permission.

---

## C. BaseVault.markRefundable: Keeper → Curator

**File:** `src/asset-management/vaults/BaseVault.sol:734-749`,
`src/interfaces/IBaseVault.sol`.

Add a plain `_onlyCurator()` internal helper alongside the existing
`_onlyOwner()`/`_onlyKeeper()` (BaseVault.sol:168-174 style):

```solidity
function _onlyCurator() internal view {
    if (msg.sender != curator) revert Unauthorized();
}
```

Replace `_onlyKeeper()` at line 737 with `_onlyCurator()`. Do **not** use
`_onlyCuratorDirectOrTimelock()` — that composite forces Timelock-only once
`FUNDING_FAILED`, which would make Curator-direct refund marking impossible
in exactly the state this function requires.

FUNDING_FAILED state check, PENDING-only filtering, liability transfer
(`pendingDepositLiability`/`pendingDepositByOwner` → `refundableLiability`),
Queue removal, and the downstream `claimRefund` flow are unchanged.

Update `IBaseVault` doc comments, permission tests, failure-path tests.

---

## D. LiquidityEarnVault → repeating cyclical product

**File:** `src/asset-management/vaults/LiquidityEarnVault.sol` (currently 129
lines, extends `BaseVault`).

### D.1 Cycle mechanism

Reuse the existing `CycleState` enum (`Types.sol`:
ACCEPTING→CALCULATING→FULFILLING→COMPLETED→ACCEPTING) already wired through
`StateManager`/`BaseVault` for the repeating open/close of subscription
windows. `ProductState` stays `OPERATING` for the vault's whole life —
no new cycle-length or window-timestamp fields are added to
LiquidityEarnVault. The 7/14-day period referenced in the client memo is an
off-chain/operational cadence for advancing `CycleState`, not an on-chain
enforced timer.

### D.2 No share minting

`totalSupply` and every user's Vault Share balance must stay zero for the
life of the vault:

- Override the deposit-settlement hook to skip `_mint` entirely (currently
  `_processDeposits` mints `lpShares` — remove that call and the
  `settledShares` bookkeeping tied to it for this vault).
- Disable (revert) `claimDeposit`, `requestRedeem`, `claimRedeem`, and the
  existing `distributeCashTokens(address investor, uint256 cashShareAmount)`
  (arbitrary user/amount — superseded by D.3's automatic pro-rata
  distribution).
- If continuing to inherit `BaseVault` for code reuse, the ERC-20 surface
  (`balanceOf`, `totalSupply`, etc.) may remain present but must always
  report zero.

### D.3 Settlement — single-transaction pro-rata distribution

`settle()` (called by `Settlement.submitBatch`, same interface as today, no
new Liquidity-Earn-specific params/Keeper/second pass) does, atomically, in
one call:

1. Sum the USDT of all FIFO requests accepted for this cycle (partial
   per-request acceptance is not supported — a request is either fully
   accepted or stays `Pending`).
2. Bridge the summed USDT to `cashVault` via `ILiquidityBridge` **once**
   for the whole cycle; determine actual Cash Token received either from the
   bridge's return value or a before/after Cash Token balance diff.
3. Take the UnifiedPool-provided bonus USDT amount for the cycle as recorded
   via `poolDistributedAssets` (exact actual transferred-in amount, not a
   requested amount).
4. For every accepted request: `share = requestAssets / cycleTotalAssets`;
   `cashTokenOut = share * totalCashTokenReceived`,
   `bonusUsdtOut = share * totalBonusUsdt`. The **last** accepted request in
   FIFO order absorbs the integer-division remainder for both amounts so the
   cycle's Cash Token and bonus USDT are fully distributed with no dust left
   in the vault.
5. State updates (request status Pending → Completed,
   `pendingDepositLiability` / `pendingDepositByOwner` decrements) happen
   before any external token transfer (checks-effects-interactions), plus a
   reentrancy guard on `settle()`.
6. Transfer both Cash Token and bonus USDT directly to each request's
   `owner` wallet in the same transaction.
7. Any single transfer failure reverts the entire `settle()` call — no
   partial distribution across a cycle boundary.
8. On success, the vault carries no per-user pending claim and no
   cross-cycle liability forward — next cycle can open immediately. Persist
   only: cycle number, accepted-total assets, total Cash Token distributed,
   total bonus USDT distributed, completion flag.

### D.4 Gas / safety bounds

- Enforce a per-cycle maximum accepted-request count, checked when
  Settlement submits the batch for a cycle (reject/require a smaller batch
  above the cap rather than silently truncating). Default cap: start at 200
  requests per cycle as a conservative, Curator-adjustable ceiling — confirm
  final number against realistic worst-case gas for one Cash Token transfer
  + one USDT transfer per request during implementation, and adjust the
  constant if profiling shows headroom or overrun.
- Before submitting a cycle's settlement, verify every accepted request's
  `owner` can receive the Cash Token (no blocklist/blacklist revert, no
  missing ERC-20 receiver requirement) — a single non-receiving address must
  not be able to freeze the whole cycle. Exact mechanism (try/catch per
  transfer with a skip-and-retry-later path vs. hard pre-flight check) to be
  finalized during implementation; the constraint from the client memo is
  that the batch must not brick because one address can't receive tokens.

### D.5 Interface / tooling sync

Update `LiquidityEarnVault`'s public surface, any dedicated interface file,
deployment script, new events (cycle settled: cycle number, totals, per-cycle
completion), frontend cycle/status display, and tests — confirming the full
"queue → invest → auto-distribute → cycle ends → reopens" loop runs
end-to-end for at least 2 consecutive cycles in tests.

---

## E. UnifiedPool: generic vault principal return path

**Files:** `src/asset-management/settlement/UnifiedPool.sol`,
`src/asset-management/vaults/BaseVault.sol`,
`src/interfaces/IUnifiedPool.sol`, `src/interfaces/IBaseVault.sol`.

### E.1 BaseVault: new `returnPrincipalToPool`

```solidity
function returnPrincipalToPool(uint256 amount) external {
    _onlySettlementOperator(); // existing local Settlement Operator role — no new role
    if (unifiedPool == address(0)) revert UnifiedPoolNotSet();
    if (amount == 0) revert ZeroAmount();
    if (amount > freeVaultUSDT()) revert InsufficientFreeUSDT();
    IERC20(usdt).safeIncreaseAllowance(unifiedPool, amount);
    IUnifiedPool(unifiedPool).receiveVaultPrincipal(amount);
}
```

Approve, transfer (inside UnifiedPool's pull), and any local record-keeping
happen atomically in one transaction. `grossManagedAssets()` already
includes `UnifiedPool.pending(vault)` — this call only moves where the
asset physically sits, it does not change total Vault assets.

### E.2 UnifiedPool: `receiveNotePrincipal` → `receiveVaultPrincipal`

```solidity
// before: receiveNotePrincipal(address targetVault, uint256 amount) — Tranche.Note only
// after:
function receiveVaultPrincipal(uint256 amount) external {
    if (!sm.registeredVaults(msg.sender)) revert UnregisteredVault(msg.sender);
    _requireConfiguredActive(msg.sender);
    // Tranche.Note check removed entirely
    usdt.safeTransferFrom(msg.sender, address(this), amount);
    pending[msg.sender] += amount;
    totalPending += amount;
    emit VaultPrincipalReceived(msg.sender, amount, block.timestamp);
}
```

`msg.sender` is both the USDT source and the vault credited — no
caller-supplied target, eliminating the misattribution risk the client
flagged. Credits go straight to `pending[vault]`/`totalPending`, **not**
`unattributedPrincipal` (that pool stays reserved for the existing permissionless
`repayPrincipal` path). Remove the old `Tranche.Note`-only restriction and
the `WrongTranche` check for this function; other Tranche-gated functions
are untouched.

### E.3 Cleanup

Delete the old Note-only principal routing logic tied to
`receiveNotePrincipal` (event `NotePrincipalReceived` → rename/replace with
`VaultPrincipalReceived`; drop `targetVault` from the event too). Update
`IBaseVault`, `IUnifiedPool`, error/event definitions, unit tests, docs.

---

## F. NAVOracle: configurable deviation cap

**Files:** `src/asset-infrastructure/NAVOracle.sol`,
`src/interfaces/INAVOracle.sol`.

- Replace `NAV_DEVIATION_MAX_BPS = 2000` constant with `uint256
  navDeviationMaxBps` storage, set from a constructor param at deploy time.
- New Owner-only setter:
  ```solidity
  function setNAVDeviationMaxBps(uint256 newBps) external onlyOwner {
      if (newBps == 0) revert ZeroDeviationBps();
      navDeviationMaxBps = newBps;
      emit NAVDeviationMaxBpsUpdated(newBps);
  }
  ```
  Only constraint is `newBps > 0` — no upper bound (client explicitly removes
  the old implicit 20% ceiling as a hard limit).
- `updateNAV` computes `maxPrice = previousPrice * (10_000 +
  navDeviationMaxBps) / 10_000` using the now-dynamic value; downward moves
  stay uncapped, unchanged.
- New parameter only affects updates made after the change — no retroactive
  effect on stored `PriceData`.
- Update `INAVOracle`: add `navDeviationMaxBps()` getter, `setNAVDeviationMaxBps`,
  `NAVDeviationMaxBpsUpdated` event, `ZeroDeviationBps` error.

---

## G. Full business-flow E2E test

**Location:** `offchain/scripts/local/` (extends the existing
`runTestPlan.ts`/`testSettlementTail.ts`/`deploy.ts`/`wallets.ts` pattern
already used for scripted local runs against a deployed stack).

Purpose: the client's code review found functions that pass unit tests in
isolation but have no real call path wired up after deployment (e.g. the old
`receiveNotePrincipal` before item E). A Solidity-only unit-test suite
wouldn't have caught that class of bug; a live local run against the actual
deployed contract graph, driven the way Settlement/Curator/users really call
it, will.

Scope — one continuous scripted run exercising real cross-contract call
paths:

1. Deploy full stack locally (reuse `deploy.ts`).
2. Vault creation → Curator config (including new
   `performanceFeeBps`/`revenuePool`/`protocolFeeShareBps` from item A) →
   Governor protocol-fee config.
3. Subscription window → deposits → funding success path.
4. Settlement cycle(s) via `Settlement.submitBatch` → price snapshot → fee
   accrual verifying the A.4 split lands correctly in both
   `performanceFeeRecipient` and `revenuePool` balances.
5. Redemption flow → payout.
6. RevenuePool: confirm `totalFeesReceived` unaffected by the Vault Share
   mint, confirm `withdrawToken` can sweep the minted shares back out.
7. Exercise B (Curator-only `recordClaim`), C (Curator-only
   `markRefundable` on a second, funding-failed vault), E
   (`returnPrincipalToPool`/`receiveVaultPrincipal` round trip) along the
   way as discrete steps in the same or a sibling script.
8. If D (LiquidityEarnVault) has landed by the time this is written, add a
   dedicated run covering at least two consecutive cycles of
   subscribe → settle → auto-distribute → reopen.

This item is written and run last, after B–F (and ideally D) have landed,
since it is meant to validate the finished wiring rather than drive it.

---

## Sequencing

1. **B** — ClaimRegistry Keeper→Curator (small, isolated)
2. **C** — markRefundable Keeper→Curator (small, isolated)
3. **F** — NAVOracle configurable deviation (small, isolated)
4. **E** — UnifiedPool generic principal path (small-medium, isolated)
5. **A** — Fee model overhaul (medium, touches BaseVault + RevenuePool +
   indexer/ABI)
6. **D** — LiquidityEarnVault rewrite (largest, most novel logic)
7. **G** — Full E2E test (last, validates B–F and D together)

Each stage: implement → unit tests for that stage → commit, before moving to
the next. Interface/ABI/indexer sync happens alongside each stage rather
than as a separate pass at the end.
