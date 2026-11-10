import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { Interface, Transaction, Wallet, keccak256, type Provider } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { readConfig, runService, RunnerError, RpcReadError, isRecoverableReadError, recoverStartupReads, watchDeploymentHealth } from "../scripts/runKytScreening.js";
import { KYT_GATEWAY_ABI } from "../src/kytScreeningBot.js";

const gateway = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const vault = "0x4444444444444444444444444444444444444444";
const asset = "0x5555555555555555555555555555555555555555";
const key = `0x${"11".repeat(32)}`; // Public test fixture, not a funded account.
const oracle = new Wallet(key).address;
const iface = new Interface(KYT_GATEWAY_ABI);
const getters = new Interface([
  "function oracle() view returns (address)", "function vault() view returns (address)",
  "function asset() view returns (address)", "function usdt() view returns (address)",
  "function gate() view returns (address)",
]);

it("aborts HTTP startup validation immediately when stopped before the bot exists", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  let stopAt = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    methods.push(call.method);
    if (call.method === "eth_getCode") {
      if (!stopAt) { stopAt = Date.now(); controller.abort(); }
      return; // Simulate a node that never completes the startup read.
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x7a69" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const config = readConfig({
    KYT_ENV: "local", KYT_CHAIN_ID: "31337", KYT_SCREENER: "allow",
    RPC_URL: `http://127.0.0.1:${port}`, WSS_URL: `ws://127.0.0.1:${port}`,
    KYT_GATEWAY: gateway, KYT_VAULT: vault, KYT_ASSET: asset,
    KYT_ORACLE_PK: key, KYT_RPC_RPS: "100", KYT_RPC_TIMEOUT_MS: "2000",
  }, []);
  try {
    expect(await runService(config, controller.signal, () => {})).toBe(0);
    expect(stopAt).toBeGreaterThan(0);
    expect(Date.now() - stopAt).toBeLessThan(1000);
    expect(methods).not.toContain("eth_call");
    expect(methods).not.toContain("eth_sendRawTransaction");
  } finally {
    controller.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);

const readOutages = [
  {name: "409", code: "KYT_RPC_HTTP_409", httpStatus: 409},
  {name: "425", code: "KYT_RPC_HTTP_425", httpStatus: 425},
  {name: "502", code: "KYT_RPC_HTTP_502", httpStatus: 502},
  {name: "invalid-json", code: "KYT_RPC_INVALID_JSON"},
  {name: "invalid-envelope", code: "KYT_RPC_INVALID_RESPONSE"},
  {name: "invalid-result", code: "KYT_RPC_INVALID_RESULT"},
  {name: "invalid-abi", code: "KYT_RPC_INVALID_RESULT"},
  {name: "rpc-internal", code: "KYT_RPC_SERVER_ERROR", rpcErrorCode: -32603},
  {name: "rpc-server", code: "KYT_RPC_SERVER_ERROR", rpcErrorCode: -32000},
  {name: "rpc-vendor", code: "KYT_RPC_UPSTREAM_ERROR", rpcErrorCode: -33000},
] as const;

