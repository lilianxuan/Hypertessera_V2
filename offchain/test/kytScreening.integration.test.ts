import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, type ContractTransactionReceipt, type Wallet } from "ethers";
import { startAnvil, type AnvilInstance } from "./anvil.js";
import { deployFullStack, type DeployedStack } from "./deployStack.js";
import { getAbi } from "../src/abis.js";

// Real EVM/RPC/WSS, real delivery deployments and the unmodified runner CLI.
// Only the risk verdict is local-test data. No manual fulfill calls are made.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 8558;
const RPC = `http://127.0.0.1:${PORT}`;
const AMOUNT = 1000n * 10n ** 6n; // Deployed MockUSDT has six decimals.
const TOKEN_ABI = [
  "function mint(address,uint256)", "function approve(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
];
const GATEWAY_ABI = [
  "function requestDeposit(uint256,address) returns(uint256)",
  "function getRequest(uint256) view returns(tuple(address payer,address owner,uint256 assets,uint64 requestedAt,uint64 expiresAt,uint8 state))",
  "function fulfill(uint256,bool,uint64)",
  "function oracle() view returns(address)", "function vault() view returns(address)",
  "function asset() view returns(address)",
  "event ScreeningRequested(uint256 indexed id,address indexed payer,address indexed owner,uint256 assets,uint64 expiresAt)",
  "event DepositExecuted(uint256 indexed id,uint256 indexed vaultRequestId,address indexed owner,uint256 assets,uint64 screenedAt)",
  "event ScreeningRejected(uint256 indexed id,address indexed payer,uint64 screenedAt,uint256 timestamp)",
];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), chainId: 31337, scenarios: [] };
const scenarioEvidence = evidence.scenarios as Record<string, unknown>[];
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

async function command(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(binary, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? done() : reject(new Error(`${binary} exited ${code}`)));
  });
}

