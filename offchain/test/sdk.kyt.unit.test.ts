import { describe, expect, it, vi } from "vitest";
import { Interface, ZeroAddress } from "ethers";
import { readFileSync } from "node:fs";
import { getAbi } from "../src/abis.js";
import { HyperTesseraSDK } from "../src/sdk.js";

const V = "0x0000000000000000000000000000000000000001";
const G = "0x0000000000000000000000000000000000000002";
const A = "0x0000000000000000000000000000000000000003";
const O = "0x0000000000000000000000000000000000000004";
const OTHER = "0x0000000000000000000000000000000000000005";
const HASH = "0x" + "ab".repeat(32);
const iface = new Interface(getAbi("KYTDepositGateway"));
function log(name: string, values: unknown[], address = G) {
  return { ...iface.encodeEventLog(iface.getEvent(name)!, values), address };
}
function setup() {
  const vault = { gate: vi.fn(async () => G), usdt: vi.fn(async () => A) };
  const receipt = { hash: HASH, logs: [log("ScreeningRequested", [17n, O, O, 10n, 3600n])] };
  const write = vi.fn(async () => ({ hash: HASH, wait: async () => receipt }));
  const gateway = { interface: iface, vault: vi.fn(async () => V), asset: vi.fn(async () => A),
    oracle: vi.fn(async () => O), validityPeriod: vi.fn(async () => 3600n),
    getRequest: vi.fn(async () => ({ payer: O, owner: O, assets: 10n, requestedAt: 1n, expiresAt: 3600n, state: 1 })),
    connect: () => ({ getFunction: () => write }) };
  const sdk = new HyperTesseraSDK({} as never, {} as never);
  const get = vi.spyOn(sdk, "getContract").mockImplementation(((name: string) => name === "EarnVault" ? vault : gateway) as never);
  const signer = { getAddress: async () => O } as never;
  return { sdk, vault, gateway, receipt, write, get, signer };
}

describe("KYT public ABI and SDK", () => {
  it("ships the same generated ABI in both browser bundles and exposes three-argument fulfill", () => {
    const json = JSON.parse(readFileSync(new URL("../../control-panel/abis.json", import.meta.url), "utf8"));
    const js = readFileSync(new URL("../../control-panel/abis.js", import.meta.url), "utf8");
    expect(JSON.parse(js.slice(js.indexOf("=") + 1).trim().replace(/;$/, ""))).toEqual(json);
    expect(iface.getFunction("fulfill")!.inputs.map(i => i.type)).toEqual(["uint256", "bool", "uint64"]);
    expect(iface.getEvent("DepositExecuted")!.inputs[1].name).toBe("vaultRequestId");
  });
  it("uses a zero on-chain gate for direct deposits, without touching a Gateway", async () => {
    const s = setup(); s.vault.gate.mockResolvedValue(ZeroAddress);
    expect(await s.sdk.getVaultDepositRoute(V)).toEqual({ mode: "direct", vault: V, asset: A, gateway: null });
    expect(s.gateway.vault).not.toHaveBeenCalled();
  });
  it("discovers the current Gateway without a preconfigured address entry", async () => {
    const s = setup();
    expect(await s.sdk.getVaultDepositRoute(V)).toEqual({ mode: "kyt", vault: V, asset: A, gateway: G });
    expect(s.get).toHaveBeenCalledWith("KYTDepositGateway", G);
  });
  it.each(["vault", "asset"] as const)("rejects a mismatching Gateway %s", async field => {
    const s = setup(); s.gateway[field].mockResolvedValue(OTHER);
    await expect(s.sdk.getVaultDepositRoute(V)).rejects.toThrow("binding mismatch");
  });
  it("propagates RPC/interface failures instead of downgrading to direct", async () => {
    const s = setup(); s.gateway.vault.mockRejectedValue(new Error("no compatible method"));
    await expect(s.sdk.getVaultDepositRoute(V)).rejects.toThrow("no compatible method");
  });
  it("rejects unsupported configuration", async () => {
    const s = setup(); s.gateway.validityPeriod.mockResolvedValue(1n);
    await expect(s.sdk.getVaultDepositRoute(V)).rejects.toThrow("Unsupported");
  });
  it("returns chain state and expiry without converting pending requests into rejected ones", async () => {
    const s = setup();
    expect(await s.sdk.getKytRequest(G, 17n)).toMatchObject({ id: 17n, state: 1, expiresAt: 3600n });
    s.gateway.getRequest.mockResolvedValue({ payer: O, owner: O, assets: 0n, requestedAt: 0n, expiresAt: 0n, state: 0 });
    expect((await s.sdk.getKytRequest(G, 99n)).state).toBe(0);
  });
  it("ignores identical event topics from foreign emitters and separates the two ID namespaces", () => {
    const s = setup();
    const rows = s.sdk.parseKytEvents(G, { logs: [
      log("DepositExecuted", [17n, 92n, O, 10n, 30n], OTHER),
      log("DepositExecuted", [17n, 92n, O, 10n, 30n]),
      log("ScreeningRejected", [18n, O, 30n, 31n]), log("RequestCancelled", [19n, O, 32n]),
    ] });
    expect(rows).toEqual([
      { name: "DepositExecuted", screeningRequestId: 17n, vaultRequestId: 92n, owner: O, assets: 10n, screenedAt: 30n },
      { name: "ScreeningRejected", screeningRequestId: 18n, payer: O, screenedAt: 30n, timestamp: 31n },
      { name: "RequestCancelled", screeningRequestId: 19n, payer: O, timestamp: 32n },
    ]);
  });
  it("uses the mined ScreeningRequested ID and does not invent a Vault request ID", async () => {
    const s = setup();
    expect(await s.sdk.requestKytDeposit(G, 10n, O, s.signer)).toEqual({ hash: HASH, receipt: s.receipt, screeningRequestId: 17n });
    expect(s.write).toHaveBeenCalledTimes(1);
    expect(s.write).toHaveBeenCalledWith(10n, O);
  });
  it("rechecks the active Gate before sending", async () => {
    const s = setup(); s.vault.gate.mockResolvedValue(ZeroAddress);
    await expect(s.sdk.requestKytDeposit(G, 10n, O, s.signer)).rejects.toThrow("not the active");
    expect(s.write).not.toHaveBeenCalled();
  });
  it.each([{ logs: [] }, { logs: [log("ScreeningRequested", [17n, OTHER, O, 10n, 3600n])] }])("preserves the broadcast hash on ambiguous receipts, without resubmitting", async ({ logs }) => {
    const s = setup(); s.receipt.logs = logs;
    await expect(s.sdk.requestKytDeposit(G, 10n, O, s.signer)).rejects.toMatchObject({ code: "KYT_RECEIPT_UNRESOLVED", txHash: HASH });
    expect(s.write).toHaveBeenCalledTimes(1);
  });
  it("rejects a signer attached to a different network", async () => {
    const sdk = new HyperTesseraSDK({} as never, { provider: { getNetwork: async () => ({ chainId: 56n }) } } as never);
    await expect(sdk.requestKytDeposit(G, 10n, O, { provider: { getNetwork: async () => ({ chainId: 97n }) } } as never))
      .rejects.toThrow("network mismatch");
  });
});
