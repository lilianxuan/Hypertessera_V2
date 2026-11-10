/**
 * PR45 KYT runner. Node.js 24+, one process / one exclusive oracle account per chain; one or more Gateways.
 * Run: node --env-file=/protected/kyt.env --import tsx scripts/runKytScreening.ts
 * See --help. Configuration is read once; changes require a graceful restart.
 * No historical scan, database or fulfill retry; live deduplication uses Gateway + request ID.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  Contract, JsonRpcApiProvider, Wallet, getAddress, ZeroAddress,
  type Provider, type JsonRpcPayload, type JsonRpcResult, type JsonRpcError,
} from "ethers";
import {
  KytScreeningBot, KytReadTimeoutError, type AddressScreener, type KytScreeningBotOptions,
  type ScreeningContext,
} from "../src/kytScreeningBot.js";

const MAX_TIMER = 2_147_483_647;
const API_URL = "https://api.chainalysis.com/api/risk/v2/entities";
const RISKS = ["low", "medium", "high", "severe"] as const;
/** BSC mainnet, BSC testnet, Monad mainnet. */
const PRODUCTION_CHAIN_IDS = [1, 56, 97, 143, 43114];
type Risk = typeof RISKS[number];
type Fetch = typeof fetch;
export type Logger = (entry: Record<string, unknown>) => void;

export class RunnerError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RunnerError"; }
}
const PUBLIC_READ_METHODS = ["eth_chainId", "eth_getCode", "eth_call", "eth_getTransactionCount"] as const;
type PublicReadMethod = typeof PUBLIC_READ_METHODS[number];
/** Created only where a known public read receives an invalid/unavailable upstream response. */
export class RpcReadError extends RunnerError {
  constructor(code: string, readonly rpcMethod: PublicReadMethod,
    readonly details: {httpStatus?: number; rpcErrorCode?: number} = {}) {
    super(code); this.name = "RpcReadError";
  }
}
function readDiagnostics(error: unknown): Record<string, unknown> {
  if (error instanceof RpcReadError) return {rpcMethod: error.rpcMethod, ...error.details};
  return error instanceof KytReadTimeoutError ? {rpcMethod: error.rpcMethod} : {};
}
function fail(code: string): never { throw new RunnerError(code); }
function codeOf(error: unknown): string {
  if (error instanceof RunnerError) return error.code;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "KYT_UNEXPECTED_ERROR";
}
export function jsonLog(entry: Record<string, unknown>): string {
  return JSON.stringify({ time: new Date().toISOString(), ...entry },
    (_, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}
const stdoutLogger: Logger = entry => { process.stdout.write(`${jsonLog(entry)}\n`); };
function logSafely(logger: Logger, entry: Record<string, unknown>): void {
  try { logger(entry); } catch { process.stderr.write("KYT_LOG_WRITE_FAILED\n"); }
}

/** A cancellable, paced FIFO. Permits are released over time, never in a burst. */
export class RequestLimiter {
  private queue: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private nextAt = 0;
  private cooldownUntil = 0;
  private closed = false;
  private readonly interval: number;
  constructor(rps: number) {
    if (!Number.isSafeInteger(rps) || rps <= 0) fail("KYT_INVALID_RPS");
    this.interval = Math.ceil(1000 / rps);
  }
  acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.reject(new RunnerError("KYT_ABORTED"));
    return new Promise((resolvePermit, reject) => {
      const item = { resolve: resolvePermit, reject, signal, abort: () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener("abort", item.abort);
        reject(new RunnerError("KYT_ABORTED"));
        this.pump();
      } };
      this.queue.push(item);
      signal?.addEventListener("abort", item.abort, { once: true });
      this.pump();
    });
  }
  coolDown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.max(0, ms));
    this.pump();
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const item of this.queue.splice(0)) {
      item.signal?.removeEventListener("abort", item.abort);
      item.reject(new RunnerError("KYT_ABORTED"));
    }
  }
  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.queue.length) return;
    const wait = Math.max(this.nextAt, this.cooldownUntil) - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => this.pump(), Math.min(wait, MAX_TIMER));
      return;
    }
    const item = this.queue.shift()!;
    item.signal?.removeEventListener("abort", item.abort);
    this.nextAt = Date.now() + this.interval;
    item.resolve();
    if (this.queue.length) this.pump();
  }
}

