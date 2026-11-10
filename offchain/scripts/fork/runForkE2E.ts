/**
 * End-to-end off-chain <-> on-chain integration run against a **local anvil fork of BNB Testnet**.
 *
 * Every contract call in here targets the v3 generation deployed on 2026-08-17
 * (offchain/scripts/testnet/addresses.bscTestnet.json, docs/deployment-bsctestnet-2026-08-17-v3.md)
 * — the same bytecode the real testnet runs, reached through a fork so nothing is broadcast.
 *
 * Start the fork first (the public data-seed endpoints are pruned and answer historical state with
 * `missing trie node`; publicnode is an archive node and works):
 *
 *   anvil --fork-url https://bsc-testnet-rpc.publicnode.com --chain-id 97 --port 8546
 *   cd offchain && npx tsx scripts/fork/runForkE2E.ts
 *
 * Scenarios, in dependency order:
 *   1. Zero-to-one product flow — registerAsset -> deployVault -> roles -> setProductParams ->
 *      deploy/whitelist/attach adapter -> setDataProvider -> openSubscription -> requestDeposit ->
 *      finalizeSubscription -> settle -> claimDeposit, all through the TypeScript SDK. This path
 *      previously existed only as Solidity in script/Deploy.s.sol.
 *   2. fundAdapter / recallAdapter on the vault scenario 1 built.
 *   3. RWAAdapter deploy + attach, and the indexer's vault->asset link path.
 *   4. Settlement ordering with a live performance fee, on the deployed Cash + LP Vaults —
 *      the on-chain counterpart of test/SettlementOrdering.t.sol.
 *   5. The three operational rules from docs/settlement-operator-runbook.md.
 *   6. KeeperBot and SettlementOperator, driven through scripts/runKeeper.ts / runSettlement.ts.
 *   7. Indexer deposit-event ingestion over fork logs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Contract, ZeroAddress, keccak256, toUtf8Bytes, type Log } from "ethers";
import { HyperTesseraSDK } from "../../src/sdk.js";
import { OnChainEventIndexer } from "../../src/indexer.js";
import { SettlementOperator } from "../../src/settlementOperator.js";
import {
  CycleState,
  FeePaymentKind,
  ProductState,
  QueueType,
  VaultType,
  type Address,
  type ProductParams,
  type RequestSettlement,
} from "../../src/types.js";
import {
  DEPLOY_WALLET,
  impersonate,
  loadForkDeployment,
  now as chainNow,
  revertTo,
  snapshot,
  warpTo,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_OFFCHAIN = join(__dirname, "..", "..");

const DAY = 86_400;
const USDT_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Scenario-4 constants — identical to test/SettlementOrdering.t.sol so the expected numbers can be
// compared against the Foundry proof line for line.
const CASH_SEED = 1_000_000_000n; // 1_000e6
const CASH_YIELD = 100_000_000n; // 100e6
const LP_DEPOSIT = 220_000_000n; // 220e6

// registerAsset's 6th parameter — issuer is ignored on input (the contract forces msg.sender), so
// it is left zero here rather than threaded through per call site.
const NO_PRODUCT_INFO = {
  productName: "",
  annualYieldRateBps: 0,
  maturityTimestamp: 0n,
  issuer: ZeroAddress,
  underlyingAsset: "",
};

const { raw, addresses, provider, wallets } = loadForkDeployment();
const sdk = new HyperTesseraSDK(addresses, provider);
const usdt = new Contract(raw.usdt, USDT_ABI, provider);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  error?: string;
}
const results: Result[] = [];

async function scenario(name: string, fn: () => Promise<void>) {
  console.log(`\n\x1b[1m== ${name}\x1b[0m`);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`\x1b[32m✓ ${name}\x1b[0m`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: message });
    console.log(`\x1b[31m✗ ${name}\x1b[0m`);
    console.log(message.split("\n").slice(0, 6).join("\n"));
  }
}

/** Asserts equality and prints the compared numbers, so a pass shows its evidence. */
function eq(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  assert.equal(a, e, `${label}: expected ${e}, got ${a}`);
  console.log(`    ${label} = ${a}`);
}

function approx(actual: bigint, expected: bigint, tolerance: bigint, label: string) {
  const delta = actual > expected ? actual - expected : expected - actual;
  assert.ok(delta <= tolerance, `${label}: expected ~${expected} (±${tolerance}), got ${actual}`);
  console.log(`    ${label} = ${actual} (target ${expected}, delta ${delta})`);
}

/** Runs `fn`, requires it to revert, and requires the revert data to contain `selectorOrText`. */
async function assertReverts(fn: () => Promise<unknown>, selectorOrText: string, label: string) {
  try {
    await fn();
  } catch (err) {
    const blob = JSON.stringify(
      err,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      0,
    );
    const message = err instanceof Error ? `${err.message} ${blob}` : blob;
    assert.ok(
      message.includes(selectorOrText),
      `${label}: reverted, but not with ${selectorOrText}\n${message.slice(0, 500)}`,
    );
    console.log(`    ${label} reverted with ${selectorOrText} ✓`);
    return;
  }
  throw new Error(`${label}: expected a revert, call succeeded`);
}

function productParams(start: number, overrides: Partial<ProductParams> = {}): ProductParams {
  return {
    subscriptionStart: BigInt(start),
    subscriptionEnd: BigInt(start + 7 * DAY),
    walletSubscriptionCap: 1_000_000_000_000n,
    minRaiseAmount: 0n,
    subscriptionCapShare: 0n,
    cycleDuration: BigInt(7 * DAY),
    maturityTimestamp: BigInt(start + 365 * DAY),
    claimingStart: BigInt(start + 370 * DAY),
    claimingEnd: BigInt(start + 400 * DAY),
    feeParams: 0n,
    ...overrides,
  };
}

/** Finds the first log index whose topic0 matches, or -1. */
function indexOfEvent(logs: readonly Log[], topic0: string): number {
  return logs.findIndex((l) => l.topics[0]?.toLowerCase() === topic0.toLowerCase());
}

function assertLogOrder(logs: readonly Log[], firstTopic: string, secondTopic: string, label: string) {
  const a = indexOfEvent(logs, firstTopic);
  const b = indexOfEvent(logs, secondTopic);
  assert.ok(a >= 0, `${label}: first event not emitted`);
  assert.ok(b >= 0, `${label}: second event not emitted`);
  assert.ok(a < b, `${label}: out of order (first at ${a}, second at ${b})`);
  console.log(`    ${label}: log #${a} precedes log #${b} ✓`);
}

