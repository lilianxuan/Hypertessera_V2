import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Contract } from "ethers";
import { getAbi } from "../../src/abis.js";
import { deriveWallet, ROLE_INDEX } from "./wallets.js";
import { sendLocalTransaction } from "./transaction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const GOVERNOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account 0

function readJson(relPath: string) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf-8"));
}

/**
 * Deploys the full stack to a running local anvil node by driving the actual delivery scripts (the
 * core -> platform stages under `script/deploy/`, then one `DeployVault` run per vault) via
 * `forge script --broadcast`, then does the one remaining piece of Curator-owned wiring the scripts
 * deliberately leave out (`LiquidityAdapter.setBridgeTarget` — see `DeployVault`'s doc comment).
 *
 * `script/deploy.sh` is the driver for real deployments; this harness drives the stages directly
 * because it additionally rewires each Vault's roles onto the dedicated local persona wallets.
 *
 * Reuses the deploy scripts' own role convention (`ANVIL_1..ANVIL_7`, see `DeployConfig`) rather
 * than inventing a parallel one — see `scripts/local/wallets.ts` for the full role -> account map,
 * extended with dedicated Settlement operator + investor accounts.
 *
 * Requires anvil already running (`anvil --port 8545`) and `TEST_PK`/`PRIVATE_KEY` NOT set in the
 * environment (forge auto-loads `.env`, which holds the real BNB testnet deployer key — this
 * script always passes an explicit `TEST_PK` override to force the anvil default account).
 */
function forgeScript(contract: string, env: Record<string, string>) {
  const label = `${contract}${env.VAULT_LABEL ? ` (${env.VAULT_LABEL})` : ""}`;
  const started = Date.now();
  console.log(`[local:deploy] ${label}: starting forge`);
  // Serialize broadcasts and bound both individual receipt waits and the whole child process.
  execFileSync(
    "forge",
    ["script", `script/deploy/${contract}.s.sol`, "--tc", contract, "--rpc-url", RPC_URL,
      "--broadcast", "--slow", "--timeout", "60"],
    { cwd: REPO_ROOT, env: { ...process.env, TEST_PK: GOVERNOR_PK, ...env },
      stdio: "inherit", timeout: 180_000 },
  );
  console.log(`[local:deploy] ${label}: finished elapsedMs=${Date.now() - started}`);
}

