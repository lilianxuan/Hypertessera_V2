/**
 * Funds the 15 BNB Testnet role wallets (scripts/testnet/wallets.ts) with testnet BNB for gas and
 * MockUSDT for deposit flows.
 *
 *   cd offchain
 *   npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run   # plan only, no txs
 *   npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts             # actually send
 *
 * Environment (see .env.testnet.example):
 *   TESTNET_MNEMONIC   — derives the 15 role wallets
 *   TEST_PK            — private key of the funding wallet (must already hold testnet BNB)
 *   BSC_TESTNET_RPC    — optional RPC override
 *   FUND_BNB_AMOUNT    — optional, default 0.002 BNB per wallet
 *   FUND_USDT_AMOUNT   — optional, default 100000 USDT (6 decimals) per wallet
 *
 * Two properties this script deliberately guarantees:
 *   - STRICTLY SEQUENTIAL sends. Every tx is awaited to inclusion before the next is built. All
 *     transfers share one `from` address, so any parallelism (Promise.all) would race on nonce.
 *   - IDEMPOTENT. Balances are read first and a wallet already at or above target is skipped, so
 *     re-running after a partial failure only tops up what is missing.
 *
 * MockUSDT.mint(address,uint256) has no access control (test/mocks/MockUSDT.sol), so the funding
 * wallet can mint to anyone; only gas is consumed.
 */
import { Contract, Wallet, formatEther, formatUnits, parseEther, parseUnits, type JsonRpcProvider } from "ethers";
import { loadTestnetDeployment } from "./config.js";
import { ROLE_INDEX, type RoleName } from "./wallets.js";

const USDT_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const USDT_DECIMALS = 6;

const BNB_PER_WALLET = parseEther(process.env.FUND_BNB_AMOUNT?.trim() || "0.002");
const USDT_PER_WALLET = parseUnits(process.env.FUND_USDT_AMOUNT?.trim() || "100000", USDT_DECIMALS);

interface WalletState {
  role: RoleName;
  index: number;
  address: string;
  bnb: bigint;
  usdt: bigint;
}

async function readState(
  provider: JsonRpcProvider,
  usdt: Contract,
  targets: { role: RoleName; index: number; address: string }[],
): Promise<WalletState[]> {
  const out: WalletState[] = [];
  for (const t of targets) {
    const bnb = await provider.getBalance(t.address);
    const bal = (await usdt.balanceOf(t.address)) as bigint;
    out.push({ ...t, bnb, usdt: bal });
  }
  return out;
}

