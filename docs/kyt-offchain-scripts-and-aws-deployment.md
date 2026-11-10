# 2026-10-19：按上游故障来源降级，恢复前重新验证

2026-10-09 的读侧恢复只列出 HTTP 408/429/5xx，遗漏 409，Monad 在健康读取返回 409 时仍会退出。本次以 transport 标记的 `RpcReadError` 区分外部读故障和本地程序错误，避免继续依赖零散状态码名单。

只读启动与周期配置验证使用 `eth_chainId`、`eth_getCode`、`eth_call` 和启动 nonce 读取 `eth_getTransactionCount`。这些读取遇到凭据/端点错误 401/403/404 以外的 HTTP 失败、网络/超时、无效 JSON/响应信封/结果格式时，保持降级，以 1/2/4/8/16/30 秒退避，上限 30 秒。经过 transport 验证的 JSON-RPC 数字错误也默认降级，涵盖供应商自定义码（如 -33000/-1），不局限于标准服务器区间；明确请求/方法/参数/版本不兼容（-32700/-32600/-32601/-32602/-32004/-32006）仍停止。错误链、凭据拒绝和真实配置错误仍停止或隔离 Gateway。任意本地异常和未经 transport 确认的 `BAD_DATA`/`UNKNOWN_ERROR` 不纳入自动恢复。

每次外部故障发 `connection-error`，附仅含安全方法名、HTTP 状态或 JSON-RPC 数字错误码的诊断；不记录端点、响应正文或上游错误消息。运行中同时发 `health ready=false`，完整重验链、bytecode、oracle、vault、asset 和 gate 后才恢复并发 `health-recovered`。持续故障由连接错误及 not-ready 告警发现。启动重连完成订阅后，也必须再次完整验证才能发 `ready` 和处理队列，避免长时间重连期间配置漂移。

配置未知时不启动新的筛查、签名或广播；WSS 仍接收申请并保留到既有处理截止时间，已开始的筛查结论可进入等待队列。准备/签名返回后再次检查状态，降级时丢弃未广播交易，恢复后重新准备且不提前消耗 nonce。已广播交易继续有限回执追踪，结果不明仍停机、人工对账；没有广播自动重试。

WSS 链查询和订阅的临时上游错误或坏响应也可退避重连；明确错误链或协议不兼容仍停止。实际进程停止后仍不自动启动，也不补扫历史事件。Chainalysis 风险 API 的重试规则不变，其 HTTP 409 不重试。

KYT 持续离线时，该链已开启 gate 的新申购不能完成；创建筛查申请仍可能成功并支付 gas，但此阶段不扣申购本金。当前 300 秒申请过期后不能 fulfill，需重新申请；其他链和不经过 KYT 的赎回/领取不受这个入口影响。

验证：类型检查、350 项链下测试和真实 Anvil 六场景通过。原生 HTTP/WSS 覆盖启动/健康读取 409、425、502、坏响应、JSON-RPC 服务器及供应商自定义错误；持续 409 时申请按期限结束且不签名/广播，临时故障恢复后只广播一次；广播 409 仍按结果不明确停止。并覆盖 WSS 重连期间 oracle 漂移、凭据/协议拒绝和程序错误的停止边界；仅恢复旧 409 停机分类时，两个原生回归均失败；供应商错误降级补充前，新增六项回归均失败。上线仍须按 AWS 变更流程执行。

# 2026-10-07：每链共用 oracle 扩展

同链可通过 `KYT_GATEWAYS` JSON 配置多个 `{gateway,vault,asset}`。不能同时配置旧的单 Gateway 环境变量或 CLI 覆盖。
一个 runner、一把本链专用 key、一套 nonce 与 pending 交易队列处理所有注册 Gateway；不同链独立运行。
`KYT_MAX_TX_FEE_WEI` 可设每笔交易的最高手续费预算，超过预算在签名前拒绝，不消耗 nonce。
生产允许链 1、56、97、143、43114，仍要求显式 chainId、RPC/WSS 和完整部署配置，不提供默认链或公共 RPC。

请求来源保留 Gateway；同一个 Gateway 的重复在途请求合并，不同 Gateway 的相同 requestId 独立处理。
队列截止时间同时服从本地处理目标和链上 expiresAt；为各 Gateway 保留 pending 配额。手续费来自实际链。
健康时每 30 秒核对部署绑定并打印 `health`（ready、队列、pending、费用预留、等待时间）；暂时读侧错误按上节降级重试，单 Gateway 配置漂移隔离该项；错误链、未知异常或广播状态不明停止本链实例。
没有历史恢复或自动补发；未知广播仍停止并要求核对回执/nonce。共享的同链 key 禁止被第二个 sender 使用。

本地验证：KYT unit/transport 套件及真实 Anvil 上三个 Gateway 同 oracle、重复 requestId、连续 nonce 的集成测试。
以下单 Gateway 使用方式保留兼容；每 Gateway 独立 key 是旧部署形态，不再是合约层限制。

---

# KYT 链下两个脚本：实现说明与 AWS 部署方案

修订日期：2026-09-21。适用文件：

- `offchain/src/kytScreeningBot.ts`
- `offchain/scripts/runKytScreening.ts`

本文是 PR45 的实现及部署手册；文档发布不代表已在 AWS 执行安装、启动或交易。合约与客户申购流程见 [KYTDepositGateway 接入说明](./kyt-deposit-gateway.md)。

**两个脚本按本文配套运行。真实 API、链上资金路径及短时突发容量需在实际环境验收。按本次确认范围，不纳入区块重组处理或相关验收。**

