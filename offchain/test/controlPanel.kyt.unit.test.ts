import { describe, expect, it, vi } from "vitest";
import * as ethers from "ethers";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { getAbi } from "../src/abis.js";

const scope: any = {};
runInNewContext(readFileSync(new URL("../../control-panel/kyt.js", import.meta.url), "utf8"), scope);
const V = "0x0000000000000000000000000000000000000001", G = "0x0000000000000000000000000000000000000002";
const A = "0x0000000000000000000000000000000000000003", O = "0x0000000000000000000000000000000000000004";
const T = "0x0000000000000000000000000000000000000005", M = "0x0000000000000000000000000000000000000006";
const ID = "0x" + "12".repeat(32), HASH = "0x" + "ab".repeat(32);
function fixture() {
  const receipt = { hash: HASH, logs: [] as any[] };
  const write = (fn?: () => void) => vi.fn(async () => { fn?.(); return { wait: async () => receipt }; });
  let gate = ethers.ZeroAddress;
  const vault = { interface: new ethers.Interface(getAbi("EarnVault")), gate: vi.fn(async () => gate), usdt: async () => A,
    owner: async () => O, stateManager: async () => M, vaultTimelock: async () => T, isOperator: vi.fn(async () => false),
    setGate: vi.fn(async (g: string) => { gate = g; return { wait: async () => receipt }; }),
    setOperator: write(), requestDeposit: write() };
  const gateway = { interface: new ethers.Interface(getAbi("KYTDepositGateway")), vault: async () => V, asset: async () => A,
    admin: async () => O, oracle: async () => O, validityPeriod: async () => 3600n,
    setOracle: write(), setValidityPeriod: write(), transferAdmin: write(), requestDeposit: write(),
    getRequest: async () => ({ state: 1n, expiresAt: 50n, requestedAt: 1n, owner: O, payer: O, assets: 10n }) };
  const manager = { getProductState: vi.fn(async () => 0n) };
  const pending = { target: V, data: vault.interface.encodeFunctionData("setGate", [G]), proposer: O,
    executableAfter: 200n, expiresAt: 300n, executed: false, cancelled: false };
  const tl = { interface: new ethers.Interface(getAbi("VaultTimelock")), vault: async () => V,
    pendingChanges: async () => pending, pendingChangeCount: async () => 1n, pendingChangesPaged: async () => [ID],
    executeParamChange: write(() => { gate = G; }), cancelParamChange: write(), scheduleParamChange: write() };
  const token = { allowance: vi.fn(async () => 0n), approve: write() };
  const provider = { getNetwork: vi.fn(async () => ({ chainId: 56n })), getBlock: vi.fn(async () => ({ timestamp: 100 })) };
  const signer = { getAddress: vi.fn(async () => O) };
  const contracts: any = { EarnVault: vault, KYTDepositGateway: gateway, StateManager: manager, VaultTimelock: tl, ERC20: token };
  const client = scope.HT_KYT.createClient({ ethers, abis: {}, provider, signer, chainId: 56, contractAt: (name: string) => contracts[name] });
  const emit = (name: string, event: string, args: any[], address: string) => {
    const iface = contracts[name].interface;
    receipt.logs = [{ ...iface.encodeEventLog(iface.getEvent(event), args), address }];
  };
  return { client, vault, gateway, manager, tl, token, provider, signer, pending, emit, receipt, setGate: (g: string) => { gate = g; } };
}
describe("Control panel KYT routing", () => {
  it("does not mix another chain's deployment files into the configured panel", async () => {
    const html = readFileSync(new URL("../../control-panel/index.html", import.meta.url), "utf8");
    const win = new Window({ url: "http://127.0.0.1/" });
    win.document.write(html);
    const deployments = { chainId: 56, addresses: { CashVault: V, StateManager: M } };
    (win as any).HT_DEPLOYMENTS = deployments;
    (win as any).HT_ABIS = JSON.parse(readFileSync(new URL("../../control-panel/abis.json", import.meta.url), "utf8"));
    const env = { window: win, document: win.document, ethers, localStorage: win.localStorage,
      fetch: async () => ({ json: async () => ({ chainId: 31337, addresses: { StateManager: G },
        vault: { label: "cash", vault: G, adapter: A, timelock: T } }) }) };
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1].replace(/boot\(\);\s*$/, "");
    runInNewContext(script, env);
    await runInNewContext("boot()", env);
    expect(deployments.addresses).toEqual({ CashVault: V, StateManager: M });
    const select = win.document.getElementById("kyt-vault") as unknown as { value: string };
    expect(select.value).toBe(V);
    await win.happyDOM.close();
  });
  it("sets Gate directly only in CONFIGURING", async () => {
    const s = fixture(); const result = await s.client.changeGate(V, G);
    expect(result.kind).toBe("direct"); expect(result.gate).toBe(G);
    expect(s.tl.scheduleParamChange).not.toHaveBeenCalled();
  });
  it("schedules on the Vault's Timelock and derives changeId from the mined event", async () => {
    const s = fixture(); s.manager.getProductState.mockResolvedValue(3n);
    s.emit("VaultTimelock", "ParamChangeScheduled", [ID, V, s.pending.data, 200n, 300n], T);
    const r = await s.client.changeGate(V, G);
    expect(r.kind).toBe("scheduled"); expect(r.change.id).toBe(ID); expect(r.change.status).toBe("waiting");
    expect(s.vault.setGate).not.toHaveBeenCalled(); expect(await s.vault.gate()).toBe(ethers.ZeroAddress);
  });
  it("rejects a foreign event emitter and preserves the submitted transaction hash", async () => {
    const s = fixture(); s.manager.getProductState.mockResolvedValue(3n);
    s.emit("VaultTimelock", "ParamChangeScheduled", [ID, V, s.pending.data, 200n, 300n], G);
    await expect(s.client.changeGate(V, G)).rejects.toMatchObject({ code: "RECEIPT_UNRESOLVED", txHash: HASH });
    expect(s.tl.scheduleParamChange).toHaveBeenCalledTimes(1);
  });
  it("blocks a non-Owner before scheduling or directly setting Gate", async () => {
    const s = fixture(); s.signer.getAddress.mockResolvedValue(G);
    await expect(s.client.changeGate(V, G)).rejects.toThrow("Owner"); expect(s.vault.setGate).not.toHaveBeenCalled();
  });
  it("blocks mismatched networks", async () => {
    const s = fixture(); s.provider.getNetwork.mockResolvedValue({ chainId: 97n });
    await expect(s.client.route(V)).rejects.toThrow("network");
  });
  it("restores pending Gate changes from the chain and rejects early/expired execution", async () => {
    const s = fixture(); expect((await s.client.listChanges(V))[0].id).toBe(ID);
    await expect(s.client.executeChange(V, ID)).rejects.toThrow("waiting");
    s.provider.getBlock.mockResolvedValue({ timestamp: 301 });
    await expect(s.client.executeChange(V, ID)).rejects.toThrow("expired");
    s.provider.getBlock.mockResolvedValue({ timestamp: 200 });
    expect((await s.client.executeChange(V, ID)).gate).toBe(G);
  });
  it("refuses to execute a different Vault's change", async () => {
    const s = fixture(); s.pending.target = G;
    await expect(s.client.executeChange(V, ID)).rejects.toThrow("different Vault");
  });
  it("uses ordinary Vault allowance and no Gateway operator permission when Gate is zero", async () => {
    const s = fixture(); s.emit("EarnVault", "DepositRequested", [9n, O, 10n, 1n], V);
    const r = await s.client.deposit(V, 10n, O);
    expect(s.token.approve).toHaveBeenCalledWith(V, 10n); expect(s.vault.setOperator).not.toHaveBeenCalled();
    expect(r.vaultRequestId).toBe(9n); expect(s.gateway.requestDeposit).not.toHaveBeenCalled();
  });
  it("requests both missing KYT permissions and then submits only to the Gateway", async () => {
    const s = fixture(); s.setGate(G); s.emit("KYTDepositGateway", "ScreeningRequested", [7n, O, O, 10n, 3600n], G);
    const r = await s.client.deposit(V, 10n, O);
    expect(s.token.approve).toHaveBeenCalledWith(G, 10n); expect(s.vault.setOperator).toHaveBeenCalledWith(G, true);
    expect(r.screeningRequestId).toBe(7n); expect(s.vault.requestDeposit).not.toHaveBeenCalled();
  });
  it("skips permissions already granted", async () => {
    const s = fixture(); s.setGate(G); s.token.allowance.mockResolvedValue(10n); s.vault.isOperator.mockResolvedValue(true);
    s.emit("KYTDepositGateway", "ScreeningRequested", [7n, O, O, 10n, 3600n], G);
    await s.client.deposit(V, 10n, O);
    expect(s.token.approve).not.toHaveBeenCalled(); expect(s.vault.setOperator).not.toHaveBeenCalled();
  });
  it("stops if Gate changes while approvals are pending", async () => {
    const s = fixture(); s.setGate(G);
    s.vault.setOperator.mockImplementation(async () => { s.setGate(ethers.ZeroAddress); return { wait: async () => s.receipt }; });
    await expect(s.client.deposit(V, 10n, O)).rejects.toThrow("Gate changed"); expect(s.gateway.requestDeposit).not.toHaveBeenCalled();
  });
  it("reports expiry without inventing an on-chain rejection", async () => {
    const s = fixture(); expect((await s.client.getRequest(V, G, 1n)).status).toBe("EXPIRED (on-chain state: PENDING)");
  });
  it("checks Gateway admin and validity bounds before submitting", async () => {
    const s = fixture(); await expect(s.client.administer(V, G, "setValidityPeriod", "1")).rejects.toThrow("Validity");
    s.signer.getAddress.mockResolvedValue(G);
    await expect(s.client.administer(V, G, "setOracle", O)).rejects.toThrow("admin"); expect(s.gateway.setOracle).not.toHaveBeenCalled();
  });
});
