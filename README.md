# hyperTessera — HyperTessera Earn

External delivery repo for the HyperTessera Earn protocol (cyclic three-tranche RWA yield product,
USDT-settled on BNB Chain). This repository tracks the agreed weekly delivery schedule in
[`docs/development-plan.md`](docs/development-plan.md).

> **For the client:** start with the latest delivery report —
> [`docs/week5-delivery-report.md`](docs/week5-delivery-report.md) — for what is delivered, how to
> test it, and how to drive it from the control panel / off-chain layer.

---

## Delivery status

Phase 1 (USDT series) is delivered through Week 5. Each week has its own delivery report:

| Week | Report | Scope |
|---|---|---|
| 1 | [`week1-delivery-report.md`](docs/week1-delivery-report.md) | Governance (`HyperAccessControl`, `ProtocolTimelock`) + asset foundations (`NAVOracle`, `MintBurnController`, `AssetRegistry`, `RWAToken`) |
| 2 | [`week2-delivery-report.md`](docs/week2-delivery-report.md) | Settlement infrastructure (`UnifiedPool`, `RevenuePool`, `Queue`) + asset infrastructure completion (`ReservePSM`, `PoRRegistry`) |
| 3 | [`week3-delivery-report.md`](docs/week3-delivery-report.md) | Vault infrastructure (`StateManager`, `BaseVault`, `EarnVault`, `LiquidityEarnVault`, `VaultFactory`, `LiquidityBridge`) |
| 4 | [`week4-delivery-report.md`](docs/week4-delivery-report.md) | Settlement completion + Strategy/Adapter layer (`BaseAdapter`, `FirstPeriodAdapter`, `LiquidityAdapter`, `AdapterFactory`) |
| 5 | [`week5-delivery-report.md`](docs/week5-delivery-report.md) | Module E off-chain layer (SDK, `OnChainEventIndexer`, `KeeperBot`, `SettlementOperator`) + net settlement conversion, `ClaimRegistry` |

See [`docs/development-plan.md`](docs/development-plan.md) §1–§2 for the full phase split and system
overview, and [`docs/function-reference.md`](docs/function-reference.md) for a plain-language,
per-function reference across every delivered contract.

---

## Layout

```
src/
  asset-infrastructure/  AssetRegistry.sol  ClaimRegistry.sol  MintBurnController.sol
                         NAVOracle.sol  PoRRegistry.sol  RWAToken.sol
  wrapped-assets/        ReservePSM.sol  WrappedAsset.sol   (wrapping, redemption, off-chain release)
  asset-management/      StateManager.sol
    vaults/               BaseVault.sol  EarnVault.sol  LiquidityEarnVault.sol  VaultFactory.sol  ...
    strategy/             BaseAdapter.sol  FirstPeriodAdapter.sol  LiquidityAdapter.sol  ...
    settlement/           Queue.sol  RevenuePool.sol  Settlement.sol  UnifiedPool.sol
  governance/  HyperAccessControl.sol  ProtocolTimelock.sol
  interfaces/  I*.sol  (protocol-wide interface layer, shared by all systems above)
  libs/        Types.sol  Constants.sol
test/          one *.t.sol suite per contract  (+ mocks/)
script/        deploy.sh               (deployment driver — see docs/deployment-handbook.md)
  deploy/               DeployCore.s.sol  DeployPlatform.s.sol   (shared, deployed once)
                        DeployVault.s.sol                        (one run per Vault)
                        DeployConfig.sol
    networks/           per-network settings (anvil, bsc-testnet, bsc-mainnet template)
    testing/            MockUSDT.sol  StubStateManager.sol   (demo-profile scaffolds)
control-panel/ index.html              (role-based wallet console — see below)
offchain/      TypeScript SDK, KeeperBot, indexer, SettlementOperator, local deploy/test tooling
docs/          development-plan.md, function-reference.md, weekN-delivery-report.md, event whitelist proposal, + v3.2 / formula / SOW / role PDFs
```

