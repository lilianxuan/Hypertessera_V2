import { BrowserProvider, Contract, type ContractRunner, type Signer, type TransactionReceipt, type TransactionResponse } from "ethers";
import type { HyperTesseraSDK } from "./sdk.js";
import type { Address, Hex } from "./types.js";

// Browser-facing Web3 helpers: wallet connect, network switch, permission detection, Allowance,
// transaction status, event parsing, error decoding. Pure additions on top of HyperTesseraSDK —
// nothing here changes how the SDK itself talks to contracts. No Node-specific imports, so this
// bundles cleanly in a Vite/webpack app; the only runtime dependency is `ethers` (already isomorphic)
// plus a real EIP-1193 provider (a wallet extension, or `window.ethereum`).

// ---------------------------------------------------------------------------
// Wallet discovery & connection (EIP-6963 with a legacy window.ethereum fallback)
// ---------------------------------------------------------------------------

/** The subset of EIP-1193 (`window.ethereum`-shaped) surface this module relies on. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  providers?: Eip1193Provider[];
  isMetaMask?: boolean;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  isBraveWallet?: boolean;
}

export interface WalletInfo {
  uuid: string;
  rdns: string;
  name: string;
  icon: string;
}

export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

function guessWalletName(p: Eip1193Provider): string {
  if (p.isOkxWallet || p.isOKExWallet) return "OKX Wallet";
  if (p.isRabby) return "Rabby";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isTrust || p.isTrustWallet) return "Trust Wallet";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isMetaMask) return "MetaMask";
  return "Injected Wallet";
}

function legacyWallets(): DiscoveredWallet[] {
  const eth = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) return [];
  const raw = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
  return raw.map((provider, i) => ({
    info: { uuid: `legacy-${i}`, rdns: `legacy.${i}`, name: guessWalletName(provider), icon: "" },
    provider,
  }));
}

/**
 * Discovers injected wallets via EIP-6963 (`eip6963:announceProvider`/`eip6963:requestProvider`),
 * falling back to legacy `window.ethereum` (including its `.providers[]` multi-injection shape)
 * if nothing answers within `timeoutMs`. Resolves once, after discovery settles — for a live
 * feed as wallets announce themselves, use `onWalletAnnounced` instead.
 */
export function discoverWallets(timeoutMs = 250): Promise<DiscoveredWallet[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  const found = new Map<string, DiscoveredWallet>();
  return new Promise((resolve) => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<DiscoveredWallet>).detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      found.set(detail.info.uuid, detail);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve(found.size ? [...found.values()] : legacyWallets());
    }, timeoutMs);
  });
}

/** Live feed of EIP-6963 wallet announcements — call the returned function to stop listening. */
export function onWalletAnnounced(callback: (wallet: DiscoveredWallet) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<DiscoveredWallet>).detail;
    if (detail?.info?.uuid && detail.provider) callback(detail);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", handler);
}

export interface WalletSession {
  address: Address;
  chainId: number;
}

/** `eth_requestAccounts` + `eth_chainId` — the only two prompts this module ever issues on its own. */
export async function connectWallet(provider: Eip1193Provider): Promise<WalletSession> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("Wallet returned no accounts");
  const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
  return { address: accounts[0] as Address, chainId: Number(chainIdHex) };
}

/** Silent reconnect — `eth_accounts` never prompts the user; empty array means no prior grant. */
export async function getConnectedAccounts(provider: Eip1193Provider): Promise<Address[]> {
  return (await provider.request({ method: "eth_accounts" })) as Address[];
}

export function onAccountsChanged(provider: Eip1193Provider, callback: (accounts: Address[]) => void): () => void {
  const listener = (...args: unknown[]) => callback(args[0] as Address[]);
  provider.on?.("accountsChanged", listener);
  return () => provider.removeListener?.("accountsChanged", listener);
}

export function onChainChanged(provider: Eip1193Provider, callback: (chainId: number) => void): () => void {
  const listener = (...args: unknown[]) => callback(Number(args[0] as string));
  provider.on?.("chainChanged", listener);
  return () => provider.removeListener?.("chainChanged", listener);
}

// ---------------------------------------------------------------------------
// Network switching
// ---------------------------------------------------------------------------

