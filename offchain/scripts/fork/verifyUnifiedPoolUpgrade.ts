/**
 * Proves the UnifiedPool StateManager correction against the **real deployed v3 bytecode**,
 * through a local anvil fork of BNB Testnet. Nothing is broadcast.
 *
 * The defect: DeployW3 initialises the UnifiedPool proxy during the W1/W2 stage, when only
 * `StubStateManager` exists. The stub registers no vaults, `UnifiedPool.sm` has no setter and
 * `initialize` cannot re-run, so `receiveVaultPrincipal` — and therefore
 * `BaseVault.returnPrincipalToPool` — reverts `UnregisteredVault` on all three live Vaults.
 *
 * The fix: a `reinitializer(2)` (`UnifiedPool.reinitializeStateManager`) delivered via the
 * existing governor-gated UUPS `upgradeToAndCall`. The proxy address is unchanged, so no
 * address-table churn for the client.
 *
 * Start the fork first (public data-seed endpoints are pruned and answer historical state with
 * `missing trie node`; publicnode is an archive node and works):
 *
 *   anvil --fork-url https://bsc-testnet-rpc.publicnode.com --chain-id 97 --port 8546
 *   cd offchain && npx tsx scripts/fork/verifyUnifiedPoolUpgrade.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Contract, ContractFactory } from "ethers";
import { DEPLOY_WALLET, impersonate, loadForkDeployment } from "./config.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const POOL_ARTIFACT = join(REPO_ROOT, "out", "UnifiedPool.sol", "UnifiedPool.json");

const SETTLEMENT_ABI = ["function sm() view returns (address)"];
const VAULT_ABI = [
  "function returnPrincipalToPool(uint256 amount)",
  "function freeVaultUSDT() view returns (uint256)",
  "function unifiedPool() view returns (address)",
  "function settlement() view returns (address)",
];
const USDT_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
];

/** Reverts are the assertion here, so capture the selector rather than letting it throw. */
async function expectRevert(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as { data?: string; info?: { error?: { data?: string } } };
    return err.data ?? err.info?.error?.data ?? String((e as Error).message);
  }
  throw new Error("expected a revert, call succeeded");
}

