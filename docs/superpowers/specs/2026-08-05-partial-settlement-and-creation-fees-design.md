# Client Feedback 2026-08-05 — Partial Queue Settlement & Protocol Creation Fees

Source: client simulation-run feedback (two items), 2026-08-05.

Branch: `feat/client-fixes-202608` (PR #13, continuing on top of the existing
2026-08-04 client-fixes work already on this branch).

This spec covers two independent items:

- **A. Partial settlement of EarnVault's deposit/redeem queue** — a request no
  longer has to be entirely accepted or entirely rejected within one
  settlement cycle.
- **B. Protocol-level creation fees** — `AssetRegistry.registerAsset` and
  `VaultFactory.deployVault` require a protocol-configured fee, payable in
  native currency, a governance token, or a designated stablecoin.

They touch disjoint contracts and can be implemented/tested independently, in
either order.

---

## A. Partial settlement of EarnVault's deposit/redeem queue

**Scope:** `EarnVault`'s net-settlement path only — `BaseVault`, `Settlement`,
`Types.sol`. `LiquidityEarnVault` is out of scope: it has no redeem queue and
already distributes its whole accepted batch pro-rata in one shot with no
per-request accept/reject split, so there's nothing to partially settle
against. Its `settle()` override picks up the new shared signature (see A.4)
but keeps its existing all-or-nothing behavior per request.

**Files:** `src/libs/Types.sol`, `src/asset-management/vaults/BaseVault.sol`,
`src/asset-management/vaults/LiquidityEarnVault.sol`,
`src/asset-management/settlement/Settlement.sol`,
`src/interfaces/IBaseVault.sol`, `src/interfaces/ISettlement.sol`.

### A.1 Behavior

Worked example from the client: a cycle has 350k USDT of pending redeems
(including carried-over requests from a prior cycle) and a 400k USDT deposit
request at the head of the deposit queue.

- Deposit side: 350k of the 400k is accepted and settled at this cycle's NAV
  (shares minted for 350k); the remaining 50k is **refunded immediately, in
  the same transaction** — it does not re-enter the queue or wait for a
  future cycle.
- Redeem side: fully covered this cycle (350k paid out, shares burned).

General rule (not just this scenario):

- **Deposit requests always resolve fully within the cycle they're touched.**
  Either the whole request is accepted, or part of it is accepted (shares
  minted for that part) and the untouched remainder is refunded immediately.
  A deposit request is never left "partially queued" across cycles.
- **Redeem requests may span multiple cycles.** Whatever portion is not paid
  out this cycle stays queued, in its original FIFO position, to be
  reconsidered in a future cycle. A redeem request may be partially filled
  more than once before it fully clears.

This asymmetry is deliberate: a deposit's unaccepted portion represents
capital the vault has decided it doesn't need this cycle, so holding it
serves no purpose (matches the client's "减少因整笔金额不匹配造成的资金闲置"
goal). A redeem is a standing liability that must eventually be paid, so it
stays queued rather than being force-refunded/cancelled.

### A.2 Data model

`Types.sol` gains one new file-scope struct, shared between `IBaseVault` and
`ISettlement`:

```solidity
/// @notice One request's per-cycle settlement instruction. `settleAmount` is
///         in assets (USDT) for a deposit, in shares for a redeem.
struct RequestSettlement {
    uint256 requestId;
    uint256 settleAmount;
}
```

No new `DepositRequestState`/`RedeemRequestState` enum values are needed.

`BaseVault.DepositRequestInternal`: unchanged shape. `assets` keeps meaning
"originally requested amount"; `settledShares` after `settle()` reflects
shares minted for whatever portion was actually accepted (which may be less
than `assets`). The request always ends the cycle it's touched in as
`SETTLED` — there's no in-between state to represent, since the unaccepted
remainder is refunded synchronously rather than persisted.

`BaseVault.RedeemRequestInternal` gains one field:

```solidity
struct RedeemRequestInternal {
    address owner;
    uint256 shares;            // ORIGINAL requested shares — immutable after creation
    uint256 remainingShares;   // NEW — starts == shares, decremented on each partial fill
    uint256 settledAssets;     // now CUMULATIVE across however many cycles partially filled it
    uint256 queuePosition;
    uint256 cycleNumber;       // cycle of the most recent (partial or final) settlement
    RedeemRequestState state;
}
```

`requestRedeem` initializes `remainingShares = shares`. While
`remainingShares > 0` the request stays `QUEUED` (including after one or more
partial fills). It flips to `SETTLED` — and only then — the cycle
`remainingShares` reaches 0. `claimRedeem` is unchanged: it already just reads
`settledAssets` once `state == SETTLED`, and cumulative accumulation makes
that correct with no other edits.

