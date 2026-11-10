import { getBytes, type Signer } from "ethers";
import type { HyperTesseraSDK } from "./sdk.js";
import type { Address, Hex, RequestSettlement, SettlementInstruction, VaultSettlement } from "./types.js";

/**
 * One vault's worth of Company-computed settlement inputs (development-plan.md §5.1, §8 — net
 * settlement conversion). Redeem payouts and share pricing are computed entirely on-chain by
 * BaseVault from its own per-cycle price snapshot — there is no off-chain redeemAmounts/
 * navSnapshot/lpBonus; `amount` is poolDistributedAssets (how much USDT UnifiedPool sends to the
 * vault this cycle), independently bounded by UnifiedPool.availableToDistribute, not required to
 * equal any redeem total or gap.
 */
export interface VaultCalcInput {
  vault: Address;
  amount: bigint; // poolDistributedAssets — UnifiedPool.distribute() amount for this vault
  deposits: RequestSettlement[];
  redeems: RequestSettlement[];
}

export interface SettlementOperatorOptions {
  /** Operator signers available to this process for M-of-N signature collection. */
  operatorSigners: Signer[];
  /** Batch validity window from assembly time (default 1 hour). */
  validitySeconds?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SettlementOperator (development-plan.md §3.5, §5.1): assembles the Company's off-chain
 * per-cycle calculation into a `SettlementInstruction`, collects M-of-N operator signatures over
 * its hash, and submits the batch — retrying transient submission failures with exponential
 * backoff. All reward/LP-yield/bonus/redemption math is computed off-chain by the Company; this
 * class only assembles the schema and drives the on-chain call.
 *
 * Batch composition carries rules the contracts do not enforce — an LP Vault and the Cash Vault it
 * bridges into must travel in the same instruction, LP first, and no Allocator may bridge outside
 * settlement. Breaking the first two reverts the batch; breaking the third silently prices the LP's
 * entry before the Cash Vault's performance fee is taken. See docs/settlement-operator-runbook.md.
 */
export class SettlementOperator {
  private readonly sdk: HyperTesseraSDK;
  private readonly options: Required<SettlementOperatorOptions>;

  constructor(sdk: HyperTesseraSDK, options: SettlementOperatorOptions) {
    this.sdk = sdk;
    this.options = {
      operatorSigners: options.operatorSigners,
      validitySeconds: options.validitySeconds ?? 3600,
      maxRetries: options.maxRetries ?? 5,
      baseRetryDelayMs: options.baseRetryDelayMs ?? 1000,
    };
  }

  /** Build a `SettlementInstruction` from the Company's per-vault calc inputs. */
  assembleInstruction(cycleNumber: bigint, vaults: VaultCalcInput[]): SettlementInstruction {
    const vaultSettlements: VaultSettlement[] = vaults.map((v) => ({
      distribution: { vault: v.vault, amount: v.amount },
      deposits: v.deposits,
      redeems: v.redeems,
    }));
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + this.options.validitySeconds);
    return { vaultSettlements, cycleNumber, validUntil };
  }

  /** Each configured operator signer signs the instruction's keccak256 hash (eth_sign-prefixed, matching Settlement.sol's ECDSA.recover). */
  async collectSignatures(instruction: SettlementInstruction): Promise<Hex[]> {
    const batchHash = await this.sdk.hashInstruction(instruction);
    const signatures: Hex[] = [];
    for (const signer of this.options.operatorSigners) {
      signatures.push(await signer.signMessage(getBytes(batchHash)));
    }
    return signatures;
  }

  /** Retry `fn` with exponential backoff; rethrows after `maxRetries` attempts. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (attempt > this.options.maxRetries) throw err;
        await sleep(this.options.baseRetryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  async submit(instruction: SettlementInstruction, signatures: Hex[], relayer: Signer) {
    return this.withRetry(() => this.sdk.submitBatch(instruction, signatures, relayer));
  }

  /** Full pipeline: assemble -> sign -> submit. */
  async run(cycleNumber: bigint, vaults: VaultCalcInput[], relayer: Signer) {
    const instruction = this.assembleInstruction(cycleNumber, vaults);
    const signatures = await this.collectSignatures(instruction);
    return this.submit(instruction, signatures, relayer);
  }

}