## 1. 版本、目标与范围

### 1.1 版本基线

事件处理器最初来自 PR45，当前配套版本包括每链 Gateway 注册表、上述读侧恢复，以及按链上时间提交 `screenedAt` 与签名前重新准备（§3.1）。下列哈希对应当前实现，历史基础说明中的行为更新以上述修订为准。

```text
offchain/src/kytScreeningBot.ts
SHA-256 8B0C0C489FA99137DD4B6B27C54D531FEF2D41310BD201595C25B67D44E17556

offchain/scripts/runKytScreening.ts
SHA-256 B391D833585F5BA97FE25A4802877B92998E173867B8307066A377B17C92AF8C
```

两个脚本必须配套；新入口不能配 PR44 的旧轮询机器人。后续改动实现或接口时，须同步调用方、测试、哈希和本文。

### 1.2 已确认的目标

在已有 AWS Linux 服务器运行单实例服务。BNB Chain 上客户提交申请后，尽快收到 WSS 事件并筛查资金来源地址，通过后提交结果交易。抢购目标是每秒 100 笔的短时突发，随后回落；按筛查完成顺序处理，默认接收事件后 60 秒为确认目标。

当前本地测试验证了调度及限速行为，没有证明真实网络每笔申请均能在 60 秒内确认。现有 Chainalysis 40 RPS 配额也不支持每笔至少一次查询时持续每秒 100 笔。

保留已确认的最小范围：不引入 SQLite/Redis/SQS；不补扫、不保存区块游标、不按申请编号去重、不在每笔筛查前 getRequest 预读；不重发已签名或已广播的 fulfill；不修改已审计的 Vault。签名前的准备失败（估算回滚、读侧故障）不占 nonce，在提交期限内退避重新准备，见 §3。

## 2. 两个脚本如何配合

```text
客户 → Gateway.requestDeposit → ScreeningRequested
                                  │
                                  ▼ WSS
runKytScreening.ts 创建并启动 KytScreeningBot
                                  │
kytScreeningBot.ts：计时 → 内存队列 → 并发调用 screener
                                  │
runKytScreening.ts：API 统一限速 → GET Chainalysis → 验证结论
                                  │
kytScreeningBot.ts：按完成顺序准备/签名 → 串行广播 → 跟踪回执
                                  │
runKytScreening.ts：HTTP RPC 统一限速、日志、异常停止、资源清理
                                  │
Gateway.fulfill → 拒绝不扣款，或扣款并提交 Vault 申购
```

生产中只启动运行入口，不单独运行 `kytScreeningBot.ts`。入口没有 HTTP 业务服务器，不向客户提供新的认购 API；客户仍通过 Gateway 合约提出申请。

## 3. kytScreeningBot.ts 的完整说明

### 3.1 修改方向及理由

| 修改 | 实际作用与理由 |
| --- | --- |
| 区块轮询改为 WSS logs 订阅 | 新事件到达即进入处理，不再等待下一轮 15 秒扫描 |
| 删除游标、补扫、settled 去重和自动 getRequest 预读 | 遵循本次实时处理、无额外持久化的范围；代价是离线遗漏不恢复、重复通知可能多处理 |
| 引入事件输入和 ScreeningContext | 明确每笔申请的付款地址、接收时间、提交截止时间和取消信号 |
| 有限并发筛查 | 短时突发不被逐笔 API 等待完全串行阻塞；RPS 限额仍由入口控制 |
| 完成顺序发送、单发送器分配 nonce | 先完成筛查的申请先进入提交；同账户避免本进程内部 nonce 冲突 |
| 广播与回执跟踪分开 | 不因等待上一笔确认而阻塞下一笔准备；控制同时待确认数量 |
| 删除 fulfill 重试循环 | 发送结果不明时不以再次调用制造重复发送或 nonce 混乱；签名前的重新准备不属于此类 |
| `screenedAt` 不晚于 RPC 最新区块时间 | 服务器秒数常比最新区块早一秒，估算以 `InvalidScreeningTime` 回滚，客户申请白白过期 |
| 签名前失败在期限内退避重新准备 | 负载均衡 RPC 的不同节点高度不一、客户稍后补足余额或授权；未签名、未占 nonce，不会重复发送 |
| 增加期限、停止、订阅清理和心跳重连 | 过时任务不能继续启动广播，断线连接得到清理，停止时保留有限交易核对 |

### 3.2 输入、输出和注入接口

```typescript
interface ScreeningRequestEvent {
  id: bigint;
  payer: Address;
  owner: Address;
  assets: bigint;
  expiresAt: bigint;
}
```

配套上下文、结论和注入函数定义如下；Address 沿用仓库地址类型：

```typescript
interface ScreeningContext {
  request: ScreeningRequestEvent;
  receivedAtMs: number;
  deadlineMs: number;
  signal: AbortSignal;
}

interface ScreeningVerdict {
  passed: boolean;
  screenedAt: number; // Unix 秒
  reason?: string;
}

type AddressScreener = (
  payer: Address,
  context: ScreeningContext,
) => Promise<ScreeningVerdict>;
```

`ScreeningRequestEvent.id` 实际为 bigint，金额和 expiresAt 也为 bigint。机器人只把 payer 作为待筛查地址传给 screener；context 内保留 owner 等申请信息用于处理，不代表会筛查 owner。导出的 ScreeningState 对应 NONE/PENDING/EXECUTED/REJECTED/CANCELLED。