const vaultIface = sdk.vaultAt(addresses.cashVault).interface;
const bridgeIface = sdk.liquidityBridge.interface;
const TOPIC = {
  performanceFeeAccrued: vaultIface.getEvent("PerformanceFeeAccrued")!.topicHash,
  depositBridged: bridgeIface.getEvent("DepositBridged")!.topicHash,
  redeemSettled: vaultIface.getEvent("RedeemSettled")!.topicHash,
  adapterFunded: vaultIface.getEvent("AdapterFunded")!.topicHash,
  adapterRecalled: vaultIface.getEvent("AdapterRecalled")!.topicHash,
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Impersonated deploy wallet — Governor, and every Vault's Owner/Curator/Guardian/Allocator/Keeper. */
let deployer: Awaited<ReturnType<typeof impersonate>>;
let forkBlock: number;

/** Mints mock USDT (the deployed MockUSDT has an open `mint`) and approves `spender`. */
async function fundAndApprove(who: (typeof wallets)["investor1"], amount: bigint, spender: string) {
  await (await (usdt.connect(deployer) as any).mint(who.address, amount)).wait();
  await (await (usdt.connect(who) as any).approve(spender, amount)).wait();
}

async function requestDeposit(vault: Address, who: (typeof wallets)["investor1"], assets: bigint) {
  const v = sdk.vaultAt(vault);
  const receipt = await (await (v.connect(who) as any).requestDeposit(assets, who.address)).wait();
  for (const log of receipt.logs) {
    const parsed = v.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed?.name === "DepositRequested") return BigInt(parsed.args[0]);
  }
  throw new Error("DepositRequested not emitted");
}

/** Grants the two anvil operator wallets the Settlement operator role on `vault`, threshold 2. */
async function wireOperators(vault: Address) {
  await sdk.setSettlementOperator(vault, wallets.operator1.address, true, deployer as any);
  await sdk.setSettlementOperator(vault, wallets.operator2.address, true, deployer as any);
  await sdk.setSettlementThreshold(vault, 2n, deployer as any);
}

/**
 * `SettlementOperator.assembleInstruction` derives `validUntil` from the HOST wall clock
 * (`Date.now()`, settlementOperator.ts:66), not from the chain's latest block timestamp. On a live
 * chain the two agree; on a fork whose clock this script warps forward by weeks they do not, and
 * every batch reverts `BatchExpired(validUntil, block.timestamp)`. Compensate by folding the skew
 * into `validitySeconds` rather than patching the component under test.
 */
async function settlementOperator() {
  const skew = (await chainNow(provider)) - Math.floor(Date.now() / 1000);
  return new SettlementOperator(sdk, {
    operatorSigners: [wallets.operator1, wallets.operator2],
    validitySeconds: Math.max(3600, skew + 3600),
    maxRetries: 1,
    baseRetryDelayMs: 100,
  });
}

function calc(vault: Address, deposits: RequestSettlement[] = [], redeems: RequestSettlement[] = []) {
  return { vault, amount: 0n, deposits, redeems };
}

// ---------------------------------------------------------------------------
// Scenario 1 — zero-to-one product flow, entirely through the SDK
// ---------------------------------------------------------------------------

let s1Vault: Address;
let s1Adapter: Address;

