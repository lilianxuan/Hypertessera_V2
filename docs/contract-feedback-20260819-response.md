# 合约问题反馈（20260819）处理结果

- **反馈来源**：`合约问题反馈20260819.pdf`
- **处理日期**：2026-08-20
- **代码分支**：`feat/contract-feedback-20260819`
- **部署世代**：BNB 测试网 v6（chainId 97）
- **相关文档**：[`deployment-bsctestnet-2026-08-20-v6.md`](./deployment-bsctestnet-2026-08-20-v6.md)、[`function-reference.md`](./function-reference.md)

---

您好，

20260819 提出的四项问题已全部修复，并已部署到 BNB 测试网（chainId 97）。以下是逐项说明与需要贵方配合的事项。

---

## 一、四项反馈的处理

### 1. Registry 绑定后无法更换

新增 `BaseVault.setAdapterRegistry(address)`。调用时校验地址非零且为合约，逐个检查现有 Adapter 是否仍被新 Registry 允许——只要有一个不被允许即回滚，避免更换后继续使用未授权 Adapter；记录新旧地址并触发 `AdapterRegistryUpdated` 事件。

权限方面我们采用 **Vault Owner 或 Governor 直接调用**，不经过 VaultTimelock。理由是：Registry 地址配错会直接使 `addAdapter` 失效，而此时若还要求走 timelock，恰恰是治理链路本身出问题时无法自救。如贵方倾向于纳入 timelock 管控，我们可以调整。

### 2. RWAToken 白名单准入

新增独立的白名单存储（刻意不复用现有 listId，使"准入"与"路径方向"成为两个互不影响的控制层）。`transfer` / `transferFrom` 现在先强制校验收发双方均在白名单内，任一方不在即回滚 `NotWhitelisted(account)`；通过后再校验已配置的转账路径。Issuer 通过 `addToWhitelist` / `removeFromWhitelist` 批量管理。

`mint` / `burn` 不受影响——发行不是转账，且 Issuer 需要保留对已撤销地址执行销毁的能力。

