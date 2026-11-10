import { Mnemonic, HDNodeWallet, JsonRpcProvider, type Wallet } from "ethers";

/**
 * Named role wallets for the local devnet, derived from anvil's standard deterministic mnemonic
 * (never used outside local testing). Indices 0-9 are anvil's default pre-funded accounts;
 * indices 10-11 are derived the same way but not pre-funded by anvil (funded manually where a
 * role needs to submit transactions — see scripts/local/deploy.ts).
 *
 * Role -> index map matches the convention already embedded in script/deploy/DeployConfig.sol
 * (ANVIL_1..ANVIL_7), extended with dedicated Settlement operator + investor accounts for this
 * local test setup. Under the Vault-local/Asset-local RBAC model, `governor` deploys and remains
 * each demo Vault's Owner; `curator`/`guardian` are then delegated the Vault-local
 * Curator/Guardian roles (see scripts/local/deploy.ts's role-wiring step, run after the vaults and
 * settlement stages since those forge scripts broadcast everything as `governor` for bootstrap).
 */
const MNEMONIC = "test test test test test test test test test test test junk";
const DERIVATION_PATH = (i: number) => `m/44'/60'/0'/0/${i}`;

export const ROLE_INDEX = {
  governor: 0, // each demo Vault's Owner
  curator: 1, // delegated Vault-local Curator (and Allocator, same wallet per the old convention)
  guardian: 2, // delegated Vault-local Guardian
  issuer: 3, // arbitrary UnifiedPool payer / RWA counterparty stand-in in the test plan
  tokenAgent: 4, // per-asset Token Agent (MintBurnController.setTokenAgent)
  demoNavSigner: 5, // NAV signer for Module D's standalone demoVault only — NOT the real vaults
  dataProvider: 6,
  compliance: 7,
  investor1: 8,
  settlementOperator1: 9,
  settlementOperator2: 10,
  investor2: 11,
} as const;

export type RoleName = keyof typeof ROLE_INDEX;

export function deriveWallet(index: number, provider: JsonRpcProvider): Wallet {
  const mnemonic = Mnemonic.fromPhrase(MNEMONIC);
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
