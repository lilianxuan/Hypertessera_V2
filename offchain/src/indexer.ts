import type { Contract, Provider } from "ethers";
import type { HyperTesseraSDK, TrancheKey } from "./sdk.js";
import { ModuleId, PauseState, QueueType, type Address, type ProductInfo } from "./types.js";

export interface DepositRecord {
  requestId: bigint;
  owner: Address;
  /** Current principal — lowered in place by `RequestWrittenDown` (insolvency haircut). */
  assets: bigint;
  blockNumber: number;
  settled: boolean;
  claimed: boolean;
  /** `BaseVault.RequestCancelled` — the user-initiated cancel in the ACCEPTING window. */
  cancelled: boolean;
  refunded: boolean;
  /** Cumulative `RequestWrittenDown` haircut already deducted from `assets`. */
  writtenDownHaircut: bigint;
  /** `Queue.RequestQueued(vault, DEPOSIT, ...)` — position in the on-chain DEPOSIT FIFO. */
  slotIndex?: bigint;
  /** `Queue.RequestQueued` payload — the queue entry's hash. */
  orderHash?: string;
  /**
   * `Queue.RequestCancelledFromQueue(vault, DEPOSIT, id)` seen. Both `cancelRequest()` and
   * `markRefundable()` remove the request from the DEPOSIT FIFO, so on its own this does not
   * identify which one happened — see `isDepositRefundable` in sdk.ts.
   */
  removedFromQueue: boolean;
  /** `DepositSettled` payload — undefined until the request is settled. */
  settledAssets?: bigint;
  refundedAssets?: bigint;
  settledCycleNumber?: bigint;
}

export interface RedeemRecord {
  requestId: bigint;
  owner: Address;
  /** ORIGINAL requested shares — immutable after creation, mirroring `BaseVault.RedeemRequestInternal`. */
  shares: bigint;
  /**
   * Shares not yet paid out. Starts equal to `shares` and is lowered by every `RedeemSettled`
   * partial fill (`BaseVault.sol` decrements `remainingShares` per cycle and only dequeues the
   * request once it reaches zero) — this, not `shares`, is what the next cycle still owes.
   */
  remainingShares: bigint;
  /** Cumulative USDT reserved for this request across however many cycles have filled it. */
  settledAssets: bigint;
  /** Cycle of the most recent (partial or final) fill; undefined until the first one. */
  lastSettledCycleNumber?: bigint;
  slotIndex?: bigint;
  orderHash?: string;
  blockNumber: number;
  dequeued: boolean;
  tombstoned: boolean;
  claimed: boolean;
  /**
   * `BaseVault.RequestCancelled(requestId, ...)` seen on a redeem that had already been partially
   * filled (`settledAssets > 0`). Cancelling returns only the unfilled `remainingShares` and
   * promotes the request to SETTLED, so its `settledAssets` are **still claimable via
   * `claimRedeem`** — unlike cancelling a wholly unfilled redeem, which leaves nothing to claim.
   * Both outcomes set `tombstoned`, so this flag is the only thing that tells them apart:
   * front-ends must keep offering "claim" while `cancelledButSettled && !claimed`.
   */
  cancelledButSettled: boolean;
}

export interface BackfillOptions {
  /** Blocks per `eth_getLogs` window. Public endpoints reject wide spans. */
  chunkSize?: number;
  /** Retries per window before giving up. */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt. */
  baseRetryDelayMs?: number;
}

export interface WatchOptions extends BackfillOptions {
  /** How often to poll for new blocks. */
  pollIntervalMs?: number;
  /**
   * Blocks left unindexed behind the chain head. A reorg deeper than this is not repaired — the
   * lag is what keeps reorged logs out of the state in the first place.
   */
  confirmations?: number;
  /** Called when a poll fails outright; the loop keeps running and retries on the next tick. */
  onError?: (err: unknown) => void;
}

export interface QueueSnapshot {
  depositDepth: bigint;
  redeemDepth: bigint;
}

/**
 * One live `vault -> adapter -> rwaToken -> assetId` hop, reconstructed off-chain.
 *
 * `BaseVault` carries no `assetId`/`assetRegistry` field: the vault world (keyed by vault address)
 * and the asset world (keyed by `assetId`) are decoupled on-chain. Every hop is still readable, so
 * the chain is rebuilt here — `BaseVault.AdapterAdded/AdapterRemoved` gives the attachment set,
 * `RWAAdapter.rwaToken` and `RWAToken.assetId` (both `immutable`) give the rest, and
 * `AssetRegistry.getAsset`/`metadataURIOf` resolve the metadata (see `HyperTesseraSDK.getVaultAssets`).
 */
export interface VaultAssetLink {
  vault: Address;
  adapter: Address;
  rwaToken: Address;
  assetId: bigint;
}

/** Result of the one-time adapter type probe — `null` marks an adapter with no `rwaToken()`. */
type AdapterAsset = { rwaToken: Address; assetId: bigint } | null;

const TRANCHES: TrancheKey[] = ["cash", "note", "lp"];

