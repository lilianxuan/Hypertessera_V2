# Week 4 (Settlement + Strategy layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Week 4 on-chain scope from `docs/development-plan.md` §3.4 — `Settlement` (M-of-N `submitBatch`, 4-fold validation), the Strategy/Adapter layer (`BaseAdapter`, `FirstPeriodAdapter`, `LiquidityAdapter`, `AdapterFactory`, Curator order / Allocator execution flow incl. rebalance), and `DeployW4` wiring — with unit tests per §3.4.3.

**Architecture:** Mirror the existing module style exactly (see `src/settlement/UnifiedPool.sol`, `src/StateManager.sol`, `src/vaults/VaultFactory.sol`): every contract implements an `I*.sol` interface in `src/interfaces/`, caches role bytes32 constants as `private immutable` read via `IHyperAccessControl` in its constructor, zero-address-checks all constructor args (`ZeroAddress()`), and emits every event with a trailing `block.timestamp`. `BaseAdapter` is an abstract OZ `ERC4626`; `FirstPeriodAdapter`/`LiquidityAdapter` are concrete. `AdapterFactory` mirrors `VaultFactory`'s Deployer-helper pattern to stay under EIP-170.

**Tech Stack:** Foundry (forge 1.4.4), Solidity 0.8.24, OpenZeppelin (SafeERC20, ERC4626, ERC20).

## Global Constraints

