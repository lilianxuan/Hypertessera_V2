import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Contract, type JsonRpcProvider, type Signer, type Wallet } from "ethers";
import { getAbi } from "../src/abis.js";
import type { HyperTesseraAddresses } from "../src/sdk.js";

/**
 * Full local deploy for the integration suite.
 *
 * Rather than re-implementing the deployment topology in TypeScript (which silently drifts from the
 * Solidity every time the constructor/wiring surface changes), this drives the *actual* delivery
 * scripts — the core -> platform stages under `script/deploy/`, then one `DeployVault` run per
 * vault — via `forge script
 * --broadcast`, exactly as `offchain/scripts/local/deploy.ts` does for the local devnet. Those
 * scripts are covered by the `forge test` suite and used for real deployments, so they cannot drift.
 *
 * The stages are driven directly here rather than through `script/deploy.sh` because each test file
 * runs its own anvil on its own port and supplies its own operator wallets, which the driver reads
 * from a committed network file.
 *
 * CONCURRENCY: `forge script --broadcast` writes its output to the repo-root-relative paths
 * `control-panel/deployments{,-platform,-vault-*}.json` regardless of which anvil port it targets.
 * The integration test files therefore MUST NOT run in parallel — `package.json`'s
 * `test:integration` enforces this with `vitest run --no-file-parallelism`. Don't drop that flag.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function readJson(relPath: string) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf-8"));
}

/**
 * `forge` auto-loads the repo `.env` (which holds a real testnet deployer key), so every invocation
 * passes an explicit `TEST_PK` to pin the broadcaster to the caller's `governor` wallet.
 */
/**
 * Drops forge's broadcast/cache records for the local chain id.
 *
 * Every integration file deploys to its own anvil, but all of them are chain 31337, so forge reuses
 * `broadcast/<script>.s.sol/31337` and `cache/<script>.s.sol/31337` across them. A record left by
 * the previous file refers to transactions that exist only on that file's (now dead) node, and
 * forge waits on them forever — the second suite in a run would hang in beforeAll while its anvil
 * sat idle and healthy. Clearing the directories keeps every deploy self-contained.
 */
function clearBroadcastRecords(chainId = 31337): void {
  for (const dir of ["broadcast", "cache"]) {
    for (const stage of Object.values(STAGES)) {
      rmSync(join(REPO_ROOT, dir, `${stage.contract}.s.sol`, String(chainId)), { recursive: true, force: true });
    }
  }
}

/** The deploy stages this harness drives, in order. */
const STAGES = {
  core:     { contract: "DeployCore",     output: "control-panel/deployments.json" },
  platform: { contract: "DeployPlatform", output: "control-panel/deployments-platform.json" },
  vault:    { contract: "DeployVault",    output: "" }, // one file per vault, see VAULT_LABELS
} as const;

/** The three delivery vaults, each deployed by its own `DeployVault` run. */
const VAULTS = ["cash", "note", "lp"] as const;

const vaultOutput = (label: string) => `control-panel/deployments-vault-${label}.json`;

function forgeScript(contract: string, rpcUrl: string, pk: string, env: Record<string, string>): Promise<void> {
  // Deliberately async (not execFileSync): the test's anvil is spawned with a piped stdout, and a
  // synchronous child would block this process's event loop for the whole deploy — the pipe would
  // fill, anvil would block on write, stop mining, and forge would report dropped transactions.
  return new Promise((resolve, reject) => {
    const child = spawn(
      "forge",
      // --slow serialises the broadcast: each transaction is sent only after the previous one is
      // confirmed. Without it forge fires the whole batch at once, and under load anvil
      // occasionally never mines one of them — forge then blocks in `wait_for_pending` waiting for
      // a receipt that never arrives, which is the intermittent beforeAll hang this suite had.
      // --timeout turns any residual stall into a failed deploy instead of a wedged test run.
      [
        "script",
        `script/deploy/${contract}.s.sol`,
        "--tc",
        contract,
        "--rpc-url",
        rpcUrl,
        "--broadcast",
        "--slow",
        "--timeout",
        "60",
      ],
      { cwd: REPO_ROOT, env: { ...process.env, TEST_PK: pk, ...env }, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`forge script --tc ${contract} exited with code ${code}`)),
    );
  });
}

/** MockUSDT (script/deploy/testing/MockUSDT.sol) — only the members the tests actually use. */
const USDT_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

export interface DeployedStack {
  addresses: HyperTesseraAddresses;
  usdt: Contract;
  governor: Signer;
  operator1: Signer;
  operator2: Signer;
}

const DAY = 86400;