/**
 * OnChainEventIndexer (development-plan.md §3.5): subscribes to the W1-W4 event surface
 * (docs/module-e-event-whitelist-proposal.md), maintains an in-memory FIFO/pending-deposit
 * reconstruction per vault, and exposes getClearingList()/getPendingDeposits() for
 * SettlementOperator's off-chain calc input.
 *
 * In-memory only — a production deployment would back this with persistent storage, but the
 * reconstruction logic (the actual deliverable) is storage-agnostic.
 */
export interface NAVRecord {
  price: bigint;
  dataTimestamp: bigint;
  updatedAt: number; // block timestamp of the update, seconds
}

export class OnChainEventIndexer {
  private readonly sdk: HyperTesseraSDK;
  private readonly provider: Provider;
  /** The vault set this instance indexes — the configured tranches unless one was supplied. */
  private readonly vaults: Address[];
  private readonly deposits = new Map<Address, Map<string, DepositRecord>>();
  private readonly redeems = new Map<Address, Map<string, RedeemRecord>>();
  private readonly navByToken = new Map<Address, NAVRecord>();
  /** `AssetRegistry.ProductInfoSet` — set once at registration; there is no updater. */
  private readonly productInfoByAsset = new Map<bigint, ProductInfo>();
  /** `AssetRegistry.AssetRegistered` — assetId -> its RWAToken, so the compliance-switch events below know which token contracts to poll. */
  private readonly tokenByAsset = new Map<bigint, Address>();
  /** `RWAToken.WhitelistEnabledSet` / `TransferPathEnabledSet`, latest value per token. */
  private readonly whitelistEnabledByToken = new Map<Address, boolean>();
  private readonly transferPathEnabledByToken = new Map<Address, boolean>();
  /** `RWAToken.WhitelistUpdated` carries no addresses (batch add/remove) — latest batch summary per token. */
  private readonly lastWhitelistUpdateByToken = new Map<Address, { added: boolean; count: number; timestamp: number }>();
  /** `StateManager.VaultPauseSet` / `VaultUnpaused` — vaults absent from the map are ACTIVE. */
  private readonly pauseByVault = new Map<Address, PauseState>();
  /** `StateManager.ModulePaused` / `ModuleUnpaused` — module-wide halts, independent of any vault. */
  private readonly pausedModules = new Set<ModuleId>();
  /** vault -> adapters currently attached (AdapterAdded minus AdapterRemoved), RWA or not. */
  private readonly adaptersByVault = new Map<Address, Set<Address>>();
  /** adapter -> its immutable rwaToken/assetId pair, or `null` once probed as non-RWA. */
  private readonly adapterAssets = new Map<Address, AdapterAsset>();
  /**
   * Log identities (`txHash:logIndex`) already folded into the state above. Two handlers accumulate
   * (`settledAssets +=`, `writtenDownHaircut +=`), so replaying an overlapping range would double
   * count without this — and overlapping replays are exactly how `start()` closes the gap between
   * one poll and the next.
   */
  private readonly appliedLogs = new Set<string>();
  /** Highest block folded into the state; -1 until the first backfill. Persisting it is the caller's business. */
  private lastBlock = -1;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  /**
   * `vaults` defaults to the configured tranches. Pass a set to index anything else — `deployVault`
   * is permissionless, so vaults exist that no config knows about; `discover()` reads that full set
   * off StateManager's on-chain vault index.
   */
  constructor(sdk: HyperTesseraSDK, provider: Provider, vaults: Address[] = TRANCHES.map((t) => sdk.vaultAddress(t))) {
    this.sdk = sdk;
    this.provider = provider;
    this.vaults = [...new Set(vaults)];
    for (const vault of this.vaults) {
      this.deposits.set(vault, new Map());
      this.redeems.set(vault, new Map());
      this.adaptersByVault.set(vault, new Set());
    }
  }

  /** An indexer over every vault registered on-chain, rather than the configured tranches. */
  static async discover(sdk: HyperTesseraSDK, provider: Provider, pageSize: number): Promise<OnChainEventIndexer> {
    return new OnChainEventIndexer(sdk, provider, await sdk.getAllVaults(pageSize));
  }

  /** The vaults this indexer tracks — every other method rejects anything outside this set. */
  indexedVaults(): Address[] {
    return [...this.vaults];
  }

  /**
   * Vault contract for event access. The `EarnVault` ABI is used for every vault regardless of
   * kind: `LiquidityEarnVault` declares extra events of its own, but every event subscribed to
   * below is declared identically by both.
   */
  private vaultContract(vault: Address): Contract {
    return this.sdk.vaultAt(vault);
  }

  private depositMap(vault: Address): Map<string, DepositRecord> {
    const m = this.deposits.get(vault);
    if (!m) throw new Error(`Vault ${vault} is not indexed by this indexer`);
    return m;
  }

  private redeemMap(vault: Address): Map<string, RedeemRecord> {
    const m = this.redeems.get(vault);
    if (!m) throw new Error(`Vault ${vault} is not indexed by this indexer`);
    return m;
  }

  private adapterSet(vault: Address): Set<Address> {
    const s = this.adaptersByVault.get(vault);
    if (!s) throw new Error(`Vault ${vault} is not indexed by this indexer`);
    return s;
  }