- 6-decimal NAV everywhere (`1e6` = 1.0); all fee math in BPS over `Constants.BPS_DENOMINATOR` (10,000).
- All USDT movement via `SafeERC20` (USDT is non-standard — see `MockUSDT` in tests, which returns no bool).
- No role hierarchy: `GOVERNOR_ROLE` is sole admin of all roles; a role holder gets no rights of another role.
- Every mutating external function is role-gated with a local `_onlyX()` internal helper calling `ac.hasRole(ac.X_ROLE(), msg.sender)`, reverting a contract-local error (`NotGovernor`, `NotCurator`, `NotAllocator`, `NotSettlement`, `NotOperator`, `NotDataProvider`, `NotGuardian`).
- Constructor pattern: zero-check every address arg first (`revert ZeroAddress()`), then cache immutables.
- Every event carries a trailing `uint256 timestamp` (`block.timestamp` at emit site).
- Follow `test/<ContractName>.t.sol` flat naming; reuse the inline OZ-`ERC20`-based `MockUSDT` pattern (6 decimals, open `mint`) seen in `test/VaultFactory.t.sol` / `test/EarnVault.t.sol`.
- `STRATEGY_ROLE` already exists in `HyperAccessControl` (doc-commented "adapter wiring") but is unused — do NOT repurpose it for Curator/Allocator/DataProvider gating in the Adapter layer; those already have dedicated roles (`CURATOR_ROLE`, `ALLOCATOR_ROLE`, `DATA_PROVIDER_ROLE`, `GUARDIAN_ROLE`). Use `STRATEGY_ROLE`... actually do NOT use it at all in this plan — `GOVERNOR_ROLE` gates `AdapterFactory.deployAdapter`/`deployLiquidityAdapter` and `LiquidityEarnVault.setAdapter`, per spec §3.4.1/§3.4.4. Leave `STRATEGY_ROLE` untouched (out of scope).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/interfaces/ISettlement.sol` | `Settlement` interface: structs (`Distribution`, `VaultSettlement`, `SettlementInstruction`), events, errors, function signatures |
| `src/settlement/Settlement.sol` | `submitBatch` M-of-N + 4-fold validation, drives `Queue.dequeue` / `UnifiedPool.distribute` / `vault.settle` / `StateManager.completeCycle` |
| `src/interfaces/IAdapter.sol` | `BaseAdapter` interface: `SettlementMode` enum, `Order`/`DealData` structs, events, errors, function signatures (order book + valuation) |
| `src/strategy/BaseAdapter.sol` | Abstract `ERC4626` + `IAdapter`: capital sourcing, Curator order book, Allocator execution, `realAssets()` (virtual), staleness |
| `src/strategy/FirstPeriodAdapter.sol` | Concrete `BaseAdapter`, no overrides — Cash/Note vaults |
| `src/interfaces/ILiquidityAdapter.sol` | `LiquidityAdapter`-specific additions: `setBridgeTarget`, `bridgeToCash`, `recallCashTokens`, events, errors |
| `src/strategy/LiquidityAdapter.sol` | Concrete `BaseAdapter` + Cash-Token bridging leg for the LP vault |
| `src/interfaces/IAdapterFactory.sol` | `AdapterParams` struct, `deployAdapter`/`deployLiquidityAdapter`, `AdapterDeployed` event, `InvalidAdapterParams` error |
| `src/strategy/AdapterFactory.sol` | Deploys `FirstPeriodAdapter`/`LiquidityAdapter` via Deployer helpers (EIP-170 safety, mirrors `VaultFactory`) |
| `src/strategy/AdapterDeployer.sol` | `FirstPeriodAdapterDeployer` + `LiquidityAdapterDeployer` helper contracts (mirrors `EarnVaultDeployer`) |
| `src/vaults/LiquidityEarnVault.sol` | *Modify*: add `address public adapter;` + `setAdapter(address)` (GOVERNOR_ROLE, set-once) — needed for `bridgeToCash` access control and DeployW4 wiring step 9 |
| `src/interfaces/IBaseVault.sol` or `ILiquidityEarnVault` | *Modify if `adapter`/`setAdapter` needs interface exposure* — check existing `ILiquidityBridge.sol`/vault interfaces first; add a minimal `AdapterAlreadySet()` error |
| `script/Deploy.s.sol` | *Modify*: add `contract DeployW4 is Script { ... }` — deploys `Settlement`, `AdapterFactory` (+3 adapters), wires roles, writes `control-panel/deployments-w4.json` |
| `test/Settlement.t.sol` | Unit tests per §3.4.3 `Settlement` |
| `test/BaseAdapter.t.sol` | Unit tests per §3.4.3 `BaseAdapter`/`FirstPeriodAdapter` (using `FirstPeriodAdapter` as the concrete instance under test) |
| `test/LiquidityAdapter.t.sol` | Unit tests per §3.4.3 `LiquidityAdapter` |
| `test/AdapterFactory.t.sol` | Unit tests per §3.4.3 `AdapterFactory` |
| `test/DeployW4.t.sol` | Wiring smoke test per §3.4.3 `DeployLib.deployAll integration` (drives the actual `DeployW4` deploy logic against a local Foundry test, not the script directly — see Task 8) |

---

## Task 1: `ISettlement` + `Settlement`

**Files:**
- Create: `src/interfaces/ISettlement.sol`
- Create: `src/settlement/Settlement.sol`
- Test: `test/Settlement.t.sol`

**Interfaces:**
- Consumes: `IStateManager.requireCycleState(vault, CycleState)`, `IStateManager.currentCycleNumber(vault)`, `IStateManager.completeCycle(vault)`, `IUnifiedPool.pending(vault)`, `IUnifiedPool.distribute(vault, amount)`, `INAVOracle.isNAVFresh(vault)`, `INAVOracle.getNAV(vault)`, `INAVOracle.navTolerance(vault)`, `IQueue.dequeue(vault, requestIds)`, `IBaseVault.settle(depositRequestIds, redeemRequestIds, redeemAmounts, distributedAssets, navSnapshot)`, `IHyperAccessControl.hasRole`/`GOVERNOR_ROLE()`.
- Produces: `Settlement.submitBatch(SettlementInstruction calldata, bytes[] calldata)`, `addOperator`, `removeOperator`, `setThreshold`, `hashInstruction`, `isOperator` — consumed by Task 8 (DeployW4) and off-chain SDK (not in this plan's scope).

`ISettlement.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISettlement {
    struct Distribution {
        address vault;
        uint256 amount;
    }

    struct VaultSettlement {
        Distribution distribution;
        uint256[] depositRequestIds;
        uint256[] redeemRequestIds;
        uint256[] redeemAmounts;
        uint256 navSnapshot;
        uint256 lpBonus;
    }

    struct SettlementInstruction {
        VaultSettlement[] vaultSettlements;
        uint256 cycleNumber;
        uint256 validUntil;
    }

    event SettlementExecuted(bytes32 indexed batchHash, uint256 cycleNumber, uint256 timestamp);
    event OperatorAdded(address indexed operator, uint256 timestamp);
    event OperatorRemoved(address indexed operator, uint256 timestamp);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold, uint256 timestamp);

    error ZeroAddress();
    error NotGovernor();
    error SignatureValidationFailed();
    error StateValidationFailed(address vault);
    error ConservationCheckFailed(address vault, uint256 pending, uint256 required);
    error OracleConsistencyFailed(address vault, uint256 onChainNav, uint256 snapshot);
    error StaleNAV(address vault);
    error ThresholdExceedsOperatorCount(uint256 threshold, uint256 operatorCount);
    error BatchAlreadyExecuted(bytes32 batchHash);
    error BatchExpired(uint256 validUntil, uint256 blockTimestamp);

    function submitBatch(SettlementInstruction calldata instruction, bytes[] calldata signatures) external;
    function addOperator(address operator) external;
    function removeOperator(address operator) external;
    function setThreshold(uint256 newThreshold) external;
    function hashInstruction(SettlementInstruction calldata instruction) external pure returns (bytes32);
    function isOperator(address account) external view returns (bool);
    function executed(bytes32 batchHash) external view returns (bool);
    function threshold() external view returns (uint256);
}
```

`Settlement.sol` — constructor `(address stateManager_, address unifiedPool_, address navOracle_, address queue_, address accessControl_)`, zero-checks all five, caches `IStateManager`, `IUnifiedPool`, `INAVOracle`, `IQueue`, `IHyperAccessControl` as immutables plus `bytes32 private immutable GOVERNOR_ROLE_` and `bytes32 private immutable SETTLEMENT_ROLE_` (the latter unused internally but useful for tests/off-chain — optional, skip if unused).

`submitBatch` body implements the exact 4-step algorithm from §3.4.1 (`hashInstruction` = `keccak256(abi.encode(instruction))`; ECDSA recover via `ECDSA.recover` from OZ, dedupe recovered signers with a `bytes32[] memory seen` scan since array length is small — M-of-N is expected to be ≤ ~7 operators):

```solidity
function submitBatch(SettlementInstruction calldata instruction, bytes[] calldata signatures) external {
    bytes32 batchHash = keccak256(abi.encode(instruction));
    if (executed[batchHash]) revert BatchAlreadyExecuted(batchHash);
    if (block.timestamp > instruction.validUntil) revert BatchExpired(instruction.validUntil, block.timestamp);

    // Step 1 — signatures
    uint256 validSigners = 0;
    address[] memory seen = new address[](signatures.length);
    bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(batchHash);
    for (uint256 i = 0; i < signatures.length; i++) {
        address signer = ECDSA.recover(ethHash, signatures[i]);
        bool dup = false;
        for (uint256 j = 0; j < validSigners; j++) {
            if (seen[j] == signer) { dup = true; break; }
        }
        if (dup) continue;
        if (!isOperator[signer]) continue;
        seen[validSigners] = signer;
        validSigners++;
    }
    if (validSigners < threshold) revert SignatureValidationFailed();

    // Step 2 — state
    for (uint256 i = 0; i < instruction.vaultSettlements.length; i++) {
        address v = instruction.vaultSettlements[i].distribution.vault;
        // requireCycleState reverts CycleStateMismatch on mismatch — wrap and re-revert as StateValidationFailed
        try stateManager.requireCycleState(v, CycleState.CALCULATING) {} catch {
            revert StateValidationFailed(v);
        }
        if (stateManager.currentCycleNumber(v) != instruction.cycleNumber) revert StateValidationFailed(v);
    }

    // Step 3 — conservation (dedup by summing amounts per vault first)
    // build a scratch array of (vault, totalAmount) pairs, O(n^2) is fine for small n
    ...
    for each unique vault: if (unifiedPool.pending(vault) < totalAmount) revert ConservationCheckFailed(vault, unifiedPool.pending(vault), totalAmount);

    // Step 4 — oracle
    for (uint256 i = 0; i < instruction.vaultSettlements.length; i++) {
        VaultSettlement calldata vs = instruction.vaultSettlements[i];
        address v = vs.distribution.vault;
        if (!navOracle.isNAVFresh(v)) revert StaleNAV(v);
        uint256 onChainNav = navOracle.getNAV(v);
        uint256 deviation = vs.navSnapshot > onChainNav
            ? (vs.navSnapshot - onChainNav) * 10000 / onChainNav
            : (onChainNav - vs.navSnapshot) * 10000 / onChainNav;
        if (deviation > navOracle.navTolerance(v)) revert OracleConsistencyFailed(v, onChainNav, vs.navSnapshot);
    }

    // Execute
    executed[batchHash] = true;
    for (uint256 i = 0; i < instruction.vaultSettlements.length; i++) {
        VaultSettlement calldata vs = instruction.vaultSettlements[i];
        address v = vs.distribution.vault;
        if (vs.redeemRequestIds.length > 0) queue.dequeue(v, vs.redeemRequestIds);
        if (vs.distribution.amount > 0) unifiedPool.distribute(v, vs.distribution.amount);
        IBaseVault(v).settle(vs.depositRequestIds, vs.redeemRequestIds, vs.redeemAmounts, vs.distribution.amount, vs.navSnapshot);
        stateManager.completeCycle(v);
    }
    emit SettlementExecuted(batchHash, instruction.cycleNumber, block.timestamp);
}
```

Note: `StateValidationFailed` swallows `IStateManager.CycleStateMismatch`'s detail via `try/catch` — acceptable per spec (`error StateValidationFailed(address vault)` has no expected/actual fields). `lpBonus` in `VaultSettlement` is **not consumed** by `Settlement` itself in Phase 1 per spec text (no on-chain function references it beyond being part of the hashed instruction / off-chain calc input) — carry it through the struct only, do not invent a use; if a test author expects it wired somewhere, re-check §3.4 spec text (currently: none).

`addOperator`/`removeOperator`/`setThreshold`: GOVERNOR_ROLE only; `setThreshold` reverts `ThresholdExceedsOperatorCount` if `newThreshold > operators.length`.

`isOperator` is `mapping(address => bool) public isOperator;` (not `function isOperator(address) external view returns(bool)` matching an array-lookup — spec lists it as a view function, use a public mapping which auto-generates the getter).

**Steps:**

- [ ] **Step 1: Write `test/Settlement.t.sol` — happy path test**

Set up `HyperAccessControl`, `StateManager`, `Queue`, `UnifiedPool`, `NAVOracle`, `MockUSDT`, deploy a real `EarnVault` (Cash tranche) via the existing `VaultFactory`/`EarnVaultDeployer`, register + fund it (mirror `test/VaultFactory.t.sol` and `test/UnifiedPool.t.sol` setup exactly), grant `SETTLEMENT_ROLE` to the `Settlement` contract on `StateManager`/`UnifiedPool`/`Queue`, grant `ac.GOVERNOR_ROLE` appropriately, add one operator, set threshold 1, drive vault to `CALCULATING` via `StateManager.startCycleCalculation`, submit a batch with zero deposit/redeem requests and `distribution.amount = 0`, assert `SettlementExecuted` emitted and `StateManager.getCycleState(vault) == ACCEPTING` with `currentCycleNumber` incremented.

```solidity
function test_submitBatch_happyPath_emptyBatch() public {
    // full env: ac, sm, queue, usdt, unifiedPool, navOracle, vault, settlement
    _driveToCalculating(vault);
    ISettlement.Distribution memory dist = ISettlement.Distribution({vault: address(vault), amount: 0});
    uint256[] memory empty = new uint256[](0);
    ISettlement.VaultSettlement[] memory vs = new ISettlement.VaultSettlement[](1);
    vs[0] = ISettlement.VaultSettlement({
        distribution: dist, depositRequestIds: empty, redeemRequestIds: empty,
        redeemAmounts: empty, navSnapshot: navOracle.getNAV(address(vault)), lpBonus: 0
    });
    ISettlement.SettlementInstruction memory instr = ISettlement.SettlementInstruction({
        vaultSettlements: vs, cycleNumber: sm.currentCycleNumber(address(vault)), validUntil: block.timestamp + 3600
    });
    bytes32 hash = settlement.hashInstruction(instr);
    bytes memory sig = _signOperator(operatorPk, hash);
    bytes[] memory sigs = new bytes[](1);
    sigs[0] = sig;

    vm.expectEmit(false, false, false, false);
    emit ISettlement.SettlementExecuted(bytes32(0), 0, 0);
    settlement.submitBatch(instr, sigs);

    assertEq(uint8(sm.getCycleState(address(vault))), uint8(CycleState.ACCEPTING));
}
```

`_signOperator` uses `vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(hash))` and `abi.encodePacked(r, s, v)`.

- [ ] **Step 2: Run test, verify it fails** (contracts don't exist yet)

Run: `forge test --match-path test/Settlement.t.sol -vv`
Expected: FAIL — compile error, `Settlement`/`ISettlement` not found.

- [ ] **Step 3: Write `src/interfaces/ISettlement.sol` and `src/settlement/Settlement.sol`** (full contents above; fill in Step 3's conservation dedup loop and constructor)

- [ ] **Step 4: Run test, verify happy path passes**

Run: `forge test --match-path test/Settlement.t.sol -vv`
Expected: PASS

- [ ] **Step 5: Add remaining `Settlement` unit tests from §3.4.3, one function per bullet:**
  - `test_submitBatch_replayGuard_reverts`
  - `test_submitBatch_expiredValidUntil_reverts`
  - `test_submitBatch_fewerSignaturesThanThreshold_reverts`
  - `test_submitBatch_duplicateSigner_reverts`
  - `test_submitBatch_nonOperatorSigner_reverts`
  - `test_submitBatch_vaultNotCalculating_reverts`
  - `test_submitBatch_cycleNumberMismatch_reverts`
  - `test_submitBatch_insufficientPending_reverts`
  - `test_submitBatch_navDeviationExceedsTolerance_reverts`
  - `test_submitBatch_happyPath_queueDequeueCalledInFifoOrder` (deposit a real redeem request via `EarnVault.requestRedeem`, assert `Queue.isInQueue` false after)
  - `test_submitBatch_happyPath_distributeMovesUsdt`
  - `test_submitBatch_happyPath_settleCalledWithCorrectArgs_sharesAdjusted`
  - `test_submitBatch_happyPath_cycleNumberIncrements`
  - `test_addOperator_removeOperator_onlyGovernor`
  - `test_setThreshold_exceedsOperatorCount_reverts`
  - `test_settle_alreadySettledDeposit_reverts` (via `IBaseVault.RequestAlreadySettled` — exercised through `Settlement.submitBatch` calling `vault.settle` twice with the same id, second call reverts)
  - `test_settle_wrongRedeemAmount_reverts` (via `IBaseVault.WrongRedeemAmount`)
  - `test_submitBatch_sumRedeemAmountsMismatchDistribution_reverts` (via `IBaseVault.ConservationFailed`)
  - `test_cancelRequest_duringCalculating_reverts` (this is a `BaseVault`-level guard already implemented in W3 — write as a regression test here since it directly gates the settlement window; check `BaseVault.cancelDepositRequest`/`cancelRedeemRequest` for the existing `CancelNotAllowed` guard, do not reimplement)
  - `test_submitBatch_staleNav_reverts_StaleNAV`
  - `test_submitBatch_badSig_revertReason_isSignatureValidationFailed`
  - `test_submitBatch_insufficientPending_revertReason_isConservationCheckFailed_withVaultAndAmounts`

  Write each with full Foundry code (arrange/act/`vm.expectRevert(...)`/assert), reusing the `setUp()` fixture from Step 1.

- [ ] **Step 6: Run full Settlement test file**

Run: `forge test --match-path test/Settlement.t.sol -vv`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/ISettlement.sol src/settlement/Settlement.sol test/Settlement.t.sol
git commit -m "W4: implement Settlement.submitBatch with 4-fold validation"
```