async function scenario1_zeroToOne() {
  const t0 = await chainNow(provider);

  // --- registerAsset. Creation fees are 0 on this deployment, so no msg.value.
  eq(await sdk.creationFeeOf(0, FeePaymentKind.Native), 0n, "creationFee(RegisterAsset, Native)");
  const nextIdBefore: bigint = await sdk.assetRegistry.nextAssetId();
  const { assetId, token } = await sdk.registerAsset(
    keccak256(toUtf8Bytes("fork-e2e-note-metadata")),
    "Fork E2E Note",
    "fkNOTE",
    18,
    FeePaymentKind.Native,
    NO_PRODUCT_INFO,
    deployer as any,
  );
  eq(assetId, nextIdBefore, "assetId == nextAssetId before");
  const info = await sdk.getAssetInfo(assetId);
  eq(info.token, token, "assetRegistry.getAsset().token");
  eq(info.active, true, "asset active");
  eq(info.owner, DEPLOY_WALLET, "asset owner");
  assert.notEqual(await provider.getCode(token), "0x", "RWA token has code");

  // --- deployVault (EARN tranche, no liquidity bridge).
  eq(await sdk.creationFeeOf(1, FeePaymentKind.Native), 0n, "creationFee(DeployVault, Native)");
  s1Vault = await sdk.deployVault(
    {
      vaultType: VaultType.EARN,
      name: "Fork E2E Earn",
      symbol: "fkEARN",
      usdt: raw.usdt,
      stateManager: addresses.stateManager,
      settlement: ZeroAddress, // read but unused by VaultFactory; wired below
      queue: addresses.queue,
      owner: ZeroAddress, // => msg.sender (the deploy wallet)
      liquidityBridge: ZeroAddress,
      cashVault: ZeroAddress,
      feeKind: FeePaymentKind.Native,
    },
    deployer as any,
  );
  console.log(`    vault = ${s1Vault}`);
  assert.notEqual(await provider.getCode(s1Vault), "0x", "vault has code");
  const vault = sdk.vaultAt(s1Vault);
  eq(await sdk.isVaultRegistered(s1Vault), true, "stateManager.isVaultRegistered");
  const ctx0 = await sdk.getStateContext(s1Vault);
  eq(ctx0.product, ProductState.CONFIGURING, "product state");
  eq(ctx0.cycle, CycleState.ACCEPTING, "cycle state");
  eq(await vault.usdt(), raw.usdt, "vault.usdt()");
  eq(await vault.queue(), addresses.queue, "vault.queue()");
  eq(await vault.owner(), DEPLOY_WALLET, "vault.owner()");

  // --- roles.
  await sdk.setCurator(s1Vault, DEPLOY_WALLET, deployer as any);
  await sdk.setGuardian(s1Vault, DEPLOY_WALLET, deployer as any);
  await sdk.setAllocator(s1Vault, DEPLOY_WALLET, deployer as any);
  await sdk.setKeeper(s1Vault, DEPLOY_WALLET, true, deployer as any);
  await (await (vault.connect(deployer) as any).setSettlement(addresses.settlement)).wait();
  eq(await vault.curator(), DEPLOY_WALLET, "vault.curator()");
  eq(await vault.guardian(), DEPLOY_WALLET, "vault.guardian()");
  eq(await vault.allocator(), DEPLOY_WALLET, "vault.allocator()");
  eq(await vault.isKeeper(DEPLOY_WALLET), true, "vault.isKeeper(deployer)");
  eq(await vault.settlement(), addresses.settlement, "vault.settlement()");

  await wireOperators(s1Vault);
  eq(await sdk.isOperator(s1Vault, wallets.operator1.address), true, "settlement.isOperator(op1)");
  eq(await sdk.isOperator(s1Vault, wallets.operator2.address), true, "settlement.isOperator(op2)");
  eq(await sdk.threshold(s1Vault), 2n, "settlement.threshold");

  // --- product params (Curator, CONFIGURING only).
  const params = productParams(t0);
  await sdk.setProductParams(s1Vault, params, deployer as any);
  const stored = await sdk.stateManager.getParams(s1Vault);
  eq(stored.cycleDuration, params.cycleDuration, "stored cycleDuration");

  // --- adapter: deploy -> whitelist -> attach -> data provider.
  s1Adapter = await sdk.deployAdapter(
    { asset: raw.usdt, vault: s1Vault, stalenessWindow: BigInt(36 * 3600) },
    deployer as any,
  );
  console.log(`    adapter = ${s1Adapter}`);
  eq(await sdk.adapterFactory.isAdapter(s1Adapter), true, "adapterFactory.isAdapter");
  const adapter = sdk.getContract("FirstPeriodAdapter", s1Adapter);
  eq(await adapter.vault(), s1Vault, "adapter.vault()");
  eq(await adapter.asset(), raw.usdt, "adapter.asset()");

  // AdapterRegistry is gone — the Curator (deployer, here) attaches any adapter directly.
  await sdk.addAdapter(s1Vault, s1Adapter, deployer as any);
  eq(await vault.isAdapter(s1Adapter), true, "vault.isAdapter(adapter)");
  eq(await vault.adapters(0), s1Adapter, "vault.adapters(0)");

  await sdk.setDataProvider(s1Adapter, wallets.dataProvider.address, deployer as any);
  eq(await adapter.dataProvider(), wallets.dataProvider.address, "adapter.dataProvider()");

  // --- openSubscription (Keeper).
  await sdk.openSubscription(s1Vault, deployer as any);
  eq((await sdk.getStateContext(s1Vault)).product, ProductState.SUBSCRIBING, "product after openSubscription");

  // --- requestDeposit.
  await fundAndApprove(wallets.investor1, CASH_SEED, s1Vault);
  const rid = await requestDeposit(s1Vault, wallets.investor1, CASH_SEED);
  eq(rid, 1n, "first requestId");
  eq(await usdt.balanceOf(s1Vault), CASH_SEED, "vault USDT balance");
  eq(await vault.pendingDepositLiability(), CASH_SEED, "pendingDepositLiability");
  eq(await vault.totalAssets(), 0n, "totalAssets (deposit still a liability)");
  eq(await vault.freeVaultUSDT(), 0n, "freeVaultUSDT");
  eq(await sdk.stateManager.totalSubscribed(s1Vault), CASH_SEED, "totalSubscribed");
  eq(await sdk.queueDepth(s1Vault, QueueType.DEPOSIT), 1n, "deposit queue depth");
  const req = await vault.getDepositRequest(rid);
  eq(req.owner, wallets.investor1.address, "request owner");
  eq(req.assets, CASH_SEED, "request assets");
  eq(req.state, 1n, "request state == PENDING");

  // --- finalizeSubscription.
  await warpTo(provider, Number(params.subscriptionEnd));
  await sdk.finalizeSubscription(s1Vault, deployer as any);
  const ctx1 = await sdk.getStateContext(s1Vault);
  eq(ctx1.product, ProductState.OPERATING, "product after finalizeSubscription");
  eq(ctx1.cycle, CycleState.CALCULATING, "cycle after finalizeSubscription");

  // --- settle through SettlementOperator (2-of-N signatures).
  const receipt = await (await settlementOperator()).run(
    ctx1.cycleNumber,
    [calc(s1Vault, [{ requestId: rid, settleAmount: CASH_SEED }])],
    wallets.relayer,
  );
  console.log(`    submitBatch gas = ${receipt!.gasUsed}`);
  const snap = await vault.cycleSnapshots(ctx1.cycleNumber);
  eq(snap.initialized, true, "cycleSnapshots.initialized");
  eq(snap.settlementPrice, 1_000_000n, "settlementPrice (seed price 1.0)");
  eq(await vault.totalAssets(), CASH_SEED, "totalAssets after settle");
  eq(await vault.pendingDepositLiability(), 0n, "pendingDepositLiability after settle");
  eq((await vault.getDepositRequest(rid)).state, 2n, "request state == SETTLED");

  // --- claimDeposit. 1_000e6 USDT at price 1.0 => 1_000e18 shares (vault shares are 18-dec).
  await (await (vault.connect(wallets.investor1) as any).claimDeposit(rid, wallets.investor1.address)).wait();
  eq(await vault.balanceOf(wallets.investor1.address), 1_000_000_000_000_000_000_000n, "investor shares");
  eq(await vault.totalSupply(), 1_000_000_000_000_000_000_000n, "vault totalSupply");
  eq(await vault.convertToAssets(1_000_000_000_000_000_000_000n), CASH_SEED, "convertToAssets(shares)");
  eq((await vault.getDepositRequest(rid)).state, 3n, "request state == CLAIMED");
}

// ---------------------------------------------------------------------------
// Scenario 2 — fundAdapter / recallAdapter
// ---------------------------------------------------------------------------

