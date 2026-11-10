import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider } from "ethers";
import type { HyperTesseraAddresses } from "../../src/sdk.js";
import { loadWallets } from "./wallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDRESSES_PATH = join(__dirname, "addresses.bscTestnet.json");

/**
 * Shape of addresses.bscTestnet.json — the deployed HyperTessera target generation on BNB Testnet
 * (chainId 97), plus the two contracts that are not part of `HyperTesseraAddresses`
 * (protocolFeeConfig, usdt).
 */
export interface RawTestnetAddresses extends HyperTesseraAddresses {
  chainId: number;
  rpcUrl: string;
  protocolFeeConfig: string;
  usdt: string;
}

export function loadTestnetDeployment() {
  const raw = JSON.parse(readFileSync(ADDRESSES_PATH, "utf-8")) as RawTestnetAddresses;
  const rpcUrl = process.env.BSC_TESTNET_RPC?.trim() || raw.rpcUrl;
  const provider = new JsonRpcProvider(rpcUrl, raw.chainId, { batchMaxCount: 1, cacheTimeout: -1 });
  const wallets = loadWallets(provider);

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

  return { raw, addresses, provider, wallets };
}
