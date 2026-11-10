import assert from "node:assert/strict";
import { Contract } from "ethers";
import { HyperTesseraSDK } from "../../src/sdk.js";
import { SettlementOperator } from "../../src/settlementOperator.js";
import { ProductState, CycleState } from "../../src/types.js";
import { loadLocalDeployment } from "./config.js";

/**
 * Full-flow local walkthrough for the 2026-08 client feedback fixes
 * (docs/superpowers/specs/2026-08-04-client-fixes-202608-design.md). Exercises the real
 * cross-contract call paths for:
 *   - Task 2: BaseVault.markRefundable is Curator-gated (Keeper now rejected).
 *   - Task 4: BaseVault.returnPrincipalToPool -> UnifiedPool.receiveVaultPrincipal round trip.
 *   - Task 5: BaseVault performance-fee split between performanceFeeRecipient and revenuePool,
 *     driven through a real deposit -> yield -> settle cycle so the split mints a real Vault
 *     Share balance (not just config getters).
 *   - Task 6: RevenuePool.withdrawToken sweeping that real minted Vault Share back out, proving
 *     the Task 5 -> Task 6 handoff composes end-to-end (not just unit-tested against a mock ERC-20).
 *   - Task 8: LiquidityEarnVault's cyclical no-share settle() over two consecutive cycles.
 *
 * NOT covered here: Task 1 (ClaimRegistry) — ClaimRegistry isn't part of the local deployment
 * stack (`grep -rn "ClaimRegistry" offchain/` returns nothing); see Task 9 Step 1. That change is
 * unit-tested only (test/ClaimRegistry.t.sol).
 *
 * Investigation notes (Task 9 Step 1): `npm run local:deploy` already registers cashVault/
 * noteVault/lpVault as UnifiedPool tranche vaults (script/Deploy.s.sol:317-319,
 * `UnifiedPool.addVault`) and authorizes unifiedPool as a RevenuePool fee source
 * (script/Deploy.s.sol:161, `revenuePool.addAuthorizedSource(unifiedPool)`). BaseVault's
 * protocol-fee split (Task 5) mints Vault Shares directly to `revenuePool` rather than calling
 * `RevenuePool.receiveFee`, so no extra authorized-source wiring is needed for that path. All
 * three demo vaults deploy with `revenuePool == address(0)` / `protocolFeeShareBps == 0` (Task 5
 * defaults) — this script configures it itself via `setProtocolFeeConfig`. No deploy.ts/Deploy.s.sol
 * changes were required.
 *
 * No FUNDING_FAILED demo vault fixture exists in the local stack — all three demo vaults start
 * CONFIGURING/ACCEPTING. Step 1 below deploys a fresh, disposable EarnVault via the real
 * (permissionless) VaultFactory and drives it into FUNDING_FAILED itself, mirroring
 * EarnVault.t.sol's `_makeFundingFailedVault` helper exactly (high minRaiseAmount, an
 * under-threshold deposit, then finalizeSubscription after subscriptionEnd).
 *
 * Run after `npm run local:deploy`: `npx tsx offchain/scripts/local/testClientFixes202608.ts`
 * (mirrors testSettlementTail.ts's invocation).
 */

const { addresses, raw, provider, wallets } = loadLocalDeployment();
const sdk = new HyperTesseraSDK(addresses, provider);

const usdt = new Contract(
  raw.usdt,
  ["function mint(address to, uint256 amount) external", "function approve(address spender, uint256 amount) external returns (bool)", "function balanceOf(address) view returns (uint256)"],
  provider,
);

async function advanceTime(seconds: number) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

async function chainNow(): Promise<number> {
  const block = await provider.getBlock("latest");
  return block!.timestamp;
}

/** Advances chain time to strictly past `target`, tolerating the case where wall-clock-driven
 *  anvil block timestamps have already passed it (RPC round trips between steps eat into any
 *  fixed look-ahead buffer). */
