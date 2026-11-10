import { Interface, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { getAbi, type ContractName } from "../src/abis.js";
import { OnChainEventIndexer } from "../src/indexer.js";
import { resolveDepositRequestState, type HyperTesseraSDK } from "../src/sdk.js";
import { DepositRequestState, ModuleId, PauseState, ProductState, QueueType, type Address } from "../src/types.js";

const rndAddr = () => Wallet.createRandom().address;

const CASH = rndAddr();
const NOTE = rndAddr();
const LP = rndAddr();

/**
 * One indexed log. `topics` holds the indexed values positionally, which is all the fake
 * `queryFilter` needs to reproduce ethers' topic matching (`filters.X(null, DEPOSIT)`).
 */
type FakeLog = {
  args: Record<string, unknown>;
  topics?: unknown[];
  blockNumber?: number;
  index?: number;
  transactionHash?: string;
};

/**
 * Stand-in for an ethers Contract restricted to the surface `OnChainEventIndexer.backfill()`
 * uses: `filters.<Event>(...)` and `queryFilter(filter, from, to)`.
 */
let fakeContractCounter = 0;

function fakeEventContract(logsByEvent: Record<string, FakeLog[]>) {
  const contractId = `c${fakeContractCounter++}`;
  return {
    filters: new Proxy(
      {},
      {
        get: (_target, event: string) => (...args: unknown[]) => ({ event, args }),
      },
    ),
    async queryFilter(filter: { event: string; args: unknown[] }) {
      return (logsByEvent[filter.event] ?? [])
        .filter((log) => filter.args.every((want, i) => want == null || String(want) === String(log.topics?.[i])))
        .map((log, i) => ({
          ...log,
          blockNumber: log.blockNumber ?? 1,
          // Stable per (contract, event, position), as on a real chain: the indexer keys its
          // apply-once set on `transactionHash:index`, so a fake without them would collapse every
          // log into one identity — and re-querying the same range must be a no-op, not a replay.
          transactionHash: log.transactionHash ?? `0x${contractId}${filter.event}${i}`,
          index: log.index ?? i,
        }));
    },
  };
}

/**
 * Stand-in for `HyperTesseraSDK.getContract` covering the adapter type probe in `onAdapterAdded`,
 * plus (for `RWAToken`) the compliance-switch event backfill: a real `RWAToken` needs both
 * `assetId()` (the probe) and `filters`/`queryFilter` (the event backfill), so that variant merges
 * a `fakeEventContract` with the `assetId()` reader.
 */
function fakeGetContract(
  rwaTokenOf: Record<string, string>,
  assetIdOf: Record<string, bigint>,
  rwaTokenLogsOf: Record<string, Record<string, FakeLog[]>> = {},
) {
  return (name: ContractName, address: string) => {
    if (name === "RWAAdapter") {
      return {
        async rwaToken() {
          const token = rwaTokenOf[address];
          if (!token) throw new Error("missing revert data (action=call)");
          return token;
        },
      };
    }
    if (name === "RWAToken") {
      return {
        ...fakeEventContract(rwaTokenLogsOf[address] ?? {}),
        async assetId() { return assetIdOf[address]; },
      };
    }
    return { async assetId() { return assetIdOf[address]; } };
  };
}

/**
 * Builds an indexer whose vaults / Queue replay the supplied logs on backfill(). Without
 * `discovered` the indexer takes its default vault set (the three configured tranches); with it,
 * the set is passed explicitly, standing in for a set discovered off StateManager's vault index.
 */
function makeIndexer(
  opts: {
    cash?: Record<string, FakeLog[]>;
    note?: Record<string, FakeLog[]>;
    queue?: Record<string, FakeLog[]>;
    /** adapter -> rwaToken, then rwaToken -> assetId, for the RWAAdapter probe. */
    rwaTokenOf?: Record<string, string>;
    assetIdOf?: Record<string, bigint>;
    /** StateManager logs — the pause surface. */
    stateManager?: Record<string, FakeLog[]>;
    /** AssetRegistry logs — ProductInfoSet / AssetRegistered. */
    assetRegistry?: Record<string, FakeLog[]>;
    /** RWAToken address -> its compliance-switch logs (WhitelistEnabledSet / TransferPathEnabledSet / WhitelistUpdated). */
    rwaTokens?: Record<Address, Record<string, FakeLog[]>>;
    /** Non-tranche vaults to index, address -> its logs. */
    discovered?: Record<Address, Record<string, FakeLog[]>>;
  } = {},
) {
  const byAddress: Record<string, ReturnType<typeof fakeEventContract>> = {
    [CASH]: fakeEventContract(opts.cash ?? {}),
    [NOTE]: fakeEventContract(opts.note ?? {}),
    [LP]: fakeEventContract({}),
  };
  for (const [address, logs] of Object.entries(opts.discovered ?? {})) byAddress[address] = fakeEventContract(logs);
  const sdk = {
    vaultAddress: (t: string) => (t === "cash" ? CASH : t === "note" ? NOTE : LP),
    vaultAt: (address: Address) => byAddress[address] ?? fakeEventContract({}),
    queue: fakeEventContract(opts.queue ?? {}),
    settlement: fakeEventContract({}),
    navOracle: fakeEventContract({}),
    assetRegistry: fakeEventContract(opts.assetRegistry ?? {}),
    stateManager: fakeEventContract(opts.stateManager ?? {}),
    getContract: fakeGetContract(opts.rwaTokenOf ?? {}, opts.assetIdOf ?? {}, opts.rwaTokens ?? {}),
  } as unknown as HyperTesseraSDK;
  const discovered = Object.keys(opts.discovered ?? {});
  // Chain head stub — `backfill()` resolves a "latest" toBlock through it before chunking.
  const provider = { getBlockNumber: async () => 1 } as never;
  return discovered.length > 0
    ? new OnChainEventIndexer(sdk, provider, [CASH, NOTE, LP, ...discovered])
    : new OnChainEventIndexer(sdk, provider);
}

const depositRequested = (requestId: bigint, owner: Address, assets: bigint): FakeLog => ({
  args: { requestId, owner, assets },
  topics: [requestId, owner],
  blockNumber: 10,
});

const queueRemoval = (vault: Address, queueType: QueueType, requestId: bigint): FakeLog => ({
  args: { vault, queueType, requestId },
  topics: [vault, queueType, requestId],
});

describe("OnChainEventIndexer — deposit request reconstruction", () => {
  const owner = rndAddr();

  it("records DepositSettled amounts and cycle", async () => {
    const indexer = makeIndexer({
      cash: {
        DepositRequested: [depositRequested(1n, owner, 1_000_000n)],
        DepositSettled: [
          {
            args: { requestId: 1n, originalAssets: 1_000_000n, settledAssets: 700_000n, refundedAssets: 300_000n, cycleNumber: 5n },
            topics: [1n, 5n],
          },
        ],
      },
    });

    await indexer.backfill();

    const rec = indexer.getDepositRecord(CASH, 1n)!;
    expect(rec.settled).toBe(true);
    expect(rec.settledAssets).toBe(700_000n);
    expect(rec.refundedAssets).toBe(300_000n);
    expect(rec.settledCycleNumber).toBe(5n);
    expect(indexer.getPendingDeposits(CASH)).toHaveLength(0);
  });

  it("lowers assets and accumulates the haircut across repeated RequestWrittenDown events", async () => {
    const indexer = makeIndexer({
      cash: {
        DepositRequested: [depositRequested(2n, owner, 1_000_000n)],
        RequestWrittenDown: [
          { args: { requestId: 2n, haircut: 100_000n, newAmount: 900_000n }, topics: [2n] },
          { args: { requestId: 2n, haircut: 400_000n, newAmount: 500_000n }, topics: [2n] },
        ],
      },
    });

    await indexer.backfill();

    const rec = indexer.getDepositRecord(CASH, 2n)!;
    expect(rec.assets).toBe(500_000n);
    expect(rec.writtenDownHaircut).toBe(500_000n);
  });

  it("ignores a RequestWrittenDown for a requestId that is not a known deposit (redeem side)", async () => {
    const indexer = makeIndexer({
      cash: { RequestWrittenDown: [{ args: { requestId: 77n, haircut: 1n, newAmount: 2n }, topics: [77n] }] },
    });

    await expect(indexer.backfill()).resolves.toBeUndefined();
    expect(indexer.getDepositRecord(CASH, 77n)).toBeUndefined();
  });

  it("flags a DEPOSIT-side queue removal, which folds to REFUNDABLE while FUNDING_FAILED", async () => {
    const indexer = makeIndexer({
      cash: { DepositRequested: [depositRequested(3n, owner, 500_000n)] },
      queue: { RequestCancelledFromQueue: [queueRemoval(CASH, QueueType.DEPOSIT, 3n)] },
    });

    await indexer.backfill();

    const rec = indexer.getDepositRecord(CASH, 3n)!;
    expect(rec.removedFromQueue).toBe(true);
    expect(rec.cancelled).toBe(false);
    expect(resolveDepositRequestState(rec, ProductState.FUNDING_FAILED)).toBe(DepositRequestState.REFUNDABLE);
    expect(resolveDepositRequestState(rec, ProductState.SUBSCRIBING)).toBe(DepositRequestState.PENDING);
  });

  it("pairs the queue removal with RequestCancelled for a user cancel, which stays CANCELLED", async () => {
    const indexer = makeIndexer({
      cash: {
        DepositRequested: [depositRequested(4n, owner, 500_000n)],
        RequestCancelled: [{ args: { requestId: 4n, actor: owner }, topics: [4n] }],
      },
      queue: { RequestCancelledFromQueue: [queueRemoval(CASH, QueueType.DEPOSIT, 4n)] },
    });

    await indexer.backfill();

    const rec = indexer.getDepositRecord(CASH, 4n)!;
    expect(rec.removedFromQueue).toBe(true);
    expect(resolveDepositRequestState(rec, ProductState.FUNDING_FAILED)).toBe(DepositRequestState.CANCELLED);
  });

  it("does not let a REDEEM-side queue removal touch a same-numbered deposit record", async () => {
    const indexer = makeIndexer({
      cash: { DepositRequested: [depositRequested(5n, owner, 500_000n)] },
      queue: { RequestCancelledFromQueue: [queueRemoval(CASH, QueueType.REDEEM, 5n)] },
    });

    await indexer.backfill();

    expect(indexer.getDepositRecord(CASH, 5n)!.removedFromQueue).toBe(false);
  });

  it("tolerates a DEPOSIT-side queue removal from a vault outside the indexed tranches", async () => {
    const indexer = makeIndexer({
      queue: { RequestCancelledFromQueue: [queueRemoval(rndAddr(), QueueType.DEPOSIT, 6n)] },
    });

    await expect(indexer.backfill()).resolves.toBeUndefined();
  });
});

const adapterEvent = (adapter: string, blockNumber: number, index: number): FakeLog => ({
  args: { adapter },
  topics: [adapter],
  blockNumber,
  index,
});

describe("OnChainEventIndexer — vault -> asset relation reconstruction", () => {
  /** Two adapters, each pointing at its own rwaToken, each token at its own assetId. */
  function twoRWAAdapters() {
    const [adapterA, adapterB, tokenA, tokenB] = [rndAddr(), rndAddr(), rndAddr(), rndAddr()];
    return {
      adapterA,
      adapterB,
      tokenA,
      tokenB,
      rwaTokenOf: { [adapterA]: tokenA, [adapterB]: tokenB },
      assetIdOf: { [tokenA]: 11n, [tokenB]: 22n },
    };
  }

  it("resolves a vault's two RWAAdapters to their two assetIds", async () => {
    const { adapterA, adapterB, tokenA, tokenB, rwaTokenOf, assetIdOf } = twoRWAAdapters();
    const indexer = makeIndexer({
      cash: { AdapterAdded: [adapterEvent(adapterA, 10, 0), adapterEvent(adapterB, 11, 0)] },
      rwaTokenOf,
      assetIdOf,
    });

    await indexer.backfill();

    expect(indexer.getVaultAssetLinks(CASH)).toEqual([
      { vault: CASH, adapter: adapterA, rwaToken: tokenA, assetId: 11n },
      { vault: CASH, adapter: adapterB, rwaToken: tokenB, assetId: 22n },
    ]);
    expect(indexer.getVaultAssetIds(CASH)).toEqual([11n, 22n]);
    expect(indexer.getVaultsHoldingAsset(11n)).toEqual([CASH]);
  });

  it("indexes only the RWAAdapter when a non-RWA adapter is attached alongside it", async () => {
    const { adapterA, tokenA, rwaTokenOf, assetIdOf } = twoRWAAdapters();
    const firstPeriodAdapter = rndAddr(); // absent from rwaTokenOf -> rwaToken() reverts
    const indexer = makeIndexer({
      cash: { AdapterAdded: [adapterEvent(firstPeriodAdapter, 10, 0), adapterEvent(adapterA, 10, 1)] },
      rwaTokenOf,
      assetIdOf,
    });

    await expect(indexer.backfill()).resolves.toBeUndefined();

    expect(indexer.getVaultAssetLinks(CASH)).toEqual([{ vault: CASH, adapter: adapterA, rwaToken: tokenA, assetId: 11n }]);
  });

  it("leaves a vault of only non-RWA adapters empty without throwing — today's deployed state", async () => {
    const indexer = makeIndexer({
      cash: { AdapterAdded: [adapterEvent(rndAddr(), 10, 0), adapterEvent(rndAddr(), 10, 1)] },
    });

    await expect(indexer.backfill()).resolves.toBeUndefined();

    expect(indexer.getVaultAssetLinks(CASH)).toEqual([]);
    expect(indexer.getVaultAssetIds(CASH)).toEqual([]);
  });

  it("drops the link once the adapter is removed", async () => {
    const { adapterA, adapterB, tokenB, rwaTokenOf, assetIdOf } = twoRWAAdapters();
    const indexer = makeIndexer({
      cash: {
        AdapterAdded: [adapterEvent(adapterA, 10, 0), adapterEvent(adapterB, 10, 1)],
        AdapterRemoved: [adapterEvent(adapterA, 12, 0)],
      },
      rwaTokenOf,
      assetIdOf,
    });

    await indexer.backfill();

    expect(indexer.getVaultAssetLinks(CASH)).toEqual([{ vault: CASH, adapter: adapterB, rwaToken: tokenB, assetId: 22n }]);
    expect(indexer.getVaultsHoldingAsset(11n)).toEqual([]);
  });

  it("replays add/remove/add in log order, so a re-added adapter is live again", async () => {
    const { adapterA, tokenA, rwaTokenOf, assetIdOf } = twoRWAAdapters();
    const indexer = makeIndexer({
      cash: {
        AdapterAdded: [adapterEvent(adapterA, 10, 0), adapterEvent(adapterA, 30, 0)],
        AdapterRemoved: [adapterEvent(adapterA, 20, 0)],
      },
      rwaTokenOf,
      assetIdOf,
    });

    await indexer.backfill();

    expect(indexer.getVaultAssetLinks(CASH)).toEqual([{ vault: CASH, adapter: adapterA, rwaToken: tokenA, assetId: 11n }]);
  });

  it("reports both vaults when two of them hold the same asset through different adapters", async () => {
    const { adapterA, adapterB, tokenA, tokenB, rwaTokenOf } = twoRWAAdapters();
    const indexer = makeIndexer({
      cash: { AdapterAdded: [adapterEvent(adapterA, 10, 0)] },
      note: { AdapterAdded: [adapterEvent(adapterB, 10, 0)] },
      rwaTokenOf,
      assetIdOf: { [tokenA]: 42n, [tokenB]: 42n },
    });

    await indexer.backfill();

    expect(indexer.getVaultsHoldingAsset(42n)).toEqual([CASH, NOTE]);
    expect(indexer.getVaultAssetIds(CASH)).toEqual([42n]);
    expect(indexer.getVaultAssetIds(NOTE)).toEqual([42n]);
    expect(indexer.getVaultsHoldingAsset(43n)).toEqual([]);
  });

  it("de-duplicates assetIds reached through two adapters on the same vault", async () => {
    const { adapterA, adapterB, tokenA, tokenB, rwaTokenOf } = twoRWAAdapters();
    const indexer = makeIndexer({
      cash: { AdapterAdded: [adapterEvent(adapterA, 10, 0), adapterEvent(adapterB, 10, 1)] },
      rwaTokenOf,
      assetIdOf: { [tokenA]: 9n, [tokenB]: 9n },
    });

    await indexer.backfill();

    expect(indexer.getVaultAssetLinks(CASH)).toHaveLength(2);
    expect(indexer.getVaultAssetIds(CASH)).toEqual([9n]);
  });

  it("grounds the try/catch probe: only RWAAdapter declares rwaToken()", () => {
    expect(new Interface(getAbi("RWAAdapter")).getFunction("rwaToken")).not.toBeNull();
    expect(new Interface(getAbi("FirstPeriodAdapter")).getFunction("rwaToken")).toBeNull();
    expect(new Interface(getAbi("LiquidityAdapter")).getFunction("rwaToken")).toBeNull();
  });
});

describe("OnChainEventIndexer — AssetRegistry / RWAToken compliance-event backfill", () => {
  it("getProductInfo decodes AssetRegistry.ProductInfoSet and returns undefined for an unseen assetId", async () => {
    const issuer = rndAddr();
    const indexer = makeIndexer({
      assetRegistry: {
        ProductInfoSet: [
          {
            args: {
              assetId: 7n,
              issuer,
              productName: "Test Note",
              annualYieldRateBps: 500,
              maturityTimestamp: 1_800_000_000n,
              underlyingAsset: "US Treasury Bill",
            },
            topics: [7n, issuer],
          },
        ],
      },
    });

    await indexer.backfill();

    expect(indexer.getProductInfo(7n)).toEqual({
      productName: "Test Note",
      annualYieldRateBps: 500,
      maturityTimestamp: 1_800_000_000n,
      issuer,
      underlyingAsset: "US Treasury Bill",
    });
    expect(indexer.getProductInfo(8n)).toBeUndefined();
  });

  it("getAssetToken discovers the RWAToken address from AssetRegistered", async () => {
    const owner = rndAddr();
    const token = rndAddr();
    const indexer = makeIndexer({
      assetRegistry: {
        AssetRegistered: [{ args: { assetId: 3n, owner, token, metadataHash: "0x" + "11".repeat(32), timestamp: 1n }, topics: [3n, owner, token] }],
      },
    });

    await indexer.backfill();

    expect(indexer.getAssetToken(3n)).toBe(token);
    expect(indexer.getAssetToken(4n)).toBeUndefined();
  });

  it("polls every RWAToken discovered via AssetRegistered for its own compliance-switch events", async () => {
    const owner = rndAddr();
    const token = rndAddr();
    const indexer = makeIndexer({
      assetRegistry: {
        AssetRegistered: [{ args: { assetId: 5n, owner, token, metadataHash: "0x" + "22".repeat(32), timestamp: 1n }, topics: [5n, owner, token] }],
      },
      rwaTokens: {
        [token]: {
          WhitelistEnabledSet: [{ args: { enabled: true, timestamp: 1n }, topics: [] }],
          TransferPathEnabledSet: [{ args: { enabled: true, timestamp: 1n }, topics: [] }],
          WhitelistUpdated: [{ args: { added: true, count: 4n, timestamp: 2n }, topics: [] }],
        },
      },
    });

    await indexer.backfill();

    expect(indexer.getWhitelistEnabled(token)).toBe(true);
    expect(indexer.getTransferPathEnabled(token)).toBe(true);
    expect(indexer.getLastWhitelistUpdate(token)).toEqual({ added: true, count: 4, timestamp: 2 });
  });

  it("replays WhitelistEnabledSet/TransferPathEnabledSet in log order, so the latest toggle wins", async () => {
    const owner = rndAddr();
    const token = rndAddr();
    const indexer = makeIndexer({
      assetRegistry: {
        AssetRegistered: [{ args: { assetId: 6n, owner, token, metadataHash: "0x" + "33".repeat(32), timestamp: 1n }, topics: [6n, owner, token] }],
      },
      rwaTokens: {
        [token]: {
          WhitelistEnabledSet: [
            { args: { enabled: true, timestamp: 1n }, topics: [], blockNumber: 1, index: 0 },
            { args: { enabled: false, timestamp: 2n }, topics: [], blockNumber: 2, index: 0 },
          ],
        },
      },
    });

    await indexer.backfill();

    expect(indexer.getWhitelistEnabled(token)).toBe(false);
  });

  it("a token never mentioned in AssetRegistered is never polled and reports undefined", async () => {
    const indexer = makeIndexer();

    await indexer.backfill();

    expect(indexer.getWhitelistEnabled(rndAddr())).toBeUndefined();
    expect(indexer.getTransferPathEnabled(rndAddr())).toBeUndefined();
    expect(indexer.getLastWhitelistUpdate(rndAddr())).toBeUndefined();
  });
});

describe("OnChainEventIndexer — discovered vault set", () => {
  const owner = rndAddr();

  it("defaults to the three configured tranche vaults", () => {
    expect(makeIndexer().indexedVaults()).toEqual([CASH, NOTE, LP]);
  });

  it("indexes a vault outside the configured tranches when it is in the discovered set", async () => {
    const permissionless = rndAddr(); // deployed via VaultFactory, unknown to the tranche config
    const indexer = makeIndexer({
      discovered: { [permissionless]: { DepositRequested: [depositRequested(1n, owner, 250_000n)] } },
    });

    await indexer.backfill();

    expect(indexer.indexedVaults()).toContain(permissionless);
    expect(indexer.getDepositRecord(permissionless, 1n)!.assets).toBe(250_000n);
    expect(indexer.getPendingDeposits(permissionless)).toHaveLength(1);
  });

  it("routes a discovered vault's queue events to that vault, not to a tranche", async () => {
    const permissionless = rndAddr();
    const indexer = makeIndexer({
      cash: { DepositRequested: [depositRequested(1n, owner, 100n)] },
      discovered: { [permissionless]: { DepositRequested: [depositRequested(1n, owner, 250_000n)] } },
      queue: { RequestCancelledFromQueue: [queueRemoval(permissionless, QueueType.DEPOSIT, 1n)] },
    });

    await indexer.backfill();

    expect(indexer.getDepositRecord(permissionless, 1n)!.removedFromQueue).toBe(true);
    expect(indexer.getDepositRecord(CASH, 1n)!.removedFromQueue).toBe(false);
  });

  it("still rejects a query for a vault outside its set", () => {
    const indexer = makeIndexer();

    expect(() => indexer.getPendingDeposits(rndAddr())).toThrow(/not indexed/i);
  });

  it("de-duplicates a repeated vault address", () => {
    const sdk = {
      vaultAddress: () => CASH,
      vaultAt: () => fakeEventContract({}),
    } as unknown as HyperTesseraSDK;

    expect(new OnChainEventIndexer(sdk, {} as never, [CASH, NOTE, CASH]).indexedVaults()).toEqual([CASH, NOTE]);
  });

  it("grounds indexing every vault through one ABI: both vault kinds declare the subscribed events identically", () => {
    const earn = new Interface(getAbi("EarnVault"));
    const lp = new Interface(getAbi("LiquidityEarnVault"));
    const subscribed = [
      "DepositRequested",
      "DepositClaimed",
      "DepositSettled",
      "RequestWrittenDown",
      "RequestCancelled",
      "RefundClaimed",
      "RedeemRequested",
      "RedeemSettled",
      "RedeemClaimed",
      "AdapterAdded",
      "AdapterRemoved",
    ];

    for (const event of subscribed) {
      expect(lp.getEvent(event)?.format("full")).toBe(earn.getEvent(event)?.format("full"));
    }
  });

  it("RedeemSettled lowers remainingShares and accumulates settledAssets across partial fills", async () => {
    const owner = rndAddr();
    const indexer = makeIndexer({
      cash: {
        RedeemRequested: [{ args: { requestId: 7n, owner, shares: 1_000n }, topics: [7n, owner], blockNumber: 3 }],
        RedeemSettled: [
          {
            args: { requestId: 7n, originalShares: 1_000n, settledSharesThisCycle: 400n, remainingShares: 600n, settledAssetsThisCycle: 40_000n, cycleNumber: 1n },
            topics: [7n, 1n],
          },
          {
            args: { requestId: 7n, originalShares: 1_000n, settledSharesThisCycle: 250n, remainingShares: 350n, settledAssetsThisCycle: 25_000n, cycleNumber: 2n },
            topics: [7n, 2n],
          },
        ],
      },
      queue: {
        RequestQueued: [{ args: { vault: CASH, queueType: QueueType.REDEEM, requestId: 7n, slotIndex: 0n, orderHash: "0xfeed" }, topics: [CASH, QueueType.REDEEM, 7n] }],
      },
    });

    await indexer.backfill();

    const [rec] = indexer.getClearingList(CASH);
    expect(rec.shares).toBe(1_000n);
    expect(rec.remainingShares).toBe(350n);
    expect(rec.settledAssets).toBe(65_000n);
    expect(rec.lastSettledCycleNumber).toBe(2n);
  });

  it("a redeem with no fills yet reports remainingShares equal to the original request", async () => {
    const owner = rndAddr();
    const indexer = makeIndexer({
      cash: {
        RedeemRequested: [{ args: { requestId: 8n, owner, shares: 500n }, topics: [8n, owner], blockNumber: 3 }],
      },
      queue: {
        RequestQueued: [{ args: { vault: CASH, queueType: QueueType.REDEEM, requestId: 8n, slotIndex: 0n, orderHash: "0xbeef" }, topics: [CASH, QueueType.REDEEM, 8n] }],
      },
    });

    await indexer.backfill();

    const [rec] = indexer.getClearingList(CASH);
    expect(rec.remainingShares).toBe(500n);
    expect(rec.settledAssets).toBe(0n);
    expect(rec.lastSettledCycleNumber).toBeUndefined();
  });

  it("a cancelled partial fill is distinguishable from a cancelled unfilled redeem: cancelledButSettled flags the one that is still claimable", async () => {
    const partialOwner = rndAddr();
    const untouchedOwner = rndAddr();
    const indexer = makeIndexer({
      cash: {
        RedeemRequested: [
          { args: { requestId: 11n, owner: partialOwner, shares: 100n }, topics: [11n, partialOwner], blockNumber: 3 },
          { args: { requestId: 12n, owner: untouchedOwner, shares: 100n }, topics: [12n, untouchedOwner], blockNumber: 3 },
        ],
        // Only 11 was partially filled: 40 of 100 shares, reserving 4_000 USDT.
        RedeemSettled: [
          {
            args: { requestId: 11n, originalShares: 100n, settledSharesThisCycle: 40n, remainingShares: 60n, settledAssetsThisCycle: 4_000n, cycleNumber: 1n },
            topics: [11n, 1n],
          },
        ],
        RequestCancelled: [
          { args: { requestId: 11n, actor: partialOwner, timestamp: 1n }, topics: [11n] },
          { args: { requestId: 12n, actor: untouchedOwner, timestamp: 1n }, topics: [12n] },
        ],
      },
      queue: {
        RequestQueued: [
          { args: { vault: CASH, queueType: QueueType.REDEEM, requestId: 11n, slotIndex: 0n, orderHash: "0xaa" }, topics: [CASH, QueueType.REDEEM, 11n] },
          { args: { vault: CASH, queueType: QueueType.REDEEM, requestId: 12n, slotIndex: 1n, orderHash: "0xbb" }, topics: [CASH, QueueType.REDEEM, 12n] },
        ],
        // Cancelling removes both from the FIFO, so both records end up tombstoned.
        RequestCancelledFromQueue: [queueRemoval(CASH, QueueType.REDEEM, 11n), queueRemoval(CASH, QueueType.REDEEM, 12n)],
      },
    });

    await indexer.backfill();

    const partial = indexer.getRedeemRecord(CASH, 11n)!;
    const cancelled = indexer.getRedeemRecord(CASH, 12n)!;

    // Both left the queue the same way — tombstoned is not enough to tell them apart.
    expect(partial.tombstoned).toBe(true);
    expect(cancelled.tombstoned).toBe(true);
    expect(indexer.getClearingList(CASH)).toEqual([]);

    // The partial fill still owes 4_000 USDT through claimRedeem; the unfilled one owes nothing.
    expect(partial.cancelledButSettled).toBe(true);
    expect(partial.settledAssets).toBe(4_000n);
    expect(partial.claimed).toBe(false);
    expect(cancelled.cancelledButSettled).toBe(false);
    expect(cancelled.settledAssets).toBe(0n);

    // Cancelling returned every unfilled share, so nothing is still owed in shares on either.
    expect(partial.remainingShares).toBe(0n);
    expect(cancelled.remainingShares).toBe(0n);
  });

  it("orders pending deposits by the on-chain DEPOSIT slot, not by requestId", async () => {
    const owner = rndAddr();
    const indexer = makeIndexer({
      cash: {
        DepositRequested: [depositRequested(11n, owner, 100n), depositRequested(12n, owner, 200n)],
      },
      queue: {
        // 12 was queued ahead of 11 — requestId order and FIFO order disagree.
        RequestQueued: [
          { args: { vault: CASH, queueType: QueueType.DEPOSIT, requestId: 12n, slotIndex: 3n, orderHash: "0xaa" }, topics: [CASH, QueueType.DEPOSIT, 12n] },
          { args: { vault: CASH, queueType: QueueType.DEPOSIT, requestId: 11n, slotIndex: 4n, orderHash: "0xbb" }, topics: [CASH, QueueType.DEPOSIT, 11n] },
        ],
      },
    });

    await indexer.backfill();

    const pending = indexer.getPendingDeposits(CASH);
    expect(pending.map((r) => r.requestId)).toEqual([12n, 11n]);
    expect(pending[0].slotIndex).toBe(3n);
    expect(pending[0].orderHash).toBe("0xaa");
  });

  it("re-running backfill over an already indexed range does not double-count accumulating fields", async () => {
    const owner = rndAddr();
    const indexer = makeIndexer({
      cash: {
        DepositRequested: [depositRequested(21n, owner, 1_000_000n)],
        RequestWrittenDown: [{ args: { requestId: 21n, haircut: 100_000n, newAmount: 900_000n }, topics: [21n] }],
        RedeemRequested: [{ args: { requestId: 22n, owner, shares: 1_000n }, topics: [22n, owner] }],
        RedeemSettled: [
          {
            args: { requestId: 22n, originalShares: 1_000n, settledSharesThisCycle: 400n, remainingShares: 600n, settledAssetsThisCycle: 40_000n, cycleNumber: 1n },
            topics: [22n, 1n],
          },
        ],
      },
      queue: {
        RequestQueued: [{ args: { vault: CASH, queueType: QueueType.REDEEM, requestId: 22n, slotIndex: 0n, orderHash: "0x01" }, topics: [CASH, QueueType.REDEEM, 22n] }],
      },
    });

    await indexer.backfill(0, 1);
    await indexer.backfill(0, 1);

    expect(indexer.getDepositRecord(CASH, 21n)!.writtenDownHaircut).toBe(100_000n);
    expect(indexer.getDepositRecord(CASH, 21n)!.assets).toBe(900_000n);
    const [redeem] = indexer.getClearingList(CASH);
    expect(redeem.settledAssets).toBe(40_000n);
    expect(redeem.remainingShares).toBe(600n);
  });

  it("walks the range in chunks and reports the last indexed block", async () => {
    const seen: Array<[unknown, unknown]> = [];
    const recordingContract = {
      filters: new Proxy({}, { get: (_t, event: string) => (...args: unknown[]) => ({ event, args }) }),
      async queryFilter(_filter: unknown, from: unknown, to: unknown) {
        seen.push([from, to]);
        return [];
      },
    };
    const sdk = {
      vaultAddress: () => CASH,
      vaultAt: () => recordingContract,
      queue: recordingContract,
      settlement: recordingContract,
      navOracle: recordingContract,
      assetRegistry: recordingContract,
      stateManager: recordingContract,
    } as unknown as HyperTesseraSDK;
    const indexer = new OnChainEventIndexer(sdk, { getBlockNumber: async () => 250 } as never, [CASH]);

    expect(indexer.lastIndexedBlock()).toBe(-1);
    await indexer.backfill(0, "latest", { chunkSize: 100 });

    const windows = [...new Set(seen.map(([from, to]) => `${from}-${to}`))];
    expect(windows).toEqual(["0-99", "100-199", "200-250"]);
    expect(indexer.lastIndexedBlock()).toBe(250);
  });

  it("retries a failing chunk before giving up", async () => {
    let attempts = 0;
    const flaky = {
      filters: new Proxy({}, { get: (_t, event: string) => (...args: unknown[]) => ({ event, args }) }),
      async queryFilter() {
        attempts++;
        if (attempts < 3) throw new Error("limit exceeded");
        return [];
      },
    };
    const sdk = {
      vaultAddress: () => CASH,
      vaultAt: () => flaky,
      queue: flaky,
      settlement: flaky,
      navOracle: flaky,
      assetRegistry: flaky,
      stateManager: flaky,
    } as unknown as HyperTesseraSDK;
    const indexer = new OnChainEventIndexer(sdk, { getBlockNumber: async () => 1 } as never, [CASH]);

    await indexer.backfill(0, 1, { maxRetries: 3, baseRetryDelayMs: 1 });

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(indexer.lastIndexedBlock()).toBe(1);
  });

  it("tracks the vault pause surface, replaying pause/unpause in log order", async () => {
    const indexer = makeIndexer({
      stateManager: {
        VaultPauseSet: [
          { args: { vault: CASH, reason: PauseState.PAUSED_BY_GUARDIAN, actor: rndAddr() }, topics: [CASH], blockNumber: 1, index: 0 },
          { args: { vault: NOTE, reason: PauseState.PAUSED_BY_GOVERNOR, actor: rndAddr() }, topics: [NOTE], blockNumber: 1, index: 1 },
        ],
        VaultUnpaused: [
          { args: { vault: CASH, previousReason: PauseState.PAUSED_BY_GUARDIAN, actor: rndAddr() }, topics: [CASH], blockNumber: 1, index: 2 },
        ],
        ModulePaused: [{ args: { id: ModuleId.SETTLEMENT, actor: rndAddr() }, topics: [ModuleId.SETTLEMENT], blockNumber: 1, index: 3 }],
      },
    });

    await indexer.backfill(0, 1);

    expect(indexer.getVaultPauseState(CASH)).toBe(PauseState.ACTIVE);
    expect(indexer.getVaultPauseState(NOTE)).toBe(PauseState.PAUSED_BY_GOVERNOR);
    expect(indexer.getVaultPauseState(LP)).toBe(PauseState.ACTIVE);
    expect(indexer.getPausedModules()).toEqual([ModuleId.SETTLEMENT]);
  });

  it("start() polls forward from lastIndexedBlock, staying `confirmations` behind the head", async () => {
    const seen: Array<[unknown, unknown]> = [];
    const recordingContract = {
      filters: new Proxy({}, { get: (_t, event: string) => (...args: unknown[]) => ({ event, args }) }),
      async queryFilter(_filter: unknown, from: unknown, to: unknown) {
        seen.push([from, to]);
        return [];
      },
    };
    const sdk = {
      vaultAddress: () => CASH,
      vaultAt: () => recordingContract,
      queue: recordingContract,
      settlement: recordingContract,
      navOracle: recordingContract,
      assetRegistry: recordingContract,
      stateManager: recordingContract,
    } as unknown as HyperTesseraSDK;
    const head = 100;
    const indexer = new OnChainEventIndexer(sdk, { getBlockNumber: async () => head } as never, [CASH]);

    await indexer.backfill(0, 90);
    indexer.start({ pollIntervalMs: 60_000, confirmations: 6 });
    await new Promise((r) => setTimeout(r, 10)); // let the immediate first tick settle
    indexer.stop();

    // head 100 - 6 confirmations = 94, so the poll resumes at 91 rather than re-reading from 0.
    const windows = [...new Set(seen.map(([from, to]) => `${from}-${to}`))];
    expect(windows).toContain("91-94");
    expect(indexer.lastIndexedBlock()).toBe(94);
  });

  it("discover() takes its vault set from StateManager's on-chain index via the SDK", async () => {
    const permissionless = rndAddr();
    const sdk = {
      getAllVaults: async (pageSize: number) => {
        expect(pageSize).toBe(50);
        return [CASH, permissionless];
      },
      vaultAt: () => fakeEventContract({}),
    } as unknown as HyperTesseraSDK;

    const indexer = await OnChainEventIndexer.discover(sdk, {} as never, 50);

    expect(indexer.indexedVaults()).toEqual([CASH, permissionless]);
  });
});