function printTable(title: string, states: WalletState[]) {
  console.log("");
  console.log(title);
  console.log("-".repeat(96));
  console.log("  idx  role                    address                                       BNB          USDT");
  console.log("-".repeat(96));
  for (const s of states) {
    console.log(
      `  ${String(s.index).padStart(3)}  ${s.role.padEnd(22)}  ${s.address}  ` +
        `${formatEther(s.bnb).padStart(10)}  ${formatUnits(s.usdt, USDT_DECIMALS).padStart(12)}`,
    );
  }
  console.log("-".repeat(96));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const { raw, provider, wallets } = loadTestnetDeployment();
  console.log(`chainId ${raw.chainId} | rpc ${process.env.BSC_TESTNET_RPC?.trim() || raw.rpcUrl}`);
  console.log(`MockUSDT ${raw.usdt}`);
  console.log(
    `targets: ${formatEther(BNB_PER_WALLET)} BNB and ${formatUnits(USDT_PER_WALLET, USDT_DECIMALS)} USDT per wallet`,
  );
  if (dryRun) console.log("*** DRY RUN — no transactions will be sent ***");

  const targets = (Object.entries(ROLE_INDEX) as [RoleName, number][]).map(([role, index]) => ({
    role,
    index,
    address: wallets[role].address,
  }));

  // --- 1. Read current balances (idempotency baseline) ---
  console.log("");
  console.log("[1/4] reading current balances...");
  const usdtRead = new Contract(raw.usdt, USDT_ABI, provider);
  const before = await readState(provider, usdtRead, targets);
  printTable("Balances BEFORE:", before);

  const needBnb = before.filter((s) => s.bnb < BNB_PER_WALLET);
  const needUsdt = before.filter((s) => s.usdt < USDT_PER_WALLET);
  console.log("");
  console.log(`  ${needBnb.length}/${before.length} wallets need BNB, ${needUsdt.length}/${before.length} need USDT`);

  if (needBnb.length === 0 && needUsdt.length === 0) {
    console.log("  nothing to do — all wallets already funded.");
    return;
  }

  if (dryRun) {
    console.log("");
    console.log("[dry run] would send, strictly sequentially:");
    for (const s of needBnb) {
      console.log(`  BNB  -> ${s.role.padEnd(22)} ${s.address}  ${formatEther(BNB_PER_WALLET - s.bnb)}`);
    }
    for (const s of needUsdt) {
      console.log(
        `  MINT -> ${s.role.padEnd(22)} ${s.address}  ${formatUnits(USDT_PER_WALLET - s.usdt, USDT_DECIMALS)} USDT`,
      );
    }
    console.log("");
    console.log("[dry run] complete — nothing was broadcast.");
    return;
  }

  // --- 2. Funding wallet ---
  const pk = process.env.TEST_PK?.trim();
  if (!pk) {
    throw new Error(
      "TEST_PK is not set. Set it in <repo-root>/.env.testnet to the private key of a wallet that " +
        "already holds BNB Testnet gas (see https://testnet.bnbchain.org/faucet-smart), then re-run with " +
        "`npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts`.",
    );
  }
  const funder = new Wallet(pk, provider);
  const funderBnb = await provider.getBalance(funder.address);
  console.log("");
  console.log(`[2/4] funder ${funder.address} — ${formatEther(funderBnb)} BNB`);

  const totalBnbNeeded = needBnb.reduce((acc, s) => acc + (BNB_PER_WALLET - s.bnb), 0n);
  if (funderBnb < totalBnbNeeded) {
    throw new Error(
      `funder has ${formatEther(funderBnb)} BNB but needs at least ${formatEther(totalBnbNeeded)} BNB ` +
        "for the transfers alone (plus gas for those transfers and the USDT mints). Top it up from a faucet.",
    );
  }

  // --- 3. BNB transfers — one at a time, awaited to inclusion (shared nonce) ---
  console.log("");
  console.log(`[3/4] sending BNB to ${needBnb.length} wallet(s), sequentially...`);
  for (let i = 0; i < needBnb.length; i++) {
    const s = needBnb[i];
    const value = BNB_PER_WALLET - s.bnb;
    process.stdout.write(
      `  (${i + 1}/${needBnb.length}) ${s.role.padEnd(22)} ${s.address} += ${formatEther(value)} BNB ... `,
    );
    const tx = await funder.sendTransaction({ to: s.address, value });
    const receipt = await tx.wait();
    console.log(`ok  tx=${tx.hash} block=${receipt?.blockNumber}`);
  }

  // --- 4. MockUSDT mints — same sequential discipline ---
  console.log("");
  console.log(`[4/4] minting MockUSDT to ${needUsdt.length} wallet(s), sequentially...`);
  const usdtWrite = new Contract(raw.usdt, USDT_ABI, funder);
  for (let i = 0; i < needUsdt.length; i++) {
    const s = needUsdt[i];
    const amount = USDT_PER_WALLET - s.usdt;
    process.stdout.write(
      `  (${i + 1}/${needUsdt.length}) ${s.role.padEnd(22)} ${s.address} += ` +
        `${formatUnits(amount, USDT_DECIMALS)} USDT ... `,
    );
    const tx = await usdtWrite.mint(s.address, amount);
    const receipt = await tx.wait();
    console.log(`ok  tx=${tx.hash} block=${receipt?.blockNumber}`);
  }

  // --- Verification ---
  console.log("");
  console.log("verifying final balances...");
  const after = await readState(provider, usdtRead, targets);
  printTable("Balances AFTER:", after);

  const short = after.filter((s) => s.bnb < BNB_PER_WALLET || s.usdt < USDT_PER_WALLET);
  if (short.length > 0) {
    console.log("");
    console.log(`WARNING: ${short.length} wallet(s) still below target: ${short.map((s) => s.role).join(", ")}`);
    console.log("Re-run this script — it is idempotent and will only top up the shortfall.");
  } else {
    console.log("");
    console.log("all 15 wallets funded.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
