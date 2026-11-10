# 合约修改建议

## 1. 删除 AdapterRegistry，并根据合约体积决定是否保留 EIP-1167 Clone

## 修改理由：

Adapter 由 Curator 根据金库业务需要直接选择、部署和配置，再经过 AdapterRegistry 登记会增加部署及操作复杂度，并扩大 Vault 相关合约体积。AdapterRegistry 本身也 不能证明 Adapter 来自指定的官方 AdapterFactory，因此不需要继续保留这层登记机 制。

## 修改方向：

删除 adapterRegistry 相关参数、存储、治理绑定、更新函数、事件和准入检查，并同 步修改相关接口、部署脚本、SDK 及测试。Adapter 的添加和移除直接由 Curator 操 作，不增加 AdapterFactory 来源、adapter.vault() 或 adapter.asset() 等额外验证。

## 出现异常时，由 Vault Guardian 停止金库，停止后可以阻止 adpater 的运行即可

删除 AdapterRegistry 后，重新恢复并编译原有直接部署方案。如果 EarnVaultDeployer 等相关合约符合 EIP-170 及创建码限制，则取消仅为解决合约体积问题引入的 EIP- 1167 Clone，恢复原有直接部署方式；如果仍然超限，再继续保留 Clone 方案。

## 2. 将到期未结算请求改为可分批执行的链上清理

## 修改理由：

到期未结算请求的资金返还属于确定性操作，退款对象和退款金额均由链上请求记录 决定，因此合约层无需限制调用角色。请求数量没有严格上限，不能在一笔交易中自 动清理全部请求，需要采用可重复执行的分批清理方式。

## 修改方向：

将现有 cancelExpiredRequests(uint256[]) 改为任何地址均可分批调用的 sweepExpiredRequests(uint256 maxCount)，并允许在 SETTLING 及其后的 MATURING、CLAIMING、CLOSED 阶段执行。

合约端为 Curator 增加一个到期请求清理操作接口，由 Curator 设置单批最大处理数量 并实际调用 sweepExpiredRequests(uint256 maxCount)。如果一批未完成，Curator 可 以继续重复调用，直至全部到期请求处理完毕；同时保留该函数的无权限调用属性， 使其他地址也可以代为执行清理。

## 3. 部分成交的赎回

同意修改方案，在 settling 阶段，只退还未成交的份额，并将该请求提升为 SETTLED，使已成交部分仍可正常领取

## 4. 将白名单和转账路径设置为两个独立开关

## 修改理由：

需要同时保留旧版本默认开放转账的行为，并允许受监管 RWA 资产选择严格模式。白 名单准入和转账路径属于两个独立的控制维度，不应根据名单或路径是否为空推断是 否启用，而应通过显式开关分别控制。

## 修改方向：

新增 whitelistEnabled 和 transferPathEnabled 两个独立开关，默认均为关闭，并按照 以下规则执行：

- 白名单关闭、路径关闭：全部转账放行；
- 白名单开启、路径关闭：只检查收发双方白名单；
- 白名单关闭、路径开启：只检查转账路径；
- 白名单开启、路径开启：白名单和转账路径必须同时通过。
两个开关由 Issuer 管理，并在开关状态发生变化时触发相应事件。mint 和 burn 继续 不受普通转账检查影响。

路径模式开启但尚未配置有效路径时，应禁止转账，避免开启严格模式后因没有路径 规则而意外放行。由于当前 RWAToken 不是可升级合约，测试网需要重新部署包含上 述开关的新版 Token；如已有余额和业务配置，还需同步完成余额迁移，以及前端、 SDK 和部署地址的更新。

## 5. 将产品核心信息同步写入 AssetRegistry

## 修改理由：

目前产品的重要业务信息主要依赖链下文档或元数据保存，需要在资产注册时将产品 核心信息同步写入链上。

## 修改方向：

扩展 AssetRegistry.registerAsset()，在注册资产时同步记录以下产品信息：

- 产品名称；

- 收益率；
- 到期日；
- 发行人；
- 投资标的，即底层资产。
收益率应采用明确的整数精度，例如使用基点 annualYieldRateBps 表示，500 代表年 化收益率 5%；到期日使用 Unix 时间戳保存；发行人地址原则上直接记录资产注册交 易的 msg.sender，避免调用者登记任意地址冒充发行人；投资标的可以使用链上字符 串保存底层资产名称或说明。

可以在 AssetRegistry 中新增 ProductInfo 数据结构，并按照 assetId 保存，例如包含 productName、annualYieldRateBps、maturityTimestamp、issuer 和 underlyingAsset。同时新增 getProductInfo(uint256 assetId) 查询接口，使前端、SDK 和其他合约能够一次性读取完整产品信息，也可以根据实际需要增加单项查询接口。

注册成功时应触发包含 assetId、发行人和主要产品信息的事件。上述产品核心条款原 则上应在注册后保持不变；如果业务上确实允许修改，应增加仅限 Issuer 调用的更新 接口，并记录修改前后的内容及对应事件。

前端和 SDK 需要同步增加产品信息填写、参数校验和链上查询功能。由于当前 AssetRegistry 不是可升级合约，加入新的 registerAsset() 参数和查询接口后，需要重 新部署新版 AssetRegistry，并同步更新部署地址、ABI 及相关调用流程。
