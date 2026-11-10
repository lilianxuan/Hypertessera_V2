# Week 2 Delivery Report — Settlement Infrastructure + Asset Infrastructure Completion

**Date:** 2026-06-29 · **Scope:** Phase 1, Week 2 (development-plan §3.2) · **Chain:** BNB Chain (USDT series)

This report covers (1) what was delivered this week, (2) how to test and validate it, and
(3) what is intentionally deferred. It is written to be self-contained for review.

---

## 1. What was delivered

### 1a. New contracts (W2 scope)

Six new contracts completing **Module D (Asset infrastructure)** and **Module C (Settlement)**:

| Module | Contract | Purpose |
|---|---|---|
| D — Asset | **ReservePSM** | HK Note Token ↔ Wrapped Asset bridge; `confirmLock` mints, `burnOnRedeem` burns; pluggable `ISettlementPool` (standalone mode when `address(0)`) |
| D — Asset | **WrappedAsset** | Minimal ERC-20 deployed per `assetId` by ReservePSM; PSM-gated mint/burn; freely transferable otherwise |
| D — Asset | **PoRRegistry** | Append-only Proof of Reserve ledger; DATA_PROVIDER_ROLE publishes proofs; records are permanent |
| C — Settlement | **UnifiedPool** | Per-vault USDT accounting ledger; routes interest/principal in; `distribute` pays vaults out; service fee routed to RevenuePool |
| C — Settlement | **RevenuePool** | Protocol fee sink; Governor-managed source whitelist; Governor sweeps accumulated fees |
| C — Settlement | **Queue** | Per-vault FIFO anchor for redemption ordering; tombstone cancellation; SETTLEMENT_ROLE-gated `dequeue` with out-of-order revert |

### 1b. Updated W1 contracts

Four W1 contracts were revised to align with client-agreed design updates (2026-06-22/25 meetings):

| Contract | Key changes |
|---|---|
| **HyperAccessControl** | Added `COMPLIANCE_ROLE` (12th role); manages RWAToken transfer paths and address lists |
| **AssetRegistry** | Now **permissionless** — any address may call `registerAsset`; caller becomes asset owner. New signature: `(metadataHash, name, symbol, decimals)` deploys a dedicated RWAToken and returns `(assetId, token)`. Owner model added: `ownerOf`, `transferAssetOwnership`, owner-only `updateMetadataHash`, owner-or-governor `deactivateAsset`. Governor wires `MintBurnController` via `setMintBurnController` for auto-registration. |
| **RWAToken** | Rewritten as **per-asset ERC-20** (one contract per `assetId`, deployed by `AssetRegistry`). ERC-1400 lightweight subset: ERC-1594 controller `mint`/`burn`, ERC-1644 forced `controllerTransfer`, transfer path restriction (up to 10 paths; `COMPLIANCE_ROLE` manages `setTransferPaths`, `addToAddressList`, `removeFromAddressList`). Zero paths = no restriction. |
| **MintBurnController** | Removed single `rwaToken` immutable; now resolves per-asset token via `rwaTokens[assetId]` mapping. Added `registerToken(assetId, token)` (callable only by `AssetRegistry`) to populate the mapping at registration time. |

### 1c. Test suite

**11 test suites · 301 tests · 0 failures**

| Suite | Tests | Notes |
|---|---|---|
| `AssetRegistryTest` | 43 | permissionless registration, owner model, MBC wiring, tokenOf |
| `MintBurnControllerTest` | 42 | per-asset token resolution, registerToken, dual-sig lifecycle |
| `ProtocolTimelockTest` | 39 | (unchanged from W1) |
| `NAVOracleTest` | 33 | (unchanged from W1) |
| `RWATokenTest` | 33 | ERC-20 standard, ERC-1400 controller, transfer paths, address lists |
| `HyperAccessControlTest` | 28 | COMPLIANCE_ROLE added |
| `ReservePSMTest` | 24 | confirmLock, burnOnRedeem, standalone partial redemption, PartialRedemption event |
| `UnifiedPoolTest` | 20 | repayInterest fee routing, repayPrincipal, distribute, tranche vaults |
| `QueueTest` | 18 | FIFO ordering, tombstone cancel, out-of-order revert, verifyOrder |
| `RevenuePoolTest` | 11 | source whitelist, receiveFee balance check, withdraw |
| `PoRRegistryTest` | 10 | publish, getLatestProof, getProof, getProofCount |

