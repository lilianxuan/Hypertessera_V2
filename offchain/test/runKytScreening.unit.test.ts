import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  chainalysisScreener, jsonLog, parseBlockedRisk, RateLimitedRpcProvider,
  readConfig, RequestLimiter, resolveScreener, validateDeployment, RpcReadError, isRecoverableReadError,
} from "../scripts/runKytScreening.js";
import type { ScreeningContext } from "../src/kytScreeningBot.js";

const payer = "0x3333333333333333333333333333333333333333";
const gateway = "0x2222222222222222222222222222222222222222";
const vault = "0x4444444444444444444444444444444444444444";
const asset = "0x5555555555555555555555555555555555555555";
const key = `0x${"11".repeat(32)}`; // Public local-test key only.
const env = () => ({ RPC_URL: "https://rpc.invalid/credential", WSS_URL: "wss://rpc.invalid/credential",
  KYT_CHAIN_ID: "56", KYT_GATEWAY: gateway, KYT_VAULT: vault, KYT_ASSET: asset,
  KYT_ORACLE_PK: key, CHAINALYSIS_API_KEY: "fake-api-secret", KYT_RPC_RPS: "80" });
const context = (windowMs = 50_000, signal = new AbortController().signal): ScreeningContext => ({
  request: { id: 9n, payer, owner: vault, assets: 100n, expiresAt: 2_100_000_000n },
  receivedAtMs: Date.now(), deadlineMs: Date.now() + windowMs, signal,
});
const complete = (overrides: Record<string, unknown> = {}) => ({ address: payer, status: "COMPLETE", risk: "Low", ...overrides });
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const limiters: RequestLimiter[] = [];
const providers: RateLimitedRpcProvider[] = [];
function limiter(rps = 30) { const l = new RequestLimiter(rps); limiters.push(l); return l; }
function screener(fetcher: typeof fetch, rps = 30, timeoutMs = 5000) {
  return chainalysisScreener({ apiKey: "fake-api-secret", baseUrl: "https://api.chainalysis.com/api/risk/v2/entities",
    blocked: parseBlockedRisk("Severe,High"), timeoutMs, limiter: limiter(rps), fetch: fetcher, logger: () => {} });
}
afterEach(() => { for (const p of providers.splice(0)) p.destroy(); for (const l of limiters.splice(0)) l.close(); vi.useRealTimers(); });

