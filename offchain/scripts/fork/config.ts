import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HDNodeWallet, JsonRpcProvider, Mnemonic, type JsonRpcSigner, type Wallet } from "ethers";
import type { HyperTesseraAddresses } from "../../src/sdk.js";
import type { RawTestnetAddresses } from "../testnet/config.js";

/**
 * Deployment loader for a **local anvil fork of BNB Testnet**.
 *
 * The address book is the same `addresses.bscTestnet.json` the real testnet uses — the v3
 * generation deployed on 2026-08-17 (docs/deployment-bsctestnet-2026-08-17-v3.md). Only the RPC
 * endpoint differs: everything here points at the fork so no transaction can ever reach the real
 * chain.
 *
 * Wallets are deliberately NOT derived from `TESTNET_MNEMONIC` (scripts/testnet/wallets.ts) —
 * a fork does not need the real testnet keys, and keeping them out means this script can never
 * accidentally sign something that a mis-set RPC would broadcast for real. Instead:
 *
 *   - privileged calls are made by **impersonating** the deploy wallet, which on the v3 generation
 *     holds Governor + every Vault's Owner/Curator/Guardian/Allocator/Keeper + Settlement operator
 *     + every Adapter's Data Provider (see the deployment doc);
 *   - anything that must produce an ECDSA **signature** (Settlement operator signatures) uses an
 *     anvil account, because an impersonated account has no key to sign with. The deploy wallet
 *     grants those accounts the operator role first, exactly as a real operator rotation would.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDRESSES_PATH = join(__dirname, "..", "testnet", "addresses.bscTestnet.json");

/** The v3 deploy wallet — Governor and every privileged role. Impersonated, never signed for. */
export const DEPLOY_WALLET = "0x425beB70d264362E4eb7953C4f7aFBDe01145538";

/** anvil's public deterministic mnemonic. These keys only ever touch the fork. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export const FORK_RPC_URL = process.env.FORK_RPC_URL?.trim() || "http://127.0.0.1:8546";

export function anvilWallet(index: number, provider: JsonRpcProvider): Wallet {
  const node = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(ANVIL_MNEMONIC), `m/44'/60'/0'/0/${index}`);
  return node.connect(provider) as unknown as Wallet;
}

/** Named anvil accounts used by the fork scripts. Indices are anvil's pre-funded 0-9. */
export const FORK_ROLE_INDEX = {
  operator1: 1,
  operator2: 2,
  investor1: 3,
  investor2: 4,
  feeRecipient: 5,
  dataProvider: 6,
  relayer: 7,
} as const;

export type ForkRoleName = keyof typeof FORK_ROLE_INDEX;

export function loadForkDeployment(rpcUrl: string = FORK_RPC_URL) {
  const raw = JSON.parse(readFileSync(ADDRESSES_PATH, "utf-8")) as RawTestnetAddresses;
  // cacheTimeout: -1 disables ethers' 250ms read cache — on a chain that mines a block per
  // transaction a cached nonce/balance is stale immediately (see scripts/local/config.ts).
  const provider = new JsonRpcProvider(rpcUrl, raw.chainId, { batchMaxCount: 1, cacheTimeout: -1 });

  const addresses: HyperTesseraAddresses = {
    hyperAccessControl: raw.hyperAccessControl,
    stateManager: raw.stateManager,
    navOracle: raw.navOracle,
    mintBurnController: raw.mintBurnController,
    assetRegistry: raw.assetRegistry,
    reservePSM: raw.reservePSM,
    poRRegistry: raw.poRRegistry,
    queue: raw.queue,
    revenuePool: raw.revenuePool,
    unifiedPool: raw.unifiedPool,
    settlement: raw.settlement,
    vaultFactory: raw.vaultFactory,
    adapterFactory: raw.adapterFactory,
    liquidityBridge: raw.liquidityBridge,
    cashVault: raw.cashVault,
    noteVault: raw.noteVault,
    lpVault: raw.lpVault,
    cashAdapter: raw.cashAdapter,
    noteAdapter: raw.noteAdapter,
    lpAdapter: raw.lpAdapter,
    protocolFeeConfig: raw.protocolFeeConfig,
  };

  const entries = Object.entries(FORK_ROLE_INDEX) as [ForkRoleName, number][];
  const wallets = Object.fromEntries(entries.map(([r, i]) => [r, anvilWallet(i, provider)])) as Record<
    ForkRoleName,
    Wallet
  >;

  return { raw, addresses, provider, wallets };
}

// ---------------------------------------------------------------------------
// anvil cheat helpers — every one of these is a fork-only capability and is
// called out in the run report. None of them fabricates protocol state: they
// only unlock a key we do not hold (impersonation) or move the clock.
// ---------------------------------------------------------------------------

/** Unlock `address` so the fork accepts unsigned transactions from it. */
export async function impersonate(provider: JsonRpcProvider, address: string): Promise<JsonRpcSigner> {
  await provider.send("anvil_impersonateAccount", [address]);
  return provider.getSigner(address);
}

export async function stopImpersonating(provider: JsonRpcProvider, address: string): Promise<void> {
  await provider.send("anvil_stopImpersonatingAccount", [address]);
}

export async function advanceTime(provider: JsonRpcProvider, seconds: number): Promise<void> {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

/** Jump the clock to an absolute timestamp; no-op if already past it. */
export async function warpTo(provider: JsonRpcProvider, timestamp: number): Promise<void> {
  const now = Number((await provider.getBlock("latest"))!.timestamp);
  if (now >= timestamp) return;
  await advanceTime(provider, timestamp - now);
}

export async function now(provider: JsonRpcProvider): Promise<number> {
  return Number((await provider.getBlock("latest"))!.timestamp);
}

export async function snapshot(provider: JsonRpcProvider): Promise<string> {
  return provider.send("evm_snapshot", []);
}

export async function revertTo(provider: JsonRpcProvider, id: string): Promise<void> {
  const ok = await provider.send("evm_revert", [id]);
  if (!ok) throw new Error(`evm_revert(${id}) failed`);
}
