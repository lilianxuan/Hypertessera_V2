import { Interface, Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { getAbi, type ContractName } from "../src/abis.js";
import {
  HyperTesseraSDK,
  hasVaultRole,
  isDepositRefundable,
  resolveDepositRequestState,
  type HyperTesseraAddresses,
} from "../src/sdk.js";
import type { DepositRecord, OnChainEventIndexer } from "../src/indexer.js";
import {
  ActionClass,
  CreationFeeAction,
  DepositRequestState,
  FeePaymentKind,
  PauseState,
  ProductState,
  CycleState,
  VaultRole,
  VaultType,
  type ProductInfo,
} from "../src/types.js";

const rndAddr = () => Wallet.createRandom().address;

const PRODUCT_INFO: ProductInfo = {
  productName: "Test Note",
  annualYieldRateBps: 500,
  maturityTimestamp: 1_800_000_000n,
  issuer: rndAddr(), // ignored on input — the contract forces msg.sender
  underlyingAsset: "US Treasury Bill",
};

const ADDRESSES: HyperTesseraAddresses = {
  hyperAccessControl: rndAddr(),
  stateManager: rndAddr(),
  navOracle: rndAddr(),
  mintBurnController: rndAddr(),
  assetRegistry: rndAddr(),
  reservePSM: rndAddr(),
  poRRegistry: rndAddr(),
  queue: rndAddr(),
  revenuePool: rndAddr(),
  unifiedPool: rndAddr(),
  settlement: rndAddr(),
  vaultFactory: rndAddr(),
  adapterFactory: rndAddr(),
  liquidityBridge: rndAddr(),
  cashVault: rndAddr(),
  noteVault: rndAddr(),
  lpVault: rndAddr(),
  cashAdapter: rndAddr(),
  noteAdapter: rndAddr(),
  lpAdapter: rndAddr(),
};

type Receipt = { logs: { topics: string[]; data: string }[] };

/**
 * Fake ethers Contract keyed by ABI name: a real `Interface` (so event logs decode exactly like
 * production) plus a call-recording write path, standing in for the real on-chain Contract that
 * `HyperTesseraSDK.getContract` would normally return.
 */
function fakeContract(abiName: ContractName) {
  const iface = new Interface(getAbi(abiName));
  const calls: { fn: string; args: unknown[] }[] = [];
  const reads = new Map<string, unknown>();
  const readFns = new Map<string, (...args: unknown[]) => unknown>();
  let receipt: Receipt = { logs: [] };

  const base = {
    interface: iface,
    calls,
    setReceipt(r: Receipt) {
      receipt = r;
    },
    stubRead(fn: string, value: unknown) {
      reads.set(fn, value);
    },
    /** Argument-dependent read — for paged views, where each call must answer for its own window. */
    stubReadFn(fn: string, impl: (...args: any[]) => unknown) {
      readFns.set(fn, impl);
    },
    connect(_signer: unknown) {
      return {
        getFunction(fn: string) {
          return async (...args: unknown[]) => {
            calls.push({ fn, args });
            return { wait: async () => receipt };
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async (...args: unknown[]) => {
        calls.push({ fn: prop, args });
        const impl = readFns.get(prop);
        return impl ? impl(...args) : reads.get(prop);
      };
    },
  });
}

function encodeLog(abiName: ContractName, eventName: string, values: unknown[]) {
  const iface = new Interface(getAbi(abiName));
  const fragment = iface.getEvent(eventName);
  if (!fragment) throw new Error(`no such event ${eventName} on ${abiName}`);
  const { topics, data } = iface.encodeEventLog(fragment, values);
  return { topics: topics as string[], data };
}

/** Builds an SDK whose `getContract` always returns the matching fake by ABI name, ignoring address/runner. */
function makeSdk(contracts: Partial<Record<ContractName, ReturnType<typeof fakeContract>>> = {}) {
  const sdk = new HyperTesseraSDK(ADDRESSES, {} as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(sdk, "getContract").mockImplementation(((name: ContractName) => contracts[name] ?? fakeContract(name)) as any);
  return sdk;
}

const noopSigner = {} as never;

describe("HyperTesseraSDK — asset issuance & vault creation", () => {
  it("registerAsset forwards args (incl. the ProductInfo struct and a Native-rail fee override) and parses AssetRegistered", async () => {
    const assetRegistry = fakeContract("AssetRegistry");
    const owner = rndAddr();
    const token = rndAddr();
    assetRegistry.setReceipt({ logs: [encodeLog("AssetRegistry", "AssetRegistered", [7n, owner, token, "0x" + "11".repeat(32), 123n])] });
    const sdk = makeSdk({ AssetRegistry: assetRegistry });

    const result = await sdk.registerAsset(
      "0x" + "11".repeat(32),
      "Name",
      "SYM",
      6,
      FeePaymentKind.Native,
      PRODUCT_INFO,
      noopSigner,
      { value: 5n },
    );

    expect(result).toEqual({ assetId: 7n, token });
    expect(assetRegistry.calls[0]).toEqual({
      fn: "registerAsset",
      args: ["0x" + "11".repeat(32), "Name", "SYM", 6, FeePaymentKind.Native, PRODUCT_INFO, { value: 5n }],
    });
  });

  it("registerAsset throws if AssetRegistered is missing from the receipt", async () => {
    const assetRegistry = fakeContract("AssetRegistry");
    assetRegistry.setReceipt({ logs: [] });
    const sdk = makeSdk({ AssetRegistry: assetRegistry });

    await expect(
      sdk.registerAsset("0x" + "00".repeat(32), "Name", "SYM", 6, FeePaymentKind.Native, PRODUCT_INFO, noopSigner),
    ).rejects.toThrow("AssetRegistered not found");
  });

  it("getProductInfo decodes AssetRegistry.getProductInfo's return round trip", async () => {
    const assetRegistry = fakeContract("AssetRegistry");
    assetRegistry.stubRead("getProductInfo", PRODUCT_INFO);
    const sdk = makeSdk({ AssetRegistry: assetRegistry });

    const info = await sdk.getProductInfo(7n);

    expect(info).toEqual(PRODUCT_INFO);
    expect(assetRegistry.calls[0]).toEqual({ fn: "getProductInfo", args: [7n] });
  });

  it("deployVault forwards params (incl. a fee override) and parses VaultDeployed", async () => {
    const vaultFactory = fakeContract("VaultFactory");
    const vault = rndAddr();
    const owner = rndAddr();
    const timelock = rndAddr();
    vaultFactory.setReceipt({
      logs: [encodeLog("VaultFactory", "VaultDeployed", [VaultType.EARN, vault, owner, timelock, "Note", "NOTE", 999n])],
    });
    const sdk = makeSdk({ VaultFactory: vaultFactory });

    const params = {
      vaultType: VaultType.EARN,
      name: "Note",
      symbol: "NOTE",
      usdt: rndAddr(),
      stateManager: ADDRESSES.stateManager,
      settlement: "0x0000000000000000000000000000000000000000",
      queue: ADDRESSES.queue,
      owner: "0x0000000000000000000000000000000000000000",
      liquidityBridge: "0x0000000000000000000000000000000000000000",
      cashVault: "0x0000000000000000000000000000000000000000",
      feeKind: FeePaymentKind.Native,
    };

    const result = await sdk.deployVault(params, noopSigner, { value: 1n });

    expect(result).toBe(vault);
    expect(vaultFactory.calls[0]).toEqual({ fn: "deployVault", args: [params, { value: 1n }] });
  });
});

describe("HyperTesseraSDK — vault role configuration (Owner-only, direct)", () => {
  const vault = rndAddr();

  it.each([
    ["transferVaultOwnership", "transferOwnership", [rndAddr()]],
    ["setCurator", "setCurator", [rndAddr()]],
    ["setGuardian", "setGuardian", [rndAddr()]],
    ["setAllocator", "setAllocator", [rndAddr()]],
  ] as const)("%s forwards to %s", async (sdkMethod, contractFn, args) => {
    const earnVault = fakeContract("EarnVault");
    const sdk = makeSdk({ EarnVault: earnVault });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sdk as any)[sdkMethod](vault, ...args, noopSigner);

    expect(earnVault.calls[0]).toEqual({ fn: contractFn, args });
  });

  it("setKeeper forwards (account, approved)", async () => {
    const earnVault = fakeContract("EarnVault");
    const sdk = makeSdk({ EarnVault: earnVault });
    const account = rndAddr();

    await sdk.setKeeper(vault, account, true, noopSigner);

    expect(earnVault.calls[0]).toEqual({ fn: "setKeeper", args: [account, true] });
  });

  it("setVaultOperator forwards (operator, approved); isVaultOperator reads through", async () => {
    const earnVault = fakeContract("EarnVault");
    const operator = rndAddr();
    const owner = rndAddr();
    earnVault.stubRead("isOperator", true);
    const sdk = makeSdk({ EarnVault: earnVault });

    await sdk.setVaultOperator(vault, operator, true, noopSigner);
    const isOp = await sdk.isVaultOperator(vault, owner, operator);

    expect(earnVault.calls[0]).toEqual({ fn: "setOperator", args: [operator, true] });
    expect(isOp).toBe(true);
  });
});

describe("HyperTesseraSDK — product params", () => {
  it("setProductParams forwards (vault, params) to StateManager", async () => {
    const stateManager = fakeContract("StateManager");
    const sdk = makeSdk({ StateManager: stateManager });
    const vault = rndAddr();
    const params = {
      subscriptionStart: 0n,
      subscriptionEnd: 10n,
      walletSubscriptionCap: 0n,
      minRaiseAmount: 0n,
      subscriptionCapShare: 0n,
      cycleDuration: 86_400n,
      maturityTimestamp: 100n,
      claimingStart: 110n,
      claimingEnd: 200n,
      feeParams: 0n,
    };

    await sdk.setProductParams(vault, params, noopSigner);

    expect(stateManager.calls[0]).toEqual({ fn: "setProductParams", args: [vault, params] });
  });
});

describe("HyperTesseraSDK — RWAToken compliance switches", () => {
  it("setWhitelistEnabled forwards (enabled) to the given RWAToken", async () => {
    const rwaToken = fakeContract("RWAToken");
    const sdk = makeSdk({ RWAToken: rwaToken });

    await sdk.setWhitelistEnabled(rndAddr(), true, noopSigner);

    expect(rwaToken.calls[0]).toEqual({ fn: "setWhitelistEnabled", args: [true] });
  });

  it("setTransferPathEnabled forwards (enabled) to the given RWAToken", async () => {
    const rwaToken = fakeContract("RWAToken");
    const sdk = makeSdk({ RWAToken: rwaToken });

    await sdk.setTransferPathEnabled(rndAddr(), true, noopSigner);

    expect(rwaToken.calls[0]).toEqual({ fn: "setTransferPathEnabled", args: [true] });
  });

  it("addToWhitelist / removeFromWhitelist forward the account batch", async () => {
    const rwaToken = fakeContract("RWAToken");
    const sdk = makeSdk({ RWAToken: rwaToken });
    const accounts = [rndAddr(), rndAddr()];

    await sdk.addToWhitelist(rndAddr(), accounts, noopSigner);
    await sdk.removeFromWhitelist(rndAddr(), accounts, noopSigner);

    expect(rwaToken.calls).toEqual([
      { fn: "addToWhitelist", args: [accounts] },
      { fn: "removeFromWhitelist", args: [accounts] },
    ]);
  });

  it("isWhitelisted reads through", async () => {
    const rwaToken = fakeContract("RWAToken");
    rwaToken.stubRead("isWhitelisted", true);
    const sdk = makeSdk({ RWAToken: rwaToken });

    await expect(sdk.isWhitelisted(rndAddr(), rndAddr())).resolves.toBe(true);
  });
});

describe("resolveDepositRequestState / isDepositRefundable", () => {
  function record(overrides: Partial<DepositRecord> = {}): DepositRecord {
    return {
      requestId: 1n,
      owner: rndAddr(),
      assets: 1n,
      blockNumber: 0,
      settled: false,
      claimed: false,
      cancelled: false,
      refunded: false,
      writtenDownHaircut: 0n,
      removedFromQueue: false,
      ...overrides,
    };
  }

  it.each([
    [{}, ProductState.SUBSCRIBING, DepositRequestState.PENDING],
    [{ settled: true }, ProductState.OPERATING, DepositRequestState.SETTLED],
    [{ settled: true, claimed: true }, ProductState.OPERATING, DepositRequestState.CLAIMED],
    [{ cancelled: true, removedFromQueue: true }, ProductState.SUBSCRIBING, DepositRequestState.CANCELLED],
    [{ removedFromQueue: true }, ProductState.FUNDING_FAILED, DepositRequestState.REFUNDABLE],
    [{ removedFromQueue: true, refunded: true }, ProductState.FUNDING_FAILED, DepositRequestState.REFUNDED],
  ] as const)("folds %o under product %i to state %i", (overrides, product, expected) => {
    expect(resolveDepositRequestState(record(overrides), product)).toBe(expected);
  });

  it("never infers REFUNDABLE outside FUNDING_FAILED — markRefundable() reverts there", () => {
    const rec = record({ removedFromQueue: true });

    expect(isDepositRefundable(rec, ProductState.FUNDING_FAILED)).toBe(true);
    expect(isDepositRefundable(rec, ProductState.SUBSCRIBING)).toBe(false);
    expect(isDepositRefundable(rec, ProductState.OPERATING)).toBe(false);
  });

  it("never infers REFUNDABLE for a settled request that somehow also left the queue", () => {
    expect(isDepositRefundable(record({ removedFromQueue: true, settled: true }), ProductState.FUNDING_FAILED)).toBe(false);
  });

});

describe("HyperTesseraSDK — ProtocolFeeConfig (Governor writes)", () => {
  it("setCreationFee forwards (action, kind, amount)", async () => {
    const feeConfig = fakeContract("ProtocolFeeConfig");
    const sdk = makeSdk({ ProtocolFeeConfig: feeConfig });

    await sdk.setCreationFee(CreationFeeAction.DeployVault, FeePaymentKind.Stable, 25_000_000n, noopSigner);

    expect(feeConfig.calls[0]).toEqual({
      fn: "setFee",
      args: [CreationFeeAction.DeployVault, FeePaymentKind.Stable, 25_000_000n],
    });
  });

  it("setFeePaymentToken forwards (kind, token)", async () => {
    const feeConfig = fakeContract("ProtocolFeeConfig");
    const sdk = makeSdk({ ProtocolFeeConfig: feeConfig });
    const token = rndAddr();

    await sdk.setFeePaymentToken(FeePaymentKind.Stable, token, noopSigner);

    expect(feeConfig.calls[0]).toEqual({ fn: "setPaymentToken", args: [FeePaymentKind.Stable, token] });
  });

  it("setFeeRevenuePool forwards (pool)", async () => {
    const feeConfig = fakeContract("ProtocolFeeConfig");
    const sdk = makeSdk({ ProtocolFeeConfig: feeConfig });
    const pool = rndAddr();

    await sdk.setFeeRevenuePool(pool, noopSigner);

    expect(feeConfig.calls[0]).toEqual({ fn: "setRevenuePool", args: [pool] });
  });

  it("reads round-trip through feeOf / paymentTokenOf / revenuePool", async () => {
    const feeConfig = fakeContract("ProtocolFeeConfig");
    const pool = rndAddr();
    const token = rndAddr();
    feeConfig.stubRead("feeOf", 42n);
    feeConfig.stubRead("paymentTokenOf", token);
    feeConfig.stubRead("revenuePool", pool);
    const sdk = makeSdk({ ProtocolFeeConfig: feeConfig });

    expect(await sdk.creationFeeOf(CreationFeeAction.RegisterAsset, FeePaymentKind.Stable)).toBe(42n);
    expect(await sdk.paymentTokenOf(FeePaymentKind.Stable)).toBe(token);
    expect(await sdk.feeRevenuePool()).toBe(pool);
  });
});

describe("HyperTesseraSDK — vault discovery (StateManager's on-chain vault index)", () => {
  /** A StateManager exposing `count` vaults through vaultCount/vaultAt/vaultsPaged, clamped like the contract. */
  function fakeVaultIndex(count: number) {
    const vaults = Array.from({ length: count }, rndAddr);
    const stateManager = fakeContract("StateManager");
    stateManager.stubRead("vaultCount", BigInt(count));
    stateManager.stubReadFn("vaultAt", (index: bigint) => {
      if (index >= BigInt(count)) throw new Error("IndexOutOfBounds");
      return vaults[Number(index)];
    });
    stateManager.stubReadFn("vaultsPaged", (offset: bigint, limit: bigint) =>
      vaults.slice(Number(offset), Number(offset) + Number(limit)),
    );
    return { vaults, stateManager, sdk: makeSdk({ StateManager: stateManager }) };
  }

  const readCalls = (c: ReturnType<typeof fakeContract>, fn: string) =>
    (c.calls as { fn: string; args: unknown[] }[]).filter((call) => call.fn === fn);

  it("reads the index size and a single vault by registration index", async () => {
    const { vaults, sdk } = fakeVaultIndex(3);

    expect(await sdk.vaultCount()).toBe(3n);
    expect(await sdk.vaultAtIndex(2n)).toBe(vaults[2]);
  });

  it("vaultsPaged forwards (offset, limit) and returns that window", async () => {
    const { vaults, stateManager, sdk } = fakeVaultIndex(5);

    expect(await sdk.vaultsPaged(1n, 2n)).toEqual([vaults[1], vaults[2]]);
    expect(readCalls(stateManager, "vaultsPaged")[0].args).toEqual([1n, 2n]);
  });

  it("vaultsPaged returns empty past the end rather than throwing — the contract clamps", async () => {
    const { sdk } = fakeVaultIndex(2);

    expect(await sdk.vaultsPaged(9n, 10n)).toEqual([]);
  });

  it("getAllVaults walks every page and concatenates them in registration order", async () => {
    const { vaults, stateManager, sdk } = fakeVaultIndex(5);

    expect(await sdk.getAllVaults(2)).toEqual(vaults);
    expect(readCalls(stateManager, "vaultsPaged").map((c) => c.args)).toEqual([
      [0n, 2n],
      [2n, 2n],
      [4n, 2n],
    ]);
  });

  it("getAllVaults on an empty index reads no pages at all", async () => {
    const { stateManager, sdk } = fakeVaultIndex(0);

    expect(await sdk.getAllVaults(10)).toEqual([]);
    expect(readCalls(stateManager, "vaultsPaged")).toHaveLength(0);
  });

  it("getAllVaults stays bounded by vaultCount even if every page comes back full", async () => {
    const { stateManager, sdk } = fakeVaultIndex(5);
    // A page that never runs short would spin forever on a short-page-only termination rule.
    stateManager.stubReadFn("vaultsPaged", () => [rndAddr(), rndAddr()]);

    await sdk.getAllVaults(2);

    expect(readCalls(stateManager, "vaultsPaged")).toHaveLength(3);
  });

  it("getAllVaults rejects a non-positive page size instead of looping forever", async () => {
    const { sdk } = fakeVaultIndex(5);

    await expect(sdk.getAllVaults(0)).rejects.toThrow(/page size/i);
    await expect(sdk.getAllVaults(-1)).rejects.toThrow(/page size/i);
  });

  it("vaultsWithRole zips the two returned arrays into one entry per hit", async () => {
    const { vaults, stateManager, sdk } = fakeVaultIndex(4);
    stateManager.stubReadFn("vaultsWithRole", () => [
      [vaults[1], vaults[3]],
      [1 << VaultRole.OWNER, (1 << VaultRole.CURATOR) | (1 << VaultRole.KEEPER)],
    ]);
    const account = rndAddr();

    const entries = await sdk.vaultsWithRole(account, 0n, 4n);

    expect(readCalls(stateManager, "vaultsWithRole")[0].args).toEqual([account, 0n, 4n]);
    expect(entries).toEqual([
      { vault: vaults[1], roleMask: 1 },
      { vault: vaults[3], roleMask: 0b10010 },
    ]);
    expect(hasVaultRole(entries[0].roleMask, VaultRole.OWNER)).toBe(true);
    expect(hasVaultRole(entries[0].roleMask, VaultRole.CURATOR)).toBe(false);
    expect(hasVaultRole(entries[1].roleMask, VaultRole.CURATOR)).toBe(true);
    expect(hasVaultRole(entries[1].roleMask, VaultRole.KEEPER)).toBe(true);
    expect(hasVaultRole(entries[1].roleMask, VaultRole.GUARDIAN)).toBe(false);
  });

  it("getAllVaultsWithRole pages the whole index, keeping the windows that hit nothing quiet", async () => {
    const { vaults, stateManager, sdk } = fakeVaultIndex(5);
    stateManager.stubReadFn("vaultsWithRole", (_account: string, offset: bigint) =>
      // Only the last window holds a role, so the earlier pages return two empty arrays.
      offset === 4n ? [[vaults[4]], [1 << VaultRole.GUARDIAN]] : [[], []],
    );
    const account = rndAddr();

    const entries = await sdk.getAllVaultsWithRole(account, 2);

    expect(entries).toEqual([{ vault: vaults[4], roleMask: 1 << VaultRole.GUARDIAN }]);
    expect(readCalls(stateManager, "vaultsWithRole").map((c) => c.args)).toEqual([
      [account, 0n, 2n],
      [account, 2n, 2n],
      [account, 4n, 2n],
    ]);
  });

  it("getAllVaultsWithRole rejects a non-positive page size", async () => {
    const { sdk } = fakeVaultIndex(5);

    await expect(sdk.getAllVaultsWithRole(rndAddr(), 0)).rejects.toThrow(/page size/i);
  });
});