export async function deployFullStack(signers: {
  governor: Signer;
  operator1: Signer;
  operator2: Signer;
}): Promise<DeployedStack> {
  const { governor, operator1, operator2 } = signers;
  const governorAddr = await governor.getAddress();
  const pk = (governor as Wallet).privateKey;
  if (!pk) throw new Error("deployFullStack requires `governor` to be an ethers Wallet (needs .privateKey for TEST_PK)");
  // The tests each run their own anvil on a different port; recover that port's URL from the
  // provider the caller's wallets are connected to rather than hardcoding one.
  // `_getConnection()` is internal-by-convention (underscore-prefixed) but is a *typed* public
  // member of ethers v6's JsonRpcProvider, and v6 exposes no non-underscore alternative for
  // reading a provider's URL back. Kept as a typed cast rather than `as any` so that a future
  // ethers rename/removal fails `npm run typecheck` instead of silently yielding
  // `--rpc-url undefined`.
  const rpcUrl: string = (governor.provider as JsonRpcProvider)._getConnection().url;

  // --- Stage 1: core (governance, asset infra/Module D, revenue pool, demo assets) ---
  clearBroadcastRecords();
  await forgeScript(STAGES.core.contract, rpcUrl, pk, {});
  const stage1 = readJson(STAGES.core.output).addresses;

  // --- Stage 2: platform (StateManager, UnifiedPool, Queue, factories, Settlement) ---
  // This stage takes REVENUE_POOL as an input and emits UNIFIED_POOL as an OUTPUT (it deploys the
  // pool itself against the real StateManager). Passing a stage 1 pool in here is not just
  // useless, it is unset: stage 1 does not deploy a UnifiedPool at all.
  await forgeScript(STAGES.platform.contract, rpcUrl, pk, {
    HYPER_ACCESS_CONTROL: stage1.HyperAccessControl,
    REVENUE_POOL: stage1.RevenuePool,
    USDT: stage1.MockUSDT,
    PROTOCOL_FEE_CONFIG: stage1.ProtocolFeeConfig,
  });
  const stage2 = readJson(STAGES.platform.output).addresses;

  // --- Stage 3: one DeployVault run per vault ---
  // The platform no longer creates any vault, so the three delivery vaults are deployed here the
  // same way the client will deploy their fourth: one run each, reusing the shared contracts.
  // LP goes last because it bridges into the Cash vault and needs its address.
  const platformEnv = {
    STATE_MANAGER: stage2.StateManager,
    QUEUE: stage2.Queue,
    UNIFIED_POOL: stage2.UnifiedPool,
    SETTLEMENT: stage2.Settlement,
    ADAPTER_FACTORY: stage2.AdapterFactory,
    VAULT_FACTORY: stage2.VaultFactory,
    CLAIM_REGISTRY: stage2.ClaimRegistry,
    LIQUIDITY_BRIDGE: stage2.LiquidityBridge,
    USDT: stage1.MockUSDT,
    SETTLEMENT_OPERATORS: `${await operator1.getAddress()},${await operator2.getAddress()}`,
    SETTLEMENT_THRESHOLD: "1",
    DATA_PROVIDER_SIGNER: governorAddr,
    // These tests use `governor` as the sole privileged caller, so every Vault-local role stays on
    // it. DeployVault hands Curator to VAULT_CURATOR at the end of each run; left unset on chain
    // 31337 that is the Anvil curator account, and `setProductParams` below is Curator-gated.
    VAULT_CURATOR: governorAddr,
    VAULT_KEEPER: governorAddr,
    VAULT_GUARDIAN: governorAddr,
    VAULT_ALLOCATOR: governorAddr,
  };
  const vaults: Record<string, { vault: string; adapter: string }> = {};
  for (const label of VAULTS) {
    await forgeScript(STAGES.vault.contract, rpcUrl, pk, {
      ...platformEnv,
      VAULT_KIND: label,
      VAULT_LABEL: label,
      ...(label === "lp" ? { CASH_VAULT: vaults.cash.vault } : {}),
    });
    vaults[label] = readJson(vaultOutput(label)).vault;
  }

  // The vaults stage already grants `governor` both Keeper and Curator on every vault (see
  // DeployVaults `_grantVaultLocalRoles`), which is all the 3 test files need — they use
  // `governor` as the sole privileged caller. The post-config stage is not run here: these tests
  // set the product parameters they need themselves, below.

  // ProductParams are deliberately not set by any deploy script (they're per-product business
  // config). Subscription opens now and ends in 3s, cycle duration 2s — fast enough for tests.
  const now = Math.floor(Date.now() / 1000);
  const productParams = {
    subscriptionStart: 0,
    subscriptionEnd: now + 3,
    walletSubscriptionCap: 10_000_000_000_000n,
    minRaiseAmount: 0,
    subscriptionCapShare: 0n,
    cycleDuration: 2,
    maturityTimestamp: now + 365 * DAY,
    claimingStart: now + 366 * DAY,
    claimingEnd: now + 367 * DAY,
    feeParams: 0,
  };
  const sm = new Contract(stage2.StateManager, getAbi("StateManager"), governor);
  for (const v of [vaults.cash.vault, vaults.note.vault, vaults.lp.vault]) {
    await (await sm.setProductParams(v, productParams)).wait();
  }

  const addresses: HyperTesseraAddresses = {
    hyperAccessControl: stage1.HyperAccessControl,
    stateManager: stage2.StateManager,
    // The real per-vault NAVOracle from the platform stage (the core stage's is the standalone
    // Module D stub).
    navOracle: stage2.NAVOracle,
    mintBurnController: stage1.MintBurnController,
    assetRegistry: stage1.AssetRegistry,
    reservePSM: stage1.ReservePSM,
    poRRegistry: stage1.PoRRegistry,
    queue: stage2.Queue,
    revenuePool: stage1.RevenuePool,
    unifiedPool: stage2.UnifiedPool,
    settlement: stage2.Settlement,
    vaultFactory: stage2.VaultFactory,
    adapterFactory: stage2.AdapterFactory,
    liquidityBridge: stage2.LiquidityBridge,
    cashVault: vaults.cash.vault,
    noteVault: vaults.note.vault,
    lpVault: vaults.lp.vault,
    cashAdapter: vaults.cash.adapter,
    noteAdapter: vaults.note.adapter,
    lpAdapter: vaults.lp.adapter,
  };

  const usdt = new Contract(stage1.MockUSDT, USDT_ABI, governor);

  return { addresses, usdt, governor, operator1, operator2 };
}
