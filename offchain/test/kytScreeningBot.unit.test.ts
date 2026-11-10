import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interface, Transaction, Wallet, keccak256, type Provider, type Signer, type TransactionRequest } from "ethers";
import {
  KYT_GATEWAY_ABI, KytScreeningBot, KytReadTimeoutError, type AddressScreener, type KytAlert,
  type KytScreeningBotOptions, type ScreeningRequestEvent, type ScreeningVerdict,
} from "../src/kytScreeningBot.js";

const gateway = "0x2222222222222222222222222222222222222222";
const owner = "0x3333333333333333333333333333333333333333";
const wallet = new Wallet(`0x${"11".repeat(32)}`); // Public, test-only fixture.
const iface = new Interface(KYT_GATEWAY_ABI);
const active: KytScreeningBot[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function verdict(passed = true): ScreeningVerdict {
  return { passed, screenedAt: Math.floor(Date.now() / 1000) };
}

function request(id: number): ScreeningRequestEvent {
  return { id: BigInt(id), payer: wallet.address, owner, assets: 1000n, expiresAt: 2_100_000_000n };
}

class TestSocket extends EventTarget {
  readyState = 1;
  silent = false;
  chainResponse?: Record<string, unknown>;
  subscriptionResponse?: Record<string, unknown>;
  calls: Record<string, any>[] = [];
  send(value: string) {
    const body = JSON.parse(value);
    this.calls.push(body);
    if (this.silent) return;
    queueMicrotask(() => this.message((body.method === "eth_chainId" ? this.chainResponse : this.subscriptionResponse) ??
      { jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0x38" : "subscription-1" }));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  message(body: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(body) })); }
  event(id: number, extra = {}) {
    const r = request(id);
    const log = iface.encodeEventLog(iface.getEvent("ScreeningRequested")!, [r.id, r.payer, r.owner, r.assets, r.expiresAt]);
    this.message({ method: "eth_subscription", params: { subscription: "subscription-1", result: {
      address: gateway, ...log, ...extra,
    } } });
  }
}

async function fixture(options: Partial<KytScreeningBotOptions> = {}, start = true) {
  const sockets: TestSocket[] = [];
  const alerts: KytAlert[] = [];
  const broadcasts: { hash: string; nonce: number; id: bigint; passed: boolean; screenedAt: bigint; to: string | null }[] = [];
  let autoConfirm = true;
  let receiptStatus = 1;
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: 56n })),
    getTransactionCount: vi.fn(async () => 7),
    getBlockNumber: vi.fn(async () => 100),
    getBlock: vi.fn(async (): Promise<{ timestamp: number } | null> => ({ timestamp: Math.floor(Date.now() / 1000) })),
    getTransactionReceipt: vi.fn(async (hash: string) => autoConfirm && broadcasts.some(tx => tx.hash === hash)
      ? { hash, status: receiptStatus, blockNumber: 100 } : null),
    broadcastTransaction: vi.fn(async (raw: string) => {
      const tx = Transaction.from(raw);
      const [id, passed, screenedAt] = iface.decodeFunctionData("fulfill", tx.data);
      const hash = keccak256(raw);
      broadcasts.push({ hash, nonce: tx.nonce, id, passed, screenedAt, to: tx.to });
      return { hash };
    }),
    call: vi.fn(async () => { throw new Error("unexpected pre-read"); }),
    getLogs: vi.fn(async () => { throw new Error("unexpected scan"); }),
  };
  const signer = {
    provider: provider as unknown as Provider,
    getAddress: vi.fn(async () => wallet.address),
    populateTransaction: vi.fn(async (tx: TransactionRequest): Promise<TransactionRequest> => ({
      ...tx, chainId: 56, gasLimit: 500_000n, gasPrice: 1_000_000_000n,
    })),
    signTransaction: vi.fn(async (tx: TransactionRequest) => wallet.signTransaction(tx)),
  };
  const screener = vi.fn<AddressScreener>(async () => verdict());
  const bot = new KytScreeningBot({
    gateway, signer: signer as unknown as Signer, screener,
    createWebSocket: () => { const ws = new TestSocket(); sockets.push(ws); return ws as unknown as WebSocket; },
    onAlert: event => alerts.push(event), receiptPollMs: 5, rpcTimeoutMs: 100, receiptTimeoutMs: 200,
    ...options,
  });
  active.push(bot);
  if (start) await bot.start();
  return { bot, provider, signer, screener, sockets, alerts, broadcasts,
    setAutoConfirm: (value: boolean) => { autoConfirm = value; },
    setReceiptStatus: (value: number) => { receiptStatus = value; },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000); });