  // -----------------------------------------------------------------------
  // Event handlers (shared by backfill() and start())
  // -----------------------------------------------------------------------

  private onDepositRequested(vault: Address, requestId: bigint, owner: Address, assets: bigint, blockNumber: number) {
    const existing = this.depositMap(vault).get(requestId.toString());
    this.depositMap(vault).set(requestId.toString(), {
      requestId,
      owner,
      assets,
      blockNumber,
      slotIndex: existing?.slotIndex,
      orderHash: existing?.orderHash,
      settled: false,
      claimed: false,
      cancelled: false,
      refunded: false,
      writtenDownHaircut: 0n,
      removedFromQueue: false,
    });
  }

  private onDepositClaimed(vault: Address, requestId: bigint) {
    const rec = this.depositMap(vault).get(requestId.toString());
    if (rec) rec.claimed = true;
  }

  private onDepositSettled(
    vault: Address,
    requestId: bigint,
    settledAssets: bigint,
    refundedAssets: bigint,
    cycleNumber: bigint,
  ) {
    const rec = this.depositMap(vault).get(requestId.toString());
    if (!rec) return;
    rec.settled = true;
    rec.settledAssets = settledAssets;
    rec.refundedAssets = refundedAssets;
    rec.settledCycleNumber = cycleNumber;
  }

  /**
   * `BaseVault.RequestWrittenDown` covers both pending/refundable deposits and settled redeems
   * (the requestId space is shared). RedeemRecord tracks locked shares rather than a settled
   * asset amount, so only the deposit side is reconstructable here — a redeem's write-down
   * falls through as a no-op.
   */
  private onRequestWrittenDown(vault: Address, requestId: bigint, haircut: bigint, newAmount: bigint) {
    const rec = this.depositMap(vault).get(requestId.toString());
    if (!rec) return;
    rec.assets = newAmount;
    rec.writtenDownHaircut += haircut;
  }

  private onDepositCancelledFromQueue(vault: Address, requestId: bigint) {
    // Tolerant lookup, unlike the redeem handlers: Queue is shared across every registered vault,
    // and deposit cancellations are the high-volume case, so an event from a vault outside this
    // indexer's set must not abort a backfill.
    const rec = this.deposits.get(vault)?.get(requestId.toString());
    if (rec) rec.removedFromQueue = true;
  }

  /**
   * `BaseVault.RequestCancelled(requestId, actor, timestamp)`.
   *
   * DEPOSIT: the USDT is pushed straight back to the owner and the request is CANCELLED.
   *
   * REDEEM: the unfilled shares come back and `Queue.remove` fires, which alone would only say
   * `tombstoned`. That is not enough: a *partially filled* redeem is promoted to SETTLED rather
   * than CANCELLED, so its `settledAssets` stay claimable. Without the two writes below such a
   * request looks exactly like a fully-cancelled one — stale `remainingShares`, `tombstoned`,
   * `claimed: false` — and nothing tells the UI the money is still there to collect.
   */
  private onRequestCancelled(vault: Address, requestId: bigint) {
    const dep = this.depositMap(vault).get(requestId.toString());
    if (dep) dep.cancelled = true;
    const red = this.redeemMap(vault).get(requestId.toString());
    if (!red) return;
    red.tombstoned = true;
    red.remainingShares = 0n; // the unfilled shares were returned to the owner
    red.cancelledButSettled = red.settledAssets > 0n; // partial fill → SETTLED, claimRedeem still pays
  }

  private onRefundClaimed(vault: Address, requestId: bigint) {
    const rec = this.depositMap(vault).get(requestId.toString());
    if (rec) rec.refunded = true;
  }

  private onRedeemRequested(vault: Address, requestId: bigint, owner: Address, shares: bigint, blockNumber: number) {
    const existing = this.redeemMap(vault).get(requestId.toString());
    this.redeemMap(vault).set(requestId.toString(), {
      requestId,
      owner,
      shares,
      remainingShares: shares,
      settledAssets: 0n,
      blockNumber,
      slotIndex: existing?.slotIndex,
      orderHash: existing?.orderHash,
      dequeued: false,
      tombstoned: false,
      claimed: false,
      cancelledButSettled: false,
    });
  }

  /**
   * `BaseVault.RedeemSettled` — emitted for every processed redeem, partial or final. A partially
   * filled request stays in the FIFO with its original `shares`, so without this the clearing list
   * would keep reporting the full amount as still owed.
   */
  private onRedeemSettled(
    vault: Address,
    requestId: bigint,
    remainingShares: bigint,
    settledAssetsThisCycle: bigint,
    cycleNumber: bigint,
  ) {
    const rec = this.redeemMap(vault).get(requestId.toString());
    if (!rec) return;
    rec.remainingShares = remainingShares;
    rec.settledAssets += settledAssetsThisCycle;
    rec.lastSettledCycleNumber = cycleNumber;
  }