> ⚠️ **这一项对既有部署是破坏性变更**，详见[第三节](#三-联调前必须先做的一步)。

### 3. 到期未结算请求的资金锁定

新增 `cancelExpiredRequests(uint256[])`，仅 Keeper、仅 SETTLING 阶段可调用。退还 PENDING 申购的 USDT 与 QUEUED 赎回的份额给**原 request owner**，同步更新负债、队列与认购额度，并按请求触发：

```
ExpiredRequestCancelled(requestId, owner, queueType, returnedAmount, timestamp)
```

已结算的请求不会被触碰，重复执行会回滚而非重复支付。

### 4. SETTLING 阶段的请求截止

`requireOperable` 此前允许 SETTLING 通过，导致到期后仍可提交赎回，而这些请求已无结算路径。现已收紧为 OPERATING + ACCEPTING（其接口注释原本写的就是这个，实现与自身契约已偏离）。`enterFinalSettlement` 另要求 cycle 已回到 ACCEPTING，确保此前的结算批次已完成。

已结算请求的边界按贵方要求保留，并各有测试覆盖：

- 已 SETTLED 的赎回继续走 `claimRedeem`，且不会被清理函数重复支付；
- 已 SETTLED 的申购份额虽由 Vault 托管，仍归属原 owner。

> **需请贵方确认——部分成交的赎回。**
>
> 这是反馈未点名、但代码强制要求处理的情形：它状态仍是 QUEUED，却已累计了一部分 `settledAssets`。若按"取消"处理标记为 CANCELLED，这笔已成交的钱将永久无法领取（`claimRedeem` 只接受 SETTLED）。
>
> 我们的处理是：**只退还未成交的份额，并将该请求提升为 SETTLED**，使已成交部分仍可正常领取。

---

## 二、合约体积与架构调整

上述改动使 `EarnVaultDeployer` 超出 EIP-170 的 24,576 字节上限而无法部署。根本原因是该 Deployer 的运行时字节码就是 Vault 的创建码，改动前余量仅剩 **229 字节**——这一模式已到结构性上限，任何新增功能都会触顶。

我们做了两项调整：

1. **Vault 改为 EIP-1167 minimal proxy（克隆）**。VaultFactory 克隆共用实作，两个 Deployer 删除，Vault 体积与 Factory 体积就此解耦。
2. **`writeDownInsolvency` 抽出为外部库 `VaultInsolvency`**（delegatecall，读写 Vault 自身存储，行为不变）——这是几乎不会执行的治理路径，却在每个 Vault 中占用约 1.8KB。

> ⚠️ **对贵方最直接的影响：三个 Vault 地址现在是代理合约，链上代码各只有 45 字节。**
>
> 前端、SDK、索引器请一律使用 **Vault 地址**，不要使用实作地址；实作合约不持有任何 Vault 状态。
>
> 这**不是**可升级代理——实作地址是 `immutable`，代理本身也没有任何切换实作的路径。

调整后各合约体积（未启用 via_ir，优化器参数保持 runs = 200）：

| 合约 | 运行时字节 | 距上限余量 |
|---|---:|---:|
| EarnVault 实作 | 24,127 | 449 |
| LiquidityEarnVault 实作 | 23,189 | 1,387 |
| VaultFactory | 11,743 | 12,833 |
| StateManager | 14,701 | 9,875 |
| VaultInsolvency | 1,780 | 22,796 |

---

## 三、⚠️ 联调前必须先做的一步

**新部署的 RWAToken 白名单是空的。**

由于第 2 项修复要求转账双方都在白名单内，且空白名单禁止一切转账，**在 Issuer 调用 `addToWhitelist` 放行地址之前，SToken / JToken 完全不可转让**，任何转账都会回滚 `NotWhitelisted(account)`。

这与旧行为相反（旧逻辑在未配置路径时放行全部转账），是本次修复的预期结果，但请务必在联调前先配置白名单。管理后台已加入对应入口（**资产工作台 → 管理转账白名单**）。

同理，**既有部署若要升级到本版本，需要为所有现有持币地址重新配置白名单**，否则会立即冻结。

---

## 四、新测试网地址（v6，chainId 97）

> **v5 及更早世代的 chainId 97 地址全部作废。**

| 合约 | 地址 |
|---|---|
| CashVault（代理） | `0x35A8B5597cd579CBeb5D4f91C2A19370aEf99edb` |
| NoteVault（代理） | `0xcB5d65b3EAcAb7471341bBe2d1dA59D2b3980012` |
| LPVault（代理） | `0x63531f840FF2CB8952A64A8206E895051ECa9a04` |
| StateManager | `0xD94c9C80F07437F0F60f8371b5bF77D53096a314` |
| VaultFactory | `0x7Eb0d3121D40923f0eB8eA4c57e2f17D81f122C2` |
| Settlement | `0x2eF6baAdF4583557b5a77f2E3C804858C6Ff62A5` |
| Queue | `0xdc7E9CEa519230029DA1988770C72cE03fa4ed6A` |
| NAVOracle | `0x35C9a6B293cb81ff2cBCb30C7afA689Fa1725acC` |
| UnifiedPool | `0xe1d9958e32Ab6da31205f3fd06f22cE83290751b` |
| MockUSDT | `0x6F86108A0172ae573D6ebB30D75D6Cb42609fDAa` |

完整地址表（含实作合约、Timelock、Adapter、AssetRegistry 等）见部署文档 [`deployment-bsctestnet-2026-08-20-v6.md`](./deployment-bsctestnet-2026-08-20-v6.md)。

---

## 五、测试与验证

- **合约测试 990 项通过**（原 955 项，新增 33 项覆盖贵方要求的状态冻结、Keeper 权限、批量取消、负债变化、重复执行与防止重复付款）
- **链下测试 121 项通过**

部署后已在链上复核：

- 所有合约均在 EIP-170 限制内；
- 三个 Vault 确为 EIP-1167 代理并指向正确实作；
- `VaultInsolvency` 已正确链接进实作的运行时代码；
- Vault 的 `name` / `owner` / `stateManager` 等状态确认已通过代理写入。

> **需如实说明一项：第 4 项修复（SETTLING 冻结赎回）尚未在链上实测**，因为需要先将某个 Vault 推进到 SETTLING 状态。该行为有单元测试覆盖，但本次部署未做端到端验证。如贵方需要，我们可以安排一次完整的生命周期演练。

---

## 六、待确认事项

1. 第 1 项的权限设计（直接调用 vs 纳入 timelock）是否符合预期
2. 第 4 项中部分成交赎回的处理方式是否认可
3. 是否需要我们先行配置测试网白名单与测试钱包资金，还是由贵方操作
4. 是否需要安排 SETTLING 全流程的链上演练

另有一处我们注意到但未改动、供贵方判断：

> `EarnVault.deposit`（仅 LiquidityBridge 可调的同步入金通道）目前只校验暂停状态、不校验产品状态。它属于协议内部通道而非用户申购入口，因此未纳入本次"到期关闭申购"的范围；但若 LP 与 Cash 两个 Vault 的到期时间不一致，理论上仍可能在 SETTLING 期间铸造份额。是否需要一并收紧，请贵方指示。

---

顺颂商祺