机器人要求有效布尔结论和正的安全整数 screenedAt，拒绝未来时间戳。reason 用于进度日志，不参与合约判断。

### 3.3 对外方法

| 方法 | 行为 |
| --- | --- |
| `new KytScreeningBot(options)` | 校验配置、构造 Gateway 最小 ABI 接口；signer 必须带 Provider 并支持本地签名 |
| `start(): Promise<void>` | 读取账户、网络及 pending nonce，核对 WSS 网络并订阅；成功前不接单；初始失败向上抛出 |
| `processRequest(event): Promise<void>` | 接收单笔事件并执行至本地任务结束；未启动、未就绪或暂停时不接收；不去重、不自动预读申请 |
| `stop(): Promise<void>` | 立即关闭接单和重连，放弃未广播任务，有限跟踪已发交易后清理结束 |
| `oracle()` | 人工读取配置的 oracle，不是自动筛查步骤 |
| `getRequest(id)` | 人工读取申请和链上状态；不由事件自动处理流程调用 |

`processRequest()` 完成不等于一定申购成功，需看对应 executed、screening-rejected、失败或超时日志。人工查询方法存在不意味着重新引入自动预读。

### 3.4 内部处理过程

启动读取 pending nonce 后，只有 WSS 订阅确认才设置为可接单。订阅过滤指定 Gateway 和 ScreeningRequested 主题，再校验事件地址、类型和订阅标识。

每个事件建立独立任务和取消控制器：接收时刻为起点，默认 submission deadline=50 秒、confirmation target=60 秒。任务依次进入 queued、screening、ready、preparing、submitted 阶段。活动集合不按申请 ID 索引去重。

`pumpScreening` 最多启动配置数量的筛查任务。有效结果进入 ready 队列；`pumpSending` 每次从队列取一笔，完成 gas/费用准备、签名，先本地计算交易哈希，再递增 nonce 并进入已提交跟踪。

发送入口在前一笔广播调用返回后继续下一笔，不等待链上回执。签名或准备失败发生在提交前时，不递增发送 nonce，任务回到 ready 队列，按 1、2、4、8 秒退避后重新准备（记 `submit-retry`），下一次已赶不上提交期限或属于签名策略拒绝（交易字段不符、超出费用上限）时才记一次 `submit-error` 结束；一旦开始广播，错误即按结果不明确处理，不复用该 nonce 自动再发。

`pollReceipts` 查询待确认哈希，一轮最多 4 个并发读取；确认数大于 1 时还读取区块高度。成功且达到确认数后记录执行或拒绝，回滚记录 execution-reverted，均释放跟踪名额。查询错误只继续核对，不生成第二笔 fulfill。

### 3.5 重连与停止

每个新 WSS 先 eth_chainId 后 eth_subscribe。运行中的断线、错误和心跳无应答触发旧连接清理，默认 5 秒后重连；已建立连接的心跳默认间隔 15 秒，等待上限由 rpcTimeoutMs 控制。

重连成功后只收新事件。断线前收到的任务可继续通过 HTTP 完成。初次启动的暂时读侧/连接故障按上节退避重试，实际配置或未知错误仍退出。

暂停会结束未广播任务，已提交交易继续有限跟踪。入口监听 submission-uncertain 后调用停止并最终以 1 退出。SIGINT/SIGTERM 正常停止则一般退出 0；停机期间如遇不明确结果，退出码可升级为 1。退出码 0 不代表每一笔客户申请成功。

### 3.6 仍然存在的限制

断线和停机期间的历史事件不补扫，重启前内存任务不恢复。内存队列没有业务级反垃圾准入或硬容量保证；本地提交期限也不能撤回已经广播的交易。

## 4. runKytScreening.ts 的完整说明

### 4.1 组件和职责

| 组件 | 当前实现 |
| --- | --- |
| `readConfig` | 启动时读取环境变量/CLI，验证地址、网络、风险等级、数值及运行模式 |
| `RequestLimiter` | 可取消的 FIFO 平滑放行队列，支持全队列冷却和关闭 |
| `chainalysisScreener` | GET、Token 鉴权、响应核对、截止时间、HTTP 超时、最多一次额外尝试 |
| `RateLimitedRpcProvider` | ethers JsonRpcApiProvider 的 HTTP 传输实现；内部请求也经过同一限速与超时 |
| `resolveScreener` | 选择真实筛查或严格限于本地的 allow/denylist |
| `validateDeployment` | 一次性核对链、三份合约代码、绑定和 oracle；不读取每笔申请 |
| `runService` | 创建组件、启动机器人、响应停止和不明确交易、清理资源、返回退出码 |
| `jsonLog` / `main` | BigInt 友好的 JSON 日志、Node 检查、CLI 帮助和 SIGINT/SIGTERM |

没有新增生产依赖；运行使用已有 ethers/tsx 和 Node 原生 fetch/WebSocket。测试中的 ws 属于本地测试环境依赖，不能把测试连接等同于实际供应商接入。

### 4.2 API 请求与结果判断

调用 `GET https://api.chainalysis.com/api/risk/v2/entities/{payer}`，请求头为 Token 和 Accept: application/json；禁止自动重定向，避免凭证被转发到其他目标。可配置 API URL 但代码限制为这一官方 origin 和路径。

返回 JSON 必须为对象，address 必须与付款地址一致，status 必须严格为 COMPLETE。risk 规范化后仅接受 low/medium/high/severe；未知等级直接失败。blocked 集合决定有效等级是否生成 passed=false。

