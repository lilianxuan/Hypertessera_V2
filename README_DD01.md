# HyperTessera DD [01] 开发交付

本包为 2026-11-10 复核修订版。

本开发副本基于用户提供的 `hyperTessera_William-main (1).zip`，基准 SHA-256：

`9c3ec2f8ba319c28e85a87a9e2009af8842c3e9d8aaf38afc51ec8e7012800fb`

## 本次交付

本次合约源码集中放在 `src/addition/`：

- `GovernanceController.sol`：本次编写的治理控制合约。
- `TimelockController.sol`：固定版本 OpenZeppelin 5.1.0 标准时间锁的完整源码副本；
  保留 MIT 许可及原注释，仅调整依赖导入路径并标注来源，不改变时间锁逻辑。

原始 OpenZeppelin 依赖保留在 `lib/`。部署脚本和专项测试使用 `src/addition/` 中的两个合约。

原 ZIP 中230个原文件保持字节级不变，Adapter / Vault / Settlement / NAVOracle /
HyperAccessControl / VaultTimelock 源码均未改动。

- [详细开发与权限交接说明](docs/dd01-governance.md)
- [尽调修改方案](docs/尽调修改方案.md)
- [新增治理控制合约](src/addition/GovernanceController.sol)
- [协议级标准时间锁](src/addition/TimelockController.sol)
- [部署及公开配置检查脚本](script/DeployDD01Governance.s.sol)
- [安全测试](test/DD01GovernanceSecurity.t.sol)
- [真实协议整合测试](test/DD01GovernanceIntegration.t.sol)
- [部署脚本及绑定预检测试](test/DD01GovernanceDeployment.t.sol)
- `abi/`：新增合约及标准时间锁 ABI。
- `reports/`：最终本地测试和源码完整性记录。

## 本轮最小修订

- 链下部署脚本使用 StateManager 的实际 `accessControl()` 接口核对权限合约绑定。
- 配置 RevenuePool 时，部署前核对其结算代币与 UnifiedPool 一致。
- 桥接白名单新增仍要求已注册；撤销仅禁止零地址，以便清理历史错误条目。
- 补充真实部署脚本入口、错误绑定、代币不一致及桥接白名单撤销测试。

`script/DeployDD01Governance.s.sol` 是本地 Foundry 执行的链下部署工具，
不作为协议业务合约部署。它用于创建新增时间锁和治理控制合约，不重部署原协议，
不自动执行 Governor 权限移交。

## 边界

这是 DD [01] 的本地开发版本，不是生产部署或第三方审计结论。
原有 Governor 转账在新层受到时间锁约束，但 DD [02] 的共享限额、一般收款白名单及
资金归属记账未实现；DD [03] 的价格发布及报价时效逻辑未实现。

不新增自定义紧急暂停、恢复、DAO 或 Cactus 接口。
原模块已有的暂停/恢复方法仅按原 Governor 职能延迟转发，不构成新增应急系统。

**切换主网前需完成相关后续整改、补充审计、目标链只读核验及明确的部署授权。**
本次没有发送链上交易、读取钱包私钥或执行权限移交。

## 工具与依赖

- Solidity 0.8.24，原有 Foundry 编译配置不变。
- OpenZeppelin 5.1.0，commit `69c8def5f222ff96f2b5beff05dfba996368aa79`。
- forge-std commit `620536fa5277db4e3fd46772d5cbc1ea0696fb43`。
- 本地验证使用 Foundry 1.8.3。

完整包包含这些依赖的源码（不含 Git 元数据）；增量包不覆盖既有依赖，应用时核对版本。

```sh
forge build --use /path/to/solc-0.8.24 --offline
forge test --use /path/to/solc-0.8.24 --offline --match-path 'test/DD01Governance*.t.sol' -vv
forge test --use /path/to/solc-0.8.24 --offline
```

部署脚本只在另行授权后使用。模拟结果、预测地址和编译产物均不等于实际主网部署证明。