### A.3 Queue interaction — no changes to Queue.sol

`Queue.sol`'s `dequeue()` enforces strict FIFO order and has no concept of
"partial" — it either removes a request from the head or it doesn't. That's
exactly what's needed: a request that isn't fully cleared this cycle simply
isn't included in the ids passed to `dequeue()`, so it's left untouched at
the FIFO head for the next cycle. No contract change required there.

`Queue`'s `orderHash` commits to the request's amount *at enqueue time* (see
existing NatSpec: `keccak256(abi.encode(requestId, owner, amount,
enqueueTimestamp))`) — an immutable record of the original order, not a live
running balance. That stays correct as-is; `verifyOrder` needs no change
either, since nothing on-chain currently calls it (it's an off-chain/view
convenience) and its contract is "was this the original order", not "is this
still owed".

### A.4 BaseVault.settle() — new signature

```solidity
function settle(
    uint256 cycleNumber,
    RequestSettlement[] calldata deposits,
    RequestSettlement[] calldata redeems,
    uint256 poolDistributedAssets
) external returns (uint256[] memory fullyClearedRedeemIds);
```

(`onlySettlementContract` modifier unchanged.)

`_processDeposits`:

```solidity
function _processDeposits(RequestSettlement[] calldata items, uint256 cycleNumber, uint256 settlementPrice)
    internal
    virtual
    returns (uint256 acceptedTotal)
{
    for (uint256 i = 0; i < items.length; i++) {
        DepositRequestInternal storage req = _depositRequests[items[i].requestId];
        if (req.state == DepositRequestState.SETTLED) revert RequestAlreadySettled(items[i].requestId);
        if (req.state != DepositRequestState.PENDING) revert RequestNotFound(items[i].requestId);

        uint256 settleAmount = items[i].settleAmount;
        if (settleAmount == 0 || settleAmount > req.assets) revert InvalidSettleAmount(items[i].requestId);

        uint256 shares = Math.mulDiv(settleAmount, 1e18, settlementPrice);
        req.settledShares = shares;
        req.state = DepositRequestState.SETTLED;
        req.cycleNumber = cycleNumber;

        pendingDepositLiability -= req.assets;             // full original leaves the pending bucket
        pendingDepositByOwner[req.owner] -= req.assets;
        acceptedTotal += settleAmount;

        _mintShares(address(this), shares);                // held for claimDeposit

        uint256 refund = req.assets - settleAmount;
        if (refund > 0) {
            IERC20(usdt).safeTransfer(req.owner, refund);
        }
        emit DepositSettled(items[i].requestId, req.assets, settleAmount, refund, cycleNumber, block.timestamp);
    }
}
```

`_processRedeems`:

```solidity
function _processRedeems(RequestSettlement[] calldata items, uint256 cycleNumber, uint256 settlementPrice)
    internal
    returns (uint256 acceptedTotal, uint256[] memory fullyClearedIds)
{
    fullyClearedIds = new uint256[](items.length); // upper bound; trimmed by caller or left sparse+compacted
    uint256 clearedCount;

    for (uint256 i = 0; i < items.length; i++) {
        RedeemRequestInternal storage req = _redeemRequests[items[i].requestId];
        if (req.state != RedeemRequestState.QUEUED) revert RequestNotFound(items[i].requestId);

        uint256 settleAmount = items[i].settleAmount; // shares
        if (settleAmount == 0 || settleAmount > req.remainingShares) revert InvalidSettleAmount(items[i].requestId);

        uint256 assetsOut = Math.mulDiv(settleAmount, settlementPrice, 1e18);
        req.remainingShares -= settleAmount;
        req.settledAssets += assetsOut;
        req.cycleNumber = cycleNumber;

        reservedRedeemLiability += assetsOut;
        acceptedTotal += assetsOut;

        _burnShares(address(this), settleAmount);

        if (req.remainingShares == 0) {
            req.state = RedeemRequestState.SETTLED;
            fullyClearedIds[clearedCount++] = items[i].requestId;
        }
        emit RedeemSettled(
            items[i].requestId, req.shares, settleAmount, req.remainingShares, assetsOut, cycleNumber, block.timestamp
        );
    }

    // trim fullyClearedIds to clearedCount before returning
}
```

`settle()` itself: same liquidity/subscription-cap checks as today, just
fed by the new `acceptedDepositTotal`/`acceptedRedeemTotal` (which are now
sums of `settleAmount`, not sums of full request size — this is a strict
generalization, full-accept is just `settleAmount == req.assets`/`shares`).
Returns `fullyClearedRedeemIds` from `_processRedeems`.

