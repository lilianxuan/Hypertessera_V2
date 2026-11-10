// Shared TypeScript types for HyperTessera Module E.
// Enum numeric values mirror src/libs/Types.sol exactly — do not reorder.
// (development-plan.md §3.1.2, §3.3.1)

export type Address = string;
export type Hex = string;

export enum ProductState {
  CONFIGURING = 0,
  SUBSCRIBING = 1,
  FUNDING_FAILED = 2,
  OPERATING = 3,
  SETTLING = 4,
  MATURING = 5,
  CLAIMING = 6,
  CLOSED = 7,
}

/** BaseVault deposit request lifecycle — mirrors `DepositRequestState` in src/libs/Types.sol. */
export enum DepositRequestState {
  NONE = 0,
  PENDING = 1,
  SETTLED = 2,
  CLAIMED = 3,
  REFUNDABLE = 4,
  REFUNDED = 5,
  CANCELLED = 6,
}

/** BaseVault redeem request lifecycle — mirrors `RedeemRequestState` in src/libs/Types.sol. */
export enum RedeemRequestState {
  NONE = 0,
  QUEUED = 1,
  CANCELLED = 2,
  SETTLED = 3,
  CLAIMED = 4,
}

export enum CycleState {
  ACCEPTING = 0,
  CALCULATING = 1,
  FULFILLING = 2,
  COMPLETED = 3,
}

export enum PauseState {
  ACTIVE = 0,
  PAUSED_BY_GUARDIAN = 1,
  PAUSED_BY_GOVERNOR = 2,
}

export enum ModuleId {
  CASH_VAULT = 0,
  NOTE_VAULT = 1,
  LP_VAULT = 2,
  SETTLEMENT = 3,
  PSM_POOL = 4,
  TOKENIZATION = 5,
  REWARD = 6,
  CLAIM_REGISTRY = 7,
}

/**
 * Bit positions of the vault-local roles in the mask `StateManager.vaultsWithRole` returns —
 * a mask has bit `1 << VaultRole.X` set when the queried account holds role X on that vault.
 */
export enum VaultRole {
  OWNER = 0,
  CURATOR = 1,
  GUARDIAN = 2,
  ALLOCATOR = 3,
  KEEPER = 4,
}

export enum SettlementMode {
  TOKEN_RETURN = 0,
  VALUE_RETURN = 1,
}

/** Queue.sol's dual-FIFO dimension (net settlement conversion, development-plan.md §8). */
export enum QueueType {
  DEPOSIT = 0,
  REDEEM = 1,
}

export enum AssetMode {
  TOKEN_CUSTODY = 0,
  DOCUMENT_PROOF = 1,
}

/** Protocol creation-fee rail (registerAsset / deployVault). Native = chain gas token; the other two are Governor-configured ERC-20s. */
export enum FeePaymentKind {
  Native = 0,
  Governance = 1,
  Stable = 2,
}

/** VaultFactory.deployVault's vault kind — Cash vs Note tranches are both EARN, distinguished only by whether liquidityBridge is set. */
export enum VaultType {
  EARN = 0,
  LP = 1,
}

/** VaultTimelock.setAllowedAction's whitelist class — which role's setters a (target, selector) pair belongs to. */
export enum ActionClass {
  OWNER = 0,
  CURATOR = 1,
}

/** Which protocol creation-fee ProtocolFeeConfig.feeOf/AssetRegistry/VaultFactory are gating. */
export enum CreationFeeAction {
  RegisterAsset = 0,
  DeployVault = 1,
}

export interface StateContext {
  product: ProductState;
  cycle: CycleState;
  pause: PauseState;
  cycleNumber: bigint;
}

export interface PriceData {
  price: bigint; // 1e18-scale: value of 1 whole rwaToken, denominated in 1 whole asset unit
  dataTimestamp: bigint;
  updatedAt: bigint;
}

/** RWAToken.setTransferPaths — addresses in fromListId may send to addresses in toListId. */
export interface TransferPath {
  fromListId: number;
  toListId: number;
}

/** PoRRegistry.getProof/getLatestProof. */
export interface ReserveProof {
  documentHash: Hex;
  uri: string;
  publishedAt: bigint;
  publisher: Address;
}

export interface AssetInfo {
  metadataHash: Hex;
  token: Address;
  active: boolean;
  registeredAt: bigint;
  owner: Address;
}

/**
 * AssetRegistry.registerAsset's 6th parameter / getProductInfo's return — on-chain product terms
 * recorded at registration. `issuer` is ignored on input; the contract forces it to msg.sender.
 */
export interface ProductInfo {
  productName: string;
  annualYieldRateBps: number; // 500 == 5.00% APY
  maturityTimestamp: bigint; // Unix seconds
  issuer: Address; // ignored on input — forced to msg.sender
  underlyingAsset: string;
}

/** StateManager.setProductParams — must be set by the vault's Curator while it's still CONFIGURING. */
export interface ProductParams {
  subscriptionStart: bigint;
  subscriptionEnd: bigint;
  walletSubscriptionCap: bigint; // per-wallet cap in USDT (6-dec); 0 = uncapped
  minRaiseAmount: bigint;
  subscriptionCapShare: bigint; // vault share-supply cap after settlement; 0 = unlimited
  cycleDuration: bigint; // seconds
  maturityTimestamp: bigint;
  claimingStart: bigint;
  claimingEnd: bigint; // closeProduct() gate
  feeParams: bigint;
}

/** VaultFactory.deployVault's params — deploying is permissionless; owner defaults to msg.sender when zero. */
export interface VaultParams {
  vaultType: VaultType;
  name: string;
  symbol: string;
  usdt: Address;
  stateManager: Address;
  settlement: Address; // address(0) until wired post-deploy
  queue: Address;
  owner: Address; // address(0) => msg.sender becomes Owner
  liquidityBridge: Address; // address(0) for a Note-style EARN vault
  cashVault: Address; // LP vaults only
  feeKind: FeePaymentKind;
}

/** AdapterFactory.deployAdapter / deployLiquidityAdapter params. */
export interface AdapterParams {
  asset: Address; // USDT
  vault: Address; // EarnVault this adapter serves
  stalenessWindow: bigint; // pendingDeposits staleness window; default 36h
}

export interface Distribution {
  vault: Address;
  amount: bigint;
}

export interface RequestSettlement {
  requestId: bigint;
  settleAmount: bigint; // assets for a deposit, shares for a redeem
}

/**
 * Net settlement (development-plan.md §8): redeem payouts and share pricing are computed
 * entirely on-chain by BaseVault from its own per-cycle price snapshot — there is no
 * off-chain-supplied redeemAmounts/navSnapshot/lpBonus.
 */
export interface VaultSettlement {
  distribution: Distribution; // distribution.amount == poolDistributedAssets
  deposits: RequestSettlement[];
  redeems: RequestSettlement[];
}

export interface SettlementInstruction {
  vaultSettlements: VaultSettlement[];
  cycleNumber: bigint;
  validUntil: bigint;
}