async function advanceTimeTo(target: number) {
  const diff = target - (await chainNow()) + 1;
  if (diff > 0) await advanceTime(diff);
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

async function step1_markRefundableIsCuratorOnly() {
  console.log("\n== Task 2: markRefundable Keeper -> Curator ==");

  // No demo vault sits in FUNDING_FAILED by default — deploy a disposable one via the real,
  // permissionless VaultFactory and drive it there ourselves, matching EarnVault.t.sol's
  // `_makeFundingFailedVault` helper: high minRaiseAmount, an under-threshold deposit, then
  // finalizeSubscription once subscriptionEnd has passed.
  const now = await chainNow();
  const subscriptionEnd = now + 100;

  const vaultAddr: string = await sdk.vaultFactory
    .connect(wallets.governor)
    .getFunction("deployVault")
    .staticCall({
      vaultType: 0, // VaultType.EARN
      name: "Refund Fixture",
      symbol: "htREF",
      usdt: raw.usdt,
      stateManager: addresses.stateManager,
      settlement: "0x0000000000000000000000000000000000000000",
      queue: addresses.queue,
      owner: "0x0000000000000000000000000000000000000000", // -> msg.sender (governor)
      liquidityBridge: "0x0000000000000000000000000000000000000000",
      cashVault: "0x0000000000000000000000000000000000000000",
      feeKind: 0, // FeePaymentKind.Native
    });
  await (
    await sdk.vaultFactory.connect(wallets.governor).getFunction("deployVault")({
      vaultType: 0,
      name: "Refund Fixture",
      symbol: "htREF",
      usdt: raw.usdt,
      stateManager: addresses.stateManager,
      settlement: "0x0000000000000000000000000000000000000000",
      queue: addresses.queue,
      owner: "0x0000000000000000000000000000000000000000",
      liquidityBridge: "0x0000000000000000000000000000000000000000",
      cashVault: "0x0000000000000000000000000000000000000000",
      feeKind: 0, // FeePaymentKind.Native
    })
  ).wait();
  console.log(`  deployed disposable FUNDING_FAILED-fixture vault at ${vaultAddr}`);

  const refVault = sdk.getContract("EarnVault", vaultAddr);
  await (await refVault.connect(wallets.governor).getFunction("setKeeper")(wallets.governor.address, true)).wait();
  await (await refVault.connect(wallets.governor).getFunction("setCurator")(wallets.curator.address)).wait();

  const params = {
    subscriptionStart: 0,
    subscriptionEnd,
    walletSubscriptionCap: 0n,
    minRaiseAmount: 100_000_000_000n, // 100,000 USDT — deliberately never met below
    subscriptionCapShare: 0n,
    cycleDuration: 7 * 86400,
    maturityTimestamp: subscriptionEnd + 365 * 86400,
    claimingStart: subscriptionEnd + 370 * 86400,
    claimingEnd: subscriptionEnd + 400 * 86400,
    feeParams: 0,
  };
  await (await sdk.stateManager.connect(wallets.curator).getFunction("setProductParams")(vaultAddr, params)).wait();
  await sdk.openSubscription(vaultAddr, wallets.governor);

  // Small deposit, well under minRaiseAmount.
  const depositAmount = 1_000_000_000n; // 1,000 USDT
  await (await usdt.connect(wallets.governor).getFunction("mint")(wallets.investor1.address, depositAmount)).wait();
  await (await usdt.connect(wallets.investor1).getFunction("approve")(vaultAddr, depositAmount)).wait();
  await (await refVault.connect(wallets.investor1).getFunction("requestDeposit")(depositAmount, wallets.investor1.address)).wait();
  const requestId: bigint = (await refVault.getFunction("nextRequestId")()) - 1n;

  await advanceTimeTo(subscriptionEnd);
  await sdk.finalizeSubscription(vaultAddr, wallets.governor);

  const state = await sdk.getStateContext(vaultAddr);
  assert.equal(state.product, ProductState.FUNDING_FAILED, "fixture vault should have entered FUNDING_FAILED (deposit stayed under minRaiseAmount)");
  console.log(`  fixture vault is FUNDING_FAILED (deposit ${depositAmount} < minRaiseAmount ${params.minRaiseAmount})`);

  await assertReverts(
    () => refVault.connect(wallets.governor).getFunction("markRefundable")([requestId]),
    "markRefundable called by Keeper (governor, no longer authorized)",
  );

  await assertReverts(
    () => refVault.connect(wallets.investor2).getFunction("markRefundable")([requestId]),
    "markRefundable called by a random non-Curator signer",
  );

  const usdtBefore: bigint = await usdt.getFunction("balanceOf")(wallets.investor1.address);
  await (await refVault.connect(wallets.curator).getFunction("markRefundable")([requestId])).wait();
  const refundableLiability: bigint = await refVault.getFunction("refundableLiability")();
  assert.equal(refundableLiability, depositAmount, "refundableLiability should equal the marked deposit");

  await (await refVault.connect(wallets.investor1).getFunction("claimRefund")(requestId)).wait();
  const usdtAfter: bigint = await usdt.getFunction("balanceOf")(wallets.investor1.address);
  assert.equal(usdtAfter - usdtBefore, depositAmount, "investor1 should have been refunded exactly their deposit");

  console.log("  PASS — Keeper and random callers rejected; Curator's markRefundable succeeded and the request was refundable.");
}

async function step2_returnPrincipalToPoolRoundTrip() {
  console.log("\n== Task 4: returnPrincipalToPool -> receiveVaultPrincipal ==");
  const cash = sdk.vault("cash");
  const cashAddr = addresses.cashVault;

  const before: bigint = await sdk.unifiedPool.getFunction("pending")(cashAddr);
  const amount = 1_000_000n; // 1 USDT, 6-decimal

  await (await usdt.connect(wallets.governor).getFunction("mint")(cashAddr, amount)).wait();

  await (await cash.connect(wallets.settlementOperator1).getFunction("returnPrincipalToPool")(amount)).wait();

  const after: bigint = await sdk.unifiedPool.getFunction("pending")(cashAddr);
  assert.equal(after - before, amount, "UnifiedPool.pending(cashVault) should have increased by exactly `amount`");
  console.log(`  PASS — pending(cashVault) increased by ${amount}`);
}

async function step3_protocolFeeSplit() {
  console.log("\n== Task 5 -> Task 6: protocol fee split lands a real minted Vault Share in RevenuePool, then Governor sweeps it out ==");
  const cash = sdk.vault("cash");
  const cashAddr = addresses.cashVault;
  const revenuePoolAddr = addresses.revenuePool;

  await (await cash.connect(wallets.governor).getFunction("setProtocolFeeConfig")(revenuePoolAddr, 3000)).wait();

  const configuredPool = await cash.getFunction("revenuePool")();
  const configuredBps = await cash.getFunction("protocolFeeShareBps")();
  assert.equal(configuredPool.toLowerCase(), revenuePoolAddr.toLowerCase());
  assert.equal(configuredBps, 3000n);

  // performanceFeeRecipient deliberately distinct from revenuePool, so the real accrual below
  // exercises the two-way _mintShares split (not the revenuePool==recipient single-mint shortcut).
  await (await cash.connect(wallets.curator).getFunction("setPerformanceFeeRecipient")(wallets.investor2.address)).wait();
  await (await cash.connect(wallets.curator).getFunction("setPerformanceFeeBps")(2000)).wait();
  console.log("  configured: protocolFeeShareBps=3000, performanceFeeBps=2000, recipient=investor2");

  // --- Drive cashVault CONFIGURING -> OPERATING, same pattern step4 uses for lpVault. ---
  const now = await chainNow();
  const subscriptionEnd = now + 10;
  const cycleDuration = 100;
  const params = {
    subscriptionStart: 0,
    subscriptionEnd,
    walletSubscriptionCap: 0n,
    minRaiseAmount: 0n, // always met -> OPERATING
    subscriptionCapShare: 0n,
    cycleDuration,
    maturityTimestamp: subscriptionEnd + 365 * 86400,
    claimingStart: subscriptionEnd + 370 * 86400,
    claimingEnd: subscriptionEnd + 400 * 86400,
    feeParams: 0,
  };
  await (await sdk.stateManager.connect(wallets.curator).getFunction("setProductParams")(cashAddr, params)).wait();
  await sdk.openSubscription(cashAddr, wallets.governor);
  await advanceTimeTo(subscriptionEnd);
  await sdk.finalizeSubscription(cashAddr, wallets.governor);

  let state = await sdk.getStateContext(cashAddr);
  assert.equal(state.product, ProductState.OPERATING, "cashVault should reach OPERATING (minRaiseAmount=0)");
  assert.equal(state.cycle, CycleState.CALCULATING, "cycle 0 should go straight to CALCULATING (no SUBSCRIBING-phase deposits to settle)");

  const operator = new SettlementOperator(sdk, {
    operatorSigners: [wallets.settlementOperator1, wallets.settlementOperator2],
  });
  await operator.run(state.cycleNumber, [{ vault: cashAddr, amount: 0n, deposits: [], redeems: [] }], wallets.governor);
  state = await sdk.getStateContext(cashAddr);
  assert.equal(state.cycle, CycleState.ACCEPTING, "cycle 0 flush should reopen to ACCEPTING");

  // --- Cycle 1: a real deposit, settled with no yield yet. Mints the initial Vault Shares (supply
  // goes from 0 -> nonzero), which sets feeHighWaterMark without any fee accruing this cycle. ---
  const depositAmount = 1_000_000_000n; // 1,000 USDT
  await (await usdt.connect(wallets.governor).getFunction("mint")(wallets.investor1.address, depositAmount)).wait();
  await (await usdt.connect(wallets.investor1).getFunction("approve")(cashAddr, depositAmount)).wait();
  await (await cash.connect(wallets.investor1).getFunction("requestDeposit")(depositAmount, wallets.investor1.address)).wait();
  const depositRequestId: bigint = (await cash.getFunction("nextRequestId")()) - 1n;

  let cycleStart = await sdk.stateManager.getFunction("currentCycleStart")(cashAddr);
  await advanceTimeTo(Number(cycleStart) + cycleDuration);
  await sdk.startCycleCalculation(cashAddr, wallets.governor);
  let cycleNumber = (await sdk.getStateContext(cashAddr)).cycleNumber;
  await operator.run(
    cycleNumber,
    [{ vault: cashAddr, amount: 0n, deposits: [{ requestId: depositRequestId, settleAmount: depositAmount }], redeems: [] }],
    wallets.governor,
  );

  // --- Simulate yield the same way test/EarnVault.t.sol does: mint extra USDT straight into the
  // vault, pushing totalAssets above feeHighWaterMark. ---
  const yieldAmount = 100_000_000_000n; // 100,000 USDT
  await (await usdt.connect(wallets.governor).getFunction("mint")(cashAddr, yieldAmount)).wait();

  const revenuePoolSharesBefore: bigint = await cash.getFunction("balanceOf")(revenuePoolAddr);
  assert.equal(revenuePoolSharesBefore, 0n, "revenuePool should hold no Vault Shares before any fee-accruing cycle");

  // --- Cycle 2: no new deposits, just the yield. snapshotSettlementPrice (called inside
  // Settlement.submitBatch, before settle()) computes and mints the real performance-fee split. ---
  cycleStart = await sdk.stateManager.getFunction("currentCycleStart")(cashAddr);
  await advanceTimeTo(Number(cycleStart) + cycleDuration);
  await sdk.startCycleCalculation(cashAddr, wallets.governor);
  cycleNumber = (await sdk.getStateContext(cashAddr)).cycleNumber;
  await operator.run(cycleNumber, [{ vault: cashAddr, amount: 0n, deposits: [], redeems: [] }], wallets.governor);

  const revenuePoolShares: bigint = await cash.getFunction("balanceOf")(revenuePoolAddr);
  const recipientShares: bigint = await cash.getFunction("balanceOf")(wallets.investor2.address);
  assert.ok(revenuePoolShares > 0n, "revenuePool should hold a nonzero real minted Vault Share balance after the fee-accruing cycle");
  assert.ok(recipientShares > 0n, "performanceFeeRecipient (investor2) should hold a nonzero real minted Vault Share balance too");
  console.log(`  PASS — real fee accrual: revenuePool holds ${revenuePoolShares} Vault Shares, investor2 (recipient) holds ${recipientShares}`);

  // --- Task 6: Governor sweeps the real minted Vault Share back out of RevenuePool. ---
  const sweepRecipient = wallets.investor1.address; // distinct from the fee recipient's own balance
  const sweepAmount = revenuePoolShares; // sweep it all
  const recipientBefore: bigint = await cash.getFunction("balanceOf")(sweepRecipient);

  await (await sdk.revenuePool.connect(wallets.governor).getFunction("withdrawToken")(cashAddr, sweepRecipient, sweepAmount)).wait();

  const revenuePoolSharesAfter: bigint = await cash.getFunction("balanceOf")(revenuePoolAddr);
  const recipientAfter: bigint = await cash.getFunction("balanceOf")(sweepRecipient);
  assert.equal(revenuePoolSharesAfter, 0n, "revenuePool's Vault Share balance should be fully swept");
  assert.equal(recipientAfter - recipientBefore, sweepAmount, "sweep recipient should have received exactly the swept Vault Share amount");
  console.log(`  PASS — Governor swept ${sweepAmount} real Vault Shares out of revenuePool via RevenuePool.withdrawToken`);
}

async function step4_liquidityEarnVaultTwoCycles() {
  console.log("\n== Task 8: LiquidityEarnVault cyclical settle() over two cycles ==");
  const lp = sdk.vault("lp");
  const lpAddr = addresses.lpVault;
  const cashAddr = addresses.cashVault;

  let state = await sdk.getStateContext(lpAddr);
  console.log(`  lpVault initial state: product=${ProductState[state.product]}, cycle=${CycleState[state.cycle]}`);
  assert.equal(state.product, ProductState.CONFIGURING, "lpVault should start CONFIGURING in a fresh local deploy");

  const operator = new SettlementOperator(sdk, {
    operatorSigners: [wallets.settlementOperator1, wallets.settlementOperator2],
  });

  // --- Drive CONFIGURING -> SUBSCRIBING -> OPERATING/ACCEPTING ---
  const now = await chainNow();
  const subscriptionEnd = now + 10;
  const cycleDuration = 100;
  const params = {
    subscriptionStart: 0,
    subscriptionEnd,
    walletSubscriptionCap: 0n,
    minRaiseAmount: 0n, // always met -> OPERATING
    subscriptionCapShare: 0n,
    cycleDuration,
    maturityTimestamp: subscriptionEnd + 365 * 86400,
    claimingStart: subscriptionEnd + 370 * 86400,
    claimingEnd: subscriptionEnd + 400 * 86400,
    feeParams: 0,
  };
  await (await sdk.stateManager.connect(wallets.curator).getFunction("setProductParams")(lpAddr, params)).wait();
  await sdk.openSubscription(lpAddr, wallets.governor);
  await advanceTimeTo(subscriptionEnd);
  await sdk.finalizeSubscription(lpAddr, wallets.governor);

  state = await sdk.getStateContext(lpAddr);
  assert.equal(state.product, ProductState.OPERATING, "lpVault should reach OPERATING (minRaiseAmount=0)");
  // StateManager.finalizeSubscription sends cycle 0 straight to CALCULATING (rather than opening an
  // ACCEPTING window first) so any SUBSCRIBING-phase deposits get settled immediately. This script made
  // none, so flush that empty cycle 0 through the real Settlement.submitBatch path to reach ACCEPTING.
  assert.equal(state.cycle, CycleState.CALCULATING, "cycle 0 should go straight to CALCULATING (no SUBSCRIBING-phase deposits to settle)");
  await operator.run(state.cycleNumber, [{ vault: lpAddr, amount: 0n, deposits: [], redeems: [] }], wallets.governor);
  state = await sdk.getStateContext(lpAddr);
  assert.equal(state.cycle, CycleState.ACCEPTING, "cycle 0 flush should reopen to ACCEPTING");

  async function runCycle(depositAmounts: bigint[], depositors: (typeof wallets)[keyof typeof wallets][]) {
    const cycleNumber = (await sdk.getStateContext(lpAddr)).cycleNumber;

    const requestIds: bigint[] = [];
    for (let i = 0; i < depositAmounts.length; i++) {
      const amount = depositAmounts[i];
      const depositor = depositors[i];
      await (await usdt.connect(wallets.governor).getFunction("mint")(depositor.address, amount)).wait();
      await (await usdt.connect(depositor).getFunction("approve")(lpAddr, amount)).wait();
      await (await lp.connect(depositor).getFunction("requestDeposit")(amount, depositor.address)).wait();
      const rid: bigint = (await lp.getFunction("nextRequestId")()) - 1n;
      requestIds.push(rid);
    }

    const cycleStart = await sdk.stateManager.getFunction("currentCycleStart")(lpAddr);
    await advanceTimeTo(Number(cycleStart) + cycleDuration);
    await sdk.startCycleCalculation(lpAddr, wallets.governor);

    const cashBefore: bigint[] = [];
    for (const d of depositors) cashBefore.push(await sdk.getContract("EarnVault", cashAddr).getFunction("balanceOf")(d.address));

    await operator.run(
      cycleNumber,
      [{ vault: lpAddr, amount: 0n, deposits: requestIds.map((id, i) => ({ requestId: id, settleAmount: depositAmounts[i] })), redeems: [] }],
      wallets.governor,
    );

    const totalAssets = depositAmounts.reduce((a, b) => a + b, 0n);
    const [acceptedTotal, cashOut, bonusOut, completed] = await lp.getFunction("cycleRecords")(cycleNumber);
    assert.equal(acceptedTotal, totalAssets, `cycleRecords(${cycleNumber}).acceptedTotalAssets should equal the batch's total deposits`);
    assert.equal(bonusOut, 0n, "no UnifiedPool bonus was distributed this cycle");
    assert.ok(completed, `cycleRecords(${cycleNumber}) should be marked completed`);
    assert.ok(cashOut > 0n, "some Cash Token amount should have been distributed");

    let distributedSum = 0n;
    for (let i = 0; i < depositors.length; i++) {
      const cashAfter: bigint = await sdk.getContract("EarnVault", cashAddr).getFunction("balanceOf")(depositors[i].address);
      const received = cashAfter - cashBefore[i];
      assert.ok(received > 0n, `depositor ${i} should have received a nonzero Cash Token amount`);
      distributedSum += received;
    }
    assert.equal(distributedSum, cashOut, "sum of per-depositor Cash Token amounts should equal cycleRecords cashTokenDistributed exactly, no dust");

    const lpUsdtBalance: bigint = await usdt.getFunction("balanceOf")(lpAddr);
    assert.equal(lpUsdtBalance, 0n, "lpVault should hold zero USDT after settle (fully bridged out)");

    const stateAfter = await sdk.getStateContext(lpAddr);
    assert.equal(stateAfter.cycle, CycleState.ACCEPTING, "cycle should have reopened to ACCEPTING immediately (completeCycle ran inside submitBatch)");
    assert.equal(stateAfter.cycleNumber, cycleNumber + 1n, "cycleNumber should have incremented");
    console.log(`  cycle ${cycleNumber}: accepted=${acceptedTotal}, cashDistributed=${cashOut}, reopened at cycle ${stateAfter.cycleNumber}`);
  }

  await runCycle([1_000_000_000n, 3_000_000_000n], [wallets.investor1, wallets.investor2]);
  await runCycle([500_000_000n], [wallets.investor1]);

  console.log("  PASS — two consecutive cycles settled with no shares minted, Cash Tokens distributed pro-rata, and immediate reopen each time.");
}

async function main() {
  await step1_markRefundableIsCuratorOnly();
  await step2_returnPrincipalToPoolRoundTrip();
  await step3_protocolFeeSplit();
  await step4_liquidityEarnVaultTwoCycles();
  console.log("\nAll steps passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
