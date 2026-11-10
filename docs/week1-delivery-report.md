# Week 1 Delivery Report — Governance + Asset Foundations

**Date:** 2026-06-17 · **Scope:** Phase 1, Week 1 (development-plan §3.1) · **Chain:** BNB Chain (USDT series)

This report tells you (1) what was delivered this week, (2) how to test and validate it, and
(3) what is intentionally deferred. It is written to be self-contained for review.

---

## 1. What was delivered

Six on-chain contracts, fully implemented, unit-tested, and exercisable from a wallet console:

| Module | Contract | Purpose |
|---|---|---|
| A — Governance | **HyperAccessControl** | Flat 11-role RBAC; GOVERNOR is sole admin of all roles |
| A — Governance | **ProtocolTimelock** | 48h delay queue for parameter changes (arbitrary target, per-change id) |
| D — Asset | **AssetRegistry** | Sequential `uint256` registry of tokenised RWA assets |
| D — Asset | **RWAToken** | Internal multi-asset ledger (S=1, J=2); mint/burn gated to the controller |
| D — Asset | **NAVOracle** | Signed daily NAV per vault; upward deviation cap; per-vault authorised signer |
| D — Asset | **MintBurnController** | Issuer + Token-Agent dual-signature RWA mint/burn lifecycle |

Plus: the supporting interfaces, the `IStateManager` interface (compile dependency for the asset
contracts' pause gate), a Foundry deploy/wiring script, and a role-based control panel.

A full **function-level module preview** (storage, signatures, access control, events, errors,
boundary conditions) is in the repo [`README.md`](../README.md).

**Live preview deployment — BNB testnet (chainId 97):**

| Contract | Address |
|---|---|
| HyperAccessControl | `0x37F8353397276f6c75AaAC174476027400A13Dbd` |
| ProtocolTimelock | `0xFf31eB3CBF6ec9977FFbe4AB3797c9b6a6ff3b31` |
| AssetRegistry | `0x1a0E6d4f5AAC900d795890399e0B114a8Ceef3d4` |
| RWAToken | `0xc5fc9f52fcb72c115A219dF25B3feaAD38c0D26b` |
| NAVOracle | `0xe9CAeb77C9DBCa9167DE1741a78BEaDBE99109a2` |
| MintBurnController | `0x10065E7b353371DD2e12348e7094cC774638EbEB` |
| StubStateManager (scaffold) | `0xD71cadFFdb96F50c9B48A205392E49CED3F77004` |

This is a **functional preview deploy** for client testing — not the formal audited W5 testnet
milestone. The deployer account holds every role, two demo assets (S=1, J=2) are registered, and the
panel is pre-pointed at it (`control-panel/config.js`). A ready-to-host single file ships at
[`control-panel/standalone.html`](../control-panel/standalone.html).

### Acceptance criteria for this week
- [x] All six contracts compile under solc 0.8.24 with pinned deps (forge-std v1.16.1, OZ v5.1.0).
- [x] Unit suite green: **217 tests, 0 failures** across 6 suites.
- [x] Contracts match the client-agreed plan spec (§3.1/§3.2.1) — see the development plan changelog.
- [x] Deployable and drivable end-to-end via wallet, per role.

---

## 2. How to test & validate

### 2a. Automated unit tests (primary validation)

```bash
git submodule update --init --recursive
forge test -vv
```

Expected: `6 test suites … 217 tests passed, 0 failed`. Per-contract coverage maps to the
plan's §3.1.3 test paths and exceeds them (role gating, signed-NAV deviation/monotonicity,
dual-sig isolation, timelock timing/replay, asset lifecycle, fuzz). Run one suite, e.g.:

```bash
forge test --match-contract NAVOracleTest -vvv
```

### 2b. Manual validation via the control panel

A zero-build wallet console lets you connect MetaMask and send real transactions. It loads the
deployment config + ABIs as plain `<script>`s, so it runs straight from a file — no node, build, or
server. Three ways to use it, simplest first:

**Option 1 — hosted single file (easiest).** Open the hosted `standalone.html` (ABIs + testnet
config + ethers.js all inlined), or open the local copy `control-panel/standalone.html` in a
browser. Connect MetaMask to **BNB testnet (chainId 97)**. Nothing to install.

