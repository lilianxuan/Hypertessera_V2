# KYTDepositGateway 接入说明

修订日期：2026-09-21。PR45 配套手册。

本手册以 [commit 4890024 中的原手册](https://github.com/alliancechuan/hyperTessera/blob/4890024a76e1c306dca79e23d2087349c7049ae2/docs/kyt-deposit-gateway.md) 和 PR45 已提交的事件处理器为基础，同步完整运行入口、脚本测试及部署要求。两个脚本的逐项说明、完整配置及 AWS 操作步骤见 [链下脚本说明与 AWS 部署方案](./kyt-offchain-scripts-and-aws-deployment.md)。

**当前状态：两个脚本已完成本地实现与功能验证；AWS 部署、真实 API/链上联调与短时突发容量仍需按本文验收。按本次确认范围，不纳入区块重组处理或相关验收。**

| 交付物 | 状态 |
| --- | --- |
| `src/compliance/KYTDepositGateway.sol` | 本次没有修改，仍为三参数 `fulfill` 接口 |
| `offchain/src/kytScreeningBot.ts` | PR45 已包含修订版；本轮复查没有再次修改 |
| `offchain/scripts/runKytScreening.ts` | 完整适配版；包含启动阶段停止处理修复，与本 PR 的机器人配套 |
| 脚本测试 | TypeScript 检查及 94 项 KYT 功能、回归测试通过 |
| Solidity 测试 | 原手册记录 43 项通过；本次不改合约，未在本机重跑 Solidity 测试 |
| AWS、真实 API、真实链与容量验证 | 尚未完成 |

## 1. 总体设计

不修改已审计的 Vault。`BaseVault` 通过 `gate` 钩子检查申购：`requestDeposit` 调用 `IGate(gate).isAllowed(owner)`，`setGate(address)` 通过 `_onlyOwnerDirectOrTimelock` 管理。`gate == address(0)` 表示关闭该检查。

一个 Vault 部署一个 Gateway。Gateway 的 `vault` 在构造时写入 immutable，付款代币 `asset` 从 `vault.usdt()` 读取并固定；申请函数不接受另一个 Vault 地址。

链下最小架构为已有 AWS Linux 服务器上的一个 Node.js 进程：WSS 接收新事件，HTTP RPC 查询和发送结果交易，Chainalysis HTTPS 接口提供付款地址风险结论。无需新增数据库、消息队列或多实例集群。

## 2. 开启 KYT 的申购流程

完成授权、gate 接线、服务启动及上线验收后：

1. 客户调用 `Gateway.requestDeposit(amount, owner)`。Gateway 以 `msg.sender` 记录付款地址 payer，保存权益归属地址 owner、金额、编号、时间和有效期；**不扣款**，发出 `ScreeningRequested`。
2. 服务通过 WebSocket 收到事件，只筛查 payer。多个申请并发筛查，有效结论按完成顺序进入发送队列。
3. 预言机账户调用当前接口 `fulfill(id, passed, screenedAt)`。发送下一笔交易无需等待上一笔交易的回执，但使用同一账户的连续 nonce。
4. 通过且交易成功时，同一笔交易内从付款钱包扣款至 Gateway，Gateway 授权 Vault 并调用 `Vault.requestDeposit(amount, owner)`；权益归属 owner。
5. 不通过且结果交易成功时，申请变为 REJECTED，不扣款。

这里的执行成功是**成功提交金库申购**，不代表后续金库结算及份额领取已完成。API 没有给出有效结论时，脚本结束本次处理，不伪造通过或拒绝。已经广播的交易不能因为客户等待结束就视为不存在。

网站、机构接口和直接合约调用都必须遵守同一条链上 gate 路径。前端不决定筛查结论。

## 3. 关闭 KYT 的申购流程

治理将 `Vault.gate` 设置为 `address(0)` 后，客户直接调用 `Vault.requestDeposit(amount, owner)`，代币由付款钱包进入 Vault，不经过 Gateway 或筛查脚本。Gateway 没有自己的 KYT 开关。

前端根据 `vault.gate()` 选择入口。**停止链下服务不等于关闭 KYT**；若 gate 仍指向 Gateway，直接向 Vault 提交申购仍会被 gate 拒绝。

## 4. `isAllowed` 的语义

Vault 检查的是 owner，而实际筛查的是 payer，两者可能不同。Gateway 不维护地址白名单，而是只在执行一笔通过筛查的申购期间，为其 owner 临时放行：

```solidity
function isAllowed(address account) external view returns (bool) {
    return account != address(0) && account == _inFlightOwner;
}
```

`_inFlightOwner` 仅在 `fulfill` 调用 Vault 的上下文中非零，结束后归零。因此 gate 指向 Gateway 时，客户直接调用 Vault 不会得到放行。该变量使用普通 storage；本实现不要求 transient storage/TSTORE。

## 5. 授权准备

| 配置 | 付款地址需要做的操作 | 权益归属地址需要做的操作 |
| --- | --- | --- |
| 关闭 KYT | 授权付款代币给 Vault | 付款地址与权益归属地址不同时，`vault.setOperator(payer, true)` |
| 开启 KYT | 授权付款代币给 Gateway | `vault.setOperator(gateway, true)` |

客户自己付款、权益也归自己时，开启 KYT 仍需要上述 Gateway 代币授权和 operator 授权。代币剩余额度足够且 operator 未撤销时，不必每次重复授权。代币额度被用完或被调低后需补充；operator 是持续开关，直到撤销。链下脚本修改不改变钱包授权流程。

客户不应直接 `USDT.transfer(Gateway, amount)` 代替 `requestDeposit`：普通 ERC-20 转账不会自动调用 Gateway 的申请函数。当前流程在申请时不收款，只在通过筛查的结果交易中扣款。

## 6. 核心接口与状态

| 接口 | 权限与行为 |
| --- | --- |
| `requestDeposit(uint256 assets, address owner)` | 任何人；金额须非零、owner 须非零；payer 固定为调用者；记录申请但不扣款 |
| `fulfill(uint256 id, bool passed, uint64 screenedAt)` | 仅 oracle；提交结论，通过时立即调用 Vault |
| `cancel(uint256 id)` | 仅记录的 payer；取消 PENDING 申请；网站无取消按钮不等于合约无此接口 |
| `isAllowed(address)` | view；仅正在执行的申购上下文放行 |
| `getRequest(uint256 id)` | view；查询完整申请；脚本人工查询助手保留，自动流程不调用 |
| `setOracle(address)` | 仅 admin；轮换结果提交账户 |
| `setValidityPeriod(uint64)` | 仅 admin；调整后续申请有效期，范围 5 分钟至 7 天 |
| `transferAdmin(address)` | 仅 admin；转移管理员权限 |

构造参数为 `(vault, oracle, admin, validityPeriod)`。预言机是被配置的签名账户，不是本次需要另外部署的一份预言机合约。

```text
NONE → requestDeposit → PENDING
                         ├─ fulfill(true)  → EXECUTED
                         ├─ fulfill(false) → REJECTED
                         └─ cancel         → CANCELLED
```

超过 expiresAt 的 PENDING 申请不能再执行，无需自动清理。本地处理超时不会改变链上状态，也不会自动调用 cancel。

主要事件包括 `ScreeningRequested`、`ScreeningRejected`、`DepositExecuted`、`RequestCancelled`、`OracleUpdated`、`AdminTransferred`、`ValidityPeriodUpdated`。处理器使用自带最小 ABI，订阅事件为：

```solidity
event ScreeningRequested(
    uint256 indexed id, address indexed payer, address indexed owner,
    uint256 assets, uint64 expiresAt
);
```

监听器的最小 ABI 不依赖 `abis-registry.ts`。公共 ABI 已通过 `control-panel/build-abis.sh` 同步生成，SDK 类型注册与 Gateway 封装、控制面板也已补齐；用法及发布步骤见 [KYT SDK 与控制面板接入](./kyt-sdk-panel.md)。

## 7. 有效期、时间戳和处理窗口

### 7.1 链上规则

expiresAt 在申请时快照；后来修改 validityPeriod 不改变已有申请。`fulfill` 要求 `block.timestamp <= expiresAt`，等于边界仍有效。

screenedAt 只有上界：不得晚于执行交易的区块时间。没有 `screenedAt >= requestedAt` 的下界，允许使用更早的合法缓存结果。状态机阻止同一申请重复执行，expiresAt 限制可执行的时间范围。

### 7.2 当前脚本的时间戳

机器人要求 screenedAt 为正安全整数，单位 Unix 秒，不晚于脚本当前时间；不会把未来时间戳偷偷改成当前时间。当前 Chainalysis 适配器在**收到并校验有效结论后**取服务器当前时间，日志及 reason 标明 `timestamp=result-retrieved-at`。这表示本次取回结论的时间，不是供应商原始评估时间。

服务器必须保持时间同步，否则可能出现未来时间戳导致合约拒绝或本地截止时间不准确。

### 7.3 四种时间的区别

| 时间 | 起点和当前默认值 |
| --- | --- |
| 链上有效期 | 申请区块时间起，由 Gateway 配置；最短仍为 5 分钟 |
| 本地提交截止 | 进程收到事件起第 50 秒；不再为该任务调用新的 Provider 广播 |
| 本地确认目标 | 收到事件起第 60 秒；目标时间，不是链上保证 |
| 回执跟踪期限 | 开始广播起默认约 60 秒，用于核对已发交易 |

排队、筛查、有限 API 重试、等待发送名额、准备和签名共享提交截止时间。Provider 接收广播调用后，还可能等待 RPC 额度或网络；此时按“已开始提交”处理，不能证明尚未发出。运行入口对 HTTP RPC 排队和请求整体设置超时，取消尚未发出的传输请求，但不能撤回已经到达节点的交易。

**50/60 秒不会缩短合约有效期。** 已提交交易仍可能在 60 秒以后执行并扣款。本次没有实现“60 秒后链上绝对不准执行”。

## 8. 已知约束与安全边界

### 8.1 只筛查申购资金来源

赎回、份额领取、退款和份额转账不筛查。被拒绝地址仍可能作为领取 receiver 或接收转账取得份额，本次不扩大原先确认的筛查范围。

### 8.2 退款归属

Vault 的退款对象是 owner，不是 payer。两者不同时，代付方与受益方自行结算；已审计退款逻辑不变。

### 8.3 申购条件变化与交易回滚

筛查期间可能发生余额/授权不足、金库申购窗口关闭、额度用尽或清算等变化。Vault 拒绝时整笔 fulfill 回滚，不发生该笔申购的资金移动，也不留下成功结论。脚本不重试 fulfill。

广播前估算失败不消耗本地分配的 nonce；上链回滚会消耗 nonce 和 gas。

### 8.4 独占预言机账户

每个交易发送器独占一个 oracle 账户。不能同时运行另一份相同服务、其他发单脚本或人工用同账户发交易。多 Gateway 最小部署方案是不同发送器使用不同 oracle，但 API/RPC 账号总额度仍可能共享。

### 8.5 不补扫与容量边界

本版不建立数据库、不保存区块游标、不补扫、不恢复重启前任务、不按申请编号去重，也不在筛查前预读 getRequest。内存任务集合、发送队列和按哈希跟踪的回执记录仅用于本进程调度。

离线期间的申请可能无人处理；重复通知可能造成重复筛查或额外交易尝试。同一条链上的重复执行由合约状态机拦截。任何地址均可提交申请，API/RPC 限速并不是反垃圾申请机制，不能保证恶意流量下每笔任务按时完成。

## 9. 链下监听脚本

### 9.1 两个文件分工

`offchain/src/kytScreeningBot.ts` 负责订阅、重连、任务期限、并发筛查调度、nonce 分配、交易准备/签名/广播和回执跟踪。它不解析供应商 API。

`offchain/scripts/runKytScreening.ts` 负责配置、Chainalysis GET 适配器、API/RPC 限速、HTTP 超时、启动接线验证、日志和进程退出。本 PR 包含配套入口；不可搭配 PR44 旧轮询机器人使用。

### 9.2 接收、并发和发送

1. 入口先验证预期链、合约代码、Gateway/Vault/asset/gate 绑定及 oracle 地址。
2. 机器人读取网络及 pending nonce，新建原生 WebSocket，核对 WSS 链 ID，再订阅指定 Gateway。
3. 完成订阅才接单。收到事件后计时，并发筛查默认 20 个任务；按筛查完成顺序准备发送。
4. 单发送器串行分配 nonce、准备、签名和广播；最多 16 笔已开始提交的交易等待结果，不要求上一笔先确认。
5. 默认每轮回执查询间隔 1 秒，一轮最多 4 个并发读取，所有 HTTP RPC 仍受统一限速约束。

并发数不是每秒调用数；结果完成顺序也不等于跨账户全局成交顺序。`executed` 只表示对应 fulfill 成功确认。

### 9.3 断线与重连

建立连接时通过 eth_chainId 验证网络。有效心跳回复后默认等待 15 秒再检查，单次应答上限 10 秒；静默断线同样可触发故障处理。发现断线后默认等 5 秒重连，并清理旧订阅和计时器。

5 秒不是任何故障都在 5 秒内恢复。初次启动失败抛给入口并退出；运行中 WSS 故障自动重连，不补扫离线事件。断线前已进入内存的任务仍可能通过 HTTP 完成。

### 9.4 Chainalysis 处理

- 直接 GET `https://api.chainalysis.com/api/risk/v2/entities/{payer}`，使用 `Token` 请求头；不先 POST 注册，不跟随重定向。
- 校验响应 address 等于 payer，status 严格等于 COMPLETE，risk 属于 Low/Medium/High/Severe。风险字符串大小写与首尾空格统一处理。
- 默认 `KYT_BLOCK_RISK=Severe,High`，有效 High/Severe 生成 passed=false；Medium/Low 生成 passed=true。空配置、空项和未知等级阻止启动；未知响应等级不会默认放行。
- 单次 HTTP 超时默认 5000ms；任务取消、服务停止和任务截止时间会中止排队或请求。
- 网络瞬时错误、单次 HTTP 超时、429、500/502/503/504 最多额外 GET 一次；两次合计共同限速。
- 429 支持秒数或 HTTP 日期形式的 Retry-After，对进程内 API 队列统一冷却；默认无有效头时等待 1 秒，其他可重试故障默认等待 500ms；剩余时间不足不重试。
- 400/401/403/404 等不可重试错误、无效 JSON、地址不符、非 COMPLETE、无效等级直接结束，不循环查询状态。

API 默认上限 30 次/秒，可配置到 40；采用平滑放行，实际速率可能略低。同账号其他服务的调用需一并计算。API 故障不会切换成 allow，也不会伪造一份“筛查不通过”的供应商结论。

### 9.5 失败、暂停和停止

| 情形 | 当前处理 |
| --- | --- |
| 筛查异常或无效结果 | screening-error，结束该任务，不提交结果 |
| 未广播任务超过提交截止 | processing-timeout，放弃任务，迟到结论不触发广播 |
| 准备或签名失败 | submit-error，不递增发送 nonce，不重试申请 |
| 广播报错或应答超时 | submission-uncertain，停止新任务，有限跟踪已知哈希，最终退出码 1 |
| 暂无回执或查询报错 | 期限内查询同一哈希，不重发交易 |
| 成功/失败回执达到确认数 | executed、screening-rejected 或 execution-reverted，释放发送名额 |
| 超过确认目标或回执跟踪期 | submission-uncertain，不自动恢复，不视为交易取消 |
| SIGINT/SIGTERM | 停止接单、放弃未广播任务，有限跟踪已发交易后退出 |
| 启动验证中收到停止信号 | 机器人尚未创建时立即销毁 HTTP Provider，取消在途及排队读取 |

日志为逐条 JSON，支持 BigInt 字段；不累积历史日志数组，不输出密钥、鉴权 URL 或上游原始错误正文。当前仅写标准输出/错误流；CloudWatch、短信或其他通知渠道需要部署侧接入，代码没有自动安装这些服务。

### 9.6 配置与入口

生产必填：`RPC_URL`、`WSS_URL`、`KYT_CHAIN_ID`、`KYT_GATEWAY`、`KYT_VAULT`、`KYT_ASSET`、`KYT_ORACLE_PK`、`CHAINALYSIS_API_KEY`、`KYT_RPC_RPS`。

| 环境变量 | 默认值/要求 |
| --- | --- |
| KYT_ENV / KYT_SCREENER | production / chainalysis |
| KYT_BLOCK_RISK | Severe,High |
| KYT_API_RPS / KYT_API_TIMEOUT_MS | 30 / 5000 |
| KYT_RPC_RPS | 必填；按实际共享账户剩余额度分配 |
| KYT_SCREENING_CONCURRENCY / KYT_MAX_PENDING_TX | 20 / 16 |
| KYT_PROCESSING_WINDOW_MS / KYT_CONFIRMATION_RESERVE_MS | 60000 / 10000 |
| KYT_CONFIRMATIONS | 1，结果交易确认数 |
| KYT_RECONNECT_DELAY_MS / KYT_HEARTBEAT_INTERVAL_MS | 5000 / 15000 |
| KYT_RPC_TIMEOUT_MS | 10000 |
| KYT_RECEIPT_POLL_MS / KYT_RECEIPT_TIMEOUT_MS | 1000 / 60000 |

完整字段、参数优先级、校验规则和配置模板见配套部署文档。`KYT_RPC_RPS` 是进程限速，不表示独立端点。用户提供的 QuickNode Accelerate 额度为全账户共享 125 RPS，不能把每个端点都按 125 分配；还需给 WSS 和其他服务留余量。

使用 Node.js 24+，在 offchain 目录、已注入环境变量的条件下运行：

```bash
node --import tsx scripts/runKytScreening.ts
```

支持 `--rpc --wss --chain-id --gateway --vault --asset --screener --confirmations` 和 `--help`。不再支持 `--pk --impersonate --poll --once --from-block --max-retries --retry-delay`。配置仅启动时读取，修改后需正常停止再启动。

生产模式允许链 ID 56/97/143（BSC 主网、BSC 测试网、Monad 主网），要求 HTTPS/WSS 和 Chainalysis。allow/denylist 仅允许 KYT_ENV=local、链 31337 且两端点均为本机回环地址。Chainalysis 使用主网地址数据，测试网资金活动不能当作供应商真实覆盖的数据。

## 10. 部署与切换

### 10.1 已落实的四点

1. **Node.js 24 和原生 WSS 工厂：** 入口检查 Node 版本与 WebSocket 可用性；每次重连新建连接；HTTP 预期链及 HTTP/WSS 一致性分别校验。
2. **单发送器及本地 Wallet：** 入口构造 ethers.Wallet，启动核对 oracle；账户独占需部署侧保证，脚本没有跨进程锁。
3. **API/RPC 分别统一限速：** API 请求和有限重试统一计数；自定义 HTTP Provider 覆盖 ethers 内部 RPC，禁用批处理和 HTTP 自动重试。WSS 调用仍需另留账号额度。
4. **50 秒提交截止、60 秒目标及异常停止：** 入口传入窗口并将截止时间/终止信号接入 API；submission-uncertain 接入停止流程和退出码 1。已经广播的交易继续有限核实。

这四点已在代码中落实，但不表示真实网络的容量、确认速度或整体安全问题已完成验收。

### 10.2 AWS 服务

在现有 Linux 服务器使用一个专用用户、一个 systemd 服务管理单个 Node 进程。不为机器人新增公网入站业务端口；允许出站访问目标 HTTPS/WSS，并保持 DNS 与时间同步。

代码只读取环境变量，不主动访问 AWS Secrets Manager，也未引入 AWS SDK。如已有秘密注入流程，可沿用；否则须在部署阶段落实受控注入，不能把“运行入口已实现”理解为“秘密获取也已自动实现”。密钥不提交仓库、不贴入日志或命令行。

采用 `Restart=no`；默认参数下 `TimeoutStopSec=90`。本版没有持久化未决状态，采用人工核对后启动；不配置自动开机启动或其他外部自动拉起机制。仅 Restart=no 并不能阻止一个已 enable 的 unit 在机器重启后启动。WSS 的连接重试由进程内部完成。

完整服务模板、目录约定、依赖安装、配置加载、日志、更新和故障恢复命令见 [部署文档第 6 节起](./kyt-offchain-scripts-and-aws-deployment.md)。

### 10.3 正确的启用顺序

1. 冻结匹配的 Gateway ABI、机器人、运行入口、测试和依赖锁文件，完成类型检查、构建与脚本测试。
2. 部署目标 Gateway，核对 vault、asset、oracle、admin 和 validityPeriod；明确该实例的独占预言机账户并补足 BNB gas。
3. 在未开放正式认购的阶段完成 `vault.setGate(gateway)`：CONFIGURING 阶段按权限可由治理 Owner 直接调用，其后走该 Vault 的 timelock schedule → 等待 delay → execute。若使用部署脚本，打印 calldata 不代表已完成 gate 接线。
4. **gate 接线完成后才能启动当前运行入口。** 入口要求 `vault.gate() == gateway`，否则 KYT_GATE_MISMATCH。原先“先启动服务再设置 gate”的顺序不适用。
5. 注入真实配置，启动服务，核对 connected 和 ready 日志。准备客户代币及 operator 授权，在受控环境完成通过、拒绝和故障情景。
6. 完成真实容量与运维验收后再开放募集。仅隐藏前端入口不能阻止客户直接调用合约，部署期间的认购开放状态应以链上实际条件为准。

cash/note/liquidity 标签是部署文件与具体 Vault 选择问题，不代表 Gateway 只支持 cash；每个服务必须明确绑定的单个 Vault/Gateway。若某份部署脚本默认读取 cash 文件，需在执行前核对该脚本的参数，不能据此推断其他 Vault 被禁止部署。

### 10.4 更新、停用与恢复

- 改风险等级或升级代码：停止旧实例，等待有限跟踪结束并核对未决交易，更新配置/代码后人工启动新实例；不要滚动运行两个相同 oracle 的实例。
- WSS 断线：检查重连和重新订阅；不补扫。重新申请前先核对原申请是否已有结果交易，不能因网页超时就判断不会扣款。
- submission-uncertain、崩溃或重启：核对日志中的所有未决哈希、链上回执和账户 pending nonce 后再恢复；单次 receipt=null 不证明没发送。
- 关闭 KYT：沿原治理路径设置 gate=0；这意味着允许不经 KYT 的直接 Vault 申购，不能作为普通网络故障的自动降级动作。

## 11. 验证记录与待完成事项

### 11.1 本地验证

本次在 PR45 分支源码（整合前提交 d75df711c66c36dbf774b308f97001391a930432）中替换完整入口及测试，按原锁文件离线安装依赖后，类型检查、构建及全部 208 项链下非集成测试通过，其中 KYT 两个脚本共 94 项。Windows 本地因配置打包工具的目录访问限制，使用等效测试配置运行；GitHub CI 使用仓库原测试命令。

验证环境使用 Node.js 24.14.1、ethers 6.17.0、TypeScript 5.9.3、Vitest 2.1.9。

- 机器人：26 项单元测试及 1 项本机传输测试。
- 入口：62 项单元测试及 5 项本机传输/生命周期测试。
- 合计 94 项功能和回归测试通过，TypeScript 检查通过。

测试覆盖配置、结果校验、有限 API 重试、API/RPC 限速、并发及 nonce、期限、广播不明确时不重发、回执、WSS 重连和生命周期。启动阶段中止 RPC 的回归测试在修复前失败，修复后通过。

本机传输测试使用真实本机 HTTP/WebSocket 和 Wallet 签名，但节点响应为模拟数据；未执行真实合约或真实 Chainalysis 请求。本地测试不替代真实供应商接口、链上交易与 AWS 部署验收。

### 11.2 上线前仍需完成

1. 在部署服务器按发布版本执行类型检查、构建及脚本测试，核对 Node.js 和依赖锁文件。
2. 联调真实授权 API，核对响应格式、阻断等级、配额和故障行为；在目标链验证通过、拒绝、授权/余额不足、窗口关闭等情景。
3. 在 AWS 验证 WSS 故障、停止和异常交易恢复、时间同步、日志保留及实际告警。
4. 压测“一秒进入 100 笔申请，随后流量回落”，再测试连续数秒的同级峰值。按申请记录接收、筛查完成、广播、确认及超时情况，同时观察共享 API/RPC 额度。

100 笔模拟输入只能证明本地调度行为；本次没有证明真实每笔申请能在 60 秒内完成，也不支持把目标写成持续每秒 100 笔。

### 11.3 对应脚本标识

```text
offchain/src/kytScreeningBot.ts
SHA-256 93137145DB38A2A3379CC2B2A821799377604493DCB462A482D2CE624BFDC3FE

offchain/scripts/runKytScreening.ts
SHA-256 A587910732583F245775C15A94693DF558E941E8059EA67425A284E84BD99A06
```

标识对应本次文档描述的配套代码。后续改动接口或实现后须重新同步哈希、文档和验证记录。

### 参考资料

- [PR45](https://github.com/alliancechuan/hyperTessera/pull/45)
- [Chainalysis Address Screening](https://developers.chainalysis.com/address-screening/docs/get-started/introduction)
- [GET 风险评估接口](https://developers.chainalysis.com/address-screening/api-reference/screening/retrieve-an-addresss-risk-assessment)
- [API 概览与限额](https://developers.chainalysis.com/address-screening/api-reference/api-overview)
- [风险设置](https://support.chainalysis.com/hc/en-us/articles/8610498710932-Risk-settings)
- [配套脚本说明及 AWS 部署方案](./kyt-offchain-scripts-and-aws-deployment.md)
