/**
 * SettlementOperator runner (development-plan.md §3.4.2).
 *
 * Points `offchain/src/settlementOperator.ts` at a deployment: assembles a SettlementInstruction
 * from a JSON spec, collects the M-of-N operator signatures, and relays `Settlement.submitBatch`.
 * Parameterised the same way as `runKeeper.ts` so it can be aimed at a local anvil fork or the
 * real testnet.
 *
 * Batch composition is the operator's responsibility and is NOT enforced on-chain — see
 * docs/settlement-operator-runbook.md. In particular an LP Vault and its `cashVault()` must be in
 * the same instruction, LP first. The order of `vaults` in the spec is preserved verbatim.
 *
 * Spec format (amounts are decimal strings so they survive JSON):
 *   {
 *     "cycleNumber": "1",
 *     "vaults": [
 *       { "vault": "lp",   "amount": "0", "deposits": [{ "requestId": "2", "settleAmount": "220000000" }], "redeems": [] },
 *       { "vault": "cash", "amount": "0", "deposits": [], "redeems": [] }
 *     ]
 *   }
 * `vault` accepts `cash` / `note` / `lp` or a literal address.
 *
 * Example:
 *   npx tsx scripts/runSettlement.ts --rpc http://127.0.0.1:8546 \
 *     --spec /tmp/batch.json --operator-pks 0xabc..,0xdef.. --relayer-pk 0xabc..
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { HyperTesseraSDK, type HyperTesseraAddresses } from "../src/sdk.js";
import { SettlementOperator, type VaultCalcInput } from "../src/settlementOperator.js";
import { resolveVaults } from "./runKeeper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ADDRESSES = join(__dirname, "testnet", "addresses.bscTestnet.json");

interface RawRequestSettlement {
  requestId: string;
  settleAmount: string;
}

interface RawVaultCalc {
  vault: string;
  amount?: string;
  deposits?: RawRequestSettlement[];
  redeems?: RawRequestSettlement[];
}

export interface BatchSpec {
  cycleNumber: string;
  vaults: RawVaultCalc[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

export function parseSpec(spec: BatchSpec, addresses: HyperTesseraAddresses): VaultCalcInput[] {
  return spec.vaults.map((v) => ({
    vault: resolveVaults(v.vault, addresses)[0],
    amount: BigInt(v.amount ?? "0"),
    deposits: (v.deposits ?? []).map((d) => ({
      requestId: BigInt(d.requestId),
      settleAmount: BigInt(d.settleAmount),
    })),
    redeems: (v.redeems ?? []).map((r) => ({
      requestId: BigInt(r.requestId),
      settleAmount: BigInt(r.settleAmount),
    })),
  }));
}

async function main() {
  const rpcUrl = arg("rpc") ?? process.env.RPC_URL ?? "http://127.0.0.1:8546";
  const addressesPath = arg("addresses") ?? DEFAULT_ADDRESSES;
  const specPath = arg("spec");
  if (!specPath) throw new Error("--spec <path-to-batch.json> is required");

  const raw = JSON.parse(readFileSync(addressesPath, "utf-8")) as HyperTesseraAddresses;
  const spec = JSON.parse(readFileSync(specPath, "utf-8")) as BatchSpec;
  const provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  const sdk = new HyperTesseraSDK(raw, provider);

  const operatorPks = (arg("operator-pks") ?? process.env.SETTLEMENT_OPERATOR_PKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (operatorPks.length === 0) throw new Error("--operator-pks <pk,pk,...> (or SETTLEMENT_OPERATOR_PKS) is required");
  const operatorSigners = operatorPks.map((pk) => new Wallet(pk, provider));

  // The relayer only pays gas — submitBatch itself is permissionless, the operator signatures are
  // the gate (Settlement.sol:70). Defaults to the first operator.
  const relayerPk = arg("relayer-pk") ?? process.env.SETTLEMENT_RELAYER_PK ?? operatorPks[0];
  const relayer = new Wallet(relayerPk, provider);

  const vaults = parseSpec(spec, raw);
  const operator = new SettlementOperator(sdk, {
    operatorSigners,
    validitySeconds: Number(arg("validity", "3600")),
    maxRetries: Number(arg("max-retries", "2")),
    baseRetryDelayMs: Number(arg("retry-delay", "200")),
  });

  console.log(`SettlementOperator -> ${rpcUrl} (chainId ${(await provider.getNetwork()).chainId})`);
  console.log(`  cycleNumber: ${spec.cycleNumber}`);
  for (const v of vaults) {
    console.log(
      `  ${v.vault}  amount=${v.amount}  deposits=${v.deposits.length}  redeems=${v.redeems.length}`,
    );
  }
  console.log(`  signers: ${(await Promise.all(operatorSigners.map((s) => s.getAddress()))).join(", ")}`);

  const instruction = operator.assembleInstruction(BigInt(spec.cycleNumber), vaults);
  console.log(`  batchHash: ${await sdk.hashInstruction(instruction)}`);

  const signatures = await operator.collectSignatures(instruction);
  const receipt = await operator.submit(instruction, signatures, relayer);
  console.log(`Submitted in block ${receipt?.blockNumber} (tx ${receipt?.hash}), gas ${receipt?.gasUsed}`);
}

// Only run when invoked directly — runKeeper.ts-style helpers above are importable.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