// Real localhost HTTP/WSS, native WebSocket and ethers signing; simulated chain only.
for (const scenario of ["confirmed", "uncertain-broadcast", "uncertain-broadcast409", "wrong-oracle", "wrong-gate", "wrong-http-chain", "wrong-wss-chain", "startup-wss-drift", "startup-nonce-timeout", "health-409-persistent",
  ...readOutages.flatMap(outage => [`health-${outage.name}`, `startup-${outage.name}`])]) {
  it(`runner lifecycle over native transports: ${scenario}`, async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    const transactions: Transaction[] = [];
    const logs: Record<string, unknown>[] = [];
    let subscriptions = 0;
    let started = false;
    const outage = readOutages.find(outage => scenario === `startup-${outage.name}` || scenario === `health-${outage.name}`);
    const healthOutage = scenario.startsWith("health-");
    const persistent = scenario === "health-409-persistent";
    let injected = false;
    let requestSent = false;
    let oracleDrift = false;
    const blockHash = `0x${"ab".repeat(32)}`;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const call = JSON.parse(body);
      methods.push(call.method);
      // ethers schedules this HTTP request after the bot's outer startup deadline begins.
      // A stalled read must retain its read provenance even when that outer timer wins.
      if (scenario === "startup-nonce-timeout" && call.method === "eth_getTransactionCount" && !injected) {
        injected = true;
        return;
      }
      if ((!injected || persistent) && call.method === (outage?.name === "invalid-abi" ? "eth_call" : "eth_getCode") &&
          ((outage && scenario.startsWith("startup-")) || (healthOutage && started))) {
        injected = true;
        if (persistent || (outage && "httpStatus" in outage)) {
          res.statusCode = persistent ? 409 : (outage as {httpStatus: number}).httpStatus;
          res.end("sensitive upstream body rpc-secret"); return;
        }
        if (outage?.name === "invalid-json") { res.end("invalid upstream JSON rpc-secret"); return; }
        res.setHeader("content-type", "application/json");
        if (outage && "rpcErrorCode" in outage) {
          res.end(JSON.stringify({jsonrpc: "2.0", id: call.id, error: {code: outage.rpcErrorCode, message: "sensitive upstream message rpc-secret"}}));
        } else if (outage?.name === "invalid-envelope") {
          res.end(JSON.stringify({jsonrpc: "2.0", id: -1, result: "0x6000"}));
        } else {
          res.end(JSON.stringify({jsonrpc: "2.0", id: call.id, result: outage?.name === "invalid-abi" ? "0x" : {unexpected: "rpc-secret"}}));
        }
        return;
      }
      let result: unknown;
      switch (call.method) {
        case "eth_chainId": result = scenario === "wrong-http-chain" ? "0x38" : "0x7a69"; break;
        case "eth_getCode": result = "0x6000"; break;
        case "eth_call": {
          const name = getters.parseTransaction({ data: call.params[0].data })!.name;
          const values: Record<string, string> = {
            oracle: scenario === "wrong-oracle" || oracleDrift ? payer : oracle,
            vault, asset, usdt: asset, gate: scenario === "wrong-gate" ? vault : gateway,
          };
          result = getters.encodeFunctionResult(name, [values[name]]); break;
        }
        case "eth_getTransactionCount": result = "0x7"; break;
        case "eth_blockNumber": result = "0x64"; break;
        case "eth_estimateGas": result = "0x7a120"; break;
        case "eth_gasPrice": result = "0x3b9aca00"; break;
        case "eth_maxPriorityFeePerGas": result = "0x3b9aca00"; break;
        case "eth_getBlockByNumber": result = {
          hash: blockHash, parentHash: blockHash, number: "0x64", timestamp: "0x77359400",
          nonce: "0x0000000000000000", difficulty: "0x1", gasLimit: "0x1c9c380",
          gasUsed: "0x5208", miner: gateway, extraData: "0x", transactions: [],
        }; break;
        case "eth_sendRawTransaction": {
          transactions.push(Transaction.from(call.params[0]));
          if (scenario === "uncertain-broadcast") { res.destroy(); return; }
          if (scenario === "uncertain-broadcast409") { res.statusCode = 409; res.end("sensitive broadcast body"); return; }
          result = keccak256(call.params[0]); break;
        }
        case "eth_getTransactionReceipt": {
          const tx = transactions.find(tx => tx.hash === call.params[0]);
          result = tx ? {
            transactionHash: tx.hash, transactionIndex: "0x0", blockHash, blockNumber: "0x64",
            from: tx.from, to: gateway, contractAddress: null, cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", logs: [],
            logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x0",
          } : null; break;
        }
        default: res.statusCode = 400; res.end("unexpected method"); return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
    const wss = new WebSocketServer({ server });
    const sendRequest = () => {
      const event = iface.encodeEventLog(iface.getEvent("ScreeningRequested")!, [11n, payer, payer, 1000n, 2_100_000_000n]);
      for (const ws of wss.clients) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: {
        subscription: "test-subscription", result: { ...event, address: gateway, removed: false },
      } }));
    };
    wss.on("connection", ws => ws.on("message", raw => {
      const call = JSON.parse(String(raw));
      if (call.method === "eth_chainId") {
        if (scenario === "startup-wss-drift" && !oracleDrift) {
          oracleDrift = true;
          ws.send(JSON.stringify({jsonrpc: "2.0", id: call.id, error: {code: -32603, message: "temporary upstream read failure"}}));
        } else ws.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: scenario === "wrong-wss-chain" ? "0x38" : "0x7a69" }));
      }
      else if (call.method === "eth_subscribe") {
        subscriptions++;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "test-subscription" }));
        if (!healthOutage) sendRequest();
      }
    }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const config = readConfig({
      KYT_ENV: "local", KYT_CHAIN_ID: "31337", KYT_SCREENER: "allow",
      RPC_URL: `http://127.0.0.1:${port}/rpc-secret`, WSS_URL: `ws://127.0.0.1:${port}/wss-secret`,
      KYT_GATEWAY: gateway, KYT_VAULT: vault, KYT_ASSET: asset, KYT_ORACLE_PK: key, KYT_RPC_RPS: "100",
      KYT_PROCESSING_WINDOW_MS: "4000", KYT_CONFIRMATION_RESERVE_MS: "1000", KYT_RPC_TIMEOUT_MS: "500",
      KYT_RECEIPT_TIMEOUT_MS: "1500", KYT_RECEIPT_POLL_MS: "50",
    }, []);
    const safety = setTimeout(() => controller.abort(), 6000);
    try {
      const code = await runService(config, controller.signal, entry => {
        logs.push(entry);
        if (entry.type === "ready") started = true;
        if (healthOutage && entry.type === "connection-error" && entry.component === "kyt-health" && !requestSent) {
          expect(transactions).toHaveLength(0);
          requestSent = true;
          sendRequest();
        }
        if (persistent && entry.type === "processing-timeout") controller.abort();
        if (entry.type === "executed" && !scenario.startsWith("uncertain-broadcast")) controller.abort();
      });
      if (scenario === "wrong-oracle" || scenario === "wrong-gate" || scenario === "wrong-wss-chain" || scenario === "wrong-http-chain" || scenario === "startup-wss-drift") {
        expect(code).toBe(1);
        expect(logs).toContainEqual(expect.objectContaining({ type: "startup-error", code: scenario === "wrong-oracle" || scenario === "startup-wss-drift" ? "KYT_ORACLE_MISMATCH" : scenario === "wrong-gate" ? "KYT_GATE_MISMATCH" : "KYT_CHAIN_MISMATCH" }));
        expect(subscriptions).toBe(scenario === "startup-wss-drift" ? 1 : 0);
        expect(transactions).toHaveLength(0);
        expect(logs.some(log => log.type === "ready")).toBe(false);
      } else if (persistent) {
        expect(code).toBe(0);
        expect(transactions).toHaveLength(0);
        expect(logs).toContainEqual(expect.objectContaining({type: "processing-timeout"}));
        expect(logs.filter(log => log.type === "health").every(log => log.ready === false)).toBe(true);
        expect(logs.some(log => log.type === "screened")).toBe(false);
        expect(logs.some(log => log.type === "health-recovered")).toBe(false);
      } else {
        expect(code).toBe(scenario.startsWith("uncertain-broadcast") ? 1 : 0);
        expect(transactions).toHaveLength(1);
        expect(transactions[0].nonce).toBe(7);
        expect(transactions[0].chainId).toBe(31337n);
        expect(iface.decodeFunctionData("fulfill", transactions[0].data).slice(0, 2)).toEqual([11n, true]);
        expect(logs.some(log => log.type === "executed")).toBe(true);
        if (scenario.startsWith("uncertain-broadcast")) expect(logs.some(log => log.type === "submission-uncertain")).toBe(true);
        if (healthOutage) {
          expect(logs).toContainEqual(expect.objectContaining({type: "health", ready: false}));
          expect(logs).toContainEqual(expect.objectContaining({type: "health-recovered", failures: 1}));
        }
        if (outage) {
          expect(logs).toContainEqual(expect.objectContaining({type: "connection-error", component: healthOutage ? "kyt-health" : "kyt-startup",
            code: outage.code, rpcMethod: outage.name === "invalid-abi" ? "eth_call" : "eth_getCode",
            ...("httpStatus" in outage ? {httpStatus: outage.httpStatus} : {}),
            ...("rpcErrorCode" in outage ? {rpcErrorCode: outage.rpcErrorCode} : {})}));
          expect(logs.some(log => log.type === "configuration-error")).toBe(false);
        }
        if (scenario === "startup-nonce-timeout") {
          expect(logs).toContainEqual(expect.objectContaining({type: "connection-error", component: "kyt-startup",
            code: "TIMEOUT", rpcMethod: "eth_getTransactionCount"}));
          expect(methods.filter(method => method === "eth_getTransactionCount")).toHaveLength(2);
          expect(logs.some(log => log.type === "startup-error")).toBe(false);
        }
      }
      expect(logs.at(-1)).toMatchObject({ type: "service-stopped", exitCode: code });
      expect(methods).not.toContain("eth_getLogs");
      const serialized = JSON.stringify(logs, (_, value) => typeof value === "bigint" ? value.toString() : value);
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain("rpc-secret");
      expect(serialized).not.toContain("wss-secret");
    } finally {
      clearTimeout(safety); controller.abort();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 10_000);
}

