# Off-chain 运营手册（KeeperBot / SettlementOperator）

`offchain/` 这一层（Module E）在合约交付后由运营方自行执行。本文件是**怎么把它跑起来**的操作手册：
环境变量、钱包与链上授权、实际命令、输出解读、常驻部署、疑难排查。

相关文件分工：

| 文件 | 负责什么 |
|---|---|
| 本文件 | 怎么跑起来（命令、环境、授权、常驻） |
| `offchain/README.md` | 代码结构与开发用的 build / test 命令 |
| `docs/settlement-operator-runbook.md` | 结算批次的**业务规则**（哪些 Vault 要同批、顺序），不含命令 |
| `offchain/scripts/testnet/ROLE_ASSIGNMENT.md` | 15 个测试钱包的角色分配表 |
| `docs/deployment-bsctestnet-2026-08-18-v4.md` | 当前 BNB Testnet（chainId 97）这一代部署的地址与角色现状 |

---

## 1. 前置准备

需求：Node ≥ 18（实测 Node 26 可用）、`npx`；只有跑本地 fork 演练时才需要 Foundry 的 `anvil`。

```bash
cd offchain
npm install
npm run typecheck     # 无输出即为通过
```

### 1.1 环境变量

复制模板到 repo 根目录（该文件已被 `.gitignore` 忽略）：

```bash
cp offchain/scripts/testnet/.env.testnet.example .env.testnet
```

| 变量 | 用途 | 谁会读 |
|---|---|---|
| `TESTNET_MNEMONIC` | 派生 15 个角色钱包（`m/44'/60'/0'/0/{index}`） | `--role` 模式、`fundWallets.ts`、`grantKeeper.ts` |
| `BSC_TESTNET_RPC` | RPC endpoint，覆盖地址簿里的 `rpcUrl` | `scripts/testnet/*` |
| `TEST_PK` | 灌钱钱包私钥；目前也是三个 Vault 的 Owner | `fundWallets.ts`、`grantKeeper.ts` |
| `KEEPER_PK` | 可选。keeper 钱包不在助记词内时才需要 | `runKeeper.ts` |
| `SETTLEMENT_OPERATOR_PKS` / `SETTLEMENT_RELAYER_PK` | 可选，结算多签私钥 | `runSettlement.ts` |

助记词尚未生成时：

```bash
cd offchain
npx tsx scripts/testnet/generateMnemonic.ts    # 打印助记词 + 15 个地址，不写入任何文件
```

### 1.2 地址簿

`offchain/scripts/testnet/addresses.bscTestnet.json` 是当前这一代部署的地址（含 `chainId`、`rpcUrl`
与三个 Vault）。换一代部署＝换这个文件，或在命令上用 `--addresses <path>` 指向别的文件。

---

## 2. 钱包与链上授权

### 2.1 现状（v4 部署）

该代部署把**所有角色都指向部署钱包** `0x425beB70…`（即 `.env.testnet` 里的 `TEST_PK`）：Owner、
Curator、Guardian、Allocator、Keeper、Settlement Operator（1-of-1）全都是它。助记词派生的 15 个
角色钱包**还没有被应用到合约上**。

因此有两条路：

- **最快跑起来**：直接用部署钱包当 keeper —— `--pk $TEST_PK`，不需要任何授权步骤。
- **正式分权**：把 Keeper 换成助记词的 `keeper`（index 4）钱包，之后就能用 `--role keeper`。

### 2.2 Owner 不等于 Keeper

Vault 的 Owner **不会自动具备 Keeper 权限**，必须有一次明确的 `setKeeper(account, true)`
授权（`scripts/local/testSettlementTail.ts:41-55` 有测试钉住这个行为）。少了这步，KeeperBot 每次
tick 都会撞 `NotKeeper()`（selector `0xf512b278`）。

### 2.3 授权命令

```bash
cd offchain
# 先看要发什么，不发交易
npx tsx --env-file=../.env.testnet scripts/testnet/grantKeeper.ts --keeper-role keeper --dry-run
# 确认后实际发出（三个 Vault 各一笔，Owner 签名取自 OWNER_PK / TEST_PK）
npx tsx --env-file=../.env.testnet scripts/testnet/grantKeeper.ts --keeper-role keeper
```

脚本是**幂等**的：已经处于目标状态的 Vault 会跳过，中途失败重跑只补没发成功的部分。撤销加
`--revoke`；授权给助记词以外的地址用 `--keeper 0x...`；Owner 如果是助记词钱包则用
`--owner-role governor`。

dry-run 输出示例（实际对 BNB Testnet 跑出来的）：

