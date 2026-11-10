import assert from "node:assert/strict";
import { Contract, Wallet } from "ethers";
import { getAbi } from "../../src/abis.js";
import { HyperTesseraSDK } from "../../src/sdk.js";
import { OnChainEventIndexer } from "../../src/indexer.js";
import { KeeperBot } from "../../src/keeperBot.js";
import { SettlementOperator } from "../../src/settlementOperator.js";
import { ProductState, CycleState, SettlementMode } from "../../src/types.js";
import { loadLocalDeployment } from "./config.js";

const { addresses, raw, provider, wallets } = loadLocalDeployment();
const sdk = new HyperTesseraSDK(addresses, provider);
const usdt = new Contract(
  raw.usdt,
  [
    "function mint(address to, uint256 amount) external",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
  ],
  provider,
);

const rwaToken = Wallet.createRandom().address; // stand-in RWA token address; updateNAV only uses it as a mapping key, never reads its code.

async function advanceTime(seconds: number) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

async function assertReverts(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
    throw new Error(`expected revert for: ${label}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("expected revert for:")) throw err;
  }
}

const DAY = 86400;

async function setProductParams(
  vault: string,
  overrides: Partial<{
    subscriptionEnd: number;
    walletSubscriptionCap: bigint;
    minRaiseAmount: bigint;
    cycleDuration: number;
  }>,
) {
  const now = Math.floor(Date.now() / 1000);
  const params = {
    subscriptionStart: 0,
    subscriptionEnd: now + 4,
    walletSubscriptionCap: 10_000_000_000_000n,
    minRaiseAmount: 0n,
    subscriptionCapShare: 0n,
    cycleDuration: 2,
    maturityTimestamp: now + 365 * DAY,
    claimingStart: now + 366 * DAY,
    claimingEnd: now + 367 * DAY,
    feeParams: 0,
    ...overrides,
  };
  await (await sdk.stateManager.connect(wallets.curator).getFunction("setProductParams")(vault, params)).wait();
}

async function fundInvestor(investor: string, amount: bigint, vault: string) {
  await (await (usdt.connect(wallets.governor) as any).mint(investor, amount)).wait();
  const investorWallet = Object.values(wallets).find((w) => w.address === investor)!;
  await (await (usdt.connect(investorWallet) as any).approve(vault, amount)).wait();
}

async function signNav(price: bigint, signer = wallets.governor) {
  const block = await provider.getBlock("latest");
  const dataTimestamp = BigInt(block!.timestamp);
  const sig = await sdk.signNAVUpdate(rwaToken, price, dataTimestamp, signer);
  await sdk.updateNAV(rwaToken, price, dataTimestamp, sig, signer);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  error?: string;
}
const results: Result[] = [];

async function scenario(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`\x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: message });
    console.log(`\x1b[31m✗\x1b[0m ${name}`);
    console.log(`  ${message.split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenario1_deploySanity() {
  for (const [key, value] of Object.entries(addresses)) {
    const code = await provider.getCode(value as string);
    assert.notEqual(code, "0x", `${key} (${value}) has no code`);
  }

  // Only GOVERNOR_ROLE remains a real HyperAccessControl grant under the Vault-local/Asset-local
  // RBAC model; every other role below is checked via IVaultRoles on each Vault (or, for asset-side
  // roles, via AssetRegistry/MintBurnController) instead of a global role hash.
  const ac = sdk.hyperAccessControl;
  const governorRole = await ac.GOVERNOR_ROLE();
  assert.equal(await ac.hasRole(governorRole, wallets.governor.address), true, "GOVERNOR_ROLE not granted to governor");

  for (const tranche of ["cash", "note", "lp"] as const) {
    const vault = sdk.vault(tranche);
    assert.equal((await vault.owner()).toLowerCase(), wallets.governor.address.toLowerCase(), `${tranche} vault Owner`);
    assert.equal((await vault.curator()).toLowerCase(), wallets.curator.address.toLowerCase(), `${tranche} vault Curator`);
    assert.equal((await vault.guardian()).toLowerCase(), wallets.guardian.address.toLowerCase(), `${tranche} vault Guardian`);
    assert.equal((await vault.allocator()).toLowerCase(), wallets.curator.address.toLowerCase(), `${tranche} vault Allocator`);
    assert.equal(await vault.isKeeper(wallets.governor.address), true, `${tranche} vault Owner should be an implicit Keeper`);
  }

  const assetRegistry = new Contract(addresses.assetRegistry, getAbi("AssetRegistry"), provider);
  const mbc = new Contract(addresses.mintBurnController, getAbi("MintBurnController"), provider);
  assert.equal((await assetRegistry.ownerOf(1n)).toLowerCase(), wallets.governor.address.toLowerCase(), "S Token Issuer (AssetRegistry owner)");
  assert.equal((await mbc.tokenAgentOf(1n)).toLowerCase(), wallets.tokenAgent.address.toLowerCase(), "S Token Agent");

  assert.equal(await sdk.adapterFactory.isAdapter(addresses.cashAdapter), true);
  assert.equal(await sdk.adapterFactory.isAdapter(addresses.noteAdapter), true);
  assert.equal(await sdk.adapterFactory.isAdapter(addresses.lpAdapter), true);

  const lpVault = sdk.vault("lp");
  assert.equal((await lpVault.adapter()).toLowerCase(), addresses.lpAdapter.toLowerCase());

  for (const tranche of ["cash", "note", "lp"] as const) {
    const settlementAddr = await sdk.vault(tranche).settlement();
    assert.equal(settlementAddr.toLowerCase(), addresses.settlement.toLowerCase(), `${tranche} vault settlement not wired`);
  }
}

async function scenario2_roleGatingNegatives() {
  await assertReverts(
    () => sdk.unifiedPool.connect(wallets.investor1).getFunction("addVault")(wallets.investor1.address),
    "non-owner addVault",
  );
  await assertReverts(
    () =>
      sdk.unifiedPool
        .connect(wallets.investor1)
        .getFunction("operatorTransfer")(addresses.cashVault, wallets.investor1.address, 1n, "0x" + "00".repeat(32)),
    "non-settlement-operator operatorTransfer",
  );
  await assertReverts(
    () => sdk.stateManager.connect(wallets.investor1).getFunction("openSubscription")(addresses.cashVault),
    "non-keeper openSubscription",
  );
  await assertReverts(async () => {
    const governorRole = await sdk.hyperAccessControl.GOVERNOR_ROLE();
    await sdk.hyperAccessControl.connect(wallets.investor1).getFunction("grantRole")(governorRole, wallets.investor1.address);
  }, "non-governor grantRole");
}

async function scenario3_guardianPauseBlocksSubscription() {
  await setProductParams(addresses.cashVault, {});

  const PAUSED_BY_GUARDIAN = 1;
  await (await sdk.stateManager.connect(wallets.guardian).getFunction("pause")(addresses.cashVault, PAUSED_BY_GUARDIAN)).wait();
  assert.equal(await sdk.isVaultActive(addresses.cashVault), false);

  await fundInvestor(wallets.investor1.address, 1_000_000n, addresses.cashVault);
  await assertReverts(
    () => sdk.requestDeposit("cash", 500_000n, wallets.investor1.address, wallets.investor1),
    "requestDeposit while guardian-paused",
  );

  await (await sdk.stateManager.connect(wallets.governor).getFunction("unpause")(addresses.cashVault)).wait();
  assert.equal(await sdk.isVaultActive(addresses.cashVault), true);
}

let cashDepositId1: bigint;
let cashDepositId2: bigint;

async function scenario4_fullSubscriptionCycle() {
  await sdk.openSubscription(addresses.cashVault, wallets.governor);
  let state = await sdk.getStateContext(addresses.cashVault);
  assert.equal(state.product, ProductState.SUBSCRIBING);

  // investor1 already funded/approved in scenario 3; approve again in case allowance was spent.
  await fundInvestor(wallets.investor1.address, 1_000_000n, addresses.cashVault);
  await fundInvestor(wallets.investor2.address, 300_000n, addresses.cashVault);

  cashDepositId1 = await sdk.requestDeposit("cash", 500_000n, wallets.investor1.address, wallets.investor1);
  cashDepositId2 = await sdk.requestDeposit("cash", 300_000n, wallets.investor2.address, wallets.investor2);

  const indexerBefore = new OnChainEventIndexer(sdk, provider);
  await indexerBefore.backfill();
  assert.equal(indexerBefore.getPendingDeposits(addresses.cashVault).length, 2);

  await advanceTime(5);
  const keeper = new KeeperBot(sdk, { vaults: [addresses.cashVault], signer: wallets.governor });
  await keeper.tick();
  state = await sdk.getStateContext(addresses.cashVault);
  assert.equal(state.product, ProductState.OPERATING);

  await advanceTime(3);
  await keeper.tick();
  state = await sdk.getStateContext(addresses.cashVault);
  assert.equal(state.cycle, CycleState.CALCULATING);

  await (await sdk.navOracle.connect(wallets.governor).getFunction("setSigner")(rwaToken, wallets.governor.address)).wait();
  await signNav(1_000_000n);
  const { price: freshPrice } = await sdk.getNAV(rwaToken);
  assert.equal(freshPrice, 1_000_000n);

  const operator = new SettlementOperator(sdk, { operatorSigners: [wallets.settlementOperator1, wallets.settlementOperator2] });
  const receipt = await operator.run(
    state.cycleNumber,
    [
      {
        vault: addresses.cashVault,
        amount: 0n,
        deposits: [
          { requestId: cashDepositId1, settleAmount: 500_000n },
          { requestId: cashDepositId2, settleAmount: 300_000n },
        ],
        redeems: [],
      },
    ],
    wallets.governor, // relayer — submitBatch is permissionless
  );
  assert.equal(receipt.status, 1);

  state = await sdk.getStateContext(addresses.cashVault);
  assert.equal(state.cycle, CycleState.ACCEPTING);

  await sdk.claimDeposit("cash", cashDepositId1, wallets.investor1.address, wallets.investor1);
  await sdk.claimDeposit("cash", cashDepositId2, wallets.investor2.address, wallets.investor2);

  const cashVault = sdk.vault("cash");
  assert.ok((await cashVault.balanceOf(wallets.investor1.address)) > 0n);
  assert.ok((await cashVault.balanceOf(wallets.investor2.address)) > 0n);

  const indexerAfter = new OnChainEventIndexer(sdk, provider);
  await indexerAfter.backfill();
  assert.equal(indexerAfter.getPendingDeposits(addresses.cashVault).length, 0);
}

async function scenario5_redemptionAndQueueClearing() {
  const cashVault = sdk.vault("cash");
  const shares = await cashVault.balanceOf(wallets.investor1.address);
  const redeemShares = shares / 2n;
  assert.ok(redeemShares > 0n, "investor1 must hold shares from scenario 4");

  const requestId = await sdk.requestRedeem("cash", redeemShares, wallets.investor1.address, wallets.investor1);

  const indexerBefore = new OnChainEventIndexer(sdk, provider);
  await indexerBefore.backfill();
  const clearing = indexerBefore.getClearingList(addresses.cashVault);
  assert.ok(clearing.some((r) => r.requestId === requestId), "redeem request not seen in clearing list");

  await advanceTime(3);
  const keeper = new KeeperBot(sdk, { vaults: [addresses.cashVault], signer: wallets.governor });
  await keeper.tick();
  const state = await sdk.getStateContext(addresses.cashVault);
  assert.equal(state.cycle, CycleState.CALCULATING);

  await signNav(1_000_000n);

  // Net settlement (development-plan.md §8): the redeem payout is computed entirely on-chain by
  // BaseVault from its own per-cycle price snapshot (shares are 1e18-scale; USDT is 6-decimal),
  // and `amount` here is just poolDistributedAssets — funding UnifiedPool sends to the vault this
  // cycle. There's no automatic fee deduction on repayInterest anymore, so no gross-up is needed;
  // this is just exercising the repayInterest -> distribute funding path (the vault's own USDT
  // balance from scenario 4's deposits would already cover this redeem on its own).
  const PRICE_ONE = 1_000_000n;
  const SHARE_SCALE = 10n ** 18n;
  const payout = (redeemShares * PRICE_ONE) / SHARE_SCALE;
  await (await (usdt.connect(wallets.governor) as any).mint(wallets.issuer.address, payout)).wait();
  await (await (usdt.connect(wallets.issuer) as any).approve(addresses.unifiedPool, payout)).wait();
  await sdk.repayInterest(payout, wallets.issuer);
  await sdk.attributeInterest(addresses.cashVault, payout, wallets.settlementOperator1);
  assert.ok((await sdk.pending(addresses.cashVault)) >= payout, "pending[cashVault] must cover the redeem payout");

  const operator = new SettlementOperator(sdk, { operatorSigners: [wallets.settlementOperator1, wallets.settlementOperator2] });
  await operator.run(
    state.cycleNumber,
    [
      {
        vault: addresses.cashVault,
        amount: payout,
        deposits: [],
        redeems: [{ requestId, settleAmount: redeemShares }],
      },
    ],
    wallets.governor,
  );

  await sdk.claimRedeem("cash", requestId, wallets.investor1.address, wallets.investor1);

  const indexerAfter = new OnChainEventIndexer(sdk, provider);
  await indexerAfter.backfill();
  assert.equal(indexerAfter.getClearingList(addresses.cashVault).length, 0);
}

async function scenario6_navDeviationCap() {
  await assertReverts(async () => {
    const block = await provider.getBlock("latest");
    const dataTimestamp = BigInt(block!.timestamp) + 10n; // strictly newer than the last accepted reading
    const price = 1_500_000n; // +50%, beyond the 20% cap
    const sig = await sdk.signNAVUpdate(rwaToken, price, dataTimestamp, wallets.governor);
    await sdk.updateNAV(rwaToken, price, dataTimestamp, sig, wallets.governor);
  }, "NAV upward deviation beyond cap");

  await advanceTime(5);
  await signNav(900_000n); // -10% downward move — always allowed
  const { price } = await sdk.getNAV(rwaToken);
  assert.equal(price, 900_000n);

  // Restore to 1.0 for later scenarios.
  await advanceTime(5);
  await signNav(1_000_000n);
}

async function scenario7_fundingFailedRefund() {
  const now = Math.floor(Date.now() / 1000);
  await setProductParams(addresses.noteVault, {
    subscriptionEnd: now + 4,
    minRaiseAmount: 1_000_000_000n, // unreachable
  });
  await sdk.openSubscription(addresses.noteVault, wallets.governor);

  await fundInvestor(wallets.investor2.address, 100_000n, addresses.noteVault);
  const noteDepositId = await sdk.requestDeposit("note", 100_000n, wallets.investor2.address, wallets.investor2);

  await advanceTime(5);
  const keeper = new KeeperBot(sdk, { vaults: [addresses.noteVault], signer: wallets.governor });
  await keeper.tick();

  const state = await sdk.getStateContext(addresses.noteVault);
  assert.equal(state.product, ProductState.FUNDING_FAILED);

  // markRefundable is Curator-gated (2026-08 client fixes, Task 2) — the vault's Curator marks
  // affected deposit requests REFUNDABLE before claimRefund becomes callable.
  await (await sdk.vault("note").connect(wallets.curator).getFunction("markRefundable")([noteDepositId])).wait();

  const balanceBefore = await usdt.balanceOf(wallets.investor2.address);
  await sdk.claimRefund("note", noteDepositId, wallets.governor); // claimRefund is permissionless; funds go to req.owner regardless of caller
  const balanceAfter = await usdt.balanceOf(wallets.investor2.address);
  assert.ok(balanceAfter > balanceBefore, "refund did not return USDT");
}

async function scenario8_adapterBuyOrder() {
  const cashAdapter = sdk.adapter("cash");
  const destination = wallets.issuer.address; // stand-in RWA counterparty

  // Capital sourcing (development-plan.md §7 "Vault-to-Strategy capital sourcing"): the Vault
  // itself deposits into the Adapter via the inherited ERC-4626 `deposit(assets, vault)`, pulling
  // USDT under a prior Vault approval. EarnVault has no operator-triggerable escape hatch to do
  // this itself in the current contracts (mirrors `test/BaseAdapter.t.sol`'s own `vm.prank
  // (vaultAddr)` helper) — anvil's account impersonation stands in for that same call here.
  await (await (usdt.connect(wallets.governor) as any).mint(addresses.cashVault, 200_000n)).wait();
  await provider.send("anvil_setBalance", [addresses.cashVault, "0x8AC7230489E80000"]); // 10 ETH — impersonation still needs gas
  await provider.send("anvil_impersonateAccount", [addresses.cashVault]);
  const vaultSigner = await provider.getSigner(addresses.cashVault);
  await (await (usdt.connect(vaultSigner) as any).approve(addresses.cashAdapter, 200_000n)).wait();
  await (await cashAdapter.connect(vaultSigner).getFunction("deposit")(200_000n, addresses.cashVault)).wait();
  await provider.send("anvil_stopImpersonatingAccount", [addresses.cashVault]);

  const orderTx = await cashAdapter.connect(wallets.curator).getFunction("createBuyOrder")(
    200_000n,
    destination,
    SettlementMode.VALUE_RETURN,
  );
  const orderReceipt = await orderTx.wait();
  const created = cashAdapter.interface.parseLog(orderReceipt.logs.find((l: any) => l.address.toLowerCase() === (cashAdapter.target as string).toLowerCase())!);
  const orderId = created!.args.orderId as bigint;

  await (await cashAdapter.connect(wallets.curator).getFunction("executeBuy")(orderId)).wait();

  const realAssetsAfterBuy = await cashAdapter.realAssets();
  assert.ok(realAssetsAfterBuy >= 200_000n, "realAssets should reflect deployed capital");

  await (await cashAdapter.connect(wallets.dataProvider).getFunction("updateDealData")(orderId, 210_000n)).wait();
  const pending = await cashAdapter.pendingDeposits(orderId);
  assert.equal(pending.dealValue, 210_000n);
}