`screenedAt` 在有效响应校验完成后取服务器 Unix 秒数，reason 标明结果取回时间。机器人准备交易时再取 RPC 最新区块，提交 `min(screenedAt, 该区块 timestamp)`：合约要求 `screenedAt <= block.timestamp`，估算在节点最新区块上执行，BNB 亚秒出块而时间戳取整秒，最新区块常比服务器时钟慢一秒，直接用服务器秒数会让估算以 `InvalidScreeningTime` 回滚。合约没有下限，链上记录因此最多早于取回时间约一个出块间隔。API 未完成或故障不是“客户高风险”，因此不提交虚构拒绝结论；更不能默认通过。

配置里的 KYT_BLOCK_RISK 只决定如何处理供应商返回的最终 risk，不会修改 Chainalysis 账户的风险规则或类别定义。供应商规则通过其管理功能设置，参见 [Risk settings](https://support.chainalysis.com/hc/en-us/articles/8610498710932-Risk-settings)。

### 4.3 重试、取消与限速

每次筛查最多两次 HTTP 尝试：首请求加一次有限重试。网络 TypeError、单次 HTTP 超时、429、500/502/503/504 可触发第二次；400/401/403/404、无效 JSON、地址/状态/等级校验错误不重试。

非 429 的可重试故障默认等 500ms；429 使用 Retry-After 秒数或 HTTP 日期，缺少有效值时默认等 1 秒，并使其他 API 排队任务一起冷却。剩余窗口不足时立即结束，不为等第二次请求延长任务期限。

API 每次尝试都取得同一个进程级 limiter 的名额。默认 30 RPS 的间隔取 ceil(1000/30)=34ms，平滑放行略保守；不会先积攒令牌再突发发送。并发 20 与 RPS=30 是两个不同约束。

API 的额度排队受任务截止和停止信号约束；单次 HTTP 超时从取得额度后开始，默认 5 秒，同时不超过任务剩余时间。成功或失败都会清理计时器；未读取的错误正文不打印，并取消正文流。

### 4.4 HTTP RPC 的行为

所有通过该 Provider 产生的 HTTP 请求共用 KYT_RPC_RPS，包括网络查询、getCode、eth_call、估算、费用读取、广播和回执。禁用 JSON-RPC 批处理及 HTTP 层自动重试/重定向。

单次 RPC 的额度排队与网络操作共享 KYT_RPC_TIMEOUT_MS，超时前尚未发送的传输请求移除；如果请求已经发出，取消本地 fetch 不能证明节点未接受交易。广播仍按不明确结果处理。

429 会让本进程后续 HTTP RPC 统一冷却；当前操作报错，不由这一层重复发送原请求。回执的下一轮查询是对同一哈希的状态核对，不是重发结果交易。

该限速不协调其他进程，也不覆盖原生 WSS；部署侧必须分配共享额度。独立端点并不自动带来独立账户配额。

### 4.5 启动检查与退出修复

依次检查：HTTP 网络等于 KYT_CHAIN_ID；Gateway/Vault/asset 地址有代码；gateway.oracle 等于 Wallet 地址；gateway.vault、gateway.asset、vault.usdt 与配置一致；vault.gate 等于本 Gateway。机器人再核对 HTTP/WSS 一致并取得 pending nonce。

这些检查不是合约字节码审计，不会证明某地址部署的代码经过审计，也不会自动检查客户授权、oracle gas 余额、Chainalysis Key 是否有效或一笔真实申购一定成功。API Key 在配置阶段只检查非空，真实可用性必须联调。

复查修复了启动阶段停止问题：机器人尚未创建时，收到停止信号立即 destroy Provider，取消在途和排队读取；机器人已存在时保留有限回执跟踪，最后统一清理。代码不在收到信号时立即 process.exit。

日志只保留标准化错误码、任务阶段和公开链上定位信息，不输出原始错误正文、私钥和鉴权端点。单进程日志不等于已经部署告警系统。

## 5. 完整配置

### 5.1 必填项

| 变量 | 含义与要求 |
| --- | --- |
| RPC_URL | 目标链 HTTPS RPC；生产禁止 http |
| WSS_URL | 同链 WSS；生产禁止 ws |
| KYT_CHAIN_ID | 生产 56、97 或 143；隔离本地模式 31337 |
| KYT_GATEWAY | 非零合法地址，绑定本次服务的 Gateway |
| KYT_VAULT | 非零合法地址，与 Gateway.vault 一致 |
| KYT_ASSET | 非零合法地址，与 Gateway.asset 和 Vault.usdt 一致 |
| KYT_ORACLE_PK | 实际签名账户私钥，须能构造 Wallet；不得公开或写进命令参数 |
| CHAINALYSIS_API_KEY | 使用 chainalysis 时必填；不在启动时自动验证供应商权限 |
| KYT_RPC_RPS | 正整数，按本进程可用的共享 HTTP RPC 份额配置 |

### 5.2 可选项与默认值

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| KYT_ENV | production | 仅 production/local |
| KYT_SCREENER | chainalysis | production 只能使用 chainalysis |
| CHAINALYSIS_API_URL | 官方 risk/v2/entities URL | 只允许官方 origin 和规定路径，无查询串 |
| KYT_BLOCK_RISK | Severe,High | 忽略大小写/首尾空格，去重；空值、空项和未知等级报错 |
| KYT_DENYLIST | 无 | 仅本地 denylist 模式必填，逗号分隔合法非零地址 |
| KYT_API_RPS | 30 | 正整数，最大 40；包括初次与重试 |
| KYT_API_TIMEOUT_MS | 5000 | 单次 API HTTP 超时 |
| KYT_SCREENING_CONCURRENCY | 20 | 同时处于筛查处理中的任务上限 |
| KYT_MAX_PENDING_TX | 16 | 已开始广播、尚在跟踪中的交易上限 |
| KYT_PROCESSING_WINDOW_MS | 60000 | 收到事件到确认目标的窗口 |
| KYT_CONFIRMATION_RESERVE_MS | 10000 | 提交截止前预留时间，必须小于总窗口 |
| KYT_CONFIRMATIONS | 1 | fulfill 结果交易确认数，不是申请事件确认数 |
| KYT_RECONNECT_DELAY_MS | 5000 | 发现 WSS 故障后的重连等待 |
| KYT_HEARTBEAT_INTERVAL_MS | 15000 | 有效回复到下次心跳的间隔 |
| KYT_RPC_TIMEOUT_MS | 10000 | HTTP RPC 排队/请求及机器人相关等待限额 |
| KYT_RECEIPT_POLL_MS | 1000 | 回执查询轮次间隔 |
| KYT_RECEIPT_TIMEOUT_MS | 60000 | 开始广播后的有限跟踪期 |

入口数值配置统一要求正安全整数且不超过 2147483647。配置仅启动读取，不热更新。URL 禁止内嵌 username/password 和 fragment；端点路径或 query 可能仍含密钥，不能打印或放到共享命令行记录中。

CLI 覆盖对应环境变量，支持 `--rpc`、`--wss`、`--chain-id`、`--gateway`、`--vault`、`--asset`、`--screener`、`--confirmations`。不认识、重复或缺值的参数报错。`--help` 不连接网络。生产建议统一用受控环境，避免 CLI 与环境配置混杂。

### 5.3 初始配置模板

以下仅为占位模板。真实地址、凭证和实际 RPC 预算由部署人员填入受控环境，不能提交仓库。

```dotenv
KYT_ENV=production
KYT_SCREENER=chainalysis
RPC_URL=https://YOUR-HTTP-ENDPOINT.example
WSS_URL=wss://YOUR-WSS-ENDPOINT.example
KYT_CHAIN_ID=56
KYT_GATEWAY=REPLACE_WITH_GATEWAY_ADDRESS
KYT_VAULT=REPLACE_WITH_VAULT_ADDRESS
KYT_ASSET=REPLACE_WITH_TOKEN_ADDRESS
KYT_ORACLE_PK=REPLACE_WITH_ORACLE_PRIVATE_KEY
CHAINALYSIS_API_KEY=REPLACE_WITH_API_KEY

KYT_BLOCK_RISK=Severe,High
KYT_API_RPS=30
KYT_API_TIMEOUT_MS=5000
# 80 只是示例，不是已核定的可用份额。
KYT_RPC_RPS=80
KYT_SCREENING_CONCURRENCY=20
KYT_MAX_PENDING_TX=16
KYT_PROCESSING_WINDOW_MS=60000
KYT_CONFIRMATION_RESERVE_MS=10000
KYT_CONFIRMATIONS=1
KYT_RECONNECT_DELAY_MS=5000
KYT_HEARTBEAT_INTERVAL_MS=15000
KYT_RPC_TIMEOUT_MS=10000
KYT_RECEIPT_POLL_MS=1000
KYT_RECEIPT_TIMEOUT_MS=60000
```

现有 QuickNode 全账户 125 RPS、9 个端点为用户提供的套餐信息，本文没有重新审计账户当前配额。举例配置 80 必须以其余服务峰值和 WSS 余量允许为前提，不能按 125−80 就保证其他业务永远够用。更换端点不消除共享限制。

### 5.4 后续调整 KYT_BLOCK_RISK

```dotenv
# 默认阻断两级
KYT_BLOCK_RISK=Severe,High
# 也阻断 Medium，只有有效 Low 通过
KYT_BLOCK_RISK=Severe,High,Medium
```

上面是两个备选值，实际配置只保留一行。无需改代码中的四级有效值校验。修改时正常停止旧进程，核对未决交易，更新受控配置再启动。已发出的交易不会因风险配置改变被撤销，停机期间的申请也不会补扫。

## 6. AWS 最小部署架构和准备

### 6.1 服务器、网络和运行身份

使用现有 AWS Linux 云服务器。以下命令以具备 systemd 的 Ubuntu/Debian 系统为示例；Amazon Linux 的包管理和用户管理命令按实际发行版调整。先确认已安装并可供服务使用的 Node.js 24.x，不需要为了本次方案先新增服务器或数据库。

进程主动出站连接 QuickNode HTTPS/WSS 和 Chainalysis HTTPS，无新增业务监听端口。保留现有受控运维通道，不为脚本单独开放公网应用端口。DNS、TLS 和时钟同步正常是前提。

EC2 可沿用 Amazon Time Sync Service；核对服务器同步状态，不需要为本方案加入硬件时间戳功能。[AWS 时间同步说明](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/set-time.html)

一个 Linux 专用用户 kyt、一个服务实例、一个独占 oracle。目录约定：

```text
/opt/hypertessera/kyt/releases/<release-id>/   匹配版本的完整仓库/发布包
/opt/hypertessera/kyt/current                指向已批准 release 的软链接
/etc/hypertessera/kyt.env                    可选受控环境文件，不在代码目录
/etc/systemd/system/hypertessera-kyt.service 服务定义
```

运行用户只需读取代码，不应能改动发布目录。依赖在发布准备阶段由部署账户安装；不要由常驻签名进程运行 npm install。

### 6.2 密钥注入方式

入口读取 process.env。优先沿用已有受控注入机制；如果现有部署已经支持 AWS Secrets Manager，就由该机制在启动前注入，不能假定脚本会自己调用 Secrets Manager。本文不新增 AWS SDK 或秘密获取脚本。

下方 systemd 模板给出一种最小可用方式：由运维提供 root 所有、权限 0600 的 EnvironmentFile，systemd 读取后将变量交给服务。不要在 unit 的 Environment= 中明文列出私钥，也不要把真实凭证放到 ExecStart 或仓库。若组织要求凭证不落盘，应接入已有运行时注入流程，并移除该 EnvironmentFile 行；单有该要求不会自动实现秘密注入。

文档示例不提供密钥内容，不要求把密钥发送给他人。含密钥的文件不应被加入发布压缩包或校验清单。

### 6.3 准备并验证发布包

发布包应包含匹配的机器人、入口、测试、配置示例及锁文件。从 PR45 工作分支选定一个经验证的固定提交作为 release，记录提交号，不直接运行不断变化的分支工作目录。

在已经准备好的 release 目录执行，以下 release-id 是示例：

```bash
cd /opt/hypertessera/kyt/releases/20260921-reviewed/offchain
node --version
command -v node
node -e 'if (Number(process.versions.node.split(".")[0]) < 24 || typeof WebSocket !== "function") process.exit(1)'
npm ci --include=dev
npm run typecheck
npm run build
npx vitest run test/kytScreeningBot.unit.test.ts test/kytScreeningBot.transport.test.ts test/runKytScreening.unit.test.ts test/runKytScreening.transport.test.ts --maxWorkers 1 --minWorkers 1
node --import tsx scripts/runKytScreening.ts --help
sha256sum src/kytScreeningBot.ts scripts/runKytScreening.ts
```

直接运行 TypeScript 入口依赖 tsx，因此本方案保留安装 devDependencies；不要用 `npm ci --omit=dev` 后再照此启动。build 产物不一定包含 scripts 目录，本服务模板运行的是源入口，不能未经确认改成 dist/scripts/runKytScreening.js。

当前仓库锁文件已包含 ws 8.21.0 及 @types/ws 8.18.1，按原锁文件安装后测试可用，本次不新增生产依赖。未来若调整依赖导致这些测试依赖缺失，应在开发分支补齐并提交锁文件；不要在生产机器临时安装未知版本。

## 7. systemd 安装模板与启动顺序

### 7.1 创建运行身份和安装服务

如果专用用户不存在，在 Ubuntu/Debian 上创建一次：

```bash
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin kyt
```

将受控配置放到选定位置后，确认其归属和权限；以下不会打印文件内容：

```bash
sudo chown root:root /etc/hypertessera/kyt.env
sudo chmod 600 /etc/hypertessera/kyt.env
```

创建 `/etc/systemd/system/hypertessera-kyt.service`：

```ini
[Unit]
Description=HyperTessera KYT screening worker
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=kyt
Group=kyt
WorkingDirectory=/opt/hypertessera/kyt/current/offchain
Environment=NODE_ENV=production
EnvironmentFile=/etc/hypertessera/kyt.env
ExecStart=/usr/bin/node --import tsx scripts/runKytScreening.ts
Restart=no
KillSignal=SIGTERM
TimeoutStopSec=90
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hypertessera-kyt
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
```

`/usr/bin/node` 必须替换为本机实际、可由 kyt 访问的 Node.js 24+ 绝对路径。不要依赖登录 shell 的 nvm 初始化；ProtectHome=true 下也不能从个人 home 目录加载 Node。服务仅需要读代码和出站连接，临时缓存可以在私有 tmp 中生成。

EnvironmentFile 不是 shell 脚本，不写 export、命令替换或环境变量引用表达式。systemd 的环境读取及文件系统保护语义见 [官方执行环境说明](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)。

本模板故意不设自动开机启动的 Install 目标；不要额外执行 enable，也不要由 PM2、容器策略或 AWS 自动化绕过异常停机重新启动。已有 unit 若曾 enable，应在迁移时取消该开机链接。Restart=no 只控制退出后重启，并不单独防止开机启动；停止超时后系统仍可能强制结束进程，不能撤回链上交易。[systemd 服务说明](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)

### 7.2 接线完成后启动

首先准备相互匹配且已通过类型、构建和脚本测试的版本。合约部署、oracle/gas 准备以及 `vault.setGate(gateway)` 完成后，才启动当前入口。入口会拒绝 gate 未接线的配置。

Vault 的治理 Owner 设置 gate，申购权益归属地址设置 operator，是两种不同权限。CONFIGURING 后的 gate 修改走该 Vault 自己的 timelock；等待治理延迟必须纳入部署安排。本脚本不会代替执行这些治理交易。

启动前完成 current 链接及读权限核对，在旧进程已完全停止的前提下：

```bash
sudo ln -sfnT /opt/hypertessera/kyt/releases/20260921-reviewed /opt/hypertessera/kyt/current
sudo systemd-analyze verify /etc/systemd/system/hypertessera-kyt.service
sudo systemctl daemon-reload
sudo systemctl start hypertessera-kyt.service
sudo systemctl status hypertessera-kyt.service --no-pager
sudo journalctl -u hypertessera-kyt.service -n 100 --no-pager
```

current 应是此部署方案管理的软链接，不能用这条命令覆盖不明的实际目录。首次准备和后续切换均先核对路径。

`active (running)` 只表示进程存在；必须同时看 connected 与 ready，并核对 ready 中的链 ID、Gateway/Vault/asset、oracle、blockedRisk 和配额参数。之后还需完成真实受控样本，才能证明 API Key、链上权限和资金路径可用。

这不是 dry-run 模式：真实服务一旦就绪，会对接收到的事件自动签名并提交结果。受控联调必须使用明确的测试部署和账户；不要为“看看能否启动”随意接入正在募集的真实 Gateway。

### 7.3 正常停止

```bash
sudo systemctl stop hypertessera-kyt.service
sudo systemctl status hypertessera-kyt.service --no-pager
sudo journalctl -u hypertessera-kyt.service -n 100 --no-pager
```

等待 service-stopped，确认已提交交易是否都已得到明确回执。默认停止时间 90 秒是依据当前参数的初始设置；增大回执期限或 RPC 等待等配置后必须重新评估。不要用 kill -9 当正常停止方式。

## 8. 日志、监控与故障操作

### 8.1 日志含义

| type | 含义及处理 |
| --- | --- |
| connected | WSS 订阅建立；不表示供应商 Key 已验证 |
| ready | 本轮启动检查和机器人启动完成 |
| received | 申请进入内存处理，包含 id/payer |
| api-complete | 有效地址风险结论，包含 risk/attempt |
| api-retry | 正在进行唯一一次额外 API 尝试 |
| screened | 机器人已接受结论并准备排队发送 |
| submitted | 已算出 txHash/nonce，开始 Provider 广播；不是链上成功证明 |
| executed / screening-rejected | 对应结果交易成功并达到确认数 |
| screening-error / processing-timeout | 本次未取得可提交结论或未提交任务到期 |
| submit-retry | 广播前准备失败（未签名、未占 nonce），按 1、2、4、8 秒退避重新准备；不计入请求错误告警 |
| submit-error / execution-reverted | 广播前准备在期限内始终失败或被签名策略拒绝（每笔只记一次），或结果交易上链回滚 |
| connection-error | WSS 错误、错链、断线或事件解析异常；结合 message 判断 |
| submission-uncertain | 停止新任务、有限核对、异常退出；需要人工查明 |
| startup-error / fatal / stop-error | 启动、配置或清理故障 |
| service-stopped | 服务退出及 exitCode，不是所有申请成功清单 |

`component=kyt-bot` 标识机器人事件；入口另有 API 和生命周期日志。id 在 JSON 中为字符串，nonce 为数字，elapsedMs 表示任务从事件接收起经历的毫秒数。敏感 URL/密钥不应出现在标准日志中。

### 8.2 监控落地

最低限度保留 systemd journal，并由已有 AWS 日志/监控机制观察进程退出、长时间无连接、submission-uncertain、API 429/鉴权失败和任务超时。若使用 CloudWatch，需要运维实际配置日志采集与告警；当前脚本没有内置 CloudWatch Agent、短信或通知机器人。

募集期间确认 journal 保留策略及输出限速不会丢掉 submitted/txHash 日志。当前没有持久化任务库，日志对事故核对很重要；日志缺失时不能假装可以完整恢复旧任务。

不新增 HTTP 健康端口。不要以“没有新申请日志”单独判断故障，募集可能本来就没有新申请；结合进程状态、connection-error 和节点连接指标判断。

### 8.3 常见故障处理

| 故障 | 操作 |
| --- | --- |
| KYT_GATE_MISMATCH | 核对 Vault/gate 配置及治理执行结果；不能删除校验让服务带错配置启动 |
| KYT_ORACLE_MISMATCH | 核对签名账户和 gateway.oracle；不要改成节点 impersonation |
| 错链/无合约代码/绑定不符 | 修正实际地址或端点；确认最终部署，不只检查 ABI |
| API 401/403 | 检查凭证和服务权限，修正后重启；不切换 allow |
| API 429 | 看账号其他调用方和 Retry-After；降低总调用预算，不增加无限重试 |
| 非 COMPLETE/无效等级/地址不符 | 保留错误编号并核对真实响应格式；不放宽成默认通过 |
| WSS 断线 | 进程内部重连；确认重新订阅；离线事件不恢复 |
| RPC 限额或超时 | 检查共享配额、网络及端点；如果涉及广播，按不明确交易处理 |
| 普通准备失败或链上回滚 | 核对余额、授权、窗口、额度、gas 等；不自动重发申请 |

### 8.4 广播不明确或进程崩溃

1. 保持旧服务停止，不启动第二个发送器。
2. 从日志收集该次运行所有尚未有明确结果的 txHash/nonce，不只看最后一笔告警。
3. 通过可信链上查询核对每个哈希的回执及 oracle 的 pending/latest nonce；单次 null 不能证明交易从未发送。
4. 已确认成功、回滚或确定的其他处理结果记录清楚；仍有未决交易时先人工查明，不绕过暂停直接恢复。
5. 确认该账户可安全恢复后人工启动；新进程重新读取 pending nonce，但不会恢复旧任务或旧回执队列。

若日志缺失，也必须核对 oracle 链上活动，不能仅因为应用内没有记录就认定没有交易。客户重新申请不会自动取消旧 PENDING 申请；原交易后来执行时仍可能扣款。

## 9. 更新、回退和多实例约束

### 9.1 正常更新步骤

1. 在新的 release 目录准备代码和锁文件，先完成类型、构建与测试。
2. 安排无申购或受控维护窗口，正常停止旧服务，核对已发交易；没有历史补扫，所以不能保证切换空档的申请被处理。
3. 更新受控配置或切换 current 链接，保证 oracle 仅被一个进程使用。
4. 人工启动，确认 connected/ready 与配置正确，再做受控样本验证。

不要在旧进程仍运行时原地覆盖依赖或切换软链接，也不要用滚动扩容方式让两个实例短时共用 oracle。

### 9.2 回退

只有旧代码与当前已部署 Gateway ABI、配置仍兼容时，才可在停机核对后回退链接。应回退整个经过确认的兼容组合，核对机器人与运行入口的接口、配置和 Node.js 要求。

将 gate 改回 0 是关闭 KYT 的业务/治理动作，会恢复不经筛查的直接申购，不是普通代码回退或 RPC 故障的自动降级。

### 9.3 多 Vault

本版一个服务绑定一个 Gateway，一个 Gateway 绑定一个 Vault。多个实例使用不同 oracle，分别配置服务名和环境文件。API/RPC 同账户仍共享额度，应把每个进程的 RPS 相加分配；本版没有跨进程总限速器，也没有分布式 nonce 管理。

## 10. 验证和容量验收

### 10.1 已完成的本地验证记录

本次在 PR45 分支源码（整合前提交 d75df711c66c36dbf774b308f97001391a930432）中替换完整入口及测试，按原锁文件离线安装依赖后，类型检查、构建及全部 208 项链下非集成测试通过，其中 KYT 两个脚本共 94 项。Windows 本地因配置打包工具的目录访问限制，使用等效测试配置运行；GitHub CI 使用仓库原测试命令。

KYT 测试包括机器人 27 项、运行入口 67 项。使用 Node 24.14.1、ethers 6.17.0、TypeScript 5.9.3、Vitest 2.1.9。

API 测试采用模拟 fetch；传输测试使用真实本机 HTTP/WSS 和 Wallet 签名、模拟 RPC 响应；没有把交易广播到真实 BNB 链。启动阶段停止问题有修复前失败、修复后通过的回归证据。本地结果不代表已完成真实 API 或链上环境测试。

### 10.2 真实环境验收顺序

1. 在发布目录执行 typecheck/build/相关测试；记录实际锁文件版本与 Node.js 版本。
2. 验证真实授权 Chainalysis 接口，确认地址、COMPLETE、四级 risk、鉴权和配额。
3. 使用受控链上账户验证通过后扣款/申购、不通过不扣款、无效 API 不提交、余额/授权不足或金库拒绝时的失败边界。
4. 在测试端点或故障注入环境验证 WSS 断线、429/5xx、HTTP 超时、广播应答丢失、回执延迟、SIGTERM 和重启核对流程；不要为测试 429 故意冲击生产供应商配额。
5. 验证日志留存、告警到达、单实例部署和时钟同步。

BNB 测试网可以验证链上交互，但 Chainalysis 地址风险来自主网活动；测试网转账不等于供应商会产生相应真实风险结论。生产模式不能用 allow/denylist 冒充真实联调结果。

### 10.3 抢购压测

先测 1 秒输入 100 笔随后停止，再测连续 3 秒、5 秒的 100 笔/秒短时突发并回落；这是压测阶梯，不是已经保证的容量。记录每笔申请的接收、筛查、广播、确认时间和最终结果，以及所有超时/拒绝/未决项，不能只统计成功样本。

API 30 RPS 下 100 笔各查一次的放行耗时理论上约 3.4 秒，尚未包含供应商响应、额外尝试、RPC 排队、串行签名/准备和区块确认。实际吞吐还受单个 oracle nonce 和 16 笔待确认上限影响，不能按 30 RPS 推出 30 笔/秒链上申购能力。

容量验收目标是约定突发模型下每笔请求得到明确、正确的结果，符合业务确认窗口，并且未突破共享配额；若达不到，应根据测得瓶颈调整额度、并发、待确认数或业务流量安排，不把本地 60 秒目标写成链上保证。

调低队列等待不一定需要提高 RPS；链上确认或单发送器准备也可能是瓶颈。不要先加多实例共用一个 oracle 来“解决速度”。本版没有单独指标端点或完整队列长度指标，压测侧需要通过事件日志和测试采集补齐测量。

## 11. 上线验收记录模板

以下由实际执行人员填写；空项不代表已通过：

```text
代码发布编号/提交：
Gateway 地址与 ABI 版本：
Vault / asset / chainId：
oracle 地址（只记录地址，不记录私钥）：
整合后的类型检查、构建、脚本测试证据：
AWS 系统、Node 路径和版本：
HTTP/WSS 一致性及 gate 接线证据：
Chainalysis 真实接口联调证据：
API/RPC 账户预算及本实例分配：
通过/拒绝/异常申购交易哈希：
停止、断线、广播不明、崩溃恢复演练结果：
100 笔短时突发的持续时间、成功/失败/超时数及延迟分布：
日志留存和告警接收验证：
最终是否开放募集及负责人：
```

参考：[PR45](https://github.com/alliancechuan/hyperTessera/pull/45)、[Chainalysis GET 风险评估](https://developers.chainalysis.com/address-screening/api-reference/screening/retrieve-an-addresss-risk-assessment)、[API 概览](https://developers.chainalysis.com/address-screening/api-reference/api-overview)、[Node CLI 官方说明](https://github.com/nodejs/node/blob/v24.x/doc/api/cli.md)。