describe("runner configuration", () => {
  it("loads rules once; changing the environment applies to the next startup", () => {
    const settings = { ...env(), KYT_BLOCK_RISK: " HIGH,Severe,high " };
    const original = readConfig(settings, []);
    settings.KYT_BLOCK_RISK = "Severe,High,Medium";
    expect([...original.blocked]).toEqual(["high", "severe"]);
    expect(readConfig(settings, []).blocked.has("medium")).toBe(true);
    expect(original.tuning.processingWindowMs - original.tuning.confirmationReserveMs).toBe(50_000);
  });
  it.each(["", "Hihg", "Severe,", "Unknown"])('rejects invalid risk configuration "%s"', rule => {
    expect(() => readConfig({ ...env(), KYT_BLOCK_RISK: rule }, [])).toThrow("KYT_INVALID_BLOCK_RISK");
  });
  it.each(["--poll", "--once", "--pk", "--impersonate", "--from-block", "--max-retries", "--retry-delay"])("rejects removed option %s", arg => {
    expect(() => readConfig(env(), [arg, "100"])).toThrow("KYT_INVALID_CLI_ARGUMENTS");
  });
  it.each([
    { KYT_RPC_RPS: undefined }, { KYT_RPC_RPS: "NaN" }, { KYT_API_RPS: "41" },
    { KYT_API_TIMEOUT_MS: "0" }, { KYT_RECEIPT_TIMEOUT_MS: "2147483648" },
    { KYT_PROCESSING_WINDOW_MS: "10000", KYT_CONFIRMATION_RESERVE_MS: "10000" },
    { KYT_SCREENER: "allow" }, { KYT_SCREENER: "denylist" }, { KYT_GATEWAY: "0x0000000000000000000000000000000000000000" },
    { RPC_URL: "http://rpc.invalid" }, { WSS_URL: "ws://rpc.invalid" },
    { CHAINALYSIS_API_URL: "https://untrusted.invalid/api/risk/v2/entities" },
  ])("rejects unsafe or incomplete configuration %#", overrides => {
    expect(() => readConfig({ ...env(), ...overrides }, [])).toThrow();
  });
  it.each(["1", "56", "97", "143", "43114"])("accepts production chain %s", chainId => {
    expect(readConfig({ ...env(), KYT_CHAIN_ID: chainId }, []).chainId).toBe(Number(chainId));
  });
  it.each(["31337", "999"])("rejects production chain %s", chainId => {
    expect(() => readConfig({ ...env(), KYT_CHAIN_ID: chainId }, [])).toThrow("KYT_PRODUCTION_CONFIGURATION_REQUIRED");
  });
  it("restricts local screeners to local endpoints and chain 31337", async () => {
    const config = readConfig({ ...env(), KYT_ENV: "local", KYT_CHAIN_ID: "31337",
      RPC_URL: "http://127.0.0.1:8545", WSS_URL: "ws://127.0.0.1:8545", KYT_SCREENER: "allow" }, []);
    expect((await resolveScreener(config, limiter())(payer, context())).passed).toBe(true);
    expect(() => readConfig({ ...env(), KYT_ENV: "local", KYT_CHAIN_ID: "31337", KYT_SCREENER: "allow" }, [])).toThrow();
  });
  it("prints help without secrets or connecting to the network", () => {
    const runner = fileURLToPath(new URL("../scripts/runKytScreening.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--import", "tsx", runner, "--help"], { encoding: "utf8" });
    expect(output).toContain("KYT_RPC_RPS");
    expect(output).not.toContain(key);
  });
  it("serializes BigInt log fields", () => {
    expect(JSON.parse(jsonLog({ id: 10n, nonce: 2 })).id).toBe("10");
  });
});

