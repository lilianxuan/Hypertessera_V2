import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcProvider, TransactionReceipt } from "ethers";
import { sendLocalTransaction } from "../scripts/local/transaction.js";

describe("local deployment transaction confirmation", () => {
  const tx = { hash: "0x1234", from: "0x5678", nonce: 7 };
  const receipt = { status: 1, blockNumber: 12 } as TransactionReceipt;
  const options = { timeoutMs: 100, pollMs: 10 };
  function fixture() {
    const provider = {
      getTransactionReceipt: vi.fn<JsonRpcProvider["getTransactionReceipt"]>().mockResolvedValue(receipt),
      getBlockNumber: vi.fn().mockResolvedValue(12),
      getTransactionCount: vi.fn().mockResolvedValue(8),
    };
    return { provider, send: vi.fn().mockResolvedValue(tx) };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("accepts an already-mined receipt without waiting for another block", async () => {
    const { provider, send } = fixture();
    expect(await sendLocalTransaction(provider, "setCurator", send, options)).toBe(receipt);
    expect(provider.getBlockNumber).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("polls a pending transaction until its receipt exists", async () => {
    const { provider, send } = fixture();
    provider.getTransactionReceipt.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const result = sendLocalTransaction(provider, "setCurator", send, options);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBe(receipt);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("fails on an on-chain revert and records nonce diagnostics", async () => {
    const { provider, send } = fixture();
    provider.getTransactionReceipt.mockResolvedValue({ ...receipt, status: 0 } as TransactionReceipt);
    await expect(sendLocalTransaction(provider, "setGuardian", send, options)).rejects.toThrow("failed (status=0)");
    expect(provider.getTransactionCount).toHaveBeenCalledWith(tx.from, "pending");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("times out a missing receipt without resending", async () => {
    const { provider, send } = fixture();
    provider.getTransactionReceipt.mockResolvedValue(null);
    const failed = expect(sendLocalTransaction(provider, "setRegistered", send, options)).rejects.toThrow("receipt 0x1234 timed out");
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a send that never returns and never rebroadcasts it", async () => {
    const { provider, send } = fixture();
    send.mockImplementation(() => new Promise(() => {}));
    const failed = expect(sendLocalTransaction(provider, "fund", send, options)).rejects.toThrow("send: timed out");
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(send).toHaveBeenCalledTimes(1);
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("bounds both a stalled receipt RPC and stalled diagnostics", async () => {
    const { provider, send } = fixture();
    provider.getTransactionReceipt.mockImplementation(() => new Promise(() => {}));
    provider.getBlockNumber.mockImplementation(() => new Promise(() => {}));
    provider.getTransactionCount.mockImplementation(() => new Promise(() => {}));
    const failed = expect(sendLocalTransaction(provider, "bridge", send, options)).rejects.toThrow("receipt 0x1234: timed out");
    await vi.advanceTimersByTimeAsync(2_100);
    await failed;
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates an RPC error instead of reporting a successful deployment", async () => {
    const { provider, send } = fixture();
    provider.getTransactionReceipt.mockRejectedValue(new Error("RPC disconnected"));
    await expect(sendLocalTransaction(provider, "bridge", send, options)).rejects.toThrow("RPC disconnected");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