async function scenario2_fundAndRecallAdapter() {
  const vault = sdk.vaultAt(s1Vault);
  const adapter = sdk.getContract("FirstPeriodAdapter", s1Adapter);

  eq(await vault.freeVaultUSDT(), CASH_SEED, "freeVaultUSDT before");
  eq(await vault.grossManagedAssets(), CASH_SEED, "grossManagedAssets before");
  eq(await adapter.realAssets(), 0n, "adapter.realAssets before");

  // fundAdapter moves free USDT into the adapter's idle leg. realAssets() must pick the idle
  // balance up so the vault's gross accounting is unchanged (deployment doc change #13).
  const FUND = 400_000_000n;
  const fundReceipt = await sdk.fundAdapter(s1Vault, s1Adapter, FUND, deployer as any);
  assert.ok(indexOfEvent(fundReceipt!.logs, TOPIC.adapterFunded) >= 0, "AdapterFunded emitted");
  console.log(`    AdapterFunded emitted at log #${indexOfEvent(fundReceipt!.logs, TOPIC.adapterFunded)}`);
  eq(await usdt.balanceOf(s1Vault), CASH_SEED - FUND, "vault USDT after fund");
  eq(await usdt.balanceOf(s1Adapter), FUND, "adapter USDT after fund");
  eq(await adapter.realAssets(), FUND, "adapter.realAssets after fund");
  eq(await vault.freeVaultUSDT(), CASH_SEED - FUND, "freeVaultUSDT after fund");
  eq(await vault.grossManagedAssets(), CASH_SEED, "grossManagedAssets after fund (unchanged)");
  eq(await vault.totalAssets(), CASH_SEED, "totalAssets after fund (unchanged)");

  const RECALL = 250_000_000n;
  const recallReceipt = await sdk.recallAdapter(s1Vault, s1Adapter, RECALL, deployer as any);
  assert.ok(indexOfEvent(recallReceipt!.logs, TOPIC.adapterRecalled) >= 0, "AdapterRecalled emitted");
  console.log(`    AdapterRecalled emitted at log #${indexOfEvent(recallReceipt!.logs, TOPIC.adapterRecalled)}`);
  eq(await usdt.balanceOf(s1Vault), CASH_SEED - FUND + RECALL, "vault USDT after recall");
  eq(await usdt.balanceOf(s1Adapter), FUND - RECALL, "adapter USDT after recall");
  eq(await adapter.realAssets(), FUND - RECALL, "adapter.realAssets after recall");
  eq(await vault.totalAssets(), CASH_SEED, "totalAssets after recall (unchanged)");

  // Access control: fundAdapter is Allocator-only (BaseVault.sol:902).
  await assertReverts(
    () => sdk.fundAdapter(s1Vault, s1Adapter, 1n, wallets.investor1),
    "0x82b42900", // Unauthorized()
    "fundAdapter from a non-Allocator",
  );

  // Put it back so scenario 7's accounting reads cleanly.
  await sdk.recallAdapter(s1Vault, s1Adapter, FUND - RECALL, deployer as any);
  eq(await adapter.realAssets(), 0n, "adapter drained");
}

// ---------------------------------------------------------------------------
// Scenario 3 — RWAAdapter + indexer vault->asset links
// ---------------------------------------------------------------------------

let rwaAdapter: Address;
let rwaAssetId: bigint;
let rwaToken: Address;

async function scenario3_rwaAdapterVaultAssetLinks() {
  // Baseline: the three deployed adapters are two FirstPeriodAdapters and one LiquidityAdapter.
  // None carries `rwaToken`, so the indexer's probe caches null and the link set is empty. That
  // is the correct answer, not a bug.
  const before = new OnChainEventIndexer(sdk, provider);
  await before.backfill(forkBlock + 1, "latest");
  eq(before.getVaultAssetLinks(addresses.noteVault).length, 0, "note vault links before RWAAdapter");
  eq(before.getVaultAssetLinks(addresses.cashVault).length, 0, "cash vault links (FirstPeriodAdapter)");

  const reg = await sdk.registerAsset(
    keccak256(toUtf8Bytes("fork-e2e-rwa-metadata")),
    "Fork E2E RWA",
    "fkRWA",
    18,
    FeePaymentKind.Native,
    NO_PRODUCT_INFO,
    deployer as any,
  );
  rwaAssetId = reg.assetId;
  rwaToken = reg.token;
  console.log(`    assetId = ${rwaAssetId}, rwaToken = ${rwaToken}`);
  eq(await sdk.getContract("RWAToken", rwaToken).assetId(), rwaAssetId, "rwaToken.assetId()");

  rwaAdapter = await sdk.deployRWAAdapter(
    {
      asset: raw.usdt,
      vault: addresses.noteVault,
      rwaToken,
      navOracle: addresses.navOracle,
      dealDataStalenessWindow: BigInt(36 * 3600),
    },
    deployer as any,
  );
  console.log(`    rwaAdapter = ${rwaAdapter}`);
  const ad = sdk.getContract("RWAAdapter", rwaAdapter);
  eq(await ad.rwaToken(), rwaToken, "rwaAdapter.rwaToken()");
  eq(await ad.navOracle(), addresses.navOracle, "rwaAdapter.navOracle()");
  eq(await ad.vault(), addresses.noteVault, "rwaAdapter.vault()");

  // AdapterRegistry is gone — the Curator attaches any adapter directly.
  // addAdapter is Curator-direct only while the vault is CONFIGURING (BaseVault.sol:207).
  eq((await sdk.getStateContext(addresses.noteVault)).product, ProductState.CONFIGURING, "note vault CONFIGURING");
  await sdk.addAdapter(addresses.noteVault, rwaAdapter, deployer as any);
  eq(await sdk.vaultAt(addresses.noteVault).isAdapter(rwaAdapter), true, "noteVault.isAdapter(rwaAdapter)");

  const after = new OnChainEventIndexer(sdk, provider);
  await after.backfill(forkBlock + 1, "latest");
  const links = after.getVaultAssetLinks(addresses.noteVault);
  eq(links.length, 1, "note vault link count after RWAAdapter");
  eq(links[0].adapter, rwaAdapter, "link.adapter");
  eq(links[0].rwaToken, rwaToken, "link.rwaToken");
  eq(links[0].assetId, rwaAssetId, "link.assetId");
  eq(after.getVaultAssetIds(addresses.noteVault)[0], rwaAssetId, "getVaultAssetIds");
  eq(after.getVaultsHoldingAsset(rwaAssetId)[0], addresses.noteVault, "getVaultsHoldingAsset");

  const views = await sdk.getVaultAssets(addresses.noteVault, after);
  eq(views.length, 1, "sdk.getVaultAssets length");
  eq(views[0].assetId, rwaAssetId, "vaultAsset.assetId");
  eq(views[0].asset.token, rwaToken, "vaultAsset.asset.token");
  eq(views[0].asset.active, true, "vaultAsset.asset.active");
}

// ---------------------------------------------------------------------------
// Scenario 4 — settlement ordering with a live performance fee (Cash + LP)
// ---------------------------------------------------------------------------

let cashCycle1: bigint;

