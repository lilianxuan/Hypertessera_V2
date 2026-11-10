import { describe, expect, it, vi } from "vitest";
import { KeeperBot } from "../src/keeperBot.js";
import type { HyperTesseraSDK } from "../src/sdk.js";
import { CycleState, PauseState, ProductState, type Address } from "../src/types.js";

/**
 * `KeeperBot.driveVault` (exercised through the public `tick()`): one lifecycle transition attempt
 * per poll. Retiring stale requests is no longer the Keeper's job — owners cancel their own
 * requests directly — so every branch here is a pure lifecycle transition.
 */
describe("KeeperBot.driveVault", () => {
  const vault = "0x0000000000000000000000000000000000000002" as Address;
  const signer = {} as never;

  /** Fake SDK that records the *order* of the calls driveVault makes. */
  function fakeSdk(
    state: { product: ProductState; cycle?: CycleState },
    opts: { pastMaturity?: boolean } = {},
  ) {
    const calls: string[] = [];
    const record = (name: string) => vi.fn(async () => { calls.push(name); });
    const sdk = {
      calls,
      getStateContext: vi.fn(async () => ({
        product: state.product,
        cycle: state.cycle ?? CycleState.ACCEPTING,
        pause: PauseState.ACTIVE,
      })),
      openSubscription: record("openSubscription"),
      finalizeSubscription: record("finalizeSubscription"),
      startCycleCalculation: record("startCycleCalculation"),
      isPastMaturity: vi.fn(async () => opts.pastMaturity ?? false),
      enterClaiming: record("enterClaiming"),
      closeProduct: record("closeProduct"),
      stateManager: { interface: { parseError: () => null } },
    };
    return sdk as unknown as HyperTesseraSDK & { calls: string[] };
  }

  function bot(sdk: HyperTesseraSDK) {
    return new KeeperBot(sdk, { vaults: [vault], signer, onAlert: () => {} });
  }

  it("CONFIGURING opens the subscription", async () => {
    const sdk = fakeSdk({ product: ProductState.CONFIGURING });
    await bot(sdk).tick();
    expect(sdk.calls).toEqual(["openSubscription"]);
  });

  it("SUBSCRIBING finalizes the subscription", async () => {
    const sdk = fakeSdk({ product: ProductState.SUBSCRIBING });
    await bot(sdk).tick();
    expect(sdk.calls).toEqual(["finalizeSubscription"]);
  });

  it("OPERATING drives the cycle", async () => {
    const sdk = fakeSdk({ product: ProductState.OPERATING, cycle: CycleState.ACCEPTING });
    await bot(sdk).tick();
    expect(sdk.calls).toEqual(["startCycleCalculation"]);
  });

  // There is no separate Keeper jump into SETTLING any more: doing that at maturity skipped the
  // product's final cycle entirely (一年期产品最终周期结算与产品参数调整说明 §7.3). The Keeper
  // just starts the next cycle; StateManager treats maturity as its own trigger and the final
  // cycle's completeCycle performs OPERATING -> SETTLING atomically.
  it("OPERATING past maturity still only starts the cycle", async () => {
    const sdk = fakeSdk(
      { product: ProductState.OPERATING, cycle: CycleState.ACCEPTING },
      { pastMaturity: true },
    );
    await bot(sdk).tick();
    expect(sdk.calls).toEqual(["startCycleCalculation"]);
  });

  // An ordinary cycle mid-settlement past maturity is NOT promoted to final — completing it
  // moves the product into SETTLING and opens a fresh final cycle — so the Keeper just waits.
  it("OPERATING + CALCULATING past maturity simply waits", async () => {
    const sdk = fakeSdk(
      { product: ProductState.OPERATING, cycle: CycleState.CALCULATING },
      { pastMaturity: true },
    );
    const alerts: string[] = [];
    await new KeeperBot(sdk, { vaults: [vault], signer, onAlert: (a) => alerts.push(a.type) }).tick();
    expect(alerts).toEqual([]);
    expect(sdk.calls).toEqual([]);
  });

  it("OPERATING + CALCULATING before maturity is ordinary quiet waiting", async () => {
    const sdk = fakeSdk({ product: ProductState.OPERATING, cycle: CycleState.CALCULATING });
    const alerts: string[] = [];
    await new KeeperBot(sdk, { vaults: [vault], signer, onAlert: (a) => alerts.push(a.type) }).tick();
    expect(alerts).toEqual([]);
    expect(sdk.calls).toEqual([]);
  });

  // SETTLING means the final cycle is running. Its only exit is the Settlement Operator's final
  // batch, which the Keeper cannot produce — so it alerts rather than attempting a transition.
  it("SETTLING alerts that the final batch is outstanding and attempts nothing", async () => {
    const sdk = fakeSdk({ product: ProductState.SETTLING });
    const alerts: string[] = [];
    await new KeeperBot(sdk, { vaults: [vault], signer, onAlert: (a) => alerts.push(a.type) }).tick();
    expect(alerts).toEqual(["final-cycle-pending"]);
    expect(sdk.calls).toEqual([]);
  });

  it("MATURING advances to CLAIMING", async () => {
    const sdk = fakeSdk({ product: ProductState.MATURING });
    await bot(sdk).tick();
    expect(sdk.calls).toEqual(["enterClaiming"]);
  });

  it("CLAIMING closes the product", async () => {
    const sdk = fakeSdk({ product: ProductState.CLAIMING });
    await bot(sdk).tick();
    expect(sdk.calls).toEqual(["closeProduct"]);
  });

  it("CLOSED is terminal — no transition is attempted, poll after poll", async () => {
    const sdk = fakeSdk({ product: ProductState.CLOSED });
    const b = bot(sdk);
    await b.tick();
    await b.tick();
    await b.tick();
    expect(sdk.calls).toEqual([]);
  });
});