```
grantKeeper -> chainId 97
  owner signer: 0x425beB70d264362E4eb7953C4f7aFBDe01145538
  keeper:       0xEF2FF284a2dd06B9D7Be71447334C46c1BAe3AC5 (approved=true) [dry-run]
  cash 0x050509B6… — would setKeeper(0xEF2FF284…, true)
  note 0x6539622a… — would setKeeper(0xEF2FF284…, true)
  lp   0xAb28ed57… — would setKeeper(0xEF2FF284…, true)
```

### 2.4 Gas

keeper 钱包要有 testnet BNB 才付得起 gas。灌钱（幂等、串行发送）：

```bash
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts
```

默认每个钱包 0.002 BNB + 100000 MockUSDT，可用 `FUND_BNB_AMOUNT` / `FUND_USDT_AMOUNT` 覆盖。

---

## 3. 运行 KeeperBot

`offchain/scripts/runKeeper.ts` 把 `src/keeperBot.ts` 指向某个部署，轮询并推进
ProductState / CycleState。时间门槛全在链上（`StateManager`），bot 只是每个 tick 尝试下一个转移，
“时候未到”的 revert 会被当成 no-op 吞掉——这是稳态下的正常噪音，不是错误。

### 3.1 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--rpc <url>` | `RPC_URL` 或 `http://127.0.0.1:8546` | 目标链 |
| `--addresses <path>` | `scripts/testnet/addresses.bscTestnet.json` | 地址簿 |
| `--vaults <list>` | `cash,note,lp` | 逗号分隔，可用 `cash`/`note`/`lp` 或直接给地址 |
| `--once` | — | 只跑一个 tick 就结束（适合验证与定时任务） |
| `--poll <ms>` | `15000` | 常驻轮询间隔 |
| `--max-retries <n>` | `2` | 非“时候未到”类错误的重试次数，超过就发 alert |
| `--retry-delay <ms>` | `200` | 指数退避的基准延迟 |

签名模式（三选一，优先级自上而下）：

| 模式 | 说明 |
|---|---|
| `--pk 0x...`（或 `KEEPER_PK`） | 私钥签名 |
| `--role <name>` | 从 `TESTNET_MNEMONIC` 派生角色钱包，**私钥不进 shell history 与 `ps`**；名称取自 `scripts/testnet/wallets.ts` 的 `ROLE_INDEX`（`governor`、`keeper`、…） |
| `--impersonate 0x...` | 仅限 anvil fork，走 `anvil_impersonateAccount` |

### 3.2 先用 `--once` 验证

```bash
cd offchain
npx tsx --env-file=../.env.testnet scripts/runKeeper.ts \
  --rpc $BSC_TESTNET_RPC --role keeper --vaults cash,note,lp --once
```

输出（下面是在 BNB Testnet fork 上、以部署钱包 `--impersonate` 实跑的结果，所以 `signer` 是
`0x425beB70…` 而不是 keeper 钱包）：

```
KeeperBot -> http://127.0.0.1:8546 (chainId 97)
  signer: 0x425beB70d264362E4eb7953C4f7aFBDe01145538
  vaults: 0x050509B6…, 0x6539622a…, 0xAb28ed57…
  before 0x050509B6…  product=CONFIGURING cycle=ACCEPTING cycleNumber=0
  before 0x6539622a…  product=CONFIGURING cycle=ACCEPTING cycleNumber=0
  before 0xAb28ed57…  product=CONFIGURING cycle=ACCEPTING cycleNumber=0
  after  0x050509B6…  product=SUBSCRIBING cycle=ACCEPTING cycleNumber=0
  after  0x6539622a…  product=SUBSCRIBING cycle=ACCEPTING cycleNumber=0
  after  0xAb28ed57…  product=SUBSCRIBING cycle=ACCEPTING cycleNumber=0
Done. 0 alert(s).
```

解读要点：`signer` 是不是预期的钱包、`chainId` 对不对、`before`/`after` 有没有推进。状态没推进
且 `0 alert(s)` 是**正常的**——说明链上时间门槛还没到。

### 3.3 常驻轮询

```bash
npx tsx --env-file=../.env.testnet scripts/runKeeper.ts \
  --rpc $BSC_TESTNET_RPC --role keeper --vaults cash,note,lp --poll 15000
```

Ctrl-C（SIGINT）会干净停止。

### 3.4 Alert 的两种类型

| 类型 | 含义 | 该做什么 |
|---|---|---|
| `transition-error` | 某个转移重试 `--max-retries` 次后仍失败 | 看消息里的 revert；权限、gas、参数问题都会落在这里 |
| `final-settlement-pending` | Vault 处于 `SETTLING`，但 Settlement Operator 还没 `confirmFinalSettlement` | Keeper 自己解不开，要由结算方发多签确认，否则 `enterMaturing` 会一直 revert |