/** Explicit timers are disposed in finally, including after successful HTTP responses. */
function deadlineSignal(deadlineMs: number, parents: AbortSignal[] = []) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const parent of parents) parent.addEventListener("abort", abort, { once: true });
  const remaining = deadlineMs - Date.now();
  const timer = setTimeout(abort, Math.max(0, Math.min(remaining, MAX_TIMER)));
  if (remaining <= 0 || parents.some(parent => parent.aborted)) abort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener("abort", abort);
    },
  };
}
function ensureActive(signal: AbortSignal, deadlineMs: number): void {
  if (signal.aborted || Date.now() >= deadlineMs) fail("KYT_ABORTED");
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new RunnerError("KYT_ABORTED"));
  return new Promise((resolveSleep, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new RunnerError("KYT_ABORTED")); };
    const timer = setTimeout(() => { cleanup(); resolveSleep(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function retryAfterMs(value: string | null): number {
  if (!value) return 1000;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, MAX_TIMER)) : 1000;
}

export function parseBlockedRisk(value: string): ReadonlySet<Risk> {
  const values = value.split(",").map(part => part.trim().toLowerCase());
  if (!values.length || values.some(item => !RISKS.includes(item as Risk))) fail("KYT_INVALID_BLOCK_RISK");
  return new Set(values as Risk[]);
}
function normalizedAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[\da-f]{40}$/i.test(value)) fail("KYT_INVALID_ADDRESS");
  return getAddress(value.toLowerCase());
}

export interface ChainalysisOptions {
  apiKey: string;
  baseUrl: string;
  blocked: ReadonlySet<Risk>;
  timeoutMs: number;
  limiter: RequestLimiter;
  shutdownSignal?: AbortSignal;
  fetch?: Fetch;
  logger?: Logger;
}

export function chainalysisScreener(options: ChainalysisOptions): AddressScreener {
  const fetcher = options.fetch ?? fetch;
  const logger = options.logger ?? stdoutLogger;
  return async (payer, context) => {
    const lifetime = deadlineSignal(context.deadlineMs,
      [context.signal, ...(options.shutdownSignal ? [options.shutdownSignal] : [])]);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        ensureActive(lifetime.signal, context.deadlineMs);
        await options.limiter.acquire(lifetime.signal);
        ensureActive(lifetime.signal, context.deadlineMs);
        const http = deadlineSignal(Math.min(context.deadlineMs, Date.now() + options.timeoutMs), [lifetime.signal]);
        let response: Response | undefined;
        let retryable = false;
        let waitMs = 500;
        let failure: unknown;
        try {
          response = await fetcher(`${options.baseUrl}/${normalizedAddress(payer)}`, {
            method: "GET", headers: { Token: options.apiKey, Accept: "application/json" },
            signal: http.signal, redirect: "error",
          });
          if (!response.ok) {
            retryable = [429, 500, 502, 503, 504].includes(response.status);
            if (response.status === 429) {
              waitMs = retryAfterMs(response.headers.get("retry-after"));
              options.limiter.coolDown(waitMs);
            }
            fail(`KYT_API_HTTP_${response.status}`);
          }
          const body: unknown = await response.json();
          ensureActive(lifetime.signal, context.deadlineMs);
          if (http.signal.aborted) fail("KYT_API_TIMEOUT");
          if (!body || typeof body !== "object" || Array.isArray(body)) fail("KYT_API_INVALID_JSON");
          const result = body as Record<string, unknown>;
          if (normalizedAddress(result.address) !== normalizedAddress(payer)) fail("KYT_API_ADDRESS_MISMATCH");
          if (result.status !== "COMPLETE") fail("KYT_API_NOT_COMPLETE");
          const risk = typeof result.risk === "string" ? result.risk.trim().toLowerCase() : "";
          if (!RISKS.includes(risk as Risk)) fail("KYT_API_INVALID_RISK");
          logSafely(logger, { type: "api-complete", id: context.request.id, payer, risk, attempt });
          return { passed: !options.blocked.has(risk as Risk), screenedAt: Math.floor(Date.now() / 1000),
            reason: `risk=${risk}; timestamp=result-retrieved-at` };
        } catch (error) {
          ensureActive(lifetime.signal, context.deadlineMs);
          if (http.signal.aborted) {
            failure = new RunnerError("KYT_API_TIMEOUT"); retryable = true;
          } else if (error instanceof RunnerError) failure = error;
          else if (error instanceof SyntaxError) failure = new RunnerError("KYT_API_INVALID_JSON");
          else if (error instanceof TypeError) {
            failure = new RunnerError("KYT_API_NETWORK_ERROR"); retryable = true;
          } else failure = new RunnerError("KYT_API_ERROR");
        } finally {
          http.dispose();
          // Error bodies are never printed; cancel unread bodies to release the connection.
          if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
        }
        if (!retryable || attempt === 2 || Date.now() + waitMs >= context.deadlineMs) throw failure;
        logSafely(logger, { type: "api-retry", id: context.request.id, attempt: 2, code: codeOf(failure) });
        await sleep(waitMs, lifetime.signal);
      }
      return fail("KYT_API_ERROR");
    } finally { lifetime.dispose(); }
  };
}