`asset-infrastructure`, `wrapped-assets`, and `asset-management` are independent on-chain systems
under the shared HyperTessera protocol — they share only the `interfaces` / `libs` / `governance`
layer and have no direct contract-to-contract imports between them.

## Build & test

```bash
git submodule update --init --recursive   # forge-std v1.16.1, openzeppelin-contracts v5.1.0
forge build
forge test                                 # 572 tests, 0 failures
```

The off-chain package (`offchain/`) has its own build/test cycle — see
[`offchain/README.md`](offchain/README.md):

```bash
cd offchain
npm install
npm run typecheck
npm test                    # fast unit tests, no chain
npm run test:integration    # spins up anvil, deploys the full stack, drives a full cycle end to end
```

---

## Deploy & run the control panel

See [`control-panel/README.md`](control-panel/README.md) for the full quickstart.

- **Deployed instance (e.g. testnet):** if `control-panel/config.js` is committed for the
  deployment, just **open `control-panel/index.html`** and connect MetaMask — no node, build, or
  server. Produce `config.js` by deploying once and committing it:
  ```bash
  PRIVATE_KEY=0x... ./script/deploy.sh --network bsc-testnet
  git add control-panel/config.js   # commit for the team
  ```
- **Local Anvil:**
  ```bash
  anvil &
  ./script/deploy.sh --network anvil     # platform + the three demo vaults; writes config.js
  ./control-panel/build-abis.sh          # writes abis.js
  open control-panel/index.html          # or: cd control-panel && python3 -m http.server 8777
  ```

`config.js` + `abis.js` load as plain `<script>`s, so the panel runs from `file://` (no server). If
MetaMask doesn't inject on `file://`, enable file-URL access for the extension or use `http.server`.

**One-file hosting:** `./control-panel/bundle.sh` inlines the ABIs, config, and ethers.js into a
single `control-panel/standalone.html` — upload that one file to pagedrop / GitHub Pages / S3 / IPFS
and it works with just MetaMask, no other files.

> `StubStateManager` and `MockUSDT` are testing scaffolds. They stand in for the module-pause
> surface and the settlement token on Anvil and public testnets only; `DEPLOY_PROFILE=production`
> deploys neither. They are not deliverable contracts.

---

## Off-chain layer (`offchain/`)

The TypeScript layer the Company operates after delivery to run the deployed contracts
(development-plan §3.5, §5.6):

| Component | File | Purpose |
|---|---|---|
| SDK | `offchain/src/sdk.ts` | `HyperTesseraSDK` — typed contract read/write access across all three on-chain systems |
| `OnChainEventIndexer` | `offchain/src/indexer.ts` | Event subscription, dual-FIFO (deposit/redeem) queue + pending-deposit reconstruction |
| `KeeperBot` | `offchain/src/keeperBot.ts` | Drives `ProductState`/`CycleState` transitions, raises NAV/PSM-lag alerts, retries with backoff |
| `SettlementOperator` | `offchain/src/settlementOperator.ts` | Assembles `SettlementInstruction`, collects M-of-N signatures, submits + retries |

ABIs are read from `control-panel/abis.json` at runtime, so the SDK and the control panel never drift
from each other or from the compiled contracts. `offchain/scripts/local/` and `offchain/test/` provide
a reproducible local Anvil devnet (full deploy + an end-to-end test plan) — see
[`offchain/README.md`](offchain/README.md) for details.

---

## Further reading

- [`docs/deployment-handbook.md`](docs/deployment-handbook.md) — 部署手册：环境变量、共享平台与逐个金库的部署、新增金库、部署后验证、上线前必须设置的参数、角色移交。
- [`docs/development-plan.md`](docs/development-plan.md) — full technical spec, phase split, module map, and change history.
- [`docs/function-reference.md`](docs/function-reference.md) — plain-language function reference for every delivered contract.
- [`docs/module-e-event-whitelist-proposal.md`](docs/module-e-event-whitelist-proposal.md) — proposed on-chain event whitelist for the off-chain indexer.