describe("KYT runner against deployed Gateway and Vault", () => {
  let chain: AnvilInstance;
  let stack: DeployedStack;
  let gateway: Contract;
  let vault: Contract;
  let token: Contract;
  let gatewayAddress: string;
  const gatewayRegistry: {gateway: string; vault: string; asset: string}[] = [];
  let tokenAddress: string;
  let runner: ChildProcess | undefined;
  let runnerCode: number | null | undefined;
  let runnerFailure: Error | undefined;
  const logs: Record<string, unknown>[] = [];
  let runnerStderr = "";
  let exitPromise: Promise<void> | undefined;

  async function waitForLog(type: string, id?: bigint, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = logs.find(entry => entry.type === type && (id === undefined || entry.id === id.toString()));
      if (found) return found;
      if (runnerFailure) throw runnerFailure;
      if (runnerCode !== undefined) throw new Error(`runner exited ${runnerCode}: ${runnerStderr}`);
      const failure = logs.find(entry => ["startup-error", "fatal", "submission-uncertain"].includes(String(entry.type)) ||
        (id !== undefined && entry.id === id.toString() && ["submit-error", "screening-error", "execution-reverted", "processing-timeout"].includes(String(entry.type))));
      if (failure && failure.type !== type) throw new Error(`Unexpected runner outcome: ${JSON.stringify(failure)}`);
      await sleep(25);
    }
    throw new Error(`No ${type} for ${id ?? "service"}; logs=${JSON.stringify(logs)} stderr=${runnerStderr}`);
  }

  beforeAll(async () => {
    chain = await startAnvil(PORT);
    expect((await chain.provider.getNetwork()).chainId).toBe(31337n);
    const [governor, operator1, operator2] = chain.wallets;
    stack = await deployFullStack({ governor, operator1, operator2 });
    const oracle = chain.wallets[8];
    // Force public Anvil credentials and the loopback RPC, regardless of surrounding environment.
    await command("forge", ["script", "script/deploy/DeployKYTGateway.s.sol", "--tc", "DeployKYTGateway",
      "--rpc-url", RPC, "--broadcast", "--slow", "--timeout", "60"], {
      ...process.env, TEST_PK: governor.privateKey, PRIVATE_KEY: "", KYT_VAULT: stack.addresses.cashVault,
      KYT_ORACLE: oracle.address, KYT_ADMIN: governor.address, KYT_LABEL: "integration", KYT_SET_GATE: "true",
      KYT_VALIDITY_PERIOD: "3600",
    });
    const deployment = JSON.parse(readFileSync(resolve(ROOT, "control-panel/deployments-kyt-integration.json"), "utf8"));
    expect(deployment.chainId).toBe(31337);
    expect(deployment.kyt.gateInstalled).toBe(true);
    gatewayAddress = deployment.kyt.gateway;
    gateway = new Contract(gatewayAddress, GATEWAY_ABI, chain.provider);
    vault = new Contract(stack.addresses.cashVault, getAbi("EarnVault"), governor);
    tokenAddress = await stack.usdt.getAddress();
    token = new Contract(tokenAddress, TOKEN_ABI, governor);
    expect((await vault.gate()).toLowerCase()).toBe(gatewayAddress.toLowerCase());
    expect(await gateway.oracle()).toBe(oracle.address);

    // The shared fixture uses a very short subscription window; configure a full test window.
    const block = await chain.provider.getBlock("latest");
    const now = block!.timestamp;
    const manager = new Contract(stack.addresses.stateManager, getAbi("StateManager"), governor);
    await (await manager.setProductParams(stack.addresses.cashVault, {
      subscriptionStart: 0, subscriptionEnd: now + 3600, walletSubscriptionCap: 10_000_000_000_000n,
      minRaiseAmount: 0, subscriptionCapShare: 0n, cycleDuration: 60,
      maturityTimestamp: now + 365 * 86400, claimingStart: now + 366 * 86400,
      claimingEnd: now + 367 * 86400, feeParams: 0,
    })).wait();
    await (await manager.openSubscription(stack.addresses.cashVault)).wait();
    for (const wallet of chain.wallets.slice(3, 7)) {
      await (await token.mint(wallet.address, 10n * AMOUNT)).wait();
    }
    gatewayRegistry.push({gateway: gatewayAddress, vault: stack.addresses.cashVault, asset: tokenAddress});
    for (const [label, address] of [["note", stack.addresses.noteVault], ["lp", stack.addresses.lpVault]]) {
      await command("forge", ["script", "script/deploy/DeployKYTGateway.s.sol", "--tc", "DeployKYTGateway",
        "--rpc-url", RPC, "--broadcast", "--slow", "--timeout", "60"], {
        ...process.env, TEST_PK: governor.privateKey, PRIVATE_KEY: "", KYT_VAULT: address,
        KYT_ORACLE: oracle.address, KYT_ADMIN: governor.address, KYT_LABEL: `integration-${label}`,
        KYT_SET_GATE: "true", KYT_VALIDITY_PERIOD: "300",
      });
      const deployed = JSON.parse(readFileSync(resolve(ROOT, `control-panel/deployments-kyt-integration-${label}.json`), "utf8"));
      gatewayRegistry.push({gateway: deployed.kyt.gateway, vault: address, asset: tokenAddress});
      await (await manager.setProductParams(address, {
        subscriptionStart: 0, subscriptionEnd: now + 3600, walletSubscriptionCap: 10_000_000_000_000n,
        minRaiseAmount: 0, subscriptionCapShare: 0n, cycleDuration: 60,
        maturityTimestamp: now + 365 * 86400, claimingStart: now + 366 * 86400,
        claimingEnd: now + 367 * 86400, feeParams: 0,
      })).wait();
      await (await manager.openSubscription(address)).wait();
    }
    evidence.addresses = { gateway: gatewayAddress, vault: stack.addresses.cashVault, token: tokenAddress, oracle: oracle.address };

    let lineBuffer = "";
    runner = spawn(process.execPath, ["--import", "tsx", "scripts/runKytScreening.ts"], {
      cwd: resolve(ROOT, "offchain"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env,
        KYT_ENV: "local", RPC_URL: RPC, WSS_URL: `ws://127.0.0.1:${PORT}`, KYT_CHAIN_ID: "31337",
        KYT_GATEWAY: undefined, KYT_VAULT: undefined, KYT_ASSET: undefined, KYT_GATEWAYS: JSON.stringify(gatewayRegistry),
        KYT_ORACLE_PK: oracle.privateKey, KYT_SCREENER: "denylist", KYT_DENYLIST: chain.wallets[4].address,
        KYT_BLOCK_RISK: "Severe,High", KYT_API_RPS: "30", KYT_RPC_RPS: "80",
        KYT_SCREENING_CONCURRENCY: "20", KYT_MAX_PENDING_TX: "16", KYT_PROCESSING_WINDOW_MS: "60000",
        KYT_CONFIRMATION_RESERVE_MS: "10000", KYT_CONFIRMATIONS: "1", KYT_RECONNECT_DELAY_MS: "5000",
        KYT_HEARTBEAT_INTERVAL_MS: "15000", KYT_RPC_TIMEOUT_MS: "10000", KYT_RECEIPT_POLL_MS: "1000",
        KYT_RECEIPT_TIMEOUT_MS: "60000", CHAINALYSIS_API_KEY: "", CHAINALYSIS_API_URL: "https://api.chainalysis.com/api/risk/v2/entities",
      },
    });
    runner.stdout!.on("data", chunk => {
      lineBuffer += String(chunk);
      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
        try { logs.push(JSON.parse(line)); } catch { runnerStderr += line + "\n"; }
      }
    });
    runner.stderr!.on("data", chunk => { runnerStderr += String(chunk); });
    runner.on("error", error => { runnerFailure = error; });
    exitPromise = new Promise(done => runner!.once("exit", code => { runnerCode = code; done(); }));
    await waitForLog("ready");
  }, 600_000);

  afterAll(async () => {
    if (runner && runnerCode === undefined) {
      runner.kill("SIGTERM");
      await Promise.race([exitPromise, sleep(5000)]);
      if (runnerCode === undefined) runner.kill("SIGKILL");
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.runnerLogs = logs;
    evidence.runnerStderr = runnerStderr;
    evidence.runnerExitCode = runnerCode;
    const path = process.env.KYT_EVIDENCE_PATH;
    if (path) {
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(path, JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    }
    chain?.provider.destroy();
    chain?.stop();
  });

  async function prepare(wallet: Wallet, approve = true, operator = true) {
    if (approve) await (await (token.connect(wallet) as Contract).approve(gatewayAddress, AMOUNT)).wait();
    if (operator) await (await (vault.connect(wallet) as Contract).setOperator(gatewayAddress, true)).wait();
  }
  async function request(wallet: Wallet) {
    const balance = await token.balanceOf(wallet.address);
    const tx = await (gateway.connect(wallet) as Contract).requestDeposit(AMOUNT, wallet.address);
    const receipt = await tx.wait() as ContractTransactionReceipt;
    const event = receipt.logs.map(log => { try { return gateway.interface.parseLog(log); } catch { return null; } })
      .find(log => log?.name === "ScreeningRequested");
    expect(event).toBeDefined();
    const id = event!.args.id as bigint;
    expect(await token.balanceOf(wallet.address, { blockTag: receipt.blockNumber })).toBe(balance);
    expect((await gateway.getRequest(id, { blockTag: receipt.blockNumber })).state).toBe(1n);
    return { id, receipt, balance };
  }
  async function fulfilledReceipt(log: Record<string, unknown>, id: bigint, passed: boolean) {
    const hash = String(log.txHash);
    const receipt = await chain.provider.getTransactionReceipt(hash);
    expect(receipt?.status).toBe(1);
    const tx = await chain.provider.getTransaction(hash);
    expect(tx?.from).toBe(chain.wallets[8].address);
    expect(tx?.to?.toLowerCase()).toBe(gatewayAddress.toLowerCase());
    const call = gateway.interface.parseTransaction({ data: tx!.data });
    expect(call?.name).toBe("fulfill"); expect(call?.args[0]).toBe(id); expect(call?.args[1]).toBe(passed);
    return { hash, blockNumber: receipt!.blockNumber, status: receipt!.status, gasUsed: receipt!.gasUsed };
  }

  it("three real Gateways with overlapping IDs share the same oracle nonce queue", async () => {
    const customer = chain.wallets[9];
    await (await token.mint(customer.address, 30n * AMOUNT)).wait();
    const submittedBefore = logs.filter(l => l.type === "submitted").length;
    const nonceBefore = await chain.provider.getTransactionCount(chain.wallets[8].address, "pending");
    for (const entry of gatewayRegistry) {
      const target = new Contract(entry.gateway, GATEWAY_ABI, customer);
      const v = new Contract(entry.vault, getAbi("EarnVault"), customer);
      await (await token.connect(customer).getFunction("approve")(entry.gateway, 10n * AMOUNT)).wait();
      await (await v.setOperator(entry.gateway, true)).wait();
      await (await target.requestDeposit(AMOUNT, customer.address)).wait();
    }
    const deadline = Date.now() + 20000;
    while (logs.filter(l => l.type === "executed").length < 3 && Date.now() < deadline) await sleep(25);
    const submitted = logs.filter(l => l.type === "submitted").slice(submittedBefore);
    expect(submitted).toHaveLength(3);
    expect(submitted.map(l => Number(l.nonce))).toEqual([nonceBefore, nonceBefore + 1, nonceBefore + 2]);
    expect(new Set(submitted.map(l => String(l.gateway).toLowerCase()))).toEqual(new Set(gatewayRegistry.map(g => g.gateway.toLowerCase())));
    for (const entry of gatewayRegistry) {
      const target = new Contract(entry.gateway, GATEWAY_ABI, chain.provider);
      expect((await target.getRequest(1)).state).toBe(2n);
      expect(await token.balanceOf(entry.vault)).toBe(AMOUNT);
    }
  }, 30000);

  it("automatically fulfills a passing request and records the Vault subscription", async () => {
    const customer = chain.wallets[3];
    await prepare(customer);
    const beforeVault = await token.balanceOf(stack.addresses.cashVault);
    const { id, receipt, balance } = await request(customer);
    const result = await waitForLog("executed", id);
    const fulfillment = await fulfilledReceipt(result, id, true);
    expect((await gateway.getRequest(id)).state).toBe(2n);
    expect(await token.balanceOf(customer.address)).toBe(balance - AMOUNT);
    expect(await token.balanceOf(stack.addresses.cashVault)).toBe(beforeVault + AMOUNT);
    expect(await vault.pendingDepositByOwner(customer.address)).toBe(AMOUNT);
    expect(await token.balanceOf(gatewayAddress)).toBe(0n);
    expect(await token.allowance(gatewayAddress, stack.addresses.cashVault)).toBe(0n);
    scenarioEvidence.push({ name: "passed", requestId: id, requestHash: receipt.hash, fulfillment, passed: true });
  }, 30_000);

  it("automatically rejects a blocked customer without moving funds", async () => {
    const customer = chain.wallets[4];
    await prepare(customer);
    const beforeVault = await token.balanceOf(stack.addresses.cashVault);
    const { id, receipt, balance } = await request(customer);
    const result = await waitForLog("screening-rejected", id);
    const fulfillment = await fulfilledReceipt(result, id, false);
    expect((await gateway.getRequest(id)).state).toBe(3n);
    expect(await token.balanceOf(customer.address)).toBe(balance);
    expect(await token.balanceOf(stack.addresses.cashVault)).toBe(beforeVault);
    expect(await vault.pendingDepositByOwner(customer.address)).toBe(0n);
    scenarioEvidence.push({ name: "rejected", requestId: id, requestHash: receipt.hash, fulfillment, passed: true });
  }, 30_000);

  it("reverts a direct Vault deposit even when the customer approved the Vault", async () => {
    const customer = chain.wallets[4];
    await (await (token.connect(customer) as Contract).approve(stack.addresses.cashVault, AMOUNT)).wait();
    const beforeCustomer = await token.balanceOf(customer.address);
    const beforeVault = await token.balanceOf(stack.addresses.cashVault);
    const data = vault.interface.encodeFunctionData("requestDeposit", [AMOUNT, customer.address]);
    try { await chain.provider.call({ from: customer.address, to: stack.addresses.cashVault, data });
      throw new Error("direct request unexpectedly allowed");
    } catch (error) {
      const reason = (error as { data?: string }).data;
      expect(reason).toBeDefined();
      expect(vault.interface.parseError(reason!)?.name).toBe("GateBlocked");
    }
    // Explicit gas bypasses estimation so the test also obtains an actual reverted receipt.
    const tx = await customer.sendTransaction({ to: stack.addresses.cashVault, data, gasLimit: 1_000_000 });
    try { await tx.wait(); } catch { /* Expected status 0, independently asserted below. */ }
    const receipt = await chain.provider.getTransactionReceipt(tx.hash);
    expect(receipt?.status).toBe(0);
    expect(await token.balanceOf(customer.address)).toBe(beforeCustomer);
    expect(await token.balanceOf(stack.addresses.cashVault)).toBe(beforeVault);
    expect(await vault.pendingDepositByOwner(customer.address)).toBe(0n);
    scenarioEvidence.push({ name: "direct-vault-blocked", txHash: tx.hash, blockNumber: receipt!.blockNumber, status: 0, passed: true });
  }, 30_000);

  for (const missing of ["token-approval", "vault-operator"] as const) {
    it(`does not move funds or consume an oracle nonce when ${missing} is missing`, async () => {
      const customer = chain.wallets[missing === "token-approval" ? 5 : 6];
      await prepare(customer, missing !== "token-approval", missing !== "vault-operator");
      const beforeVault = await token.balanceOf(stack.addresses.cashVault);
      const beforeNonce = await chain.provider.getTransactionCount(chain.wallets[8].address, "pending");
      const { id, receipt, balance } = await request(customer);
      // The runner keeps preparing it again until the deadline; the first failure is the evidence.
      const failure = await waitForLog("submit-retry", id);
      expect((await gateway.getRequest(id)).state).toBe(1n);
      expect(await token.balanceOf(customer.address)).toBe(balance);
      expect(await token.balanceOf(stack.addresses.cashVault)).toBe(beforeVault);
      expect(await token.balanceOf(gatewayAddress)).toBe(0n);
      expect(await vault.pendingDepositByOwner(customer.address)).toBe(0n);
      expect(await token.allowance(gatewayAddress, stack.addresses.cashVault)).toBe(0n);
      expect(await chain.provider.getTransactionCount(chain.wallets[8].address, "pending")).toBe(beforeNonce);
      expect(logs.some(entry => entry.id === id.toString() && entry.type === "submitted")).toBe(false);
      scenarioEvidence.push({ name: missing, requestId: id, requestHash: receipt.hash, outcome: failure, passed: true });
    }, 30_000);
  }
});