**Option 2 — open the panel from the repo.** Open `control-panel/index.html`; it reads the
committed `config.js` (already pointed at the testnet deployment above).

**Option 3 — stand up your own instance.**
```bash
# Local Anvil
anvil &
forge script script/Deploy.s.sol --tc Deploy --rpc-url http://localhost:8545 --broadcast  # writes config.js
./control-panel/build-abis.sh                                                              # writes abis.js
open control-panel/index.html

# BNB testnet — key from TEST_PK (or PRIVATE_KEY) in .env; --legacy for BSC gas
forge script script/Deploy.s.sol --tc Deploy --rpc-url https://bsc-testnet-rpc.publicnode.com --broadcast --legacy
./control-panel/bundle.sh        # regenerate standalone.html, then commit config.js + standalone.html
```

> **Roles:** on the BNB testnet preview the **deployer account holds every role**, so you can run the
> whole walkthrough from one wallet — no account switching. (On Anvil the roles are instead spread
> across the standard test accounts; see `control-panel/README.md`.)

Suggested end-to-end walkthrough:

1. **Access control** — `grantRole(KEEPER, <addr>)`; read `getRoleAdmin(any)` → GOVERNOR_ROLE; from a non-governor account `grantRole` reverts.
2. **Asset registry** — `registerAsset("DEAL-2026-A")` → returns the next id; `getAsset(id)`; `isActive(id)` → true. (Demo assets 1 = S, 2 = J are pre-registered.)
3. **Mint (dual-sig)** — `initiateMint(1, 1000000, <addr>)` → nonce 0; `approveMint(0)`; read `RWAToken.balanceOf(<addr>, 1)` → 1000000. Issuer-alone-cannot-approve is enforced by the role split.
4. **NAV** — `updateNAV(vault, 1000000, now)` (the panel signs + submits as the authorized signer); read `getNavData(vault)` and `isNAVFresh(vault)`. Try `nav = 0` (→ `InvalidNAV`) and a >+20% jump (→ `DeviationTooHigh`).
5. **Emergency pause** — `pauseModule(TOKENIZATION)`; now `initiateMint` reverts `ModulePaused`; `unpauseModule(TOKENIZATION)` to restore.
6. **Timelock** — `scheduleParamChange(target, data)` → changeId; `executeParamChange(changeId)` before the delay → `TooEarly`; `cancelParamChange(changeId)`.

Every action and result (tx hash, return value, or revert reason) streams to the console's
transaction log. Get testnet BNB for gas from a BNB Chain faucet (chainId 97).

---

## 3. Deferred / out of scope this week

- **StateManager** — deferred at the 2026-06-16 meeting (client finalizing the exhaustive
  product/cycle/pause state list). Its interface ships now because `NAVOracle` and
  `MintBurnController` consume its `modulePaused` emergency gate. For local testing a
  **`StubStateManager`** (module-pause surface only; every other function reverts) stands in — it is
  a **testing scaffold, not a deliverable contract**, and will be replaced by the real StateManager
  when its scope is confirmed.
- **DemoNAVConsumer** — a one-function stand-in "vault" so `updateNAV` is demoable before real
  vaults arrive in Week 3. Testing scaffold only.
- **On-chain signature verification** of issuer/token-agent and the NAV feed follows the plan's
  MVP model: the dual-sig is enforced by sequential role-gated calls; the NAV feed verifies an
  ECDSA signature over `(vault, nav, dataTimestamp)`. M-of-N hardening is Phase 2.
- **Formal testnet/mainnet deployment** (full stack, audited, with the real StateManager) is the W5+
  milestone. The BNB testnet addresses above are a **functional preview** for W1 client testing only,
  deployed with the deferred-StateManager stub — not the audited release.

## 4. One item for client confirmation
`NAVOracle` and `MintBurnController` retain an emergency **module-pause gate** (via StateManager)
beyond the plan's bare validation lists — kept on safety grounds. If you prefer these ungated for
Phase 1, we can remove them; otherwise the real StateManager will back them when delivered.