async function scenario4_settlementOrderingWithFee() {
  const cash = sdk.vaultAt(addresses.cashVault);
  const lp = sdk.vaultAt(addresses.lpVault, "LiquidityEarnVault");
  const t0 = await chainNow(provider);

  // --- configure: 10% performance fee on the Cash Vault, no protocol split (revenuePool unset).
  eq(await cash.revenuePool(), ZeroAddress, "cash revenuePool unset (no protocol split)");
  await (await (cash.connect(deployer) as any).setPerformanceFeeRecipient(wallets.feeRecipient.address)).wait();
  await (await (cash.connect(deployer) as any).setPerformanceFeeBps(1000)).wait();
  eq(await cash.performanceFeeBps(), 1000n, "performanceFeeBps");
  eq(await cash.feeHighWaterMark(), 0n, "feeHighWaterMark before first cycle");

  const params = productParams(t0);
  await sdk.setProductParams(addresses.cashVault, params, deployer as any);
  await sdk.setProductParams(addresses.lpVault, params, deployer as any);
  await wireOperators(addresses.cashVault);
  await wireOperators(addresses.lpVault);
  await sdk.openSubscription(addresses.cashVault, deployer as any);
  await sdk.openSubscription(addresses.lpVault, deployer as any);
  eq(await lp.cashVault(), addresses.cashVault, "lpVault.cashVault()");

  // --- cycle 0: seed the Cash Vault at price 1.0 so the high-water mark is set.
  await fundAndApprove(wallets.investor1, CASH_SEED, addresses.cashVault);
  const cashRid = await requestDeposit(addresses.cashVault, wallets.investor1, CASH_SEED);
  await warpTo(provider, Number(params.subscriptionEnd));
  await sdk.finalizeSubscription(addresses.cashVault, deployer as any);
  await sdk.finalizeSubscription(addresses.lpVault, deployer as any);

  const cycle0 = (await sdk.getStateContext(addresses.cashVault)).cycleNumber;
  // Runbook rule 1+2: the LP Vault and its cashVault() go in one instruction, LP first.
  await (await settlementOperator()).run(
    cycle0,
    [calc(addresses.lpVault), calc(addresses.cashVault, [{ requestId: cashRid, settleAmount: CASH_SEED }])],
    wallets.relayer,
  );
  await (await (cash.connect(wallets.investor1) as any).claimDeposit(cashRid, wallets.investor1.address)).wait();
  eq(await cash.totalAssets(), CASH_SEED, "cash totalAssets after cycle 0");
  eq(await cash.totalSupply(), 1_000_000_000_000_000_000_000n, "cash totalSupply after cycle 0");
  eq(await cash.feeHighWaterMark(), 1_000_000n, "feeHighWaterMark == 1.0 after cycle 0");

  // --- cycle 1 setup: +10% yield on the Cash Vault, and an LP deposit that will bridge in.
  await (await (usdt.connect(deployer) as any).mint(addresses.cashVault, CASH_YIELD)).wait();
  eq(await cash.totalAssets(), CASH_SEED + CASH_YIELD, "cash totalAssets after yield");

  await fundAndApprove(wallets.investor2, LP_DEPOSIT, addresses.lpVault);
  const lpRid = await requestDeposit(addresses.lpVault, wallets.investor2, LP_DEPOSIT);

  const cycleStart = Number(await sdk.stateManager.currentCycleStart(addresses.cashVault));
  await warpTo(provider, cycleStart + 7 * DAY + 1);
  await sdk.startCycleCalculation(addresses.cashVault, deployer as any);
  await sdk.startCycleCalculation(addresses.lpVault, deployer as any);
  cashCycle1 = (await sdk.getStateContext(addresses.cashVault)).cycleNumber;
  eq(cashCycle1, 1n, "cash cycle number");

  /*
   * Expected, from test/SettlementOrdering.t.sol::test_cashVaultFeeAccruesBeforeLpUsdtEnters:
   *   grossPrice   = 1_100e6 * 1e18 / 1_000e18            = 1.100000
   *   profitAssets = 100e6 -> feeAssets = 10e6 (10%)
   *   feeShares    = 10e6 * 1_000e18 / (1_100e6 - 10e6)   = 9.174311926605504587e18
   *   settlement   = 1_100e6 * 1e18 / 1_009.174311926605504587e18 = 1.090000
   *   LP mint      = 220e6 * 1e18 / 1.090000e6            = 201.834862385321100917e18
   * The fee must be taken on pre-existing assets only, and the LP must enter at the POST-fee price.
   */
  const receipt = await (await settlementOperator()).run(
    cashCycle1,
    [calc(addresses.lpVault, [{ requestId: lpRid, settleAmount: LP_DEPOSIT }]), calc(addresses.cashVault)],
    wallets.relayer,
  );

  const snap = await cash.cycleSnapshots(cashCycle1);
  eq(snap.initialized, true, "cycleSnapshots.initialized");
  eq(snap.feeAssets, 10_000_000n, "feeAssets (pre-existing assets only)");
  eq(snap.feeShares, 9_174_311_926_605_504_587n, "feeShares (pre-existing assets only)");
  eq(snap.settlementPrice, 1_090_000n, "settlementPrice (post-fee)");

  const lpCash = await cash.balanceOf(wallets.investor2.address);
  eq(lpCash, 201_834_862_385_321_100_917n, "LP depositor's Cash Tokens (minted at post-fee price)");
  approx(await cash.convertToAssets(lpCash), LP_DEPOSIT, 2n, "LP round-trip value");
  eq(await cash.feeHighWaterMark(), 1_090_000n, "feeHighWaterMark after cycle 1");
  eq(await cash.balanceOf(wallets.feeRecipient.address), 9_174_311_926_605_504_587n, "fee recipient shares");

  // The fee must accrue BEFORE the LP's USDT lands — that ordering is what the two-phase
  // submitBatch split buys, and it is visible in the log order of the single settlement tx.
  assertLogOrder(receipt!.logs, TOPIC.performanceFeeAccrued, TOPIC.depositBridged, "fee accrual precedes bridge");
}

// ---------------------------------------------------------------------------
// Scenario 5 — the three operational rules from docs/settlement-operator-runbook.md
// ---------------------------------------------------------------------------

/**
 * Drains the Cash Vault's free USDT down to 100e6 and queues a redeem only the bridged LP USDT can
 * fund. Mirrors `_setupRedeemGapScenario` in test/SettlementOrdering.t.sol, parking the principal in
 * UnifiedPool through `returnPrincipalToPool` exactly as the Foundry test does — that path was dead
 * on this deployment until the StateManager rebind (scenario 9). Parking moves USDT out of
 * `freeVaultUSDT()` while leaving `totalAssets()` untouched.
 */
const REDEEM_SHARES = 200_000_000_000_000_000_000n; // 200e18
const FREE_AFTER_PARKING = 100_000_000n; // 100e6

