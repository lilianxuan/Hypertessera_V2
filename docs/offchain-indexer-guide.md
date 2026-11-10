# OnChainEventIndexer 使用指南（结算取申赎队列）

结算时需要知道「这一轮有哪些申购待结算、赎回队列的 FIFO 顺序是什么」。这两份数据由
`offchain/src/indexer.ts` 的 `OnChainEventIndexer` 从链上事件重建，本文件说明怎么用。

相关文件分工：

| 文件 | 负责什么 |
|---|---|
| 本文件 | indexer 的生命周期、查询接口、字段含义、接进结算流程的方式 |
| `docs/offchain-operations-runbook.md` | KeeperBot / SettlementOperator 怎么跑起来（环境、授权、常驻） |
| `docs/settlement-operator-runbook.md` | 结算批次的业务规则（哪些 Vault 同批、顺序） |
| `docs/module-e-event-whitelist-proposal.md` | indexer 订阅的事件白名单全表 |

---

## 1. 三分钟上手

仓库里带了一支只读脚本，直接把三个 Vault 的队列打出来：

```bash
cd offchain
npx tsx --env-file=../.env.testnet scripts/testnet/dumpQueues.ts \
  --from-block 125937000 --chunk 2000
```

实跑输出（BNB Testnet，当前还没有任何申赎请求，所以是空队列）：

```
dumpQueues -> chainId 97, blocks 125937000..125942326 (latest 125942326)
  indexed through block 125942326

cash 0x2EAe528B02778476d5C268f7fB4e9e610924dab1
  pause: ACTIVE
  on-chain depth: deposit=0 redeem=0
  pending deposits (0):
  clearing list (0, FIFO order):
...
```

脚本本身只有几十行，可以直接当模板改：`scripts/testnet/dumpQueues.ts`。

自己写代码时最小可用形态是：

```ts
import { JsonRpcProvider } from "ethers";
// 仓库内脚本用相对路径；作为依赖安装时从包入口 `@hypertessera/offchain` 取（见 package.json 的 exports）
import { HyperTesseraSDK } from "../../src/sdk.js";
import { OnChainEventIndexer } from "../../src/indexer.js";

const provider = new JsonRpcProvider(rpcUrl, 97);
const sdk = new HyperTesseraSDK(addresses, provider);

const indexer = new OnChainEventIndexer(sdk, provider);   // 默认索引 cash/note/lp 三个 Vault
await indexer.backfill(fromBlock, toBlock);               // 必须先回补历史
indexer.start({ pollIntervalMs: 15_000 });                // 之后持续跟进新区块（可选）

const pending  = indexer.getPendingDeposits(vault);       // 待结算申购
const clearing = indexer.getClearingList(vault);          // 赎回队列，FIFO 顺序
```

`backfill` 与 `start` 都只负责**读链**：把链上事件折叠成内存里的队列视图。要不要落库、落哪里、
下游怎么消费，都由调用方决定——`lastIndexedBlock()` 会告诉你索引到哪个区块了，存这个游标就够了。

---

## 2. 生命周期

| 步骤 | 说明 |
|---|---|
| `new OnChainEventIndexer(sdk, provider, vaults?)` | 第三个参数不给时，索引配置里的 cash/note/lp。`deployVault` 是无权限的，链上可能存在配置不知道的 Vault |
| `OnChainEventIndexer.discover(sdk, provider, pageSize)` | 改为索引 **StateManager 上注册的全部 Vault**（读链上索引，不靠日志重放） |
| `await backfill(from, to, options?)` | 回补历史事件。**不调用就查不到任何东西**——所有查询接口读的都是内存状态。内部按 `chunkSize`（默认 2000）分段扫描，每段失败会指数退避重试 |
| `start(options?)` | 轮询新区块并持续折叠（默认 15 秒一次，落后链头 `confirmations` 个区块，默认 6） |
| `stop()` | 停止轮询 |
| `lastIndexedBlock()` | 已折叠到哪个区块；-1 表示还没 backfill 过。**要持久化就存这个游标** |
| `indexedVaults()` | 该实例索引的 Vault 集合；其它方法传入集合外的地址会被拒绝 |

**重复扫描是安全的。** 每条日志都带身份（`txHash:logIndex`），只会被应用一次，所以对同一段区块
反复 `backfill` 不会把 `settledAssets`、`writtenDownHaircut` 这类累加字段算两遍——`start()` 的
轮询正是靠这一点来接续。

