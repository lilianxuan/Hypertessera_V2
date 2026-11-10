import type { InterfaceAbi } from "ethers";

// The ABI registry itself, isolated from both the Node loader (abis-node.ts) and the guarded
// auto-load orchestration (abis.ts) so neither of those can form an import cycle with this file.

export type ContractName =
  | "HyperAccessControl"
  | "VaultTimelock"
  | "AssetRegistry"
  | "RWAToken"
  | "NAVOracle"
  | "MintBurnController"
  | "StubStateManager"
  | "PoRRegistry"
  | "ReservePSM"
  | "WrappedAsset"
  | "Queue"
  | "RevenuePool"
  | "UnifiedPool"
  | "StateManager"
  | "EarnVault"
  | "LiquidityEarnVault"
  | "LiquidityBridge"
  | "VaultFactory"
  | "Settlement"
  | "AdapterFactory"
  | "FirstPeriodAdapter"
  | "LiquidityAdapter"
  | "RWAAdapter"
  | "KYTDepositGateway"
  | "ProtocolFeeConfig";

let registry: Record<string, InterfaceAbi> | undefined;

/** Registers the ABI bundle this process will use. Idempotent — last call wins. */
export function setAbis(data: Record<string, InterfaceAbi>): void {
  registry = data;
}

export function abisLoaded(): boolean {
  return registry !== undefined;
}

export function getAbi(name: ContractName): InterfaceAbi {
  if (!registry) {
    throw new Error(
      `ABIs not loaded. In Node this should have happened automatically (see abis-node.ts); ` +
        `in a browser bundle, call setAbis(abisJson) with an imported control-panel/abis.json before using the SDK.`,
    );
  }
  const abi = registry[name];
  if (!abi) throw new Error(`No ABI found for contract "${name}"`);
  return abi;
}