### 1c-bis. Live preview deployment — BNB testnet (chainId 97)

| Contract | Address |
|---|---|
| HyperAccessControl | `0x9bbefE25f656732015969778dF26e104D2394Bb8` |
| ProtocolTimelock | `0xDb3a050AD81E3B49ef7dD03Daf56579f49F95eaB` |
| AssetRegistry | `0x50222D8849f44F90fCd911fC5f36387Db8EAD429` |
| MintBurnController | `0x563f4C2e62B4917860a4435Da0bF6615648aF28e` |
| NAVOracle | `0x507A11A4D10B2206b65cF633269738B945e64e8c` |
| PoRRegistry | `0x581A7604f9429fF52fa378f2548c28B817e68d17` |
| ReservePSM | `0x67D10e814B57E381cE020697eF14CCDf922Dd654` |
| Queue | `0xCAd26BEF4ef0E71d2d54b11C1930df2F37bB1080` |
| RevenuePool | `0x19801Db23a0572dE445c2E73b52b71ff85914EF3` |
| UnifiedPool | `0x14E9ef574ABd6de2548eDe365F06AA4378010D6a` |
| MockUSDT (demo) | `0x66924eC2539ab478aba1112428cD6979baDa6bC6` |
| S Token RWAToken (assetId 1) | `0x9eCA8ce710432d2e24C85e4f1f0A939c82A5B93f` |
| J Token RWAToken (assetId 2) | `0xbA66F0919Db8e7Cf08A98c543E29606bD41A2A05` |
| StubStateManager (scaffold) | `0xe3E0a6b46d50c15649dF252448B77C2e754caE20` |

This is a **functional preview deploy** for client testing — not the formal audited W5 milestone.
The deployer account holds every role; 1 M mock USDT is pre-loaded in ReservePSM; a Wrapped S Token
(`wS-TKN`) is deployed for `assetId 1`. Connect MetaMask to **BNB testnet (chainId 97)**; get
testnet BNB from a faucet.

### 1d. Control panel

The wallet console (`control-panel/index.html` / `standalone.html`) was extended with full W2
coverage:

- All 6 new contracts wired as collapsible modules with role-badged actions and typed inputs
- Updated AssetRegistry and RWAToken panels reflecting the new signatures and owner/compliance model
- `tranche` dropdown (Cash / Note / LP) for UnifiedPool actions
- `COMPLIANCE_ROLE` badge and `DATA_PROVIDER_ROLE` badge added
- `build-abis.sh` updated to export ABIs for all 13 contracts

---

## 2. How to test & validate

### 2a. Automated unit tests (primary validation)

```bash
git submodule update --init --recursive
forge test -vv
```

Expected: `11 test suites … 301 tests passed, 0 failed`. Run a single suite, e.g.:

```bash
forge test --match-contract ReservePSMTest -vvv
forge test --match-contract QueueTest -vvv
forge test --match-contract UnifiedPoolTest -vvv
```

### 2b. Manual validation via the control panel

Open `control-panel/index.html` (or `standalone.html`) in a browser, connect MetaMask to the
configured network. The panel now shows all W2 modules alongside the W1 modules.

**Option 1 — open locally from the repo:**
```bash
open control-panel/index.html   # reads config.js + abis.js already committed
```

**Option 2 — stand up your own instance (Anvil):**
```bash
anvil &
forge script script/Deploy.s.sol --tc Deploy --rpc-url http://localhost:8545 --broadcast
./control-panel/build-abis.sh
open control-panel/index.html
```

**Option 3 — regenerate standalone.html (after redeploying):**
```bash
forge script script/Deploy.s.sol --tc Deploy --rpc-url <rpc> --broadcast --legacy
./control-panel/build-abis.sh
./control-panel/bundle.sh   # inlines everything into standalone.html
```

Suggested W2 walkthrough (builds on the W1 walkthrough):

1. **Asset registration (permissionless)** — `AssetRegistry.registerAsset("DEAL-2026-B", "Surf Note", "SURF", 18)` → returns `(assetId, tokenAddress)`. Read `ownerOf(id)` → caller; `tokenOf(id)` → deployed RWAToken address.