**内存重建、没有持久化**：进程重启后状态归零，必须重新 `backfill`。存储与后续处理不在本 repo
范围内，这一层只负责把链上状态读对。

### 为什么 `start()` 是轮询而不是事件订阅

原先用 `contract.on` 推送，有三个运营上会真踩到的问题，改成轮询后一并消掉：

| 问题 | 推送订阅 | 轮询 |
|---|---|---|
| provider 断线重连 | 静默不再收到事件，不报错 | 下一次轮询从 `lastIndexedBlock()` 续上 |
| `backfill` 结束到订阅生效之间 | 空窗，期间的事件永久丢失 | 从 backfill 停下的区块继续，无空窗 |
| 链重组 | 推送的是未确认链头，重组后的日志已经进了状态 | 落后 `confirmations` 个区块，重组日志根本不会进来 |

注意第三点是**规避**而不是**修复**：深度超过 `confirmations` 的重组仍会污染内存状态，这时唯一
的办法是重建实例重新 `backfill`。对一个内存索引来说这是诚实的边界。

---

## 3. 查询接口

### 3.1 结算直接要用的两个

**`getPendingDeposits(vault): DepositRecord[]`**（`indexer.ts:664`）
待结算申购，按 `requestId` 升序。过滤条件是 `!settled && !cancelled && !refunded`。

**`getClearingList(vault): RedeemRecord[]`**（`indexer.ts:694`）
仍在链上 FIFO 队列里的赎回请求，**按 `slotIndex` 排序**，即链上队列的真实顺序。过滤条件是
`!dequeued && !tombstoned && slotIndex !== undefined`。

### 3.2 其它

| 方法 | 用途 |
|---|---|
| `getDepositRecord(vault, requestId)` | 单笔申购的原始重建记录（`BaseVault._depositRequests` 是 internal，链上没有 getter） |
| `getRedeemRecord(vault, requestId)` | 单笔赎回的原始重建记录。**已离开队列的请求只能从这里读到**——`getClearingList` 会把它们过滤掉，而被取消的部分成交赎回恰恰仍然可领 |
| `getProductInfo(assetId)` | `AssetRegistry.ProductInfoSet` 重建的产品信息（`issuer` / `apy` / `duration` / …）；没见过该 assetId 返回 `undefined` |
| `getAssetToken(assetId)` | `AssetRegistry.AssetRegistered` 里为该 assetId 部署的 `RWAToken` 地址 |
| `getWhitelistEnabled(rwaToken)` | 该 `RWAToken` 的白名单开关（`WhitelistEnabledSet` 重建）。从未观测到则为 `undefined`，即仍是合约默认值 `false` |
| `getTransferPathEnabled(rwaToken)` | 该 `RWAToken` 的转账路径开关（`TransferPathEnabledSet` 重建），`undefined` 的含义同上 |
| `getLastWhitelistUpdate(rwaToken)` | 该 token 最近一次 `WhitelistUpdated` 批次：`{ added, count, timestamp }`。事件只带条数、不带地址，所以查某个具体地址是否在白名单里仍要直接读链上 |
| `getQueueSnapshot(vault)` | **直接读链上**的双 FIFO 深度（`deposit`/`redeem`），不走内存——用来和重建结果对账 |
| `getLatestNAV(rwaToken)` | 最近一次 NAV 读数（`price` / `dataTimestamp` / `updatedAt`） |
| `getVaultAssetLinks(vault)` / `getVaultAssetIds(vault)` / `getVaultsHoldingAsset(assetId)` | vault ↔ adapter ↔ rwaToken ↔ assetId 的对应关系 |
| `getVaultPauseState(vault)` | 该 Vault 当前的暂停状态（`StateManager.VaultPauseSet` / `VaultUnpaused` 重建），从未暂停过则是 `ACTIVE` |
| `getPausedModules()` | 当前被全局暂停的模块列表（`ModulePaused` / `ModuleUnpaused`） |
| `getEvents(contract, eventName, from, to)` | 通用逃生舱：查任何 indexer 没跟踪的事件 |

---

## 4. 字段含义

### `DepositRecord`

