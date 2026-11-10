import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { startAnvil, type AnvilInstance } from "./anvil.js";
import { deployFullStack, type DeployedStack } from "./deployStack.js";
import { HyperTesseraSDK } from "../src/sdk.js";
import { OnChainEventIndexer } from "../src/indexer.js";
import { SettlementOperator } from "../src/settlementOperator.js";

/**
 * Dedicated OnChainEventIndexer coverage (development-plan.md §3.5) — the SDK/backend test suite
 * previously only exercised this class indirectly via the big subscription-cycle e2e test.
 */
describe("OnChainEventIndexer", () => {
  let anvil: AnvilInstance;
  let stack: DeployedStack;
  let sdk: HyperTesseraSDK;

  beforeAll(async () => {
    anvil = await startAnvil(8554);
    const [governor, operator1, operator2, investor] = anvil.wallets;
    stack = await deployFullStack({ governor, operator1, operator2 });
    sdk = new HyperTesseraSDK(stack.addresses, anvil.provider);

    const usdt = stack.usdt.connect(governor) as any;
    await (await usdt.mint(await investor.getAddress(), 1_000_000_000n)).wait();
    await (await (stack.usdt.connect(investor) as any).approve(stack.addresses.cashVault, 1_000_000_000n)).wait();
  });

  afterAll(() => {
    anvil?.stop();
  });

  it("getPendingDeposits reflects a fresh requestDeposit before settlement", async () => {
    const [governor, , , investor] = anvil.wallets;
    await sdk.openSubscription(stack.addresses.cashVault, governor);

    const requestId = await sdk.requestDeposit("cash", 200_000n, await investor.getAddress(), investor);

    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    await indexer.backfill();

    const pending = indexer.getPendingDeposits(stack.addresses.cashVault);
    expect(pending.map((r) => r.requestId)).toContain(requestId);
    expect(pending.find((r) => r.requestId === requestId)?.assets).toBe(200_000n);
  });

  it("getQueueSnapshot reports live depth for both dual-FIFO queues", async () => {
    const [governor, , , investor] = anvil.wallets;

    // Advance the cash vault to OPERATING so a redeem request is possible; the existing pending
    // deposit from the previous test carries into this cycle.
    await anvil.provider.send("evm_increaseTime", [5]);
    await anvil.provider.send("evm_mine", []);
    const { KeeperBot } = await import("../src/keeperBot.js");
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.cashVault], signer: governor });
    await keeper.tick();

    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    const before = await indexer.getQueueSnapshot(stack.addresses.cashVault);
    expect(before.depositDepth).toBeGreaterThanOrEqual(1n);

    // requestRedeem needs shares — none claimed yet in this vault, so just assert the REDEEM side
    // starts at zero rather than driving a full redeem cycle here (covered by e2e.integration.test.ts).
    expect(before.redeemDepth).toBe(0n);
  });

  it("getLatestNAV reflects a signed NAV update after backfill", async () => {
    const [governor] = anvil.wallets;
    const governorAddr = await governor.getAddress();
    const rwaToken = Wallet.createRandom().address;
    await (await sdk.navOracle.connect(governor).getFunction("setSigner")(rwaToken, governorAddr)).wait();

    const block = await anvil.provider.getBlock("latest");
    const dataTimestamp = BigInt(block!.timestamp);
    const nav = 1_000_000n;
    const sig = await sdk.signNAVUpdate(rwaToken, nav, dataTimestamp, governor);
    await sdk.updateNAV(rwaToken, nav, dataTimestamp, sig, governor);

    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    await indexer.backfill();

    const navRecord = indexer.getLatestNAV(rwaToken);
    expect(navRecord?.price).toBe(nav);
    expect(navRecord?.dataTimestamp).toBe(dataTimestamp);
  });

  it("getEvents performs a generic ad-hoc query for an event the indexer doesn't track by default", async () => {
    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    const logs = await indexer.getEvents(sdk.navOracle, "NAVUpdated");
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("getClearingList is empty for a vault with no queued redeems", () => {
    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    expect(indexer.getClearingList(stack.addresses.noteVault)).toEqual([]);
  });

  /**
   * onSettlementExecuted (finding: PR #7 review) decodes the raw Settlement.submitBatch calldata
   * via interface.parseTransaction rather than reading event args, since settle() takes request-id
   * arrays as calldata with no per-request "settled" event. That decode path was previously only
   * exercised incidentally with a single deposit id per batch (e2e.integration.test.ts) — this
   * drives a batch settling *two* deposit requests for the same vault in one submitBatch call, to
   * cover the `for (const d of vs.deposits)` loop actually decoding a multi-element array.
   */
  it("onSettlementExecuted (via backfill) marks every depositRequestId in a multi-id batch as settled", async () => {
    const [governor, operator1, , , investor2] = anvil.wallets;

    await sdk.openSubscription(stack.addresses.noteVault, governor);
    const usdt = stack.usdt.connect(governor) as any;
    await (await usdt.mint(await investor2.getAddress(), 1_000_000_000n)).wait();
    await (await (stack.usdt.connect(investor2) as any).approve(stack.addresses.noteVault, 1_000_000_000n)).wait();

    const requestId1 = await sdk.requestDeposit("note", 100_000n, await investor2.getAddress(), investor2);
    const requestId2 = await sdk.requestDeposit("note", 150_000n, await investor2.getAddress(), investor2);

    await anvil.provider.send("evm_increaseTime", [5]);
    await anvil.provider.send("evm_mine", []);
    const { KeeperBot } = await import("../src/keeperBot.js");
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.noteVault], signer: governor });
    await keeper.tick(); // SUBSCRIBING -> OPERATING/ACCEPTING

    await anvil.provider.send("evm_increaseTime", [3]);
    await anvil.provider.send("evm_mine", []);
    await keeper.tick(); // ACCEPTING -> CALCULATING

    const governorAddr = await governor.getAddress();
    const rwaToken = Wallet.createRandom().address;
    await (await sdk.navOracle.connect(governor).getFunction("setSigner")(rwaToken, governorAddr)).wait();

    const latestBlock = await anvil.provider.getBlock("latest");
    const dataTimestamp = BigInt(latestBlock!.timestamp);
    const nav = 1_000_000n;
    const sig = await sdk.signNAVUpdate(rwaToken, nav, dataTimestamp, governor);
    await sdk.updateNAV(rwaToken, nav, dataTimestamp, sig, governor);

    const state = await sdk.getStateContext(stack.addresses.noteVault);
    const operator = new SettlementOperator(sdk, { operatorSigners: [operator1] });
    const receipt = await operator.run(
      state.cycleNumber,
      [
        {
          vault: stack.addresses.noteVault,
          amount: 0n,
          deposits: [
            { requestId: requestId1, settleAmount: 100_000n },
            { requestId: requestId2, settleAmount: 150_000n },
          ],
          redeems: [],
        },
      ],
      operator1,
    );
    expect(receipt.status).toBe(1);

    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    await indexer.backfill();
    const pendingIds = indexer.getPendingDeposits(stack.addresses.noteVault).map((r) => r.requestId);
    expect(pendingIds).not.toContain(requestId1);
    expect(pendingIds).not.toContain(requestId2);
  });
});