async function main() {
  const { addresses, provider, raw } = loadForkDeployment();
  const artifact = JSON.parse(readFileSync(POOL_ARTIFACT, "utf-8"));

  const governor = await impersonate(provider, DEPLOY_WALLET);
  const pool = new Contract(addresses.unifiedPool, artifact.abi, provider);
  const settlement = new Contract(addresses.settlement, SETTLEMENT_ABI, provider);
  const vault = new Contract(addresses.cashVault, VAULT_ABI, governor);
  const usdt = new Contract(raw.usdt, USDT_ABI, governor);

  // --- 1. The defect, on the deployed bytecode -----------------------------
  const poolSm: string = await pool.sm();
  const settlementSm: string = await settlement.sm();

  // This is a migration tool: it repairs a pool that still carries the defect. Once the upgrade has
  // been applied to a generation there is nothing left to do, so verify the end state and stop.
  // The permanent invariant lives in runForkE2E.ts scenario 9.
  if (poolSm.toLowerCase() === settlementSm.toLowerCase()) {
    console.log(`  UnifiedPool.sm()  = ${poolSm}`);
    console.log("  already bound to the real StateManager — upgrade already applied, nothing to do.");
    const spent = await expectRevert(() =>
      new Contract(addresses.unifiedPool, artifact.abi, governor).reinitializeStateManager.staticCall(
        addresses.stateManager,
      ),
    );
    assert.ok(
      spent.startsWith("0xf92ee8a9"),
      `pool is corrected but the reinitializer is not spent (got ${spent}) — investigate`,
    );
    console.log("  reinitializeStateManager is spent (InvalidInitialization).");
    return;
  }
  assert.equal(
    (await vault.unifiedPool()).toLowerCase(),
    addresses.unifiedPool.toLowerCase(),
    "cash vault is not wired to this pool",
  );
  console.log(`  UnifiedPool.sm()  = ${poolSm}   (StubStateManager)`);
  console.log(`  Settlement.sm()   = ${settlementSm}   (real StateManager)`);

  // Give the vault free cash to return. MockUSDT.mint is public and unpermissioned on the
  // deployed mock — the same faucet anyone can call on the real testnet, not a fork cheat.
  const AMOUNT = 1_000_000n; // 1 USDT, 6dp
  await (await usdt.mint(addresses.cashVault, AMOUNT)).wait();
  const free: bigint = await vault.freeVaultUSDT();
  assert.ok(free >= AMOUNT, `vault free USDT ${free} < ${AMOUNT}`);

  const revertData = await expectRevert(() => vault.returnPrincipalToPool.staticCall(AMOUNT));
  // UnregisteredVault(address) — 0x0c03962a
  assert.ok(
    revertData.startsWith("0x0c03962a"),
    `expected UnregisteredVault(0x0c03962a), got ${revertData}`,
  );
  console.log(`  returnPrincipalToPool -> reverts UnregisteredVault (${revertData.slice(0, 10)})`);

  // --- 2. Ledger state before the upgrade ----------------------------------
  const before = {
    pending: (await pool.pending(addresses.cashVault)) as bigint,
    totalPending: (await pool.totalPending()) as bigint,
    unattributedPrincipal: (await pool.unattributedPrincipal()) as bigint,
    usdt: (await pool.usdt()) as string,
    ac: (await pool.ac()) as string,
    configured: (await pool.vaultConfigured(addresses.cashVault)) as boolean,
    poolBalance: (await usdt.balanceOf(addresses.unifiedPool)) as bigint,
  };
  assert.equal(before.configured, true, "cash vault is not configured on the pool");

  // --- 3. Deploy the corrected implementation and upgrade ------------------
  const impl = await new ContractFactory(artifact.abi, artifact.bytecode.object, governor).deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();

  const initData = pool.interface.encodeFunctionData("reinitializeStateManager", [
    addresses.stateManager,
  ]);
  const receipt = await (
    await new Contract(addresses.unifiedPool, artifact.abi, governor).upgradeToAndCall(
      implAddress,
      initData,
    )
  ).wait();
  console.log(`  upgradeToAndCall -> impl ${implAddress}, gas ${receipt.gasUsed}`);

  // --- 4. Post-conditions --------------------------------------------------
  assert.equal(
    (await pool.sm()).toLowerCase(),
    addresses.stateManager.toLowerCase(),
    "sm did not repoint to the real StateManager",
  );
  assert.equal(await pool.pending(addresses.cashVault), before.pending, "pending ledger moved");
  assert.equal(await pool.totalPending(), before.totalPending, "totalPending moved");
  assert.equal(
    await pool.unattributedPrincipal(),
    before.unattributedPrincipal,
    "unattributedPrincipal moved",
  );
  assert.equal(await pool.usdt(), before.usdt, "usdt binding moved");
  assert.equal(await pool.ac(), before.ac, "access control binding moved");
  assert.equal(await pool.vaultConfigured(addresses.cashVault), true, "vaultConfigured moved");

  // The same call that reverted above now settles.
  await (await vault.returnPrincipalToPool(AMOUNT)).wait();
  assert.equal(
    await pool.pending(addresses.cashVault),
    before.pending + AMOUNT,
    "pending did not credit",
  );
  assert.equal(await pool.totalPending(), before.totalPending + AMOUNT, "totalPending did not credit");
  assert.equal(
    await usdt.balanceOf(addresses.unifiedPool),
    before.poolBalance + AMOUNT,
    "pool did not receive the USDT",
  );

  // One-shot: a second reinitialize must be rejected.
  const twice = await expectRevert(() =>
    new Contract(addresses.unifiedPool, artifact.abi, governor).reinitializeStateManager.staticCall(
      addresses.stateManager,
    ),
  );
  // Initializable.InvalidInitialization() — 0xf92ee8a9
  assert.ok(twice.startsWith("0xf92ee8a9"), `expected InvalidInitialization, got ${twice}`);

  console.log(`  returnPrincipalToPool(${AMOUNT}) -> pending ${before.pending} -> ${before.pending + AMOUNT}`);
  console.log(`  second reinitializeStateManager -> InvalidInitialization (${twice.slice(0, 10)})`);
  console.log("\nPASS — UnifiedPool repointed, ledger preserved, returnPrincipalToPool live.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