New events (`IBaseVault.sol`), emitted for *every* processed request (not
only partial ones), so indexer/front-end have one uniform source of truth
rather than needing to infer "was this partial" from event absence:

```solidity
event DepositSettled(
    uint256 indexed requestId, uint256 originalAssets, uint256 settledAssets, uint256 refundedAssets,
    uint256 indexed cycleNumber, uint256 timestamp
);
event RedeemSettled(
    uint256 indexed requestId, uint256 originalShares, uint256 settledSharesThisCycle, uint256 remainingShares,
    uint256 settledAssetsThisCycle, uint256 indexed cycleNumber, uint256 timestamp
);
```

New error: `error InvalidSettleAmount(uint256 requestId);` (zero, or exceeds
what's left on the request).

### A.5 Settlement.sol — submitBatch reordering

`ISettlement.VaultSettlement` changes from flat id arrays to:

```solidity
struct VaultSettlement {
    Distribution distribution;
    RequestSettlement[] deposits;
    RequestSettlement[] redeems;
}
```

`submitBatch` execution order changes from
"dequeue both queues, then snapshot+settle" to:

```solidity
if (vs.deposits.length > 0) {
    queue.dequeue(v, QueueType.DEPOSIT, _ids(vs.deposits)); // deposits always fully leave the queue
}
IBaseVault(v).snapshotSettlementPrice(instruction.cycleNumber);
uint256[] memory clearedRedeemIds = IBaseVault(v).settle(
    instruction.cycleNumber, vs.deposits, vs.redeems, vs.distribution.amount
);
if (clearedRedeemIds.length > 0) {
    queue.dequeue(v, QueueType.REDEEM, clearedRedeemIds);
}
```

(`_ids()` is a small local helper extracting `.requestId` from
`RequestSettlement[]` — needed since `Queue.dequeue` still takes a flat
`uint256[]`, which is correct: Queue has no reason to know about partial
amounts.) `distribution.amount > 0 → unifiedPool.distribute(...)` and
`sm.completeCycle(v)` keep their existing positions in the loop.

`_validateConservation` is unaffected — it already just sums
`distribution.amount` per vault against `unifiedPool.availableToDistribute`,
which has no dependency on how deposits/redeems are internally split.

### A.6 LiquidityEarnVault.settle() — signature parity, no behavior change

Its override adopts the same `(cycleNumber, RequestSettlement[] deposits,
RequestSettlement[] redeems, poolDistributedAssets) returns (uint256[])`
shape (still reverting via `RedeemNotSupported` if `redeems.length != 0`,
returning an empty array). To preserve today's all-or-nothing per-request
behavior, it requires `deposits[i].settleAmount == request.assets` for every
entry (revert otherwise) rather than allowing partial acceptance — this vault
type is explicitly out of scope for the new partial-fill behavior (§A, Scope).

### A.7 writeDownInsolvency — closing a hole this change opens

`_writeDownSettledRedeems` currently only haircuts `state == SETTLED`
redeems. After this change, a redeem can be `QUEUED` with a nonzero
`settledAssets` (partially filled, still waiting on the rest) — that reserved
liability needs to be haircut-able too, or an insolvency write-down can't
reach it. Extend the eligibility check to
`state == SETTLED || (state == QUEUED && settledAssets > 0)`, and haircut
against `settledAssets` in both cases (the field already means "cumulative
reserved amount" in both states after this change, so the existing haircut
math is unchanged — only the eligibility guard widens).

### A.8 Test plan

- Unit: deposit request settled fully vs. partially (refund emitted, shares
  correct, `pendingDepositLiability`/`pendingDepositByOwner` fully cleared in
  both cases).
- Unit: redeem request partially filled once, twice, then fully clears across
  3 cycles — `remainingShares`, `settledAssets`, dequeue timing (only cleared
  on the 3rd) at each step; FIFO position preserved (a later-queued request
  cannot be dequeued ahead of the still-partially-queued one).
- Unit: `InvalidSettleAmount` reverts — zero, and amount exceeding what's left
  on the request (both deposit and redeem).
- Integration: reproduce the client's exact worked example (400k deposit head
  vs 350k redeem demand) end-to-end through `Settlement.submitBatch`.
- Unit: `writeDownInsolvency` haircutting a partially-filled, still-`QUEUED`
  redeem.
- `LiquidityEarnVault`: existing tests updated for the new signature; add one
  asserting a non-full `settleAmount` reverts (behavior-preservation check).

---

