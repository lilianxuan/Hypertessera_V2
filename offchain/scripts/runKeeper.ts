/**
 * KeeperBot runner (development-plan.md §3.3.2).
 *
 * Points `offchain/src/keeperBot.ts` at a deployment and drives ProductState transitions. It is
 * deliberately parameterised rather than hardwired to BNB Testnet so the same runner can be aimed
 * at a local anvil fork (`--rpc http://127.0.0.1:8546`), the real testnet, or a devnet.
 *
 * Signing modes:
 *   --pk 0x...            sign with a private key (the only mode that works on a real chain)
 *   --role keeper         derive a role wallet from TESTNET_MNEMONIC (scripts/testnet/wallets.ts)
 *   --impersonate 0x...   fork-only: unlock the account via anvil_impersonateAccount
 *
 * Examples:
 *   # one tick against a BNB Testnet fork, as the deploy wallet (which is Keeper on all vaults)
 *   npx tsx scripts/runKeeper.ts --rpc http://127.0.0.1:8546 \
 *     --impersonate 0x425beB70d264362E4eb7953C4f7aFBDe01145538 --vaults note --once
 *
 *   # poll every 15s against the real testnet, as the mnemonic-derived keeper wallet
 *   npx tsx --env-file=../.env.testnet scripts/runKeeper.ts \
 *     --rpc $BSC_TESTNET_RPC --role keeper --vaults cash,note,lp --poll 15000
 *
 *   # same, signing with an explicit private key instead of the mnemonic
 *   npx tsx --env-file=../.env.testnet scripts/runKeeper.ts \
 *     --pk $KEEPER_PK --vaults cash,note,lp --poll 15000
 *
 * Tuning:
 *   --poll 15000          poll interval in ms; --once runs a single tick and exits
 *
 * See docs/offchain-operations-runbook.md for the full operational procedure (role grants,
 * gas funding, long-running deployment).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Wallet, type Signer } from "ethers";
import { HyperTesseraSDK, type HyperTesseraAddresses } from "../src/sdk.js";
import { KeeperBot, type KeeperAlert } from "../src/keeperBot.js";
import { ProductState, CycleState, type Address } from "../src/types.js";
import { ROLE_INDEX, deriveWallet, type RoleName } from "./testnet/wallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ADDRESSES = join(__dirname, "testnet", "addresses.bscTestnet.json");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Resolves `cash` / `note` / `lp` against the address book; anything else is taken literally. */
export function resolveVaults(spec: string, addresses: HyperTesseraAddresses): Address[] {
  return spec.split(",").map((s) => {
    const key = s.trim();
    if (key === "cash") return addresses.cashVault;
    if (key === "note") return addresses.noteVault;
    if (key === "lp") return addresses.lpVault;
    return key;
  });
}

async function resolveSigner(provider: JsonRpcProvider): Promise<Signer> {
  const pk = arg("pk") ?? process.env.KEEPER_PK;
  const role = arg("role");
  const impersonated = arg("impersonate");
  if (pk) return new Wallet(pk, provider);
  if (role) {
    if (!(role in ROLE_INDEX)) {
      throw new Error(`unknown --role '${role}'; expected one of: ${Object.keys(ROLE_INDEX).join(", ")}`);
    }
    // Derives from TESTNET_MNEMONIC, so no private key has to be pasted on the command line (where
    // it would land in shell history and `ps`). wallets.ts raises a self-explaining error when the
    // mnemonic is missing.
    return deriveWallet(ROLE_INDEX[role as RoleName], provider);
  }
  if (impersonated) {
    await provider.send("anvil_impersonateAccount", [impersonated]);
    return provider.getSigner(impersonated);
  }
  throw new Error(
    "no signer: pass --role <name> (with TESTNET_MNEMONIC set), --pk <key> (or KEEPER_PK), or --impersonate <address> on a fork",
  );
}

async function main() {
  const rpcUrl = arg("rpc") ?? process.env.RPC_URL ?? "http://127.0.0.1:8546";
  const addressesPath = arg("addresses") ?? DEFAULT_ADDRESSES;
  const raw = JSON.parse(readFileSync(addressesPath, "utf-8")) as HyperTesseraAddresses;
  const provider = new JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });

  const sdk = new HyperTesseraSDK(raw, provider);
  const signer = await resolveSigner(provider);
  const vaults = resolveVaults(arg("vaults", "cash,note,lp")!, raw);

  const alerts: KeeperAlert[] = [];
  const bot = new KeeperBot(sdk, {
    vaults,
    signer,
    onAlert: (a) => {
      alerts.push(a);
      console.log(`  [alert:${a.type}] ${a.vault ?? ""} ${a.message}`);
    },
    maxRetries: Number(arg("max-retries", "2")),
    baseRetryDelayMs: Number(arg("retry-delay", "200")),
  });

  console.log(`KeeperBot -> ${rpcUrl} (chainId ${(await provider.getNetwork()).chainId})`);
  console.log(`  signer: ${await signer.getAddress()}`);
  console.log(`  vaults: ${vaults.join(", ")}`);

  async function report(label: string) {
    for (const v of vaults) {
      const ctx = await sdk.getStateContext(v);
      console.log(
        `  ${label} ${v}  product=${ProductState[ctx.product]} cycle=${CycleState[ctx.cycle]} cycleNumber=${ctx.cycleNumber}`,
      );
    }
  }

  await report("before");
  if (flag("once")) {
    await bot.tick();
    await report("after ");
    console.log(`Done. ${alerts.length} alert(s).`);
    return;
  }

  const interval = Number(arg("poll", "15000"));
  bot.start(interval);
  console.log(`Polling every ${interval}ms — Ctrl-C to stop.`);
  process.on("SIGINT", () => {
    bot.stop();
    process.exit(0);
  });
}

// Only run when invoked directly — `resolveVaults` is imported by runSettlement.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
