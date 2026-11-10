// @vitest-environment happy-dom
import { Interface, Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { getAbi, type ContractName } from "../src/abis.js";
import { HyperTesseraSDK, type HyperTesseraAddresses } from "../src/sdk.js";
import {
  BNB_TESTNET,
  connectWallet,
  decodeError,
  discoverWallets,
  ensureAllowance,
  getAllowance,
  getBalance,
  getConnectedAccounts,
  getSettlementPermissions,
  getVaultPermissions,
  isGovernor,
  onAccountsChanged,
  onChainChanged,
  parseEventLogs,
  subscribeToEvent,
  switchNetwork,
  trackTransaction,
  type Eip1193Provider,
} from "../src/web3.js";

const rndAddr = () => Wallet.createRandom().address;

// ---------------------------------------------------------------------------
// Wallet discovery & connection
// ---------------------------------------------------------------------------

describe("discoverWallets", () => {
  it("collects EIP-6963 announcements within the window", async () => {
    const provider = { request: vi.fn() } as unknown as Eip1193Provider;
    const promise = discoverWallets(20);
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "a", rdns: "com.a", name: "A", icon: "" }, provider } }),
    );
    const wallets = await promise;
    expect(wallets).toHaveLength(1);
    expect(wallets[0].info.name).toBe("A");
  });

  it("falls back to legacy window.ethereum when nothing announces", async () => {
    (globalThis as { ethereum?: unknown }).ethereum = { request: vi.fn(), isMetaMask: true };
    try {
      const wallets = await discoverWallets(20);
      expect(wallets).toHaveLength(1);
      expect(wallets[0].info.name).toBe("MetaMask");
    } finally {
      delete (globalThis as { ethereum?: unknown }).ethereum;
    }
  });
});

describe("connectWallet / getConnectedAccounts", () => {
  it("requests accounts then chainId", async () => {
    const address = rndAddr();
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x61"; // 97
      throw new Error("unexpected method " + method);
    });
    const provider = { request } as unknown as Eip1193Provider;

    const session = await connectWallet(provider);

    expect(session).toEqual({ address, chainId: 97 });
  });

  it("throws when the wallet returns no accounts", async () => {
    const provider = { request: vi.fn(async () => []) } as unknown as Eip1193Provider;
    await expect(connectWallet(provider)).rejects.toThrow("no accounts");
  });

  it("getConnectedAccounts never prompts (eth_accounts)", async () => {
    const request = vi.fn(async () => []);
    await getConnectedAccounts({ request } as unknown as Eip1193Provider);
    expect(request).toHaveBeenCalledWith({ method: "eth_accounts" });
  });
});