## B. Protocol creation fees (AssetRegistry + VaultFactory)

**Files:** new `src/asset-infrastructure/ProtocolFeeConfig.sol` (+
`src/interfaces/IProtocolFeeConfig.sol`), `src/asset-infrastructure/AssetRegistry.sol`,
`src/asset-management/vaults/VaultFactory.sol`,
`src/asset-management/settlement/RevenuePool.sol` (+ `IRevenuePool.sol`),
`src/libs/Types.sol`, `script/Deploy.s.sol`.

### B.1 Behavior

Before `AssetRegistry.registerAsset` registers a new asset (deploys its
`RWAToken`) and before `VaultFactory.deployVault` deploys a new Vault, the
caller must pay a protocol-configured creation fee. Both entry points stay
permissionless (anyone may still register an asset / deploy a vault — the fee
gate doesn't add an allowlist, per your requirement that this "only收费,
不应改变任何人无许可发行资产或创建Vault的资格"). The creator chooses *which*
of three payment rails to use; the protocol — never the creator — decides the
amount and the recipient:

1. Native currency (BNB/ETH depending on chain).
2. The protocol's governance token (address configured by Governor; no such
   token is deployed yet, so this rail defaults to fee `0`/effectively
   disabled until Governor wires a real token address).
3. A designated stablecoin (e.g. USDT — configured by Governor, independent
   of the protocol-wide `usdt` address used elsewhere, since a creation fee
   need not use the same stablecoin as vault accounting).

Fee amounts are keyed by (action, payment rail) and independently
Governor-configurable per deployment/network — deploying `ProtocolFeeConfig`
fresh on each chain with different Governor-set values satisfies "不同网络...
应由协议层统一配置" without the contract itself needing chain-awareness.
Every (action, rail) amount may be set to 0.

If payment fails, is short, or the chosen rail isn't configured
(zero-address token for a nonzero fee), the entire creation transaction
reverts — enforced structurally by running fee collection as the *first*
effect in both `registerAsset` and `deployVault`, before any asset/vault
state is created.

### B.2 New enums (`Types.sol`)

```solidity
enum CreationFeeAction { RegisterAsset, DeployVault }
enum FeePaymentKind { Native, Governance, Stable }
```

### B.3 ProtocolFeeConfig — pure configuration, no custody

```solidity
interface IProtocolFeeConfig {
    event FeeSet(CreationFeeAction indexed action, FeePaymentKind indexed kind, uint256 amount, uint256 timestamp);
    event PaymentTokenSet(FeePaymentKind indexed kind, address token, uint256 timestamp);
    event RevenuePoolSet(address oldPool, address newPool, uint256 timestamp);

    error ZeroAddress();
    error NotGovernor();
    error NativeKindHasNoToken();

    function setFee(CreationFeeAction action, FeePaymentKind kind, uint256 amount) external;
    function setPaymentToken(FeePaymentKind kind, address token) external; // Governance/Stable only
    function setRevenuePool(address pool) external;

    function feeOf(CreationFeeAction action, FeePaymentKind kind) external view returns (uint256);
    function paymentTokenOf(FeePaymentKind kind) external view returns (address); // address(0) for Native
    function revenuePool() external view returns (address);
}
```

Access control: `onlyGovernor` via existing `IHyperAccessControl`
(`GOVERNOR_ROLE`), same pattern as `RevenuePool`. `ProtocolFeeConfig` never
holds funds — `AssetRegistry`/`VaultFactory` collect and forward directly to
`revenuePool()`, so there's no approval-to-ProtocolFeeConfig step for callers
to get wrong.

### B.4 AssetRegistry — constructor + registerAsset changes

`AssetRegistry`'s constructor is currently no-arg (fully decoupled — no
`IHyperAccessControl`/`StateManager`/Vault dependency at all, per its own
NatSpec). This is the one place that decoupling narrows: it now needs an
immutable reference to `ProtocolFeeConfig`.

```solidity
constructor(address feeConfig_) {
    if (feeConfig_ == address(0)) revert ZeroAddress();
    feeConfig = IProtocolFeeConfig(feeConfig_);
    nextAssetId = 1;
    mintBurnController = address(new MintBurnController(address(this)));
}

function registerAsset(
    bytes32 metadataHash,
    string calldata name,
    string calldata symbol,
    uint8 decimals,
    FeePaymentKind feeKind
) external payable override returns (uint256 assetId, address token) {
    _collectCreationFee(CreationFeeAction.RegisterAsset, feeKind);
    // ... existing body unchanged ...
}
```

