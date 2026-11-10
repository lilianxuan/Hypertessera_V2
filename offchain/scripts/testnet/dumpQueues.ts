/**
 * Prints the deposit/redeem queues an `OnChainEventIndexer` reconstructs per vault — the calc input the
 * SettlementOperator works from (`getPendingDeposits` / `getClearingList`), plus the live on-chain
 * queue depths to reconcile the reconstruction against.
 *
 * Read-only: it backfills logs and calls view functions, and never sends a transaction.
 *
 *   cd offchain
 *   npx tsx --env-file=../.env.testnet scripts/testnet/dumpQueues.ts --from-block 125000000
 *   npx tsx --env-file=../.env.testnet scripts/testnet/dumpQueues.ts --from-block 125000000 --chunk 500
 *
 * `--chunk` sizes the windows `backfill` already walks the range in (default 2000). Public RPC
 * endpoints cap `eth_getLogs` spans and rate-limit wide sweeps, so a smaller window is the knob to
 * reach for when an endpoint rejects the default.
 *
 * See docs/offchain-indexer-guide.md.
 */
import { OnChainEventIndexer } from "../../src/indexer.js";
import { HyperTesseraSDK } from "../../src/sdk.js";
import { loadTestnetDeployment } from "./config.js";
import { PauseState, type Address } from "../../src/types.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main() {
  const { raw, addresses, provider } = loadTestnetDeployment();
  const sdk = new HyperTesseraSDK(addresses, provider);
  const indexer = new OnChainEventIndexer(sdk, provider);

  const latest = await provider.getBlockNumber();
  const fromBlock = Number(arg("from-block", "0"));
  const toBlock = Number(arg("to-block", String(latest)));
  const chunkSize = Number(arg("chunk", "2000"));

  console.log(`dumpQueues -> chainId ${raw.chainId}, blocks ${fromBlock}..${toBlock} (latest ${latest})`);

  await indexer.backfill(fromBlock, toBlock, { chunkSize });
  console.log(`  indexed through block ${indexer.lastIndexedBlock()}`);

  const vaults: [string, Address][] = [
    ["cash", addresses.cashVault],
    ["note", addresses.noteVault],
    ["lp", addresses.lpVault],
  ];

  for (const [label, vault] of vaults) {
    const pending = indexer.getPendingDeposits(vault);
    const clearing = indexer.getClearingList(vault);
    const depth = await indexer.getQueueSnapshot(vault);

    console.log(`\n${label} ${vault}`);
    console.log(`  pause: ${PauseState[indexer.getVaultPauseState(vault)]}`);
    console.log(`  on-chain depth: deposit=${depth.depositDepth} redeem=${depth.redeemDepth}`);

    console.log(`  pending deposits (${pending.length}):`);
    for (const d of pending) {
      const writtenDown = d.writtenDownHaircut > 0n ? ` writtenDown=${d.writtenDownHaircut}` : "";
      console.log(`    #${d.requestId} owner=${d.owner} assets=${d.assets}${writtenDown} block=${d.blockNumber}`);
    }

    console.log(`  clearing list (${clearing.length}, FIFO order):`);
    for (const r of clearing) {
      // `remainingShares`, not `shares`, is what the next cycle still owes on a partially filled request.
      const partial = r.remainingShares !== r.shares ? ` (of ${r.shares}, filled through cycle ${r.lastSettledCycleNumber})` : "";
      console.log(`    slot ${r.slotIndex} #${r.requestId} owner=${r.owner} remaining=${r.remainingShares}${partial}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
