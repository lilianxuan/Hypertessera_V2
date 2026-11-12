# OpenZeppelin TimelockController provenance

`src/addition/TimelockController.sol` is the complete standard implementation from **OpenZeppelin Contracts v5.1.0**, pinned to upstream commit `69c8def5f222ff96f2b5beff05dfba996368aa79`. The file is included as a **standard third-party dependency** under the MIT license. [Pinned upstream source](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/69c8def5f222ff96f2b5beff05dfba996368aa79/contracts/governance/TimelockController.sol) · [v5.1.0 release](https://github.com/OpenZeppelin/openzeppelin-contracts/releases/tag/v5.1.0) · [MIT license](../../lib/openzeppelin-contracts/LICENSE)

The copy used by the deployment script has four adjusted import paths that resolve to the same vendored OpenZeppelin dependencies and two source attribution comments. Its contract body matches upstream. The original file header records v5.0.0 as the version in which this file was last updated. [Project copy](TimelockController.sol) · [Original copy in this repository](../../lib/openzeppelin-contracts/contracts/governance/TimelockController.sol) · [Source integrity record](../../reports/source-integrity.json)

The original copy in this repository and the pinned upstream file share Git blob ID `349d940fd506f9380109469b23f896d7376bf1ba`. Review the tracked blob and the deployment copy's diff from the repository root.

```sh
git rev-parse HEAD:lib/openzeppelin-contracts/contracts/governance/TimelockController.sol
git --no-pager diff --no-index --ignore-cr-at-eol -- lib/openzeppelin-contracts/contracts/governance/TimelockController.sol src/addition/TimelockController.sol
```

For due diligence and audit estimates, list this file under **standard third-party dependency verification**, separately from project-authored SLOC. The proposed project-specific scope includes the GovernanceController implementation and its integration with the timelock, including the initial delay, role assignment, and permission handover. [Deployment script](../../script/DeployDD01Governance.s.sol) · [GovernanceController](GovernanceController.sol) · [Governance handover](../../docs/dd01-governance.md)

`TimelockController.sol` 为 OpenZeppelin v5.1.0 标准时间锁的完整副本，与固定上游版本的差异仅为四处依赖导入路径和两行来源注释。尽调及审计报价可将该文件单独列为第三方标准依赖核验。建议项目侧的审计范围覆盖 `GovernanceController` 的实现及时间锁集成，包括初始延迟、角色分配和权限交接。 [尽调修改方案](../../docs/尽调修改方案.md)