async function setupRedeemGap() {
  const cash = sdk.vaultAt(addresses.cashVault);
  const assetsBefore: bigint = await cash.totalAssets();

  const redeemReceipt = await (
    await (cash.connect(wallets.investor1) as any).requestRedeem(REDEEM_SHARES, wallets.investor1.address)
  ).wait();
  let redeemRid = 0n;
  for (const log of redeemReceipt.logs) {
    const parsed = cash.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed?.name === "RedeemRequested") redeemRid = BigInt(parsed.args[0]);
  }

  const free: bigint = await cash.freeVaultUSDT();
  const parked = free - FREE_AFTER_PARKING;
  const poolPendingBefore: bigint = await sdk.unifiedPool.pending(addresses.cashVault);
  await (
    await (cash.connect(wallets.operator1) as any).returnPrincipalToPool(parked)
  ).wait();
  eq(
    await sdk.unifiedPool.pending(addresses.cashVault),
    poolPendingBefore + parked,
    "pool.pending(cash) credited by parking",
  );
  eq(await cash.freeVaultUSDT(), FREE_AFTER_PARKING, "cash freeVaultUSDT after parking");
  eq(await cash.totalAssets(), assetsBefore, "cash totalAssets unchanged by parking");

  await fundAndApprove(wallets.investor2, LP_DEPOSIT, addresses.lpVault);
  const lpRid = await requestDeposit(addresses.lpVault, wallets.investor2, LP_DEPOSIT);

  const cycleStart = Number(await sdk.stateManager.currentCycleStart(addresses.cashVault));
  await warpTo(provider, cycleStart + 7 * DAY + 1);
  await sdk.startCycleCalculation(addresses.cashVault, deployer as any);
  await sdk.startCycleCalculation(addresses.lpVault, deployer as any);
  const cycle = (await sdk.getStateContext(addresses.cashVault)).cycleNumber;

  // What the redeem will cost at the cycle's settlement price — the `acceptedRedeemTotal` the
  // liquidity check compares against.
  const owed: bigint = await cash.convertToAssets(REDEEM_SHARES);
  console.log(`    redeem owes ${owed} against ${FREE_AFTER_PARKING} of free vault USDT`);
  return { lpRid, redeemRid, cycle, owed };
}

async function scenario5a_cashAloneReverts() {
  const { redeemRid, cycle } = await setupRedeemGap();
  await assertReverts(
    async () =>
      (await settlementOperator()).run(
        cycle,
        [calc(addresses.cashVault, [], [{ requestId: redeemRid, settleAmount: REDEEM_SHARES }])],
        wallets.relayer,
      ),
    INSUFFICIENT_LIQUIDITY_SELECTOR,
    "Cash Vault alone (rule 1 violated)",
  );
}

async function scenario5b_wrongOrderReverts() {
  const { lpRid, redeemRid, cycle } = await setupRedeemGap();
  await assertReverts(
    async () =>
      (await settlementOperator()).run(
        cycle,
        [
          calc(addresses.cashVault, [], [{ requestId: redeemRid, settleAmount: REDEEM_SHARES }]),
          calc(addresses.lpVault, [{ requestId: lpRid, settleAmount: LP_DEPOSIT }]),
        ],
        wallets.relayer,
      ),
    INSUFFICIENT_LIQUIDITY_SELECTOR,
    "Cash Vault before LP Vault (rule 2 violated)",
  );
}

async function scenario5c_correctOrderFundsRedeem() {
  const cash = sdk.vaultAt(addresses.cashVault);
  const { lpRid, redeemRid, cycle, owed } = await setupRedeemGap();
  const receipt = await (await settlementOperator()).run(
    cycle,
    [
      calc(addresses.lpVault, [{ requestId: lpRid, settleAmount: LP_DEPOSIT }]),
      calc(addresses.cashVault, [], [{ requestId: redeemRid, settleAmount: REDEEM_SHARES }]),
    ],
    wallets.relayer,
  );
  assertLogOrder(receipt!.logs, TOPIC.depositBridged, TOPIC.redeemSettled, "bridge inflow precedes redeem settle");

  const snap = await cash.cycleSnapshots(cycle);
  const before = await usdt.balanceOf(wallets.investor1.address);
  await (await (cash.connect(wallets.investor1) as any).claimRedeem(redeemRid, wallets.investor1.address)).wait();
  const paid = (await usdt.balanceOf(wallets.investor1.address)) - before;
  eq(paid, owed, "redeem paid the full amount owed");
  eq(paid, (REDEEM_SHARES * snap.settlementPrice) / 10n ** 18n, "redeem priced at the cycle settlementPrice");
  eq(snap.settlementPrice, 1_090_000n, "settlementPrice still the post-fee 1.090000 (no new profit)");
}

async function scenario5d_allocatorBridgeAuthorisation() {
  // Runbook rule 3 claims LiquidityBridge.bridgeDeposit has "no on-chain backstop at all": it
  // authorises the vault OR its Allocator (LiquidityBridge.sol:52). Verify what actually stops an
  // off-cycle Allocator bridge — the authorisation check, or something else.
  const bridge = sdk.liquidityBridge;
  const alloc = await sdk.vaultAt(addresses.lpVault, "LiquidityEarnVault").allocator();
  eq(alloc, DEPLOY_WALLET, "lpVault.allocator() is the impersonated deploy wallet");
  eq(await usdt.allowance(addresses.lpVault, addresses.liquidityBridge), 0n, "lpVault -> bridge allowance");

  // Not CallerNotAuthorized(address) — the Allocator IS authorised, exactly as the runbook says.
  // The only thing that stops it is the ERC-20 allowance: LiquidityEarnVault.settle approves the
  // bridge for the exact cycle amount and consumes it in full, leaving zero.
  await assertReverts(
    () => (bridge.connect(deployer) as any).bridgeDeposit(1_000_000n, addresses.lpVault, addresses.cashVault),
    "MockUSDT: allowance",
    "off-cycle Allocator bridgeDeposit",
  );
}

// ---------------------------------------------------------------------------
// Scenario 6 — KeeperBot + SettlementOperator runners against the fork
// ---------------------------------------------------------------------------

function runScript(script: string, args: string[]): string {
  const out = execFileSync("npx", ["tsx", script, ...args], {
    cwd: REPO_OFFCHAIN,
    encoding: "utf-8",
    env: { ...process.env },
  });
  console.log(
    out
      .trimEnd()
      .split("\n")
      .map((l) => `    | ${l}`)
      .join("\n"),
  );
  return out;
}