/**
 * ReservePSM is now a fully independent, two-mode asset-wrap module (net settlement conversion,
 * development-plan.md §8) — no more Vault/Settlement/StateManager coupling. Deploy.s.sol
 * configures demo asset 1 (S Token) as Token Custody Mode backed by MockUSDT with partial unwrap
 * allowed, so this exercises the full wrap -> partial unwrap round trip.
 */
async function scenario9_reservePsmTokenCustodyRoundTrip() {
  const psm = new Contract(raw.reservePSM, getAbi("ReservePSM"), provider);
  const assetId = BigInt(raw.assetRegistryModuleD.sTokenAssetId);
  const wrappedTokenAddr: string = await psm.wrappedTokenOf(assetId);
  const wrapped = new Contract(wrappedTokenAddr, getAbi("WrappedAsset"), provider);

  const investor = wallets.investor1;
  const wrapAmount = 50_000n;

  await (await (usdt.connect(wallets.governor) as any).mint(investor.address, wrapAmount)).wait();
  await (await (usdt.connect(investor) as any).approve(raw.reservePSM, wrapAmount)).wait();

  const usdtBefore: bigint = await usdt.balanceOf(investor.address);
  const wrappedBefore: bigint = await wrapped.balanceOf(investor.address);

  await (await psm.connect(investor).getFunction("wrap")(assetId, wrapAmount, investor.address)).wait();

  assert.equal(await wrapped.balanceOf(investor.address), wrappedBefore + wrapAmount);
  assert.equal(await usdt.balanceOf(investor.address), usdtBefore - wrapAmount);

  // Partial unwrap — Deploy.s.sol configured this asset with allowPartialUnwrap=true.
  const unwrapAmount = wrapAmount / 2n;
  await (await psm.connect(investor).getFunction("unwrap")(assetId, unwrapAmount, investor.address)).wait();

  assert.equal(await wrapped.balanceOf(investor.address), wrappedBefore + wrapAmount - unwrapAmount);
  assert.equal(await usdt.balanceOf(investor.address), usdtBefore - wrapAmount + unwrapAmount);
}