afterEach(async () => {
  const stops = active.splice(0).map(bot => bot.stop());
  await vi.advanceTimersByTimeAsync(150_000);
  await Promise.all(stops);
  vi.useRealTimers();
});

describe("KytScreeningBot event processing", () => {
  it("screens the payer and submits in screening-completion order without waiting for receipts", async () => {
    const slow = deferred<ScreeningVerdict>();
    const fast = deferred<ScreeningVerdict>();
    const screener = vi.fn<AddressScreener>((_payer, ctx) => ctx.request.id === 1n ? slow.promise : fast.promise);
    const f = await fixture({ screener });
    f.setAutoConfirm(false);
    const one = f.bot.processRequest(request(1));
    const two = f.bot.processRequest(request(2));
    fast.resolve(verdict());
    await vi.advanceTimersByTimeAsync(0);
    slow.resolve(verdict());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.broadcasts.map(tx => tx.id)).toEqual([2n, 1n]);
    expect(f.broadcasts.map(tx => tx.nonce)).toEqual([7, 8]);
    expect(screener.mock.calls.map(call => call[0])).toEqual([wallet.address, wallet.address]);
    expect(screener.mock.calls[0][1]).not.toHaveProperty("controller");
    expect(f.provider.call).not.toHaveBeenCalled();
    expect(f.provider.getLogs).not.toHaveBeenCalled();
    f.setAutoConfirm(true);
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all([one, two]);
  });

  it("accepts a 100-event burst with bounded screening concurrency and pending transactions", async () => {
    let current = 0;
    let maximum = 0;
    const screener: AddressScreener = async () => {
      current++; maximum = Math.max(maximum, current);
      await new Promise(resolve => setTimeout(resolve, 10));
      current--;
      return verdict();
    };
    const f = await fixture({ screener, screeningConcurrency: 8, maxPendingTransactions: 4 });
    f.setAutoConfirm(false);
    const work = Array.from({ length: 100 }, (_, i) => f.bot.processRequest(request(i + 1)));
    await vi.advanceTimersByTimeAsync(130);
    expect(maximum).toBe(8);
    expect(f.broadcasts).toHaveLength(4);
    f.setAutoConfirm(true);
    await vi.advanceTimersByTimeAsync(150);
    await Promise.all(work);
    expect(f.broadcasts).toHaveLength(100);
    expect(f.broadcasts.map(tx => tx.nonce)).toEqual(Array.from({ length: 100 }, (_, i) => i + 7));
    expect(f.alerts.filter(event => event.type === "executed")).toHaveLength(100);
  });

  it("deduplicates the same live Gateway request", async () => {
    const f = await fixture();
    const work = [f.bot.processRequest(request(1)), f.bot.processRequest(request(1))];
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(work);
    expect(f.screener).toHaveBeenCalledTimes(1);
    expect(f.broadcasts).toHaveLength(1);
  });

  it("submits negative verdicts and reports the on-chain rejection", async () => {
    const f = await fixture({ screener: async () => verdict(false) });
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(5);
    await done;
    expect(f.broadcasts[0].passed).toBe(false);
    expect(f.alerts.some(event => event.type === "screening-rejected")).toBe(true);
  });

  it("drops a screening error without retrying or submitting", async () => {
    const screener = vi.fn<AddressScreener>(async () => { throw new Error("https://secret-url.example/token"); });
    const f = await fixture({ screener });
    await f.bot.processRequest(request(1));
    expect(screener).toHaveBeenCalledTimes(1);
    expect(f.broadcasts).toHaveLength(0);
    expect(f.alerts.find(event => event.type === "screening-error")?.message).not.toContain("secret-url");
  });

  it("rejects a malformed or future-dated verdict before submission", async () => {
    const f = await fixture({ screener: async () => ({ passed: true, screenedAt: Math.floor(Date.now() / 1000) + 100 }) });
    await f.bot.processRequest(request(1));
    expect(f.broadcasts).toHaveLength(0);
  });

  it("includes queue time in the deadline and ignores a late API result", async () => {
    const delayed = deferred<ScreeningVerdict>();
    const screener = vi.fn<AddressScreener>(() => delayed.promise);
    const f = await fixture({ screener, screeningConcurrency: 1, processingWindowMs: 100, confirmationReserveMs: 20 });
    const work = [f.bot.processRequest(request(1)), f.bot.processRequest(request(2))];
    await vi.advanceTimersByTimeAsync(80);
    await Promise.all(work);
    delayed.resolve(verdict());
    await vi.advanceTimersByTimeAsync(0);
    expect(screener).toHaveBeenCalledTimes(1);
    expect(screener.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.broadcasts).toHaveLength(0);
    expect(f.alerts.filter(event => event.type === "processing-timeout")).toHaveLength(2);
  });

  it("cannot broadcast a signature that arrives after the deadline", async () => {
    const f = await fixture({ processingWindowMs: 100, confirmationReserveMs: 20 });
    const signed = deferred<string>();
    f.signer.signTransaction.mockImplementation(() => signed.promise);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(80);
    await done;
    signed.resolve("0xdead");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.broadcasts).toHaveLength(0);
  });

  it("does not consume a nonce on transaction preparation failure and prepares it again", async () => {
    const f = await fixture();
    f.signer.populateTransaction.mockRejectedValueOnce(new Error("gas estimation reverted"));
    const work = [f.bot.processRequest(request(1)), f.bot.processRequest(request(2))];
    await vi.advanceTimersByTimeAsync(10);
    expect(f.broadcasts.map(tx => [tx.id, tx.nonce])).toEqual([[2n, 7]]);
    expect(f.alerts.filter(event => event.type === "submit-retry").map(event => event.id)).toEqual([1n]);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(work);
    expect(f.broadcasts.map(tx => [tx.id, tx.nonce])).toEqual([[2n, 7], [1n, 8]]);
    expect(f.alerts.some(event => event.type === "submit-error")).toBe(false);
  });

  it("dates the verdict no later than the newest block the RPC node has", async () => {
    // BNB: the request block is stamped second S, the verdict lands in S+1 before a block
    // stamped S+1 reaches the node, and fulfill(screenedAt = S+1) reverts InvalidScreeningTime.
    const f = await fixture();
    const now = Math.floor(Date.now() / 1000);
    f.provider.getBlock.mockResolvedValue({ timestamp: now - 1 });
    await Promise.all([f.bot.processRequest(request(1)), vi.advanceTimersByTimeAsync(10)]);
    expect(f.broadcasts.map(tx => tx.screenedAt)).toEqual([BigInt(now - 1)]);
    f.provider.getBlock.mockResolvedValue({ timestamp: now + 5 });
    await Promise.all([f.bot.processRequest(request(2)), vi.advanceTimersByTimeAsync(10)]);
    expect(f.broadcasts[1].screenedAt).toBe(BigInt(now));
    expect(f.provider.getBlock).toHaveBeenCalledWith("latest");
  });

  it("prepares again with backoff and reports one submit-error when the deadline arrives", async () => {
    const f = await fixture({ processingWindowMs: 5_000, confirmationReserveMs: 1_000 });
    f.signer.populateTransaction.mockRejectedValue(Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" }));
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    // Attempts at 0, 1 s and 3 s; the next (+4 s) would pass the 4 s deadline.
    expect(f.signer.populateTransaction).toHaveBeenCalledTimes(3);
    expect(f.alerts.filter(event => event.type === "submit-retry")).toHaveLength(2);
    const terminal = f.alerts.filter(event => ["submit-error", "processing-timeout"].includes(event.type));
    expect(terminal.map(event => [event.type, event.message]))
      .toEqual([["submit-error", "Error (CALL_EXCEPTION); 3 preparation attempts failed before the deadline"]]);
    expect(f.broadcasts).toHaveLength(0);
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
  });

  it("does not retry a signing-policy refusal", async () => {
    const f = await fixture({ maxTransactionFeeWei: 1n });
    await Promise.all([f.bot.processRequest(request(1)), vi.advanceTimersByTimeAsync(5_000)]);
    expect(f.signer.populateTransaction).toHaveBeenCalledTimes(1);
    expect(f.alerts.filter(event => event.type === "submit-error")).toHaveLength(1);
    expect(f.alerts.some(event => event.type === "submit-retry")).toBe(false);
    expect(f.broadcasts).toHaveLength(0);
  });

  it("treats a failed head read like any other preparation failure", async () => {
    const f = await fixture();
    f.provider.getBlock.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce(null);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(3_100);
    await done;
    expect(f.alerts.filter(event => event.type === "submit-retry")).toHaveLength(2);
    expect(f.broadcasts.map(tx => [tx.id, tx.nonce])).toEqual([[1n, 7]]);
  });

  it("consumes the nonce of a mined revert without retrying fulfill", async () => {
    const f = await fixture();
    f.setReceiptStatus(0);
    const one = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(5);
    await one;
    f.setReceiptStatus(1);
    const two = f.bot.processRequest(request(2));
    await vi.advanceTimersByTimeAsync(5);
    await two;
    expect(f.broadcasts.map(tx => tx.nonce)).toEqual([7, 8]);
    expect(f.alerts.some(event => event.type === "execution-reverted")).toBe(true);
  });

  it("pauses on an ambiguous broadcast but tracks the known hash without resubmitting", async () => {
    const f = await fixture();
    const normal = f.provider.broadcastTransaction.getMockImplementation()!;
    f.provider.broadcastTransaction.mockImplementationOnce(async raw => {
      await normal(raw);
      throw new Error("response lost after acceptance");
    });
    const work = [f.bot.processRequest(request(1)), f.bot.processRequest(request(2))];
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all(work);
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(f.alerts.find(event => event.type === "submission-uncertain")?.txHash).toBe(f.broadcasts[0].hash);
    expect(f.alerts.some(event => event.type === "executed")).toBe(true);
    await f.bot.processRequest(request(3));
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not block later sends on a temporary receipt query failure", async () => {
    const f = await fixture();
    f.provider.getTransactionReceipt.mockRejectedValueOnce(new Error("network"));
    const work = [f.bot.processRequest(request(1)), f.bot.processRequest(request(2))];
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(work);
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(2);
    expect(f.alerts.filter(event => event.type === "executed")).toHaveLength(2);
  });

  it("pauses at the confirmation target and finishes bounded receipt tracking", async () => {
    const f = await fixture({ processingWindowMs: 100, confirmationReserveMs: 20, receiptTimeoutMs: 150 });
    f.setAutoConfirm(false);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.alerts.some(event => event.type === "submission-uncertain")).toBe(true);
    await f.bot.processRequest(request(2));
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55);
    await done;
  });

  it("requires the configured number of confirmations", async () => {
    const f = await fixture({ confirmations: 2 });
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(5);
    expect(f.alerts.some(event => event.type === "executed")).toBe(false);
    f.provider.getBlockNumber.mockResolvedValue(101);
    await vi.advanceTimersByTimeAsync(5);
    await done;
    expect(f.alerts.some(event => event.type === "executed")).toBe(true);
  });

  it("stops unsigned work and can start again without old signatures being broadcast", async () => {
    const f = await fixture();
    const signed = deferred<string>();
    f.signer.signTransaction.mockImplementationOnce(() => signed.promise);
    const old = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(0);
    await f.bot.stop();
    await old;
    await f.bot.start();
    const current = f.bot.processRequest(request(2));
    signed.resolve("0xdead");
    await vi.advanceTimersByTimeAsync(10);
    await current;
    expect(f.broadcasts.map(tx => tx.id)).toEqual([2n]);
    expect(f.broadcasts[0].nonce).toBe(7);
  });

  it("waits for interrupted startup before permitting a fresh start", async () => {
    const f = await fixture({}, false);
    const count = deferred<number>();
    f.provider.getTransactionCount.mockImplementationOnce(() => count.promise);
    const startup = f.bot.start();
    const rejected = expect(startup).rejects.toThrow("startup was stopped");
    await vi.advanceTimersByTimeAsync(0);
    const stop = f.bot.stop();
    await expect(f.bot.start()).rejects.toThrow("bot is stopping");
    count.resolve(7);
    await rejected;
    await stop;
    expect(f.sockets).toHaveLength(0);
    await f.bot.start();
    expect(f.sockets).toHaveLength(1);
  });

  it.each([
    ["getNetwork", "eth_chainId"], ["getTransactionCount", "eth_getTransactionCount"],
  ] as const)("retains public-read provenance when startup %s exceeds the outer deadline", async (method, rpcMethod) => {
    const f = await fixture({}, false);
    f.provider[method].mockImplementationOnce(() => new Promise<never>(() => {}));
    const startup = f.bot.start();
    const rejected = expect(startup).rejects.toMatchObject({name: "KytReadTimeoutError", code: "TIMEOUT", rpcMethod});
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.bot.health()).toMatchObject({ready: false});
    expect(f.sockets).toHaveLength(0);
    await f.bot.start();
    expect(f.bot.health()).toMatchObject({ready: true});
  });

  it("keeps a local signer timeout fatal instead of classifying it as an RPC read", async () => {
    const f = await fixture({}, false);
    f.signer.getAddress.mockImplementationOnce(() => new Promise<never>(() => {}));
    const startup = f.bot.start();
    const observed = startup.catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await observed;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(KytReadTimeoutError);
    expect(error.code).toBeUndefined();
    expect(f.sockets).toHaveLength(0);
  });

  it.each(["getNetwork", "getTransactionCount"] as const)("preserves the original rejection from startup %s", async method => {
    const f = await fixture({}, false);
    const failure = new Error("unexpected programming error");
    f.provider[method].mockRejectedValueOnce(failure);
    await expect(f.bot.start()).rejects.toBe(failure);
    expect(f.sockets).toHaveLength(0);
  });

  it("subscribes to the exact topic, ignores removed logs and reconnects without backfill", async () => {
    const f = await fixture();
    expect(f.sockets[0].calls.find(call => call.method === "eth_subscribe")).toMatchObject({ method: "eth_subscribe", params: ["logs", {
      address: gateway, topics: [iface.getEvent("ScreeningRequested")!.topicHash],
    }] });
    f.sockets[0].event(1, { removed: true });
    f.sockets[0].event(2, { address: owner });
    expect(f.screener).not.toHaveBeenCalled();
    const old = f.sockets[0];
    old.close();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sockets).toHaveLength(2);
    old.event(3);
    f.sockets[1].event(4);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.screener).toHaveBeenCalledTimes(1);
    expect(f.broadcasts.map(tx => tx.id)).toEqual([4n]);
    expect(f.provider.getLogs).not.toHaveBeenCalled();
  });

  it("does not let a failing log callback cause extra transactions", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ onAlert: () => { throw new Error("logging down"); } });
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(5);
    await done;
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("does not accept requests before startup has loaded the nonce and subscribed", async () => {
    const f = await fixture({}, false);
    const count = deferred<number>();
    f.provider.getTransactionCount.mockImplementationOnce(() => count.promise);
    const startup = f.bot.start();
    const observed = startup.catch(() => {});
    const early = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(f.screener).not.toHaveBeenCalled();
    count.resolve(7);
    await startup;
    await observed;
    await early;
    const done = f.bot.processRequest(request(2));
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(f.broadcasts.map(tx => [tx.id, tx.nonce])).toEqual([[2n, 7]]);
  });

  it("reuses a freed pending slot without waiting for a different stalled receipt query", async () => {
    const f = await fixture({ maxPendingTransactions: 2 });
    const stalled = deferred<never>();
    const normal = f.provider.getTransactionReceipt.getMockImplementation()!;
    f.provider.getTransactionReceipt.mockImplementation(hash =>
      hash === f.broadcasts[0]?.hash ? stalled.promise : normal(hash));
    const work = [1, 2, 3].map(id => f.bot.processRequest(request(id)));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.broadcasts.map(tx => tx.id)).toEqual([1n, 2n, 3n]);
    f.provider.getTransactionReceipt.mockImplementation(normal);
    stalled.resolve(undefined as never);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(work);
  });

  it("detects a silent WebSocket connection and reconnects without a close notification", async () => {
    const f = await fixture();
    f.sockets[0].silent = true;
    await vi.advanceTimersByTimeAsync(15_000 + 100 + 5_000);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[0].readyState).toBe(3);
    expect(f.provider.getLogs).not.toHaveBeenCalled();
  });

  it("rejects a timer value that would overflow Node timers", async () => {
    await expect(fixture({ processingWindowMs: 2 ** 31 }, false)).rejects.toThrow();
  });

  it("emits submitted only after handing the signed transaction to the provider", async () => {
    let countAtAlert: number | undefined;
    let stopped: Promise<void> | undefined;
    const f = await fixture({ onAlert: event => {
      if (event.type === "submitted") {
        countAtAlert = f.provider.broadcastTransaction.mock.calls.length;
        stopped = f.bot.stop();
      }
    } });
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(10);
    await done;
    await stopped;
    expect(countAtAlert).toBe(1);
  });

  it("rejects different HTTP and WebSocket chains before accepting events", async () => {
    const f = await fixture({}, false);
    f.provider.getNetwork.mockResolvedValue({ chainId: 1n });
    await expect(f.bot.start()).rejects.toMatchObject({ code: "KYT_CHAIN_MISMATCH" });
    await f.bot.processRequest(request(1));
    expect(f.screener).not.toHaveBeenCalled();
    expect(f.sockets[0].calls.some(call => call.method === "eth_subscribe")).toBe(false);
    expect(f.alerts.some(event => event.message.includes("same chain"))).toBe(true);
  });

  it.each([
    { error: { code: -32603, message: "sensitive upstream failure" } },
    { error: { code: -32002, message: "resource temporarily unavailable" } },
    { error: { code: -32005, message: "rate limited" } },
    { result: null }, { result: false }, { result: "not-a-chain" }, { result: "0x00" },
    { result: "0x38", error: { code: -32603, message: "contradictory envelope" } },
    { jsonrpc: "1.0", result: "0x38" },
  ])("keeps an unavailable or malformed WSS chain response recoverable %#", async response => {
    const sockets: TestSocket[] = [];
    const f = await fixture({ createWebSocket: () => {
      const socket = new TestSocket();
      if (!sockets.length) socket.chainResponse = { jsonrpc: "2.0", id: 2, ...response };
      sockets.push(socket); return socket as unknown as WebSocket;
    } }, false);
    await expect(f.bot.start()).rejects.toMatchObject({ code: "KYT_WSS_READ_ERROR" });
    await f.bot.processRequest(request(1));
    expect(f.bot.health()).toMatchObject({ ready: false });
    expect(sockets[0].calls.some(call => call.method === "eth_subscribe")).toBe(false);
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.broadcasts).toHaveLength(0);
    expect(f.alerts.some(event => event.message.includes("same chain"))).toBe(false);
    expect(JSON.stringify(f.alerts)).not.toContain("sensitive upstream failure");
    await f.bot.start();
    expect(f.bot.health()).toMatchObject({ ready: true });
    expect(sockets).toHaveLength(2);
  });

  it.each([-32700, -32600, -32601, -32602, -32004, -32006])(
    "keeps proven WSS protocol incompatibility %s fatal", async code => {
      const socket = new TestSocket();
      socket.chainResponse = { jsonrpc: "2.0", id: 2, error: { code, message: "incompatible RPC" } };
      const f = await fixture({ createWebSocket: () => socket as unknown as WebSocket }, false);
      await expect(f.bot.start()).rejects.toMatchObject({ code: "KYT_WSS_PROTOCOL_ERROR" });
      expect(socket.calls.some(call => call.method === "eth_subscribe")).toBe(false);
      expect(f.broadcasts).toHaveLength(0);
    });

  it("allows a temporary WSS subscription error to recover on a fresh connection", async () => {
    const sockets: TestSocket[] = [];
    const f = await fixture({ createWebSocket: () => {
      const socket = new TestSocket();
      if (!sockets.length) socket.subscriptionResponse = {
        jsonrpc: "2.0", id: 1, error: { code: -32603, message: "temporary subscription failure" },
      };
      sockets.push(socket); return socket as unknown as WebSocket;
    } }, false);
    await expect(f.bot.start()).rejects.toMatchObject({ code: "KYT_WSS_READ_ERROR" });
    expect(f.bot.health()).toMatchObject({ ready: false });
    expect(f.broadcasts).toHaveLength(0);
    await f.bot.start();
    expect(f.bot.health()).toMatchObject({ ready: true });
    expect(sockets).toHaveLength(2);
  });

  it("keeps a healthy idle connection and cleans heartbeat timers on stop", async () => {
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0].calls.filter(call => call.method === "eth_chainId")).toHaveLength(3);
    await f.bot.stop();
    const count = f.sockets[0].calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets[0].calls).toHaveLength(count);
    expect(f.sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses on broadcast timeout without sending the next nonce", async () => {
    const f = await fixture();
    f.provider.broadcastTransaction.mockImplementation(() => new Promise(() => {}));
    const work = [f.bot.processRequest(request(1)), f.bot.processRequest(request(2))];
    await vi.advanceTimersByTimeAsync(100);
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(f.alerts.some(event => event.type === "submission-uncertain" && event.txHash)).toBe(true);
    await vi.advanceTimersByTimeAsync(110);
    await Promise.all(work);
    expect(f.provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });
});


