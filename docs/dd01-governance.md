# DD [01] 权限与时间锁：开发及交接说明

## 1. 本次范围

本次只实现经确认的 DD [01]：新增 `GovernanceController`，复用 OpenZeppelin
`TimelockController`。Cactus 按既有签名钱包使用，不读取其内部审批数据，不开发
Cactus API、DAO、治理代币或自定义暂停/恢复系统。

原 ZIP 中所有原文件保持逐字节不变，包括 Adapter、Vault、Settlement、
HyperAccessControl、NAVOracle 和原 VaultTimelock。

**DD [02] 的共享资金限额、一般收款白名单、收入归属/投资回款账务未在本次实现；
DD [03] 的 NAV 下调第二签名、报价时效及偏差逻辑也未在本次实现。**
Controller 的 Pool 转账路径目前只增加时间锁；不要据此宣称 [02] 或 [03] 已解决，
也不要在完成后续整改、审计和授权前据此切换生产权限。

## 2. 文件及依赖

- `src/addition/GovernanceController.sol`：唯一新增业务合约，带 NatSpec 和关键中文说明。
- `src/addition/TimelockController.sol`：OpenZeppelin 5.1.0 标准时间锁的完整源码副本，
  仅调整依赖导入路径并标注来源；保留 MIT 许可，时间锁规则不变。
- `script/DeployDD01Governance.s.sol`：标准时间锁和 Controller 的部署/模拟脚本；只部署新合约，
  不自动授权 Governor、撤销原角色、移交 Oracle Owner 或更改原协议配置。
- `test/DD01GovernanceSecurity.t.sol`：权限、时间锁及绕过测试。
- `test/DD01GovernanceIntegration.t.sol`：原协议合约的调用兼容性测试。
- `test/DD01GovernanceDeployment.t.sol`：真实部署脚本入口及部署前绑定检查测试。

两个合约统一位于小写 `src/addition/`。部署脚本及以上专项测试均使用该目录中的源码，
原始 OpenZeppelin 库及其余依赖继续保留在 `lib/`，未修改依赖源码。

### 2026-11-10 复核修订

- 部署脚本对 StateManager 使用实际 `accessControl()` 接口；其他模块沿用 `ac()`。
- 配置 RevenuePool 时，在部署前校验其 `usdt()` 与 UnifiedPool 的 `usdt()` 一致，
  避免固定收入路径使用不同结算代币。该检查不改变任何原合约配置。
- Bridge 白名单准入仍验证 Vault 已注册；撤销只禁止零地址，允许清理历史错误条目。
- 补充以上场景的回归测试。

测试依赖锁定为 OpenZeppelin 5.1.0
(`69c8def5f222ff96f2b5beff05dfba996368aa79`)、forge-std
(`620536fa5277db4e3fd46772d5cbc1ea0696fb43`)、Solidity 0.8.24。
沿用原项目优化器和 viaIR 配置，不通过全仓依赖升级改变原合约。

## 3. 权限关系

```text
Cactus Governor 钱包（提案、执行，并保留标准取消权）
    -> TimelockController（初始最低等待 1 天，self-admin）
    -> GovernanceController（原协议唯一 Governor）
    -> 原协议合约

Cactus Guardian 钱包 -> TimelockController.cancel（仅取消未执行提案）
```

- 时间锁和原人员钱包不直接持有 Governor；只有 Controller 持有。
- 时间锁构造参数 `admin=address(0)`，不设置外部 bootstrap 管理员。
- 不配置 `address(0)` 为执行人。初始 proposer/executor 使用同一个现有 Cactus 钱包。
- Guardian 取消权通过标准时间锁自调用 `grantRole(CANCELLER_ROLE, guardian)` 配置。
  初始配置下，这一步也须等待 1 天，应在生产角色移交前完成。