export interface AddEthereumChainParams {
  chainId: number;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** BNB Smart Chain Testnet — ready to pass to `switchNetwork`'s `addIfMissing` param. */
export const BNB_TESTNET: AddEthereumChainParams = {
  chainId: 97,
  chainName: "BNB Smart Chain Testnet",
  nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545"],
  blockExplorerUrls: ["https://testnet.bscscan.com"],
};

/**
 * `wallet_switchEthereumChain`; if the wallet doesn't have the chain yet (error code 4902) and
 * `addIfMissing` is supplied, falls back to `wallet_addEthereumChain` and retries the switch.
 */
export async function switchNetwork(provider: Eip1193Provider, chainId: number, addIfMissing?: AddEthereumChainParams): Promise<void> {
  const chainIdHex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902 || !addIfMissing) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: addIfMissing.chainName,
          nativeCurrency: addIfMissing.nativeCurrency,
          rpcUrls: addIfMissing.rpcUrls,
          blockExplorerUrls: addIfMissing.blockExplorerUrls,
        },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Signer wiring
// ---------------------------------------------------------------------------

export function createBrowserProvider(provider: Eip1193Provider): BrowserProvider {
  return new BrowserProvider(provider as never);
}

export async function getWriteSigner(provider: Eip1193Provider): Promise<Signer> {
  return createBrowserProvider(provider).getSigner();
}

// ---------------------------------------------------------------------------
// Permission / capability detection
// ---------------------------------------------------------------------------

export interface VaultPermissions {
  owner: Address;
  curator: Address;
  guardian: Address;
  allocator: Address;
  isOwner: boolean;
  isCurator: boolean;
  isGuardian: boolean;
  isAllocator: boolean;
  isKeeper: boolean;
}

/** Reads a vault's IVaultRoles state and resolves it against `account` in one round trip. */
export async function getVaultPermissions(sdk: HyperTesseraSDK, vault: Address, account: Address): Promise<VaultPermissions> {
  const v = sdk.vaultAt(vault);
  const [owner, curator, guardian, allocator, isKeeper] = await Promise.all([
    v.owner() as Promise<Address>,
    v.curator() as Promise<Address>,
    v.guardian() as Promise<Address>,
    v.allocator() as Promise<Address>,
    v.isKeeper(account) as Promise<boolean>,
  ]);
  const eq = (a: Address) => a.toLowerCase() === account.toLowerCase();
  return { owner, curator, guardian, allocator, isOwner: eq(owner), isCurator: eq(curator), isGuardian: eq(guardian), isAllocator: eq(allocator), isKeeper };
}

export interface SettlementPermissions {
  isOperator: boolean;
  threshold: bigint;
}

export async function getSettlementPermissions(sdk: HyperTesseraSDK, vault: Address, account: Address): Promise<SettlementPermissions> {
  const [isOperator, threshold] = await Promise.all([sdk.isOperator(vault, account), sdk.threshold(vault)]);
  return { isOperator, threshold };
}

/** Protocol-global GOVERNOR_ROLE check — reads the role hash on-chain rather than hardcoding keccak256("GOVERNOR_ROLE"). */
export async function isGovernor(sdk: HyperTesseraSDK, account: Address): Promise<boolean> {
  const role = (await sdk.hyperAccessControl.GOVERNOR_ROLE()) as Hex;
  return sdk.hasRole(role, account);
}

// ---------------------------------------------------------------------------
// ERC-20 Allowance helpers
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export function erc20(token: Address, runner: ContractRunner): Contract {
  return new Contract(token, ERC20_ABI, runner);
}

export async function getBalance(token: Address, account: Address, runner: ContractRunner): Promise<bigint> {
  return BigInt(await erc20(token, runner).balanceOf(account));
}

export async function getAllowance(token: Address, owner: Address, spender: Address, runner: ContractRunner): Promise<bigint> {
  return BigInt(await erc20(token, runner).allowance(owner, spender));
}

/**
 * Approves `spender` for at least `amount` of `token`, but only if the current allowance is
 * insufficient. Returns the approve TransactionResponse, or `null` if nothing needed to be sent —
 * so callers can safely call this before every write instead of hand-rolling the check-then-approve
 * dance themselves.
 */
export async function ensureAllowance(token: Address, spender: Address, amount: bigint, signer: Signer): Promise<TransactionResponse | null> {
  const owner = (await signer.getAddress()) as Address;
  const current = await getAllowance(token, owner, spender, signer);
  if (current >= amount) return null;
  return erc20(token, signer).approve(spender, amount);
}

// ---------------------------------------------------------------------------
// Transaction status tracking
// ---------------------------------------------------------------------------

export type TxStatus = "submitted" | "pending" | "confirmed" | "failed";

export interface TxStatusEvent {
  status: TxStatus;
  hash?: Hex;
  receipt?: TransactionReceipt;
  error?: unknown;
}

