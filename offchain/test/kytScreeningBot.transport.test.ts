import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { Interface, JsonRpcProvider, Transaction, Wallet, keccak256 } from "ethers";
import { expect, it } from "vitest";
import { KYT_GATEWAY_ABI, KytScreeningBot, type KytAlert } from "../src/kytScreeningBot.js";

// Real local transports and ethers signing/formatting, with simulated RPC responses.
// No external service, contract execution or real-chain transaction is involved.
it("handles a native WebSocket event through Wallet signing and HTTP receipt decoding", async () => {
  const gateway = "0x2222222222222222222222222222222222222222";
  const payer = "0x3333333333333333333333333333333333333333";
  const owner = "0x4444444444444444444444444444444444444444";
  const iface = new Interface(KYT_GATEWAY_ABI);
  const hash = `0x${"ab".repeat(32)}`;
  const transactions: Transaction[] = [];
  const methods: string[] = [];
  const alerts: KytAlert[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const calls = JSON.parse(body);
    const handle = (call: { id: number; method: string; params: any[] }) => {
      methods.push(call.method);
      let result: unknown;
      switch (call.method) {
        case "eth_chainId": result = "0x38"; break;
        case "eth_getTransactionCount": result = "0x7"; break;
        case "eth_blockNumber": result = "0x64"; break;
        case "eth_estimateGas": result = "0x7a120"; break;
        case "eth_gasPrice": result = "0x3b9aca00"; break;
        case "eth_maxPriorityFeePerGas": result = "0x3b9aca00"; break;
        case "eth_getBlockByNumber": result = {
          hash, parentHash: hash, number: "0x64", timestamp: "0x77359400",
          nonce: "0x0000000000000000", difficulty: "0x1", gasLimit: "0x1c9c380",
          gasUsed: "0x5208", miner: gateway, extraData: "0x", transactions: [],
        }; break;
        case "eth_sendRawTransaction": {
          transactions.push(Transaction.from(call.params[0]));
          result = keccak256(call.params[0]);
          break;
        }
        case "eth_getTransactionReceipt": {
          const tx = transactions.find(tx => tx.hash === call.params[0]);
          result = tx ? {
            transactionHash: tx.hash, transactionIndex: "0x0", blockHash: hash,
            blockNumber: "0x64", from: tx.from, to: gateway, contractAddress: null,
            cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
            logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x0",
          } : null;
          break;
        }
        default: return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "unexpected method" } };
      }
      return { jsonrpc: "2.0", id: call.id, result };
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(calls) ? calls.map(handle) : handle(calls)));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", ws => ws.on("message", raw => {
    const call = JSON.parse(String(raw));
    if (call.method === "eth_chainId") {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x38" }));
    } else if (call.method === "eth_subscribe") {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "native-subscription" }));
      const event = iface.encodeEventLog(iface.getEvent("ScreeningRequested")!, [11n, payer, owner, 1000n, 2_100_000_000n]);
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: {
        subscription: "native-subscription", result: { ...event, address: gateway, removed: false },
      } }));
    }
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 56, { batchMaxCount: 1, cacheTimeout: -1 });
  const signer = new Wallet(`0x${"11".repeat(32)}`, provider); // Public test-only key.
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  const screened: string[] = [];
  const bot = new KytScreeningBot({
    gateway, signer, createWebSocket: () => new WebSocket(`ws://127.0.0.1:${port}`),
    screener: async address => { screened.push(address); return { passed: true, screenedAt: Math.floor(Date.now() / 1000) }; },
    onAlert: event => { alerts.push(event); if (event.type === "executed") completed(); },
    processingWindowMs: 3000, confirmationReserveMs: 500, rpcTimeoutMs: 500,
    receiptTimeoutMs: 1500, receiptPollMs: 25,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await bot.start();
    await Promise.race([done, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`local transport timed out: ${alerts.map(event => event.type).join(",")}`)), 3500);
    })]);
    expect(screened).toEqual([payer]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].nonce).toBe(7);
    expect(transactions[0].chainId).toBe(56n);
    expect(transactions[0].from).toBe(signer.address);
    expect(iface.decodeFunctionData("fulfill", transactions[0].data).slice(0, 2)).toEqual([11n, true]);
    expect(methods).toContain("eth_estimateGas");
    expect(methods).toContain("eth_getTransactionReceipt");
    expect(methods).not.toContain("eth_getLogs");
    expect(methods).not.toContain("eth_call");
  } finally {
    clearTimeout(timeout);
    await bot.stop();
    provider.destroy();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 8000);