/**
 * All ethers HTTP traffic, including its internal calls, passes this transport.
 * Native fetch performs one HTTP attempt; no automatic HTTP retry or redirect.
 * A timed-out broadcast remains uncertain even if fetch is aborted.
 */
export class RateLimitedRpcProvider extends JsonRpcApiProvider {
  private readonly limiter: RequestLimiter;
  private readonly shutdown = new AbortController();
  constructor(private readonly endpoint: string, chainId: number, rps: number,
    private readonly timeoutMs: number, private readonly fetcher: Fetch = fetch) {
    super(chainId, { batchMaxCount: 1, cacheTimeout: -1 });
    this.limiter = new RequestLimiter(rps);
    this._start();
  }
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<(JsonRpcResult | JsonRpcError)[]> {
    const request = Array.isArray(payload) ? payload[0] : payload;
    if (!request || (Array.isArray(payload) && payload.length !== 1)) fail("KYT_RPC_BATCH_DISABLED");
    const deadlineMs = Date.now() + this.timeoutMs;
    const lifetime = deadlineSignal(deadlineMs, [this.shutdown.signal]);
    let response: Response | undefined;
    const readFailure = (code: string, details: RpcReadError["details"] = {}): never => {
      if (PUBLIC_READ_METHODS.includes(request.method as PublicReadMethod)) {
        throw new RpcReadError(code, request.method as PublicReadMethod, details);
      }
      return fail(code);
    };
    try {
      await this.limiter.acquire(lifetime.signal);
      ensureActive(lifetime.signal, deadlineMs);
      const body = JSON.stringify(request);
      try {
        response = await this.fetcher(this.endpoint, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body, signal: lifetime.signal, redirect: "error",
        });
      } catch (error) {
        if (error instanceof TypeError) readFailure("KYT_RPC_TRANSPORT_ERROR");
        throw error;
      }
      if (!response.ok) {
        if (response.status === 429) this.limiter.coolDown(retryAfterMs(response.headers.get("retry-after")));
        if ([401, 403, 404].includes(response.status)) fail(`KYT_RPC_HTTP_${response.status}`);
        readFailure(`KYT_RPC_HTTP_${response.status}`, {httpStatus: response.status});
      }
      let parsed: unknown;
      try { parsed = await response.json(); }
      catch (error) {
        if (error instanceof SyntaxError) readFailure("KYT_RPC_INVALID_JSON");
        if (error instanceof TypeError) readFailure("KYT_RPC_TRANSPORT_ERROR");
        throw error;
      }
      ensureActive(lifetime.signal, deadlineMs);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) readFailure("KYT_RPC_INVALID_RESPONSE");
      const result = parsed as Record<string, unknown>;
      if (result.id !== request.id || result.jsonrpc !== "2.0" ||
          Object.hasOwn(result, "result") === Object.hasOwn(result, "error")) readFailure("KYT_RPC_INVALID_RESPONSE");
      if (Object.hasOwn(result, "error")) {
        const rpcError = result.error as Record<string, unknown> | null;
        if (!rpcError || typeof rpcError !== "object" || !Number.isSafeInteger(rpcError.code) ||
            typeof rpcError.message !== "string") readFailure("KYT_RPC_INVALID_RESPONSE");
        const rpcErrorCode = rpcError!.code as number;
        if (rpcErrorCode === -32603 || (rpcErrorCode <= -32000 && rpcErrorCode >= -32099 &&
            ![-32004, -32006].includes(rpcErrorCode))) {
          readFailure("KYT_RPC_SERVER_ERROR", {rpcErrorCode});
        }
        if (PUBLIC_READ_METHODS.includes(request.method as PublicReadMethod) &&
            ![-32700, -32600, -32601, -32602, -32004, -32006].includes(rpcErrorCode)) {
          readFailure("KYT_RPC_UPSTREAM_ERROR", {rpcErrorCode});
        }
      } else if (PUBLIC_READ_METHODS.includes(request.method as PublicReadMethod)) {
        const quantity = request.method === "eth_chainId" || request.method === "eth_getTransactionCount";
        if (typeof result.result !== "string" || !(quantity ? /^0x[\da-f]+$/i : /^0x(?:[\da-f]{2})*$/i).test(result.result)) {
          readFailure("KYT_RPC_INVALID_RESULT");
        }
        if (request.method === "eth_getTransactionCount" && BigInt(result.result as string) > BigInt(Number.MAX_SAFE_INTEGER)) {
          readFailure("KYT_RPC_INVALID_RESULT");
        }
      }
      return [result as JsonRpcResult | JsonRpcError];
    } catch (error) {
      if (this.shutdown.signal.aborted) fail("KYT_ABORTED");
      if (lifetime.signal.aborted) readFailure("KYT_RPC_TIMEOUT");
      throw error;
    } finally {
      lifetime.dispose();
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
    }
  }
  override destroy(): void {
    this.shutdown.abort();
    this.limiter.close();
    super.destroy();
  }
}

