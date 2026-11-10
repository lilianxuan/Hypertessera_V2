import { Contract, Interface, keccak256, getAddress, type Provider, type Signer } from "ethers";
import type { Address } from "./types.js";

export const KYT_GATEWAY_ABI = [
  "event ScreeningRequested(uint256 indexed id, address indexed payer, address indexed owner, uint256 assets, uint64 expiresAt)",
  "event ScreeningRejected(uint256 indexed id, address indexed payer, uint64 screenedAt, uint256 timestamp)",
  "event DepositExecuted(uint256 indexed id, uint256 indexed vaultRequestId, address indexed owner, uint256 assets, uint64 screenedAt)",
  "event RequestCancelled(uint256 indexed id, address indexed payer, uint256 timestamp)",
  "function fulfill(uint256 id, bool passed, uint64 screenedAt)",
  "function getRequest(uint256 id) view returns (tuple(address payer, address owner, uint256 assets, uint64 requestedAt, uint64 expiresAt, uint8 state))",
  "function oracle() view returns (address)",
] as const;

export enum ScreeningState { NONE, PENDING, EXECUTED, REJECTED, CANCELLED }

/** Used only by the optional manual getRequest() helper. */
export interface ScreeningRequest {
  id: bigint; payer: Address; owner: Address; assets: bigint;
  requestedAt: bigint; expiresAt: bigint; state: ScreeningState;
}

export interface ScreeningRequestEvent {
  /** Originating Gateway; required when listening to multiple Gateways. */
  gateway?: Address;
  id: bigint; payer: Address; owner: Address; assets: bigint; expiresAt: bigint;
}

export interface ScreeningContext {
  request: ScreeningRequestEvent;
  receivedAtMs: number;
  /** Deadline for screening and starting submission, including queue time. */
  deadlineMs: number;
  signal: AbortSignal;
}

export interface ScreeningVerdict {
  passed: boolean;
  /** Unix seconds supplied by the screener; not necessarily a vendor timestamp. */
  screenedAt: number;
  reason?: string;
}

/** The injected screener owns API validation, rate limiting and its one optional retry. */
export type AddressScreener = (
  payer: Address, context: ScreeningContext,
) => Promise<ScreeningVerdict>;

export type KytAlertType =
  | "connected" | "received" | "screened" | "submitted" | "executed" | "stopped"
  | "screening-rejected" | "screening-error" | "submit-retry" | "submit-error" | "execution-reverted"
  | "processing-timeout" | "submission-uncertain" | "connection-error";

export interface KytAlert {
  gateway?: Address;
  type: KytAlertType;
  message: string;
  id?: bigint;
  payer?: Address;
  txHash?: string;
  nonce?: number;
  elapsedMs?: number;
}

export interface KytScreeningBotOptions {
  gateway: Address;
  /** All registered Gateways share this bot's single nonce queue and signer. */
  gateways?: Address[];
  maxTransactionFeeWei?: bigint;
  /** Must support signTransaction(); use a Wallet with the rate-limited HTTP provider. */
  signer: Signer;
  /** Fresh native WebSocket each call; Node.js 24: () => new WebSocket(wssUrl). */
  createWebSocket: () => WebSocket;
  screener: AddressScreener;
  /** Retains the existing callback name; now includes informational progress events. */
  onAlert?: (event: KytAlert) => void;
  screeningConcurrency?: number;
  maxPendingTransactions?: number;
  processingWindowMs?: number;
  confirmationReserveMs?: number;
  confirmations?: number;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  rpcTimeoutMs?: number;
  receiptPollMs?: number;
  /** Finite receipt tracking period after broadcast, also used while stopping. */
  receiptTimeoutMs?: number;
  /** First delay before re-preparing a failed fulfill; doubles up to 8x, never past the deadline. */
  preparationRetryMs?: number;
}

type Task = ScreeningContext & {
  completionAtMs: number;
  controller: AbortController;
  phase: "queued" | "screening" | "ready" | "preparing" | "submitted";
  verdict?: ScreeningVerdict;
  submitTimer?: ReturnType<typeof setTimeout>;
  completionTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolve: () => void;
  finished: boolean;
  txHash?: string;
  nonce?: number;
  maxFeeWei?: bigint;
  /** Failed preparations so far; no nonce is consumed before signing. */
  attempts: number;
  retryAtMs?: number;
  lastError?: string;
};