describe("Chainalysis adapter", () => {
  it("performs only GET for payer and timestamps the validated response", async () => {
    vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      vi.setSystemTime(2_000_000_002_000); return json(complete());
    });
    const result = await screener(fetcher)(payer, context());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.chainalysis.com/api/risk/v2/entities/${payer}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { Token: "fake-api-secret" } });
    expect(result).toMatchObject({ passed: true, screenedAt: 2_000_000_002 });
  });
  it("rejects a completed High risk assessment without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(complete({ risk: "High" })));
    expect((await screener(fetcher)(payer, context())).passed).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { address: vault }, { address: null }, { status: "PENDING" }, { status: "IN_PROGRESS" },
    { status: undefined }, { risk: "Unknown" }, { risk: null }, { risk: "" },
  ])("does not retry an invalid business result %#", async overrides => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(complete(overrides)));
    await expect(screener(fetcher)(payer, context())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry invalid JSON", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 }));
    await expect(screener(fetcher)(payer, context())).rejects.toThrow("KYT_API_INVALID_JSON");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 404, 406, 409])("does not retry HTTP %s", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message: "sensitive upstream details" }, status));
    await expect(screener(fetcher)(payer, context())).rejects.toThrow(`KYT_API_HTTP_${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503, 504])("allows exactly one retry for HTTP %s", async status => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({}, status));
    const checked = expect(screener(fetcher)(payer, context())).rejects.toThrow(`KYT_API_HTTP_${status}`);
    await vi.advanceTimersByTimeAsync(5000); await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("honors Retry-After as seconds and counts the second request", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      starts.push(Date.now());
      return starts.length === 1 ? json({}, 429, { "Retry-After": "2" }) : json(complete());
    });
    const result = screener(fetcher)(payer, context());
    await vi.advanceTimersByTimeAsync(1999); expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect((await result).passed).toBe(true);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2000);
  });
  it("ends instead of retrying beyond the application's deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 429, { "Retry-After": "120" }));
    await expect(screener(fetcher)(payer, context(1000))).rejects.toThrow("KYT_API_HTTP_429");
    await vi.advanceTimersByTimeAsync(2000); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("stops after a second 429 and does not retry indefinitely", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 429, { "Retry-After": "1" }));
    const checked = expect(screener(fetcher)(payer, context())).rejects.toThrow("KYT_API_HTTP_429");
    await vi.advanceTimersByTimeAsync(10_000); await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("applies an HTTP-date Retry-After to other queued requests too", async () => {
    vi.useFakeTimers(); vi.setSystemTime(2_000_000_000_000);
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      starts.push(Date.now());
      return starts.length === 1 ? json({}, 429, { "Retry-After": new Date(Date.now() + 2000).toUTCString() }) : json(complete());
    });
    const screen = screener(fetcher);
    const results = Promise.all([screen(payer, context()), screen(payer, context())]);
    await vi.advanceTimersByTimeAsync(1999); expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); await results;
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2000);
  });
  it("retries a temporary network failure only once", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network error with a secret URL"));
    const checked = expect(screener(fetcher)(payer, context())).rejects.toThrow("KYT_API_NETWORK_ERROR");
    await vi.advanceTimersByTimeAsync(1000); await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("aborts each HTTP timeout and stops after the second attempt", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const checked = expect(screener(fetcher, 30, 100)(payer, context())).rejects.toThrow("KYT_API_TIMEOUT");
    await vi.advanceTimersByTimeAsync(1000); await checked;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
  });
  it("cancels a queued expired request without making a later HTTP call", async () => {
    vi.useFakeTimers();
    const quota = limiter(1); await quota.acquire();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(complete()));
    const screen = chainalysisScreener({ apiKey: "fake", baseUrl: "https://api.chainalysis.com/api/risk/v2/entities",
      blocked: parseBlockedRisk("High"), timeoutMs: 5000, limiter: quota, fetch: fetcher, logger: () => {} });
    const checked = expect(screen(payer, context(200))).rejects.toThrow("KYT_ABORTED");
    await vi.advanceTimersByTimeAsync(200); await checked;
    await vi.advanceTimersByTimeAsync(2000); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not retry an HTTP operation after service shutdown", async () => {
    vi.useFakeTimers();
    const shutdown = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new TypeError("aborted")), { once: true });
    }));
    const screen = chainalysisScreener({ apiKey: "fake", baseUrl: "https://api.chainalysis.com/api/risk/v2/entities",
      blocked: parseBlockedRisk("High"), timeoutMs: 5000, limiter: limiter(), fetch: fetcher,
      shutdownSignal: shutdown.signal, logger: () => {} });
    const checked = expect(screen(payer, context())).rejects.toThrow("KYT_ABORTED");
    await vi.advanceTimersByTimeAsync(1); shutdown.abort(); await checked;
    await vi.advanceTimersByTimeAsync(6000); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("paces a 100-request burst within the shared 30 RPS quota", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { starts.push(Date.now()); return json(complete()); });
    const screen = screener(fetcher);
    const result = Promise.all(Array.from({ length: 100 }, () => screen(payer, context())));
    await vi.advanceTimersByTimeAsync(4000); await result;
    expect(starts).toHaveLength(100);
    for (let i = 30; i < starts.length; i++) expect(starts[i] - starts[i - 30]).toBeGreaterThanOrEqual(1000);
  });
});

describe("HTTP RPC transport", () => {
  it("limits internal network queries and explicit calls together", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      starts.push(Date.now()); const p = JSON.parse(String(init!.body));
      return json({ id: p.id, jsonrpc: "2.0", result: p.method === "eth_chainId" ? "0x38" : "0x64" });
    });
    const provider = new RateLimitedRpcProvider("https://rpc.invalid", 56, 10, 5000, fetcher); providers.push(provider);
    const responses = Promise.all(Array.from({ length: 12 }, () => provider.getBlockNumber()));
    await vi.advanceTimersByTimeAsync(3000); await responses;
    expect(starts.length).toBeGreaterThanOrEqual(13);
    for (let i = 10; i < starts.length; i++) expect(starts[i] - starts[i - 10]).toBeGreaterThanOrEqual(1000);
  });
  it.each([409, 425, 429, 502])("never retries a raw transaction rejected by HTTP %s", async status => {
    vi.useFakeTimers();
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      const p = JSON.parse(String(init!.body)); methods.push(p.method);
      return p.method === "eth_sendRawTransaction" ? json({}, status) : json({ id: p.id, jsonrpc: "2.0", result: "0x38" });
    });
    const provider = new RateLimitedRpcProvider("https://rpc.invalid", 56, 30, 2000, fetcher); providers.push(provider);
    const checked = expect(provider.send("eth_sendRawTransaction", ["0xab"])).rejects.toThrow(`KYT_RPC_HTTP_${status}`);
    await vi.advanceTimersByTimeAsync(5000); await checked;
    expect(methods.filter(m => m === "eth_sendRawTransaction")).toHaveLength(1);
  });
  it.each([401, 403, 404])("keeps HTTP %s permanent for public reads", async status => {
    const read = {method: "eth_getCode", id: 1, jsonrpc: "2.0" as const, params: [gateway, "latest"]};
    // _send is the native transport boundary; no automatic network discovery is involved.
    const transport = new RateLimitedRpcProvider("https://rpc.invalid", 56, 100, 2000,
      async (_, init) => {
        const p = JSON.parse(String(init!.body));
        return p.method === "eth_chainId" ? json({id: p.id, jsonrpc: "2.0", result: "0x38"}) : json({message: "sensitive"}, status);
      });
    providers.push(transport);
    await transport._send(read).then(() => { throw new Error("expected HTTP rejection"); }, error => {
      expect(error).not.toBeInstanceOf(RpcReadError);
      expect(isRecoverableReadError(error)).toBe(false);
    });
  });
  it.each([-32700, -32600, -32601, -32602, -32004, -32006])("keeps JSON-RPC protocol error %s permanent", async code => {
    const transport = new RateLimitedRpcProvider("https://rpc.invalid", 56, 100, 2000,
      async (_, init) => {
        const p = JSON.parse(String(init!.body));
        return p.method === "eth_chainId" ? json({id: p.id, jsonrpc: "2.0", result: "0x38"}) :
          json({id: p.id, jsonrpc: "2.0", error: {code, message: "sensitive"}});
      });
    providers.push(transport);
    await transport.send("eth_getCode", [gateway, "latest"]).then(() => { throw new Error("expected RPC rejection"); }, error => {
      expect(error).not.toBeInstanceOf(RpcReadError);
      expect(isRecoverableReadError(error)).toBe(false);
    });
  });
  it.each([-33000, -1, 3, 42])("degrades an unrecognized upstream RPC code %s on a public read", async code => {
    const transport = new RateLimitedRpcProvider("https://rpc.invalid", 56, 100, 2000,
      async (_, init) => {
        const p = JSON.parse(String(init!.body));
        return p.method === "eth_chainId" ? json({id: p.id, jsonrpc: "2.0", result: "0x38"}) :
          json({id: p.id, jsonrpc: "2.0", error: {code, message: "sensitive vendor error"}});
      });
    providers.push(transport);
    await expect(transport.send("eth_getCode", [gateway, "latest"])).rejects.toMatchObject({
      code: "KYT_RPC_UPSTREAM_ERROR", rpcMethod: "eth_getCode", details: {rpcErrorCode: code},
    });
  });
  it("classifies an upstream nonce beyond the supported integer range as a read failure", async () => {
    const transport = new RateLimitedRpcProvider("https://rpc.invalid", 56, 100, 2000,
      async (_, init) => {
        const p = JSON.parse(String(init!.body));
        return json({id: p.id, jsonrpc: "2.0", result: p.method === "eth_chainId" ? "0x38" : "0xffffffffffffffff"});
      });
    providers.push(transport);
    await expect(transport.getTransactionCount(gateway, "pending")).rejects.toMatchObject({
      code: "KYT_RPC_INVALID_RESULT", rpcMethod: "eth_getTransactionCount",
    });
  });
  it("does not hide a local request serialization bug as an upstream failure", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = new RateLimitedRpcProvider("https://rpc.invalid", 56, 100, 2000, fetcher);
    providers.push(transport);
    const params: unknown[] = []; params.push(params);
    await transport._send({id: 1, jsonrpc: "2.0", method: "eth_getCode", params}).then(
      () => { throw new Error("expected serialization error"); }, error => {
        expect(error).toBeInstanceOf(TypeError);
        expect(isRecoverableReadError(error)).toBe(false);
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not transmit queued work after provider destruction", async () => {
    vi.useFakeTimers();
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      const p = JSON.parse(String(init!.body)); methods.push(p.method);
      return json({ id: p.id, jsonrpc: "2.0", result: "0x38" });
    });
    const provider = new RateLimitedRpcProvider("https://rpc.invalid", 56, 1, 5000, fetcher); providers.push(provider);
    await vi.advanceTimersByTimeAsync(10);
    const checked = expect(provider.send("eth_sendRawTransaction", ["0xab"])).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10); provider.destroy(); await checked;
    await vi.advanceTimersByTimeAsync(6000);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("expires an RPC waiting for quota without transmitting it later", async () => {
    vi.useFakeTimers();
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
      const p = JSON.parse(String(init!.body)); methods.push(p.method);
      return json({ id: p.id, jsonrpc: "2.0", result: "0x38" });
    });
    const provider = new RateLimitedRpcProvider("https://rpc.invalid", 56, 1, 100, fetcher); providers.push(provider);
    await vi.advanceTimersByTimeAsync(10);
    const checked = expect(provider.send("eth_sendRawTransaction", ["0xab"])).rejects.toThrow("KYT_RPC_TIMEOUT");
    await vi.advanceTimersByTimeAsync(3000); await checked;
    expect(methods).not.toContain("eth_sendRawTransaction");
  });
  it("rejects a wrong chain before validating contracts", async () => {
    const config = readConfig(env(), []);
    const getCode = vi.fn();
    const provider = { getNetwork: async () => ({ chainId: 97n }), getCode };
    await expect(validateDeployment(config, provider as any, new Wallet(key))).rejects.toThrow("KYT_CHAIN_MISMATCH");
    expect(getCode).not.toHaveBeenCalled();
  });
});


describe("chain Gateway registry", () => {
  const multi = () => ({...env(), KYT_GATEWAY: undefined, KYT_VAULT: undefined, KYT_ASSET: undefined,
    KYT_GATEWAYS: JSON.stringify([{gateway, vault, asset},
      {gateway: "0x6666666666666666666666666666666666666666", vault: "0x7777777777777777777777777777777777777777", asset}])});
  it("loads multiple Gateways with one chain/key", () => {
    const config = readConfig(multi(), []);
    expect(config.gateways).toHaveLength(2); expect(config.gateway).toBe(gateway); expect(config.oracleKey).toBe(key);
  });
  it("rejects ambiguous legacy fields and overrides", () => {
    expect(() => readConfig({...multi(), KYT_GATEWAY: gateway}, [])).toThrow();
    expect(() => readConfig(multi(), ["--gateway", gateway])).toThrow();
  });
  it.each(["[]", "{}", "bad json", JSON.stringify([{gateway, vault, asset}, {gateway, vault, asset}])])(
    "rejects invalid/duplicate registry %s", registry => { expect(() => readConfig({...multi(), KYT_GATEWAYS: registry}, [])).toThrow(); });
});