- 相同 Cactus 地址提案和执行不等于链上多签；人员审批仍由现有 Cactus 流程完成。
- 部署脚本将初始最低延迟设为 1 天（86,400 秒）。修改后续最低延迟须按当时的等待期
  排队，通过时间锁自调用 `updateDelay`。角色调整也遵守标准自管理流程。
- 后续不得把外部管理员或开放执行权限写成与本配置等价；若治理决定改变这些设置，
  应重新说明风险和治理边界，不能沿用“当前没有外部管理员”的结论。

## 4. Controller 接口与边界

所有修改状态的 Controller 接口均为 `onlyTimelock`。原目标地址固定，不支持任意
`execute(target,data)`、fallback、delegatecall 或直接任意 grantRole。

### 4.1 原 Governor 管理入口

- Pool：`operatorTransfer`、`operatorTransferToRevenuePool`、准入白名单、
  `upgradeUnifiedPool` 和原有一次性 `reinitializePoolStateManager`。
- StateManager：原有一次性 `setVaultFactory`、原模块暂停配置。
- ProtocolFeeConfig：费用、支付代币及官方收入池配置。
- RevenuePool：USDT/ERC-20/原生币提款、费源管理和原有策略地址保留字段。
- LiquidityBridge：原桥接白名单。
- Vault 协议分费：`setVaultProtocolFeeConfig(vault, uint16 shareBps)` 调用原
  `BaseVault.setProtocolFeeConfig(address revenuePool, uint16 shareBps)`。
  该原函数设置的是分费收款方和比例，不是一个 ProtocolFeeConfig 合约指针。
- ReservePSM：原部署、全局暂停及 Controller 自身创建资产的签名人/资产暂停配置。

保留的模块/PSM 暂停接口仅转发**原合约已有操作**，同样等待时间锁；没有新增快速暂停或
恢复状态。原 Vault Guardian 暂停保持独立，且 Pool 并未统一读取 StateManager 模块暂停。

Controller 不接受任意收入池参数，Pool 收入转账及 Vault 分费使用固定官方 RevenuePool。
但这不等于已实现 DD [02] 的收入归属及可转余额校验。

### 4.2 可选 NAV Owner 管理

Oracle 必须同时在 Controller 的 `managedOracles` 名单中，且 `owner()` 实际为 Controller，
才能调用 signer、偏差参数、所有权等管理入口。登记名单不自动移交所有权。

该层不代理 `updateNAV`、不改变报价签名人、不更新价格、不改变 Adapter 绑定。
独立 Oracle 的实际管理地址应逐实例登记，不将协议公共 Oracle 与产品 Oracle 混淆。

### 4.3 管理身份变化

ReservePSM 原 `deployWrappedToken` 会把 `msg.sender` 记为 Wrapper Controller。因此新创建
资产的 Wrapper Controller 会是本 Controller；已提供对应的受控 signer/pause 路由。
历史资产仍保留原 Wrapper Controller，不因 Governor 移交自动改变。

`migrateGovernor` 仅替换本合约的 Governor 角色，核对新合约 runtime code hash 后先授新、
再撤旧，同一交易完成。它不是 DAO，也不证明新代码安全。

**它不会自动移交 Oracle Owner 或 ReservePSM Wrapper Controller。** 原 PSM 没有转移
`controllerOf` 的入口；如本 Controller 已创建包装资产，即使未来 Governor 迁走，仍须
保持本 Controller 和旧时间锁可操作，以管理那些资产。Oracle Owner 另行按治理流程移交。

### 4.4 未迁移的权限

Vault Owner、Curator、Allocator、Guardian、Keeper、Settlement Operator 和其他资产独立
权限不由本次代码自动接管。因此，不能声称全部产品角色、Settlement 门槛或 Vault 恢复
都已受到新协议时间锁覆盖。Adapter、原 VaultTimelock 及日常投资流程不改。

## 5. 提案、执行和取消

使用标准时间锁的 `schedule`/`scheduleBatch`、`execute`/`executeBatch` 和 `cancel`。
目标、原生币 value、完整 calldata、predecessor 和 salt 都属于操作哈希的一部分。
不允许在执行时替换参数。推荐业务治理 value 为 0。