/**
 * Wraps a pending-or-already-sent transaction and reports each stage through `onStatus`:
 * "submitted" (have a TransactionResponse) -> "pending" (have a hash, waiting for confirmations)
 * -> "confirmed" (receipt with status 1) or "failed" (receipt with status 0, or the send/wait itself
 * threw). Resolves with the receipt on success, rejects with the original error on failure —
 * `onStatus` is a progress callback, not a substitute for the returned promise's own control flow.
 */
export async function trackTransaction(
  txOrPromise: TransactionResponse | Promise<TransactionResponse>,
  opts: { confirmations?: number; onStatus?: (event: TxStatusEvent) => void } = {},
): Promise<TransactionReceipt> {
  const { confirmations = 1, onStatus } = opts;
  let hash: Hex | undefined;
  try {
    const tx = await txOrPromise;
    hash = tx.hash as Hex;
    onStatus?.({ status: "submitted", hash });
    onStatus?.({ status: "pending", hash });
    const receipt = await tx.wait(confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${hash} reverted`);
    onStatus?.({ status: "confirmed", hash, receipt });
    return receipt;
  } catch (error) {
    onStatus?.({ status: "failed", hash, error });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

export interface DecodedEvent {
  name: string;
  args: Record<string, unknown>;
  logIndex: number;
}

/** Decodes every log in `receipt` that `contract`'s ABI recognizes; unrecognized logs (other contracts' events in the same tx) are skipped. */
export function parseEventLogs(contract: Contract, receipt: TransactionReceipt, eventNames?: string[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      if (eventNames && !eventNames.includes(parsed.name)) continue;
      out.push({ name: parsed.name, args: { ...parsed.args.toObject?.(), ...parsed.args }, logIndex: log.index });
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  return out;
}

/** Subscribes to a live contract event; returns an unsubscribe function. */
export function subscribeToEvent(contract: Contract, eventName: string, callback: (...args: unknown[]) => void): () => void {
  contract.on(eventName, callback);
  return () => {
    contract.off(eventName, callback);
  };
}

// ---------------------------------------------------------------------------
// Error decoding
// ---------------------------------------------------------------------------

/** Human-readable copy for the most common custom errors, shared across many contracts in this system. */
const ERROR_MESSAGES: Record<string, string> = {
  NotOwner: "You are not this vault's Owner.",
  NotCurator: "You are not this vault's Curator.",
  NotGuardian: "You are not this vault's Guardian.",
  NotAllocator: "You are not this vault's Allocator.",
  NotKeeper: "You are not an approved Keeper for this vault.",
  Unauthorized: "Your wallet is not authorized for this action.",
  VaultPausedError: "This vault is paused — adapter and vault actions are blocked until it's unpaused.",
  ZeroAddress: "A required address was left empty.",
  InsufficientAllowance: "Token allowance is too low — approve more first.",
  InsufficientBalance: "Balance is too low for this amount.",
};

export interface DecodedTxError {
  /** Custom error name if it could be decoded, else "UnknownError" / "Reverted" / "ProviderError". */
  name: string;
  args: unknown[];
  /** Human-readable message — from ERROR_MESSAGES if recognized, else the best available raw reason. */
  message: string;
  raw: unknown;
}

/**
 * Decodes a thrown ethers error into a custom-error name + args where possible. Tries `contracts`'
 * interfaces in order (pass every ABI you have in scope — e.g. `[sdk.vaultAt(vault), sdk.stateManager]`)
 * since a single tx can revert with any contract's custom error, not just the one you called.
 */
export function decodeError(error: unknown, contracts: Contract[] = []): DecodedTxError {
  const data = extractRevertData(error);
  if (data) {
    for (const contract of contracts) {
      try {
        const parsed = contract.interface.parseError(data);
        if (parsed) {
          return { name: parsed.name, args: [...parsed.args], message: ERROR_MESSAGES[parsed.name] ?? `${parsed.name}(${parsed.args.join(", ")})`, raw: error };
        }
      } catch {
        // this contract's ABI doesn't recognize the error — try the next one
      }
    }
  }
  const reason = (error as { reason?: string })?.reason;
  if (reason) return { name: "Reverted", args: [], message: reason, raw: error };
  const shortMessage = (error as { shortMessage?: string; message?: string })?.shortMessage ?? (error as { message?: string })?.message;
  return { name: "UnknownError", args: [], message: shortMessage ?? "Transaction failed for an unknown reason.", raw: error };
}

function extractRevertData(error: unknown): Hex | undefined {
  const e = error as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const candidate = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  return typeof candidate === "string" && candidate.startsWith("0x") ? (candidate as Hex) : undefined;
}
