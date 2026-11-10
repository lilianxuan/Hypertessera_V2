import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider } from "ethers";
import type { HyperTesseraAddresses } from "../../src/sdk.js";
import { loadWallets } from "./wallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDRESSES_PATH = join(__dirname, "..", "..", "local", "addresses.json");

interface RawLocalAddresses extends HyperTesseraAddresses {
  usdt: string;
  protocolTimelock: string;
  chainId: number;
  rpcUrl: string;
  assetRegistryModuleD: {
    stubStateManager: string;
    navOracleStub: string;
    demoRwaAdapter: string;
    sToken: string;
    jToken: string;
    sTokenAssetId: number;
    jTokenAssetId: number;
  };
}

export function loadLocalDeployment() {
  const raw = JSON.parse(readFileSync(ADDRESSES_PATH, "utf-8")) as RawLocalAddresses;
  const provider = new JsonRpcProvider(raw.rpcUrl, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
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
  };

  return { raw, addresses, provider, wallets };
}