获授权钱包可以取消 Waiting 或 Ready 操作；已执行操作不能通过 cancel 回滚。取消后重新
提交须重新等待。提案到期不自动执行，须由执行钱包另行发交易。标准实现没有自动过期
模块，本次不增加该功能。

Controller 内不另写取消、Guardian 否决、epoch 或暂停恢复机制。应急处置采用现有
取消权和现有协议处置流程。

## 6. 部署输入（全部是公开配置）

`script/DeployDD01Governance.s.sol` 是在本地由 Foundry 运行的链下部署工具，
不作为协议业务合约部署。它创建标准时间锁和治理控制合约，原协议继续使用现有地址。
运行测试只涉及本地虚拟 EVM；实际部署及权限移交仍分别需要明确授权。

脚本使用以下环境变量；不读取私钥、助记词、API Key 或原项目的密钥文件：

```text
GOVERNANCE_CHAIN_ID
GOVERNANCE_DEPLOYER
GOVERNANCE_WALLET
GOVERNANCE_GUARDIAN_WALLET
GOVERNANCE_ACCESS_CONTROL
GOVERNANCE_STATE_MANAGER
GOVERNANCE_UNIFIED_POOL
GOVERNANCE_REVENUE_POOL          # 可选，未使用模块可省略
GOVERNANCE_FEE_CONFIG            # 可选
GOVERNANCE_RESERVE_PSM           # 可选
GOVERNANCE_LIQUIDITY_BRIDGE      # 可选
GOVERNANCE_NAV_ORACLES           # 可选，逗号分隔的公开地址
```

省略的模块对应 Controller 接口会拒绝调用。已投入使用的模块不能误省略，否则治理移交后
相应管理功能将不可用。部署前脚本会核对各模块的 ACL/StateManager 公开绑定。

Controller 构造检查目标代码和非零初始延迟，但不能单靠该检查证明标准时间锁源码、
1 天配置、正确角色或整个目标系统的一致性；部署脚本及后续链上核验须一起完成。

## 7. 权限切换顺序

1. 逐链锁定旧地址、依赖绑定及完整 Governor 名单，保留当前可用权限。
2. 测试和审计新增合约及其与原协议的集成，完成 DD [02]/[03] 尚需的相关工作后再决定上线。
3. 部署新时间锁/Controller，验证成功回执、实际代码和所有构造配置。
4. 排队并执行 Guardian 取消权，核验 proposer/executor/canceller/self-admin。
5. 原 Governor 授权新 Controller；验证延迟治理调用。不能把 grant 当作已完全移交。
6. 从部署块起完整重放 `RoleGranted/RoleRevoked`（含构造授权），按区块/日志顺序还原名单，
   再对每个地址检查 `hasRole`。原 ACL 没有 `getRoleMemberCount`。
7. 撤销/放弃所有旧 Governor；核验 Controller 是唯一持有人。
8. 如明确纳入 Oracle Owner，逐地址另外移交并核验。
9. 更新调用方和运营说明，留存部署、角色变化及实际时间锁配置的证明。

不得先撤旧再授新。普通 EOA 的多笔授权/撤销不自动具有原子性；不借普通 multicall
假定 `msg.sender` 不变。脚本不自动执行上述权限切换。

模拟地址、编译成功、测试通过都不等于已部署、已审计或已完成主网移交。

## 8. 编译及验证

```sh
forge build --use /path/to/solc-0.8.24 --offline
forge test --use /path/to/solc-0.8.24 --offline --match-path 'test/DD01Governance*.t.sol' -vv
forge test --use /path/to/solc-0.8.24 --offline
```

交付时附源码基准哈希、原文件保持不变的检查、固定依赖版本、本地测试结果及新增合约 ABI。
本次没有主网交易、钱包签名或第三方审计结果；后续必须另行取得实际部署和审计证明。