describe("onAccountsChanged / onChainChanged", () => {
  it("wire and unwire provider event listeners", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const provider = { request: vi.fn(), on, removeListener } as unknown as Eip1193Provider;

    const unsubAccounts = onAccountsChanged(provider, () => {});
    const unsubChain = onChainChanged(provider, () => {});
    expect(on).toHaveBeenCalledWith("accountsChanged", expect.any(Function));
    expect(on).toHaveBeenCalledWith("chainChanged", expect.any(Function));

    unsubAccounts();
    unsubChain();
    expect(removeListener).toHaveBeenCalledWith("accountsChanged", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("chainChanged", expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// Network switching
// ---------------------------------------------------------------------------

describe("switchNetwork", () => {
  it("sends wallet_switchEthereumChain with the hex chainId", async () => {
    const request = vi.fn(async () => undefined);
    await switchNetwork({ request } as unknown as Eip1193Provider, 97);
    expect(request).toHaveBeenCalledWith({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x61" }] });
  });

  it("falls back to wallet_addEthereumChain on error code 4902", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "wallet_switchEthereumChain") {
        const err = new Error("Unrecognized chain") as Error & { code: number };
        err.code = 4902;
        throw err;
      }
      return undefined;
    });

    await switchNetwork({ request } as unknown as Eip1193Provider, 97, BNB_TESTNET);

    expect(request).toHaveBeenCalledWith({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x61",
          chainName: BNB_TESTNET.chainName,
          nativeCurrency: BNB_TESTNET.nativeCurrency,
          rpcUrls: BNB_TESTNET.rpcUrls,
          blockExplorerUrls: BNB_TESTNET.blockExplorerUrls,
        },
      ],
    });
  });

  it("rethrows non-4902 errors without falling back", async () => {
    const request = vi.fn(async () => {
      throw new Error("user rejected");
    });
    await expect(switchNetwork({ request } as unknown as Eip1193Provider, 97, BNB_TESTNET)).rejects.toThrow("user rejected");
  });
});

// ---------------------------------------------------------------------------
// Transaction status tracking
// ---------------------------------------------------------------------------

describe("trackTransaction", () => {
  it("reports submitted -> pending -> confirmed and resolves with the receipt", async () => {
    const events: string[] = [];
    const receipt = { status: 1 };
    const tx = { hash: "0xabc", wait: vi.fn(async () => receipt) };

    const result = await trackTransaction(tx as never, { onStatus: (e) => events.push(e.status) });

    expect(result).toBe(receipt);
    expect(events).toEqual(["submitted", "pending", "confirmed"]);
  });

  it("reports failed and rejects when the receipt status is 0", async () => {
    const events: string[] = [];
    const tx = { hash: "0xabc", wait: vi.fn(async () => ({ status: 0 })) };

    await expect(trackTransaction(tx as never, { onStatus: (e) => events.push(e.status) })).rejects.toThrow("reverted");
    expect(events).toEqual(["submitted", "pending", "failed"]);
  });

  it("reports failed when the send itself throws", async () => {
    const events: string[] = [];
    const rejected = Promise.reject(new Error("user rejected"));

    await expect(trackTransaction(rejected, { onStatus: (e) => events.push(e.status) })).rejects.toThrow("user rejected");
    expect(events).toEqual(["failed"]);
  });
});

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

describe("parseEventLogs / subscribeToEvent", () => {
  it("decodes recognized logs and skips unrecognized ones", () => {
    const iface = new Interface(getAbi("AssetRegistry"));
    const owner = rndAddr();
    const token = rndAddr();
    const { topics, data } = iface.encodeEventLog(iface.getEvent("AssetRegistered")!, [7n, owner, token, "0x" + "11".repeat(32), 123n]);
    const contract = { interface: iface } as never;
    const receipt = { logs: [{ topics, data, index: 0 }, { topics: ["0xdead"], data: "0x", index: 1 }] } as never;

    const decoded = parseEventLogs(contract, receipt);

    expect(decoded).toHaveLength(1);
    expect(decoded[0].name).toBe("AssetRegistered");
    expect(decoded[0].args.token).toBe(token);
  });

  it("filters by eventNames when given", () => {
    const iface = new Interface(getAbi("AssetRegistry"));
    const { topics, data } = iface.encodeEventLog(iface.getEvent("AssetDeactivated")!, [1n, 999n]);
    const contract = { interface: iface } as never;
    const receipt = { logs: [{ topics, data, index: 0 }] } as never;

    expect(parseEventLogs(contract, receipt, ["AssetRegistered"])).toHaveLength(0);
    expect(parseEventLogs(contract, receipt, ["AssetDeactivated"])).toHaveLength(1);
  });

  it("subscribeToEvent wires contract.on and unsubscribe calls contract.off", () => {
    const on = vi.fn();
    const off = vi.fn();
    const contract = { on, off } as never;
    const cb = () => {};

    const unsub = subscribeToEvent(contract, "AssetRegistered", cb);
    expect(on).toHaveBeenCalledWith("AssetRegistered", cb);
    unsub();
    expect(off).toHaveBeenCalledWith("AssetRegistered", cb);
  });
});

// ---------------------------------------------------------------------------
// Error decoding
// ---------------------------------------------------------------------------

describe("decodeError", () => {
  it("decodes a custom error via the contract's interface and applies known copy", () => {
    const iface = new Interface(getAbi("EarnVault"));
    const data = iface.encodeErrorResult("NotOwner", []);
    const err = { data };
    const contract = { interface: iface } as never;

    const decoded = decodeError(err, [contract]);

    expect(decoded.name).toBe("NotOwner");
    expect(decoded.message).toMatch(/Owner/);
  });

  it("falls back to .reason when no contract recognizes the error data", () => {
    const decoded = decodeError({ reason: "execution reverted: custom message" });
    expect(decoded.name).toBe("Reverted");
    expect(decoded.message).toBe("execution reverted: custom message");
  });

  it("falls back to a generic message when nothing is decodable", () => {
    const decoded = decodeError({});
    expect(decoded.name).toBe("UnknownError");
    expect(decoded.message).toMatch(/unknown reason/);
  });
});

// ---------------------------------------------------------------------------
// Permission detection (reuses the sdk.unit.test.ts fake-contract pattern)
// ---------------------------------------------------------------------------

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

function fakeContract(abiName: ContractName, reads: Record<string, unknown>) {
  return new Proxy(
    { interface: new Interface(getAbi(abiName)) } as never,
    { get: (target: never, prop: string) => (prop in reads ? async (...args: unknown[]) => (typeof reads[prop] === "function" ? (reads[prop] as (...a: unknown[]) => unknown)(...args) : reads[prop]) : (target as never)[prop]) },
  );
}

function makeSdk(contracts: Partial<Record<ContractName, unknown>>) {
  const sdk = new HyperTesseraSDK(ADDRESSES, {} as never);
  vi.spyOn(sdk, "getContract").mockImplementation(((name: ContractName) => contracts[name]) as never);
  return sdk;
}

describe("getVaultPermissions", () => {
  it("resolves each role against the given account", async () => {
    const account = rndAddr();
    const earnVault = fakeContract("EarnVault", {
      owner: account,
      curator: rndAddr(),
      guardian: rndAddr(),
      allocator: account,
      isKeeper: true,
    });
    const sdk = makeSdk({ EarnVault: earnVault });

    const perms = await getVaultPermissions(sdk, rndAddr(), account);

    expect(perms.isOwner).toBe(true);
    expect(perms.isCurator).toBe(false);
    expect(perms.isAllocator).toBe(true);
    expect(perms.isKeeper).toBe(true);
  });
});

describe("getSettlementPermissions", () => {
  it("reads isOperator and threshold", async () => {
    const settlement = fakeContract("Settlement", { isOperator: true, threshold: 2n });
    const sdk = makeSdk({ Settlement: settlement });

    const perms = await getSettlementPermissions(sdk, rndAddr(), rndAddr());

    expect(perms).toEqual({ isOperator: true, threshold: 2n });
  });
});

describe("isGovernor", () => {
  it("reads GOVERNOR_ROLE then checks hasRole", async () => {
    const role = "0x" + "ab".repeat(32);
    const hac = fakeContract("HyperAccessControl", { GOVERNOR_ROLE: role, hasRole: true });
    const sdk = makeSdk({ HyperAccessControl: hac });

    await expect(isGovernor(sdk, rndAddr())).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Allowance helpers (real ethers Contract against a minimal fake ContractRunner)
// ---------------------------------------------------------------------------

const ERC20_TEST_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function fakeErc20Runner(opts: { allowance?: bigint; balance?: bigint } = {}) {
  const iface = new Interface(ERC20_TEST_ABI);
  const calls: string[] = [];
  return {
    provider: null,
    getAddress: async () => rndAddr(),
    call: async (tx: { data: string }) => {
      const parsed = iface.parseTransaction({ data: tx.data })!;
      calls.push(parsed.name);
      if (parsed.name === "allowance") return iface.encodeFunctionResult("allowance", [opts.allowance ?? 0n]);
      if (parsed.name === "balanceOf") return iface.encodeFunctionResult("balanceOf", [opts.balance ?? 0n]);
      throw new Error("unexpected call " + parsed.name);
    },
    sendTransaction: async () => {
      calls.push("approve");
      return { hash: "0xsent" };
    },
    resolveName: async () => null,
    calls,
  };
}

describe("getAllowance / getBalance / ensureAllowance", () => {
  it("getAllowance and getBalance read through the ERC-20 ABI", async () => {
    const runner = fakeErc20Runner({ allowance: 5n, balance: 9n });
    await expect(getAllowance(rndAddr(), rndAddr(), rndAddr(), runner as never)).resolves.toBe(5n);
    await expect(getBalance(rndAddr(), rndAddr(), runner as never)).resolves.toBe(9n);
  });

  it("ensureAllowance skips approve when the current allowance already covers the amount", async () => {
    const runner = fakeErc20Runner({ allowance: 100n });
    const result = await ensureAllowance(rndAddr(), rndAddr(), 50n, runner as never);
    expect(result).toBeNull();
    expect(runner.calls).toEqual(["allowance"]);
  });

  it("ensureAllowance sends approve when the current allowance is insufficient", async () => {
    const runner = fakeErc20Runner({ allowance: 1n });
    const result = await ensureAllowance(rndAddr(), rndAddr(), 50n, runner as never);
    expect(result).not.toBeNull();
    expect(runner.calls).toEqual(["allowance", "approve"]);
  });
});