function healthFixture() {
  const config = readConfig({KYT_ENV: "local", KYT_CHAIN_ID: "31337", KYT_SCREENER: "allow",
    RPC_URL: "http://127.0.0.1/rpc-secret", WSS_URL: "ws://127.0.0.1/wss-secret",
    KYT_GATEWAY: gateway, KYT_VAULT: vault, KYT_ASSET: asset, KYT_ORACLE_PK: key, KYT_RPC_RPS: "100"}, []);
  const provider = {
    getNetwork: vi.fn(async () => ({chainId: 31337n})),
    getCode: vi.fn(async () => "0x6000"),
    call: vi.fn(async (tx: {data: string}) => {
      const name = getters.parseTransaction({data: tx.data})!.name;
      return getters.encodeFunctionResult(name, [name === "oracle" ? oracle : name === "vault" ? vault :
        name === "gate" ? gateway : asset]);
    }),
  };
  let healthy = true;
  const disabled = new Set<string>();
  const bot = {
    setConfigurationHealthy: vi.fn((value: boolean) => { healthy = value; }),
    disableGateway: vi.fn((value: string) => { disabled.add(value); }),
    health: () => ({ready: healthy && !disabled.size, configurationHealthy: healthy}),
  };
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const fatal = vi.fn();
  return {config, provider, bot, logs, controller, fatal, run: () => watchDeploymentHealth(config,
    provider as unknown as Provider, new Wallet(key), bot, controller.signal, entry => logs.push(entry), fatal)};
}