async function scenario11_liquidityAdapterBridgeTarget() {
  const lpAdapter = sdk.adapter("lp");
  assert.equal((await lpAdapter.liquidityBridge()).toLowerCase(), addresses.liquidityBridge.toLowerCase());
  assert.equal((await lpAdapter.cashVault()).toLowerCase(), addresses.cashVault.toLowerCase());
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  await scenario("1. Deploy sanity", scenario1_deploySanity);
  await scenario("2. Role-gating negative checks", scenario2_roleGatingNegatives);
  await scenario("3. Guardian pause blocks subscription", scenario3_guardianPauseBlocksSubscription);
  await scenario("4. Full subscription + settlement cycle (Cash)", scenario4_fullSubscriptionCycle);
  await scenario("5. Redemption + queue clearing (Cash)", scenario5_redemptionAndQueueClearing);
  await scenario("6. NAV deviation cap", scenario6_navDeviationCap);
  await scenario("7. FUNDING_FAILED refund (Note)", scenario7_fundingFailedRefund);
  await scenario("8. Adapter buy order + clearDealValue (Cash)", scenario8_adapterBuyOrder);
  await scenario("9. ReservePSM Token Custody wrap/unwrap round trip (Module D)", scenario9_reservePsmTokenCustodyRoundTrip);
  await scenario("11. LiquidityAdapter bridge target wiring", scenario11_liquidityAdapterBridgeTarget);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
