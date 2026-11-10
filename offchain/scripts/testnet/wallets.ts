import { Mnemonic, HDNodeWallet, JsonRpcProvider, type Wallet } from "ethers";

/**
 * Named role wallets for the BNB Testnet (chainId 97) integration environment.
 *
 * Unlike scripts/local/wallets.ts — which hardcodes anvil's public deterministic mnemonic because
 * those keys only ever touch a throwaway devnet — this module derives from a *fresh, testnet-only*
 * BIP-39 mnemonic supplied via the `TESTNET_MNEMONIC` environment variable. The mnemonic is
 * deliberately NOT stored in this file (or anywhere else in the repo) so it never enters git.
 *
 * Bootstrap:
 *   1. `npx tsx scripts/testnet/generateMnemonic.ts` — prints a new 12-word phrase + the 15 addresses.
 *   2. Save the phrase into `.env.testnet` at the repo root (see `.env.testnet.example`).
 *      `.env.testnet` is gitignored.
 *   3. Run scripts with the env file loaded, e.g.
 *      `npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts`
 *
 * These are TESTNET keys holding only faucet BNB and MockUSDT. Never reuse this mnemonic on mainnet.
 */
const DERIVATION_PATH = (i: number) => `m/44'/60'/0'/0/${i}`;

/**
 * 15 named roles for client integration testing (indices 0-14).
 * settlementOperator1..5 form the 3-of-5 Settlement multisig operator set.
 * This is the *suggested* assignment — the client may override it; see ROLE_ASSIGNMENT.md.
 */
export const ROLE_INDEX = {
  governor: 0, // protocol owner / deployer; owns each Vault and grants global roles
  curator: 1, // Vault-local Curator: product params, adapter wiring
  guardian: 2, // Vault-local Guardian: emergency pause
  allocator: 3, // Vault-local Allocator: moves capital between Vault and adapters
  keeper: 4, // KeeperBot operator: epoch rollover, queue processing
  dataProvider: 5, // per-Adapter Data Provider (IAdapter.setDataProvider) AND per-asset PoR publisher (PoRRegistry.setProofPublisher) — distinct contract roles, same wallet here
  tokenAgent: 6, // per-asset Token Agent (MintBurnController.setTokenAgent)
  navSigner: 7, // signs NAV updates consumed by NAVOracle
  settlementOperator1: 8,
  settlementOperator2: 9,
  settlementOperator3: 10,
  settlementOperator4: 11,
  settlementOperator5: 12,
  investor1: 13, // end-user deposit/withdraw flows
  investor2: 14, // second end-user, for multi-investor / partial-settlement cases
} as const;

export type RoleName = keyof typeof ROLE_INDEX;

/** The 3-of-5 Settlement operator set. */
export const SETTLEMENT_OPERATORS: readonly RoleName[] = [
  "settlementOperator1",
  "settlementOperator2",
  "settlementOperator3",
  "settlementOperator4",
  "settlementOperator5",
];

export const SETTLEMENT_THRESHOLD = 3;

function readMnemonic(): Mnemonic {
  const phrase = process.env.TESTNET_MNEMONIC?.trim();
  if (!phrase) {
    throw new Error(
      [
        "TESTNET_MNEMONIC is not set.",
        "",
        "The BNB Testnet role wallets are derived from a mnemonic that is deliberately kept out of git.",
        "To set it up:",
        "  1. Generate one:  npx tsx scripts/testnet/generateMnemonic.ts",
        "  2. Copy offchain/scripts/testnet/.env.testnet.example to <repo-root>/.env.testnet",
        "     and paste the phrase into TESTNET_MNEMONIC.",
        "  3. Re-run this script with the env file loaded, e.g.",
        "       npx tsx --env-file=../.env.testnet scripts/testnet/<script>.ts",
        "     (or `set -a; source ../.env.testnet; set +a` first).",
        "",
        "See offchain/scripts/testnet/ROLE_ASSIGNMENT.md for the role table.",
      ].join("\n"),
    );
  }
  return Mnemonic.fromPhrase(phrase);
}

export function deriveWallet(index: number, provider: JsonRpcProvider): Wallet {
  const mnemonic = readMnemonic();
  const node = HDNodeWallet.fromMnemonic(mnemonic, DERIVATION_PATH(index));
  return node.connect(provider) as unknown as Wallet;
}

export function loadWallets(provider: JsonRpcProvider): Record<RoleName, Wallet> {
  const entries = Object.entries(ROLE_INDEX) as [RoleName, number][];
  return Object.fromEntries(entries.map(([role, index]) => [role, deriveWallet(index, provider)])) as Record<
    RoleName,
    Wallet
  >;
}
