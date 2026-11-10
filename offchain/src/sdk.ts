import { Contract, getAddress, keccak256, ZeroAddress, type Provider, type Signer, type ContractRunner } from "ethers";
import { getAbi, type ContractName } from "./abis.js";
import type { ScreeningRequest, ScreeningState } from "./kytScreeningBot.js";
import type { DepositRecord, OnChainEventIndexer, VaultAssetLink } from "./indexer.js";
import {
  ProductState,
  DepositRequestState,
  RedeemRequestState,
  CycleState,
  PauseState,
  QueueType,
  AssetMode,
  FeePaymentKind,
  ActionClass,
  CreationFeeAction,
  SettlementMode,
  VaultRole,
  type Address,
  type Hex,
  type StateContext,
  type PriceData,
  type AssetInfo,
  type SettlementInstruction,
  type ProductParams,
  type VaultParams,
  type AdapterParams,
  type TransferPath,
  type ReserveProof,
  type ProductInfo,
} from "./types.js";

/** Every on-chain address the SDK needs, keyed by module (development-plan.md §2 module map). */
export interface HyperTesseraAddresses {
  hyperAccessControl: Address;
  stateManager: Address;
  navOracle: Address;
  mintBurnController: Address;
  assetRegistry: Address;
  reservePSM: Address;
  poRRegistry: Address;
  queue: Address;
  revenuePool: Address;
  unifiedPool: Address;
  settlement: Address;
  vaultFactory: Address;
  adapterFactory: Address;
  liquidityBridge: Address;
  cashVault: Address;
  noteVault: Address;
  lpVault: Address;
  cashAdapter: Address;
  noteAdapter: Address;
  lpAdapter: Address;
  rwaAdapter?: Address;
  protocolFeeConfig?: Address;
}

/** keccak256 of raw document bytes — used for `AssetRegistry.metadataHash` and `PoRRegistry.documentHash`. */
export function computeDocumentHash(documentBytes: Uint8Array): Hex {
  return keccak256(documentBytes) as Hex;
}

export type TrancheKey = "cash" | "note" | "lp";

export type VaultDepositRoute =
  | { mode: "direct"; vault: Address; asset: Address; gateway: null }
  | { mode: "kyt"; vault: Address; asset: Address; gateway: Address };

export type KytEvent =
  | { name: "ScreeningRequested"; screeningRequestId: bigint; payer: Address; owner: Address; assets: bigint; expiresAt: bigint }
  | { name: "DepositExecuted"; screeningRequestId: bigint; vaultRequestId: bigint; owner: Address; assets: bigint; screenedAt: bigint }
  | { name: "ScreeningRejected"; screeningRequestId: bigint; payer: Address; screenedAt: bigint; timestamp: bigint }
  | { name: "RequestCancelled"; screeningRequestId: bigint; payer: Address; timestamp: bigint };

type KytReceipt = { logs: readonly { address: string; topics: readonly string[]; data: string }[] };

/**
 * HyperTessera Earn TypeScript SDK (development-plan.md §3.1.2 W1 read/write methods, extended
 * through W2-W4 for the full on-chain surface). Wraps read-only view calls and role-gated writes;
 * callers supply their own signer for anything mutating (KeeperBot / SettlementOperator / Issuer /
 * Token Agent per the role table in development-plan.md §3.1.1).
 */
export class HyperTesseraSDK {
  readonly addresses: HyperTesseraAddresses;
  private readonly runner: ContractRunner;
  private readonly contractCache = new Map<string, Contract>();

  constructor(addresses: HyperTesseraAddresses, runner: ContractRunner) {
    this.addresses = addresses;
    this.runner = runner;
  }

  /** Returns a typed ethers Contract for any deployed module — full ABI access beyond the curated methods below. */
  getContract(name: ContractName, address: Address, runner: ContractRunner = this.runner): Contract {
    const key = `${name}:${address}:${runner === this.runner ? "default" : "custom"}`;
    if (runner === this.runner) {
      const cached = this.contractCache.get(key);
      if (cached) return cached;
    }
    const contract = new Contract(address, getAbi(name), runner);
    if (runner === this.runner) this.contractCache.set(key, contract);
    return contract;
  }

  // ---------------------------------------------------------------------
  // Module contract getters
  // ---------------------------------------------------------------------

  get hyperAccessControl(): Contract {
    return this.getContract("HyperAccessControl", this.addresses.hyperAccessControl);
  }
  get stateManager(): Contract {
    return this.getContract("StateManager", this.addresses.stateManager);
  }
  get navOracle(): Contract {
    return this.getContract("NAVOracle", this.addresses.navOracle);
  }
  get mintBurnController(): Contract {
    return this.getContract("MintBurnController", this.addresses.mintBurnController);
  }
  get assetRegistry(): Contract {
    return this.getContract("AssetRegistry", this.addresses.assetRegistry);
  }
  get reservePSM(): Contract {
    return this.getContract("ReservePSM", this.addresses.reservePSM);
  }
  get poRRegistry(): Contract {
    return this.getContract("PoRRegistry", this.addresses.poRRegistry);
  }
  get queue(): Contract {
    return this.getContract("Queue", this.addresses.queue);
  }
  get revenuePool(): Contract {
    return this.getContract("RevenuePool", this.addresses.revenuePool);
  }
  get unifiedPool(): Contract {
    return this.getContract("UnifiedPool", this.addresses.unifiedPool);
  }
  get settlement(): Contract {
    return this.getContract("Settlement", this.addresses.settlement);
  }
  get vaultFactory(): Contract {
    return this.getContract("VaultFactory", this.addresses.vaultFactory);
  }
  get adapterFactory(): Contract {
    return this.getContract("AdapterFactory", this.addresses.adapterFactory);
  }
  get liquidityBridge(): Contract {
    return this.getContract("LiquidityBridge", this.addresses.liquidityBridge);
  }
  get rwaAdapter(): Contract {
    return this.getContract("RWAAdapter", this.addresses.rwaAdapter!);
  }
  get protocolFeeConfig(): Contract {
    return this.getContract("ProtocolFeeConfig", this.addresses.protocolFeeConfig!);
  }

  /** Vault contract for a tranche — Cash/Note use `EarnVault`, LP uses `LiquidityEarnVault`. */
  vault(tranche: TrancheKey): Contract {
    const address =
      tranche === "cash" ? this.addresses.cashVault : tranche === "note" ? this.addresses.noteVault : this.addresses.lpVault;
    const abiName: ContractName = tranche === "lp" ? "LiquidityEarnVault" : "EarnVault";
    return this.getContract(abiName, address);
  }

  /** Adapter contract for a tranche — Cash/Note use `FirstPeriodAdapter`, LP uses `LiquidityAdapter`. */
  adapter(tranche: TrancheKey): Contract {
    const address =
      tranche === "cash" ? this.addresses.cashAdapter : tranche === "note" ? this.addresses.noteAdapter : this.addresses.lpAdapter;
    const abiName: ContractName = tranche === "lp" ? "LiquidityAdapter" : "FirstPeriodAdapter";
    return this.getContract(abiName, address);
  }

  vaultAddress(tranche: TrancheKey): Address {
    return tranche === "cash" ? this.addresses.cashVault : tranche === "note" ? this.addresses.noteVault : this.addresses.lpVault;
  }

  /**
   * Vault contract at an arbitrary address (e.g. one just created via `deployVault`, not yet a
   * known tranche). `IVaultRoles`/`VaultTimelock` targeting is identical for EarnVault and
   * LiquidityEarnVault, so the `EarnVault` ABI (a superset for that surface) is always safe here;
   * pass `"LiquidityEarnVault"` explicitly only when calling an LP-specific method like `setAdapter`.
   */
  vaultAt(address: Address, abiName: ContractName = "EarnVault"): Contract {
    return this.getContract(abiName, address);
  }

  /** Dynamic Gateway access; no per-product Gateway address book is required. */
  kytGatewayAt(address: Address): Contract {
    const gateway = getAddress(address);
    if (gateway === ZeroAddress) throw new Error("KYT Gateway cannot be the zero address");
    return this.getContract("KYTDepositGateway", gateway);
  }

  /** Read again before submitting. Unsupported/non-readable gates never fall back to direct deposits. */
  async getVaultDepositRoute(vault: Address): Promise<VaultDepositRoute> {
    const address = getAddress(vault);
    const contract = this.vaultAt(address);
    const [rawGate, rawAsset] = await Promise.all([contract.gate(), contract.usdt()]);
    const gate = getAddress(rawGate), asset = getAddress(rawAsset);
    if (asset === ZeroAddress) throw new Error("Vault settlement asset is not configured");
    if (gate === ZeroAddress) return { mode: "direct", vault: address, asset, gateway: null };
    const gateway = this.kytGatewayAt(gate);
    const [boundVault, boundAsset, oracle, validity] = await Promise.all([
      gateway.vault(), gateway.asset(), gateway.oracle(), gateway.validityPeriod(),
    ]);
    if (getAddress(boundVault) !== address || getAddress(boundAsset) !== asset) {
      throw new Error("KYT Gateway vault/asset binding mismatch");
    }
    if (getAddress(oracle) === ZeroAddress || BigInt(validity) < 300n || BigInt(validity) > 604800n) {
      throw new Error("Unsupported KYT Gateway configuration");
    }
    return { mode: "kyt", vault: address, asset, gateway: gate };
  }

