import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type AnvilInstance } from "./anvil.js";
import { deployFullStack, type DeployedStack } from "./deployStack.js";
import { HyperTesseraSDK } from "../src/sdk.js";
import { KeeperBot, type KeeperAlert } from "../src/keeperBot.js";
import { ProductState } from "../src/types.js";

/**
 * Dedicated KeeperBot coverage (development-plan.md §3.5) — previously only exercised indirectly
 * via the big subscription-cycle e2e test and the local devnet test plan.
 */
describe("KeeperBot", () => {
  let anvil: AnvilInstance;
  let stack: DeployedStack;
  let sdk: HyperTesseraSDK;

  beforeAll(async () => {
    anvil = await startAnvil(8555);
    const [governor, operator1, operator2] = anvil.wallets;
    stack = await deployFullStack({ governor, operator1, operator2 });
    sdk = new HyperTesseraSDK(stack.addresses, anvil.provider);
  });

  afterAll(() => {
    anvil?.stop();
  });

  it("tick() drives CONFIGURING -> SUBSCRIBING directly (deployStack's subscriptionStart: 0 makes it immediately due)", async () => {
    const [governor] = anvil.wallets;
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.noteVault], signer: governor });
    await keeper.tick();

    const state = await sdk.getStateContext(stack.addresses.noteVault);
    expect(state.product).toBe(ProductState.SUBSCRIBING);
  });

  it("tick() is a no-op once SUBSCRIBING but subscriptionEnd hasn't passed yet", async () => {
    const [governor] = anvil.wallets;
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.noteVault], signer: governor });
    await keeper.tick(); // finalizeSubscription isn't due yet — swallowed as a no-op, not an error

    const state = await sdk.getStateContext(stack.addresses.noteVault);
    expect(state.product).toBe(ProductState.SUBSCRIBING);
  });

  it("start()/stop() manage the polling interval without throwing", () => {
    const keeper = new KeeperBot(sdk, { vaults: [stack.addresses.cashVault], signer: anvil.wallets[0] });
    keeper.start(60_000);
    keeper.stop();
    // calling stop() twice must be safe (idempotent)
    expect(() => keeper.stop()).not.toThrow();
  });
});