目前 alert 只会 `console.log`。要接 PagerDuty / Slack 之类，是在 `KeeperBot` 的 `onAlert` 回调
上接——`runKeeper.ts` 里就是那个 push 进数组并打印出来的函数。

### 3.5 到期请求的处置：由用户自己撤单

到期后仍留在队列里的请求永远等不到结算轮。**这件事不再由运维处理**——2026-08-20 起
`sweepExpiredRequests` 已从合约删除，KeeperBot 也不再有任何清理动作。取而代之的是持有人
（或其授权 operator）随时自己调 `BaseVault.cancelRequest(requestId)` 把钱取回。

**可撤单的阶段。** 只有两个阶段禁止，因为此时确实有一轮结算正压在这笔请求上：

| 阶段 | 是否允许 | 说明 |
|---|---|---|
| `cycle != ACCEPTING`（普通周期计算中） | 不允许 | 这笔请求正在被结算批次处理 |
| `product == SETTLING`（最终结算窗口） | 不允许 | 最终结算轮可能仍会成交它 |
| `SUBSCRIBING` / `OPERATING` 且 `cycle == ACCEPTING` | 允许 | 常规撤单窗口 |
| `MATURING` / `CLAIMING` / `CLOSED` | 允许 | 结算已不可能再发生，否则请求会被永久锁死 |

`SETTLING` 需要单独一条禁令：产品是在最终周期的 `completeCycle` 中进入 `SETTLING` 的，而
`completeCycle` 已经把 cycle 归还到 `ACCEPTING`，其后再无任何转换改动 cycle，所以
`SETTLING → MATURING → CLAIMING → CLOSED` 全程 cycle 都读作 `ACCEPTING`。

> **2026-08-24 变更**：金库暂停（Guardian `pause`）的冻结范围已扩大。此前暂停只挡住新申购、
> 新赎回申请与结算；现在 `claimDeposit` / `claimRedeem` / `claimRefund` / `cancelRequest` /
> `returnPrincipalToPool` 以及份额 `transfer` / `transferFrom` 同样被冻结。运营上意味着：暂停
> 期间用户无法领取已结算的赎回款与退款，也无法转让份额——这正是“紧急冻结止损”的预期行为，
> 但需要在对客沟通中提前说明。

**撤单后各类请求的去向：**

| 请求 | 结果 | 用户还要做什么 |
|---|---|---|
| PENDING 申购 | USDT 直接推回原持有人，请求转为 CANCELLED | 无需操作 |
| QUEUED 赎回、从未成交 | 锁定份额全额退回，请求转为 CANCELLED | 无需操作 |
| QUEUED 赎回、已部分成交 | 只退还未成交的 `remainingShares`，请求提升为 SETTLED | 仍需调 `claimRedeem` 领走已成交部分对应的 USDT |

最后一行是最容易被忽略的一种：这笔请求在链下看起来是“已作废”，钱却还在合约里等着领。
链下靠 `RedeemRecord.cancelledButSettled` 区分，前端必须继续给出 claim 入口——
详见 `docs/offchain-indexer-guide.md` §4。

**运维要注意的一点。** 没有任何人能替失联用户清账：一笔用户始终不来撤的申购会一直挂在
`pendingDepositLiability` 上，直到本人自己来取。这是有意的取舍——资金始终是用户的，
且 `CLOSED` 之后撤单窗口永久开放，不存在过期作废。

**手动协助。** 撤单只接受请求持有人或其授权 operator，运维**不能**代为执行。用户端可以用
控制面板的 `cancelRequest` 表单，或直接：

```bash
cast send $VAULT "cancelRequest(uint256)" $REQUEST_ID \
  --rpc-url $BSC_TESTNET_RPC --private-key $OWNER_PK
```

---

## 4. 运行 SettlementOperator

`offchain/scripts/runSettlement.ts` 从一份 JSON spec 组出 `SettlementInstruction`，收集 M-of-N 签名，
再发 `Settlement.submitBatch`。

**发之前先读 `docs/settlement-operator-runbook.md`**——批次组成不受合约强制，组错只会 revert 或
（最糟的情况）让 LP 以未扣业绩费的价格进场。两条硬规则：LP Vault 与它的 `cashVault()` 必须同批；
顺序是 `[LP Vault, Cash Vault]`。

spec 格式（金额用十进制字符串以免 JSON 精度问题）：

```json
{
  "cycleNumber": "1",
  "vaults": [
    { "vault": "lp",   "amount": "0", "deposits": [{ "requestId": "2", "settleAmount": "220000000" }], "redeems": [] },
    { "vault": "cash", "amount": "0", "deposits": [], "redeems": [] }
  ]
}
```