/** Signing-policy refusals are deliberate and are not retried. */
function policyError(text: string): Error {
  return Object.assign(new Error(text), { policy: true });
}

function message(error: unknown): string {
  // Provider messages can contain authenticated URLs and serialized transactions.
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(error.name)
    ? error.name : "Error";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_-]{1,48}$/.test(code) ? `${name} (${code})` : name;
}

/** Only an explicit protocol rejection proves incompatibility; unavailable reads remain closed and retryable. */
function webSocketResponseFailure(body: Record<string, unknown>): string | undefined {
  if (body.jsonrpc !== "2.0" || Object.hasOwn(body, "result") === Object.hasOwn(body, "error")) {
    return "KYT_WSS_READ_ERROR";
  }
  if (!Object.hasOwn(body, "error")) return undefined;
  const error = body.error;
  if (error && typeof error === "object" && !Array.isArray(error) && "code" in error &&
      Number.isSafeInteger(error.code) && "message" in error && typeof error.message === "string" &&
      [-32700, -32600, -32601, -32602, -32004, -32006].includes(error.code as number)) {
    return "KYT_WSS_PROTOCOL_ERROR";
  }
  return "KYT_WSS_READ_ERROR";
}

/** The bot's outer startup deadline expired while waiting on a known public read. */
export class KytReadTimeoutError extends Error {
  readonly code = "TIMEOUT";
  constructor(readonly rpcMethod: "eth_chainId" | "eth_getTransactionCount") {
    super("public RPC read timed out");
    this.name = "KytReadTimeoutError";
  }
}

