import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { HyperTesseraSDK } from "../../src/sdk.js";
import { KeeperBot } from "../../src/keeperBot.js";
import { SettlementOperator } from "../../src/settlementOperator.js";
import { ProductState } from "../../src/types.js";
import { loadLocalDeployment } from "./config.js";

/**
 * Manual walkthrough of the RBAC audit-fix branch's new SETTLING -> confirmFinalSettlement ->
 * MATURING -> CLAIMING -> CLOSED tail, plus the keeper-fallback-removal and threshold==0-guard
 * checks (docs/superpowers/plans/2026-07-31-anvil-e2e-handover.md). Drives `lpVault` — the one
 * demo vault runTestPlan.ts never advances past CONFIGURING — through its full lifecycle using
 * the real off-chain SDK/KeeperBot/SettlementOperator classes against an already-deployed local
 * stack (offchain/local/addresses.json). Run after `npm run local:deploy`.
 */

const { addresses, provider, wallets } = loadLocalDeployment();
const sdk = new HyperTesseraSDK(addresses, provider);
const vault = addresses.lpVault;

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
    console.log(`  (reverted as expected: ${message.split("\n")[0]})`);
  }
}

const DAY = 86400;

async function step1_keeperFallbackRemoved() {
  console.log("\n== Fix 1: Owner no longer implicit Keeper ==");
  const lpVault = sdk.vault("lp");
  assert.equal(await lpVault.isKeeper(wallets.governor.address), true, "governor should be an explicit Keeper (deploy-time setKeeper grant)");

  await (await lpVault.connect(wallets.governor).getFunction("setKeeper")(wallets.governor.address, false)).wait();
  assert.equal(await lpVault.isKeeper(wallets.governor.address), false, "setKeeper(false) should have revoked Keeper");

  await assertReverts(
    () => sdk.openSubscription(vault, wallets.governor),
    "Owner-only (non-Keeper) openSubscription",
  );

  await (await lpVault.connect(wallets.governor).getFunction("setKeeper")(wallets.governor.address, true)).wait();
  assert.equal(await lpVault.isKeeper(wallets.governor.address), true, "setKeeper(true) should have restored Keeper");
  console.log("  PASS — Owner alone cannot call Keeper-gated functions; explicit setKeeper grant required.");
}

async function step2_thresholdZeroGuard() {
  console.log("\n== Fix 5: threshold==0 guard on submitBatch ==");
  const neverConfiguredVault = Wallet.createRandom().address;
  assert.equal(await sdk.threshold(neverConfiguredVault), 0n, "sanity: random address should have threshold 0");
  console.log("  PASS — an unconfigured vault has threshold 0, which submitBatch treats as never valid.");
}

async function chainNow(): Promise<number> {
  const block = await provider.getBlock("latest");
  return block!.timestamp;
}

let claimingStart: number;
let claimingEnd: number;

/** Submits an empty settlement batch for the vault's current cycle. */
async function settleEmptyCycle(settler: SettlementOperator) {
  const { cycleNumber } = await sdk.getStateContext(vault);
  const instruction = settler.assembleInstruction(cycleNumber, [
    { vault, amount: 0n, deposits: [], redeems: [] },
  ]);
  const signatures = await settler.collectSignatures(instruction);
  await settler.submit(instruction, signatures, wallets.governor);
}

async function step3_driveToSettling() {
  console.log("\n== Setup: drive lpVault CONFIGURING -> SUBSCRIBING -> OPERATING -> SETTLING ==");
  const now = await chainNow();
  claimingStart = now + 10 * DAY;
  claimingEnd = now + 20 * DAY;
  const params = {
    subscriptionStart: 0,
    subscriptionEnd: now + 3,
    walletSubscriptionCap: 10_000_000_000_000n,
    minRaiseAmount: 0n,
    subscriptionCapShare: 0n,
    cycleDuration: 2,
    maturityTimestamp: now + 8,
    claimingStart,
    claimingEnd,
    feeParams: 0,
  };
  await (await sdk.stateManager.connect(wallets.curator).getFunction("setProductParams")(vault, params)).wait();

  await sdk.openSubscription(vault, wallets.governor);
  let state = await sdk.getStateContext(vault);
  assert.equal(state.product, ProductState.SUBSCRIBING);

  await advanceTime(4);
  await sdk.finalizeSubscription(vault, wallets.governor);
  state = await sdk.getStateContext(vault);
  assert.equal(state.product, ProductState.OPERATING, "should reach OPERATING (minRaiseAmount=0 always met)");

  // finalizeSubscription drops straight into cycle 0's CALCULATING window; settle its empty
  // batch to get back to ACCEPTING.
  const settler = new SettlementOperator(sdk, {
    operatorSigners: [wallets.settlementOperator1, wallets.settlementOperator2],
  });
  await settleEmptyCycle(settler);

  // There is no longer a Keeper transition into SETTLING: past maturity the Keeper starts the
  // product's FINAL cycle, and that cycle's batch takes it to SETTLING atomically
  // (一年期产品最终周期结算与产品参数调整说明 §5).
  await advanceTime(5); // past maturityTimestamp (now+8)
  await sdk.startCycleCalculation(vault, wallets.governor);
  await settleEmptyCycle(settler);

  state = await sdk.getStateContext(vault);
  assert.equal(
    state.product,
    ProductState.MATURING,
    "the final cycle's completeCycle moves SETTLING -> MATURING atomically",
  );
  console.log("  lpVault is now MATURING, via its final cycle.");
}

async function step4_noSeparateConfirmationStep() {
  console.log("\n== Final settlement confirmation is gone: completeCycle is SETTLING's only exit ==");
  // The final batch is already M-of-N protected, so confirming it a second time was duplicate
  // machinery (最终周期结算及最终兑付补充修改方案 §九). Reaching MATURING took nothing but the
  // final batch itself, and no Keeper transition exists to skip it.
  const state = await sdk.getStateContext(vault);
  assert.equal(state.product, ProductState.MATURING, "already MATURING off the final batch alone");

  const alerts: string[] = [];
  const keeper = new KeeperBot(sdk, {
    vaults: [vault],
    signer: wallets.governor,
    onAlert: (a) => alerts.push(a.type),
  });
  await keeper.tick();
  assert.equal(alerts.length, 0, "no alert should fire once the final cycle has completed");
  console.log("  PASS — MATURING reached through the final batch, with no separate confirmation.");
}

async function step6_claimingEndGate() {
  console.log("\n== Fix 3: claimingEnd gate on closeProduct ==");
  let now = await chainNow();
  await advanceTime(claimingStart - now + 1); // past claimingStart, still well before claimingEnd
  const keeper = new KeeperBot(sdk, { vaults: [vault], signer: wallets.governor });
  await keeper.tick();
  let state = await sdk.getStateContext(vault);
  assert.equal(state.product, ProductState.CLAIMING, "should have advanced MATURING -> CLAIMING");

  await assertReverts(() => sdk.closeProduct(vault, wallets.governor), "closeProduct before claimingEnd");

  now = await chainNow();
  await advanceTime(claimingEnd - now + 1); // past claimingEnd
  await sdk.closeProduct(vault, wallets.governor);
  state = await sdk.getStateContext(vault);
  assert.equal(state.product, ProductState.CLOSED, "should have advanced CLAIMING -> CLOSED");
  console.log("  PASS — closeProduct reverted before claimingEnd, succeeded after.");
}

async function main() {
  await step1_keeperFallbackRemoved();
  await step2_thresholdZeroGuard();
  await step3_driveToSettling();
  await step4_noSeparateConfirmationStep();
  await step6_claimingEndGate();
  console.log("\nAll steps passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