| 字段 | 含义 |
|---|---|
| `requestId` / `owner` / `blockNumber` | 请求 id、发起人、进入区块 |
| `assets` | **当前**本金。`RequestWrittenDown`（坏账减记）会就地调低这个值 |
| `writtenDownHaircut` | 已累计扣掉的减记金额 |
| `settled` / `claimed` / `cancelled` / `refunded` | 状态标志位 |
| `removedFromQueue` | 已从 DEPOSIT FIFO 移除。`cancelRequest()` 与 `markRefundable()` 都会触发，**单看这个标志分不出是哪一种**——要用 `isDepositRefundable(record, product)`（`sdk.ts` 导出的独立函数，第二个参数是当前 `ProductState`）区分 |
| `settledAssets` / `refundedAssets` / `settledCycleNumber` | `DepositSettled` 的载荷，结算前为 `undefined` |
| `slotIndex` / `orderHash` | 在链上 DEPOSIT FIFO 里的槽位与条目哈希（`Queue.RequestQueued`）。`getPendingDeposits` 按槽位排序；早于回补窗口、没有槽位的记录退回按 `requestId` 排在后面 |

结算算金额时用 `assets`（已扣减记），不要用最初 `DepositRequested` 里的原始值。

申购离开 DEPOSIT FIFO 的路径有两条，去向不同：

| 路径 | 何时可用 | 去向 | 链下如何识别 |
|---|---|---|---|
| `markRefundable(ids)`（Curator） | 仅 `FUNDING_FAILED` | `REFUNDABLE`，需再 `claimRefund` | `removedFromQueue && !cancelled && !settled`，且当前 `ProductState` 是 `FUNDING_FAILED` |
| `cancelRequest(id)`（用户自己撤单） | 除 `cycle != ACCEPTING` 与 `product == SETTLING` 外的任何阶段 | `CANCELLED`，USDT 已直接推回 | `BaseVault.RequestCancelled` → `cancelled = true` |

`isDepositRefundable(record, product)` 只判定第一条：REFUNDABLE 现在只可能来自
`markRefundable`，撤单是直接退款、不经过 REFUNDABLE。

### `RedeemRecord`

| 字段 | 含义 |
|---|---|
| `requestId` / `owner` / `blockNumber` | 请求 id、发起人、进入区块 |
| `shares` | **原始**请求份额，创建后不再变（与合约的 `RedeemRequestInternal.shares` 一致） |
| `remainingShares` | **还没付的份额**。初值等于 `shares`，每次 `RedeemSettled` 部分成交后递减，归零时才出队 |
| `settledAssets` | 跨轮**累计**已预留的 USDT |
| `lastSettledCycleNumber` | 最近一次（部分或最终）成交所在的 cycle；没成交过则为 `undefined` |
| `slotIndex` | 在链上 FIFO 里的槽位 —— **排序依据** |
| `orderHash` | 队列条目哈希 |
| `dequeued` / `tombstoned` / `claimed` | 已出队 / 已作废 / 已领取 |
| `cancelledButSettled` | 这笔赎回是被 `cancelRequest` 撤掉的，**且撤单前已有部分成交**（`settledAssets > 0`）。合约只退还未成交的份额并把请求提升为 SETTLED，所以那笔 `settledAssets` 仍然可以 `claimRedeem` 领走 |

赎回可以跨轮部分成交（`BaseVault` 每轮递减 `remainingShares`，减到 0 才 `RequestDequeued`）。
**组下一轮批次时用 `remainingShares`，不要用 `shares`**，否则会把已经付过的部分再算一遍。

**被撤销的部分成交赎回，界面必须继续显示“可领取”。** 完全未成交的撤单和部分成交的撤单
都会置 `tombstoned = true`、`remainingShares = 0`、`claimed = false`，形状完全一样；
唯一的区别就是 `cancelledButSettled`：

```ts
const rec = indexer.getRedeemRecord(vault, requestId);
// 仍可 claimRedeem 领走 rec.settledAssets
const claimable = rec?.cancelledButSettled === true && !rec.claimed;
```

漏掉这个判断的后果是用户永远不会去点 claim，那笔 USDT 就一直躺在合约里
（资金不会丢，`claimRedeem` 随时可领，只是没人告诉他）。

---

## 5. 接进结算流程

`runSettlement.ts` 吃的是一份 JSON spec，每笔请求要 `requestId` + `settleAmount`：

