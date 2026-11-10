# PR46：本地部署确认与 CI 诊断

## 已确认的问题边界

PR46 的两次 GitHub Actions 部署失败，均发生在 Forge 已完成平台及三个金库部署之后。第一次最后输出为 Note 金库角色配置，第二次最后输出为 StubStateManager 注册。旧脚本没有逐笔交易哈希，也没有为这些 `tx.wait()` 设置截止时间，因此现有日志不能证明具体根因。

两次失败以及此前 main 的成功运行都使用 Foundry/Anvil 1.8.3，不能归因于这几次运行之间 Foundry 升级。相关 Solidity、部署脚本和角色配置方法 ABI 未被 PR46 的原始修改改变。

## 本次补充

- `offchain/scripts/local/deploy.ts` 的本地配置交易统一使用 `sendLocalTransaction`：记录操作名、交易哈希、发送账户、nonce、确认区块和耗时。
- 直接查询交易回执，避免已出块交易的确认依赖后续区块通知。发送和回执等待分别最多 60 秒，单次回执 RPC 最多 10 秒；任何错误、失败回执或超时都让部署失败退出，不自动重发交易。
- 失败后读取当前区块、回执及账户 latest/pending nonce；各项诊断最多 2 秒。结束时关闭 provider。
- Forge 增加 `--timeout 60`，每个 Forge 子进程最多 180 秒，并打印开始及结束耗时。CI 的部署步骤仍为 8 分钟，整个任务仍为 20 分钟。
- CI 保存 `local-deployment-diagnostics` 附件，包含部署输出和 Anvil 日志；`pipefail` 确保写日志不会掩盖部署失败。
- 增加 7 项回归测试：已出块、等待出块、链上回滚、无回执超时、发送卡住、RPC/诊断卡住及 RPC 错误。

上述调整仅用于本地 Anvil 部署和 CI，不改变 Solidity 合约、生产 KYT 监听器或主网部署状态。

## 本地验证记录

环境：Windows、Node 24.14.1、ethers 6.17.0、Solidity 0.8.24；Foundry/Anvil 1.8.3，提交 `cae51ad458f6abb64852b7709eb784352429825d`，与所查 CI 相同。

1. 原始 PR46 部署脚本在全新本地 Anvil 上运行成功：306.639 秒，退出码 0。
2. 本次修正后的完整部署成功：316.719 秒，退出码 0。完成 Core、Platform、Cash/Note/LP、角色配置、Stub 注册、桥接目标及测试账户注资，写出地址簿；最终区块 101，交易池为空。没有手动补挖区块或跳过交易。
3. 类型检查通过；全部无链测试 243 项通过，其中本次新增 7 项。
4. 本次 CI 修正前，原样运行的 KYT Runner/Gateway 联调 5 项、SDK/控制面板联调 7 项全部通过。使用真实本地合约及交易回执，筛查结果采用测试数据；未调用 Chainalysis。

Windows 本地使用 Vitest 程序化入口加载相同测试文件，避免本机配置打包的目录权限问题；GitHub CI 使用标准命令。

本地成功不能代替 Ubuntu CI，也不证明旧超时根因已复现。完整 CI 还包含第四个金库的独立追加部署与断言；合并前应以最新提交的 GitHub Actions 三项检查全部通过为准。