  private onDepositQueued(vault: Address, requestId: bigint, slotIndex: bigint, orderHash: string) {
    // Tolerant lookup for the same reason as onDepositCancelledFromQueue: Queue is shared across
    // every registered vault, not just this indexer's set.
    const rec = this.deposits.get(vault)?.get(requestId.toString());
    if (rec) {
      rec.slotIndex = slotIndex;
      rec.orderHash = orderHash;
    }
  }

  private onRedeemClaimed(vault: Address, requestId: bigint) {
    const rec = this.redeemMap(vault).get(requestId.toString());
    if (rec) rec.claimed = true;
  }

  private onRedeemQueued(vault: Address, requestId: bigint, slotIndex: bigint, orderHash: string) {
    const rec = this.redeemMap(vault).get(requestId.toString());
    if (rec) {
      rec.slotIndex = slotIndex;
      rec.orderHash = orderHash;
    }
  }

  private onRedeemDequeued(vault: Address, requestId: bigint) {
    const rec = this.redeemMap(vault).get(requestId.toString());
    if (rec) rec.dequeued = true;
  }

  /**
   * True when this log was already folded in, marking it applied otherwise. Logs carry a stable
   * identity (`transactionHash` + `index`) that survives being returned by two overlapping
   * `eth_getLogs` calls.
   */
  private alreadyApplied(log: { transactionHash?: string; index?: number }): boolean {
    const key = `${log.transactionHash}:${log.index}`;
    if (this.appliedLogs.has(key)) return true;
    this.appliedLogs.add(key);
    return false;
  }

  private onVaultPauseSet(vault: Address, reason: PauseState) {
    // Tolerant: StateManager emits for every registered vault, not just this indexer's set.
    this.pauseByVault.set(vault, reason);
  }

  private onModulePauseSet(id: ModuleId, paused: boolean) {
    if (paused) this.pausedModules.add(id);
    else this.pausedModules.delete(id);
  }

  private onRedeemCancelledFromQueue(vault: Address, requestId: bigint) {
    const rec = this.redeemMap(vault).get(requestId.toString());
    if (rec) rec.tombstoned = true;
  }

  // Queue.sol is dual-FIFO (DEPOSIT + REDEEM) as of the net settlement conversion (§8) — this
  // indexer's clearing-list scope is redeem-only, so every handler above filters to
  // QueueType.REDEEM before updating redeem records.

  /**
   * `BaseVault.AdapterAdded`. A vault holds up to `MAX_ADAPTERS = 16` adapters and they come and go
   * via `removeAdapter`, so vault -> asset is 1:N and time-varying — hence a live set rather than a
   * single field. The adapter's own asset is resolved once here and then cached forever: both legs
   * (`RWAAdapter.rwaToken`, `RWAToken.assetId`) are `immutable`, so re-reading them can never change
   * the answer.
   */
  private async onAdapterAdded(vault: Address, adapter: Address) {
    this.adapterSet(vault).add(adapter);
    if (this.adapterAssets.has(adapter)) return;
    this.adapterAssets.set(adapter, await this.probeAdapterAsset(adapter));
  }

  /**
   * Removal only drops the attachment, never the probe cache — the same adapter can legitimately be
   * re-added later, and its assetId cannot have changed in the meantime.
   */
  private onAdapterRemoved(vault: Address, adapter: Address) {
    this.adapterSet(vault).delete(adapter);
  }

  /**
   * Duck-types the adapter: only `RWAAdapter` declares `rwaToken()`, so a `FirstPeriodAdapter` or
   * `LiquidityAdapter` makes this call revert. That is the expected path, not an error — it is
   * swallowed into a cached `null` so a backfill over a vault full of non-RWA adapters stays quiet.
   *
   * NOTE: as of this writing every deployed adapter is a FirstPeriodAdapter or LiquidityAdapter, so
   * the asset link surface below legitimately comes back empty. It only fills in once an adapter
   * built by `deployRWAAdapter` is actually attached to a vault — an empty result is not a bug.
   */
  private async probeAdapterAsset(adapter: Address): Promise<AdapterAsset> {
    try {
      const rwaToken: Address = await this.sdk.getContract("RWAAdapter", adapter).rwaToken();
      const assetId = BigInt(await this.sdk.getContract("RWAToken", rwaToken).assetId());
      return { rwaToken, assetId };
    } catch {
      return null;
    }
  }

  private onNAVUpdated(rwaToken: Address, price: bigint, dataTimestamp: bigint, updatedAt: number) {
    this.navByToken.set(rwaToken, { price, dataTimestamp, updatedAt });
  }

  /** `AssetRegistry.ProductInfoSet` — set once at `registerAsset` time; there is no updater. */
  private onProductInfoSet(
    assetId: bigint,
    issuer: Address,
    productName: string,
    annualYieldRateBps: number,
    maturityTimestamp: bigint,
    underlyingAsset: string,
  ) {
    this.productInfoByAsset.set(assetId, { productName, annualYieldRateBps, maturityTimestamp, issuer, underlyingAsset });
  }

  private onAssetRegistered(assetId: bigint, token: Address) {
    this.tokenByAsset.set(assetId, token);
  }

  private onWhitelistEnabledSet(token: Address, enabled: boolean) {
    this.whitelistEnabledByToken.set(token, enabled);
  }

