# KYT SDK 与控制面板接入

本文对应合约仓库内的 SDK、ABI 和静态控制面板。Solidity 合约、链下筛查策略与客户网站代码不在本次改动范围内；无需重新部署 Vault 或 Gateway。

## 1. 生成与发布

```bash
./control-panel/build-abis.sh
./control-panel/bundle.sh
cd offchain
npm ci
npm run typecheck
npm test
npm run build
npx vitest run --no-file-parallelism test/kytSdkPanel.integration.test.ts
```

`build-abis.sh` 从当前源码的编译产物生成 `abis.json` 和 `abis.js`，两者均提交。`ContractName` 已登记 `KYTDepositGateway`。`standalone.html` 是已提交的生成文件，需与 `index.html`、`kyt.js`、ABI、地址配置一起更新。

原目录托管须包含 `index.html`、`kyt.js`、`abis.js`、`config.js`；单文件托管使用重新生成的 `standalone.html`。`bundle.sh` 会内联 KYT helpers，并尝试内联 ethers；下载失败时脚本会明确提示 ethers 仍从 CDN 加载。

仓库现有 `config.js` 是 97 测试网配置。本补丁不会把它悄悄替换成某条主网。操作实际部署时，用该链已有部署记录生成/配置地址簿并重新打包，不要为更新面板而重新部署已有合约。面板拒绝钱包网络与配置链不一致的 KYT 操作。

## 2. SDK

`getVaultDepositRoute(vault)` 每次读取链上的 `gate()` 和付款代币。零 Gate 返回 `mode: "direct"`；非零 Gate 必须能读取 Gateway 接口，且 `vault()`、`asset()` 与当前金库一致，才返回 `mode: "kyt"` 和动态 Gateway 地址。RPC 失败、接口不兼容或绑定不符都报错，不降级为普通申购。不需要预先维护哪些产品启用 KYT，也不使用部署记录中的 `gateInstalled` 判断实时状态。

新增接口：

- `kytGatewayAt(gateway)`：按地址获得合约对象。
- `requestKytDeposit(gateway, assets, owner, signer)`：重新确认 Gateway 是当前 Gate，再提交申请；返回 `{ hash, receipt, screeningRequestId }`。
- `getKytRequest(gateway, id)`：返回原始链上申请状态与 `expiresAt`；不存在的申请保留 `NONE`。
- `parseKytEvents(gateway, receipt)`：仅解析指定地址发出的四类申请事件。`DepositExecuted` 同时包含 `screeningRequestId` 和 `vaultRequestId`，二者不能混用。

`setVaultOperator`、`isVaultOperator`、Timelock 方法沿用原实现。`requestKytDeposit` 本身不自动申请代币/operator 授权，调用方应在提交前准备；SDK 也不会替客户自动重提。金额使用付款代币最小单位的 `bigint`。

```ts
const route = await sdk.getVaultDepositRoute(vault);
if (route.mode === "kyt") {
  // 调用方先检查付款代币 allowance，以及 sdk.isVaultOperator(vault, owner, route.gateway)。
  const submitted = await sdk.requestKytDeposit(route.gateway, amountRaw, owner, signer);
  const request = await sdk.getKytRequest(route.gateway, submitted.screeningRequestId);
}
```

申请编号取自已确认交易的 `ScreeningRequested`，不预测 `nextRequestId`。若交易已发送但回执不能解析，错误包含 `KYT_RECEIPT_UNRESOLVED` 和 `txHash`；先检查该交易，不据此再次提交。

链上 `PENDING` 不表示后台仍在处理。页面等待超过 60 秒不能改成 REJECTED；过期需结合链上区块时间及该申请的 `expiresAt` 判断。`EXECUTED` 表示已扣款并进入 Vault 申购队列，不表示份额已经结算或领取。

## 3. 控制面板

面板新增 Vault KYT / Gate 区域。可从已部署金库列表选择，也可输入其他金库地址；两者均使用当前配置链。点击读取会展示链上 Gate、产品状态、Owner、Timelock；Gate 非零时校验并展示 Gateway 参数。Gate 为零时，管理员填写待连接 Gateway，使用 Inspect Gateway 核对绑定关系。

连接、替换和关闭的行为：

1. CONFIGURING：仅该 Vault Owner 直接执行 `setGate`。
2. 非 CONFIGURING：Owner 提交该 Vault 自己的 Timelock，目标为 Vault、数据为 `setGate(address)`。
3. 排队后从 `ParamChangeScheduled` 回执取真实 changeId，并读取可执行时间和到期时间。排队不表示启用。
4. 等待后使用 Execute ready change；执行者可为任意地址，由合约检查延迟和到期条件。执行成功重新读取 Gate。
5. Cancel change 仍由链上 Owner / Guardian / 原提议者权限决定。

刷新后可从 Timelock 的分页 pending 列表恢复变更；本地仅按链和金库保存最近的变更编号，所有状态重新从链读取。不增加数据库。更换金库时读取该金库自己的 Timelock，不共用 Cash 的地址。

Gateway 参数管理独立检查 `Gateway.admin()`：支持更换 oracle、调整有效期和移交 admin。关闭 KYT 将 Gate 设为零，权限流程相同；它不取消旧 Gateway 的未过期申请，查询旧 Gateway 仍然可用。

原有 Vault requestDeposit 按钮也会读取实时 Gate。普通模式检查对 Vault 的代币授权；KYT 模式检查对 Gateway 的代币授权及 Vault operator 权限，只补缺少的权限。每笔必要操作由钱包确认，授权完成后再次检查 Gate；期间 Gate 改变则停止，要求刷新。授权他人作为权益归属人的情况必须先由该人授予 operator，面板不会以付款人身份冒充其授权。

## 4. 验证与上线边界

- 单元测试覆盖公共 ABI 一致性、动态入口、绑定错误、失败不降级、外部同名事件过滤、两类编号、授权分支、权限、延迟与过期。
- `kytSdkPanel.integration.test.ts` 在 Anvil 使用真实交付部署脚本和实际 Vault/Gateway/Timelock 验证直接连接、普通申购、排队与执行、KYT 授权/申请/通过/拒绝/过期、取消变更、关闭及 Gateway 管理。该套测试用本地预言机签署模拟判定，不调用 Chainalysis。
- 既有 runner 联调测试继续单独验证事件监听脚本，不由本套 SDK/面板测试替代。
- 本仓库更新不会自动更新独立客户网站的 SDK/ABI 副本，也不会启动 AWS 服务或启用主网 Gate。上线 KYT 仍须完成部署手册第 12.6 节。