```json
{
  "cycleNumber": "1",
  "vaults": [
    { "vault": "lp",   "amount": "0", "deposits": [{ "requestId": "2", "settleAmount": "220000000" }], "redeems": [] },
    { "vault": "cash", "amount": "0", "deposits": [], "redeems": [] }
  ]
}
```

从 indexer 到这份 spec 的映射：

- `deposits[]` ← `getPendingDeposits(vault)`，`settleAmount` 由公司侧的链下计算决定（金额计算不在
  这一层，见 `offchain/README.md` 的 Notes）
- `redeems[]` ← `getClearingList(vault)`，**保持返回的 FIFO 顺序**，`settleAmount` 的上限是
  `remainingShares` 而不是 `shares`（合约侧 `settleAmount > remainingShares` 会 revert）

一条硬约束：链上是 FIFO 队列，链下选出来的应当是**队列前缀**，不能跳着挑
（`Settlement.sol:16` 的说明：合约把公司侧的「每轮 FIFO 前缀选择」翻译成链上的 mint/burn 与资金划转）。
批次怎么组（LP 与它的 `cashVault()` 必须同批、顺序 `[LP, Cash]`）见
`docs/settlement-operator-runbook.md`，那些规则合约不强制，组错会 revert 或错价。

对账习惯：送批之前用 `getQueueSnapshot(vault)` 读链上深度，和 `getPendingDeposits`/`getClearingList`
的条数比一比。对不上通常意味着 backfill 的起始区块太晚，漏掉了早期事件。

---

## 6. RPC 的现实限制（实测）

公共 RPC 端点会从两个方向卡住 `backfill`，这是实际跑出来的结果：

| 端点 | 现象 | 实测报错 |
|---|---|---|
| `data-seed-prebsc-1-s1.binance.org` | 区间/频率限制，宽区间直接拒 | `-32005 limit exceeded` |
| `bsc-testnet.publicnode.com` | 只保留近期区块，历史被裁剪 | `-32701 History has been pruned for this block` |

也就是说：**用公共端点无法从部署区块一路回补到现在**（v5 一代部署在 2026-08-19，见 `docs/deployment-bsctestnet-2026-08-19-v5.md`）。可行的做法：

1. 用 archive 节点或自建全节点做首次回补；
2. 或者接受「只回补近期窗口 + 持续 `start()` 订阅增量」，并把重建结果落到自己的存储里，避免每次重启都要重灌；
3. 分段回补（`backfill` 内建，`chunkSize` 可调）能绕开区间限制，但绕不开历史裁剪。

另外 `start()` 每轮只扫描新增的区块，所以稳态下的 RPC 压力和回补完全不是一个量级——真正难的
只有首次回补。

---

## 7. 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 队列全空，但链上确实有请求 | 没调 `backfill`，或 `--from-block` 太晚 | 起始区块往前推；或和 `getQueueSnapshot` 的链上深度对账 |
| `-32005 limit exceeded` | RPC 区间/频率限制 | 加 `--chunk`（实测 2000 可用），或换端点 |
| `-32701 History has been pruned` | 端点不保留历史 | 换 archive 节点 |
| 重启后队列变空 | 内存重建，无持久化 | 重新 `backfill`，或自行落库 |
| `removedFromQueue=true` 但分不清是取消还是退款 | 两条路径共用同一个队列事件 | 看 `cancelled`（`RequestCancelled` 置位）区分撤单；其余用 `isDepositRefundable(record, product)` 判断 |
| 赎回显示已作废，用户却说钱还在 | 被撤销的部分成交赎回已提升为 SETTLED，仍可 `claimRedeem` | 用 `getRedeemRecord(vault, id)` 看 `cancelledButSettled`；为 true 就继续给出 claim 入口 |
| 传入的 vault 报错 | 该地址不在这个实例的索引集合里 | 用 `indexedVaults()` 确认，或改用 `OnChainEventIndexer.discover(...)` |
| `start()` 之后数据不更新 | 轮询默认落后链头 6 个区块，且默认 15 秒一轮 | 正常延迟；要更快就调小 `confirmations` / `pollIntervalMs`，但重组风险相应上升 |
| 轮询期间 RPC 报错 | 端点抖动 | 传 `onError` 回调观察；循环不会中断，下一轮自动重试 |
| 怀疑深度重组污染了状态 | 重组深度超过 `confirmations` | 重建实例并重新 `backfill`；内存索引没有回滚能力 |
