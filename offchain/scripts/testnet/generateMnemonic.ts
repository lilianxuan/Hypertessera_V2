/**
 * Generates a fresh 12-word BIP-39 mnemonic for the BNB Testnet role wallets and prints the 15
 * derived addresses alongside their role names.
 *
 * Run once, then paste the phrase into `<repo-root>/.env.testnet` as `TESTNET_MNEMONIC`
 * (see .env.testnet.example). Nothing is written to disk by this script — that is deliberate, so
 * the mnemonic can never end up in git.
 *
 *   cd offchain && npx tsx scripts/testnet/generateMnemonic.ts
 */
import { Mnemonic, HDNodeWallet, randomBytes } from "ethers";
import { ROLE_INDEX, SETTLEMENT_OPERATORS, SETTLEMENT_THRESHOLD, type RoleName } from "./wallets.js";

const DERIVATION_PATH = (i: number) => `m/44'/60'/0'/0/${i}`;

function main() {
  // 16 bytes of entropy => 12 words.
  const mnemonic = Mnemonic.fromEntropy(randomBytes(16));

  console.log("");
  console.log("=".repeat(78));
  console.log("  HyperTessera — BNB Testnet (chainId 97) role wallets");
  console.log("=".repeat(78));
  console.log("");
  console.log("  MNEMONIC (12 words) — store this in <repo-root>/.env.testnet, never in git:");
  console.log("");
  console.log(`    TESTNET_MNEMONIC="${mnemonic.phrase}"`);
  console.log("");
  console.log("-".repeat(78));
  console.log("  idx  role                    address");
  console.log("-".repeat(78));

  const entries = Object.entries(ROLE_INDEX) as [RoleName, number][];
  for (const [role, index] of entries) {
    const node = HDNodeWallet.fromMnemonic(mnemonic, DERIVATION_PATH(index));
    console.log(`  ${String(index).padStart(3)}  ${role.padEnd(22)}  ${node.address}`);
  }

  console.log("-".repeat(78));
  console.log(
    `  Settlement multisig: ${SETTLEMENT_THRESHOLD}-of-${SETTLEMENT_OPERATORS.length} — ` +
      SETTLEMENT_OPERATORS.join(", "),
  );
  console.log("");
  console.log("  Next steps:");
  console.log("    1. cp offchain/scripts/testnet/.env.testnet.example .env.testnet   (repo root)");
  console.log("    2. Paste the phrase above into TESTNET_MNEMONIC, and set TEST_PK to a funded wallet.");
  console.log("    3. cd offchain && npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts");
  console.log("");
}

main();