type BotTuning = Required<Pick<KytScreeningBotOptions,
  "screeningConcurrency" | "maxPendingTransactions" | "processingWindowMs" | "confirmationReserveMs" |
  "confirmations" | "reconnectDelayMs" | "heartbeatIntervalMs" | "rpcTimeoutMs" | "receiptPollMs" | "receiptTimeoutMs">>;
export interface GatewayConfig { gateway: string; vault: string; asset: string; }
export interface RunnerConfig {
  mode: "production" | "local";
  rpcUrl: string; wssUrl: string; chainId: number;
  gateway: string; vault: string; asset: string; oracleKey: string;
  gateways: GatewayConfig[];
  maxTransactionFeeWei?: bigint;
  screener: "chainalysis" | "allow" | "denylist";
  apiKey: string; apiUrl: string; blocked: ReadonlySet<Risk>; denylist: ReadonlySet<string>;
  apiRps: number; rpcRps: number; apiTimeoutMs: number; tuning: BotTuning;
}

function positive(value: string | undefined, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) fail(`KYT_INVALID_${name}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_TIMER) fail(`KYT_INVALID_${name}`);
  return n;
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) fail(`KYT_MISSING_${name}`);
  return value.trim();
}
function address(value: string | undefined, name: string): string {
  const raw = required(value, name);
  try {
    const parsed = getAddress(raw);
    if (parsed === ZeroAddress) fail("KYT_ZERO_ADDRESS");
    return parsed;
  } catch { return fail(`KYT_INVALID_${name}`); }
}
function url(value: string | undefined, name: string, schemes: string[]): URL {
  const raw = required(value, name);
  try {
    const parsed = new URL(raw);
    if (!schemes.includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) fail("KYT_INVALID_URL");
    return parsed;
  } catch { return fail(`KYT_INVALID_${name}`); }
}
function loopback(value: URL): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname); }

export function readConfig(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)): RunnerConfig {
  const names = new Set(["rpc", "wss", "gateway", "vault", "asset", "chain-id", "screener", "confirmations"]);
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !names.has(key) || args.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      fail("KYT_INVALID_CLI_ARGUMENTS");
    }
    args.set(key, argv[i + 1]);
  }
  const mode = env.KYT_ENV ?? "production";
  if (mode !== "production" && mode !== "local") fail("KYT_INVALID_ENV");
  const rpcUrl = url(args.get("rpc") ?? env.RPC_URL, "RPC_URL", mode === "local" ? ["http:", "https:"] : ["https:"]);
  const wssUrl = url(args.get("wss") ?? env.WSS_URL, "WSS_URL", mode === "local" ? ["ws:", "wss:"] : ["wss:"]);
  const chainId = positive(args.get("chain-id") ?? env.KYT_CHAIN_ID, "CHAIN_ID");
  const screener = args.get("screener") ?? env.KYT_SCREENER ?? "chainalysis";
  if (!["chainalysis", "allow", "denylist"].includes(screener)) fail("KYT_INVALID_SCREENER");
  if (mode === "local" && (!loopback(rpcUrl) || !loopback(wssUrl) || chainId !== 31337)) fail("KYT_LOCAL_ENDPOINT_REQUIRED");
  if (mode === "production" && (screener !== "chainalysis" || !PRODUCTION_CHAIN_IDS.includes(chainId))) fail("KYT_PRODUCTION_CONFIGURATION_REQUIRED");
  const apiUrl = url(env.CHAINALYSIS_API_URL ?? API_URL, "API_URL", ["https:"]);
  if (apiUrl.origin !== "https://api.chainalysis.com" || apiUrl.pathname.replace(/\/$/, "") !== "/api/risk/v2/entities" || apiUrl.search) fail("KYT_INVALID_API_URL");
  const tuning: BotTuning = {
    screeningConcurrency: positive(env.KYT_SCREENING_CONCURRENCY, "SCREENING_CONCURRENCY", 20),
    maxPendingTransactions: positive(env.KYT_MAX_PENDING_TX, "MAX_PENDING_TX", 16),
    processingWindowMs: positive(env.KYT_PROCESSING_WINDOW_MS, "PROCESSING_WINDOW_MS", 60_000),
    confirmationReserveMs: positive(env.KYT_CONFIRMATION_RESERVE_MS, "CONFIRMATION_RESERVE_MS", 10_000),
    confirmations: positive(args.get("confirmations") ?? env.KYT_CONFIRMATIONS, "CONFIRMATIONS", 1),
    reconnectDelayMs: positive(env.KYT_RECONNECT_DELAY_MS, "RECONNECT_DELAY_MS", 5_000),
    heartbeatIntervalMs: positive(env.KYT_HEARTBEAT_INTERVAL_MS, "HEARTBEAT_INTERVAL_MS", 15_000),
    rpcTimeoutMs: positive(env.KYT_RPC_TIMEOUT_MS, "RPC_TIMEOUT_MS", 10_000),
    receiptPollMs: positive(env.KYT_RECEIPT_POLL_MS, "RECEIPT_POLL_MS", 1_000),
    receiptTimeoutMs: positive(env.KYT_RECEIPT_TIMEOUT_MS, "RECEIPT_TIMEOUT_MS", 60_000),
  };
  if (tuning.confirmationReserveMs >= tuning.processingWindowMs) fail("KYT_INVALID_TIME_WINDOW");
  const oracleKey = required(env.KYT_ORACLE_PK, "ORACLE_PK");
  try { new Wallet(oracleKey); } catch { fail("KYT_INVALID_ORACLE_KEY"); }
  const apiRps = positive(env.KYT_API_RPS, "API_RPS", 30);
  if (apiRps > 40) fail("KYT_API_RPS_EXCEEDS_40");
  let gateways: GatewayConfig[];
  if (env.KYT_GATEWAYS) {
    if (["gateway", "vault", "asset"].some(k => args.has(k)) ||
        [env.KYT_GATEWAY, env.KYT_VAULT, env.KYT_ASSET].some(Boolean)) fail("KYT_AMBIGUOUS_GATEWAY_CONFIGURATION");
    try {
      const entries: unknown = JSON.parse(env.KYT_GATEWAYS);
      if (!Array.isArray(entries) || !entries.length) fail("KYT_INVALID_GATEWAYS");
      gateways = entries.map(item => ({gateway: address(item.gateway, "GATEWAY"),
        vault: address(item.vault, "VAULT"), asset: address(item.asset, "ASSET")}));
      if (new Set(gateways.map(g => g.gateway)).size !== gateways.length ||
          new Set(gateways.map(g => g.vault)).size !== gateways.length) fail("KYT_DUPLICATE_GATEWAY");
    } catch { fail("KYT_INVALID_GATEWAYS"); }
  } else {
    gateways = [{gateway: address(args.get("gateway") ?? env.KYT_GATEWAY, "GATEWAY"),
      vault: address(args.get("vault") ?? env.KYT_VAULT, "VAULT"),
      asset: address(args.get("asset") ?? env.KYT_ASSET, "ASSET")}];
  }
  let maxTransactionFeeWei: bigint | undefined;
  if (env.KYT_MAX_TX_FEE_WEI !== undefined) {
    if (!/^[1-9][0-9]*$/.test(env.KYT_MAX_TX_FEE_WEI)) fail("KYT_INVALID_MAX_TX_FEE_WEI");
    maxTransactionFeeWei = BigInt(env.KYT_MAX_TX_FEE_WEI);
  }
  const denylist = new Set<string>();
  if (screener === "denylist") {
    for (const item of required(env.KYT_DENYLIST, "DENYLIST").split(",")) denylist.add(address(item.trim(), "DENYLIST_ADDRESS"));
  }
  return {
    mode, rpcUrl: rpcUrl.href, wssUrl: wssUrl.href, chainId,
    ...gateways[0], gateways, oracleKey, maxTransactionFeeWei,
    screener: screener as RunnerConfig["screener"],
    apiKey: screener === "chainalysis" ? required(env.CHAINALYSIS_API_KEY, "API_KEY") : "",
    apiUrl: apiUrl.href.replace(/\/$/, ""), blocked: parseBlockedRisk(env.KYT_BLOCK_RISK ?? "Severe,High"), denylist,
    apiRps, rpcRps: positive(env.KYT_RPC_RPS, "RPC_RPS"),
    apiTimeoutMs: positive(env.KYT_API_TIMEOUT_MS, "API_TIMEOUT_MS", 5_000), tuning,
  };
}

export function resolveScreener(config: RunnerConfig, limiter: RequestLimiter,
  signal?: AbortSignal, logger?: Logger): AddressScreener {
  if (config.screener === "chainalysis") return chainalysisScreener({
    apiKey: config.apiKey, baseUrl: config.apiUrl, blocked: config.blocked,
    timeoutMs: config.apiTimeoutMs, limiter, shutdownSignal: signal, logger,
  });
  if (config.mode !== "local" || config.chainId !== 31337 ||
      !loopback(new URL(config.rpcUrl)) || !loopback(new URL(config.wssUrl))) fail("KYT_LOCAL_ENDPOINT_REQUIRED");
  return async (payer, context: ScreeningContext) => {
    ensureActive(context.signal, context.deadlineMs);
    return { passed: config.screener === "allow" || !config.denylist.has(normalizedAddress(payer)),
      screenedAt: Math.floor(Date.now() / 1000), reason: `local-test=${config.screener}` };
  };
}

/** Once-only startup validation; this does not read any individual application. */
export async function validateDeployment(config: RunnerConfig, provider: Provider, signer: Wallet): Promise<void> {
  try {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) fail("KYT_CHAIN_MISMATCH");
  } catch (error) {
    // ethers reports a changed chain as NETWORK_ERROR; it is a configuration failure, not an outage.
    if (error && typeof error === "object" && "event" in error && error.event === "changed") fail("KYT_CHAIN_MISMATCH");
    throw error;
  }
  for (const entry of config.gateways) {
  const bytecodes = await Promise.all([entry.gateway, entry.vault, entry.asset].map(a => provider.getCode(a)));
  if (bytecodes.some(code => code === "0x")) fail("KYT_MISSING_CONTRACT_CODE");
  const gateway = new Contract(entry.gateway, [
    "function oracle() view returns (address)", "function vault() view returns (address)",
    "function asset() view returns (address)",
  ], provider);
  const vault = new Contract(entry.vault, ["function usdt() view returns (address)", "function gate() view returns (address)"], provider);
  const [oracle, boundVault, boundAsset, usdt, gate] = await Promise.all([
    gateway.oracle(), gateway.vault(), gateway.asset(), vault.usdt(), vault.gate(),
  ]).catch(error => {
    // ABI decoding of an upstream read result is external data; unrelated exceptions remain fatal.
    if (error && typeof error === "object" && "code" in error && error.code === "BAD_DATA") {
      throw new RpcReadError("KYT_RPC_INVALID_RESULT", "eth_call");
    }
    throw error;
  });
  if (normalizedAddress(oracle) !== signer.address) fail("KYT_ORACLE_MISMATCH");
  if (normalizedAddress(boundVault) !== entry.vault) fail("KYT_VAULT_MISMATCH");
  if (normalizedAddress(boundAsset) !== entry.asset || normalizedAddress(usdt) !== entry.asset) fail("KYT_ASSET_MISMATCH");
  if (normalizedAddress(gate) !== entry.gateway) fail("KYT_GATE_MISMATCH");
  }
}

/** Recovery is for public reads only. Never wrap a broadcast or an uncertain transaction in this policy. */
export function isRecoverableReadError(error: unknown): boolean {
  if (error && typeof error === "object" && "event" in error && error.event === "changed") return false;
  const code = codeOf(error);
  return error instanceof RpcReadError || ["KYT_WSS_DISCONNECTED", "KYT_WSS_READ_ERROR", "NETWORK_ERROR", "TIMEOUT"].includes(code);
}
function recoveryDelay(failures: number): number { return Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)); }

export async function recoverStartupReads(operation: () => Promise<void>, signal: AbortSignal,
  logger: Logger, chainId: number): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try { await operation(); return; }
    catch (error) {
      if (signal.aborted) return;
      if (!isRecoverableReadError(error)) throw error;
      const retryInMs = recoveryDelay(++failures);
      logSafely(logger, {type: "connection-error", component: "kyt-startup", chainId,
        code: codeOf(error), ...readDiagnostics(error), failures, retryInMs});
      await sleep(retryInMs, signal).catch(error => { if (!signal.aborted) throw error; });
    }
  }
}

/** A self-paced loop prevents overlapping checks and reports not-ready while configuration is unknown. */
export async function watchDeploymentHealth(config: RunnerConfig, provider: Provider, signer: Wallet,
  bot: Pick<KytScreeningBot, "setConfigurationHealthy" | "disableGateway" | "health">,
  signal: AbortSignal, logger: Logger, onFatal: () => void): Promise<void> {
  let failures = 0;
  let lastValidatedAt: string | null = null;
  while (!signal.aborted) {
    let retryInMs = 30_000;
    try {
      for (const entry of config.gateways) {
        if (signal.aborted) return;
        try { await validateDeployment({...config, gateways: [entry]}, provider, signer); }
        catch (error) {
          const code = codeOf(error);
          if (!["KYT_MISSING_CONTRACT_CODE", "KYT_ORACLE_MISMATCH", "KYT_VAULT_MISMATCH", "KYT_ASSET_MISMATCH", "KYT_GATE_MISMATCH"].includes(code)) throw error;
          bot.disableGateway(entry.gateway);
          logSafely(logger, {type: "gateway-disabled", chainId: config.chainId, gateway: entry.gateway, code});
        }
      }
      if (signal.aborted) return;
      lastValidatedAt = new Date().toISOString();
      bot.setConfigurationHealthy(true);
      if (failures) logSafely(logger, {type: "health-recovered", chainId: config.chainId, failures});
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      bot.setConfigurationHealthy(false);
      if (!isRecoverableReadError(error)) {
        logSafely(logger, {type: "configuration-error", chainId: config.chainId, code: codeOf(error)});
        onFatal();
        return;
      }
      retryInMs = recoveryDelay(++failures);
      logSafely(logger, {type: "connection-error", component: "kyt-health", chainId: config.chainId,
        code: codeOf(error), ...readDiagnostics(error), failures, retryInMs});
    }
    logSafely(logger, {type: "health", chainId: config.chainId, oracle: signer.address,
      gateways: config.gateways, ...bot.health(), configurationReadFailures: failures, lastValidatedAt});
    await sleep(retryInMs, signal).catch(error => { if (!signal.aborted) throw error; });
  }
}

/** Runs until SIGINT/SIGTERM (via signal), startup failure or an uncertain transaction. */
export async function runService(config: RunnerConfig, signal: AbortSignal, logger: Logger = stdoutLogger): Promise<number> {
  const provider = new RateLimitedRpcProvider(config.rpcUrl, config.chainId, config.rpcRps, config.tuning.rpcTimeoutMs);
  const apiLimiter = new RequestLimiter(config.apiRps);
  const apiShutdown = new AbortController();
  let bot: KytScreeningBot | undefined;
  let healthWork: Promise<void> | undefined;
  let stopping = false;
  let exitCode = 0;
  let wake!: () => void;
  const stopped = new Promise<void>(resolveStop => { wake = resolveStop; });
  const requestStop = (code: number) => {
    exitCode = Math.max(exitCode, code);
    if (stopping) return;
    stopping = true;
    apiShutdown.abort();
    // Before the bot is created there can be no signed transaction to track.
    // Abort startup reads and queued RPC immediately instead of awaiting timeouts.
    if (!bot) provider.destroy();
    // stop() disables intake synchronously, but retains finite receipt tracking.
    void bot?.stop().catch(() => { exitCode = 1; });
    wake();
  };
  const onSignal = () => requestStop(0);
  signal.addEventListener("abort", onSignal, { once: true });
  try {
    if (signal.aborted) requestStop(0);
    if (!stopping) {
      const signer = new Wallet(config.oracleKey, provider);
      await recoverStartupReads(() => validateDeployment(config, provider, signer), apiShutdown.signal, logger, config.chainId);
      if (!stopping) {
        bot = new KytScreeningBot({
          gateway: config.gateway, gateways: config.gateways.map(g => g.gateway), maxTransactionFeeWei: config.maxTransactionFeeWei, signer, ...config.tuning,
          createWebSocket: () => new WebSocket(config.wssUrl),
          screener: resolveScreener(config, apiLimiter, apiShutdown.signal, logger),
          onAlert: event => {
            logSafely(logger, { component: "kyt-bot", ...event });
            if (event.type === "submission-uncertain") requestStop(1);
          },
        });
        // Subscribing can recover after a long outage; revalidate before admitting any unsigned work.
        bot.setConfigurationHealthy(false);
        await recoverStartupReads(() => bot!.start(), apiShutdown.signal, logger, config.chainId);
        if (!stopping) {
          await recoverStartupReads(() => validateDeployment(config, provider, signer), apiShutdown.signal, logger, config.chainId);
        }
        if (!stopping) {
          bot.setConfigurationHealthy(true);
          logSafely(logger, { type: "ready", chainId: config.chainId, gateway: config.gateway,
            vault: config.vault, asset: config.asset, gateways: config.gateways, oracle: signer.address, screener: config.screener,
            blockedRisk: [...config.blocked], apiRps: config.apiRps, rpcRps: config.rpcRps,
            apiTimeoutMs: config.apiTimeoutMs, ...config.tuning });
          healthWork = watchDeploymentHealth(config, provider, signer, bot, apiShutdown.signal, logger,
            () => requestStop(1)).catch(error => {
              if (!stopping) {
                logSafely(logger, {type: "configuration-error", chainId: config.chainId, code: codeOf(error)});
                requestStop(1);
              }
            });
          await stopped;
        }
      }
    }
  } catch (error) {
    if (!stopping) { exitCode = 1; logSafely(logger, { type: "startup-error", code: codeOf(error) }); }
  } finally {
    apiShutdown.abort();
    try { await bot?.stop(); }
    catch { exitCode = 1; logSafely(logger, { type: "stop-error", code: "KYT_STOP_FAILED" }); }
    apiLimiter.close();
    provider.destroy();
    await healthWork;
    signal.removeEventListener("abort", onSignal);
    logSafely(logger, { type: "service-stopped", exitCode });
  }
  return exitCode;
}

const HELP = `KYT runner (Node.js 24+). Configuration is loaded once at startup.
Required: RPC_URL, WSS_URL, KYT_CHAIN_ID (1/56/97/143/43114), KYT_ORACLE_PK,
          CHAINALYSIS_API_KEY, KYT_RPC_RPS.
Gateways: KYT_GATEWAYS JSON [{gateway,vault,asset},...] or single KYT_GATEWAY/KYT_VAULT/KYT_ASSET.
Optional: KYT_MAX_TX_FEE_WEI caps the total fee before signing.
Defaults: KYT_BLOCK_RISK=Severe,High; KYT_API_RPS=30; KYT_API_TIMEOUT_MS=5000.
CLI overrides: --rpc --wss --chain-id --gateway --vault --asset --screener --confirmations.
No --pk, --impersonate, --poll, --once, --from-block, --max-retries or --retry-delay.
Local mocks only: KYT_ENV=local, chain 31337 and loopback HTTP/WSS; --screener allow|denylist.
One process per chain oracle; KYT_GATEWAYS JSON registers multiple Gateway/Vault/asset entries. No history recovery. Restart after changing configuration.
`;

async function main(): Promise<void> {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
    process.stdout.write(HELP); return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24 || typeof WebSocket !== "function") fail("KYT_NODE_24_REQUIRED");
  const config = readConfig();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try { process.exitCode = await runService(config, controller.signal); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    logSafely(stdoutLogger, { type: "fatal", code: codeOf(error) });
    process.exitCode = 1;
  });
}