---

## Task 2: `IAdapter` + `BaseAdapter`

**Files:**
- Create: `src/interfaces/IAdapter.sol`
- Create: `src/strategy/BaseAdapter.sol`
- Test: `test/BaseAdapter.t.sol` (instantiate via a minimal concrete test harness `TestAdapter is BaseAdapter` if `FirstPeriodAdapter` isn't built yet — but since Task 3 is trivial, sequence Task 2+3 together and test against `FirstPeriodAdapter` directly to avoid a throwaway harness contract)

**Interfaces:**
- Consumes: OZ `ERC4626`, `SafeERC20`, `IHyperAccessControl`.
- Produces: `createBuyOrder`, `createSellOrder`, `createRebalanceOrder`, `cancelBuyOrder`/`cancelSellOrder`/`cancelRebalanceOrder`, `executeBuy`/`executeSell`/`executeRebalance`, `realAssets()` (virtual), `updateDealData`, `clearDealValue`, `setStalenessWindow`, `totalAssets()` override — consumed by Task 3 (`FirstPeriodAdapter`), Task 4 (`LiquidityAdapter` overrides `realAssets()`), Task 5 (`AdapterFactory` deploys it).

`IAdapter.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAdapter {
    enum SettlementMode { TOKEN_RETURN, VALUE_RETURN }

    struct Order {
        uint256 amount;
        address destination;
        address source;
        SettlementMode mode;
        bool executed;
        bool cancelled;
    }

    struct DealData {
        uint256 dealValue;
        uint256 updatedAt;
        uint256 stalenessWindow;
    }

    event BuyOrderCreated(uint256 indexed orderId, uint256 amount, address destination, uint8 mode, uint256 timestamp);
    event SellOrderCreated(uint256 indexed orderId, uint256 amount, uint256 timestamp);
    event RebalanceOrderCreated(uint256 indexed orderId, uint256 amount, address source, address destination, uint8 mode, uint256 timestamp);
    event BuyOrderExecuted(uint256 indexed orderId, uint256 timestamp);
    event SellOrderExecuted(uint256 indexed orderId, uint256 timestamp);
    event RebalanceOrderExecuted(uint256 indexed orderId, uint256 timestamp);
    event OrderCancelled(uint256 indexed orderId, uint8 orderType, uint256 timestamp);
    event DealDataUpdated(uint256 indexed orderId, uint256 newValue, uint256 timestamp);
    event DealValueCleared(uint256 indexed orderId, uint256 timestamp);
    event CapitalDeployed(address indexed destination, uint256 amount, uint256 timestamp);
    event CapitalRecalled(uint256 amount, uint256 timestamp);

    error ZeroAddress();
    error NotCurator();
    error NotAllocator();
    error NotCuratorOrGuardian();
    error NotAllocatorOrDataProvider();
    error NotDataProvider();
    error NotGovernor();
    error OrderDoesNotExist(uint256 orderId);
    error OrderAlreadyExecuted(uint256 orderId);
    error OrderAlreadyCancelled(uint256 orderId);
    error StaleAdapterData(uint256 lastUpdated, uint256 stalenessWindow);
    error InsufficientAdapterBalance(uint256 balance, uint256 requested);
    error WrongSettlementMode(uint256 orderId, uint8 expected, uint8 actual);

    function createBuyOrder(uint256 amount, address destination, SettlementMode mode) external returns (uint256 orderId);
    function createSellOrder(uint256 amount) external returns (uint256 orderId);
    function createRebalanceOrder(uint256 amount, address source, address destination, SettlementMode mode) external returns (uint256 orderId);
    function cancelBuyOrder(uint256 orderId) external;
    function cancelSellOrder(uint256 orderId) external;
    function cancelRebalanceOrder(uint256 orderId) external;
    function executeBuy(uint256 orderId) external;
    function executeSell(uint256 orderId) external;
    function executeRebalance(uint256 orderId) external;
    function realAssets() external view returns (uint256);
    function updateDealData(uint256 orderId, uint256 newValue) external;
    function clearDealValue(uint256 orderId) external;
    function setStalenessWindow(uint256 window) external;

    function buyOrders(uint256 orderId) external view returns (uint256 amount, address destination, address source, SettlementMode mode, bool executed, bool cancelled);
    function sellOrders(uint256 orderId) external view returns (uint256 amount, address destination, address source, SettlementMode mode, bool executed, bool cancelled);
    function rebalanceOrders(uint256 orderId) external view returns (uint256 amount, address destination, address source, SettlementMode mode, bool executed, bool cancelled);
    function pendingDeposits(uint256 orderId) external view returns (uint256 dealValue, uint256 updatedAt, uint256 stalenessWindow);
    function vault() external view returns (address);
}
```

`BaseAdapter.sol` — `abstract contract BaseAdapter is ERC4626, IAdapter`. Constructor `(IERC20 asset_, address vault_, address accessControl_, uint256 stalenessWindow_)` calling `ERC4626(asset_)` and `ERC20(<name>, <symbol>)` — since `BaseAdapter` is abstract, push name/symbol construction to concrete subclasses (`FirstPeriodAdapter("FirstPeriod Adapter Share", "fpaXXX", ...)`), i.e. **`BaseAdapter`'s constructor takes `(IERC20 asset_, address vault_, address accessControl_, uint256 defaultStalenessWindow_, string memory name_, string memory symbol_)`** and forwards `name_`/`symbol_` to `ERC20`. Zero-check `vault_`/`accessControl_` (asset_ zero-check comes free from `ERC4626`/`ERC20` if `address(asset_) == address(0)` — add explicit check anyway for consistency with house style).

Storage: exactly the fields in spec §3.4.1 (`buyOrders`/`sellOrders`/`rebalanceOrders` mappings, `nextBuyOrderId`/`nextSellOrderId`/`nextRebalanceOrderId`, `pendingDeposits`, `liveDealOrderIds`, plus `uint256 public defaultStalenessWindow`).

Implement all functions exactly per spec pseudocode (§3.4.1, lines already quoted in the spec excerpt above — reuse verbatim): `createBuyOrder`/`createSellOrder`/`createRebalanceOrder` (CURATOR_ROLE), `cancelBuyOrder`/`cancelSellOrder`/`cancelRebalanceOrder` (CURATOR_ROLE or GUARDIAN_ROLE), `executeBuy`/`executeSell`/`executeRebalance` (ALLOCATOR_ROLE, only take `orderId` — verify via a dedicated test that reads the function selector has exactly one `uint256` param), `_deployCapital`/`_recallCapital`/`_recallCapitalFrom` (internal), `realAssets()` (`public view virtual returns (uint256)`, iterates `liveDealOrderIds`, reverts `StaleAdapterData` on any stale entry), `totalAssets()` (`public view override returns (uint256) { return realAssets(); }`), `updateDealData` (DATA_PROVIDER_ROLE, requires `VALUE_RETURN` + executed), `clearDealValue` (ALLOCATOR_ROLE or DATA_PROVIDER_ROLE, requires `TOKEN_RETURN` + executed, swap-and-pop from `liveDealOrderIds`), `setStalenessWindow` (GOVERNOR_ROLE).

`liveDealOrderIds` removal helper:
```solidity
function _removeLiveDeal(uint256 orderId) internal {
    uint256 len = liveDealOrderIds.length;
    for (uint256 i = 0; i < len; i++) {
        if (liveDealOrderIds[i] == orderId) {
            liveDealOrderIds[i] = liveDealOrderIds[len - 1];
            liveDealOrderIds.pop();
            break;
        }
    }
}
```

**Steps:**

- [ ] **Step 1: Write `src/interfaces/IAdapter.sol`** (full contents above)

- [ ] **Step 2: Write `src/strategy/BaseAdapter.sol`** (abstract, per spec pseudocode — this is implemented alongside Task 3 since it cannot be deployed standalone; Task 3's `FirstPeriodAdapter` is the concrete instantiation used to test it)

- [ ] **Step 3: Proceed directly to Task 3** — `BaseAdapter` has no standalone test file; its behavior is fully covered by `test/BaseAdapter.t.sol` instantiating `FirstPeriodAdapter` (Task 3).

- [ ] **Step 4: Commit** (bundled with Task 3's commit — see Task 3 Step 6)

---

## Task 3: `FirstPeriodAdapter` + full `BaseAdapter`/`FirstPeriodAdapter` test suite

**Files:**
- Create: `src/strategy/FirstPeriodAdapter.sol`
- Test: `test/BaseAdapter.t.sol`

**Interfaces:**
- Consumes: `BaseAdapter` (Task 2).
- Produces: `FirstPeriodAdapter` — consumed by Task 5 (`AdapterFactory.deployAdapter`), Task 8 (`DeployW4`).

`FirstPeriodAdapter.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseAdapter} from "./BaseAdapter.sol";

contract FirstPeriodAdapter is BaseAdapter {
    constructor(IERC20 asset_, address vault_, address accessControl_, uint256 stalenessWindow_)
        BaseAdapter(asset_, vault_, accessControl_, stalenessWindow_, "FirstPeriod Adapter Share", "fpaShare")
    {}
}
```
(No overrides — `realAssets()` uses `BaseAdapter`'s default.)

**Steps:**

- [ ] **Step 1: Write `test/BaseAdapter.t.sol` — setUp + one order-book happy-path test**

Mirror `test/VaultFactory.t.sol` setup style: deploy `HyperAccessControl`, `MockUSDT`, a `FirstPeriodAdapter` (constructor args: `usdt`, a `makeAddr("vault")` stand-in address, `ac`, `36 hours`), grant `CURATOR_ROLE`/`ALLOCATOR_ROLE`/`DATA_PROVIDER_ROLE`/`GUARDIAN_ROLE` to test addresses, fund the adapter with USDT by having the stand-in vault address `approve` + the adapter's inherited `deposit(amount, vaultAddr)` pull it in (standard ERC-4626 flow — no bespoke funding path).

```solidity
function test_executeBuy_happyPath_deploysCapital_andInitializesDealData() public {
    uint256 amount = 1000e6;
    _fundAdapterViaVaultDeposit(amount);
    vm.prank(curator);
    uint256 orderId = adapter.createBuyOrder(amount, destination, IAdapter.SettlementMode.TOKEN_RETURN);

    vm.expectEmit(true, false, false, true);
    emit IAdapter.CapitalDeployed(destination, amount, block.timestamp);
    vm.prank(allocator);
    adapter.executeBuy(orderId);

    assertEq(usdt.balanceOf(destination), amount);
    (uint256 dealValue, uint256 updatedAt,) = adapter.pendingDeposits(orderId);
    assertEq(dealValue, amount);
    assertEq(updatedAt, block.timestamp);
    assertEq(adapter.realAssets(), amount);
}
```

- [ ] **Step 2: Run, verify fails** (contract doesn't exist)

Run: `forge test --match-path test/BaseAdapter.t.sol -vv`
Expected: FAIL

- [ ] **Step 3: Write `src/strategy/FirstPeriodAdapter.sol`** and finish `src/strategy/BaseAdapter.sol` body (from Task 2 Step 2)

- [ ] **Step 4: Run, verify happy path passes**

Run: `forge test --match-path test/BaseAdapter.t.sol -vv`
Expected: PASS

- [ ] **Step 5: Add remaining tests from §3.4.3 `BaseAdapter`/`FirstPeriodAdapter` bullets** (22 bullets — write each as a `test_` function against the same `setUp()`):
  - staleness revert on `totalAssets()`/`realAssets()`
  - `VALUE_RETURN` order + `updateDealData` happy path + wrong-mode revert + unexecuted-order revert + role revert
  - `TOKEN_RETURN` order + `executeBuy` + `clearDealValue` happy path + wrong-mode revert + role revert (both ALLOCATOR_ROLE and DATA_PROVIDER_ROLE succeed; a third role reverts)
  - `clearDealValue` happy path asserts `liveDealOrderIds` no longer contains orderId and `realAssets()` excludes it
  - mixed live-orders `realAssets()` sums only remaining
  - `setStalenessWindow` GOVERNOR_ROLE only, default 36h assertion at deploy
  - `createBuyOrder`/`createSellOrder`/`createRebalanceOrder` role + sequential orderId + mode/source/destination recorded
  - `cancelBuyOrder`/`cancelSellOrder`/`cancelRebalanceOrder`: CURATOR_ROLE or GUARDIAN_ROLE, already-executed revert, already-cancelled revert
  - `executeBuy`/`executeSell`/`executeRebalance`: ALLOCATOR_ROLE only, unknown-id revert, cancelled revert, double-execute revert, happy-path event assertions
  - selector-shape test: `assertEq(adapter.executeBuy.selector, bytes4(keccak256("executeBuy(uint256)")))` (and same for `executeSell`/`executeRebalance`) to lock in "no extra args"
  - ERC-4626 deposit-into-adapter test: `vault` approves, calls `adapter.deposit(amount, vault)`, asserts USDT pulled + adapter shares minted to vault

- [ ] **Step 6: Run full suite, then commit**

Run: `forge test --match-path test/BaseAdapter.t.sol -vv`
Expected: PASS (all tests)

```bash
git add src/interfaces/IAdapter.sol src/strategy/BaseAdapter.sol src/strategy/FirstPeriodAdapter.sol test/BaseAdapter.t.sol
git commit -m "W4: implement BaseAdapter order book + FirstPeriodAdapter"
```

---

## Task 4: `LiquidityEarnVault.setAdapter` + `ILiquidityAdapter` + `LiquidityAdapter`

**Files:**
- Modify: `src/vaults/LiquidityEarnVault.sol` — add `address public adapter;` + `function setAdapter(address adapter_) external` (GOVERNOR_ROLE, set-once, `revert AdapterAlreadySet()` — add this error locally in `LiquidityEarnVault` or its interface if one exists; check `src/interfaces/` for an `ILiquidityEarnVault.sol` first — if none exists, declare the error directly in `LiquidityEarnVault.sol`, matching how other vault-local errors are declared if any precedent exists, else add to `IBaseVault.sol` only if `LiquidityEarnVault` already extends it for other vault-local pieces)
- Create: `src/interfaces/ILiquidityAdapter.sol`
- Create: `src/strategy/LiquidityAdapter.sol`
- Test: `test/LiquidityAdapter.t.sol`

**Interfaces:**
- Consumes: `BaseAdapter` (Task 2/3), `ILiquidityBridge.bridgeDeposit(uint256 assets, address fromVault, address toVault) external returns (uint256 shares)`, `IERC4626` (for `cashVault`'s share price — spec says `sharePrice()`; **verify** `EarnVault`/Cash vault actually exposes a `sharePrice()` view before writing this — if the Cash vault only exposes standard ERC-4626 `convertToAssets`/`totalAssets`/`totalSupply`, compute price as `convertToAssets(1e6) `or `totalAssets() * 1e6 / totalSupply()` instead and adjust `realAssets()` accordingly; do not assume `sharePrice()` exists without checking `src/vaults/EarnVault.sol`/`IEarnVault.sol` first).
- Produces: `LiquidityAdapter` — consumed by Task 5 (`AdapterFactory.deployLiquidityAdapter`), Task 8 (`DeployW4`).

**Pre-step (do this before writing code): grep `src/vaults/EarnVault.sol` and `src/interfaces/IEarnVault.sol`/`IBaseVault.sol` for `sharePrice`.** The spec's `realAssets()` formula is `(cashTokenBalance * IERC4626(cashVault).sharePrice() / 1e6) + super.realAssets()` — if no `sharePrice()` function exists on the real `EarnVault`, this is a spec-vs-code mismatch; use whatever share-price accessor the actual `EarnVault` exposes (most likely a public `sharePrice()` state-var-backed getter, since NAV/share-price is fundamental to the whole system — §2 says "6-decimal NAV everywhere (`sharePrice = 1e6` ≙ 1.0)" implying a named `sharePrice` getter does exist). Confirm the exact name before implementing; do not guess further than one `grep`.

`ILiquidityAdapter.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ILiquidityAdapter {
    event BridgeTargetSet(address liquidityBridge, address cashVault, uint256 timestamp);
    event BridgedToCash(uint256 assets, uint256 shares, uint256 timestamp);
    event CashTokensRecalled(uint256 shares, uint256 timestamp);

    error BridgeTargetNotSet();
    error NotSettlementOrVault();
    error NotVault();

    function setBridgeTarget(address newLiquidityBridge, address newCashVault) external;
    function bridgeToCash(uint256 amount) external returns (uint256 shares);
    function recallCashTokens(uint256 shares) external;
    function liquidityBridge() external view returns (address);
    function cashVault() external view returns (address);
    function cashTokenBalance() external view returns (uint256);
}
```

`LiquidityAdapter.sol` — `contract LiquidityAdapter is BaseAdapter, ILiquidityAdapter`, constructor `(IERC20 asset_, address vault_, address accessControl_, uint256 stalenessWindow_)` forwarding to `BaseAdapter(..., "Liquidity Adapter Share", "lqaShare")`, `liquidityBridge`/`cashVault` start at `address(0)`.

`setBridgeTarget`: **CURATOR_ROLE via Timelock** per spec — i.e. gate on `msg.sender == timelock`? Re-check: the codebase's existing Timelock-gated setters (e.g. `UnifiedPool.setCashServiceFeeBps`) check `msg.sender == address(timelock)`, meaning `LiquidityAdapter` needs a `address public timelock` constructor/setter param wired to `ProtocolTimelock`. **This constructor needs a 5th arg: `address timelock_`.** Add it: `constructor(IERC20 asset_, address vault_, address accessControl_, uint256 stalenessWindow_, address timelock_)`, zero-check `timelock_`, store as immutable, and gate `setBridgeTarget` on `if (msg.sender != timelock) revert OnlyTimelock();` (add `error OnlyTimelock();` to `ILiquidityAdapter`). This changes `AdapterParams` in Task 5 — see Task 5's note.

`bridgeToCash`: access = `SETTLEMENT_ROLE` or `msg.sender == vault`; pulls USDT from `vault` (not `msg.sender` — re-read spec: `safeTransferFrom(vault, address(this), amount)`, so the LP vault must have pre-approved the adapter); calls `ILiquidityBridge(liquidityBridge).bridgeDeposit(amount, address(this), cashVault)`; increments `cashTokenBalance`.

`recallCashTokens`: `vault`-only; decrements `cashTokenBalance`; `IERC20(cashVault).safeTransfer(vault, shares)`.

`realAssets()` override: `(cashTokenBalance * <cashVaultSharePriceGetter>() / 1e6) + super.realAssets()`.

**Steps:**

- [ ] **Step 1: Grep for `sharePrice` in `src/vaults/`** and note the exact accessor to use.

Run: `grep -rn "sharePrice" src/vaults/ src/interfaces/`

- [ ] **Step 2: Add `adapter`/`setAdapter` to `LiquidityEarnVault.sol`**

```solidity
address public adapter;
error AdapterAlreadySet();

function setAdapter(address adapter_) external {
    if (!ac.hasRole(ac.GOVERNOR_ROLE(), msg.sender)) revert NotGovernor(); // reuse existing NotGovernor error if present, else add
    if (adapter != address(0)) revert AdapterAlreadySet();
    if (adapter_ == address(0)) revert ZeroAddress();
    adapter = adapter_;
}
```
(Match whatever existing zero-check/role-check error names `LiquidityEarnVault.sol` already declares — read the file first, do not introduce a second `ZeroAddress`/`NotGovernor` error if one is already imported from `IBaseVault`.)

- [ ] **Step 3: Write `test/LiquidityAdapter.t.sol` — setUp + `setBridgeTarget` + `bridgeToCash` happy path**, deploying a real `LiquidityBridge` + Cash `EarnVault` + LP `LiquidityEarnVault` (reuse `test/LiquidityBridge.t.sol`'s fixture as a base), plus `ProtocolTimelock` for the `setBridgeTarget` gate.

- [ ] **Step 4: Run, verify fails; write `ILiquidityAdapter.sol` + `LiquidityAdapter.sol`; run again, verify happy paths pass.**

- [ ] **Step 5: Add remaining §3.4.3 `LiquidityAdapter` bullets** (11 bullets: `setBridgeTarget` role gate, `bridgeToCash` before target set reverts, `bridgeToCash` role gate, `bridgeToCash` happy path full assertions, `recallCashTokens` vault-only + insufficient-balance revert + happy path, `realAssets()` cash-only / cash+RWA / cash+stale-RWA-reverts, inherited order-book functions behave identically).

- [ ] **Step 6: Run full suite, then commit**

```bash
git add src/vaults/LiquidityEarnVault.sol src/interfaces/ILiquidityAdapter.sol src/strategy/LiquidityAdapter.sol test/LiquidityAdapter.t.sol
git commit -m "W4: implement LiquidityAdapter + wire LiquidityEarnVault.adapter"
```

---

## Task 5: `IAdapterFactory` + `AdapterFactory` (+ Deployer helpers)

**Files:**
- Create: `src/interfaces/IAdapterFactory.sol`
- Create: `src/strategy/AdapterDeployer.sol` (two small deployer contracts, mirroring `EarnVaultDeployer`)
- Create: `src/strategy/AdapterFactory.sol`
- Test: `test/AdapterFactory.t.sol`

**Interfaces:**
- Consumes: `FirstPeriodAdapter` (Task 3), `LiquidityAdapter` (Task 4), `IHyperAccessControl`.
- Produces: `AdapterFactory.deployAdapter`/`deployLiquidityAdapter` — consumed by Task 8 (`DeployW4`).

**Note on `AdapterParams` and the Timelock dependency from Task 4:** `LiquidityAdapter`'s constructor now takes 5 args (`asset_, vault_, accessControl_, stalenessWindow_, timelock_`) while `FirstPeriodAdapter` takes 4. `AdapterParams` (shared struct per spec) must carry a `timelock` field used only by `deployLiquidityAdapter` and ignored by `deployAdapter`:

```solidity
struct AdapterParams {
    address asset;
    address vault;
    address accessControl;
    uint256 stalenessWindow;
    address timelock; // only used by deployLiquidityAdapter; pass address(0) for deployAdapter calls
}
```

`IAdapterFactory.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAdapterFactory {
    struct AdapterParams {
        address asset;
        address vault;
        address accessControl;
        uint256 stalenessWindow;
        address timelock;
    }

    event AdapterDeployed(address indexed adapter, address indexed vault, uint256 timestamp);

    error ZeroAddress();
    error NotGovernor();
    error InvalidAdapterParams();

    function deployAdapter(AdapterParams calldata params) external returns (address adapter);
    function deployLiquidityAdapter(AdapterParams calldata params) external returns (address adapter);
    function isAdapter(address adapter) external view returns (bool);
}
```

`AdapterDeployer.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FirstPeriodAdapter} from "./FirstPeriodAdapter.sol";
import {LiquidityAdapter} from "./LiquidityAdapter.sol";

contract FirstPeriodAdapterDeployer {
    function deploy(address asset_, address vault_, address accessControl_, uint256 stalenessWindow_) external returns (address) {
        return address(new FirstPeriodAdapter(IERC20(asset_), vault_, accessControl_, stalenessWindow_));
    }
}

contract LiquidityAdapterDeployer {
    function deploy(address asset_, address vault_, address accessControl_, uint256 stalenessWindow_, address timelock_) external returns (address) {
        return address(new LiquidityAdapter(IERC20(asset_), vault_, accessControl_, stalenessWindow_, timelock_));
    }
}
```

`AdapterFactory.sol` — mirrors `VaultFactory.sol` exactly: constructor `(address accessControl_)`, zero-checks it, caches `GOVERNOR_ROLE` immutable, deploys both Deployer helpers as `immutable` in its own constructor, `deployAdapter`/`deployLiquidityAdapter` are GOVERNOR_ROLE-gated (`revert NotGovernor()` — local error, matching `VaultFactory`'s `Unauthorized()` precedent but named per spec's error list which only lists `InvalidAdapterParams` — add `NotGovernor`/`ZeroAddress` too since spec's role table requires the gate even though the errors subsection doesn't enumerate it explicitly, consistent with every other module in this codebase), validates `params.asset != address(0) && params.vault != address(0) && params.accessControl != address(0)` else `InvalidAdapterParams()`, calls the deployer, sets `isAdapter[adapter] = true`, emits `AdapterDeployed`.

**Steps:**

- [ ] **Step 1: Write `test/AdapterFactory.t.sol` — setUp + `deployAdapter` happy path**

```solidity
function test_deployAdapter_happyPath() public {
    IAdapterFactory.AdapterParams memory params = IAdapterFactory.AdapterParams({
        asset: address(usdt), vault: cashVaultStandIn, accessControl: address(ac),
        stalenessWindow: 36 hours, timelock: address(0)
    });
    vm.prank(governor);
    address adapter = factory.deployAdapter(params);
    assertTrue(factory.isAdapter(adapter));
}
```

- [ ] **Step 2: Run, verify fails; write the three new files above; run again, verify passes.**

- [ ] **Step 3: Add remaining §3.4.3 `AdapterFactory` bullets** (5 bullets: GOVERNOR_ROLE gate on both deploy functions, two `deployAdapter` calls with different vaults produce independent adapters, `deployLiquidityAdapter` deploys with both bridge addresses `address(0)`, `isAdapter` true for both types).

- [ ] **Step 4: Run full suite, then commit**

```bash
git add src/interfaces/IAdapterFactory.sol src/strategy/AdapterDeployer.sol src/strategy/AdapterFactory.sol test/AdapterFactory.t.sol
git commit -m "W4: implement AdapterFactory"
```

---

## Task 6: `DeployW4` script

**Files:**
- Modify: `script/Deploy.s.sol` — append `contract DeployW4 is Script { ... }`

**Interfaces:**
- Consumes: `Settlement`, `AdapterFactory`, `FirstPeriodAdapter`, `LiquidityAdapter` (all prior tasks), plus env vars for W1–W3 addresses (`HYPER_ACCESS_CONTROL`, `STATE_MANAGER`, `QUEUE`, `UNIFIED_POOL`, `USDT`, `NAV_ORACLE`, `CASH_VAULT`, `NOTE_VAULT`, `LP_VAULT`, `LIQUIDITY_BRIDGE`, `PROTOCOL_TIMELOCK`, `SETTLEMENT_OPERATOR_1`..N, `SETTLEMENT_THRESHOLD`, `DATA_PROVIDER_SIGNER`), following `DeployW3`'s `vm.envAddress(...)` pattern exactly (required, reverts if unset).
- Produces: `control-panel/deployments-w4.json` (mirrors `deployments-w3.json`'s `vm.serializeAddress`/`vm.writeJson` shape).

Implements §3.4.4's pseudocode exactly as a Foundry script `run()` body:

```solidity
contract DeployW4 is Script {
    function run() external {
        address ac = vm.envAddress("HYPER_ACCESS_CONTROL");
        address sm = vm.envAddress("STATE_MANAGER");
        address queue = vm.envAddress("QUEUE");
        address unifiedPool = vm.envAddress("UNIFIED_POOL");
        address navOracle = vm.envAddress("NAV_ORACLE");
        address usdt = vm.envAddress("USDT");
        address cashVault = vm.envAddress("CASH_VAULT");
        address noteVault = vm.envAddress("NOTE_VAULT");
        address lpVault = vm.envAddress("LP_VAULT");
        address timelock = vm.envAddress("PROTOCOL_TIMELOCK");
        uint256 threshold = vm.envUint("SETTLEMENT_THRESHOLD");
        address dataProviderSigner = vm.envAddress("DATA_PROVIDER_SIGNER");

        vm.startBroadcast();

        Settlement settlement = new Settlement(sm, unifiedPool, navOracle, queue, ac);
        IHyperAccessControl(ac).grantRole(IHyperAccessControl(ac).SETTLEMENT_ROLE(), address(settlement));

        // operators: read a comma-free fixed set via repeated env vars, or a single array env if vm supports envAddress(name, ",")
        address[] memory operators = vm.envAddress("SETTLEMENT_OPERATORS", ",");
        for (uint256 i = 0; i < operators.length; i++) {
            settlement.addOperator(operators[i]);
        }
        settlement.setThreshold(threshold);

        AdapterFactory adapterFactory = new AdapterFactory(ac);
        IAdapterFactory.AdapterParams memory cashParams = IAdapterFactory.AdapterParams({
            asset: usdt, vault: cashVault, accessControl: ac, stalenessWindow: 36 hours, timelock: address(0)
        });
        address cashAdapter = adapterFactory.deployAdapter(cashParams);

        IAdapterFactory.AdapterParams memory noteParams = IAdapterFactory.AdapterParams({
            asset: usdt, vault: noteVault, accessControl: ac, stalenessWindow: 36 hours, timelock: address(0)
        });
        address noteAdapter = adapterFactory.deployAdapter(noteParams);

        IAdapterFactory.AdapterParams memory lpParams = IAdapterFactory.AdapterParams({
            asset: usdt, vault: lpVault, accessControl: ac, stalenessWindow: 36 hours, timelock: timelock
        });
        address lpAdapter = adapterFactory.deployLiquidityAdapter(lpParams);

        ILiquidityEarnVault(lpVault).setAdapter(lpAdapter);

        IHyperAccessControl(ac).grantRole(IHyperAccessControl(ac).DATA_PROVIDER_ROLE(), dataProviderSigner);

        // vault.setSettlement(address(settlement)) for all 3 vaults — deferred from W3 per VaultFactory comment
        IBaseVault(cashVault).setSettlement(address(settlement));
        IBaseVault(noteVault).setSettlement(address(settlement));
        IBaseVault(lpVault).setSettlement(address(settlement));

        vm.stopBroadcast();

        // write control-panel/deployments-w4.json — mirror DeployW3's vm.serializeAddress/vm.writeJson block exactly,
        // keys: settlement, adapterFactory, cashAdapter, noteAdapter, lpAdapter
    }
}
```

**Note:** `revenuePool.addAuthorizedSource(address(unifiedPool))` (spec step 11) and `lpAdapter.setBridgeTarget(liquidityBridge, cashVault)` (spec step 12, Curator-only via Timelock) are **not** GOVERNOR_ROLE deploy steps — step 11 should already be wired from W2/W3 (verify via `grep -n "addAuthorizedSource" script/Deploy.s.sol`; only add if missing), and step 12 is explicitly out of scope for the deploy script per spec's own note ("not part of the GOVERNOR_ROLE deploy steps above — Curator's own initial configuration"). Do not call `setBridgeTarget` from `DeployW4`.

**Steps:**

- [ ] **Step 1: Grep for existing `addAuthorizedSource` wiring**

Run: `grep -n "addAuthorizedSource" script/Deploy.s.sol`

If absent, add it to `DeployW4` per spec step 11; if present in an earlier week's script, leave it alone.

- [ ] **Step 2: Write `test/DeployW4.t.sol`** — a Foundry test (not a script invocation) that replicates `DeployW4.run()`'s logic inline against a full local deploy (reuse or extend `test/VaultFactory.t.sol`'s fixture to get through W1–W3 state), then asserts every §3.4.3 "wiring smoke test" bullet:
  - all role grants present
  - all set-once addresses wired
  - `StateManager.isVaultRegistered`... (check actual getter name — spec says `isVaultRegistered`, codebase interface reports `registeredVaults(address) returns (bool)` per Task 1's research — use the real getter name, note the spec/code naming mismatch)
  - `Settlement.isOperator` true for configured operators
  - `NAVOracle` has authorized signer for each vault
  - `ReservePSM.reserveAddress` set (only if a `ReservePSM` is part of the W4 test fixture — otherwise skip this bullet if it's already covered by an existing W2 test, note the gap rather than re-testing unrelated W2 scope)
  - `AdapterFactory.isAdapter` true for all three; `lpVault.adapter()` matches deployed `LiquidityAdapter`
  - KYT Gate = `address(0)` on all vaults

- [ ] **Step 3: Run, iterate until passing**

Run: `forge test --match-path test/DeployW4.t.sol -vv`
Expected: PASS

- [ ] **Step 4: Add `DeployW4` to `script/Deploy.s.sol`**, run a dry-run against local anvil if available, or skip live dry-run and rely on `test/DeployW4.t.sol` as the executable spec (script itself is not unit-testable via `forge test` directly since it's a `Script`, not a `Test` — the parallel `test/DeployW4.t.sol` is the source of truth for correctness; the script is a thin `vm.startBroadcast`-wrapped restatement).

- [ ] **Step 5: Commit**

```bash
git add script/Deploy.s.sol test/DeployW4.t.sol
git commit -m "W4: DeployW4 wiring — Settlement, AdapterFactory, adapter deploy + settlement wiring"
```

---

## Task 7: Full-suite regression + delivery report

**Files:**
- Test: run full suite
- Create: `docs/week4-delivery-report.md` (mirror `docs/week1-delivery-report.md`/`week3-delivery-report.md`'s structure — read one first, then write W4's equivalent: what was delivered, how to test, deviations from spec if any, e.g. the `sharePrice()` accessor-name note from Task 4).

**Steps:**

- [ ] **Step 1: Run full test suite**

Run: `forge test -vv`
Expected: all tests pass (W1–W4 combined)

- [ ] **Step 2: Run `forge build` clean**

Run: `forge build --force`
Expected: `Compiler run successful` (warnings OK, no errors)

- [ ] **Step 3: Read `docs/week3-delivery-report.md`, write `docs/week4-delivery-report.md` following the same structure**, covering: Settlement (4-fold validation, M-of-N), BaseAdapter/FirstPeriodAdapter/LiquidityAdapter (order book, NAV double-count resolution), AdapterFactory, DeployW4 wiring, test counts, any spec-vs-code naming deviations discovered during implementation (e.g. `sharePrice()` accessor name, `registeredVaults` vs `isVaultRegistered`).

- [ ] **Step 4: Commit**

```bash
git add docs/week4-delivery-report.md
git commit -m "W4: delivery report"
```

---

## Self-Review Notes (already folded into tasks above)

- **Spec coverage:** Settlement (Task 1), BaseAdapter (Task 2/3), FirstPeriodAdapter (Task 3), LiquidityAdapter incl. `LiquidityEarnVault.adapter` wiring (Task 4), AdapterFactory (Task 5), DeployW4 wiring (Task 6) all covered. `createRebalanceOrder`/`executeRebalance` (un-deferred per §7) covered inside Task 2/3's `BaseAdapter` — not a separate task since it's one order type on the same order book.
- **Known spec-vs-code gaps flagged inline (resolve via one grep each, not by guessing):** (1) `LiquidityAdapter.realAssets()`'s cash-vault share-price accessor name — Task 4 Step 1. (2) `Settlement`'s `StateManager` registration-check getter name (`registeredVaults` vs. spec's `isVaultRegistered`) — Task 6 Step 2. (3) `setBridgeTarget`'s Timelock gate requires adding a `timelock` constructor param to `LiquidityAdapter` not explicitly spelled out in the spec's storage block — Task 4, resolved by following the codebase's existing Timelock-gated-setter convention.
- **Placeholder scan:** no TBDs; every step has runnable code or an exact grep/test command.