2. **Transfer path setup** — Switch to COMPLIANCE account. On the deployed RWAToken address call `setTransferPaths([0], [1], [2])` (path 0: list 1 → list 2). Call `addToAddressList(1, [<issuer>])` and `addToAddressList(2, [<vault>])`. Attempt a transfer between unlisted addresses → reverts `TransferRestricted`. Verify paths block or permit as expected.

3. **Proof of Reserve** — DATA_PROVIDER calls `PoRRegistry.publishReserveProof(assetId, "PoR-2026-06", "ipfs://...")`. Read `getLatestProof(assetId)` → struct with hash, uri, publishedAt, publisher. Call again; `getProofCount(assetId)` → 2. Confirm records cannot be deleted.

4. **Reserve PSM — lock and wrap** — GOVERNOR calls `deployWrappedToken(assetId, "Wrapped Surf Note", "wSURF", 18)` → emits `WrappedTokenDeployed`. ALLOCATOR calls `setReserveAddress(assetId, <reserveAddr>)`. OPERATOR calls `confirmLock(assetId, 1000e6, <vault>)` → vault receives 1000 wSURF. Read `wrappedBalanceOf(vault, assetId)` → 1000e6; `totalLocked(assetId)` → 1000e6.

5. **Reserve PSM — redeem (standalone mode)** — In standalone mode (no `settlementPool`), vault calls `burnOnRedeem(assetId, 500e6)` → burns wSURF, transfers 500 USDT directly to vault. If PSM USDT < requested amount, only partial burn occurs and `PartialRedemption` is emitted.

6. **Revenue pool and interest repayment** — GOVERNOR calls `RevenuePool.addAuthorizedSource(unifiedPool)`. ISSUER approves USDT and calls `UnifiedPool.repayInterest(0 /*Cash*/, 1000e6)` → 5 USDT (50 bps) routed to RevenuePool; 995 USDT credited to `trancheVault[Cash].pending`. Read `RevenuePool.totalFeesReceived()` → 5e6.

7. **Queue ordering** — Vault calls `Queue.enqueue(vault, requestId=1, owner, shares)`. Read `peek(vault)` → slot 0. SETTLEMENT calls `dequeue(vault, [1])` → head advances. Attempt `dequeue(vault, [99])` when head is `2` → reverts `OutOfOrderDequeue`.

---

## 3. Deferred / out of scope this week

- **autoConfirmLock** — `ReservePSM.autoConfirmLock` is stubbed (reverts `AutoConfirmLockNotSupported`). The on-chain trigger mechanism (on-chain listener vs oracle feed) is pending client decision (open item).
- **StateManager** — still backed by `StubStateManager` (testing scaffold). The real StateManager is deferred pending the client finalizing the full product/cycle/pause state list. The `IStateManager` interface is frozen and shared by `Queue`, `UnifiedPool`, and `ReservePSM`.
- **Settlement (`submitBatch`)** — the `Settlement` contract itself (M-of-N batch settlement, LP-priority enforcement, per-request payout validation) is **W4 scope**. `Queue` and `UnifiedPool` are the on-chain anchors Settlement will call; their interfaces are final.
- **Vault contracts (BaseVault, CashEarnVault, etc.)** — **W3 scope**. `UnifiedPool.distribute` targets `address vault`; any registered vault address satisfies the interface.
- **Formal testnet/mainnet deployment** — the W5 milestone. No new preview deployment this week; use Anvil locally or the W1 testnet for W1 contract testing.

---

## 4. Items for client confirmation

| # | Item | Status |
|---|---|---|
| 1 | **`autoConfirmLock` trigger mechanism** — on-chain listener vs price-feed oracle vs manual OPERATOR call. Current implementation reverts; full wiring is TBD. | Open |
| 2 | **`ReservePSM` redemption formula** — `usdtRequired = wrappedAmount × currentNAV` (per 2026-06-24 meeting). NAV integration point (`INAVOracle`) not yet wired into `burnOnRedeem`; current implementation uses 1:1. Confirm formula and NAV feed source before W4. | Open |
| 3 | **`UnifiedPool` upgrade proxy** — plan notes UUPS upgradeability. Current implementation is non-upgradeable. Confirm whether proxy wrapper is required before W3 (dependency: vault `distribute` target address must be stable). | Open |
