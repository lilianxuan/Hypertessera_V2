/**
 * Grants (or revokes) the vault-local Keeper role on the three tranche vaults, so `runKeeper.ts`
 * has an account allowed to drive lifecycle transitions.
 *
 * Owner is NOT implicitly a Keeper — `BaseVault` requires an explicit `setKeeper` grant
 * (`scripts/local/testSettlementTail.ts:41-55` pins this), so this step is mandatory whenever the
 * bot runs as anything other than the wallet the deploy script already granted.
 *
 *   cd offchain
 *   npx tsx --env-file=../.env.testnet scripts/testnet/grantKeeper.ts --keeper-role keeper --dry-run
 *   npx tsx --env-file=../.env.testnet scripts/testnet/grantKeeper.ts --keeper-role keeper
 *   npx tsx --env-file=../.env.testnet scripts/testnet/grantKeeper.ts --keeper 0xabc... --revoke
 *
 * The grantee is either a role name from `wallets.ts` (`--keeper-role`) or a literal address
 * (`--keeper`). The Owner signer comes from `OWNER_PK` / `TEST_PK`, or from `--owner-role <name>`
 * when the Owner is one of the mnemonic-derived wallets.
 *
 * Idempotent: vaults already in the requested state are skipped, so re-running after a partial
 * failure only sends what is missing.
 */
import { Wallet, type Signer } from "ethers";
import { loadTestnetDeployment } from "./config.js";
import { ROLE_INDEX, deriveWallet, type RoleName } from "./wallets.js";
import { HyperTesseraSDK } from "../../src/sdk.js";
import type { Address } from "../../src/types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function asRoleName(name: string): RoleName {
  if (!(name in ROLE_INDEX)) {
    throw new Error(`unknown role '${name}'; expected one of: ${Object.keys(ROLE_INDEX).join(", ")}`);
  }
  return name as RoleName;
}

async function main() {
  const { raw, addresses, provider, wallets } = loadTestnetDeployment();
  const sdk = new HyperTesseraSDK(addresses, provider);

  const keeperRole = arg("keeper-role");
  const keeper = (arg("keeper") ?? (keeperRole ? wallets[asRoleName(keeperRole)].address : undefined)) as
    | Address
    | undefined;
  if (!keeper) throw new Error("pass --keeper-role <name> or --keeper <address>");

  const ownerRole = arg("owner-role");
  const ownerPk = arg("owner-pk") ?? process.env.OWNER_PK ?? process.env.TEST_PK;
  let owner: Signer;
  if (ownerRole) owner = deriveWallet(ROLE_INDEX[asRoleName(ownerRole)], provider);
  else if (ownerPk) owner = new Wallet(ownerPk, provider);
  else throw new Error("no Owner signer: pass --owner-role <name> or --owner-pk <key> (or OWNER_PK / TEST_PK)");

  const approved = !process.argv.includes("--revoke");
  const dryRun = process.argv.includes("--dry-run");
  const ownerAddress = await owner.getAddress();
  const vaults: [string, Address][] = [
    ["cash", addresses.cashVault],
    ["note", addresses.noteVault],
    ["lp", addresses.lpVault],
  ];

  console.log(`grantKeeper -> chainId ${raw.chainId}`);
  console.log(`  owner signer: ${ownerAddress}`);
  console.log(`  keeper:       ${keeper} (approved=${approved})${dryRun ? " [dry-run]" : ""}`);

  for (const [label, vault] of vaults) {
    const contract = sdk.vaultAt(vault);
    const current = (await contract.isKeeper(keeper)) as boolean;
    if (current === approved) {
      console.log(`  ${label} ${vault} — already isKeeper=${current}, skipped`);
      continue;
    }
    const onChainOwner = (await contract.owner()) as string;
    if (onChainOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new Error(`${label} vault Owner is ${onChainOwner}, not the signer — setKeeper would revert`);
    }
    if (dryRun) {
      console.log(`  ${label} ${vault} — would setKeeper(${keeper}, ${approved})`);
      continue;
    }
    await sdk.setKeeper(vault, keeper, approved, owner);
    console.log(`  ${label} ${vault} — setKeeper done, isKeeper=${await contract.isKeeper(keeper)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