```bash
npx tsx --env-file=../.env.testnet scripts/runSettlement.ts \
  --rpc $BSC_TESTNET_RPC --spec ./batch.json \
  --operator-pks 0xaaa...,0xbbb...,0xccc... --relayer-pk 0xaaa...
```

`--operator-pks` 也可用 `SETTLEMENT_OPERATOR_PKS` 环境变量。relayer 只付 gas（`submitBatch` 本身没有
权限限制，门槛是那 M 份签名），默认用第一个 operator。脚本会先打印 `batchHash` 再发出，成功后打印
区块高度、tx hash 与 gas。

注意当前 v4 部署的 threshold 是 **1-of-1**（唯一 operator 是部署钱包），还没切到 3-of-5。

---

## 5. 常驻部署

KeeperBot 是唯一需要 7×24 常驻的组件（结算是事件驱动的人工／定时动作）。

pm2 示例：

```bash
cd offchain
pm2 start "npx tsx --env-file=../.env.testnet scripts/runKeeper.ts \
  --rpc $BSC_TESTNET_RPC --role keeper --vaults cash,note,lp --poll 15000" \
  --name hypertessera-keeper --time
pm2 logs hypertessera-keeper
pm2 save
```

systemd 示例（`/etc/systemd/system/hypertessera-keeper.service`）：

```ini
[Service]
WorkingDirectory=/opt/hyperTessera/offchain
EnvironmentFile=/opt/hyperTessera/.env.testnet
ExecStart=/usr/bin/npx tsx scripts/runKeeper.ts --rpc ${BSC_TESTNET_RPC} --role keeper --vaults cash,note,lp --poll 15000
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

运营注意事项：

- **私钥不要放在命令行参数上**（会进 shell history 与 `ps`）。用 `--role`（读 `TESTNET_MNEMONIC`）或
  `KEEPER_PK` 环境变量；正式环境建议接 secret manager。
- **keeper 用专属钱包**，不要和 governor / Owner 共用——分权的意义就在这里。
- **监控 BNB 余额**，余额归零时 bot 只会不断报 `transition-error`。
- 进程只有单一 timer，没有内置 leader election：**同一组 Vault 不要同时跑两个实例**，否则两边
  会抢同一个 nonce。

---

## 6. 换网络 / fork 演练

正式操作前，建议先在本地 fork 上把整套流程走一遍——状态是真的，但交易不会落到公链：

```bash
anvil --fork-url $BSC_TESTNET_RPC --port 8546 --silent &
cd offchain
npx tsx scripts/runKeeper.ts --rpc http://127.0.0.1:8546 \
  --impersonate 0x425beB70d264362E4eb7953C4f7aFBDe01145538 --vaults cash,note,lp --once
```

换到另一代部署或另一条链，只要换 `--rpc` 与 `--addresses` 两个参数，程序不用改。

---

## 7. 疑难排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `no signer: pass --role ...` | 三种签名模式都没给 | 补 `--role` / `--pk` / `--impersonate` |
| `TESTNET_MNEMONIC is not set` | 没加载 env 文件 | 加 `--env-file=../.env.testnet`，或 `set -a; source .env.testnet; set +a` |
| `unknown --role 'xxx'` | 角色名拼错 | 报错信息会列出全部合法名称（见 `ROLE_INDEX`） |
| `[alert:transition-error] … data="0xf512b278"` | `NotKeeper()`——该钱包没有 Keeper 授权 | 跑 §2.3 的 `grantKeeper.ts` |
| `[alert:transition-error] … insufficient funds` | keeper 没有 BNB | 跑 §2.4 的 `fundWallets.ts` |
| `[alert:final-settlement-pending]` | 等结算方多签确认 | 见 §4，Keeper 端不用处理 |
| 状态一直不动、也没有 alert | 链上时间门槛未到（正常） | 对照 `getStateContext` 的 `product`/`cycle` 与产品参数的时间设置 |
| RPC 频繁 timeout / 限流 | 公共 endpoint 限流 | 换 `BSC_TESTNET_RPC`（模板里有备用列表）或改用自建节点 |
| 用户撤单报 `CancelNotAllowed` | 正处于普通周期计算中（`cycle != ACCEPTING`），或处于最终结算窗口（`product == SETTLING`） | 见 §3.5 的阶段表。前者等本轮 `completeCycle`，后者要等 Keeper 推进到 `MATURING` |
| 用户说赎回撤单后钱不见了 | 部分成交的赎回被提升为 SETTLED，USDT 仍需 `claimRedeem` 领取 | 用 indexer 的 `getRedeemRecord` 看 `cancelledButSettled` 与 `settledAssets`，指引用户 claim |