async function scenario6_keeperAndSettlementRunners() {
  const note = sdk.vaultAt(addresses.noteVault);
  const t0 = await chainNow(provider);
  const params = productParams(t0, { subscriptionEnd: BigInt(t0 + 300) });
  await sdk.setProductParams(addresses.noteVault, params, deployer as any);
  await wireOperators(addresses.noteVault);
  eq((await sdk.getStateContext(addresses.noteVault)).product, ProductState.CONFIGURING, "note product before keeper");

  // Tick 1: CONFIGURING -> SUBSCRIBING.
  runScript("scripts/runKeeper.ts", [
    "--rpc", provider._getConnection().url,
    "--impersonate", DEPLOY_WALLET,
    "--vaults", "note",
    "--once",
  ]);
  eq((await sdk.getStateContext(addresses.noteVault)).product, ProductState.SUBSCRIBING, "note product after tick 1");

  const NOTE_DEPOSIT = 500_000_000n;
  await fundAndApprove(wallets.investor1, NOTE_DEPOSIT, addresses.noteVault);
  const rid = await requestDeposit(addresses.noteVault, wallets.investor1, NOTE_DEPOSIT);

  // Tick 2 before subscriptionEnd must be a no-op (the bot swallows ConditionNotMet).
  runScript("scripts/runKeeper.ts", [
    "--rpc", provider._getConnection().url,
    "--impersonate", DEPLOY_WALLET,
    "--vaults", "note",
    "--once",
  ]);
  eq((await sdk.getStateContext(addresses.noteVault)).product, ProductState.SUBSCRIBING, "still SUBSCRIBING (not due)");

  // Tick 3 after subscriptionEnd: SUBSCRIBING -> OPERATING.
  await warpTo(provider, Number(params.subscriptionEnd) + 1);
  runScript("scripts/runKeeper.ts", [
    "--rpc", provider._getConnection().url,
    "--impersonate", DEPLOY_WALLET,
    "--vaults", "note",
    "--once",
  ]);
  const ctx = await sdk.getStateContext(addresses.noteVault);
  eq(ctx.product, ProductState.OPERATING, "note product after tick 3");
  eq(ctx.cycle, CycleState.CALCULATING, "note cycle after tick 3");

  // Settle through the runSettlement.ts CLI.
  const specPath = join(tmpdir(), "hypertessera-note-batch.fork.json");
  writeFileSync(
    specPath,
    JSON.stringify(
      {
        cycleNumber: ctx.cycleNumber.toString(),
        vaults: [
          {
            vault: addresses.noteVault,
            amount: "0",
            deposits: [{ requestId: rid.toString(), settleAmount: NOTE_DEPOSIT.toString() }],
            redeems: [],
          },
        ],
      },
      null,
      2,
    ),
  );
  const skew = (await chainNow(provider)) - Math.floor(Date.now() / 1000);
  runScript("scripts/runSettlement.ts", [
    "--rpc", provider._getConnection().url,
    "--spec", specPath,
    // See the note on `settlementOperator()` — validUntil comes from the host clock, and this
    // fork's clock has been warped weeks ahead.
    "--validity", String(Math.max(3600, skew + 3600)),
    "--operator-pks", `${wallets.operator1.privateKey},${wallets.operator2.privateKey}`,
    "--relayer-pk", wallets.relayer.privateKey,
  ]);

  const snap = await note.cycleSnapshots(ctx.cycleNumber);
  eq(snap.initialized, true, "note cycleSnapshots.initialized");
  eq(snap.settlementPrice, 1_000_000n, "note settlementPrice");
  eq(await note.totalAssets(), NOTE_DEPOSIT, "note totalAssets after settle");
  eq((await note.getDepositRequest(rid)).state, 2n, "note request state == SETTLED");
}

// ---------------------------------------------------------------------------
// Scenario 7 — indexer deposit-event ingestion over fork logs
// ---------------------------------------------------------------------------

async function scenario7_indexerDepositIngestion() {
  const indexer = new OnChainEventIndexer(sdk, provider);
  await indexer.backfill(forkBlock + 1, "latest");

  // Cash Vault: one deposit request, settled and claimed in scenario 4.
  const cashRecord = indexer.getDepositRecord(addresses.cashVault, 1n);
  assert.ok(cashRecord, "cash deposit record #1 indexed");
  eq(cashRecord!.assets, CASH_SEED, "indexed cash deposit assets");
  eq(cashRecord!.owner, wallets.investor1.address, "indexed cash deposit owner");
  eq(cashRecord!.settled, true, "indexed cash deposit settled");
  eq(cashRecord!.claimed, true, "indexed cash deposit claimed");
  eq(indexer.getPendingDeposits(addresses.cashVault).length, 0, "no pending cash deposits");

  // Note Vault: settled in scenario 6, never claimed.
  const noteRecord = indexer.getDepositRecord(addresses.noteVault, 1n);
  assert.ok(noteRecord, "note deposit record #1 indexed");
  eq(noteRecord!.settled, true, "indexed note deposit settled");
  eq(noteRecord!.claimed, false, "indexed note deposit not claimed");

  const snap = await indexer.getQueueSnapshot(addresses.cashVault);
  console.log(`    cash queue snapshot: deposit=${snap.depositDepth} redeem=${snap.redeemDepth}`);

  // SDK view built on the indexer.
  const view = await sdk.getDepositRequest(addresses.cashVault, 1n, indexer);
  eq(view.state, 3, "sdk.getDepositRequest state == CLAIMED");
}

/**
 * Documents how anvil answers `eth_getLogs` over pre-fork history: the range below the fork block
 * is proxied to the upstream archive RPC, which usually rejects a genesis-wide range. This is why
 * every backfill above starts at `forkBlock + 1` rather than 0.
 */