  private onTransferPathEnabledSet(token: Address, enabled: boolean) {
    this.transferPathEnabledByToken.set(token, enabled);
  }

  private onWhitelistUpdated(token: Address, added: boolean, count: number, timestamp: number) {
    this.lastWhitelistUpdateByToken.set(token, { added, count, timestamp });
  }

  /** Decode a Settlement.submitBatch transaction and mark its deposit requestIds as settled. */
  private async onSettlementExecuted(txHash: string) {
    const tx = await this.provider.getTransaction(txHash);
    if (!tx) return;
    const parsed = this.sdk.settlement.interface.parseTransaction({ data: tx.data, value: tx.value });
    if (!parsed || parsed.name !== "submitBatch") return;
    const instruction = parsed.args[0];
    for (const vs of instruction.vaultSettlements) {
      const vaultAddr: Address = vs.distribution.vault;
      const depositMap = this.deposits.get(vaultAddr);
      if (!depositMap) continue;
      for (const d of vs.deposits as { requestId: bigint; settleAmount: bigint }[]) {
        const rec = depositMap.get(d.requestId.toString());
        if (rec) rec.settled = true;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Historical backfill
  // -----------------------------------------------------------------------

  /**
   * Folds every whitelisted event in `[fromBlock, toBlock]` into the in-memory state.
   *
   * The range is walked in `chunkSize`-block windows because public RPC endpoints cap how wide an
   * `eth_getLogs` span may be, and each window is retried with exponential backoff because they
   * also rate-limit. Re-running over a range already folded in is safe and cheap — every log
   * carries an identity and is applied at most once (see `alreadyApplied`).
   */
  async backfill(
    fromBlock: number | bigint = 0,
    toBlock: number | bigint | "latest" = "latest",
    options: BackfillOptions = {},
  ): Promise<void> {
    const { chunkSize = 2_000, maxRetries = 3, baseRetryDelayMs = 500 } = options;
    const from = Number(fromBlock);
    const to = toBlock === "latest" ? await this.provider.getBlockNumber() : Number(toBlock);

    for (let start = from; start <= to; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, to);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.backfillRange(start, end);
          break;
        } catch (err) {
          if (attempt >= maxRetries) throw err;
          await new Promise((resolve) => setTimeout(resolve, baseRetryDelayMs * 2 ** attempt));
        }
      }
    }
    // An empty range (from > to) scanned nothing, so it must not claim progress up to `to`.
    if (from <= to) this.lastBlock = Math.max(this.lastBlock, to);
  }

  /** Highest block folded in so far, or -1 before the first backfill. */
  lastIndexedBlock(): number {
    return this.lastBlock;
  }

