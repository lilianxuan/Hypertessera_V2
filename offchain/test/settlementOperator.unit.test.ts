import { getBytes, Wallet, verifyMessage } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { SettlementOperator } from "../src/settlementOperator.js";
import type { HyperTesseraSDK } from "../src/sdk.js";

describe("SettlementOperator.assembleInstruction", () => {
  it("builds a SettlementInstruction from per-vault calc inputs with a future validUntil", () => {
    // assembleInstruction doesn't touch the chain, so a `null as any` SDK stub is fine here.
    const operator = new SettlementOperator(null as any, { operatorSigners: [] });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const instruction = operator.assembleInstruction(3n, [
      {
        vault: "0x0000000000000000000000000000000000dEaD",
        amount: 1_000_000n,
        deposits: [
          { requestId: 1n, settleAmount: 100n },
          { requestId: 2n, settleAmount: 200n },
        ],
        redeems: [{ requestId: 3n, settleAmount: 300n }],
      },
    ]);

    expect(instruction.cycleNumber).toBe(3n);
    expect(instruction.vaultSettlements).toHaveLength(1);
    expect(instruction.vaultSettlements[0].distribution).toEqual({
      vault: "0x0000000000000000000000000000000000dEaD",
      amount: 1_000_000n,
    });
    expect(instruction.vaultSettlements[0].deposits).toEqual([
      { requestId: 1n, settleAmount: 100n },
      { requestId: 2n, settleAmount: 200n },
    ]);
    expect(instruction.validUntil).toBeGreaterThan(BigInt(nowSeconds));
  });

  it("respects a custom validitySeconds option", () => {
    const shortLived = new SettlementOperator(null as any, { operatorSigners: [], validitySeconds: 10 });
    const longLived = new SettlementOperator(null as any, { operatorSigners: [], validitySeconds: 10_000 });

    const shortInstruction = shortLived.assembleInstruction(1n, []);
    const longInstruction = longLived.assembleInstruction(1n, []);

    expect(longInstruction.validUntil).toBeGreaterThan(shortInstruction.validUntil);
  });
});

describe("SettlementOperator.collectSignatures", () => {
  it("has every configured operator sign the SDK-computed batch hash", async () => {
    const batchHash = "0x" + "ab".repeat(32);
    const sdkStub = { hashInstruction: vi.fn().mockResolvedValue(batchHash) } as unknown as HyperTesseraSDK;
    const signers = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
    const operator = new SettlementOperator(sdkStub, { operatorSigners: signers });

    const instruction = operator.assembleInstruction(1n, []);
    const signatures = await operator.collectSignatures(instruction);

    expect(sdkStub.hashInstruction).toHaveBeenCalledWith(instruction);
    expect(signatures).toHaveLength(3);
    // Each signature must recover to its signer over the eth_sign-prefixed batch hash bytes —
    // this must match Settlement.sol's ECDSA.recover(toEthSignedMessageHash(hash)) exactly, or
    // valid Company-authorized batches would be rejected on-chain.
    signatures.forEach((sig, i) => {
      expect(verifyMessage(getBytes(batchHash), sig)).toBe(signers[i].address);
    });
  });

  it("returns no signatures when no operators are configured", async () => {
    const sdkStub = { hashInstruction: vi.fn().mockResolvedValue("0x" + "00".repeat(32)) } as unknown as HyperTesseraSDK;
    const operator = new SettlementOperator(sdkStub, { operatorSigners: [] });
    const signatures = await operator.collectSignatures(operator.assembleInstruction(1n, []));
    expect(signatures).toEqual([]);
  });
});

describe("SettlementOperator.submit retry/backoff", () => {
  it("retries transient submission failures and eventually succeeds", async () => {
    let calls = 0;
    const sdkStub = {
      submitBatch: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls < 3) throw new Error("transient RPC error");
        return { hash: "0xsuccess" };
      }),
    } as unknown as HyperTesseraSDK;
    const operator = new SettlementOperator(sdkStub, { operatorSigners: [], maxRetries: 5, baseRetryDelayMs: 1 });

    const relayer = Wallet.createRandom();
    const instruction = operator.assembleInstruction(1n, []);
    const result = await operator.submit(instruction, [], relayer as any);

    expect(result).toEqual({ hash: "0xsuccess" });
    expect(calls).toBe(3);
  });

  it("rethrows after exhausting maxRetries", async () => {
    const failure = new Error("permanently broken");
    const sdkStub = { submitBatch: vi.fn().mockRejectedValue(failure) } as unknown as HyperTesseraSDK;
    const operator = new SettlementOperator(sdkStub, { operatorSigners: [], maxRetries: 2, baseRetryDelayMs: 1 });

    const relayer = Wallet.createRandom();
    const instruction = operator.assembleInstruction(1n, []);

    await expect(operator.submit(instruction, [], relayer as any)).rejects.toThrow("permanently broken");
    // Initial attempt + maxRetries retries.
    expect(sdkStub.submitBatch).toHaveBeenCalledTimes(3);
  });
});

describe("SettlementOperator.run", () => {
  it("pipes assemble -> sign -> submit in order with consistent data", async () => {
    const batchHash = "0x" + "cd".repeat(32);
    const submitBatch = vi.fn().mockResolvedValue({ hash: "0xdone" });
    const sdkStub = {
      hashInstruction: vi.fn().mockResolvedValue(batchHash),
      submitBatch,
    } as unknown as HyperTesseraSDK;
    const signer = Wallet.createRandom();
    const operator = new SettlementOperator(sdkStub, { operatorSigners: [signer], baseRetryDelayMs: 1 });
    const relayer = Wallet.createRandom();

    const vaults = [
      { vault: "0x0000000000000000000000000000000000dEaD" as const, amount: 1n, deposits: [], redeems: [] },
    ];
    const result = await operator.run(7n, vaults, relayer as any);

    expect(result).toEqual({ hash: "0xdone" });
    const [passedInstruction, passedSignatures, passedRelayer] = submitBatch.mock.calls[0];
    expect(passedInstruction.cycleNumber).toBe(7n);
    expect(passedInstruction.vaultSettlements[0].distribution.vault).toBe(vaults[0].vault);
    expect(passedSignatures).toHaveLength(1);
    expect(verifyMessage(getBytes(batchHash), passedSignatures[0])).toBe(signer.address);
    expect(passedRelayer).toBe(relayer);
  });
});