async function scenario8_preForkGetLogsBehaviour() {
  const indexer = new OnChainEventIndexer(sdk, provider);
  try {
    await indexer.backfill(0, "latest");
    console.log("    backfill(0) succeeded — upstream served the full pre-fork range");
    eq(indexer.getDepositRecord(addresses.cashVault, 1n) !== undefined, true, "post-fork events still indexed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`    backfill(0) rejected by the upstream RPC: ${message.split("\n")[0].slice(0, 200)}`);
    console.log("    -> callers must pass fromBlock >= the fork block. Recorded, not skipped.");
  }
}

// ---------------------------------------------------------------------------
// Scenario 9 — UnifiedPool StateManager wiring and the vault -> pool principal path
// ---------------------------------------------------------------------------

/**
 * `UnifiedPool.sm` is written once in `initialize()` and has no setter. The v3 generation shipped
 * with it bound to `StubStateManager` — the W1/W2 scaffold, which registers no vaults — because
 * the pool was created in the W1/W2 stage, before the real StateManager existed. Consequence:
 * `UnifiedPool.receiveVaultPrincipal` (`src/asset-management/settlement/UnifiedPool.sol:218`)
 * gates on `sm.registeredVaults(msg.sender)`, false for all three Vaults, so
 * `BaseVault.returnPrincipalToPool` (`src/asset-management/vaults/BaseVault.sol:860`) always
 * reverted `UnregisteredVault(vault)`.
 *
 * Corrected in place on 2026-08-17 by `UnifiedPool.reinitializeStateManager`, a `reinitializer(2)`
 * delivered through the governor-gated UUPS `upgradeToAndCall` (proxy address unchanged; see
 * docs/deployment-bsctestnet-2026-08-17-v3.md). `script/deploy/DeployVaults.s.sol` now deploys the
 * pool alongside the real StateManager, so a fresh generation initialises correctly in one shot
 * and never calls the reinitialiser.
 *
 * This scenario pins the corrected wiring and drives the previously dead path end to end.
 */
async function scenario9_unifiedPoolStateManagerWiring() {
  const pool = sdk.unifiedPool;
  const poolSm: string = await pool.sm();
  console.log(`    UnifiedPool.sm()   = ${poolSm}`);
  console.log(`    Settlement.sm()    = ${await sdk.settlement.sm()}`);
  console.log(`    Queue.sm()         = ${await sdk.queue.sm()}`);

  eq(poolSm.toLowerCase(), addresses.stateManager.toLowerCase(), "UnifiedPool.sm == real StateManager");
  eq(
    (await sdk.settlement.sm()).toLowerCase(),
    poolSm.toLowerCase(),
    "Settlement.sm == UnifiedPool.sm",
  );
  eq((await sdk.queue.sm()).toLowerCase(), poolSm.toLowerCase(), "Queue.sm == UnifiedPool.sm");

  for (const [name, vault] of [
    ["cash", addresses.cashVault],
    ["note", addresses.noteVault],
    ["lp", addresses.lpVault],
  ] as const) {
    eq(await sdk.stateManager.registeredVaults(vault), true, `StateManager.registeredVaults(${name})`);
    eq(await pool.vaultConfigured(vault), true, `UnifiedPool.vaultConfigured(${name})`);
  }

  // The call that used to revert UnregisteredVault now credits the pool ledger.
  const AMOUNT = 1_000_000n;
  await (await (usdt.connect(deployer) as any).mint(addresses.cashVault, AMOUNT)).wait();

  const pendingBefore: bigint = await pool.pending(addresses.cashVault);
  const totalBefore: bigint = await pool.totalPending();
  const poolUsdtBefore: bigint = await usdt.balanceOf(addresses.unifiedPool);

  await (
    await (sdk.vaultAt(addresses.cashVault).connect(wallets.operator1) as any).returnPrincipalToPool(AMOUNT)
  ).wait();

  eq(await pool.pending(addresses.cashVault), pendingBefore + AMOUNT, "pool.pending(cash) after return");
  eq(await pool.totalPending(), totalBefore + AMOUNT, "pool.totalPending after return");
  eq(await usdt.balanceOf(addresses.unifiedPool), poolUsdtBefore + AMOUNT, "pool USDT balance after return");

  // The reinitialiser is one-shot and already spent on this deployment. Reached through an
  // explicit fragment: it is a one-time governance entry point, not part of the SDK's pool ABI.
  const poolAsGovernor = new Contract(
    addresses.unifiedPool,
    ["function reinitializeStateManager(address stateManager_)"],
    deployer,
  );
  await assertReverts(
    () => (poolAsGovernor as any).reinitializeStateManager.staticCall(addresses.stateManager),
    "0xf92ee8a9", // Initializable.InvalidInitialization()
    "second reinitializeStateManager on the live pool",
  );
}

// ---------------------------------------------------------------------------

/** InsufficientSettlementLiquidity(uint256,uint256) — computed, never guessed. */
const INSUFFICIENT_LIQUIDITY_SELECTOR = vaultIface
  .getError("InsufficientSettlementLiquidity")!
  .selector;

async function main() {
  const net = await provider.getNetwork();
  forkBlock = await provider.getBlockNumber();
  console.log(`Fork RPC ${provider._getConnection().url}  chainId ${net.chainId}  block ${forkBlock}`);
  console.log(`Address book: offchain/scripts/testnet/addresses.bscTestnet.json (v3 generation)`);
  console.log(`InsufficientSettlementLiquidity selector = ${INSUFFICIENT_LIQUIDITY_SELECTOR}`);

  deployer = await impersonate(provider, DEPLOY_WALLET);

  await scenario("1. Zero-to-one product flow (registerAsset -> claimDeposit)", scenario1_zeroToOne);
  await scenario("2. fundAdapter / recallAdapter", scenario2_fundAndRecallAdapter);
  await scenario("3. RWAAdapter + indexer vault->asset links", scenario3_rwaAdapterVaultAssetLinks);
  await scenario("4. Settlement ordering with a live performance fee", scenario4_settlementOrderingWithFee);

  // Scenarios 5a-5d are alternative continuations of the same post-cycle-1 state, so each runs
  // from its own snapshot.
  for (const [name, fn] of [
    ["5a. Cash Vault alone reverts InsufficientSettlementLiquidity", scenario5a_cashAloneReverts],
    ["5b. Cash-before-LP order reverts InsufficientSettlementLiquidity", scenario5b_wrongOrderReverts],
    ["5c. LP-before-Cash funds the same-cycle redeem", scenario5c_correctOrderFundsRedeem],
    ["5d. Allocator bridgeDeposit authorisation (runbook rule 3)", scenario5d_allocatorBridgeAuthorisation],
  ] as [string, () => Promise<void>][]) {
    const id = await snapshot(provider);
    await scenario(name, fn);
    await revertTo(provider, id);
  }

  await scenario("6. KeeperBot + SettlementOperator runners", scenario6_keeperAndSettlementRunners);
  await scenario("7. Indexer deposit-event ingestion", scenario7_indexerDepositIngestion);
  await scenario("8. anvil eth_getLogs over pre-fork history", scenario8_preForkGetLogsBehaviour);
  await scenario("9. UnifiedPool StateManager wiring + returnPrincipalToPool", scenario9_unifiedPoolStateManagerWiring);

  console.log("\n=====================================================");
  for (const r of results) {
    console.log(`${r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${r.name}`);
    if (!r.ok) console.log(`      ${r.error?.split("\n")[0]}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} scenarios passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
