import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { startAnvil, type AnvilInstance } from "./anvil.js";
import { deployFullStack, type DeployedStack } from "./deployStack.js";
import { HyperTesseraSDK } from "../src/sdk.js";
import { OnChainEventIndexer } from "../src/indexer.js";
import { KeeperBot, type KeeperAlert } from "../src/keeperBot.js";
import { SettlementOperator } from "../src/settlementOperator.js";
import { ProductState, CycleState } from "../src/types.js";

/**
 * Full-stack integration test, exercising development-plan.md §3.5's "Full subscription cycle"
 * scenario end to end against a real chain (anvil): requestDeposit -> KeeperBot drives
 * ACCEPTING -> CALCULATING -> SettlementOperator submitBatch -> vault.settle -> claimDeposit.
 */
describe("Module E — full subscription cycle (development-plan.md §3.5)", () => {
  let anvil: AnvilInstance;
  let stack: DeployedStack;
  let sdk: HyperTesseraSDK;
  let depositRequestId: bigint;

  beforeAll(async () => {
    anvil = await startAnvil(8553);
    const [governor, operator1, operator2, investor] = anvil.wallets;
    stack = await deployFullStack({ governor, operator1, operator2 });
    sdk = new HyperTesseraSDK(stack.addresses, anvil.provider);

    // Fund the investor and approve the cash vault to pull USDT on requestDeposit.
    const usdt = stack.usdt.connect(governor) as any;
    await (await usdt.mint(await investor.getAddress(), 1_000_000_000n)).wait();
    await (await (stack.usdt.connect(investor) as any).approve(stack.addresses.cashVault, 1_000_000_000n)).wait();
  });

  afterAll(() => {
    anvil?.stop();
  });

  async function advanceTime(seconds: number) {
    await anvil.provider.send("evm_increaseTime", [seconds]);
    await anvil.provider.send("evm_mine", []);
  }

  it("drives CONFIGURING -> SUBSCRIBING and accepts a deposit", async () => {
    const [governor, , , investor] = anvil.wallets;

    await sdk.openSubscription(stack.addresses.cashVault, governor);
    const state1 = await sdk.getStateContext(stack.addresses.cashVault);
    expect(state1.product).toBe(ProductState.SUBSCRIBING);

    depositRequestId = await sdk.requestDeposit(
      "cash",
      500_000n,
      await investor.getAddress(),
      investor,
    );
    expect(depositRequestId).toBeGreaterThanOrEqual(0n);
  });

  it("KeeperBot finalizes subscription once subscriptionEnd passes", async () => {
    const [governor] = anvil.wallets;
    await advanceTime(5);

    const alerts: KeeperAlert[] = [];
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.cashVault], signer: governor, onAlert: (a) => alerts.push(a) });
    await keeper.tick();

    const state = await sdk.getStateContext(stack.addresses.cashVault);
    expect(state.product).toBe(ProductState.OPERATING);
    // Cycle-0 initial-settlement fix: finalizeSubscription lands cycle 0 straight in CALCULATING
    // (see StateManager.finalizeSubscription) rather than opening an ACCEPTING window first.
    expect(state.cycle).toBe(CycleState.CALCULATING);
  });

  it("indexer sees the deposit as pending", async () => {
    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    await indexer.backfill();
    const pending = indexer.getPendingDeposits(stack.addresses.cashVault);
    expect(pending).toHaveLength(1);
    expect(pending[0].assets).toBe(500_000n);
  });

  it("SettlementOperator assembles, signs, and submits the batch; deposit settles", async () => {
    const [governor, operator1, , investor] = anvil.wallets;

    // NAV signing service (development-plan.md §5.2): governor is authorized as the signer for this stand-in rwaToken.
    const governorAddr = await governor.getAddress();
    const rwaToken = Wallet.createRandom().address;
    await (await sdk.navOracle.connect(governor).getFunction("setSigner")(rwaToken, governorAddr)).wait();

    const latestBlock = await anvil.provider.getBlock("latest");
    const dataTimestamp = BigInt(latestBlock!.timestamp);
    const nav = 1_000_000n; // 1.0
    const sig = await sdk.signNAVUpdate(rwaToken, nav, dataTimestamp, governor);
    await sdk.updateNAV(rwaToken, nav, dataTimestamp, sig, governor);

    const { price } = await sdk.getNAV(rwaToken);
    expect(price).toBe(nav);

    const state = await sdk.getStateContext(stack.addresses.cashVault);
    const operator = new SettlementOperator(sdk, { operatorSigners: [operator1] });
    const receipt = await operator.run(
      state.cycleNumber,
      [
        {
          vault: stack.addresses.cashVault,
          amount: 0n,
          deposits: [{ requestId: depositRequestId, settleAmount: 500_000n }],
          redeems: [],
        },
      ],
      operator1,
    );
    expect(receipt.status).toBe(1);

    const stateAfter = await sdk.getStateContext(stack.addresses.cashVault);
    expect(stateAfter.cycle).toBe(CycleState.ACCEPTING);
    expect(stateAfter.cycleNumber).toBe(state.cycleNumber + 1n);

    // Investor can now claim shares for the settled deposit.
    await sdk.claimDeposit("cash", depositRequestId, await investor.getAddress(), investor);
    const vault = sdk.vault("cash");
    expect(await vault.balanceOf(await investor.getAddress())).toBeGreaterThan(0n);
  });

  it("KeeperBot advances ACCEPTING -> CALCULATING once the cycle duration elapses", async () => {
    const [governor] = anvil.wallets;

    // Only cycles >= 1 open with an ACCEPTING window — cycle 0 goes straight to CALCULATING
    // (StateManager's cycle-0 initial-settlement fix), so this must run after the settlement
    // above completed cycle 0 and opened cycle 1.
    const before = await sdk.getStateContext(stack.addresses.cashVault);
    expect(before.cycle).toBe(CycleState.ACCEPTING);

    await advanceTime(3);
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.cashVault], signer: governor });
    await keeper.tick();

    const state = await sdk.getStateContext(stack.addresses.cashVault);
    expect(state.cycle).toBe(CycleState.CALCULATING);
    expect(state.cycleNumber).toBe(before.cycleNumber); // same cycle, just a phase change
  });

  it("indexer no longer reports the deposit as pending once settled", async () => {
    const indexer = new OnChainEventIndexer(sdk, anvil.provider);
    await indexer.backfill();
    expect(indexer.getPendingDeposits(stack.addresses.cashVault)).toHaveLength(0);
  });
});