`_collectCreationFee` (internal, ~15 lines, duplicated in `VaultFactory` too
— two call sites don't justify a shared library per Simplicity First):

```solidity
function _collectCreationFee(CreationFeeAction action, FeePaymentKind kind) internal {
    uint256 fee = feeConfig.feeOf(action, kind);
    if (kind == FeePaymentKind.Native) {
        if (msg.value != fee) revert IncorrectNativeFee(fee, msg.value);
        if (fee > 0) {
            (bool ok,) = feeConfig.revenuePool().call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        }
    } else {
        if (msg.value != 0) revert UnexpectedNativeValue();
        if (fee > 0) {
            address token = feeConfig.paymentTokenOf(kind);
            if (token == address(0)) revert PaymentTokenNotConfigured(kind);
            IERC20(token).safeTransferFrom(msg.sender, feeConfig.revenuePool(), fee);
        }
    }
    emit AssetCreationFeeCollected(action, kind, fee, msg.sender, block.timestamp);
}
```

(`VaultFactory`'s copy is identical apart from the emitted event name/type.)

### B.5 VaultFactory — deployVault changes

Same `_collectCreationFee` pattern; `deployVault` becomes `payable` and gains
a `FeePaymentKind feeKind` field on `VaultParams` (simpler than a separate
positional param, since `VaultParams` is already the single struct carrying
per-deploy choices). Fee collection is the first statement in `deployVault`,
before `earnDeployer.deploy(...)`/`lpDeployer.deploy(...)`.

### B.6 RevenuePool — accept native currency

```solidity
receive() external payable {}

function withdrawNative(address to, uint256 amount) external override {
    _onlyGovernor();
    if (to == address(0)) revert ZeroAddress();
    (bool ok,) = to.call{value: amount}("");
    if (!ok) revert NativeTransferFailed();
    emit NativeWithdrawn(to, amount, block.timestamp);
}
```

Mirrors the existing `withdrawToken` (Governor-only ERC-20 sweep) — this is
the native-currency equivalent, needed because the existing `withdraw` is
USDT-specific and `withdrawToken` is ERC-20-specific; neither handles plain
native currency.

### B.7 Deploy.s.sol

`ProtocolFeeConfig` deploys before `AssetRegistry`/`VaultFactory` (both now
depend on it). Default: all fees 0, both `Governance`/`Stable` tokens unset —
matches "允许设置为零" and keeps existing local/E2E deployments working
unchanged (creators pay `Native` kind with `msg.value == 0`) unless a test
explicitly configures nonzero fees to exercise the new path.

### B.8 New interface members (IAssetRegistry / IVaultFactory)

Each of `IAssetRegistry` and `IVaultFactory` gains its own copy of:

```solidity
event AssetCreationFeeCollected( // VaultCreationFeeCollected in IVaultFactory
    CreationFeeAction indexed action, FeePaymentKind indexed kind, uint256 amount, address indexed payer, uint256 timestamp
);

error IncorrectNativeFee(uint256 expected, uint256 provided);
error UnexpectedNativeValue();
error FeeTransferFailed();
error PaymentTokenNotConfigured(FeePaymentKind kind);
```

Not shared via a common interface — each contract's own fee-collection
surface, consistent with how the rest of each interface is already
self-contained (only the `CreationFeeAction`/`FeePaymentKind` enums and the
`IProtocolFeeConfig` interface are shared, since those describe the config
data itself, not each contract's own collection mechanics).

### B.9 Test plan

- Unit: `ProtocolFeeConfig` — only Governor can set fees/tokens/revenuePool;
  `feeOf`/`paymentTokenOf` default to 0/address(0).
- Unit: `AssetRegistry.registerAsset` — Native (exact `msg.value`, wrong
  `msg.value` reverts), Stable/Governance (pulls exact amount, insufficient
  allowance/balance reverts, unconfigured token reverts), fee == 0 (no-op,
  still permissionless), whole tx reverts on fee failure (no asset/token
  created).
- Unit: same matrix for `VaultFactory.deployVault`.
- Unit: `RevenuePool.receive()`/`withdrawNative` — balance accounting,
  Governor-only.
- Integration: end-to-end registerAsset + deployVault each paid via all three
  rails against a local deployment, confirming funds land in `RevenuePool`
  and nowhere else.

---

## Sequencing

No dependency between A and B — implement/test/commit independently, in
either order. Suggested order: A first (touches existing hot-path contracts
already under active test coverage on this branch), then B (net-new
contract + two call-site integrations). Update `control-panel/index.html`'s
function registry for both new/changed entry points as a final step, per this
branch's existing convention (see the 2026-08-04 spec's control-panel task).