/** Bounds waiting. In particular, timing out a broadcast does NOT cancel that transaction. */
function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal,
  timeoutError: Error = new Error("operation timed out")): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("operation aborted")); };
    const timer = setTimeout(() => { cleanup(); reject(timeoutError); }, Math.max(0, ms));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class KytScreeningBot {
  private readonly options: Required<Omit<KytScreeningBotOptions, "onAlert" | "gateways" | "maxTransactionFeeWei">> & Pick<KytScreeningBotOptions, "onAlert" | "gateways" | "maxTransactionFeeWei">;
  private readonly provider: Provider;
  private readonly gateway: Contract;
  private readonly iface = new Interface(KYT_GATEWAY_ABI);
  private readonly gateways: Address[];
  private readonly disabledGateways = new Set<Address>();
  private readonly activeRequests = new Map<string, Task>();
  private running = false;
  private accepting = false;
  private paused = false;
  private configurationHealthy = true;
  private chainId?: bigint;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private socket?: WebSocket;
  private disconnect?: () => void;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private receiptTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private screening = 0;
  private sending = false;
  private nextNonce = 0;
  private queue: Task[] = [];
  private ready: Task[] = [];
  /** Live work only; duplicates are scoped by Gateway, with no historical scan/recovery. */
  private readonly tasks = new Set<Task>();
  private readonly pending = new Map<string, { task: Task; expiresAtMs: number }>();
  private readonly work = new Set<Promise<void>>();

  constructor(options: KytScreeningBotOptions) {
    if (!options.signer.provider) throw new Error("signer needs an HTTP provider");
    this.gateways = (options.gateways ?? [options.gateway]).map(a => getAddress(a));
    if (!this.gateways.length || new Set(this.gateways).size !== this.gateways.length ||
        !this.gateways.includes(getAddress(options.gateway))) throw new Error("invalid Gateway registry");
    this.provider = options.signer.provider;
    this.gateway = new Contract(options.gateway, KYT_GATEWAY_ABI, options.signer);
    this.options = {
      ...options,
      screeningConcurrency: options.screeningConcurrency ?? 20,
      maxPendingTransactions: options.maxPendingTransactions ?? 16,
      processingWindowMs: options.processingWindowMs ?? 60_000,
      confirmationReserveMs: options.confirmationReserveMs ?? 10_000,
      confirmations: options.confirmations ?? 1,
      reconnectDelayMs: options.reconnectDelayMs ?? 5_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      rpcTimeoutMs: options.rpcTimeoutMs ?? 10_000,
      receiptPollMs: options.receiptPollMs ?? 1_000,
      receiptTimeoutMs: options.receiptTimeoutMs ?? 60_000,
      preparationRetryMs: options.preparationRetryMs ?? 1_000,
    };
    const numericOptions = [
      "screeningConcurrency", "maxPendingTransactions", "processingWindowMs", "confirmationReserveMs",
      "confirmations", "reconnectDelayMs", "heartbeatIntervalMs", "rpcTimeoutMs", "receiptPollMs", "receiptTimeoutMs",
      "preparationRetryMs",
    ] as const;
    for (const name of numericOptions) {
      const value = this.options[name];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
      if (name.endsWith("Ms") && value > 2_147_483_647) throw new Error(`${name} exceeds the Node.js timer limit`);
    }
    if (this.options.confirmationReserveMs >= this.options.processingWindowMs) {
      throw new Error("confirmationReserveMs must be shorter than processingWindowMs");
    }
  }

  async oracle(): Promise<Address> {
    return bounded(this.gateway.oracle(), this.options.rpcTimeoutMs);
  }

  disableGateway(address: Address): void {
    const normalized = getAddress(address);
    if (!this.gateways.includes(normalized)) throw new Error("unregistered Gateway");
    this.disabledGateways.add(normalized);
    for (const task of this.tasks) {
      if (task.request.gateway === normalized && task.phase !== "submitted") this.finish(task);
    }
    this.queue = this.queue.filter(t => !t.finished);
    this.ready = this.ready.filter(t => !t.finished);
  }

  health(): Record<string, unknown> {
    const now = Date.now();
    return { ready: this.running && this.accepting && !this.paused && this.configurationHealthy && this.disabledGateways.size === 0,
      configurationHealthy: this.configurationHealthy,
      disabledGateways: [...this.disabledGateways],
      gatewayCount: this.gateways.length, queued: this.queue.length + this.ready.length,
      screening: this.screening, pending: this.pending.size, nextNonce: this.nextNonce,
      pendingFeeReserveWei: [...this.pending.values()].reduce((sum, p) => sum + (p.task.maxFeeWei ?? 0n), 0n),
      oldestPendingMs: this.pending.size ? now - Math.min(...[...this.pending.values()].map(p => p.task.receivedAtMs)) : 0,
      oldestQueuedMs: this.queue.length + this.ready.length ? now - Math.min(...[...this.queue, ...this.ready].map(t => t.receivedAtMs)) : 0 };
  }

  /** A failed configuration read suspends unsigned work; WSS intake and receipt tracking stay alive. */
  setConfigurationHealthy(healthy: boolean): void {
    this.configurationHealthy = healthy;
    if (healthy) {
      this.pumpScreening();
      this.track(this.pumpSending());
    }
  }

  /** Manual inspection only; automatic processing never calls this helper. */
  async getRequest(id: bigint): Promise<ScreeningRequest> {
    const r = await bounded(this.gateway.getRequest(id), this.options.rpcTimeoutMs);
    return { id, payer: r.payer, owner: r.owner, assets: r.assets,
      requestedAt: r.requestedAt, expiresAt: r.expiresAt, state: Number(r.state) };
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("bot is stopping"));
    if (this.running) return this.starting ?? Promise.resolve();
    this.running = true;
    this.accepting = false;
    this.paused = false;
    this.starting = (async () => {
      const [address, network] = await Promise.all([
        bounded(this.options.signer.getAddress(), this.options.rpcTimeoutMs),
        bounded(this.provider.getNetwork(), this.options.rpcTimeoutMs, undefined, new KytReadTimeoutError("eth_chainId")),
      ]);
      this.chainId = network.chainId;
      this.nextNonce = await bounded(this.provider.getTransactionCount(address, "pending"), this.options.rpcTimeoutMs,
        undefined, new KytReadTimeoutError("eth_getTransactionCount"));
      if (!this.running) throw new Error("startup was stopped");
      await this.connect();
    })().catch(error => {
      this.running = false;
      this.accepting = false;
      this.disconnect?.();
      throw error;
    })
      .finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Stops intake and unsigned work; already signed/broadcast transactions are not cancelled. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.accepting = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.disconnect?.();
    for (const task of this.tasks) {
      if (task.phase !== "submitted") {
        this.emit("stopped", "stopped before broadcast", task);
        this.finish(task);
      }
    }
    this.queue = [];
    this.ready = [];
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await Promise.all([...this.tasks].map(task => task.done));
      while (this.work.size) await Promise.all([...this.work]);
      clearTimeout(this.receiptTimer);
      this.receiptTimer = undefined;
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private track(work: Promise<void>): void {
    this.work.add(work);
    void work.then(() => this.work.delete(work), () => this.work.delete(work));
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.options.createWebSocket();
      this.socket = ws;
      let subscription: string | undefined;
      let networkVerified = false;
      let awaitingNetwork = false;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      let failureCode = "KYT_WSS_DISCONNECTED";
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        clearTimeout(heartbeatTimer);
        clearTimeout(heartbeatTimeout);
        ws.removeEventListener("open", open);
        ws.removeEventListener("message", receive);
        ws.removeEventListener("error", failed);
        ws.removeEventListener("close", failed);
        if (this.socket === ws) { this.socket = undefined; this.disconnect = undefined; this.accepting = false; }
        try { ws.close(); } catch { /* Already closed. */ }
      };
      const failed = () => {
        if (closed) return;
        cleanup();
        if (!subscription) reject(Object.assign(new Error("WebSocket subscription failed"), {code: failureCode}));
        else if (this.running) {
          this.emit("connection-error", "WebSocket disconnected; reconnecting without backfill");
          this.reconnect();
        }
      };
      const open = () => {
        try {
          awaitingNetwork = true;
          heartbeatTimeout = setTimeout(failed, this.options.rpcTimeoutMs);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] }));
        } catch { failed(); }
      };
      const receive = (event: MessageEvent) => {
        if (closed || !this.running || this.socket !== ws) return;
        try {
          const body = JSON.parse(String(event.data));
          if (body.id === 2 && awaitingNetwork) {
            awaitingNetwork = false;
            clearTimeout(heartbeatTimeout);
            const responseFailure = webSocketResponseFailure(body);
            if (responseFailure || typeof body.result !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(body.result)) {
              failureCode = responseFailure ?? "KYT_WSS_READ_ERROR";
              this.emit("connection-error", "WebSocket chain check unavailable; no subscription accepted");
              failed();
              return;
            }
            if (BigInt(body.result) !== this.chainId) {
              failureCode = "KYT_CHAIN_MISMATCH";
              this.emit("connection-error", "WebSocket chain check failed; HTTP and WSS must use the same chain");
              failed();
              return;
            }
            networkVerified = true;
            if (subscription) heartbeatTimer = setTimeout(open, this.options.heartbeatIntervalMs);
            else {
              try {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", {
                  address: this.gateways.length === 1 ? this.gateways[0] : this.gateways,
                  topics: [this.iface.getEvent("ScreeningRequested")!.topicHash],
                }] }));
              } catch { failed(); }
            }
            return;
          }
          if (body.id === 1 && !subscription) {
            const responseFailure = webSocketResponseFailure(body);
            if (!networkVerified || responseFailure || typeof body.result !== "string" || !body.result) {
              failureCode = responseFailure ?? "KYT_WSS_READ_ERROR";
              failed(); return;
            }
            subscription = body.result;
            clearTimeout(timeout);
            this.accepting = true;
            heartbeatTimer = setTimeout(open, this.options.heartbeatIntervalMs);
            this.emit("connected", "ScreeningRequested subscription ready");
            resolve();
            return;
          }
          if (!subscription || body.method !== "eth_subscription" || body.params?.subscription !== subscription) return;
          const log = body.params.result;
          if (log?.removed === true || typeof log?.address !== "string" ||
              !this.gateways.some(a => a.toLowerCase() === log.address.toLowerCase())) return;
          const parsed = this.iface.parseLog(log);
          if (!parsed || parsed.name !== "ScreeningRequested") return;
          const { id, payer, owner, assets, expiresAt } = parsed.args;
          void this.processRequest({ gateway: getAddress(log.address), id, payer, owner, assets, expiresAt });
        } catch {
          this.emit("connection-error", "invalid ScreeningRequested notification");
        }
      };
      const timeout = setTimeout(failed, this.options.rpcTimeoutMs);
      this.disconnect = () => {
        cleanup();
        if (!subscription) reject(new Error("subscription stopped"));
      };
      ws.addEventListener("open", open);
      ws.addEventListener("message", receive);
      ws.addEventListener("error", failed);
      ws.addEventListener("close", failed);
      if (ws.readyState === 1) open();
    });
  }

  private reconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.running) return;
      this.track(this.connect().catch(() => {
        if (this.running) {
          this.emit("connection-error", "WebSocket reconnect failed");
          this.reconnect();
        }
      }));
    }, this.options.reconnectDelayMs);
  }

  /** Enqueues a registered Gateway event, deduplicating only its live work. */
  processRequest(request: ScreeningRequestEvent): Promise<void> {
    if (!this.running || !this.accepting || this.paused) {
      this.emit("stopped", `not accepting request ${request.id}; service not ready or paused`);
      return Promise.resolve();
    }
    let gateway: Address;
    try { gateway = getAddress(request.gateway ?? (this.gateways.length === 1 ? this.gateways[0] : "")); }
    catch { this.emit("submit-error", "missing or invalid request Gateway"); return Promise.resolve(); }
    if (!this.gateways.includes(gateway) || this.disabledGateways.has(gateway)) {
      this.emit("submit-error", "unregistered request Gateway"); return Promise.resolve();
    }
    request = { ...request, gateway };
    const key = `${gateway}:${request.id}`;
    const existing = this.activeRequests.get(key);
    if (existing) return existing.done;
    const receivedAtMs = Date.now();
    const expiresAtMs = Number(request.expiresAt) * 1000;
    const completionAtMs = Math.min(receivedAtMs + this.options.processingWindowMs, expiresAtMs);
    if (!Number.isSafeInteger(expiresAtMs) || completionAtMs - this.options.confirmationReserveMs <= receivedAtMs) {
      this.emit("processing-timeout", "request expired or insufficient confirmation window");
      return Promise.resolve();
    }
    const controller = new AbortController();
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const task: Task = {
      request, receivedAtMs, completionAtMs,
      deadlineMs: completionAtMs - this.options.confirmationReserveMs,
      controller, signal: controller.signal, phase: "queued", done, resolve, finished: false, attempts: 0,
    };
    task.submitTimer = setTimeout(() => {
      if (!task.finished && task.phase !== "submitted") {
        this.emitDeadline(task);
        this.finish(task);
      }
    }, task.deadlineMs - receivedAtMs);
    task.completionTimer = setTimeout(() => {
      if (!task.finished && task.phase === "submitted") {
        this.pause("confirmation target exceeded; transaction is not cancelled", task);
      }
    }, completionAtMs - receivedAtMs);
    this.activeRequests.set(key, task);
    this.tasks.add(task);
    this.queue.push(task);
    this.emit("received", "request received", task);
    this.pumpScreening();
    return done;
  }

  private canContinue(task: Task): boolean {
    if (task.finished) return false;
    if (this.disabledGateways.has(task.request.gateway!)) { this.finish(task); return false; }
    if (this.running && !this.paused && Date.now() < task.deadlineMs) return true;
    if (Date.now() >= task.deadlineMs) this.emitDeadline(task);
    this.finish(task);
    return false;
  }

  /** One terminal event per request: the last preparation failure if there was one. */
  private emitDeadline(task: Task): void {
    if (task.lastError) {
      this.emit("submit-error", `${task.lastError}; ${task.attempts} preparation attempts failed before the deadline`, task);
    } else {
      this.emit("processing-timeout", "submission deadline exceeded; no new transaction", task);
    }
  }

  private pumpScreening(): void {
    while (this.running && !this.paused && this.configurationHealthy && this.screening < this.options.screeningConcurrency && this.queue.length) {
      this.queue.sort((a, b) => a.deadlineMs - b.deadlineMs);
      const task = this.queue.shift()!;
      if (!this.canContinue(task)) continue;
      this.screening++;
      this.track(this.screen(task).finally(() => { this.screening--; this.pumpScreening(); }));
    }
  }

  private async screen(task: Task): Promise<void> {
    task.phase = "screening";
    try {
      const { request, receivedAtMs, deadlineMs, signal } = task;
      const verdict = await bounded(
        this.options.screener(request.payer, { request, receivedAtMs, deadlineMs, signal }),
        deadlineMs - Date.now(), signal,
      );
      if (!this.canContinue(task)) return;
      if (typeof verdict.passed !== "boolean" || !Number.isSafeInteger(verdict.screenedAt) ||
          verdict.screenedAt <= 0 || verdict.screenedAt > Math.floor(Date.now() / 1000)) {
        throw new Error("invalid screening verdict or timestamp");
      }
      task.verdict = verdict;
      task.phase = "ready";
      this.ready.push(task);
      this.emit("screened", `screening complete: passed=${verdict.passed}${verdict.reason ? `; ${verdict.reason}` : ""}`, task);
      this.track(this.pumpSending());
    } catch (error) {
      if (!task.finished) { this.emit("screening-error", message(error), task); this.finish(task); }
    }
  }

  private async pumpSending(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.running && !this.paused && this.configurationHealthy && this.ready.length && this.pending.size < this.options.maxPendingTransactions) {
        this.ready.sort((a, b) => a.deadlineMs - b.deadlineMs);
        // A hot Gateway may not occupy every pending slot while another is ready.
        const quota = Math.max(1, Math.ceil(this.options.maxPendingTransactions / this.gateways.length));
        const available = this.ready.findIndex(candidate => (candidate.retryAtMs ?? 0) <= Date.now() &&
          [...this.pending.values()].filter(p => p.task.request.gateway === candidate.request.gateway).length < quota);
        if (available < 0) break;
        const task = this.ready.splice(available, 1)[0];
        if (!this.canContinue(task)) continue;
        task.phase = "preparing";
        try {
          const nonce = this.nextNonce;
          // The Gateway rejects screenedAt > block.timestamp, and estimation runs on the newest block
          // this node has. With sub-second blocks and whole-second timestamps that block is often a
          // second behind the wall clock, so date the verdict by chain time. There is no lower bound.
          const head = await bounded(this.provider.getBlock("latest"), task.deadlineMs - Date.now(), task.signal);
          if (!head) throw new Error("latest block unavailable");
          const screenedAt = Math.min(task.verdict!.screenedAt, head.timestamp);
          const data = this.iface.encodeFunctionData("fulfill", [task.request.id, task.verdict!.passed, screenedAt]);
          const prepared = await bounded(this.options.signer.populateTransaction({
            to: task.request.gateway, nonce, value: 0n, chainId: this.chainId,
            data,
          }), task.deadlineMs - Date.now(), task.signal);
          if (!this.canSend(task)) continue;
          if (BigInt(prepared.chainId!) !== this.chainId ||
              String(prepared.to).toLowerCase() !== task.request.gateway!.toLowerCase() ||
              BigInt(prepared.value ?? 0) !== 0n || prepared.nonce !== nonce || prepared.data !== data) {
            throw policyError("signing policy mismatch");
          }
          task.maxFeeWei = BigInt(prepared.gasLimit ?? 0) * BigInt(prepared.maxFeePerGas ?? prepared.gasPrice ?? 0);
          if (this.options.maxTransactionFeeWei !== undefined && task.maxFeeWei > this.options.maxTransactionFeeWei) {
            throw policyError("transaction exceeds configured fee budget");
          }
          const raw = await bounded(this.options.signer.signTransaction(prepared), task.deadlineMs - Date.now(), task.signal);
          if (!this.canSend(task)) continue;
          task.maxFeeWei = BigInt(prepared.gasLimit ?? 0) * BigInt(prepared.maxFeePerGas ?? prepared.gasPrice ?? 0);
          task.nonce = nonce;
          task.txHash = keccak256(raw);
          task.phase = "submitted";
          clearTimeout(task.submitTimer);
          this.nextNonce++;
          this.pending.set(task.txHash, { task, expiresAtMs: Date.now() + this.options.receiptTimeoutMs });
          this.scheduleReceipts();
          // Hash is known before transmission. A timeout cannot cause a second fulfill.
          const broadcast = this.provider.broadcastTransaction(raw);
          this.emit("submitted", `broadcasting nonce=${nonce} hash=${task.txHash}`, task);
          await bounded(broadcast, this.options.rpcTimeoutMs);
        } catch (error) {
          if (task.finished) continue;
          if (task.phase === "submitted") this.pause(`broadcast result uncertain: ${message(error)}`, task);
          else this.retryOrFail(task, error);
        }
      }
    } finally {
      this.sending = false;
      this.scheduleRetry();
    }
  }

  /**
   * A failed preparation consumed no nonce, so it is safe to prepare again. Estimation can fail
   * transiently (RPC node behind the event, payer still funding), and the Gateway leaves retrying to
   * this listener. Policy refusals and attempts that cannot finish before the deadline are final.
   */
  private retryOrFail(task: Task, error: unknown): void {
    task.attempts++;
    task.lastError = message(error);
    const delay = this.options.preparationRetryMs * 2 ** Math.min(task.attempts - 1, 3);
    if (error && typeof error === "object" && "policy" in error) {
      this.emit("submit-error", task.lastError, task);
      this.finish(task);
    } else if (Date.now() + delay >= task.deadlineMs) {
      this.emitDeadline(task);
      this.finish(task);
    } else {
      task.phase = "ready";
      task.retryAtMs = Date.now() + delay;
      this.ready.push(task);
      this.emit("submit-retry", `${task.lastError}; preparing again in ${delay} ms`, task);
    }
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const now = Date.now();
    const waiting = this.ready.filter(task => (task.retryAtMs ?? 0) > now).map(task => task.retryAtMs!);
    if (!this.running || !waiting.length) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.track(this.pumpSending());
    }, Math.min(...waiting) - now);
  }

  private canSend(task: Task): boolean {
    if (!this.canContinue(task)) return false;
    if (this.configurationHealthy) return true;
    // No nonce is consumed before broadcast. Discard any prepared/raw transaction and rebuild after recovery.
    task.phase = "ready";
    this.ready.push(task);
    return false;
  }

  private scheduleReceipts(): void {
    if (this.receiptTimer || this.polling || !this.pending.size) return;
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = undefined;
      this.track(this.pollReceipts());
    }, this.options.receiptPollMs);
  }

  private async pollReceipts(): Promise<void> {
    this.polling = true;
    try {
      const entries = [...this.pending.entries()];
      let head: number | undefined;
      if (this.options.confirmations > 1) {
        head = await bounded(this.provider.getBlockNumber(), this.options.rpcTimeoutMs);
      }
      // Four concurrent reads at most; all requests still use the injected HTTP provider.
      for (let i = 0; i < entries.length; i += 4) {
        await Promise.all(entries.slice(i, i + 4).map(async ([hash, pending]) => {
          const { task } = pending;
          const remaining = pending.expiresAtMs - Date.now();
          if (task.finished || remaining <= 0) return;
          try {
            const receipt = await bounded(this.provider.getTransactionReceipt(hash), Math.min(this.options.rpcTimeoutMs, remaining));
            if (task.finished) return;
            if (!receipt || (head !== undefined && head - receipt.blockNumber + 1 < this.options.confirmations)) return;
            if (receipt.status === 1) {
              this.emit(task.verdict!.passed ? "executed" : "screening-rejected", "result transaction confirmed", task);
              this.finish(task);
            } else if (receipt.status === 0) {
              this.emit("execution-reverted", "result transaction reverted; no automatic resubmission", task);
              this.finish(task);
            }
          } catch { /* Query errors do not mean the transaction failed. */ }
        }));
      }
    } catch { /* A failed head query likewise does not justify a new transaction. */ }
    finally {
      for (const { task, expiresAtMs } of this.pending.values()) {
        if (Date.now() >= expiresAtMs) {
          this.pause("receipt tracking timed out; verify the recorded hash before restarting", task);
          this.finish(task);
        }
      }
      this.polling = false;
      this.track(this.pumpSending());
      this.scheduleReceipts();
    }
  }

  private pause(reason: string, task: Task): void {
    this.paused = true;
    this.emit("submission-uncertain", reason, task);
    for (const other of this.tasks) {
      if (other.phase !== "submitted") {
        this.emit("stopped", "sending paused; unsigned task abandoned", other);
        this.finish(other);
      }
    }
    this.queue = [];
    this.ready = [];
  }

  private finish(task: Task): void {
    if (task.finished) return;
    task.finished = true;
    this.activeRequests.delete(`${task.request.gateway}:${task.request.id}`);
    clearTimeout(task.submitTimer);
    clearTimeout(task.completionTimer);
    task.controller.abort();
    this.tasks.delete(task);
    this.queue = this.queue.filter(candidate => candidate !== task);
    this.ready = this.ready.filter(candidate => candidate !== task);
    if (task.txHash && this.pending.delete(task.txHash) && this.running && !this.paused) {
      this.track(this.pumpSending());
    }
    task.resolve();
  }

  private emit(type: KytAlertType, text: string, task?: Task): void {
    const event: KytAlert = { type, message: text, id: task?.request.id, payer: task?.request.payer,
      gateway: task?.request.gateway, nonce: task?.nonce, txHash: task?.txHash, elapsedMs: task ? Date.now() - task.receivedAtMs : undefined };
    try {
      if (this.options.onAlert) this.options.onAlert(event);
      else console.log(`[KYT:${type}] id=${event.id ?? ""} hash=${event.txHash ?? ""} ${text}`);
    } catch { console.error("KYT log callback failed"); }
  }
}