  private async backfillRange(fromBlock: number, toBlock: number): Promise<void> {
    for (const vaultAddr of this.vaults) {
      const vault = this.vaultContract(vaultAddr);

      for (const log of await vault.queryFilter(vault.filters.DepositRequested(), fromBlock, toBlock)) {

        if (this.alreadyApplied(log)) continue;
        const { requestId, owner, assets } = (log as any).args;
        this.onDepositRequested(vaultAddr, BigInt(requestId), owner, BigInt(assets), log.blockNumber);
      }
      // RequestWrittenDown before DepositSettled/DepositClaimed: it only ever lowers `assets`,
      // and the record must already exist from the DepositRequested pass above.
      for (const log of await vault.queryFilter(vault.filters.RequestWrittenDown(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        const { requestId, haircut, newAmount } = (log as any).args;
        this.onRequestWrittenDown(vaultAddr, BigInt(requestId), BigInt(haircut), BigInt(newAmount));
      }
      for (const log of await vault.queryFilter(vault.filters.DepositSettled(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        const { requestId, settledAssets, refundedAssets, cycleNumber } = (log as any).args;
        this.onDepositSettled(vaultAddr, BigInt(requestId), BigInt(settledAssets), BigInt(refundedAssets), BigInt(cycleNumber));
      }
      for (const log of await vault.queryFilter(vault.filters.DepositClaimed(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        this.onDepositClaimed(vaultAddr, BigInt((log as any).args.requestId));
      }
      for (const log of await vault.queryFilter(vault.filters.RefundClaimed(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        this.onRefundClaimed(vaultAddr, BigInt((log as any).args.requestId));
      }
      for (const log of await vault.queryFilter(vault.filters.RedeemRequested(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        const { requestId, owner, shares } = (log as any).args;
        this.onRedeemRequested(vaultAddr, BigInt(requestId), owner, BigInt(shares), log.blockNumber);
      }
      // After RedeemRequested (the record must exist) and before the queue pass below.
      for (const log of await vault.queryFilter(vault.filters.RedeemSettled(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        const { requestId, remainingShares, settledAssetsThisCycle, cycleNumber } = (log as any).args;
        this.onRedeemSettled(
          vaultAddr,
          BigInt(requestId),
          BigInt(remainingShares),
          BigInt(settledAssetsThisCycle),
          BigInt(cycleNumber),
        );
      }
      for (const log of await vault.queryFilter(vault.filters.RedeemClaimed(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        this.onRedeemClaimed(vaultAddr, BigInt((log as any).args.requestId));
      }
      // Deliberately after the RedeemRequested/RedeemSettled/RedeemClaimed passes: a cancelled
      // redeem's classification depends on the `settledAssets` those passes populate, so running
      // it earlier would misread a partial fill that arrived in the same scan window.
      for (const log of await vault.queryFilter(vault.filters.RequestCancelled(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        this.onRequestCancelled(vaultAddr, BigInt((log as any).args.requestId));
      }

      // Unlike the passes above, AdapterAdded/AdapterRemoved are order-sensitive — an adapter can be
      // removed and re-added — so the two streams are merged and replayed in log order rather than
      // one event type at a time.
      const adapterLogs = [
        ...(await vault.queryFilter(vault.filters.AdapterAdded(), fromBlock, toBlock)).map((log) => ({ log, added: true })),
        ...(await vault.queryFilter(vault.filters.AdapterRemoved(), fromBlock, toBlock)).map((log) => ({ log, added: false })),
      ].sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.index - b.log.index);
      for (const { log, added } of adapterLogs) {
        if (this.alreadyApplied(log)) continue;
        const adapter: Address = (log as any).args.adapter;
        if (added) await this.onAdapterAdded(vaultAddr, adapter);
        else this.onAdapterRemoved(vaultAddr, adapter);
      }
    }

    const queue = this.sdk.queue;
    for (const log of await queue.queryFilter(queue.filters.RequestQueued(null, QueueType.REDEEM), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      const { vault, requestId, slotIndex, orderHash } = (log as any).args;
      this.onRedeemQueued(vault, BigInt(requestId), BigInt(slotIndex), orderHash);
    }
    for (const log of await queue.queryFilter(queue.filters.RequestQueued(null, QueueType.DEPOSIT), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      const { vault, requestId, slotIndex, orderHash } = (log as any).args;
      this.onDepositQueued(vault, BigInt(requestId), BigInt(slotIndex), orderHash);
    }
    for (const log of await queue.queryFilter(queue.filters.RequestDequeued(null, QueueType.REDEEM), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      const { vault, requestId } = (log as any).args;
      this.onRedeemDequeued(vault, BigInt(requestId));
    }
    for (const log of await queue.queryFilter(
      queue.filters.RequestCancelledFromQueue(null, QueueType.REDEEM),
      fromBlock,
      toBlock,
    )) {
      if (this.alreadyApplied(log)) continue;
      const { vault, requestId } = (log as any).args;
      this.onRedeemCancelledFromQueue(vault, BigInt(requestId));
    }
    for (const log of await queue.queryFilter(
      queue.filters.RequestCancelledFromQueue(null, QueueType.DEPOSIT),
      fromBlock,
      toBlock,
    )) {
      if (this.alreadyApplied(log)) continue;
      const { vault, requestId } = (log as any).args;
      this.onDepositCancelledFromQueue(vault, BigInt(requestId));
    }

    const settlement = this.sdk.settlement;
    for (const log of await settlement.queryFilter(settlement.filters.SettlementExecuted(), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      await this.onSettlementExecuted(log.transactionHash);
    }

    const navOracle = this.sdk.navOracle;
    for (const log of await navOracle.queryFilter(navOracle.filters.NAVUpdated(), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      const { rwaToken, price, dataTimestamp, updatedAt } = (log as any).args;
      this.onNAVUpdated(rwaToken, BigInt(price), BigInt(dataTimestamp), Number(updatedAt));
    }

    const assetRegistry = this.sdk.assetRegistry;
    for (const log of await assetRegistry.queryFilter(assetRegistry.filters.ProductInfoSet(), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      const { assetId, issuer, productName, annualYieldRateBps, maturityTimestamp, underlyingAsset } = (log as any).args;
      this.onProductInfoSet(BigInt(assetId), issuer, productName, Number(annualYieldRateBps), BigInt(maturityTimestamp), underlyingAsset);
    }
    // AssetRegistered discovers each asset's RWAToken address — needed below to know which
    // per-asset RWAToken contracts to poll for their own compliance-switch events.
    for (const log of await assetRegistry.queryFilter(assetRegistry.filters.AssetRegistered(), fromBlock, toBlock)) {
      if (this.alreadyApplied(log)) continue;
      const { assetId, token } = (log as any).args;
      this.onAssetRegistered(BigInt(assetId), token);
    }

    // RWAToken compliance switches (whitelist / transfer-path). One contract per asset, so this
    // polls every RWAToken discovered so far — including ones registered earlier than `fromBlock`.
    for (const token of new Set(this.tokenByAsset.values())) {
      const rwaToken = this.sdk.getContract("RWAToken", token);
      for (const log of await rwaToken.queryFilter(rwaToken.filters.WhitelistEnabledSet(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        this.onWhitelistEnabledSet(token, (log as any).args.enabled);
      }
      for (const log of await rwaToken.queryFilter(rwaToken.filters.TransferPathEnabledSet(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        this.onTransferPathEnabledSet(token, (log as any).args.enabled);
      }
      for (const log of await rwaToken.queryFilter(rwaToken.filters.WhitelistUpdated(), fromBlock, toBlock)) {
        if (this.alreadyApplied(log)) continue;
        const { added, count, timestamp } = (log as any).args;
        this.onWhitelistUpdated(token, added, Number(count), Number(timestamp));
      }
    }

    // Pause surface. Replayed in log order across all four events because a vault can be paused,
    // unpaused and re-paused inside one range — one event type at a time would land on the wrong
    // final state.
    const sm = this.sdk.stateManager;
    const pauseLogs = [
      ...(await sm.queryFilter(sm.filters.VaultPauseSet(), fromBlock, toBlock)).map((log) => ({ log, kind: "vault-pause" as const })),
      ...(await sm.queryFilter(sm.filters.VaultUnpaused(), fromBlock, toBlock)).map((log) => ({ log, kind: "vault-unpause" as const })),
      ...(await sm.queryFilter(sm.filters.ModulePaused(), fromBlock, toBlock)).map((log) => ({ log, kind: "module-pause" as const })),
      ...(await sm.queryFilter(sm.filters.ModuleUnpaused(), fromBlock, toBlock)).map((log) => ({ log, kind: "module-unpause" as const })),
    ].sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.index - b.log.index);
    for (const { log, kind } of pauseLogs) {
      if (this.alreadyApplied(log)) continue;
      const args = (log as any).args;
      if (kind === "vault-pause") this.onVaultPauseSet(args.vault, Number(args.reason) as PauseState);
      else if (kind === "vault-unpause") this.onVaultPauseSet(args.vault, PauseState.ACTIVE);
      else this.onModulePauseSet(Number(args.id) as ModuleId, kind === "module-pause");
    }
  }

  // -----------------------------------------------------------------------
  // Live tracking
  // -----------------------------------------------------------------------

  /**
   * Keeps the state current by polling for new blocks until `stop()`.
   *
   * Polling, rather than `contract.on` push subscriptions, for three reasons an operator actually
   * hits. A provider that drops and reconnects silently stops delivering pushed events, while the
   * next poll simply resumes from `lastIndexedBlock()`. The window between the initial `backfill()`
   * and a subscription going live is a silent hole, while polling continues from exactly where the
   * backfill stopped. And pushed events arrive at the unconfirmed head, while polling stays
   * `confirmations` blocks behind it, so logs from a reorged block never enter the state — the lag
   * avoids reorgs rather than repairing them, which is the honest guarantee for an in-memory index.
   *
   * Call `backfill()` first if history matters: with no prior backfill, tracking starts at the
   * current head and everything before it stays invisible.
   */
  start(options: WatchOptions = {}): void {
    if (this.pollTimer) return;
    const { pollIntervalMs = 15_000, confirmations = 6, onError, ...backfillOptions } = options;

    const tick = async () => {
      // A poll slower than the interval must not overlap the next tick — both would replay the
      // same range, and while that is harmless it doubles the RPC bill.
      if (this.polling) return;
      this.polling = true;
      try {
        const head = (await this.provider.getBlockNumber()) - confirmations;
        if (this.lastBlock < 0) this.lastBlock = head;
        else if (head > this.lastBlock) await this.backfill(this.lastBlock + 1, head, backfillOptions);
      } catch (err) {
        onError?.(err);
      } finally {
        this.polling = false;
      }
    };

    this.pollTimer = setInterval(() => void tick(), pollIntervalMs);
    void tick();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  // -----------------------------------------------------------------------
  // Query surface (development-plan.md §3.5: "validate getClearingList and getPendingDeposits")
  // -----------------------------------------------------------------------

  /** Deposit requests not yet settled/cancelled/refunded — SettlementOperator's calc input. */
  getPendingDeposits(vault: Address): DepositRecord[] {
    return [...this.depositMap(vault).values()]
      .filter((r) => !r.settled && !r.cancelled && !r.refunded)
      .sort((a, b) =>
        // `slotIndex` is the authoritative DEPOSIT FIFO position; requestId only approximates it
        // (a cancel/refund removes an entry without renumbering the ids). Records queued before
        // this indexer's backfill window have no slot and sort last, by id.
        a.slotIndex !== undefined && b.slotIndex !== undefined
          ? Number(a.slotIndex - b.slotIndex)
          : a.slotIndex !== undefined
            ? -1
            : b.slotIndex !== undefined
              ? 1
              : Number(a.requestId - b.requestId),
      );
  }

  /**
   * Raw reconstructed record for one deposit request, or undefined if this indexer never saw a
   * `DepositRequested` for it. `HyperTesseraSDK.getDepositRequest` turns this into a
   * `DepositRequestState`; `BaseVault._depositRequests` itself is `internal` with no getter.
   */
  getDepositRecord(vault: Address, requestId: bigint): DepositRecord | undefined {
    return this.depositMap(vault).get(requestId.toString());
  }

  /**
   * Redeem requests still resident in the on-chain FIFO queue, in FIFO order. Partially filled
   * requests stay in the queue — read `remainingShares`, not `shares`, for what is still owed.
   */
  getClearingList(vault: Address): RedeemRecord[] {
    return [...this.redeemMap(vault).values()]
      .filter((r) => !r.dequeued && !r.tombstoned && r.slotIndex !== undefined)
      .sort((a, b) => Number((a.slotIndex ?? 0n) - (b.slotIndex ?? 0n)));
  }

  /**
   * Raw reconstructed record for one redeem request — the counterpart of `getDepositRecord`, and
   * the only way to reach a request that has left the FIFO (`getClearingList` filters those out).
   * Front-ends need it for exactly that case: a cancelled partial fill is `tombstoned` yet still owes
   * the user its `settledAssets` via `claimRedeem` — see `RedeemRecord.cancelledButSettled`.
   */
  getRedeemRecord(vault: Address, requestId: bigint): RedeemRecord | undefined {
    return this.redeemMap(vault).get(requestId.toString());
  }

  /**
   * The assets `vault` currently holds — one entry per attached `RWAAdapter`. Non-RWA adapters
   * (FirstPeriodAdapter / LiquidityAdapter) are attached but carry no asset, so they are absent
   * here; see `probeAdapterAsset` on why an all-empty result is the expected state today.
   *
   * `HyperTesseraSDK.getVaultAssets` layers the AssetRegistry metadata on top of this.
   */
  getVaultAssetLinks(vault: Address): VaultAssetLink[] {
    const links: VaultAssetLink[] = [];
    for (const adapter of this.adapterSet(vault)) {
      const asset = this.adapterAssets.get(adapter);
      if (asset) links.push({ vault, adapter, rwaToken: asset.rwaToken, assetId: asset.assetId });
    }
    return links.sort((a, b) => Number(a.assetId - b.assetId));
  }

  /** Distinct assetIds currently reachable from `vault` — two adapters may point at one asset. */
  getVaultAssetIds(vault: Address): bigint[] {
    return [...new Set(this.getVaultAssetLinks(vault).map((l) => l.assetId))];
  }

  /** The reverse direction: every indexed vault currently holding `assetId`. */
  getVaultsHoldingAsset(assetId: bigint): Address[] {
    return [...this.adaptersByVault.keys()].filter((vault) =>
      this.getVaultAssetLinks(vault).some((l) => l.assetId === assetId),
    );
  }

  /**
   * Current pause state of `vault` per `StateManager`'s events — ACTIVE when it was never paused
   * within the indexed range. `HyperTesseraSDK.getStateContext` reads the same field live from the
   * chain; this is the event-sourced view, for dashboards that already hold the reconstruction.
   */
  getVaultPauseState(vault: Address): PauseState {
    return this.pauseByVault.get(vault) ?? PauseState.ACTIVE;
  }

  /** Modules currently halted protocol-wide (`StateManager.ModulePaused`), independent of any vault. */
  getPausedModules(): ModuleId[] {
    return [...this.pausedModules].sort((a, b) => a - b);
  }

  /** Last indexed NAV reading for `rwaToken`, or undefined if none has been backfilled/observed yet. */
  getLatestNAV(rwaToken: Address): NAVRecord | undefined {
    return this.navByToken.get(rwaToken);
  }

  /** Event-sourced `AssetRegistry.ProductInfoSet`, or undefined if never backfilled/observed. */
  getProductInfo(assetId: bigint): ProductInfo | undefined {
    return this.productInfoByAsset.get(assetId);
  }

  /** `AssetRegistry.AssetRegistered` — the RWAToken deployed for `assetId`, or undefined if never seen. */
  getAssetToken(assetId: bigint): Address | undefined {
    return this.tokenByAsset.get(assetId);
  }

  /** Event-sourced `RWAToken.whitelistEnabled` for `rwaToken`; undefined if never observed (still the contract default, false). */
  getWhitelistEnabled(rwaToken: Address): boolean | undefined {
    return this.whitelistEnabledByToken.get(rwaToken);
  }

  /** Event-sourced `RWAToken.transferPathEnabled` for `rwaToken`; undefined if never observed (still the contract default, false). */
  getTransferPathEnabled(rwaToken: Address): boolean | undefined {
    return this.transferPathEnabledByToken.get(rwaToken);
  }

  /** Most recent `RWAToken.WhitelistUpdated` batch for `rwaToken` — the event carries no addresses, only a count. */
  getLastWhitelistUpdate(rwaToken: Address): { added: boolean; count: number; timestamp: number } | undefined {
    return this.lastWhitelistUpdateByToken.get(rwaToken);
  }

  /** Live on-chain depth of both dual-FIFO queues for `vault` (net settlement conversion, §8). */
  async getQueueSnapshot(vault: Address): Promise<QueueSnapshot> {
    const [depositDepth, redeemDepth] = await Promise.all([
      this.sdk.queueDepth(vault, QueueType.DEPOSIT),
      this.sdk.queueDepth(vault, QueueType.REDEEM),
    ]);
    return { depositDepth, redeemDepth };
  }

  /** Generic ad-hoc historical query — any contract/event this indexer doesn't already track. */
  async getEvents(contract: Contract, eventName: string, fromBlock: number | bigint = 0, toBlock: number | bigint | "latest" = "latest") {
    return contract.queryFilter(contract.filters[eventName](), fromBlock, toBlock);
  }
}
