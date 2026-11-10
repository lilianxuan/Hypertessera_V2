# Module E — Proposed Event-Variable Whitelist (Draft for Company review)

**Date:** 2026-07-16 · **Status:** Developer-proposed starting list, per client request (2026-07-16) to
not block Module E kickoff on the Company-side event-variable whitelist (development-plan §5.4/§6).
Company to review and add/amend — this is a starting point, not a final freeze.

**Scope.** Every event currently emitted by the W1–W4 contracts (`src/`), i.e. everything available
for `OnChainEventIndexer` to subscribe to as of this W4 build. Grouped by contract; the "Consumer"
column notes which Module E component is the primary reader. Events already itemized in
development-plan.md's per-week "Events to index" blocks (§3.1.2, §3.2.2, §3.3.2, §3.4.2) are included
here for completeness alongside a few not previously called out explicitly (`HyperAccessControl` role
events, `VaultFactory.VaultDeployed`, `LiquidityBridge`/`LiquidityAdapter`, ERC-20 `Transfer`/`Approval`
on token contracts, and `UnifiedPool`'s new UUPS `Upgraded` event).

---

## Module A — Governance

**`HyperAccessControl`** (OZ `AccessControl` standard events)
| Event | Consumer |
|---|---|
| `RoleGranted(role, account, sender)` | SDK (`hasRole` cache), ops dashboard |
| `RoleRevoked(role, account, sender)` | SDK, ops dashboard |

**`ProtocolTimelock`**
| Event | Consumer |
|---|---|
| `ParamChangeScheduled(changeId, target, data, executableAfter, expiresAt)` | KeeperBot (executes once due), ops dashboard |
| `ParamChangeExecuted(changeId, executedAt)` | Indexer |
| `ParamChangeCancelled(changeId, cancelledAt)` | Indexer |
| `DelayUpdated(oldDelay, newDelay, timestamp)` | Indexer |

**`StateManager`**
| Event | Consumer |
|---|---|
| `VaultRegistered(vault, initialProduct, initialCycle, timestamp)` | Indexer (vault registry) |
| `ProductStateChanged(vault, from, to, timestamp)` | KeeperBot (drives next transition), SDK `getStateContext` |
| `CycleStateChanged(vault, from, to, cycleNumber, timestamp)` | KeeperBot, SettlementOperator (cycle gating) |
| `VaultPauseSet(vault, reason, actor, timestamp)` | KeeperBot (halt), ops alerting |
| `VaultUnpaused(vault, previousReason, actor, timestamp)` | KeeperBot |
| `ProductParamsSet(vault, timestamp)` | Indexer |
| `ModulePaused(id, actor, timestamp)` | KeeperBot, ops alerting |
| `ModuleUnpaused(id, actor, timestamp)` | KeeperBot |

---

## Module D — Asset infrastructure

**`NAVOracle`**
| Event | Consumer |
|---|---|
| `NAVUpdated(vault, nav, dataTimestamp, updatedAt, signer)` | SettlementOperator (freshness/deviation pre-check), KeeperBot (staleness alert) |
| `SignerAuthorized(vault, signer, timestamp)` | Indexer |
| `SignerRevoked(vault, timestamp)` | Indexer |
| `NavToleranceSet(vault, bps, timestamp)` | Indexer, SettlementOperator |

**`MintBurnController`**
| Event | Consumer |
|---|---|
| `MintInitiated(nonce, assetId, amount, to, timestamp)` | Indexer, ops dashboard (Issuer/TokenAgent workflow) |
| `MintApproved(nonce, assetId, amount, to, timestamp)` | Indexer |
| `BurnInitiated(nonce, assetId, amount, from, timestamp)` | Indexer |
| `BurnApproved(nonce, assetId, amount, from, timestamp)` | Indexer |

**`AssetRegistry`**
| Event | Consumer |
|---|---|
| `AssetRegistered(assetId, owner, token, metadataHash, timestamp)` | Indexer, SDK `getAssetInfo` |
| `AssetMetadataUpdated(assetId, oldHash, newHash, timestamp)` | Indexer |
| `AssetOwnershipTransferred(assetId, oldOwner, newOwner, timestamp)` | Indexer |
| `AssetDeactivated(assetId, timestamp)` | Indexer |

**`RWAToken`** (per `assetId`)
| Event | Consumer |
|---|---|
| `Transfer(from, to, value)` / `Approval(owner, spender, value)` | Indexer (balance cache) |
| `ControllerSet(controller, timestamp)` | Indexer |
| `TransferPathsUpdated(timestamp)` | Indexer, compliance dashboard |
| `AddressListUpdated(listId, added, count, timestamp)` | Indexer, compliance dashboard |
| ~~`ControllerTransfer(controller, from, to, amount, timestamp)`~~ | ~~Indexer~~ — event removed 2026-08-17 along with ERC-1644 `controllerTransfer` (never emitted on-chain) |

**`WrappedAsset`** (per `assetId`, deployed by `ReservePSM`)
| Event | Consumer |
|---|---|
| `Transfer(from, to, value)` / `Approval(owner, spender, value)` | Indexer (balance cache; future DeFi interop tracking) |

**`ReservePSM`**
| Event | Consumer |
|---|---|
| `WrappedTokenDeployed(assetId, mode, wrappedToken, underlyingToken, timestamp)` | Indexer, SDK |
| `AuthorizedSignerSet(assetId, signer, timestamp)` | Indexer |
| `Wrapped(assetId, caller, amount, to, timestamp)` | Indexer |
| `MintedWithAuthorization(assetId, to, amount, nonce, documentId, timestamp)` | Indexer, BVI SPV ops monitor (lock registered) |
| `Unwrapped(assetId, caller, amount, to, timestamp)` | Indexer |
| `ReleaseRequested(assetId, caller, amount, to, documentId, timestamp)` | BVI SPV trigger (redeem HK Note), KeeperBot (Reserve PSM lag alert) |
| `Paused(timestamp)` / `Unpaused(timestamp)` | KeeperBot, ops alerting |
| `AssetPaused(assetId, timestamp)` / `AssetUnpaused(assetId, timestamp)` | Indexer, ops alerting |

**`PoRRegistry`**
| Event | Consumer |
|---|---|
| `ReserveProofPublished(assetId, documentHash, uri, publisher, timestamp)` | Indexer, PoR dashboard |

**`ClaimRegistry`**
| Event | Consumer |
|---|---|
| `ClaimRecorded(claimId, vault, owner, requestId, assets, kind, timestamp)` | Indexer, ops dashboard (unclaimed-position sweep) |
| `StateManagerSet(stateManager, timestamp)` | Indexer |

---

## Module B — Vaults

**`BaseVault`** (emitted by `EarnVault` Cash/Note and `LiquidityEarnVault`)
| Event | Consumer |
|---|---|
| `DepositRequested(requestId, owner, assets, timestamp)` | SettlementOperator (`getPendingDeposits`), Indexer |
| `DepositClaimed(requestId, receiver, shares, timestamp)` | Indexer, SDK |
| `RedeemRequested(requestId, owner, shares, timestamp)` | Indexer — **source-of-truth for queue reconstruction** |
| `RedeemClaimed(requestId, receiver, assets, timestamp)` | Indexer, SDK |
| `RequestCancelled(requestId, actor, timestamp)` | Indexer |
| `SettlementProcessed(depositCount, redeemCount, poolDistributedAssets, timestamp)` | Indexer, SettlementOperator |
| `GateUpdated(oldGate, newGate, timestamp)` | Indexer |
| `SettlementSet(settlement, timestamp)` | Indexer |
| `RefundClaimed(requestId, owner, assets, timestamp)` | Indexer (FUNDING_FAILED flow) |
| `UnifiedPoolSet(pool, timestamp)` | Indexer |
| `AdapterAdded(adapter, timestamp)` / `AdapterRemoved(adapter, timestamp)` | Indexer |
| `PerformanceFeeUpdated(bps, timestamp)` / `PerformanceFeeRecipientUpdated(recipient, timestamp)` | Indexer |
| `PerformanceFeeAccrued(cycleNumber, feeAssets, feeShares, timestamp)` / `PerformanceFeeSkipped(cycleNumber, feeAssets, timestamp)` | Indexer, SDK |
| `SettlementPriceSnapshotted(cycleNumber, totalAssets, totalSupply, settlementPrice, timestamp)` | SDK (`getNAV`-adjacent reads), Indexer |
| `CycleNetFlow(cycleNumber, acceptedDepositTotal, acceptedRedeemTotal, netFlow)` | Indexer, SettlementOperator |
| `RequestWrittenDown(requestId, haircut, newAmount, timestamp)` | Indexer, ops alerting (insolvency) |
| `InsolvencyWrittenDown(grossAssets, liabilitiesBefore, liabilitiesAfter, timestamp)` | Indexer, ops alerting (insolvency) |
| `Transfer(from, to, amount)` / `Approval(owner, spender, amount)` | Indexer (share balance cache) |

**`EarnVault`**
| Event | Consumer |
|---|---|
| `SyncDeposit(receiver, assets, shares, timestamp)` | Indexer (LiquidityBridge sync path) |

**`LiquidityEarnVault`**
| Event | Consumer |
|---|---|
| `CashTokensReceived(fromBridge, assets, cashShares, timestamp)` | Indexer |
| `CashTokensDistributed(investor, cashShares, timestamp)` | Indexer, SDK (LP exit distribution) |

**`VaultFactory`**
| Event | Consumer |
|---|---|
| `VaultDeployed(vault, tranche, cycleDuration, timestamp)` *(signature per `IVaultFactory`)* | Indexer (vault registry bootstrap) |

**`LiquidityBridge`**
| Event | Consumer |
|---|---|
| `DepositBridged(fromVault, toVault, assets, shares, timestamp)` *(signature per `ILiquidityBridge`)* | Indexer |

---

## Module C — Settlement

**`UnifiedPool`**
| Event | Consumer |
|---|---|
| `TrancheVaultAdded(tranche, vault, timestamp)` | Indexer |
| `TrancheVaultDeactivated(vault, timestamp)` / `TrancheVaultReactivated(vault, timestamp)` | Indexer |
| `InterestRepaid(tranche, vault, amount, timestamp)` | Indexer, SettlementOperator (pending reconciliation) |
| `PrincipalRepaid(vault, amount, timestamp)` | Indexer, SettlementOperator |
| `NotePrincipalReceived(sourceVault, targetVault, amount, timestamp)` | Indexer |
| `Distributed(vault, amount, timestamp)` | Indexer, SettlementOperator |
| `ThirdPartyTransferExecuted(operator, recipient, amount, referenceId, timestamp)` | Indexer |
| `Upgraded(implementation)` *(UUPS, from `ERC1967Utils`)* | Ops alerting (implementation change) |

**`RevenuePool`**
| Event | Consumer |
|---|---|
| `FeeReceived(source, amount, timestamp)` | Indexer |
| `FeeWithdrawn(recipient, amount, timestamp)` | Indexer |
| `SourceAuthorized(source, timestamp)` | Indexer |
| `SourceRevoked(source, timestamp)` | Indexer |
| `YieldStrategySet(strategy, timestamp)` | Indexer |

**`Queue`**
| Event | Consumer |
|---|---|
| `RequestQueued(vault, queueType, requestId, slotIndex, orderHash, timestamp)` | Indexer — **queue reconstruction** |
| `RequestDequeued(vault, queueType, requestId, newHead, timestamp)` | Indexer, SettlementOperator |
| `RequestCancelledFromQueue(vault, queueType, requestId, timestamp)` | Indexer |

**`Settlement`**
| Event | Consumer |
|---|---|
| `SettlementExecuted(batchHash, cycleNumber, timestamp)` | SettlementOperator (batch confirmation), Indexer |
| `OperatorAdded(operator, timestamp)` | Indexer, ops dashboard |
| `OperatorRemoved(operator, timestamp)` | Indexer |
| `ThresholdUpdated(oldThreshold, newThreshold, timestamp)` | Indexer, SettlementOperator (signature count) |

---

## Strategy — Adapters

**`AdapterFactory`**
| Event | Consumer |
|---|---|
| `AdapterDeployed(adapter, vault, timestamp)` | Indexer (adapter registry) |

**`BaseAdapter`** (emitted by `FirstPeriodAdapter` and `LiquidityAdapter`)
| Event | Consumer |
|---|---|
| `BuyOrderCreated(orderId, amount, destination, mode, timestamp)` | Indexer, ops dashboard (Curator/Allocator flow) |
| `SellOrderCreated(orderId, exitAsset, exitAmount, proceeds, payer, assetRecipient, expiry, timestamp)` | Indexer, ops dashboard |
| `SellOrderFunded(orderId, payer, proceeds, timestamp)` | Indexer, ops dashboard (the counterparty has paid; delivery may proceed) |
| `BuyOrderExecuted(orderId, timestamp)` | Indexer |
| `SellOrderExecuted(orderId, exitAsset, exitAmount, assetRecipient, proceeds, timestamp)` | Indexer |
| `SellOrderRefunded(orderId, payer, proceeds, timestamp)` | Indexer, ops alerting (an exit failed to deliver) |
| `OrderCancelled(orderId, orderType, timestamp)` | Indexer — `orderType` is now 0=buy, 1=sell only |
| `DealDataUpdated(orderId, newValue, timestamp)` | Indexer (`realAssets()` valuation feed) |
| `DealValueCleared(orderId, timestamp)` | Indexer (`TOKEN_RETURN` position zeroed) |
| `DealValueReducedBySell(orderId, dealKey, reduction, newValue, timestamp)` | Indexer (position retired by a sale, not by the Data Provider) |
| `CapitalDeployed(destination, amount, timestamp)` | Indexer |
| `CapitalRecalled(amount, timestamp)` | Indexer |
| `AllocatorFrozen(actor, timestamp)` / `AllocatorUnfrozen(actor, timestamp)` | KeeperBot, ops alerting |

> **[REVISED 2026-08-28]** `RebalanceOrderCreated` / `RebalanceOrderExecuted` /
> `RebalanceDealDataUpdated` / `RebalanceDealValueCleared`, and RWAAdapter's
> `RWAWithdrawOrderCreated` / `RWAWithdrawOrderExecuted` / `RWAWithdrawn`, no longer exist —
> both order books were deleted. `SellOrderCreated` and `SellOrderExecuted` changed shape.
> An indexer must handle `SellOrderFunded` as a distinct stage: an order that is created is not
> yet paid, and one that is paid is not yet delivered.

**`LiquidityAdapter`** (adds to `BaseAdapter`)
| Event | Consumer |
|---|---|
| `BridgeTargetSet(liquidityBridge, cashVault, timestamp)` | Indexer |
| `BridgedToCash(assets, shares, timestamp)` | Indexer |
| `CashTokensRecalled(shares, timestamp)` | Indexer |

---

## Notes for finalization

- **Priority tier.** Events feeding KeeperBot state transitions and SettlementOperator batch assembly
  (`*StateChanged`, `NAVUpdated`, `RedeemRequested`/`RequestQueued`, `DepositRequested`,
  `SettlementExecuted`, `Distributed`) should be treated as must-index from day one; the rest
  (informational/ops-dashboard) can follow.
- **Not yet covered:** Phase 2 items (KYT Gate live events, M-of-N NAV signer events, LP incentive)
  — out of scope until Phase 2 begins, per development-plan §1/§4. `ClaimRegistry` is Phase 1 scope
  and is included above (recording only — no PENDING→APPROVED→PAID state machine yet).
- Company: please add any additional events needed for the dApp/back-end (e.g. finer-grained
  analytics, off-chain notification triggers) and flag any of the above that are not actually needed,
  before this is treated as final.