describe("shared chain oracle", () => {
  const other = "0x4444444444444444444444444444444444444444";
  const third = "0x5555555555555555555555555555555555555555";
  it("routes identical IDs from three Gateways through one nonce stream", async () => {
    const f = await fixture({ gateways: [gateway, other, third] });
    const work = [gateway, other, third].map(g => f.bot.processRequest({ ...request(1), gateway: g }));
    await vi.advanceTimersByTimeAsync(20); await Promise.all(work);
    expect(f.broadcasts.map(t => [t.to, t.id, t.nonce])).toEqual([[gateway, 1n, 7], [other, 1n, 8], [third, 1n, 9]]);
    expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(1);
    expect(f.alerts.filter(a => a.type === "executed").map(a => a.gateway)).toEqual([gateway, other, third]);
  });
  it("rejects missing or unregistered origin without signing", async () => {
    const f = await fixture({ gateways: [gateway, other] });
    await f.bot.processRequest(request(1)); await f.bot.processRequest({ ...request(2), gateway: third });
    expect(f.broadcasts).toHaveLength(0); expect(f.screener).not.toHaveBeenCalled();
  });
  it("does not sign when the chain deadline leaves no confirmation reserve", async () => {
    const f = await fixture();
    await f.bot.processRequest({ ...request(1), expiresAt: BigInt(Date.now() / 1000 + 5) });
    expect(f.screener).not.toHaveBeenCalled();
    expect(f.alerts.some(a => a.type === "processing-timeout")).toBe(true);
  });
  it("a hot Gateway cannot occupy every pending slot", async () => {
    const f = await fixture({ gateways: [gateway, other], maxPendingTransactions: 4 });
    f.setAutoConfirm(false);
    const work = [1, 2, 3, 4].map(id => f.bot.processRequest({ ...request(id), gateway }));
    work.push(f.bot.processRequest({ ...request(1), gateway: other }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.broadcasts.map(t => t.to)).toEqual([gateway, gateway, other]);
    f.setAutoConfirm(true); await vi.advanceTimersByTimeAsync(30); await Promise.all(work);
    expect(f.broadcasts.map(t => t.nonce)).toEqual([7, 8, 9, 10, 11]);
  });
  it("uses a WSS address array and routes the emitting Gateway", async () => {
    const f = await fixture({ gateways: [gateway, other] });
    expect(f.sockets[0].calls.find(c => c.method === "eth_subscribe")!.params[1].address).toEqual([gateway, other]);
    f.sockets[0].event(1, { address: other }); await vi.advanceTimersByTimeAsync(20);
    expect(f.broadcasts[0].to).toBe(other);
  });
  it("rejects a transaction prepared for another chain", async () => {
    const f = await fixture();
    f.signer.populateTransaction.mockImplementation(async tx => ({...tx, chainId: 143, gasLimit: 500000n, gasPrice: 1n}));
    await f.bot.processRequest(request(1));
    expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.broadcasts).toHaveLength(0);
  });
});