async function main() {
  // --- Stage 1: core (Module A partial, Module D, revenue pool, demo assets) ---
  forgeScript("DeployCore", {});
  const stage1 = readJson("control-panel/deployments.json");

  // --- Stage 2: platform (real StateManager, NAVOracle, Queue, factories, Settlement) ---
  forgeScript("DeployPlatform", {
    HYPER_ACCESS_CONTROL: stage1.addresses.HyperAccessControl,
    // The platform stage has required this since the UnifiedPool -> RevenuePool authorisation
    // moved into it; the harness was never updated, so `npm run local:deploy` aborted at stage 2.
    REVENUE_POOL: stage1.addresses.RevenuePool,
    USDT: stage1.addresses.MockUSDT,
    PROTOCOL_FEE_CONFIG: stage1.addresses.ProtocolFeeConfig,
  });
  const stage2 = readJson("control-panel/deployments-platform.json");

  // --- Stage 3: one DeployVault run per vault ---
  // `staticNetwork` pins chainId 31337 instead of leaving ethers to detect it: with detection on,
  // a single failed `eth_chainId` puts the provider into a retry that every later call waits behind.
  const provider = new JsonRpcProvider(RPC_URL, 31337, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: true });
  try {
    const settlementOperator1 = deriveWallet(ROLE_INDEX.settlementOperator1, provider);
    const settlementOperator2 = deriveWallet(ROLE_INDEX.settlementOperator2, provider);
    const dataProvider = deriveWallet(ROLE_INDEX.dataProvider, provider);

    // The platform stage creates no vault, so each of the three delivery vaults is deployed the same
    // way the client deploys their next one. LP last: it bridges into the Cash vault.
    const platformEnv = {
      STATE_MANAGER: stage2.addresses.StateManager,
      QUEUE: stage2.addresses.Queue,
      UNIFIED_POOL: stage2.addresses.UnifiedPool,
      SETTLEMENT: stage2.addresses.Settlement,
      ADAPTER_FACTORY: stage2.addresses.AdapterFactory,
      VAULT_FACTORY: stage2.addresses.VaultFactory,
      CLAIM_REGISTRY: stage2.addresses.ClaimRegistry,
      LIQUIDITY_BRIDGE: stage2.addresses.LiquidityBridge,
      USDT: stage1.addresses.MockUSDT,
      SETTLEMENT_OPERATORS: `${settlementOperator1.address},${settlementOperator2.address}`,
      SETTLEMENT_THRESHOLD: "2",
      DATA_PROVIDER_SIGNER: dataProvider.address,
      // Keep Curator on `governor` through the deploy; the role-wiring step below delegates it to
      // the curator persona once bootstrap is done, which is the order the old scripts used too.
      VAULT_CURATOR: deriveWallet(ROLE_INDEX.governor, provider).address,
    };
    const vaults: Record<string, { vault: string; adapter: string }> = {};
    for (const label of ["cash", "note", "lp"]) {
      forgeScript("DeployVault", {
        ...platformEnv,
        VAULT_KIND: label,
        VAULT_LABEL: label,
        ...(label === "lp" ? { CASH_VAULT: vaults.cash.vault } : {}),
      });
      vaults[label] = readJson(`control-panel/deployments-vault-${label}.json`).vault;
    }

    // --- Vault-local role wiring ---
    // The vaults stage bootstraps each Vault with `governor` as Owner and explicitly grants it
    // Keeper (see `DeployVaults._grantVaultLocalRoles`, which calls `setKeeper(governor, true)` —
    // Owner no longer implicitly inherits Keeper); it also sets `governor` as Curator so the
    // governor-broadcast Curator-gated bootstrap calls (addAdapter/setAdapter, setDataProvider)
    // succeed. Now that bootstrap is done, delegate Curator/Guardian/Allocator (Owner-gated setters,
    // so `governor` can still call them) to the dedicated Anvil persona wallets, matching the
    // ROLE_INDEX convention the rest of this local devnet (and runTestPlan.ts) expects.
    const governor = deriveWallet(ROLE_INDEX.governor, provider);
    const curator = deriveWallet(ROLE_INDEX.curator, provider);
    const guardian = deriveWallet(ROLE_INDEX.guardian, provider);
    const baseVaultAbi = getAbi("EarnVault"); // BaseVault role setters — shared by EarnVault/LiquidityEarnVault
    // Log every transaction and explicitly poll its receipt with a finite deadline.
    for (const vaultAddr of [vaults.cash.vault, vaults.note.vault, vaults.lp.vault]) {
      const vault = new Contract(vaultAddr, baseVaultAbi, governor);
      console.log(`  wiring roles on ${vaultAddr}`);
      await sendLocalTransaction(provider, `${vaultAddr}.setCurator`, () => vault.setCurator(curator.address));
      await sendLocalTransaction(provider, `${vaultAddr}.setGuardian`, () => vault.setGuardian(guardian.address));
      await sendLocalTransaction(provider, `${vaultAddr}.setAllocator`, () => vault.setAllocator(curator.address)); // same wallet as Curator, per the old convention
    }

    // --- UnifiedPool.receiveVaultPrincipal wiring ---
    // UnifiedPool is deployed in Stage 1 against StubStateManager (Deploy.s.sol's `stub` — Module D's
    // standalone testing scaffold, immutable once UnifiedPool.initialize() runs), which is a
    // different contract instance from the real StateManager the three demo Vaults register into in
    // Stage 2. UnifiedPool.receiveVaultPrincipal (Task 4) checks
    // `sm.registeredVaults(msg.sender)` against that StubStateManager, so without this step every
    // real Vault's `returnPrincipalToPool` call reverts with `UnregisteredVault` even though the Vault
    // is registered in the real StateManager. StubStateManager.setRegistered is a permissionless
    // testing-scaffold setter for exactly this — mark all three real Vaults registered there too.
    const stub = new Contract(stage1.addresses.StubStateManager, getAbi("StubStateManager"), governor);
    for (const vaultAddr of [vaults.cash.vault, vaults.note.vault, vaults.lp.vault]) {
      console.log(`  registering ${vaultAddr} in StubStateManager`);
      await sendLocalTransaction(provider, `StubStateManager.setRegistered(${vaultAddr})`, () => stub.setRegistered(vaultAddr, true));
    }

    // --- Final wiring: Curator sets the LP adapter's bridge target (deliberately not scripted) ---
    console.log("  setting the LP adapter's bridge target");
    const lpAdapter = new Contract(vaults.lp.adapter, getAbi("LiquidityAdapter"), curator);
    await sendLocalTransaction(provider, "LPAdapter.setBridgeTarget", () => lpAdapter.setBridgeTarget(stage2.addresses.LiquidityBridge, vaults.cash.vault));

    // Fund the one investor account anvil doesn't pre-fund by default (mnemonic index 11).
    console.log("  funding investor2");
    const investor2 = deriveWallet(ROLE_INDEX.investor2, provider);
    if ((await provider.getBalance(investor2.address)) === 0n) {
      await sendLocalTransaction(provider, "fund investor2", () => governor.sendTransaction({ to: investor2.address, value: 10n ** 19n }));
    }

    const addresses = {
      hyperAccessControl: stage1.addresses.HyperAccessControl,
      stateManager: stage2.addresses.StateManager,
      navOracle: stage2.addresses.NAVOracle,
      mintBurnController: stage1.addresses.MintBurnController,
      assetRegistry: stage1.addresses.AssetRegistry,
      reservePSM: stage1.addresses.ReservePSM,
      poRRegistry: stage1.addresses.PoRRegistry,
      queue: stage2.addresses.Queue,
      revenuePool: stage1.addresses.RevenuePool,
      unifiedPool: stage2.addresses.UnifiedPool,
      settlement: stage2.addresses.Settlement,
      vaultFactory: stage2.addresses.VaultFactory,
      adapterFactory: stage2.addresses.AdapterFactory,
      liquidityBridge: stage2.addresses.LiquidityBridge,
      cashVault: vaults.cash.vault,
      noteVault: vaults.note.vault,
      lpVault: vaults.lp.vault,
      cashAdapter: vaults.cash.adapter,
      noteAdapter: vaults.note.adapter,
      lpAdapter: vaults.lp.adapter,
      usdt: stage1.addresses.MockUSDT,
      assetRegistryModuleD: {
        note:
          "Module D (AssetRegistry/MintBurnController/ReservePSM/PoRRegistry/NAVOracle-stub) is deployed " +
          "standalone against StubStateManager, matching the confirmed 'D Asset Infra standalone module' " +
          "design (development-plan.md §7). It is NOT wired to the real vaults above — see TEST_PLAN.md.",
        stubStateManager: stage1.addresses.StubStateManager,
        navOracleStub: stage1.addresses.NAVOracle,
        demoRwaAdapter: stage1.addresses.RWAAdapter,
        sToken: stage1.addresses.SToken,
        jToken: stage1.addresses.JToken,
        sTokenAssetId: 1,
        jTokenAssetId: 2,
      },
      chainId: 31337,
      rpcUrl: RPC_URL,
    };

    writeFileSync(join(__dirname, "..", "..", "local", "addresses.json"), JSON.stringify(addresses, null, 2) + "\n");
    console.log("Wrote offchain/local/addresses.json");

    // Rewrite the control panel's config.js with every stage merged — the same merge
    // `script/deploy.sh` performs. Each stage's own writer only knows its own addresses, so without
    // this the panel's StateManager/Vault/VaultTimelock/Settlement/Adapter sections render
    // "— not loaded —" when served from file:// (where boot()'s per-stage fetch fallback can't run).
    // The flat Cash/Note/LP keys mirror the driver's: labels cash/note/lp fill them, so the panel
    // needs no knowledge of vault labels.
    const titled: Record<string, string> = { cash: "Cash", note: "Note", lp: "LP" };
    const vaultRecords = ["cash", "note", "lp"].map((l) => readJson(`control-panel/deployments-vault-${l}.json`).vault);
    const merged = {
      addresses: {
        ...stage1.addresses,
        ...stage2.addresses,
        ...Object.fromEntries(
          vaultRecords.flatMap((v) => [
            [`${titled[v.label]}Vault`, v.vault],
            [`${titled[v.label]}Adapter`, v.adapter],
            [`${titled[v.label]}VaultTimelock`, v.timelock],
          ]),
        ),
      },
      vaults: vaultRecords,
      chainId: 31337,
      roles: (stage1 as { roles?: Record<string, string> }).roles ?? {},
    };
    writeFileSync(
      join(REPO_ROOT, "control-panel", "config.js"),
      `window.HT_DEPLOYMENTS = ${JSON.stringify(merged)};\n`,
    );
    console.log(`Wrote control-panel/config.js (core + platform + ${vaultRecords.length} vaults merged)`);
  } finally {
    provider.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
