import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as ethers from "ethers";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { startAnvil, type AnvilInstance } from "./anvil.js";
import { deployFullStack, type DeployedStack } from "./deployStack.js";
import { HyperTesseraSDK } from "../src/sdk.js";
import { getAbi } from "../src/abis.js";

const abiMap = JSON.parse(readFileSync(new URL("../../control-panel/abis.json", import.meta.url), "utf8"));
const scope: any = {};
runInNewContext(readFileSync(new URL("../../control-panel/kyt.js", import.meta.url), "utf8"), scope);
const AMOUNT = 10n * 10n ** 6n;

describe("KYT SDK and panel helpers against real Vault/Gateway/Timelock", () => {
  let chain: AnvilInstance, stack: DeployedStack, sdk: HyperTesseraSDK;
  let gateway: ethers.Contract, vault: ethers.Contract, manager: ethers.Contract, token: ethers.Contract;
  let gw: string, v: string;
  function panel(signer = chain.wallets[0]) {
    return scope.HT_KYT.createClient({ ethers, abis: abiMap, provider: chain.provider, signer, chainId: 31337 });
  }
  async function advance(seconds: number) {
    await chain.provider.send("evm_increaseTime", [seconds]); await chain.provider.send("evm_mine", []);
  }
  beforeAll(async () => {
    chain = await startAnvil(8562);
    stack = await deployFullStack({ governor: chain.wallets[0], operator1: chain.wallets[1], operator2: chain.wallets[2] });
    sdk = new HyperTesseraSDK(stack.addresses, chain.provider);
    v = stack.addresses.cashVault;
    vault = new ethers.Contract(v, getAbi("EarnVault"), chain.wallets[0]);
    manager = new ethers.Contract(stack.addresses.stateManager, getAbi("StateManager"), chain.wallets[0]);
    const artifact = JSON.parse(readFileSync(new URL("../../out/KYTDepositGateway.sol/KYTDepositGateway.json", import.meta.url), "utf8"));
    const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, chain.wallets[0])
      .deploy(v, chain.wallets[8].address, chain.wallets[0].address, 3600n);
    await deployed.waitForDeployment(); gw = await deployed.getAddress();
    gateway = new ethers.Contract(gw, getAbi("KYTDepositGateway"), chain.wallets[8]);
    token = new ethers.Contract(await vault.usdt(), [
      "function mint(address,uint256)", "function balanceOf(address) view returns(uint256)",
      "function allowance(address,address) view returns(uint256)",
    ], chain.wallets[0]);
    await (await token.mint(chain.wallets[3].address, 100n * AMOUNT)).wait();
    const now = (await chain.provider.getBlock("latest"))!.timestamp;
    await (await manager.setProductParams(v, { subscriptionStart: 0, subscriptionEnd: now + 10 * 86400,
      walletSubscriptionCap: 10_000_000_000_000n, minRaiseAmount: 0, subscriptionCapShare: 0n,
      cycleDuration: 60, maturityTimestamp: now + 365 * 86400, claimingStart: now + 366 * 86400,
      claimingEnd: now + 367 * 86400, feeParams: 0 })).wait();
  }, 600_000);
  afterAll(() => { chain?.provider.destroy(); chain?.stop(); });

  it("connects/disconnects directly in CONFIGURING and rejects wrong bindings/owners", async () => {
    expect((await sdk.getVaultDepositRoute(v)).mode).toBe("direct");
    await expect(panel(chain.wallets[3]).changeGate(v, gw)).rejects.toThrow("Owner");
    await expect(panel().gatewayInfo(stack.addresses.noteVault, gw)).rejects.toThrow("binding mismatch");
    expect((await panel().changeGate(v, gw)).kind).toBe("direct");
    expect((await sdk.getVaultDepositRoute(v)).gateway).toBe(gw);
    expect((await sdk.getVaultDepositRoute(stack.addresses.noteVault)).mode).toBe("direct");
    await panel().changeGate(v, ethers.ZeroAddress);
    await (await manager.openSubscription(v)).wait();
  });
  it("preserves ordinary subscriptions with the Vault as allowance spender", async () => {
    const customer = chain.wallets[3], client = panel(customer);
    const before = await token.balanceOf(customer.address);
    for (let i = 0; i < 2; i++) expect((await client.deposit(v, AMOUNT, customer.address)).mode).toBe("direct");
    expect(await token.balanceOf(customer.address)).toBe(before - 2n * AMOUNT);
    expect(await vault.isOperator(customer.address, gw)).toBe(false);
  }, 30_000);
  it("uses the real Timelock after CONFIGURING and recovers pending changes in a fresh client", async () => {
    const r = await panel().changeGate(v, gw);
    expect(r.kind).toBe("scheduled"); expect(await vault.gate()).toBe(ethers.ZeroAddress);
    expect((await panel().listChanges(v)).map((c: any) => c.id)).toContain(r.change.id);
    await expect(panel().executeChange(v, r.change.id)).rejects.toThrow("waiting");
    await expect(panel().getChange(stack.addresses.noteVault, r.change.id)).rejects.toThrow();
    const tl = new ethers.Contract(await vault.vaultTimelock(), getAbi("VaultTimelock"), chain.provider);
    await advance(Number(await tl.delay()) + 1);
    // Execution is permissionless; only scheduling setGate requires the Vault Owner.
    expect((await panel(chain.wallets[7]).executeChange(v, r.change.id)).gate).toBe(gw);
    expect((await sdk.getVaultDepositRoute(v)).mode).toBe("kyt");
  }, 30_000);
  it("approves/submits through Gateway, then links the SDK event to the distinct Vault request ID", async () => {
    const customer = chain.wallets[3], before = await token.balanceOf(customer.address);
    const r = await panel(customer).deposit(v, AMOUNT, customer.address);
    expect(r.mode).toBe("kyt"); expect(r.screeningRequestId).toBe(1n);
    expect(await sdk.isVaultOperator(v, customer.address, gw)).toBe(true);
    expect(await token.balanceOf(customer.address)).toBe(before);
    expect((await sdk.getKytRequest(gw, r.screeningRequestId)).state).toBe(1);
    const timestamp = (await chain.provider.getBlock("latest"))!.timestamp;
    const receipt = await (await gateway.fulfill(r.screeningRequestId, true, timestamp)).wait();
    const event = sdk.parseKytEvents(gw, receipt).find(e => e.name === "DepositExecuted");
    expect(event).toMatchObject({ screeningRequestId: 1n, vaultRequestId: 3n });
    expect((await sdk.getKytRequest(gw, 1n)).state).toBe(2);
    expect(await token.balanceOf(customer.address)).toBe(before - AMOUNT);
    expect((await vault.getDepositRequest(3n)).owner).toBe(customer.address);
  }, 30_000);
  it("SDK submission reports rejection and expiry without moving customer funds", async () => {
    const customer = chain.wallets[3], before = await token.balanceOf(customer.address);
    const r = await sdk.requestKytDeposit(gw, AMOUNT, customer.address, customer);
    const now = (await chain.provider.getBlock("latest"))!.timestamp;
    const rejected = await (await gateway.fulfill(r.screeningRequestId, false, now)).wait();
    expect(sdk.parseKytEvents(gw, rejected)[0].name).toBe("ScreeningRejected");
    expect((await sdk.getKytRequest(gw, r.screeningRequestId)).state).toBe(3);
    const pending = await sdk.requestKytDeposit(gw, AMOUNT, customer.address, customer);
    await advance(3601);
    expect((await sdk.getKytRequest(gw, pending.screeningRequestId)).state).toBe(1);
    expect((await panel().getRequest(v, gw, pending.screeningRequestId)).status).toContain("EXPIRED");
    expect(await token.balanceOf(customer.address)).toBe(before);
  }, 30_000);
  it("cancels a queued Gate change, then disables through Timelock without altering old requests", async () => {
    const first = await panel().changeGate(v, ethers.ZeroAddress);
    await panel().cancelChange(v, first.change.id);
    expect((await panel().getChange(v, first.change.id)).status).toBe("cancelled");
    expect(await vault.gate()).toBe(gw);
    const next = await panel().changeGate(v, ethers.ZeroAddress);
    const tl = new ethers.Contract(await vault.vaultTimelock(), getAbi("VaultTimelock"), chain.provider);
    await advance(Number(await tl.delay()) + 1);
    expect((await panel().executeChange(v, next.change.id)).gate).toBe(ethers.ZeroAddress);
    expect((await sdk.getVaultDepositRoute(v)).mode).toBe("direct");
    expect((await sdk.getKytRequest(gw, 3n)).state).toBe(1);
  }, 30_000);
  it("administers Gateway using its admin role independently of the Vault Gate", async () => {
    await expect(panel(chain.wallets[3]).administer(v, gw, "setValidityPeriod", 7200n)).rejects.toThrow("admin");
    await panel().administer(v, gw, "setValidityPeriod", 7200n);
    await panel().administer(v, gw, "setOracle", chain.wallets[9].address);
    await panel().administer(v, gw, "transferAdmin", chain.wallets[7].address);
    const info = await panel().gatewayInfo(v, gw);
    expect(info.validityPeriod).toBe(7200n); expect(info.oracle).toBe(chain.wallets[9].address);
    expect(info.admin).toBe(chain.wallets[7].address);
  }, 30_000);
});
