// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBaseVault} from "../../interfaces/IBaseVault.sol";
import {IStateManager} from "../../interfaces/IStateManager.sol";
import {IQueue} from "../../interfaces/IQueue.sol";
import {IGate} from "../../interfaces/IGate.sol";
import {IUnifiedPool} from "../../interfaces/IUnifiedPool.sol";
import {ISettlement} from "../../interfaces/ISettlement.sol";
import {IAdapter} from "../../interfaces/IAdapter.sol";
import {IVaultRoles} from "../../interfaces/IVaultRoles.sol";
import {IHyperAccessControl} from "../../interfaces/IHyperAccessControl.sol";
import {IClaimRegistry} from "../../interfaces/IClaimRegistry.sol";
import {CycleState, ProductState, QueueType, DepositRequestState, RedeemRequestState, RequestSettlement} from "../../libs/Types.sol";

/// @title BaseVault
/// @notice Abstract ERC-4626 + ERC-7540 async vault base shared by all HyperTessera tranches.
///         Each vault is its own ERC-20 share token. Subscribe/redeem are two-step async:
///         request → settlement → claim. Share mint/burn is settlement-gated.
///
///         Net settlement: deposits and redeems are FIFO-queued (Queue.sol, dual DEPOSIT/REDEEM
///         queues) and settled against a per-cycle `CycleSnapshot` price computed on-chain from
///         `totalAssets()/totalSupply()` — there is no external NAVOracle write path. A
///         Morpho-style performance fee (shares minted against a High-Water Mark) accrues once
///         per cycle in `snapshotSettlementPrice`. (development-plan §3.3.1, §8)
abstract contract BaseVault is IBaseVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // ERC-20 share token
    // -----------------------------------------------------------------------

    string public name;
    string public symbol;
    uint8  public constant decimals = 18;

    uint256 private _totalShares;
    mapping(address => uint256) private _shareBalance;
    mapping(address => mapping(address => uint256)) private _shareAllowance;

    // -----------------------------------------------------------------------
    // ERC-7540 request tracking
    // -----------------------------------------------------------------------

    struct DepositRequestInternal {
        address owner;
        uint256 assets;
        uint256 settledShares;
        uint256 cycleNumber;
        DepositRequestState state;
    }

    struct RedeemRequestInternal {
        address owner;
        uint256 shares;            // ORIGINAL requested shares — immutable after creation
        uint256 remainingShares;   // shares not yet paid; starts == shares, decremented per partial fill
        uint256 settledAssets;     // USDT already filled and owed, MINUS whatever has been claimed:
                                   // accrues on each partial fill, reset to 0 on each claimRedeem.
                                   // Was cumulative-and-never-reset until 审计反馈 V3 #3 made a
                                   // partially-filled request claimable while it is still queued.
        uint256 cycleNumber;       // cycle of the most recent (partial or final) settlement
        RedeemRequestState state;
    }

    mapping(uint256 => DepositRequestInternal) internal _depositRequests;
    mapping(uint256 => RedeemRequestInternal)  internal _redeemRequests;
    uint256 public nextRequestId;

    // -----------------------------------------------------------------------
    // Overdue claim registration (Audit Feedback V2 #11)
    // -----------------------------------------------------------------------

    /// @notice ClaimRegistry receiving this Vault's overdue-claim records, or 0 while unwired.
    /// @dev    Wired post-deploy like `settlement` / `unifiedPool` rather than through the
    ///         constructor: ClaimRegistry is deployed alongside StateManager in W3, before the
    ///         Vaults exist, and threading it through `VaultFactory.DeployParams` would break that
    ///         ABI again for a bookkeeping hook.
    address public claimRegistry;

    /// @notice Grace period after `maturityTimestamp` before an unclaimed request may be recorded.
    uint256 public claimGracePeriod;

    /// @notice Requests already pushed to ClaimRegistry — prevents duplicate records.
    mapping(uint256 requestId => bool) public claimRecorded;

    // ERC-7540 operator approval
    mapping(address => mapping(address => bool)) private _operators;

    // -----------------------------------------------------------------------
    // Liability accounting (net settlement)
    // -----------------------------------------------------------------------

    uint256 public pendingDepositLiability;
    mapping(address => uint256) public pendingDepositByOwner;
    uint256 public reservedRedeemLiability;
    uint256 public refundableLiability;

    // -----------------------------------------------------------------------
    // Adapter aggregation + UnifiedPool
    // -----------------------------------------------------------------------

    address public override unifiedPool;
    address[] public adapters;
    mapping(address => bool) public override isAdapter;
    uint256 public constant MAX_ADAPTERS = 16;

    // -----------------------------------------------------------------------
    // Subscription cap
    // -----------------------------------------------------------------------

    /// @notice Maximum subscription quota this vault may have outstanding, in share units.
    ///         0 = unlimited. Denominated in shares, so NAV growth never consumes headroom.
    uint256 public subscriptionCapShare;

    /// @notice Quota actually consumed: shares minted for real subscriptions, less shares burned
    ///         by real redemptions. This — not `totalSupply()` — is what `subscriptionCapShare`
    ///         limits (净募集额度修改方案 §2).
    ///
    ///         `totalSupply()` also carries performance-fee shares, which arrive with no new
    ///         money behind them; charging them against the raise ceiling would shrink the
    ///         product's real capacity every time it performed well. So the fee mint in
    ///         `snapshotSettlementPrice` deliberately does not touch this, while every burn does
    ///         release quota — fee shares included, once their holder actually redeems them.
    ///
    ///         Never reset per cycle. Deliberately `internal` with no setter, event, or getter:
    ///         the vault's runtime bytecode is close enough to the EIP-170 ceiling that the
    ///         accessor surface was not worth its bytes. It moves only through settlement
    ///         (`_applyCapUsage`) and the LiquidityBridge sync mint.
    uint256 internal subscriptionCapUsedShares;

    // -----------------------------------------------------------------------
    // Performance fee (Morpho-style, High-Water Mark)
    // -----------------------------------------------------------------------

    uint16  public performanceFeeBps;
    address public performanceFeeRecipient;
    uint256 public feeHighWaterMark; // 1e18-scale price
    uint16  public constant MAX_PERFORMANCE_FEE_BPS = 10_000;

    address public revenuePool;
    uint16  public protocolFeeShareBps;

    mapping(uint256 => CycleSnapshot) public cycleSnapshots;

    /// @notice The one price every remaining share is redeemed at after maturity, frozen by the
    ///         final cycle's snapshot. 0 until that snapshot is taken.
    /// @dev    `claimFinal` reads this and never re-values, so nothing after the final cycle —
    ///         MATURING, CLAIMING or CLOSED — can change what a holder is owed
    ///         (最终周期结算及最终兑付补充修改方案 §六.4, §十一.3).
    uint256 public finalSettlementPrice;

    /// @notice Set once a `writeDownInsolvency` liquidation has been executed; never cleared.
    /// @dev    From then on the vault only unwinds: no new subscription, redemption, settlement
    ///         or capital deployment, and no `claimFinal` — assets could not even cover the fixed
    ///         claims, so shares have nothing left to distribute. Cancelling a PENDING
    ///         subscription, claiming a refund, claiming an already-settled (now haircut)
    ///         redemption, recovering `remainingShares`, and pulling assets back from Adapters or
    ///         the UnifiedPool all stay open (0826 writeDownInsolvency 最小化修改方案 §七).
    bool public insolvencyLiquidated;

    // -----------------------------------------------------------------------
    // Protocol wiring
    // -----------------------------------------------------------------------

    address public usdt;

    /// @notice Price of one whole share (1e18 share units) at 1:1 parity with the settlement
    ///         token, i.e. `10 ** IERC20Metadata(usdt).decimals()`.
    /// @dev    Every price in this contract is "settlement-token units per 1e18 shares", so the
    ///         parity price is not a constant: it is 1e6 for a 6-decimal USDT and 1e18 for an
    ///         18-decimal one (BSC mainnet USDT 0x55d3…7955 is 18-decimal). Hardcoding 1e6 priced
    ///         the first share of an 18-decimal vault at one-trillionth of a token.
    ///
    ///         Written once in the constructor and never again — logically immutable, but held in
    ///         storage rather than as an `immutable`: EarnVaultDeployer sits ~300 bytes under the
    ///         EIP-170 ceiling, and the code the compiler emits to splice an immutable into the
    ///         runtime at each read site costs more than those bytes. Every read is on a
    ///         `totalSupply == 0` branch, so the extra SLOAD is off the hot path.
    uint256 public parityPrice;
    address public override stateManager;
    address public override settlement;
    address public queue;
    address public gate; // address(0) = open

    // -----------------------------------------------------------------------
    // Vault-local roles (IVaultRoles) — appointed by Owner, independent per Vault
    // -----------------------------------------------------------------------

    address public override owner;
    address public override curator;
    address public override guardian;
    address public override allocator;
    mapping(address => bool) private _keepers;

    /// @notice Bound once by VaultFactory in the same deploy transaction; never rebindable.
    address public override vaultTimelock;

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(
        string memory name_,
        string memory symbol_,
        address usdt_,
        address stateManager_,
        address queue_,
        address owner_
    ) {
        if (usdt_ == address(0) || stateManager_ == address(0) ||
            queue_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        name         = name_;
        symbol       = symbol_;
        usdt         = usdt_;
        stateManager = stateManager_;
        queue        = queue_;
        owner        = owner_;
        nextRequestId = 1;

        parityPrice  = 10 ** IERC20Metadata(usdt_).decimals();

        // Seeded at the 1 settlement-token : 1 share reference price. Left at 0, a first snapshot taken when
        // the vault already holds shares — reachable via a LiquidityBridge mint, or an LP-first
        // cycle-0 batch — would read the entire NAV as profit and mint a performance fee against
        // all of it, diluting the earliest depositors (Audit Feedback V2 #5).
        feeHighWaterMark = parityPrice;
    }

    /// @notice One-time wiring of this Vault's VaultTimelock, called by VaultFactory in the same
    ///         transaction that constructs this Vault (VaultTimelock's own constructor needs this
    ///         Vault's address, so it cannot be a constructor arg here).
    /// @dev Gated to the one VaultFactory wired into StateManager, not merely to "not yet bound".
    ///      The design assumes the factory binds in the same transaction that deploys the Vault,
    ///      but the function must not depend on that being atomic: any non-atomic deploy window
    ///      would otherwise let anyone front-run the bind with a timelock they control and take
    ///      over the Vault's governance (审计反馈 2026-08-17 #9).
    function bindGovernance(address vaultTimelock_) external override {
        if (msg.sender != IStateManager(stateManager).vaultFactory()) revert Unauthorized();
        if (vaultTimelock != address(0)) revert GovernanceAlreadyBound();
        if (vaultTimelock_ == address(0)) revert ZeroAddress();
        vaultTimelock = vaultTimelock_;
    }

    // -----------------------------------------------------------------------
    // Modifiers / internal auth helpers
    // -----------------------------------------------------------------------

    modifier onlySettlementContract() {
        if (msg.sender != settlement) revert OnlySettlement(msg.sender);
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert Unauthorized();
    }

    function _onlyKeeper() internal view {
        if (!_keepers[msg.sender]) revert Unauthorized();
    }

    function _onlyCurator() internal view {
        if (msg.sender != curator) revert Unauthorized();
    }

    function _onlyGovernor() internal view {
        address ac = IStateManager(stateManager).accessControl();
        bytes32 role = IHyperAccessControl(ac).GOVERNOR_ROLE();
        if (!IHyperAccessControl(ac).hasRole(role, msg.sender)) revert Unauthorized();
    }

    /// @dev The vault-level circuit breaker. Applied to every path that moves value out of the
    ///      Vault or moves shares between holders, not just to new requests: a Guardian pause is
    ///      meant to be an emergency freeze, and a freeze that still lets settled redemptions,
    ///      refunds, cancellations, principal return and share transfers through does not stop
    ///      withdrawals against a price the Guardian believes to be wrong
    ///      (审计反馈 2026-08-17 #4).
    function _requireActive() internal view {
        IStateManager(stateManager).requireActive(address(this));
    }

    function _isConfiguring() internal view returns (bool) {
        return IStateManager(stateManager).getProductState(address(this)) == ProductState.CONFIGURING;
    }

    /// @notice Direct Owner call while CONFIGURING (initial setup); VaultTimelock-only afterward.
    function _onlyOwnerDirectOrTimelock() internal view {
        if (_isConfiguring()) {
            if (msg.sender != owner) revert Unauthorized();
        } else {
            if (msg.sender != vaultTimelock) revert Unauthorized();
        }
    }

    /// @notice Direct Curator call while CONFIGURING (initial setup); VaultTimelock-only afterward.
    function _onlyCuratorDirectOrTimelock() internal view {
        if (_isConfiguring()) {
            if (msg.sender != curator) revert Unauthorized();
        } else {
            if (msg.sender != vaultTimelock) revert Unauthorized();
        }
    }

    // -----------------------------------------------------------------------
    // IVaultRoles
    // -----------------------------------------------------------------------

    /// @inheritdoc IVaultRoles
    function isKeeper(address account) external view override returns (bool) {
        return _keepers[account];
    }

    /// @inheritdoc IVaultRoles
    function transferOwnership(address newOwner) external override {
        _onlyOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnerTransferred(address(this), old, newOwner, block.timestamp);
    }

    /// @inheritdoc IVaultRoles
    function setCurator(address account) external override {
        _onlyOwner();
        address old = curator;
        curator = account;
        emit CuratorSet(address(this), old, account, block.timestamp);
    }

    /// @inheritdoc IVaultRoles
    function setGuardian(address account) external override {
        _onlyOwner();
        address old = guardian;
        guardian = account;
        emit GuardianSet(address(this), old, account, block.timestamp);
    }

    /// @inheritdoc IVaultRoles
    function setAllocator(address account) external override {
        _onlyOwner();
        address old = allocator;
        allocator = account;
        emit AllocatorSet(address(this), old, account, block.timestamp);
    }

    /// @inheritdoc IVaultRoles
    function setKeeper(address account, bool approved) external override {
        _onlyOwner();
        _keepers[account] = approved;
        emit KeeperSet(address(this), account, approved, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // ERC-20 surface
    // -----------------------------------------------------------------------

    function totalSupply() external view returns (uint256) { return _totalShares; }
    function balanceOf(address account) external view returns (uint256) { return _shareBalance[account]; }
    function allowance(address owner, address spender) external view returns (uint256) {
        return _shareAllowance[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _shareAllowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transferShares(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _shareAllowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(from, msg.sender, allowed, amount);
            _shareAllowance[from][msg.sender] = allowed - amount;
        }
        _transferShares(from, to, amount);
        return true;
    }

    function _transferShares(address from, address to, uint256 amount) internal {
        _requireActive();
        if (_shareBalance[from] < amount) revert InsufficientShares(from, _shareBalance[from], amount);
        _shareBalance[from] -= amount;
        _shareBalance[to]   += amount;
        emit Transfer(from, to, amount);
    }

    function _mintShares(address to, uint256 amount) internal {
        _shareBalance[to] += amount;
        _totalShares      += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burnShares(address from, uint256 amount) internal {
        if (_shareBalance[from] < amount) revert InsufficientShares(from, _shareBalance[from], amount);
        _shareBalance[from] -= amount;
        _totalShares        -= amount;
        emit Transfer(from, address(0), amount);
    }

    // ERC-20 events (declared here for completeness; emitted in helpers)
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requested);

    // -----------------------------------------------------------------------
    // ERC-4626 read surface — dynamic pricing
    // -----------------------------------------------------------------------

    /// @notice Vault USDT balance + UnifiedPool receivable + Σ Adapter.realAssets().
    function grossManagedAssets() public view returns (uint256 total) {
        total = IERC20(usdt).balanceOf(address(this));
        if (unifiedPool != address(0)) {
            total += IUnifiedPool(unifiedPool).pending(address(this));
        }
        for (uint256 i = 0; i < adapters.length; i++) {
            total += IAdapter(adapters[i]).realAssets();
        }
    }

    /// @notice Share-holder net assets: grossManagedAssets minus all outstanding liabilities.
    function totalAssets() public view virtual returns (uint256) {
        uint256 gross = grossManagedAssets();
        uint256 liabilities = pendingDepositLiability + reservedRedeemLiability + refundableLiability;
        if (gross < liabilities) revert AccountingInsolvent();
        return gross - liabilities;
    }

    /// @notice Vault USDT balance not already earmarked for pending deposits, reserved
    ///         redeems, or refunds. Single canonical view — no before/after variants.
    function freeVaultUSDT() public view returns (uint256) {
        uint256 balance = IERC20(usdt).balanceOf(address(this));
        uint256 liabilities = pendingDepositLiability + reservedRedeemLiability + refundableLiability;
        if (balance < liabilities) revert AccountingInsolvent();
        return balance - liabilities;
    }

    function _pricePerShare() internal view returns (uint256) {
        uint256 supply = _totalShares;
        if (supply == 0) return parityPrice;
        return Math.mulDiv(totalAssets(), 1e18, supply);
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, 1e18, _pricePerShare());
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, _pricePerShare(), 1e18);
    }

    // -----------------------------------------------------------------------
    // ERC-7540 operator
    // -----------------------------------------------------------------------

    function setOperator(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
    }

    function isOperator(address owner, address operator) external view returns (bool) {
        return _operators[owner][operator];
    }

    function _checkOwnerOrOperator(address owner) internal view {
        if (msg.sender != owner && !_operators[owner][msg.sender]) {
            revert NotOwnerOrOperator(msg.sender, owner);
        }
    }

    // -----------------------------------------------------------------------
    // ERC-7540 lifecycle
    // -----------------------------------------------------------------------

    function requestDeposit(uint256 assets, address owner) external virtual nonReentrant returns (uint256 requestId) {
        if (assets == 0) revert ZeroAssets();
        if (insolvencyLiquidated) revert VaultLiquidated(); // no new subscriptions after liquidation
        _checkOwnerOrOperator(owner);

        // KYT gate
        if (gate != address(0) && !IGate(gate).isAllowed(owner)) revert GateBlocked(owner);

        // State check — delegate to StateManager
        IStateManager(stateManager).requireSubscribable(address(this));

        // Cap checks — delegate to StateManager (reverts on violation)
        IStateManager(stateManager).recordSubscription(address(this), owner, assets);

        // Pull USDT
        IERC20(usdt).safeTransferFrom(msg.sender, address(this), assets);

        requestId = nextRequestId++;
        uint256 cn = IStateManager(stateManager).currentCycleNumber(address(this));
        _depositRequests[requestId] = DepositRequestInternal({
            owner:         owner,
            assets:        assets,
            settledShares: 0,
            cycleNumber:   cn,
            state:         DepositRequestState.PENDING
        });

        pendingDepositLiability += assets;
        pendingDepositByOwner[owner] += assets;

        IQueue(queue).enqueue(address(this), QueueType.DEPOSIT, requestId, owner, assets);

        emit DepositRequested(requestId, owner, assets, block.timestamp);
    }

    function claimDeposit(uint256 requestId, address receiver) external virtual nonReentrant returns (uint256 shares) {
        DepositRequestInternal storage req = _depositRequests[requestId];
        if (req.owner == address(0)) revert RequestNotFound(requestId);
        _checkOwnerOrOperator(req.owner);
        if (req.state != DepositRequestState.SETTLED) revert RequestNotSettled(requestId);

        shares = req.settledShares;
        req.state = DepositRequestState.CLAIMED;

        _transferShares(address(this), receiver, shares);

        emit DepositClaimed(requestId, receiver, shares, block.timestamp);
    }

    function requestRedeem(uint256 shares, address owner) external virtual nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();
        if (insolvencyLiquidated) revert VaultLiquidated(); // no new redemptions after liquidation
        _checkOwnerOrOperator(owner);

        IStateManager(stateManager).requireOperable(address(this));

        // Lock shares in vault
        _transferShares(owner, address(this), shares);

        requestId = nextRequestId++;
        uint256 cn = IStateManager(stateManager).currentCycleNumber(address(this));

        _redeemRequests[requestId] = RedeemRequestInternal({
            owner:           owner,
            shares:          shares,
            remainingShares: shares,
            settledAssets:   0,
            cycleNumber:     cn,
            state:           RedeemRequestState.QUEUED
        });

        IQueue(queue).enqueue(address(this), QueueType.REDEEM, requestId, owner, shares);

        emit RedeemRequested(requestId, owner, shares, block.timestamp);
    }

    /// @dev Unwinds a PENDING deposit: liability, per-owner tally, queue slot, and the
    ///      StateManager subscription allowance all have to move together, and the USDT goes
    ///      straight back to the owner. Pushing is safe here because the only caller is
    ///      `cancelRequest`: it is owner-initiated and single-request, so a token that rejects
    ///      the transfer only fails the caller's own call.
    function _unwindPendingDeposit(uint256 requestId, DepositRequestInternal storage dep) internal {
        uint256 assets = dep.assets;
        address o = dep.owner;
        pendingDepositLiability -= assets;
        pendingDepositByOwner[o] -= assets;
        IQueue(queue).remove(address(this), QueueType.DEPOSIT, requestId);
        IStateManager(stateManager).releaseSubscription(address(this), o, assets);
        dep.state = DepositRequestState.CANCELLED;
        IERC20(usdt).safeTransfer(o, assets);
    }

    /// @dev Unwinds a QUEUED redeem, returning only the shares the vault still holds on its
    ///      behalf. A partially-filled request already had its filled portion burned and its USDT
    ///      reserved in a prior settle(), so it is promoted to SETTLED rather than CANCELLED —
    ///      claimRedeem only accepts SETTLED, and marking it CANCELLED would strand that USDT
    ///      permanently.
    function _unwindQueuedRedeem(uint256 requestId, RedeemRequestInternal storage red) internal {
        uint256 returned = red.remainingShares;
        red.remainingShares = 0;
        red.state = red.settledAssets > 0 ? RedeemRequestState.SETTLED : RedeemRequestState.CANCELLED;
        IQueue(queue).remove(address(this), QueueType.REDEEM, requestId);
        if (returned > 0) _transferShares(address(this), red.owner, returned);
    }

    /// @dev The window in which an owner may withdraw their own request. Two phases are closed,
    ///      both because a settlement round is or may be in flight over the request: an ordinary
    ///      cycle being computed (`cycle != ACCEPTING`), and the final settlement window
    ///      (`ProductState.SETTLING`). Everything else is open — the ACCEPTING window of
    ///      SUBSCRIBING/OPERATING, and MATURING / CLAIMING / CLOSED, where nothing can settle
    ///      any more and the request would otherwise be locked in forever.
    ///
    ///      SETTLING needs its own clause rather than falling out of the cycle check: the
    ///      product reaches SETTLING from `completeCycle`, which has already returned the cycle
    ///      to ACCEPTING, and no transition after it touches the cycle — so `cycle` reads
    ///      ACCEPTING for the whole SETTLING → MATURING → CLAIMING → CLOSED tail.
    function _requireCancellable(uint256 requestId) internal view {
        ProductState ps = IStateManager(stateManager).getProductState(address(this));
        CycleState cs = IStateManager(stateManager).getCycleState(address(this));
        if (cs != CycleState.ACCEPTING || ps == ProductState.SETTLING) {
            revert CancelNotAllowed(requestId, ps, cs);
        }
    }

    function cancelRequest(uint256 requestId) external nonReentrant {
        _requireActive();
        // Check if deposit or redeem
        DepositRequestInternal storage dep = _depositRequests[requestId];
        if (dep.owner != address(0)) {
            _checkOwnerOrOperator(dep.owner);
            if (dep.state != DepositRequestState.PENDING) revert RequestNotFound(requestId);

            // Same liquidation exemption the redeem branch below carries, for the same reason
            // and with more force (审计反馈 V4 #5). `writeDownInsolvency` has no cycle-state
            // precondition, so a liquidation can land while the cycle is CALCULATING; from then
            // on `snapshotSettlementPrice` reverts on `insolvencyLiquidated`, so `settle` can
            // never finish the batch, `completeCycle` — the only writer that returns the cycle to
            // ACCEPTING and the product to MATURING — never runs, and `startCycleCalculation`
            // cannot reopen a cycle that is not ACCEPTING. The cycle is then wedged in
            // CALCULATING for good and `_requireCancellable` rejects forever.
            //
            // That would close the only exit a PENDING deposit has: `markRefundable` needs
            // FUNDING_FAILED, unreachable from OPERATING, and `evictDepositRequest` exists only
            // on LiquidityEarnVault. Yet `writeDownInsolvency` checks
            // `cash >= pendingDepositLiability + refundableLiability` precisely to declare this
            // class protected in full — and REFUNDABLE, the other protected class, keeps its
            // payout path through `claimRefund` regardless. PENDING must be no worse off.
            if (!insolvencyLiquidated) _requireCancellable(requestId);
            _unwindPendingDeposit(requestId, dep);

            emit RequestCancelled(requestId, msg.sender, block.timestamp);
            return;
        }

        RedeemRequestInternal storage red = _redeemRequests[requestId];
        if (red.owner == address(0)) revert RequestNotFound(requestId);
        _checkOwnerOrOperator(red.owner);
        if (red.state != RedeemRequestState.QUEUED) revert RequestNotFound(requestId);

        // The cancellation window exists because a settlement round may be in flight over the
        // request. Liquidation ends that possibility for good — no cycle prices again and no
        // batch settles again — so keeping the gate would only lock the request in forever, which
        // is exactly the trap 审计反馈 V3 #3 describes when the liquidation lands mid-CALCULATING.
        // This is also the exit for a liquidated request with nothing written down to claim
        // (审计问题 3 回复 §三.4).
        if (!insolvencyLiquidated) _requireCancellable(requestId);
        // A partially-filled redeem gets back only `remainingShares` and is promoted to SETTLED,
        // never CANCELLED — the USDT already reserved for the filled part must stay claimable
        // through claimRedeem. _unwindQueuedRedeem handles both cases.
        _unwindQueuedRedeem(requestId, red);

        emit RequestCancelled(requestId, msg.sender, block.timestamp);
    }

    /// @dev Pays out whatever this request has been filled for so far — not only a request that
    ///      has been filled in full. Until 审计反馈 V3 #3 this accepted SETTLED alone, so a
    ///      partially-filled request sat in QUEUED with its filled shares already burned and its
    ///      USDT already inside `reservedRedeemLiability`, yet unreachable. Both routes out of
    ///      QUEUED could be closed at once: a successful `writeDownInsolvency` makes
    ///      `snapshotSettlementPrice` revert forever, so no later batch can finish the remainder,
    ///      and if the liquidation lands while the cycle is CALCULATING that cycle never returns
    ///      to ACCEPTING, so `_requireCancellable` rejects `cancelRequest` forever too. The cash
    ///      was then stranded permanently — for the partially filled only, at the same haircut
    ///      ratio their fully-filled peers were paid at.
    ///
    ///      Three shapes, distinguished after the payout:
    ///      - QUEUED, shares still outstanding, solvent: stays QUEUED in its original FIFO slot
    ///        and keeps accruing on later fills, so one request may be filled and claimed many
    ///        times over.
    ///      - QUEUED, shares still outstanding, liquidated: no batch will ever price again, so
    ///        the payout and the exit happen together — queue slot released, `remainingShares`
    ///        handed back, request terminal (审计问题 3 回复 §三.3). Returned shares are for
    ///        unlocking and cleanup; liquidation has already established they carry no residual
    ///        payout value, and `claimFinal` stays disabled.
    ///      - Nothing outstanding: terminal, as before.
    ///
    ///      A liquidated request with no written-down cash left (`settledAssets == 0`) exits via
    ///      `cancelRequest` instead, which drops its cycle-state gate once liquidated.
    function claimRedeem(uint256 requestId, address receiver) external virtual nonReentrant returns (uint256 assets) {
        RedeemRequestInternal storage req = _redeemRequests[requestId];
        if (req.owner == address(0)) revert RequestNotFound(requestId);
        _checkOwnerOrOperator(req.owner);
        if (req.state != RedeemRequestState.SETTLED && req.state != RedeemRequestState.QUEUED) {
            revert RequestNotSettled(requestId);
        }
        assets = req.settledAssets;
        if (assets == 0) revert RequestNotSettled(requestId);
        _requireActive();

        // State and liabilities settle before any transfer: `settledAssets` is what makes this
        // claimable and what `reservedRedeemLiability` is the sum of, so zeroing it here is what
        // makes a second claim of the same money impossible.
        req.settledAssets = 0;
        reservedRedeemLiability -= assets;

        bool liquidationExit = req.state == RedeemRequestState.QUEUED && insolvencyLiquidated;
        uint256 sharesReturned;

        if (liquidationExit) {
            sharesReturned = req.remainingShares;
            req.remainingShares = 0;
            req.state = RedeemRequestState.CLAIMED;
            IQueue(queue).remove(address(this), QueueType.REDEEM, requestId);
            if (sharesReturned > 0) _transferShares(address(this), req.owner, sharesReturned);
        } else if (req.remainingShares == 0) {
            req.state = RedeemRequestState.CLAIMED;
        }

        IERC20(usdt).safeTransfer(receiver, assets);

        emit RedeemClaimed(requestId, receiver, assets, block.timestamp);
        if (liquidationExit) {
            emit RedeemLiquidationExit(requestId, receiver, assets, sharesReturned, block.timestamp);
        } else if (req.remainingShares > 0) {
            emit RedeemPartiallyClaimed(requestId, receiver, assets, req.remainingShares, block.timestamp);
        }
    }

    function claimRefund(uint256 requestId) external nonReentrant {
        DepositRequestInternal storage req = _depositRequests[requestId];
        if (req.owner == address(0)) revert RequestNotFound(requestId);
        if (req.state != DepositRequestState.REFUNDABLE) revert NotRefundable(requestId);
        _requireActive();

        uint256 assets = req.assets;
        req.state = DepositRequestState.REFUNDED;
        refundableLiability -= assets;

        IERC20(usdt).safeTransfer(req.owner, assets);

        emit RefundClaimed(requestId, req.owner, assets, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Performance fee snapshot — once per cycle, before settle()
    // -----------------------------------------------------------------------

    function snapshotSettlementPrice(uint256 cycleNumber) external onlySettlementContract {
        _requireActive();
        if (insolvencyLiquidated) revert VaultLiquidated(); // no further pricing after liquidation
        if (cycleSnapshots[cycleNumber].initialized) revert SnapshotAlreadyInitialized(cycleNumber);

        // The final price must reflect what was actually recovered, not what the book still says
        // is out there. So before it can be struck, every position must have left: no adapter may
        // report any assets, and the UnifiedPool must owe this vault nothing. Both readings are
        // the on-chain evidence that the wind-down really happened — an asset that defaulted
        // outright satisfies this too, by being written down to zero, and the loss then lands on
        // the price rather than on anyone's obligation to top the vault up
        // (最终周期结算及最终兑付补充修改方案 §五.3).
        bool isFinal = IStateManager(stateManager).isFinalCycle(address(this));
        if (isFinal) _requireAssetsWoundDown();

        uint256 supply = _totalShares;
        uint256 assets = totalAssets();
        uint256 feeAssets;
        uint256 feeShares;

        if (supply == 0) {
            feeHighWaterMark = parityPrice;
        } else {
            uint256 grossPrice = Math.mulDiv(assets, 1e18, supply);
            if (grossPrice > feeHighWaterMark) {
                uint256 profitPerShare = grossPrice - feeHighWaterMark;
                uint256 profitAssets = Math.mulDiv(supply, profitPerShare, 1e18);
                feeAssets = profitAssets * performanceFeeBps / 10_000;
                if (feeAssets > 0) {
                    if (performanceFeeRecipient != address(0)) {
                        feeShares = Math.mulDiv(feeAssets, supply, assets - feeAssets);
                        supply += feeShares;

                        uint256 protocolFeeShares = Math.mulDiv(feeShares, protocolFeeShareBps, 10_000);
                        uint256 recipientFeeShares = feeShares - protocolFeeShares;

                        if (protocolFeeShares > 0 && recipientFeeShares > 0 && revenuePool == performanceFeeRecipient) {
                            _mintShares(performanceFeeRecipient, feeShares);
                        } else {
                            if (recipientFeeShares > 0) _mintShares(performanceFeeRecipient, recipientFeeShares);
                            if (protocolFeeShares > 0) _mintShares(revenuePool, protocolFeeShares);
                        }

                        emit PerformanceFeeAccrued(cycleNumber, feeAssets, feeShares, block.timestamp);
                        emit PerformanceFeeDistributed(
                            cycleNumber, feeAssets, feeShares, protocolFeeShares, recipientFeeShares, revenuePool, performanceFeeRecipient
                        );
                    } else {
                        // No recipient configured: the fee can't be collected this cycle. Flag it
                        // on-chain instead of silently dropping it — feeShares stays 0 and the HWM
                        // still ratchets up below, so this cycle's fee is forfeited, not deferred.
                        emit PerformanceFeeSkipped(cycleNumber, feeAssets, block.timestamp);
                    }
                }
                feeHighWaterMark = Math.mulDiv(assets, 1e18, supply);
            }
        }

        uint256 settlementPrice = supply == 0 ? parityPrice : Math.mulDiv(assets, 1e18, supply);

        cycleSnapshots[cycleNumber] = CycleSnapshot({
            totalAssets:     assets,
            totalSupply:     supply,
            settlementPrice: settlementPrice,
            feeAssets:       feeAssets,
            feeShares:       feeShares,
            timestamp:       block.timestamp,
            initialized:     true
        });

        if (isFinal) {
            finalSettlementPrice = settlementPrice;
            emit FinalPriceFrozen(cycleNumber, settlementPrice, assets, supply, block.timestamp);
        }

        emit SettlementPriceSnapshotted(cycleNumber, assets, supply, settlementPrice, block.timestamp);
    }

    /// @dev Reverts unless every investment position has been realised back into this vault.
    function _requireAssetsWoundDown() internal view {
        if (unifiedPool != address(0)) {
            uint256 owed = IUnifiedPool(unifiedPool).pending(address(this));
            if (owed != 0) revert AssetsNotWoundDown(unifiedPool, owed);
        }
        for (uint256 i = 0; i < adapters.length; i++) {
            uint256 held = IAdapter(adapters[i]).realAssets();
            if (held != 0) revert AssetsNotWoundDown(adapters[i], held);
        }
    }

    // -----------------------------------------------------------------------
    // Settlement — net settlement against the cycle's price snapshot
    // -----------------------------------------------------------------------

    function settle(
        uint256 cycleNumber,
        RequestSettlement[] calldata deposits,
        RequestSettlement[] calldata redeems,
        uint256 poolDistributedAssets
    ) external virtual onlySettlementContract nonReentrant returns (uint256[] memory fullyClearedRedeemIds) {
        _requireActive();

        CycleSnapshot storage snap = cycleSnapshots[cycleNumber];
        if (!snap.initialized) revert SnapshotNotInitialized(cycleNumber);

        // Captured before this batch's own liability changes: still excludes the deposits
        // being accepted this cycle (added back explicitly below) and the redeems being
        // reserved this cycle (which must not shrink their own funding check).
        uint256 freeBefore = freeVaultUSDT();

        uint256 acceptedDepositTotal;
        uint256 acceptedRedeemTotal;
        // Scoped so the per-batch share tallies leave the stack before the event below — settle()
        // is otherwise one local away from "stack too deep" under the legacy codegen pipeline.
        {
            uint256 mintedShares;
            uint256 burnedShares;
            (acceptedDepositTotal, mintedShares) = _processDeposits(deposits, cycleNumber, snap.settlementPrice);
            (acceptedRedeemTotal, burnedShares, fullyClearedRedeemIds) =
                _processRedeems(redeems, cycleNumber, snap.settlementPrice);

            if (acceptedRedeemTotal > acceptedDepositTotal + freeBefore) {
                revert InsufficientSettlementLiquidity(acceptedRedeemTotal, acceptedDepositTotal + freeBefore);
            }

            // The authoritative capacity check, applied once per batch on the NET movement
            // rather than after each request. Netting matters: a batch that subscribes then
            // redeems within the same cycle would otherwise trip the cap on an intermediate
            // state that never actually existed at rest.
            //
            // Any LP Bridge inflow is already counted — it minted its Cash shares through
            // `EarnVault.deposit`, which charges the quota at mint time — so a bridged
            // subscription cannot escape the check the way it once could.
            _applyCapUsage(mintedShares, burnedShares);
        }

        emit CycleNetFlow(
            cycleNumber, acceptedDepositTotal, acceptedRedeemTotal,
            int256(acceptedDepositTotal) - int256(acceptedRedeemTotal)
        );
        emit SettlementProcessed(deposits.length, redeems.length, poolDistributedAssets, block.timestamp);
    }

    /// @dev Applies one batch's net quota movement and enforces the cap. Floors at zero rather
    ///      than reverting on underflow: a redemption of performance-fee shares releases quota
    ///      that was never charged when those shares were minted, so burns can legitimately
    ///      exceed the quota on the books (净募集额度修改方案 §3, §4).
    function _applyCapUsage(uint256 mintedShares, uint256 burnedShares) internal {
        uint256 used = subscriptionCapUsedShares + mintedShares;
        used = used > burnedShares ? used - burnedShares : 0;
        subscriptionCapUsedShares = used;

        uint256 capShare = subscriptionCapShare;
        if (capShare != 0 && used > capShare) revert SupplyCapExceeded(capShare, used);
    }

    /// @dev Refunds are pushed to `req.owner` via `safeTransfer`; a reverting/blacklisted
    ///      recipient reverts the whole settlement batch. Operational mitigation: evict the
    ///      offending request from the batch, or settle it as a full accept instead of partial.
    function _processDeposits(RequestSettlement[] calldata items, uint256 cycleNumber, uint256 settlementPrice)
        internal
        virtual
        returns (uint256 acceptedTotal, uint256 mintedShares)
    {
        for (uint256 i = 0; i < items.length; i++) {
            uint256 rid = items[i].requestId;
            DepositRequestInternal storage req = _depositRequests[rid];
            if (req.state == DepositRequestState.SETTLED) revert RequestAlreadySettled(rid);
            if (req.state != DepositRequestState.PENDING) revert RequestNotFound(rid);

            uint256 settleAmount = items[i].settleAmount;
            if (settleAmount == 0 || settleAmount > req.assets) revert InvalidSettleAmount(rid);

            // FIFO prefix semantics: at most one partial fill per batch, and nothing accepted
            // after it. `items` is in queue order — Settlement hands this same array to
            // Queue.dequeue, which reverts unless the ids come off the queue head in order — so
            // "nothing accepted after the partial" reduces to "only the final entry may be
            // partial". A request that is not accepted at all is absent from the array entirely
            // and stays PENDING.
            if (settleAmount < req.assets && i != items.length - 1) revert PartialFillMustBeLast(rid);

            uint256 shares = Math.mulDiv(settleAmount, 1e18, settlementPrice);
            req.settledShares = shares;
            req.state = DepositRequestState.SETTLED;
            req.cycleNumber = cycleNumber;

            pendingDepositLiability -= req.assets;
            pendingDepositByOwner[req.owner] -= req.assets;
            acceptedTotal += settleAmount;

            _mintShares(address(this), shares); // held for claimDeposit
            mintedShares += shares;

            uint256 refund = req.assets - settleAmount;
            if (refund > 0) {
                IERC20(usdt).safeTransfer(req.owner, refund);
            }
            emit DepositSettled(rid, req.assets, settleAmount, refund, cycleNumber, block.timestamp);
        }
    }

    function _processRedeems(RequestSettlement[] calldata items, uint256 cycleNumber, uint256 settlementPrice)
        internal
        returns (uint256 acceptedTotal, uint256 burnedShares, uint256[] memory fullyClearedIds)
    {
        uint256[] memory cleared = new uint256[](items.length);
        uint256 clearedCount;

        for (uint256 i = 0; i < items.length; i++) {
            uint256 rid = items[i].requestId;
            RedeemRequestInternal storage req = _redeemRequests[rid];
            if (req.state != RedeemRequestState.QUEUED) revert RequestNotFound(rid);

            uint256 settleAmount = items[i].settleAmount; // shares
            if (settleAmount == 0 || settleAmount > req.remainingShares) revert InvalidSettleAmount(rid);

            uint256 assetsOut = Math.mulDiv(settleAmount, settlementPrice, 1e18);
            req.remainingShares -= settleAmount;
            req.settledAssets += assetsOut;
            req.cycleNumber = cycleNumber;

            reservedRedeemLiability += assetsOut;
            acceptedTotal += assetsOut;

            _burnShares(address(this), settleAmount);
            burnedShares += settleAmount;

            if (req.remainingShares == 0) {
                req.state = RedeemRequestState.SETTLED;
                cleared[clearedCount++] = rid;
            }
            emit RedeemSettled(rid, req.shares, settleAmount, req.remainingShares, assetsOut, cycleNumber, block.timestamp);
        }

        fullyClearedIds = new uint256[](clearedCount);
        for (uint256 i = 0; i < clearedCount; i++) {
            fullyClearedIds[i] = cleared[i];
        }
    }

    // -----------------------------------------------------------------------
    // Final redemption — the exit for shares that were never queued
    // -----------------------------------------------------------------------

    /// @notice Burns `shares` at the frozen final price and pays the proceeds to `receiver`.
    /// @dev    The exit path for anyone still simply holding shares at maturity: a holder who
    ///         never called `requestRedeem`, or who cancelled an unsettled request and took their
    ///         shares back. Without it those holders own a claim with no on-chain way to realise
    ///         it (审计反馈 2026-08-17 待确认问题 2；最终周期结算及最终兑付补充修改方案 §十一.3).
    ///
    ///         Open from CLAIMING onward and — deliberately — still open once the product is
    ///         CLOSED: CLOSED ends the product's business, not the holder's right to be paid.
    ///         Partial claims are allowed and nothing forces a holder to exit inside any window.
    ///
    ///         Paid strictly out of `freeVaultUSDT()`, so it can never reach into the USDT owed
    ///         to pending deposits, already-settled redemptions, or refunds.
    function claimFinal(uint256 shares, address owner, address receiver)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroShares();
        _checkOwnerOrOperator(owner);
        _requireActive();

        // Checked before the lifecycle gate: a liquidation shuts this permanently, in every
        // state, because the fixed claims already exceeded total assets and shares rank behind
        // them — there is nothing left for them to draw on (§三, §七).
        if (insolvencyLiquidated) revert VaultLiquidated();

        ProductState ps = IStateManager(stateManager).getProductState(address(this));
        if (ps != ProductState.CLAIMING && ps != ProductState.CLOSED) {
            revert WrongProductState(ProductState.CLAIMING, ps);
        }

        uint256 price = finalSettlementPrice;
        if (price == 0) revert FinalPriceNotSet();

        // Rounded down for every claimant alike, so no ordering of claims changes what anyone
        // gets and no early claimant can round their way into someone else's money. The dust that
        // survives is bounded by one unit per claim (§十一.4).
        assets = Math.mulDiv(shares, price, 1e18);

        uint256 available = freeVaultUSDT();
        if (assets > available) revert InsufficientFreeUSDT(assets, available);

        _burnShares(owner, shares);
        IERC20(usdt).safeTransfer(receiver, assets);

        emit FinalClaimed(owner, receiver, shares, assets, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Insolvency recovery — governance-directed loss write-down
    // -----------------------------------------------------------------------

    /// @notice Recovery path for when grossManagedAssets() has fallen below total liabilities
    ///         (e.g. an Adapter loss), which makes totalAssets()/freeVaultUSDT() revert with
    ///         AccountingInsolvent and blocks settle(). The Company computes the loss
    ///         allocation off-chain (same trust model as SettlementOperator's calc input) and
    ///         supplies the reduced amount owed on each still-outstanding request; this
    ///         function only applies haircuts (never increases what's owed) and requires the
    ///         write-down to fully clear the deficit before it takes effect.
    ///
    ///         PENDING subscriptions are NOT in scope and cannot be haircut here at all
    ///         (审计报告（一）回复 §2). That money has not been settled, has minted no shares and
    ///         has never reached an Adapter — it is a protected subscription liability the owner
    ///         may still cancel and be refunded in full, so it must not absorb losses taken by
    ///         the invested portfolio. Ordinary investment losses reach the people who actually
    ///         bear them through NAV and the share price instead.
    /// @notice One-shot insolvency liquidation: pays the protected classes in full and haircuts
    ///         every outstanding settled redemption by one uniform ratio.
    /// @param  settledRedeemIds EVERY unclaimed redemption that still carries `settledAssets`,
    ///         in strictly ascending order. The caller supplies ids only — never amounts.
    ///
    /// @dev    Reserved for the case where assets can no longer cover even the FIXED liabilities.
    ///         An ordinary investment loss — where `grossManagedAssets()` still covers them — is
    ///         not this: it reaches share holders through NAV and the share price, and calling
    ///         here is rejected (0826 writeDownInsolvency 最小化修改方案 §二).
    ///
    ///         Waterfall (§三): PENDING subscriptions and REFUNDABLE refunds are protected in
    ///         full — neither ever bought into the portfolio — then whatever remains pays the
    ///         settled redemptions pro rata, and shares rank last. Since assets cannot even cover
    ///         the fixed claims, share holders have nothing left to distribute, which is why a
    ///         successful liquidation disables `claimFinal` permanently.
    ///
    ///         The ratio is computed on-chain and never supplied by the caller, so the same
    ///         proportion necessarily applies to everyone. Two integrity checks make partial or
    ///         selective submission impossible (§五): ids must strictly ascend (no repeats), and
    ///         the original amounts must sum to exactly `reservedRedeemLiability` (no omissions).
    function writeDownInsolvency(uint256[] calldata settledRedeemIds) external {
        if (msg.sender != vaultTimelock) revert Unauthorized();
        if (insolvencyLiquidated) revert AlreadyLiquidated();

        uint256 reserved = reservedRedeemLiability;
        if (reserved == 0) revert NotInsolvent();

        uint256 protectedLiabilities = pendingDepositLiability + refundableLiability;
        uint256 gross = grossManagedAssets();
        uint256 liabilitiesBefore = protectedLiabilities + reserved;
        if (gross >= liabilitiesBefore) revert NotInsolvent();

        // The protected classes are paid from USDT actually sitting in this vault, so require it
        // to be there before haircutting anyone. This also guarantees the subtraction below.
        uint256 cash = IERC20(usdt).balanceOf(address(this));
        if (cash < protectedLiabilities) revert ProtectedLiabilitiesUnbacked(protectedLiabilities, cash);

        uint256 available = gross - protectedLiabilities;
        uint256 sumOriginal;
        uint256 sumNew;
        uint256 previousId;

        for (uint256 i = 0; i < settledRedeemIds.length; i++) {
            uint256 rid = settledRedeemIds[i];
            if (rid <= previousId) revert IdsNotStrictlyAscending(rid);
            previousId = rid;

            RedeemRequestInternal storage req = _redeemRequests[rid];
            uint256 original = req.settledAssets;
            bool eligible = original > 0
                && (req.state == RedeemRequestState.SETTLED || req.state == RedeemRequestState.QUEUED);
            if (!eligible) revert RequestNotFound(rid);

            uint256 newAssets = Math.mulDiv(original, available, reserved);
            req.settledAssets = newAssets;
            sumOriginal += original;
            sumNew += newAssets;

            emit RequestWrittenDown(rid, original - newAssets, newAssets, block.timestamp);
        }

        // Every outstanding claim had to be in the list, or the ratio would have been applied to
        // some holders and not others.
        if (sumOriginal != reserved) revert IncompleteWriteDown(sumOriginal, reserved);

        reservedRedeemLiability = sumNew;
        uint256 liabilitiesAfter = protectedLiabilities + sumNew;
        if (gross < liabilitiesAfter) revert InsufficientWriteDown(gross, liabilitiesAfter);

        insolvencyLiquidated = true;
        emit InsolvencyWrittenDown(gross, liabilitiesBefore, liabilitiesAfter, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Mark all deposit requests REFUNDABLE (called when FUNDING_FAILED)
    // -----------------------------------------------------------------------

    function markRefundable(uint256[] calldata requestIds) external {
        ProductState ps = IStateManager(stateManager).getProductState(address(this));
        if (ps != ProductState.FUNDING_FAILED) revert WrongProductState(ProductState.FUNDING_FAILED, ps);
        _onlyCurator();

        for (uint256 i = 0; i < requestIds.length; i++) {
            DepositRequestInternal storage req = _depositRequests[requestIds[i]];
            if (req.state == DepositRequestState.PENDING) {
                req.state = DepositRequestState.REFUNDABLE;
                pendingDepositLiability -= req.assets;
                pendingDepositByOwner[req.owner] -= req.assets;
                refundableLiability += req.assets;
                IQueue(queue).remove(address(this), QueueType.DEPOSIT, requestIds[i]);
                emit DepositMarkedRefundable(requestIds[i], req.owner, req.assets, block.timestamp);
            }
        }
    }

    error WrongProductState(ProductState expected, ProductState actual);

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    function setSettlement(address settlement_) external {
        _onlyOwnerDirectOrTimelock();
        CycleState cs = IStateManager(stateManager).getCycleState(address(this));
        if (cs == CycleState.CALCULATING || cs == CycleState.FULFILLING) {
            revert SettlementChangeDuringActiveCycle(cs);
        }
        settlement = settlement_;
        emit SettlementSet(settlement_, block.timestamp);
    }

    function setGate(address gate_) external {
        _onlyOwnerDirectOrTimelock();
        address old = gate;
        gate = gate_;
        emit GateUpdated(old, gate_, block.timestamp);
    }

    /// @dev `grossManagedAssets()` reads `pending` from whichever pool is wired here, so swapping
    ///      pools with a non-zero balance left behind would drop that receivable out of NAV in a
    ///      single step and strand the cash in the old pool. The balance has to be distributed
    ///      back to this Vault first (审计反馈 2026-08-17 #6).
    function setUnifiedPool(address pool) external {
        _onlyOwnerDirectOrTimelock();
        if (pool == address(0)) revert ZeroAddress();
        address old = unifiedPool;
        if (old != address(0) && old != pool) {
            uint256 stranded = IUnifiedPool(old).pending(address(this));
            if (stranded != 0) revert OldPoolPendingNotDrained(old, stranded);
        }
        unifiedPool = pool;
        emit UnifiedPoolSet(pool, block.timestamp);
    }

    /// @notice Wire the ClaimRegistry and the post-maturity grace period used by
    ///         `recordOverdueClaims`. Passing `registry == address(0)` disables registration.
    function configureClaimRegistry(address registry, uint256 gracePeriod) external {
        _onlyOwnerDirectOrTimelock();
        claimRegistry = registry;
        claimGracePeriod = gracePeriod;
        emit ClaimRegistrySet(registry, gracePeriod, block.timestamp);
    }

    /// @notice Record requests still unclaimed past `maturityTimestamp + claimGracePeriod` into
    ///         this Vault's ClaimRegistry.
    /// @dev    Audit Feedback V2 #11: `ClaimRegistry.recordClaim` had no on-chain caller at all,
    ///         so its `msg.sender == vault` branch was dead and the backstop register depended
    ///         entirely on the Curator acting by hand. This is that caller. Deliberately
    ///         permissionless — the record is append-only bookkeeping that moves no funds and
    ///         changes no request state, so anyone may push an overdue request in; the
    ///         `claimRecorded` guard makes repeat calls no-ops rather than duplicate entries,
    ///         which is the de-dup the audit also asked for.
    /// @param  requestIds Deposit and/or redeem request ids, in any order.
    function recordOverdueClaims(uint256[] calldata requestIds) external {
        address registry = claimRegistry;
        if (registry == address(0)) revert ClaimRegistryNotConfigured();

        uint256 dueFrom = IStateManager(stateManager).getParams(address(this)).maturityTimestamp + claimGracePeriod;
        if (block.timestamp < dueFrom) revert ClaimGracePeriodNotElapsed(dueFrom);

        uint256 len = requestIds.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 requestId = requestIds[i];
            if (claimRecorded[requestId]) continue;

            DepositRequestInternal storage dep = _depositRequests[requestId];
            RedeemRequestInternal storage red = _redeemRequests[requestId];

            // SETTLED/REFUNDABLE are exactly the states holding a claimable balance the owner has
            // not taken. Everything else is either terminal or still awaiting settlement.
            if (dep.state == DepositRequestState.SETTLED || dep.state == DepositRequestState.REFUNDABLE) {
                claimRecorded[requestId] = true;
                IClaimRegistry(registry).recordClaim(
                    address(this),
                    dep.owner,
                    requestId,
                    dep.state == DepositRequestState.SETTLED ? dep.settledShares : dep.assets,
                    IClaimRegistry.ClaimKind.DEPOSIT_REFUND
                );
            } else if (
                red.state == RedeemRequestState.SETTLED
                    || (red.state == RedeemRequestState.QUEUED && red.settledAssets > 0)
            ) {
                // Since 审计反馈 V3 #3 a still-queued request can hold a claimable balance too.
                claimRecorded[requestId] = true;
                IClaimRegistry(registry).recordClaim(
                    address(this), red.owner, requestId, red.settledAssets, IClaimRegistry.ClaimKind.REDEEM_PAYOUT
                );
            }
        }
    }

    function _onlySettlementOperator() internal view {
        if (!ISettlement(settlement).isOperator(address(this), msg.sender)) revert Unauthorized();
    }

    /// @notice Sends `amount` of this Vault's own free USDT to its configured UnifiedPool,
    ///         crediting this Vault's own pending there for later Settlement-directed
    ///         distribution.
    /// @dev    Access: this Vault's Settlement Operator (per this Vault's own bound Settlement
    ///         contract).
    function returnPrincipalToPool(uint256 amount) external {
        _onlySettlementOperator();
        _requireActive();
        if (insolvencyLiquidated) revert VaultLiquidated(); // no capital may leave after liquidation
        if (unifiedPool == address(0)) revert UnifiedPoolNotSet();
        if (amount == 0) revert ZeroAssets();
        uint256 available = freeVaultUSDT();
        if (amount > available) revert InsufficientFreeUSDT(amount, available);

        IERC20(usdt).safeIncreaseAllowance(unifiedPool, amount);
        IUnifiedPool(unifiedPool).receiveVaultPrincipal(amount);
    }

    /// @notice Reads a deposit request by id. An id that was never issued returns a zeroed struct
    ///         whose `state` is `DepositRequestState.NONE`.
    /// @dev    `nextRequestId` is public, so callers can already learn how many requests exist;
    ///         without this the individual records were unreachable, leaving front-ends unable to
    ///         gate claim/refund actions on a request's actual state.
    function getDepositRequest(uint256 requestId) external view returns (DepositRequest memory) {
        DepositRequestInternal storage req = _depositRequests[requestId];
        return DepositRequest({
            owner: req.owner,
            assets: req.assets,
            settledShares: req.settledShares,
            cycleNumber: req.cycleNumber,
            state: req.state
        });
    }

    /// @notice Read model for a redeem request; a never-created id reads back all-zero with
    ///         `state == RedeemRequestState.NONE`.
    /// @dev    The redeem-side counterpart to `getDepositRequest`, needed since 审计反馈 V3 #3:
    ///         "claimable" is no longer implied by the state, so a caller has to read
    ///         `settledAssets` and `remainingShares` to tell how much can be claimed now and how
    ///         much is still queued.
    function getRedeemRequest(uint256 requestId) external view returns (RedeemRequest memory) {
        RedeemRequestInternal storage req = _redeemRequests[requestId];
        return RedeemRequest({
            owner: req.owner,
            shares: req.shares,
            remainingShares: req.remainingShares,
            settledAssets: req.settledAssets,
            cycleNumber: req.cycleNumber,
            state: req.state
        });
    }

    function _onlyAllocator() internal view {
        if (msg.sender != allocator) revert Unauthorized();
    }

    /// @notice Deploys `assets` of this Vault's free USDT into one of its registered Adapters.
    /// @dev    Access: this Vault's Allocator ("在 Curator 约束内调度资金").
    ///
    ///         The transfer itself is the standard ERC-4626 allocation the design calls for —
    ///         approve, then `deposit(assets, address(this))` so the Adapter shares land on the
    ///         Vault. What this function adds is the on-chain entrypoint that makes the Vault
    ///         issue those two calls; without it no actor can move Vault capital into an Adapter.
    ///
    ///         Only `freeVaultUSDT()` is deployable: USDT owed to pending deposits, reserved
    ///         redeems, or refunds stays put. `grossManagedAssets()` is unchanged by this call —
    ///         the balance leaving the Vault reappears as the Adapter's `realAssets()`.
    function fundAdapter(address adapter_, uint256 assets) external nonReentrant {
        _onlyAllocator();
        if (insolvencyLiquidated) revert VaultLiquidated(); // no new deployment after liquidation
        if (!isAdapter[adapter_]) revert AdapterNotFound(adapter_);
        if (assets == 0) revert ZeroAssets();
        uint256 available = freeVaultUSDT();
        if (assets > available) revert InsufficientFreeUSDT(assets, available);

        IERC20(usdt).forceApprove(adapter_, assets);
        IERC4626(adapter_).deposit(assets, address(this));

        emit AdapterFunded(adapter_, assets, block.timestamp);
    }

    /// @notice Pulls `assets` of USDT back out of one of this Vault's registered Adapters.
    /// @dev    Access: this Vault's Allocator. The Vault owns the Adapter shares, so it is both
    ///         `receiver` and `owner` of the inherited ERC-4626 withdrawal — no allowance needed.
    ///         Counterpart to `fundAdapter`: without it, capital deployed into an Adapter counts
    ///         toward `grossManagedAssets()` but can never be paid back out to share holders.
    function recallAdapter(address adapter_, uint256 assets) external nonReentrant {
        _onlyAllocator();
        if (!isAdapter[adapter_]) revert AdapterNotFound(adapter_);
        if (assets == 0) revert ZeroAssets();

        IERC4626(adapter_).withdraw(assets, address(this), address(this));

        emit AdapterRecalled(adapter_, assets, block.timestamp);
    }

    function addAdapter(address adapter_) public virtual {
        _onlyCuratorDirectOrTimelock();
        if (adapter_ == address(0)) revert ZeroAddress();
        if (IAdapter(adapter_).vault() != address(this)) revert AdapterNotFound(adapter_);
        if (isAdapter[adapter_]) revert AdapterAlreadyAdded(adapter_);
        if (adapters.length >= MAX_ADAPTERS) revert AdapterLimitExceeded();
        IAdapter(adapter_).realAssets(); // must not revert — confirms the adapter is well-formed before admission

        adapters.push(adapter_);
        isAdapter[adapter_] = true;
        emit AdapterAdded(adapter_, block.timestamp);
    }

    /// @inheritdoc IBaseVault
    /// @dev Ordering is not stable — `removeAdapter` is swap-and-pop, so a removal moves the
    ///      last adapter into the freed slot. Callers must pin one `blockTag` across this and
    ///      the `adapters(i)` reads that follow it.
    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    function removeAdapter(address adapter_) external {
        _onlyCuratorDirectOrTimelock();
        if (!isAdapter[adapter_]) revert AdapterNotFound(adapter_);
        if (IAdapter(adapter_).realAssets() != 0) revert AdapterStillHasAssets(adapter_);

        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i] == adapter_) {
                adapters[i] = adapters[len - 1];
                adapters.pop();
                break;
            }
        }
        isAdapter[adapter_] = false;
        emit AdapterRemoved(adapter_, block.timestamp);
    }

    /// @notice One-shot initialisation of the subscription cap, pushed in by this Vault's
    ///         StateManager as part of `setProductParams`.
    /// @dev    Access: this Vault's own StateManager, while the product is CONFIGURING only.
    ///         Curator sets the cap alongside the rest of the product parameters rather than in a
    ///         second, easily-forgotten call to this Vault; StateManager arrives here as
    ///         `msg.sender`, which no Vault-local role check would admit, so it gets this narrow
    ///         entry point instead of a widened `setSubscriptionCapShare`
    ///         (募集上限参数调整建议 §2, §3).
    function initSubscriptionCapShare(uint256 capShare) external {
        if (msg.sender != stateManager || !_isConfiguring()) revert Unauthorized();
        _writeSubscriptionCapShare(capShare);
    }

    /// @notice Change the subscription cap after configuration.
    /// @dev    Access: this Vault's VaultTimelock only. The initial value comes from
    ///         `StateManager.setProductParams`; every later change is a governance action
    ///         (募集上限参数调整建议 §3).
    function setSubscriptionCapShare(uint256 capShare) external {
        if (msg.sender != vaultTimelock) revert Unauthorized();
        _writeSubscriptionCapShare(capShare);
    }

    function _writeSubscriptionCapShare(uint256 capShare) internal {
        uint256 old = subscriptionCapShare;
        subscriptionCapShare = capShare;
        emit SubscriptionCapShareUpdated(old, capShare, block.timestamp);
    }

    function setPerformanceFeeBps(uint16 bps) external {
        _onlyCuratorDirectOrTimelock();
        if (bps > MAX_PERFORMANCE_FEE_BPS) revert FeeTooHigh(bps);
        if (bps > 0 && performanceFeeRecipient == address(0)) revert InvalidFeeRecipient();
        performanceFeeBps = bps;
        emit PerformanceFeeUpdated(bps, block.timestamp);
    }

    function setPerformanceFeeRecipient(address recipient) external {
        _onlyCuratorDirectOrTimelock();
        if (performanceFeeBps > 0 && recipient == address(0)) revert InvalidFeeRecipient();
        performanceFeeRecipient = recipient;
        emit PerformanceFeeRecipientUpdated(recipient, block.timestamp);
    }

    function setProtocolFeeConfig(address revenuePool_, uint16 protocolFeeShareBps_) external {
        _onlyGovernor();
        if (protocolFeeShareBps_ > 10_000) revert FeeTooHigh(protocolFeeShareBps_);
        if (protocolFeeShareBps_ > 0 && revenuePool_ == address(0)) revert InvalidFeeRecipient();
        address old = revenuePool;
        revenuePool = revenuePool_;
        protocolFeeShareBps = protocolFeeShareBps_;
        emit ProtocolFeeConfigSet(old, revenuePool_, protocolFeeShareBps_, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Internal share getters (for subclasses)
    // -----------------------------------------------------------------------

    function _getShareBalance(address account) internal view returns (uint256) {
        return _shareBalance[account];
    }

    function _getTotalShares() internal view returns (uint256) {
        return _totalShares;
    }
}