describe("deployment health recovery", () => {
  it.each(["KYT_RPC_HTTP_409", "KYT_RPC_HTTP_502", "KYT_RPC_HTTP_429", "KYT_RPC_HTTP_504", "KYT_RPC_TIMEOUT", "KYT_RPC_TRANSPORT_ERROR"])(
    "suspends and recovers from %s without terminating the runner", async code => {
      vi.useFakeTimers();
      const f = healthFixture();
      f.provider.getCode.mockRejectedValueOnce(new RpcReadError(code, "eth_getCode"));
      const work = f.run();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(f.logs).toContainEqual(expect.objectContaining({type: "health", ready: false, configurationReadFailures: 1}));
        expect(f.fatal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.logs).toContainEqual(expect.objectContaining({type: "health-recovered", failures: 1}));
        expect(f.logs.at(-1)).toMatchObject({type: "health", ready: true, configurationReadFailures: 0});
        expect(f.bot.disableGateway).not.toHaveBeenCalled();
        expect(JSON.stringify(f.logs)).not.toContain(key);
        expect(JSON.stringify(f.logs)).not.toContain("rpc-secret");
      } finally { f.controller.abort(); await work; vi.useRealTimers(); }
    });

  it("retries sustained outages with capped backoff and fresh not-ready heartbeats", async () => {
    vi.useFakeTimers();
    const f = healthFixture();
    f.provider.getCode.mockRejectedValue(new RpcReadError("KYT_RPC_HTTP_409", "eth_getCode", {httpStatus: 409}));
    const work = f.run();
    try {
      await vi.advanceTimersByTimeAsync(121000);
      const failures = f.logs.filter(l => l.type === "connection-error");
      expect(failures.map(l => l.retryInMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
      expect(f.logs.filter(l => l.type === "health").every(l => l.ready === false)).toBe(true);
      expect(f.fatal).not.toHaveBeenCalled();
      f.provider.getCode.mockResolvedValue("0x6000");
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.logs.at(-1)).toMatchObject({ready: true, configurationReadFailures: 0});
    } finally { f.controller.abort(); await work; vi.useRealTimers(); }
  });

  it.each(["KYT_RPC_HTTP_401", "KYT_RPC_HTTP_403", "KYT_RPC_HTTP_404", "KYT_RPC_INVALID_RESPONSE", "KYT_UNEXPECTED_ERROR"])(
    "keeps non-transient failure %s fail-stop", async code => {
      const f = healthFixture();
      f.provider.getCode.mockRejectedValue(new RunnerError(code));
      await f.run();
      expect(f.fatal).toHaveBeenCalledTimes(1);
      expect(f.logs.at(-1)).toMatchObject({type: "configuration-error", code});
      expect(f.bot.health()).toMatchObject({ready: false});
    });

  it("fails closed on the wrong HTTP chain", async () => {
    const f = healthFixture(); f.provider.getNetwork.mockResolvedValue({chainId: 56n});
    await f.run();
    expect(f.logs.at(-1)).toMatchObject({type: "configuration-error", code: "KYT_CHAIN_MISMATCH"});
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.provider.getCode).not.toHaveBeenCalled();
  });

  it("does not classify arbitrary exceptions by upstream-looking codes", async () => {
    for (const error of [new TypeError("bug"), new Error("bug"), Object.assign(new Error("bug"), {code: "BAD_DATA"}),
      new RunnerError("KYT_RPC_HTTP_409"), new RunnerError("KYT_RPC_TRANSPORT_ERROR")]) {
      expect(isRecoverableReadError(error)).toBe(false);
    }
    const f = healthFixture(); f.provider.getCode.mockRejectedValue(new TypeError("programming error"));
    await f.run();
    expect(f.fatal).toHaveBeenCalledTimes(1);
    expect(f.logs.at(-1)).toMatchObject({type: "configuration-error", code: "KYT_UNEXPECTED_ERROR"});
  });

  it("isolates real Gateway configuration drift instead of retrying it as an outage", async () => {
    vi.useFakeTimers();
    const f = healthFixture();
    f.provider.call.mockImplementation(async tx => {
      const name = getters.parseTransaction({data: tx.data})!.name;
      return getters.encodeFunctionResult(name, [name === "vault" ? vault : name === "gate" ? gateway : asset]);
    });
    const work = f.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.bot.disableGateway).toHaveBeenCalledWith(gateway);
      expect(f.logs).toContainEqual(expect.objectContaining({type: "gateway-disabled", code: "KYT_ORACLE_MISMATCH"}));
      expect(f.logs.at(-1)).toMatchObject({type: "health", ready: false});
      expect(f.fatal).not.toHaveBeenCalled();
    } finally { f.controller.abort(); await work; vi.useRealTimers(); }
  });

  it("retries read-only startup and cancels backoff immediately on shutdown", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValueOnce(new RpcReadError("KYT_RPC_HTTP_409", "eth_getCode")).mockResolvedValue(undefined);
    try {
      const work = recoverStartupReads(operation, controller.signal, () => {}, 143);
      await vi.advanceTimersByTimeAsync(1000); await work;
      expect(operation).toHaveBeenCalledTimes(2);
      operation.mockRejectedValue(new RpcReadError("KYT_RPC_TIMEOUT", "eth_getCode"));
      const stopped = recoverStartupReads(operation, controller.signal, () => {}, 143);
      await vi.advanceTimersByTimeAsync(0); controller.abort(); await stopped;
      const count = operation.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(operation).toHaveBeenCalledTimes(count);
    } finally { controller.abort(); vi.useRealTimers(); }
  });
});