it("does not sign or consume a nonce above the configured transaction fee budget", async () => {
  const f = await fixture({maxTransactionFeeWei: 1n});
  await f.bot.processRequest(request(1));
  expect(f.signer.signTransaction).not.toHaveBeenCalled();
  expect(f.broadcasts).toHaveLength(0);
});


it("isolates a disabled Gateway while another uses the shared sender", async () => {
  const other = "0x4444444444444444444444444444444444444444";
  const f = await fixture({gateways: [gateway, other]});
  f.bot.disableGateway(gateway);
  await f.bot.processRequest({...request(1), gateway});
  const work = f.bot.processRequest({...request(1), gateway: other});
  await vi.advanceTimersByTimeAsync(20); await work;
  expect(f.broadcasts.map(t => [t.to, t.nonce])).toEqual([[other, 7]]);
  expect(f.bot.health()).toMatchObject({ready: false, disabledGateways: [gateway]});
});

describe("recoverable configuration-read degradation", () => {
  it("retains a verdict that completes while configuration reads are degraded", async () => {
    const screened = deferred<ScreeningVerdict>();
    const f = await fixture({screener: () => screened.promise});
    const done = f.bot.processRequest(request(1));
    f.bot.setConfigurationHealthy(false);
    screened.resolve(verdict());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bot.health()).toMatchObject({ready: false, queued: 1});
    expect(f.signer.populateTransaction).not.toHaveBeenCalled();
    f.bot.setConfigurationHealthy(true);
    await vi.advanceTimersByTimeAsync(20); await done;
    expect(f.broadcasts.map(tx => tx.nonce)).toEqual([7]);
  });

  it("retains live WSS requests without screening until configuration is validated again", async () => {
    const f = await fixture();
    f.bot.setConfigurationHealthy(false);
    f.sockets[0].event(1);
    f.sockets[0].event(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bot.health()).toMatchObject({ready: false, configurationHealthy: false, queued: 1});
    expect(f.screener).not.toHaveBeenCalled();
    expect(f.broadcasts).toHaveLength(0);
    f.bot.setConfigurationHealthy(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.broadcasts.map(tx => [tx.id, tx.nonce])).toEqual([[1n, 7]]);
    expect(f.bot.health()).toMatchObject({ready: true, queued: 0});
  });

  it("does not sign after an in-flight prepare completes during degradation", async () => {
    const prepared = deferred<TransactionRequest>();
    const f = await fixture();
    f.signer.populateTransaction.mockImplementationOnce(() => prepared.promise);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(0);
    const tx = f.signer.populateTransaction.mock.calls[0][0];
    f.bot.setConfigurationHealthy(false);
    prepared.resolve({...tx, gasLimit: 500000n, gasPrice: 1n});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.bot.health()).toMatchObject({queued: 1, nextNonce: 7});
    f.bot.setConfigurationHealthy(true);
    await vi.advanceTimersByTimeAsync(20); await done;
    expect(f.broadcasts.map(tx => tx.nonce)).toEqual([7]);
  });

  it("discards an unbroadcast signature and rebuilds it only after recovery", async () => {
    const signed = deferred<string>();
    const f = await fixture();
    f.signer.signTransaction.mockImplementationOnce(() => signed.promise);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(0);
    f.bot.setConfigurationHealthy(false);
    signed.resolve(await wallet.signTransaction(f.signer.signTransaction.mock.calls[0][0]));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.broadcasts).toHaveLength(0);
    expect(f.bot.health()).toMatchObject({queued: 1, nextNonce: 7});
    f.bot.setConfigurationHealthy(true);
    await vi.advanceTimersByTimeAsync(20); await done;
    expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
    expect(f.broadcasts.map(tx => tx.nonce)).toEqual([7]);
  });

  it("keeps tracking broadcasts while degraded and does not resend them", async () => {
    const f = await fixture(); f.setAutoConfirm(false);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(0);
    f.bot.setConfigurationHealthy(false);
    f.setAutoConfirm(true);
    await vi.advanceTimersByTimeAsync(10); await done;
    expect(f.alerts.some(a => a.type === "executed")).toBe(true);
    expect(f.bot.health()).toMatchObject({ready: false, pending: 0, nextNonce: 8});
    f.bot.setConfigurationHealthy(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.broadcasts).toHaveLength(1);
  });

  it("expires queued work during prolonged degradation without a late broadcast", async () => {
    const f = await fixture({processingWindowMs: 1000, confirmationReserveMs: 100});
    f.bot.setConfigurationHealthy(false);
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(1000); await done;
    expect(f.bot.health()).toMatchObject({queued: 0, ready: false});
    f.bot.setConfigurationHealthy(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.screener).not.toHaveBeenCalled();
    expect(f.broadcasts).toHaveLength(0);
    expect(f.alerts.some(a => a.type === "processing-timeout")).toBe(true);
    expect(f.bot.health()).toMatchObject({queued: 0});
  });

  it("cannot clear a broadcast-uncertain pause by recovering configuration reads", async () => {
    const f = await fixture(); f.setAutoConfirm(false);
    f.provider.broadcastTransaction.mockRejectedValueOnce(new Error("uncertain"));
    const done = f.bot.processRequest(request(1));
    await vi.advanceTimersByTimeAsync(0);
    f.bot.setConfigurationHealthy(false); f.bot.setConfigurationHealthy(true);
    await f.bot.processRequest(request(2));
    expect(f.bot.health()).toMatchObject({ready: false});
    expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.alerts.some(a => a.type === "submission-uncertain")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); await done;
  });
});