  async getKytRequest(gateway: Address, id: bigint): Promise<ScreeningRequest> {
    const r = await this.kytGatewayAt(gateway).getRequest(id);
    const state = Number(r.state);
    if (!Number.isInteger(state) || state < 0 || state > 4) throw new Error("Unknown KYT request state");
    return { id, payer: getAddress(r.payer), owner: getAddress(r.owner), assets: BigInt(r.assets),
      requestedAt: BigInt(r.requestedAt), expiresAt: BigInt(r.expiresAt), state: state as ScreeningState };
  }

  /** Only logs emitted by this Gateway are accepted; Vault request IDs are a separate namespace. */
  parseKytEvents(gateway: Address, receipt: KytReceipt): KytEvent[] {
    const address = getAddress(gateway);
    const contract = this.kytGatewayAt(address);
    const events: KytEvent[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address.toLowerCase()) continue;
      let parsed;
      try { parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data }); }
      catch { continue; }
      if (!parsed) continue;
      const a = parsed.args;
      switch (parsed.name) {
        case "ScreeningRequested":
          events.push({ name: parsed.name, screeningRequestId: BigInt(a.id), payer: a.payer, owner: a.owner,
            assets: BigInt(a.assets), expiresAt: BigInt(a.expiresAt) }); break;
        case "DepositExecuted":
          events.push({ name: parsed.name, screeningRequestId: BigInt(a.id), vaultRequestId: BigInt(a.vaultRequestId),
            owner: a.owner, assets: BigInt(a.assets), screenedAt: BigInt(a.screenedAt) }); break;
        case "ScreeningRejected":
          events.push({ name: parsed.name, screeningRequestId: BigInt(a.id), payer: a.payer,
            screenedAt: BigInt(a.screenedAt), timestamp: BigInt(a.timestamp) }); break;
        case "RequestCancelled":
          events.push({ name: parsed.name, screeningRequestId: BigInt(a.id), payer: a.payer,
            timestamp: BigInt(a.timestamp) }); break;
      }
    }
    return events;
  }

  /** Registers screening only. Existing token/operator approvals are managed by the caller. */
  async requestKytDeposit(gateway: Address, assets: bigint, owner: Address, signer: Signer) {
    if (assets <= 0n || getAddress(owner) === ZeroAddress) throw new Error("Invalid KYT deposit amount/owner");
    if (this.runner.provider && signer.provider) {
      const [readNetwork, writeNetwork] = await Promise.all([
        this.runner.provider.getNetwork(), signer.provider.getNetwork(),
      ]);
      if (readNetwork.chainId !== writeNetwork.chainId) throw new Error("KYT signer network mismatch");
    }
    const contract = this.kytGatewayAt(gateway);
    const route = await this.getVaultDepositRoute(await contract.vault());
    if (route.mode !== "kyt" || route.gateway !== getAddress(gateway)) throw new Error("KYT Gateway is not the active Vault gate");
    const payer = getAddress(await signer.getAddress());
    const tx = await contract.connect(signer).getFunction("requestDeposit")(assets, owner);
    const receipt = await tx.wait();
    const requested = receipt ? this.parseKytEvents(gateway, receipt).filter(e => e.name === "ScreeningRequested") : [];
    const event = requested[0];
    if (requested.length !== 1 || !event || getAddress(event.payer) !== payer
      || getAddress(event.owner) !== getAddress(owner) || event.assets !== assets) {
      // The transaction may already be mined: preserve its hash and never auto-resubmit.
      throw Object.assign(new Error("KYT receipt could not be resolved; check the submitted transaction"),
        { code: "KYT_RECEIPT_UNRESOLVED", txHash: tx.hash });
    }
    return { hash: receipt.hash as Hex, receipt, screeningRequestId: event.screeningRequestId };
  }

  // ---------------------------------------------------------------------
  // Module A — read methods (development-plan.md §3.1.2)
  // ---------------------------------------------------------------------

  async getStateContext(vault: Address): Promise<StateContext> {
    const raw = await this.stateManager.getState(vault);
    return {
      product: Number(raw.product) as ProductState,
      cycle: Number(raw.cycle) as CycleState,
      pause: Number(raw.pause) as PauseState,
      cycleNumber: BigInt(raw.currentCycleNumber),
    };
  }

  /**
   * True once the product has reached its `maturityTimestamp`. Used by the KeeperBot to tell an
   * ordinary CALCULATING cycle apart from the FINAL one it must wait on
   * (一年期产品最终周期结算与产品参数调整说明 §7.3).
   */
  async isPastMaturity(vault: Address): Promise<boolean> {
    const params = await this.stateManager.getParams(vault);
    const block = await this.stateManager.runner!.provider!.getBlock("latest");
    return BigInt(block!.timestamp) >= BigInt(params.maturityTimestamp);
  }

  async isVaultRegistered(vault: Address): Promise<boolean> {
    return this.stateManager.isVaultRegistered(vault);
  }

  async isVaultActive(vault: Address): Promise<boolean> {
    const pause: bigint = await this.stateManager.getPauseState(vault);
    return Number(pause) === PauseState.ACTIVE;
  }

  // ---------------------------------------------------------------------
  // Module A — vault discovery (StateManager's on-chain vault index)
  // ---------------------------------------------------------------------
  // `VaultFactory.deployVault` is permissionless, so the vault set is not knowable from
  // `HyperTesseraAddresses`' configured tranches alone. StateManager indexes every registered
  // vault in registration order, so the full set is readable with eth_call — no log replay.

  /** Total vaults ever registered. */
  async vaultCount(): Promise<bigint> {
    return BigInt(await this.stateManager.vaultCount());
  }

  /**
   * The vault at `index` in registration order; reverts past the end. Named for its argument
   * because `vaultAt(address)` above already means "vault contract at this address".
   */
  async vaultAtIndex(index: bigint): Promise<Address> {
    return this.stateManager.vaultAt(index);
  }

  /**
   * One window of the vault index. Clamped on-chain rather than checked — an offset at or past the
   * end yields an empty array and an overlong limit a short page — so this pages without a
   * `vaultCount()` read first.
   */
  async vaultsPaged(offset: bigint, limit: bigint): Promise<Address[]> {
    return [...(await this.stateManager.vaultsPaged(offset, limit))];
  }

  /** Every registered vault, walked `pageSize` at a time. Bounded by `vaultCount()`, read once up front. */
  async getAllVaults(pageSize: number): Promise<Address[]> {
    const limit = toPageSize(pageSize);
    const count = await this.vaultCount();
    const vaults: Address[] = [];
    for (let offset = 0n; offset < count; offset += limit) {
      const page = await this.vaultsPaged(offset, limit);
      if (page.length === 0) break;
      vaults.push(...page);
    }
    return vaults;
  }

  /**
   * Within the `[offset, offset + limit)` window of the vault index, the vaults on which `account`
   * holds at least one vault-local role. Vaults where it holds none are omitted, so the result is
   * shorter than the window (empty for `account == ZeroAddress`). Five contract calls per vault in
   * the window — a paged scan, not an index, so keep `limit` modest.
   */
  async vaultsWithRole(account: Address, offset: bigint, limit: bigint): Promise<VaultRoleEntry[]> {
    const [vaults, roleMasks] = await this.stateManager.vaultsWithRole(account, offset, limit);
    return (vaults as Address[]).map((vault, i) => ({ vault, roleMask: Number(roleMasks[i]) }));
  }

  /** `vaultsWithRole` scanned across the whole index, `pageSize` vaults at a time. Bounded by `vaultCount()`. */
  async getAllVaultsWithRole(account: Address, pageSize: number): Promise<VaultRoleEntry[]> {
    const limit = toPageSize(pageSize);
    const count = await this.vaultCount();
    const entries: VaultRoleEntry[] = [];
    // Unlike getAllVaults there is no short-page signal to stop on — a window can legitimately
    // return nothing — so `count` is the only thing terminating this loop.
    for (let offset = 0n; offset < count; offset += limit) {
      entries.push(...(await this.vaultsWithRole(account, offset, limit)));
    }
    return entries;
  }

  async hasRole(role: Hex, account: Address): Promise<boolean> {
    return this.hyperAccessControl.hasRole(role, account);
  }

  async getNAV(rwaToken: Address): Promise<PriceData> {
    const raw = await this.navOracle.getPriceData(rwaToken);
    return { price: BigInt(raw.price), dataTimestamp: BigInt(raw.dataTimestamp), updatedAt: BigInt(raw.updatedAt) };
  }

  async getRWABalance(rwaToken: Address, account: Address): Promise<bigint> {
    const token = this.getContract("RWAToken", rwaToken);
    return BigInt(await token.balanceOf(account));
  }

  async getRWATotalSupply(rwaToken: Address): Promise<bigint> {
    const token = this.getContract("RWAToken", rwaToken);
    return BigInt(await token.totalSupply());
  }

  async getAssetInfo(assetId: bigint): Promise<AssetInfo> {
    const raw = await this.assetRegistry.getAsset(assetId);
    return {
      metadataHash: raw.metadataHash,
      token: raw.token,
      active: raw.active,
      registeredAt: BigInt(raw.registeredAt),
      owner: raw.owner,
    };
  }

  /** Off-chain pointer (IPFS/HTTPS) to the document `metadataHash` commits to; `""` when unset. */
  async metadataURIOf(assetId: bigint): Promise<string> {
    return this.assetRegistry.metadataURIOf(assetId);
  }

  /**
   * Answers "a user subscribed to this vault — what is actually underneath it?".
   *
   * `BaseVault` stores no assetId, so the vault -> asset edge exists only as the event/immutable
   * chain the indexer rebuilds (see `VaultAssetLink`); this method takes that reconstruction and
   * adds the two AssetRegistry reads that turn an assetId into displayable metadata. The relation
   * is 1:N — an EarnVault can hold up to `MAX_ADAPTERS` adapters — so the return is always a list.
   *
   * Same split as `getDepositRequest`: the indexer owns the reconstructed state and is passed in,
   * so the SDK stays a stateless contract wrapper and the sdk -> indexer dependency stays type-only.
   * Pass an indexer that has already `backfill()`ed over `vault`.
   */
  async getVaultAssets(vault: Address, indexer: OnChainEventIndexer): Promise<VaultAssetView[]> {
    return Promise.all(
      indexer.getVaultAssetLinks(vault).map(async (link) => {
        const [asset, metadataURI] = await Promise.all([this.getAssetInfo(link.assetId), this.metadataURIOf(link.assetId)]);
        return { ...link, asset, metadataURI };
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Module A — write methods (development-plan.md §3.1.2 — KeeperBot uses these)
  // ---------------------------------------------------------------------

  async openSubscription(vault: Address, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("openSubscription")(vault);
    return tx.wait();
  }
  async finalizeSubscription(vault: Address, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("finalizeSubscription")(vault);
    return tx.wait();
  }
  /**
   * ACCEPTING -> CALCULATING. Due either when `cycleDuration` has elapsed since the previous
   * cycle actually completed, or — for the product's FINAL cycle — as soon as
   * `maturityTimestamp` is reached, regardless of how much of the normal cycle has run. There is
   * no separate transition into SETTLING: the final cycle's `completeCycle` performs it
   * atomically (一年期产品最终周期结算与产品参数调整说明 §5).
   */
  /** True while a vault's FINAL cycle is running (product SETTLING, cycle CALCULATING). */
  async isFinalCycle(vault: Address): Promise<boolean> {
    return this.stateManager.isFinalCycle(vault);
  }

  /** The one price every remaining share is redeemed at after maturity; 0 until the final snapshot. */
  async finalSettlementPrice(vault: Address): Promise<bigint> {
    return BigInt(await this.vaultAt(vault).finalSettlementPrice());
  }

  /**
   * Burns `shares` at the frozen final price and pays the proceeds to `receiver`. The exit for
   * anyone still simply holding shares at maturity. Open from CLAIMING onward, including CLOSED.
   */
  async claimFinal(vault: Address, shares: bigint, owner: Address, receiver: Address, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("claimFinal")(shares, owner, receiver);
    return tx.wait();
  }

  async startCycleCalculation(vault: Address, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("startCycleCalculation")(vault);
    return tx.wait();
  }
  async enterClaiming(vault: Address, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("enterClaiming")(vault);
    return tx.wait();
  }
  async closeProduct(vault: Address, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("closeProduct")(vault);
    return tx.wait();
  }

  /** NAV signing service uses this. */
  async updateNAV(rwaToken: Address, price: bigint, dataTimestamp: bigint, sig: Hex, signer: Signer) {
    const tx = await this.navOracle.connect(signer).getFunction("updateNAV")(rwaToken, price, dataTimestamp, sig);
    return tx.wait();
  }

  /** Off-chain NAV signing service uses this to produce the `sig` argument for `updateNAV`. */
  async signNAVUpdate(rwaToken: Address, price: bigint, dataTimestamp: bigint, signer: Signer): Promise<Hex> {
    const domain = {
      name: "NAVOracle",
      version: "1",
      chainId: (await signer.provider!.getNetwork()).chainId,
      verifyingContract: await this.navOracle.getAddress(),
    };
    const types = {
      NAVUpdate: [
        { name: "rwaToken", type: "address" },
        { name: "price", type: "uint256" },
        { name: "dataTimestamp", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, { rwaToken, price, dataTimestamp }) as unknown as Promise<Hex>;
  }

  /** Caller must be that assetId's Issuer (its AssetRegistry owner). */
  async initiateMint(assetId: bigint, amount: bigint, to: Address, signer: Signer) {
    const tx = await this.mintBurnController.connect(signer).getFunction("initiateMint")(assetId, amount, to);
    const receipt = await tx.wait();
    return { txHash: receipt.hash as Hex, nonce: this.mintBurnController.interface.parseLog(receipt.logs[0])!.args.nonce as bigint };
  }
  /** Caller must be that assetId's Token Agent (see setTokenAgent). */
  async approveMint(nonce: bigint, signer: Signer) {
    const tx = await this.mintBurnController.connect(signer).getFunction("approveMint")(nonce);
    return tx.wait();
  }
  /** Caller must be that assetId's Issuer (its AssetRegistry owner). */
  async initiateBurn(assetId: bigint, amount: bigint, from: Address, signer: Signer) {
    const tx = await this.mintBurnController.connect(signer).getFunction("initiateBurn")(assetId, amount, from);
    const receipt = await tx.wait();
    return { txHash: receipt.hash as Hex, nonce: this.mintBurnController.interface.parseLog(receipt.logs[0])!.args.nonce as bigint };
  }
  /** Caller must be that assetId's Token Agent (see setTokenAgent). */
  async approveBurn(nonce: bigint, signer: Signer) {
    const tx = await this.mintBurnController.connect(signer).getFunction("approveBurn")(nonce);
    return tx.wait();
  }
  /** Appoints assetId's Token Agent. Caller must be that assetId's AssetRegistry owner. */
  async setTokenAgent(assetId: bigint, agent: Address, signer: Signer) {
    const tx = await this.mintBurnController.connect(signer).getFunction("setTokenAgent")(assetId, agent);
    return tx.wait();
  }

  /** Deploys a new RWAAdapter via AdapterFactory; returns the deployed adapter's address. */
  async deployRWAAdapter(
    params: { asset: Address; vault: Address; rwaToken: Address; navOracle: Address; dealDataStalenessWindow: bigint },
    signer: Signer,
  ): Promise<Address> {
    const tx = await this.adapterFactory.connect(signer).getFunction("deployRWAAdapter")(params);
    const receipt = await tx.wait();
    return parseAdapterAddress(this.adapterFactory, receipt);
  }

  // ---------------------------------------------------------------------
  // Module C — Settlement (development-plan.md §3.4.2, consumed by SettlementOperator)
  // ---------------------------------------------------------------------

  async hashInstruction(instruction: SettlementInstruction): Promise<Hex> {
    return this.settlement.hashInstruction(instructionToTuple(instruction));
  }



  async isOperator(vault: Address, account: Address): Promise<boolean> {
    return this.settlement.isOperator(vault, account);
  }

  async threshold(vault: Address): Promise<bigint> {
    return BigInt(await this.settlement.threshold(vault));
  }

  async isExecuted(batchHash: Hex): Promise<boolean> {
    return this.settlement.executed(batchHash);
  }

  async submitBatch(instruction: SettlementInstruction, signatures: Hex[], signer: Signer) {
    const tx = await this.settlement
      .connect(signer)
      .getFunction("submitBatch")(instructionToTuple(instruction), signatures);
    return tx.wait();
  }


  /** Caller must be `vault`'s own Owner. */
  async setSettlementOperator(vault: Address, operator: Address, approved: boolean, signer: Signer) {
    const tx = await this.settlement.connect(signer).getFunction("setOperator")(vault, operator, approved);
    return tx.wait();
  }

  /** Caller must be `vault`'s own Owner. */
  async setSettlementThreshold(vault: Address, newThreshold: bigint, signer: Signer) {
    const tx = await this.settlement.connect(signer).getFunction("setThreshold")(vault, newThreshold);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module C — UnifiedPool (Issuer / Operator funding paths; net settlement conversion, §8)
  // ---------------------------------------------------------------------

  async pending(vault: Address): Promise<bigint> {
    return BigInt(await this.unifiedPool.pending(vault));
  }

  async totalPending(): Promise<bigint> {
    return BigInt(await this.unifiedPool.totalPending());
  }

  async availableToDistribute(vault: Address): Promise<bigint> {
    return BigInt(await this.unifiedPool.availableToDistribute(vault));
  }

  /** Deposits into the unattributed interest pool — not yet credited to any vault's pending. */
  async repayInterest(amount: bigint, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("repayInterest")(amount);
    return tx.wait();
  }

  /** Deposits into the unattributed principal pool — not yet credited to any vault's pending. */
  async repayPrincipal(amount: bigint, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("repayPrincipal")(amount);
    return tx.wait();
  }

  /**
   * Caller must be `vault`'s Settlement Operator. Moves from the unattributed interest pool.
   * Since 审计反馈 V3 #1/#2 `vault` must also be on the Governor Vault whitelist and its current
   * `settlement()` on the Governor Settlement whitelist.
   */
  async attributeInterest(vault: Address, amount: bigint, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("attributeInterest")(vault, amount);
    return tx.wait();
  }

  /**
   * Caller must be `vault`'s Settlement Operator. Moves from the unattributed principal pool.
   * Same double whitelist gate as `attributeInterest` — it is what stops a permissionlessly
   * created Vault inflating its own pending, and so its share price, out of the open inflow pool.
   */
  async attributePrincipal(vault: Address, amount: bigint, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("attributePrincipal")(vault, amount);
    return tx.wait();
  }

  async receiveVaultPrincipal(amount: bigint, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("receiveVaultPrincipal")(amount);
    return tx.wait();
  }

  /**
   * Configure `vault` in the UnifiedPool so it can receive attributions and distributions.
   * Caller must be `vault`'s Owner. Tranche classification was removed on 2026-08-25 —
   * everything in the pool keys on the vault address alone.
   */
  async addVault(vault: Address, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("addVault")(vault);
    return tx.wait();
  }

  /**
   * Admit (or remove) `vault` from the shared pool. Caller must hold GOVERNOR_ROLE.
   *
   * `addVault` above is the Vault's own Owner opting in; this is the protocol permitting it.
   * `VaultFactory.deployVault` stays permissionless — being built from the standard contracts is
   * not an endorsement and must not by itself confer access to shared cash (审计反馈 V3 #1/#2).
   */
  async setVaultWhitelisted(vault: Address, allowed: boolean, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("setVaultWhitelisted")(vault, allowed);
    return tx.wait();
  }

  /**
   * Trust (or untrust) a Settlement contract for pool operations. Caller must hold GOVERNOR_ROLE.
   * Several addresses may be listed at once so a new Settlement rolls out alongside the old one.
   */
  async setSettlementWhitelisted(settlement: Address, allowed: boolean, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("setSettlementWhitelisted")(settlement, allowed);
    return tx.wait();
  }

  /** Recognise a PERMANENT loss on pool-managed assets. Caller must be `vault`'s VaultTimelock. */
  async writeDownPending(vault: Address, amount: bigint, referenceId: Hex, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("writeDownPending")(vault, amount, referenceId);
    return tx.wait();
  }

  /**
   * Caller must hold GOVERNOR_ROLE — moved off the Settlement Operator by 审计反馈 V3 #1.
   * This and `operatorTransferToRevenuePool` are the only paths that take cash out of the pool
   * without a matching ledger entry, so a stolen Operator key must not reach them. `vault` is
   * now purely the accounting reference the transfer is booked against.
   */
  async operatorTransfer(vault: Address, recipient: Address, amount: bigint, referenceId: Hex, signer: Signer) {
    const tx = await this.unifiedPool.connect(signer).getFunction("operatorTransfer")(vault, recipient, amount, referenceId);
    return tx.wait();
  }

  /** Caller must hold GOVERNOR_ROLE (审计反馈 V3 #1). */
  async operatorTransferToRevenuePool(vault: Address, revenuePool: Address, amount: bigint, referenceId: Hex, signer: Signer) {
    const tx = await this.unifiedPool
      .connect(signer)
      .getFunction("operatorTransferToRevenuePool")(vault, revenuePool, amount, referenceId);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module D — ReservePSM (Token Custody Mode / Document Proof Mode, §8)
  // ---------------------------------------------------------------------

  async deployWrappedToken(
    assetId: bigint,
    mode: AssetMode,
    underlyingToken: Address,
    name: string,
    symbol: string,
    decimals: number,
    allowPartialUnwrap: boolean,
    signer: Signer,
  ) {
    const tx = await this.reservePSM
      .connect(signer)
      .getFunction("deployWrappedToken")(assetId, mode, underlyingToken, name, symbol, decimals, allowPartialUnwrap);
    return tx.wait();
  }

  /** Token Custody Mode: locks the underlying 1:1 and mints wrapped tokens to `to`. */
  async wrap(assetId: bigint, amount: bigint, to: Address, signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("wrap")(assetId, amount, to);
    return tx.wait();
  }

  /** Document Proof Mode: signature-authorized mint, no on-chain token custody. */
  async mintWithAuthorization(
    assetId: bigint,
    amount: bigint,
    to: Address,
    nonce: bigint,
    expiry: bigint,
    signature: Hex,
    documentId: Hex,
    signer: Signer,
  ) {
    const tx = await this.reservePSM
      .connect(signer)
      .getFunction("mintWithAuthorization")(assetId, amount, to, nonce, expiry, signature, documentId);
    return tx.wait();
  }

  /** Unified unwrap entry — Token Custody releases the underlying 1:1; Document Proof only emits ReleaseRequested. */
  async unwrap(assetId: bigint, amount: bigint, to: Address, signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("unwrap")(assetId, amount, to);
    return tx.wait();
  }

  async wrappedTokenOf(assetId: bigint): Promise<Address> {
    return this.reservePSM.wrappedTokenOf(assetId);
  }

  // ---------------------------------------------------------------------
  // Module C — Queue (dual FIFO; also see OnChainEventIndexer.getClearingList) (§8)
  // ---------------------------------------------------------------------

  async queueDepth(vault: Address, queueType: QueueType): Promise<bigint> {
    return BigInt(await this.queue.depth(vault, queueType));
  }

  async isInQueue(vault: Address, queueType: QueueType, requestId: bigint): Promise<boolean> {
    return this.queue.isInQueue(vault, queueType, requestId);
  }

  // ---------------------------------------------------------------------
  // Module B — Vault deposit/redeem lifecycle (ERC-7540 async; per-tranche)
  // ---------------------------------------------------------------------

  async requestDeposit(tranche: TrancheKey, assets: bigint, owner: Address, signer: Signer): Promise<bigint> {
    const tx = await this.vault(tranche).connect(signer).getFunction("requestDeposit")(assets, owner);
    const receipt = await tx.wait();
    return parseRequestId(this.vault(tranche), receipt, "DepositRequested");
  }

  async claimDeposit(tranche: TrancheKey, requestId: bigint, receiver: Address, signer: Signer) {
    const tx = await this.vault(tranche).connect(signer).getFunction("claimDeposit")(requestId, receiver);
    return tx.wait();
  }

  async requestRedeem(tranche: TrancheKey, shares: bigint, owner: Address, signer: Signer): Promise<bigint> {
    const tx = await this.vault(tranche).connect(signer).getFunction("requestRedeem")(shares, owner);
    const receipt = await tx.wait();
    return parseRequestId(this.vault(tranche), receipt, "RedeemRequested");
  }

  /**
   * Pays out everything the redeem has been filled for and not yet claimed.
   *
   * Since 审计反馈 V3 #3 this accepts a partially-filled request that is still QUEUED, not only a
   * fully-filled SETTLED one. A solvent partial claim leaves the request queued at its original
   * FIFO position, so the same request can be filled and claimed repeatedly — do NOT treat one
   * successful call as the whole order being finished. After liquidation the payout also releases
   * the queue slot and returns the unfilled shares. Read `getRedeemRequest` for the amount
   * claimable now (`settledAssets`) and the amount still queued (`remainingShares`).
   */
  async claimRedeem(tranche: TrancheKey, requestId: bigint, receiver: Address, signer: Signer) {
    const tx = await this.vault(tranche).connect(signer).getFunction("claimRedeem")(requestId, receiver);
    return tx.wait();
  }

  async cancelRequest(tranche: TrancheKey, requestId: bigint, signer: Signer) {
    const tx = await this.vault(tranche).connect(signer).getFunction("cancelRequest")(requestId);
    return tx.wait();
  }

  async claimRefund(tranche: TrancheKey, requestId: bigint, signer: Signer) {
    const tx = await this.vault(tranche).connect(signer).getFunction("claimRefund")(requestId);
    return tx.wait();
  }

  /**
   * Reads one redeem request straight off the Vault.
   *
   * Added with 审计反馈 V3 #3, which makes "claimable" no longer inferable from the state alone:
   * a QUEUED request now holds a claimable balance whenever `settledAssets > 0`. Show a claim
   * action for `settledAssets`, show `remainingShares` as still queued, and keep displaying the
   * request as queued after a partial claim rather than treating it as finished. After
   * liquidation the same claim also returns `remainingShares` and exits the queue; a liquidated
   * request whose `settledAssets` is 0 exits via `cancelRequest`.
   */
  async getRedeemRequest(vault: Address, requestId: bigint): Promise<RedeemRequestView> {
    const raw = await this.vaultAt(vault).getRedeemRequest(requestId);
    return {
      requestId,
      owner: raw.owner,
      shares: raw.shares,
      remainingShares: raw.remainingShares,
      settledAssets: raw.settledAssets,
      cycleNumber: raw.cycleNumber,
      state: Number(raw.state) as RedeemRequestState,
    };
  }

  /**
   * Reconstructs one deposit request from indexed events. `BaseVault._depositRequests` is
   * `internal` and the contract exposes no per-request getter (only `nextRequestId()`), so the
   * event stream is the only read path — pass an `OnChainEventIndexer` that has already
   * backfilled (and, for a live UI, `start()`ed) over `vault`.
   *
   * The indexer is a parameter rather than SDK state so that the SDK stays a stateless contract
   * wrapper and the sdk -> indexer dependency stays type-only (the indexer already depends on the
   * SDK at runtime; holding a reference the other way would close that cycle).
   */
  async getDepositRequest(vault: Address, requestId: bigint, indexer: OnChainEventIndexer): Promise<DepositRequestView> {
    const record = indexer.getDepositRecord(vault, requestId);
    if (!record) {
      return {
        requestId,
        owner: ZeroAddress,
        assets: 0n,
        writtenDownHaircut: 0n,
        state: DepositRequestState.NONE,
      };
    }
    // Only needed to disambiguate REFUNDABLE (see isDepositRefundable), but the read is cheap and
    // keeps the resolver itself pure/synchronous.
    const { product } = await this.getStateContext(vault);
    return {
      requestId: record.requestId,
      owner: record.owner,
      assets: record.assets,
      writtenDownHaircut: record.writtenDownHaircut,
      settledAssets: record.settledAssets,
      refundedAssets: record.refundedAssets,
      settledCycleNumber: record.settledCycleNumber,
      blockNumber: record.blockNumber,
      state: resolveDepositRequestState(record, product),
    };
  }

  // ---------------------------------------------------------------------
  // Module F — Asset issuance & Vault creation (permissionless creator flows)
  // ---------------------------------------------------------------------

  /**
   * Permissionless; `msg.sender` becomes the asset's owner. `product.issuer` is ignored on input —
   * the contract forces it to `msg.sender`; pass any value (or `ZeroAddress`). Pass `value` for a
   * Native-rail creation fee.
   */
  async registerAsset(
    metadataHash: Hex,
    name: string,
    symbol: string,
    decimals: number,
    feeKind: FeePaymentKind,
    product: ProductInfo,
    signer: Signer,
    overrides: { value?: bigint } = {},
  ): Promise<{ assetId: bigint; token: Address }> {
    const tx = await this.assetRegistry
      .connect(signer)
      .getFunction("registerAsset")(metadataHash, name, symbol, decimals, feeKind, product, overrides);
    const receipt = await tx.wait();
    return parseAssetRegistered(this.assetRegistry, receipt);
  }

  /** On-chain product terms recorded at registration (zero-valued if the asset was never registered). */
  async getProductInfo(assetId: bigint): Promise<ProductInfo> {
    const raw = await this.assetRegistry.getProductInfo(assetId);
    return {
      productName: raw.productName,
      annualYieldRateBps: Number(raw.annualYieldRateBps),
      maturityTimestamp: BigInt(raw.maturityTimestamp),
      issuer: raw.issuer,
      underlyingAsset: raw.underlyingAsset,
    };
  }

  /** Permissionless; caller (or `params.owner`, if set) becomes the new vault's Owner. Pass `value` for a Native-rail creation fee. */
  async deployVault(params: VaultParams, signer: Signer, overrides: { value?: bigint } = {}): Promise<Address> {
    const tx = await this.vaultFactory.connect(signer).getFunction("deployVault")(params, overrides);
    const receipt = await tx.wait();
    return parseVaultDeployed(this.vaultFactory, receipt);
  }

  // ---------------------------------------------------------------------
  // Module F — Vault role configuration (IVaultRoles; Owner-only, direct, never via Timelock)
  // ---------------------------------------------------------------------

  async transferVaultOwnership(vault: Address, newOwner: Address, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("transferOwnership")(newOwner);
    return tx.wait();
  }
  async setCurator(vault: Address, account: Address, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("setCurator")(account);
    return tx.wait();
  }
  async setGuardian(vault: Address, account: Address, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("setGuardian")(account);
    return tx.wait();
  }
  async setAllocator(vault: Address, account: Address, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("setAllocator")(account);
    return tx.wait();
  }
  async setKeeper(vault: Address, account: Address, approved: boolean, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("setKeeper")(account, approved);
    return tx.wait();
  }

  /** ERC-7540 operator approval — lets `operator` call requestDeposit/requestRedeem/etc. on `owner`'s behalf. */
  async setVaultOperator(vault: Address, operator: Address, approved: boolean, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("setOperator")(operator, approved);
    return tx.wait();
  }
  async isVaultOperator(vault: Address, owner: Address, operator: Address): Promise<boolean> {
    return this.vaultAt(vault).isOperator(owner, operator);
  }

  // ---------------------------------------------------------------------
  // Module F — Product params (StateManager; Curator-only, CONFIGURING-only)
  // ---------------------------------------------------------------------

  async setProductParams(vault: Address, params: ProductParams, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("setProductParams")(vault, params);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module F — Adapter / module configuration
  // ---------------------------------------------------------------------

  /** Deploys a "FirstPeriodAdapter" (Cash/Note style) via AdapterFactory. Permissionless. */
  async deployAdapter(params: AdapterParams, signer: Signer): Promise<Address> {
    const tx = await this.adapterFactory.connect(signer).getFunction("deployAdapter")(params);
    const receipt = await tx.wait();
    return parseAdapterAddress(this.adapterFactory, receipt);
  }

  /** Deploys a LiquidityAdapter (LP style) via AdapterFactory. Permissionless. */
  async deployLiquidityAdapter(params: AdapterParams, signer: Signer): Promise<Address> {
    const tx = await this.adapterFactory.connect(signer).getFunction("deployLiquidityAdapter")(params);
    const receipt = await tx.wait();
    return parseAdapterAddress(this.adapterFactory, receipt);
  }

  /** Cash/Note (BaseVault) adapter attachment. Curator direct while CONFIGURING; Timelock-only after. AdapterRegistry is gone — the Curator adds any adapter directly. */
  async addAdapter(vault: Address, adapter: Address, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("addAdapter")(adapter);
    return tx.wait();
  }

  /** Pushes `assets` of the vault's free USDT into one of its already-attached adapters. Caller must be `vault`'s Allocator. */
  async fundAdapter(vault: Address, adapter: Address, assets: bigint, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("fundAdapter")(adapter, assets);
    return tx.wait();
  }

  /** Pulls `assets` of USDT back out of one of the vault's attached adapters. Caller must be `vault`'s Allocator. */
  async recallAdapter(vault: Address, adapter: Address, assets: bigint, signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("recallAdapter")(adapter, assets);
    return tx.wait();
  }

  /** LP (LiquidityEarnVault) adapter attachment — one-time only. Same Curator/Timelock gate as addAdapter. */
  async setLPAdapter(vault: Address, adapter: Address, signer: Signer) {
    const tx = await this.vaultAt(vault, "LiquidityEarnVault").connect(signer).getFunction("setAdapter")(adapter);
    return tx.wait();
  }

  /** LiquidityAdapter-only bootstrap step, not run by deployVault/addAdapter. Curator direct while CONFIGURING; Timelock-only after. */
  async setBridgeTarget(adapter: Address, liquidityBridge: Address, cashVault: Address, signer: Signer) {
    const tx = await this.getContract("LiquidityAdapter", adapter)
      .connect(signer)
      .getFunction("setBridgeTarget")(liquidityBridge, cashVault);
    return tx.wait();
  }

  /** Per-adapter, not global. Curator direct while that adapter's vault is CONFIGURING; Timelock-only after. */
  async setDataProvider(adapter: Address, provider: Address, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("setDataProvider")(provider);
    return tx.wait();
  }

  /** Same Curator/Timelock gate as setDataProvider. */
  async setAdapterStalenessWindow(adapter: Address, window: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("setStalenessWindow")(window);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module F — VaultTimelock (post-CONFIGURING parameter changes)
  // ---------------------------------------------------------------------

  async vaultTimelockAddress(vault: Address): Promise<Address> {
    return this.vaultAt(vault).vaultTimelock();
  }

  /** Caller must be that vault's Owner or Curator, and (target, data's selector) must already be whitelisted for their class. */
  async scheduleParamChange(timelock: Address, target: Address, data: Hex, signer: Signer): Promise<Hex> {
    const tx = await this.getContract("VaultTimelock", timelock).connect(signer).getFunction("scheduleParamChange")(target, data);
    const receipt = await tx.wait();
    return parseChangeScheduled(this.getContract("VaultTimelock", timelock), receipt);
  }

  /** Permissionless — callable by anyone once the delay has elapsed and before it expires. */
  async executeParamChange(timelock: Address, changeId: Hex, signer: Signer) {
    const tx = await this.getContract("VaultTimelock", timelock).connect(signer).getFunction("executeParamChange")(changeId);
    return tx.wait();
  }

  /** Caller must be that vault's Owner, Guardian, or the change's original proposer. */
  async cancelParamChange(timelock: Address, changeId: Hex, signer: Signer) {
    const tx = await this.getContract("VaultTimelock", timelock).connect(signer).getFunction("cancelParamChange")(changeId);
    return tx.wait();
  }

  /** Caller must be that vault's Owner, and only while it's still CONFIGURING (bootstrapping) — afterward this is self-scheduled only, via scheduleParamChange/executeParamChange against the Timelock itself. */
  async setAllowedAction(timelock: Address, target: Address, selector: Hex, actionClass: ActionClass, allowed: boolean, signer: Signer) {
    const tx = await this.getContract("VaultTimelock", timelock)
      .connect(signer)
      .getFunction("setAllowedAction")(target, selector, actionClass, allowed);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module G — AssetRegistry post-issuance management (asset owner only)
  // ---------------------------------------------------------------------

  async updateMetadataHash(assetId: bigint, newHash: Hex, signer: Signer) {
    const tx = await this.assetRegistry.connect(signer).getFunction("updateMetadataHash")(assetId, newHash);
    return tx.wait();
  }
  async transferAssetOwnership(assetId: bigint, newOwner: Address, signer: Signer) {
    const tx = await this.assetRegistry.connect(signer).getFunction("transferAssetOwnership")(assetId, newOwner);
    return tx.wait();
  }
  async deactivateAsset(assetId: bigint, signer: Signer) {
    const tx = await this.assetRegistry.connect(signer).getFunction("deactivateAsset")(assetId);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module G — RWAToken transfer compliance (that asset's Issuer / AssetRegistry owner)
  // ---------------------------------------------------------------------

  /** indexes[i] is set to (fromListIds[i], toListIds[i]); arrays must have equal length. */
  async setTransferPaths(rwaToken: Address, indexes: number[], fromListIds: number[], toListIds: number[], signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken)
      .connect(signer)
      .getFunction("setTransferPaths")(indexes, fromListIds, toListIds);
    return tx.wait();
  }
  async addToAddressList(rwaToken: Address, listId: number, accounts: Address[], signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken).connect(signer).getFunction("addToAddressList")(listId, accounts);
    return tx.wait();
  }
  async removeFromAddressList(rwaToken: Address, listId: number, accounts: Address[], signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken).connect(signer).getFunction("removeFromAddressList")(listId, accounts);
    return tx.wait();
  }
  async isInList(rwaToken: Address, listId: number, account: Address): Promise<boolean> {
    return this.getContract("RWAToken", rwaToken).isInList(listId, account);
  }
  async transferPathCount(rwaToken: Address): Promise<number> {
    return Number(await this.getContract("RWAToken", rwaToken).transferPathCount());
  }
  async getTransferPath(rwaToken: Address, index: number): Promise<TransferPath> {
    const raw = await this.getContract("RWAToken", rwaToken).transferPaths(index);
    return { fromListId: Number(raw.fromListId), toListId: Number(raw.toListId) };
  }

  /** Toggle whitelist admission checks. Default false (open). */
  async setWhitelistEnabled(rwaToken: Address, enabled: boolean, signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken).connect(signer).getFunction("setWhitelistEnabled")(enabled);
    return tx.wait();
  }
  /** Toggle transfer path direction checks. Default false (open). */
  async setTransferPathEnabled(rwaToken: Address, enabled: boolean, signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken).connect(signer).getFunction("setTransferPathEnabled")(enabled);
    return tx.wait();
  }
  async addToWhitelist(rwaToken: Address, accounts: Address[], signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken).connect(signer).getFunction("addToWhitelist")(accounts);
    return tx.wait();
  }
  async removeFromWhitelist(rwaToken: Address, accounts: Address[], signer: Signer) {
    const tx = await this.getContract("RWAToken", rwaToken).connect(signer).getFunction("removeFromWhitelist")(accounts);
    return tx.wait();
  }
  async isWhitelisted(rwaToken: Address, account: Address): Promise<boolean> {
    return this.getContract("RWAToken", rwaToken).isWhitelisted(account);
  }
  async whitelistEnabled(rwaToken: Address): Promise<boolean> {
    return this.getContract("RWAToken", rwaToken).whitelistEnabled();
  }
  async transferPathEnabled(rwaToken: Address): Promise<boolean> {
    return this.getContract("RWAToken", rwaToken).transferPathEnabled();
  }

  // ---------------------------------------------------------------------
  // Module G — PoRRegistry (append-only; that asset's Issuer or their delegated Proof Publisher)
  // ---------------------------------------------------------------------

  async setProofPublisher(assetId: bigint, publisher: Address, signer: Signer) {
    const tx = await this.poRRegistry.connect(signer).getFunction("setProofPublisher")(assetId, publisher);
    return tx.wait();
  }
  async publishReserveProof(assetId: bigint, documentHash: Hex, uri: string, signer: Signer) {
    const tx = await this.poRRegistry.connect(signer).getFunction("publishReserveProof")(assetId, documentHash, uri);
    return tx.wait();
  }
  async proofPublisherOf(assetId: bigint): Promise<Address> {
    return this.poRRegistry.proofPublisherOf(assetId);
  }
  async getProofCount(assetId: bigint): Promise<bigint> {
    return BigInt(await this.poRRegistry.getProofCount(assetId));
  }
  async getProof(assetId: bigint, index: bigint): Promise<ReserveProof> {
    const raw = await this.poRRegistry.getProof(assetId, index);
    return { documentHash: raw.documentHash, uri: raw.uri, publishedAt: BigInt(raw.publishedAt), publisher: raw.publisher };
  }
  async getLatestProof(assetId: bigint): Promise<ReserveProof> {
    const raw = await this.poRRegistry.getLatestProof(assetId);
    return { documentHash: raw.documentHash, uri: raw.uri, publishedAt: BigInt(raw.publishedAt), publisher: raw.publisher };
  }

  // ---------------------------------------------------------------------
  // Module G — NAVOracle administration (Oracle Owner)
  // ---------------------------------------------------------------------

  async setNAVSigner(rwaToken: Address, navSigner: Address, signer: Signer) {
    const tx = await this.navOracle.connect(signer).getFunction("setSigner")(rwaToken, navSigner);
    return tx.wait();
  }
  async removeNAVSigner(rwaToken: Address, signer: Signer) {
    const tx = await this.navOracle.connect(signer).getFunction("removeSigner")(rwaToken);
    return tx.wait();
  }
  async transferNAVOracleOwnership(newOwner: Address, signer: Signer) {
    const tx = await this.navOracle.connect(signer).getFunction("transferOwnership")(newOwner);
    return tx.wait();
  }
  async setNAVDeviationMaxBps(newBps: bigint, signer: Signer) {
    const tx = await this.navOracle.connect(signer).getFunction("setNAVDeviationMaxBps")(newBps);
    return tx.wait();
  }
  async navSignerOf(rwaToken: Address): Promise<Address> {
    return this.navOracle.signerOf(rwaToken);
  }
  async navOracleOwner(): Promise<Address> {
    return this.navOracle.owner();
  }
  async navDeviationMaxBps(): Promise<bigint> {
    return BigInt(await this.navOracle.navDeviationMaxBps());
  }

  // ---------------------------------------------------------------------
  // Module G — ReservePSM administration
  // ---------------------------------------------------------------------

  /** Caller must be that assetId's Wrapper Controller. DOCUMENT_PROOF assets only. */
  async setPSMAuthorizedSigner(assetId: bigint, authorizedSigner: Address, signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("setAuthorizedSigner")(assetId, authorizedSigner);
    return tx.wait();
  }
  /** Caller must hold GOVERNOR_ROLE. Pauses/unpauses the whole ReservePSM. */
  async pauseReservePSM(signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("pause")();
    return tx.wait();
  }
  async unpauseReservePSM(signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("unpause")();
    return tx.wait();
  }
  /** Caller must be that assetId's Wrapper Controller. */
  async pauseAsset(assetId: bigint, signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("pauseAsset")(assetId);
    return tx.wait();
  }
  async unpauseAsset(assetId: bigint, signer: Signer) {
    const tx = await this.reservePSM.connect(signer).getFunction("unpauseAsset")(assetId);
    return tx.wait();
  }
  async wrapperControllerOf(assetId: bigint): Promise<Address> {
    return this.reservePSM.controllerOf(assetId);
  }

  // ---------------------------------------------------------------------
  // Module G — ProtocolFeeConfig (reads price registerAsset/deployVault; writes are Governor-only)
  // ---------------------------------------------------------------------

  async creationFeeOf(action: CreationFeeAction, kind: FeePaymentKind): Promise<bigint> {
    return BigInt(await this.protocolFeeConfig.feeOf(action, kind));
  }
  async paymentTokenOf(kind: FeePaymentKind): Promise<Address> {
    return this.protocolFeeConfig.paymentTokenOf(kind);
  }
  async feeRevenuePool(): Promise<Address> {
    return this.protocolFeeConfig.revenuePool();
  }

  /** Governor-only. Sets the creation fee charged for `action` when paid on the `kind` rail. */
  async setCreationFee(action: CreationFeeAction, kind: FeePaymentKind, amount: bigint, signer: Signer) {
    const tx = await this.protocolFeeConfig.connect(signer).getFunction("setFee")(action, kind, amount);
    return tx.wait();
  }

  /** Governor-only. Sets the ERC-20 charged on the `kind` rail; reverts for `FeePaymentKind.Native`. */
  async setFeePaymentToken(kind: FeePaymentKind, token: Address, signer: Signer) {
    const tx = await this.protocolFeeConfig.connect(signer).getFunction("setPaymentToken")(kind, token);
    return tx.wait();
  }

  /** Governor-only. Sets the pool that collected creation fees are directed to. */
  async setFeeRevenuePool(pool: Address, signer: Signer) {
    const tx = await this.protocolFeeConfig.connect(signer).getFunction("setRevenuePool")(pool);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module G — StateManager vault pause (Guardian pauses; Owner lifts)
  // ---------------------------------------------------------------------

  async pauseVault(vault: Address, reason: PauseState, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("pause")(vault, reason);
    return tx.wait();
  }
  async unpauseVault(vault: Address, signer: Signer) {
    const tx = await this.stateManager.connect(signer).getFunction("unpause")(vault);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module G — Adapter order book (Curator creates/cancels; Allocator executes; Guardian freezes)
  // ---------------------------------------------------------------------

  async createBuyOrder(adapter: Address, amount: bigint, destination: Address, mode: SettlementMode, signer: Signer): Promise<bigint> {
    const tx = await this.getContract("FirstPeriodAdapter", adapter)
      .connect(signer)
      .getFunction("createBuyOrder")(amount, destination, mode);
    const receipt = await tx.wait();
    return parseOrderId(this.getContract("FirstPeriodAdapter", adapter), receipt, "BuyOrderCreated");
  }
  /**
   * Authorise an asset exit and the proceeds expected for it. Caller must be this Adapter's
   * Vault's Curator.
   *
   * Replaces the old `createSellOrder(amount)`, which never sold anything: it pulled the proceeds
   * out of the Allocator's own wallet, so a human role sat in the custody path and had to hold and
   * approve the money, and it recorded neither what was exited nor from which position — so
   * `dealValue` never fell and the returned cash could be counted on top of the original
   * valuation. It also replaces the RWA Withdraw and Rebalance order books, both removed.
   *
   * Flow: create -> the counterparty calls `fundSellOrder` -> the Allocator calls `executeSell`.
   *
   * @param exitAsset          Token to hand over, or `ZeroAddress` for a position with no on-chain
   *                           token (a VALUE_RETURN deal), where only `dealValue` moves.
   * @param dealValueReduction `dealValue` written off on execution; capped by what other
   *                           outstanding Sell Orders have not already reserved.
   * @param expiry             Unix seconds, must be in the future. Past it the order cannot
   *                           execute and the payer can refund themselves.
   */
  async createSellOrder(
    adapter: Address,
    params: {
      exitAsset: Address;
      exitAmount: bigint;
      proceeds: bigint;
      payer: Address;
      assetRecipient: Address;
      dealKey: bigint;
      hasDeal: boolean;
      dealValueReduction: bigint;
      expiry: bigint;
    },
    signer: Signer,
  ): Promise<bigint> {
    const tx = await this.getContract("FirstPeriodAdapter", adapter)
      .connect(signer)
      .getFunction("createSellOrder")(
      params.exitAsset,
      params.exitAmount,
      params.proceeds,
      params.payer,
      params.assetRecipient,
      params.dealKey,
      params.hasDeal,
      params.dealValueReduction,
      params.expiry,
    );
    const receipt = await tx.wait();
    return parseOrderId(this.getContract("FirstPeriodAdapter", adapter), receipt, "SellOrderCreated");
  }

  /**
   * Pay a Sell Order's proceeds. Caller must be the order's declared `payer`, and must have
   * approved the Adapter for `proceeds` of its `asset()` first.
   *
   * The counterparty pays the Adapter directly — the Allocator is not in the custody path. A plain
   * ERC-20 transfer carries no order id and cannot be matched, so this is the only way an order
   * becomes FUNDED.
   */
  async fundSellOrder(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("fundSellOrder")(orderId);
    return tx.wait();
  }

  /**
   * Reclaim the proceeds of a funded order that expired unexecuted. Caller must be its payer.
   *
   * Deliberately not gated on the Curator or Allocator: a counterparty who has paid must be able
   * to get their money back without depending on the party that failed to deliver. Works while the
   * Vault is paused.
   */
  async refundSellOrder(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("refundSellOrder")(orderId);
    return tx.wait();
  }

  /** Amount of `token` spoken for by Sell Orders that have not settled yet. */
  async reservedExitAmount(adapter: Address, token: Address): Promise<bigint> {
    return BigInt(await this.getContract("FirstPeriodAdapter", adapter).reservedExitAmount(token));
  }

  /** `dealValue` spoken for by Sell Orders that have not settled yet. */
  async reservedDealValue(adapter: Address, dealKey: bigint): Promise<bigint> {
    return BigInt(await this.getContract("FirstPeriodAdapter", adapter).reservedDealValue(dealKey));
  }

  /**
   * Proceeds received and held for FUNDED orders. Excluded from `realAssets()` and from what
   * `recallAdapter` may take — the counterparty's money is not the Vault's until the exit asset
   * has actually been delivered.
   */
  async lockedProceeds(adapter: Address): Promise<bigint> {
    return BigInt(await this.getContract("FirstPeriodAdapter", adapter).lockedProceeds());
  }

  /**
   * Allow or disallow `token` as a Sell Order exit asset on a FirstPeriodAdapter. Curator-class:
   * direct while the Vault is CONFIGURING, via its VaultTimelock afterwards.
   *
   * An explicit allowlist rather than "any token": a Sell Order must never become a way to move an
   * arbitrary token out of an Adapter. RWAAdapter needs no equivalent — it is bound to one token
   * at construction; LiquidityAdapter declares none, so only token-free (Deal-only) exits work
   * against it.
   */
  async setExitableAsset(adapter: Address, token: Address, allowed: boolean, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter)
      .connect(signer)
      .getFunction("setExitableAsset")(token, allowed);
    return tx.wait();
  }

  async cancelBuyOrder(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("cancelBuyOrder")(orderId);
    return tx.wait();
  }
  /**
   * Withdraw a Sell Order. Caller must be this Adapter's Vault's Curator or Guardian.
   *
   * A CREATED order just releases its reservations. A FUNDED order can never be cancelled while
   * keeping the counterparty's money — it refunds the payer and ends REFUNDED. Works while the
   * Vault is paused.
   */
  async cancelSellOrder(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("cancelSellOrder")(orderId);
    return tx.wait();
  }
  async executeBuy(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("executeBuy")(orderId);
    return tx.wait();
  }
  /**
   * Deliver a FUNDED, unexpired Sell Order's exit asset. Caller must be this Adapter's Vault's
   * Allocator. Reduces the linked `dealValue` and/or moves the token out in the same call, so the
   * exited value can never be counted twice, and frees the proceeds as ordinary Adapter capital.
   */
  async executeSell(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("executeSell")(orderId);
    return tx.wait();
  }
  /** Caller must be this adapter's vault's Guardian. Halts Allocator execution only — Curator order creation is unaffected. */
  async freezeAllocator(adapter: Address, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("freezeAllocator")();
    return tx.wait();
  }
  /** Caller must be this adapter's vault's Curator. */
  async unfreezeAllocator(adapter: Address, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("unfreezeAllocator")();
    return tx.wait();
  }
  async allocatorFrozen(adapter: Address): Promise<boolean> {
    return this.getContract("FirstPeriodAdapter", adapter).allocatorFrozen();
  }
  async realAssets(adapter: Address): Promise<bigint> {
    return BigInt(await this.getContract("FirstPeriodAdapter", adapter).realAssets());
  }
  /** VALUE_RETURN orders only. Caller must be this adapter's Data Provider. */
  async updateDealData(adapter: Address, orderId: bigint, newValue: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("updateDealData")(orderId, newValue);
    return tx.wait();
  }
  /** TOKEN_RETURN orders only, once the target token has actually been delivered. Caller must be this adapter's Allocator. */
  async clearDealValue(adapter: Address, orderId: bigint, signer: Signer) {
    const tx = await this.getContract("FirstPeriodAdapter", adapter).connect(signer).getFunction("clearDealValue")(orderId);
    return tx.wait();
  }

  // ---------------------------------------------------------------------
  // Module G — Vault refund handling (Curator marks refundable after FUNDING_FAILED)
  // ---------------------------------------------------------------------

  async markRefundable(vault: Address, requestIds: bigint[], signer: Signer) {
    const tx = await this.vaultAt(vault).connect(signer).getFunction("markRefundable")(requestIds);
    return tx.wait();
  }
}

/** Event-reconstructed view of a single deposit request — the return of `getDepositRequest`. */
export interface DepositRequestView {
  requestId: bigint;
  /** `ZeroAddress` when `state` is NONE. */
  owner: Address;
  /** Current principal, i.e. the amount a refund would pay out — already net of any write-down. */
  assets: bigint;
  state: DepositRequestState;
  /** Cumulative `RequestWrittenDown` haircut already deducted from `assets`. */
  writtenDownHaircut: bigint;
  /** Present from SETTLED onward. */
  settledAssets?: bigint;
  /** Partial-settlement remainder returned to the owner during `settle()` — not the FUNDING_FAILED refund. */
  refundedAssets?: bigint;
  settledCycleNumber?: bigint;
  blockNumber?: number;
}

/**
 * On-chain view of a single redeem request — the return of `getRedeemRequest`.
 *
 * `state` alone no longer tells you whether anything is claimable: since 审计反馈 V3 #3 a QUEUED
 * request holds a claimable balance whenever `settledAssets > 0`, and claiming it leaves the
 * request QUEUED for `remainingShares` unless the Vault has been liquidated.
 */
export interface RedeemRequestView {
  requestId: bigint;
  /** `ZeroAddress` when `state` is NONE. */
  owner: Address;
  /** Originally requested shares; immutable after creation. */
  shares: bigint;
  /** Shares still queued and unfilled. */
  remainingShares: bigint;
  /** Filled and owed but not yet claimed — the amount `claimRedeem` would pay out right now. */
  settledAssets: bigint;
  /** Cycle of the most recent partial or final fill. */
  cycleNumber: bigint;
  state: RedeemRequestState;
}

/** One hit from `vaultsWithRole` — a vault plus which vault-local roles the queried account holds on it. */
export interface VaultRoleEntry {
  vault: Address;
  /** Bitmask; bit `1 << VaultRole.X` is set when the account holds role X. Decode with `hasVaultRole`. */
  roleMask: number;
}

/** Whether `roleMask` (from `vaultsWithRole`) carries `role`. */
export function hasVaultRole(roleMask: number, role: VaultRole): boolean {
  return (roleMask & (1 << role)) !== 0;
}

/** Guards the auto-paging walks: a non-positive page size would never advance their offset. */
function toPageSize(pageSize: number): bigint {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error(`page size must be a positive integer, got ${pageSize}`);
  return BigInt(pageSize);
}

/** One `vault -> adapter -> rwaToken -> assetId` hop with its asset metadata — `getVaultAssets`'s element type. */
export interface VaultAssetView extends VaultAssetLink {
  /** `AssetRegistry.getAsset(assetId)` — `active: false` once the issuer has deactivated the asset. */
  asset: AssetInfo;
  /** `AssetRegistry.metadataURIOf(assetId)` — `""` when the asset owner has never set one. */
  metadataURI: string;
}

/**
 * REFUNDABLE has no event of its own. `BaseVault.markRefundable()` flips PENDING -> REFUNDABLE and
 * calls `Queue.remove(vault, DEPOSIT, id)`, but emits nothing on the vault itself, so the only
 * on-chain trace is the queue's `RequestCancelledFromQueue(vault, DEPOSIT, id)`.
 *
 * That event alone is ambiguous: `cancelRequest()` removes from the same queue. The two are told
 * apart by what else was emitted — `cancelRequest()` additionally emits
 * `BaseVault.RequestCancelled(id)`, `markRefundable()` does not. Settlement leaves the FIFO via
 * `Queue.dequeue` (`RequestDequeued`), never `remove`, so a settled request never lands here.
 * Requiring FUNDING_FAILED is what makes the inference safe: `markRefundable()` reverts in any
 * other product state, so outside FUNDING_FAILED a DEPOSIT-side `remove` can only be a cancel.
 *
 * When BaseVault starts emitting a dedicated event for this transition, index it onto
 * `DepositRecord` and reduce this function to reading that flag — `resolveDepositRequestState`
 * and `getDepositRequest` do not need to change.
 */
export function isDepositRefundable(record: DepositRecord, product: ProductState): boolean {
  return product === ProductState.FUNDING_FAILED && record.removedFromQueue && !record.cancelled && !record.settled;
}

/**
 * Folds an indexed `DepositRecord` down to the on-chain `DepositRequestState`. Ordered
 * terminal-first, since the flags are cumulative (a CLAIMED request also has `settled` set).
 */
export function resolveDepositRequestState(record: DepositRecord, product: ProductState): DepositRequestState {
  if (record.refunded) return DepositRequestState.REFUNDED;
  if (record.claimed) return DepositRequestState.CLAIMED;
  if (record.cancelled) return DepositRequestState.CANCELLED;
  if (record.settled) return DepositRequestState.SETTLED;
  if (isDepositRefundable(record, product)) return DepositRequestState.REFUNDABLE;
  return DepositRequestState.PENDING;
}

function instructionToTuple(instruction: SettlementInstruction) {
  return {
    vaultSettlements: instruction.vaultSettlements.map((vs) => ({
      distribution: vs.distribution,
      deposits: vs.deposits.map((d) => ({ requestId: d.requestId, settleAmount: d.settleAmount })),
      redeems: vs.redeems.map((r) => ({ requestId: r.requestId, settleAmount: r.settleAmount })),
    })),
    cycleNumber: instruction.cycleNumber,
    validUntil: instruction.validUntil,
  };
}

async function parseRequestId(contract: Contract, receipt: { logs: readonly { topics: readonly string[]; data: string }[] }, eventName: string): Promise<bigint> {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log as { topics: string[]; data: string });
      if (parsed?.name === eventName) return BigInt(parsed.args.requestId);
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  throw new Error(`${eventName} not found in transaction receipt`);
}

function parseAdapterAddress(contract: Contract, receipt: { logs: readonly { topics: readonly string[]; data: string }[] }): Address {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log as { topics: string[]; data: string });
      if (parsed?.name === "AdapterDeployed") return parsed.args.adapter as Address;
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  throw new Error("AdapterDeployed not found in transaction receipt");
}

function parseAssetRegistered(
  contract: Contract,
  receipt: { logs: readonly { topics: readonly string[]; data: string }[] },
): { assetId: bigint; token: Address } {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log as { topics: string[]; data: string });
      if (parsed?.name === "AssetRegistered") return { assetId: BigInt(parsed.args.assetId), token: parsed.args.token as Address };
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  throw new Error("AssetRegistered not found in transaction receipt");
}

function parseVaultDeployed(contract: Contract, receipt: { logs: readonly { topics: readonly string[]; data: string }[] }): Address {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log as { topics: string[]; data: string });
      if (parsed?.name === "VaultDeployed") return parsed.args.vault as Address;
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  throw new Error("VaultDeployed not found in transaction receipt");
}

function parseChangeScheduled(contract: Contract, receipt: { logs: readonly { topics: readonly string[]; data: string }[] }): Hex {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log as { topics: string[]; data: string });
      if (parsed?.name === "ParamChangeScheduled") return parsed.args.changeId as Hex;
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  throw new Error("ParamChangeScheduled not found in transaction receipt");
}

function parseOrderId(
  contract: Contract,
  receipt: { logs: readonly { topics: readonly string[]; data: string }[] },
  eventName: string,
): bigint {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log as { topics: string[]; data: string });
      if (parsed?.name === eventName) return BigInt(parsed.args.orderId);
    } catch {
      // not a log this interface recognizes — skip
    }
  }
  throw new Error(`${eventName} not found in transaction receipt`);
}

export type { Provider, Signer };
