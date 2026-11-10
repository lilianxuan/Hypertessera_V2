import type { Signer } from "ethers";
import type { HyperTesseraSDK } from "./sdk.js";
import { ProductState, CycleState, type Address } from "./types.js";

export type KeeperAlertType = "transition-error" | "final-cycle-pending";

export interface KeeperAlert {
  type: KeeperAlertType;
  vault?: Address;
  assetId?: bigint;
  message: string;
}

export interface KeeperBotOptions {
  /** Vaults this bot drives through their product/cycle lifecycle. */
  vaults: Address[];
  /** Signer that is each vault's Owner or an appointed Keeper (per-vault, via IVaultRoles). */
  signer: Signer;
  onAlert?: (alert: KeeperAlert) => void;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

const KNOWN_NOT_DUE_ERRORS = new Set([
  "ConditionNotMet",
  "WrongProductState",
  "WrongCycleState",
  "InvalidStateTransition",
  "InvalidCycleTransition",
]);

/**
 * True if `err` is StateManager rejecting a transition as not-yet-due (timing gate, wrong state).
 * Prefers decoding the raw revert data via the StateManager ABI — ethers does not always resolve a
 * custom error to a human-readable name in its thrown Error's message (e.g. during estimateGas), so
 * falling back to substring-matching `err.message` alone misses real "not due" reverts.
 */
function isNotDueError(sdk: HyperTesseraSDK, err: unknown): boolean {
  const data = (err as { data?: string })?.data;
  if (data) {
    try {
      const parsed = sdk.stateManager.interface.parseError(data);
      if (parsed) return KNOWN_NOT_DUE_ERRORS.has(parsed.name);
    } catch {
      // fall through to message matching
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return [...KNOWN_NOT_DUE_ERRORS].some((name) => message.includes(name));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * KeeperBot (development-plan.md §3.5): drives ProductState/CycleState transitions, raises NAV
 * freshness alerts, and retries transient failures with exponential backoff. Timing gates
 * (subscriptionStart, cycleDuration, maturityTimestamp, ...) live entirely on-chain in
 * StateManager — the bot just attempts the next transition every tick and treats an on-chain
 * "not due yet" revert as a no-op rather than an error.
 */
export class KeeperBot {
  private readonly sdk: HyperTesseraSDK;
  private readonly options: Required<Omit<KeeperBotOptions, "onAlert">> & Pick<KeeperBotOptions, "onAlert">;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(sdk: HyperTesseraSDK, options: KeeperBotOptions & { pollIntervalMs?: number }) {
    this.sdk = sdk;
    this.options = {
      vaults: options.vaults,
      signer: options.signer,
      maxRetries: options.maxRetries ?? 5,
      baseRetryDelayMs: options.baseRetryDelayMs ?? 1000,
      onAlert: options.onAlert,
    };
  }

  private alert(a: KeeperAlert): void {
    this.options.onAlert?.(a);
  }

  /** Attempt the next lifecycle transition for one vault; swallows "not due yet" reverts. */
  private async driveVault(vault: Address): Promise<void> {
    const state = await this.sdk.getStateContext(vault);
    const signer = this.options.signer;

    // "Not due yet" reverts are expected steady-state noise (the gate just hasn't opened) and are
    // swallowed immediately — only genuinely unexpected errors go through the retry/backoff path.
    const attempt = async (fn: () => Promise<unknown>) => {
      let retries = 0;
      for (;;) {
        try {
          await fn();
          return;
        } catch (err) {
          if (isNotDueError(this.sdk, err)) return;
          retries++;
          if (retries > this.options.maxRetries) {
            this.alert({ type: "transition-error", vault, message: err instanceof Error ? err.message : String(err) });
            return;
          }
          await sleep(this.options.baseRetryDelayMs * 2 ** (retries - 1));
        }
      }
    };

    switch (state.product) {
      case ProductState.CONFIGURING:
        await attempt(() => this.sdk.openSubscription(vault, signer));
        break;
      case ProductState.SUBSCRIBING:
        await attempt(() => this.sdk.finalizeSubscription(vault, signer));
        break;
      case ProductState.OPERATING: {
        // There is no longer a Keeper transition that jumps straight to SETTLING at maturity:
        // doing that skipped the product's final cycle, so the last year's return never reached
        // a settlement price, the last performance fee was never charged, and requests queued
        // before maturity were never priced. The Keeper now just starts the next cycle —
        // StateManager treats maturity as its own trigger — and the final cycle's own
        // completeCycle moves the product to SETTLING atomically
        // (一年期产品最终周期结算与产品参数调整说明 §7.3).
        if (state.cycle === CycleState.ACCEPTING) {
          await attempt(() => this.sdk.startCycleCalculation(vault, signer));
          break;
        }
        // Still OPERATING while CALCULATING: an ordinary cycle is mid-settlement. Past maturity
        // that cycle is NOT promoted to final — completing it moves the product into SETTLING and
        // opens a fresh final cycle — so the Keeper simply waits for the operator either way.
        break;
      }
      case ProductState.SETTLING: {
        // SETTLING means the FINAL cycle is running, and its only exit is the Settlement
        // Operator's final batch — which the Keeper cannot produce (it holds no operator keys).
        // completeCycle then moves the product to MATURING atomically, so there is no Keeper
        // transition to attempt here at all
        // (最终周期结算及最终兑付补充修改方案 §九).
        this.alert({
          type: "final-cycle-pending",
          vault,
          message:
            "vault is SETTLING: its final cycle is awaiting the Settlement Operator's final " +
            "batch (an empty batch is valid). The product cannot reach MATURING until it lands.",
        });
        break;
      }
      case ProductState.MATURING:
        await attempt(() => this.sdk.enterClaiming(vault, signer));
        break;
      case ProductState.CLAIMING:
        await attempt(() => this.sdk.closeProduct(vault, signer));
        break;
      default:
        break;
    }
  }

  /** Run one pass over all watched vaults. Safe to call directly in tests without start(). */
  async tick(): Promise<void> {
    for (const vault of this.options.vaults) {
      await this.driveVault(vault);
    }
  }

  start(pollIntervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
