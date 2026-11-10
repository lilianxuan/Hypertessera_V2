# HyperTessera 部署手册

本手册面向接手方的部署与运维人员，覆盖从零部署一整套 HyperTessera 合约、验证部署结果、
完成上线前配置，以及把各个角色从部署钱包移交给正式名单的全过程。

协议分两部分部署：**共享平台**只建一次，**金库**按需一个一个建。平台建好之后，新增第几个
金库都只是重复跑一次同一条命令，不再动任何已有合约。

本手册只讲部署与交接。日常运营（KeeperBot、结算、索引器）另见文末“延伸阅读”。

---

## 目录

1. [前置准备](#1-前置准备)
2. [部署配置：profile 与网络文件](#2-部署配置profile-与网络文件)
3. [环境变量完整清单](#3-环境变量完整清单)
4. [部署结构：共享平台与逐个金库](#4-部署结构共享平台与逐个金库)
5. [执行部署](#5-执行部署)
6. [新增一个金库](#6-新增一个金库)
7. [部署后验证](#7-部署后验证)
8. [上线前必须设置的参数](#8-上线前必须设置的参数)
9. [角色移交](#9-角色移交)
10. [升级与换代](#10-升级与换代)
11. [疑难排查](#11-疑难排查)
12. [可选模块：KYT 申购筛查](#12-可选模块kyt-申购筛查)
13. [延伸阅读](#13-延伸阅读)

---

## 1. 前置准备

### 工具

| 工具 | 用途 | 检查 |
|---|---|---|
| [Foundry](https://getfoundry.sh)（`forge` / `cast` / `anvil`） | 编译、部署、链上读写 | `forge --version` |
| `jq` | 部署脚本合并各阶段输出 | `jq --version` |
| Node.js ≥ 20 + npm | 链下服务（`offchain/`） | `node --version` |
| `git` | 拉取子模块 | `git --version` |

### 拉取代码并编译

```bash
git submodule update --init --recursive   # forge-std v1.16.1, openzeppelin-contracts v5.1.0
forge build
forge test                                # 全部通过才能进入部署
./script/check-sizes.sh                   # 确认所有合约都在 EIP-170 24,576 字节限制内
```

> ⚠️ **`EarnVaultDeployer` 距离 EIP-170 上限只剩约 100 字节。**
> 今后任何往 `BaseVault` 加代码的改动，都必须先跑 `./script/check-sizes.sh` 确认还放得下，
> 否则 `EarnVaultDeployer` 会直接超限、部署第二阶段无法完成。
> （余量从约 300 字节降到约 100 字节，是因为初始份额价格改为按结算代币 `decimals()` 动态计算，
> 见[第 3 节](#3-环境变量完整清单)“结算代币小数位”。）

### 部署钱包

部署钱包需要：

- 目标链上足够的原生代币支付 gas。`demo` 下一整套部署（core + platform + 三个金库）实测约消耗
  **9,100 万 gas**、共 83 笔交易（BSC Testnet 2026-09-16 这一代实测：core 26.1M / platform 32.3M /
  每个金库约 10.7M，合计 90.6M；按 0.1 gwei 约 0.0091 BNB）。
  `production` 下不带 `--vault` 只建共享平台，约 58.4M；之后每加一个金库再约 10.7M。
- 私钥通过环境变量 `TEST_PK` 或 `PRIVATE_KEY` 提供，**不要写进网络文件**。
  必须让它出现在调用 `script/deploy.sh` 的那个 shell 的环境里：

  ```bash
  export TEST_PK=0x...                      # 或
  set -a; . ./.env; set +a                  # 从仓库根目录的 .env 导出（该文件已被 gitignore）
  ./script/deploy.sh --network bsc-testnet
  ```

  > ⚠️ **只把私钥写进 `.env` 是不够的。** `script/deploy.sh` 只读取
  > `script/deploy/networks/<名称>.env`，**不会** source 仓库根目录的 `.env`。
  > 它在 `demo` profile 下找不到 `TEST_PK` / `PRIVATE_KEY` 时，会**静默回退到硬编码的
  > Anvil 账户 0 私钥**（一个公开的私钥），既不报错也不提示，部署钱包就变成了
  > `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`。
  > 开跑前先核对脚本打印的 `deployer:` 那一行确实是你的地址。
  > （`forge` 自己会自动加载 `.env`，所以直接调 `forge script` 时没有这个问题——
  > 这一条只针对 `script/deploy.sh`。）

部署钱包在部署过程中同时是 Governor、三个 Vault 的 Owner、以及临时的 Curator 与 Keeper。
部署完成后按[第 9 节](#9-角色移交)移交。

---

## 2. 部署配置：profile 与网络文件

### `DEPLOY_PROFILE`

部署脚本有两种 profile，由环境变量 `DEPLOY_PROFILE` 选择：

| | `demo`（默认） | `production` |
|---|---|---|
| 结算代币 | 未指定 `USDT` 时部署一颗 `MockUSDT` | **必须**指定 `USDT` 为真实代币 |
| 演示资产 | 注册 S Token / J Token 两个演示资产，部署演示 `RWAAdapter` 和包装代币 | 不注册、不部署 |
| `StubStateManager` | 部署（模块暂停测试脚手架） | 不部署 |
| 角色地址 | 未指定的角色回退到部署钱包（chainId 31337 上回退到对应的 Anvil 账户） | **每个角色都必须显式指定**，缺一个就中止部署并报出变量名 |
| 部署私钥 | 未指定时回退到 Anvil 账户 0 | 必须提供 `TEST_PK` 或 `PRIVATE_KEY` |

`production` 存在的意义就是：**不让任何一个角色因为忘记配置而悄悄落在部署钱包上**。

### 网络文件

每条链的配置放在 `script/deploy/networks/<名称>.env`，仓库自带三个：

```
script/deploy/networks/
  anvil.env                  本地 Anvil 开发网（demo）
  bsc-testnet.env            BNB Smart Chain 测试网（demo）
  bsc-mainnet.env.example    主网模板（production），复制后填写
```

部署主网：

```bash
cp script/deploy/networks/bsc-mainnet.env.example script/deploy/networks/bsc-mainnet.env
$EDITOR script/deploy/networks/bsc-mainnet.env     # 填写每一项
```

---

## 3. 环境变量完整清单

### 网络文件中设置

| 变量 | 用于 | 说明 |
|---|---|---|
| `RPC_URL` | 全部 | 必填。目标链的 RPC 地址。 |
| `DEPLOY_PROFILE` | 全部 | `demo`（默认）或 `production`。 |
| `FORGE_FLAGS` | 全部 | 追加给 `forge script` 的参数。BSC 用 `--legacy --slow`，Anvil 用 `--slow`，见[第 11 节](#11-疑难排查)。 |
| `USDT` | core | `demo` 下可选（指定则沿用已有的 MockUSDT，测试钱包余额不会归零）；`production` 下**必填**，须为真实结算代币。 |
| `VAULT_CURATOR` | 金库 | 该金库的 Curator。`production` 下建金库时必填。 |
| `VAULT_KEEPER` | 金库 | 该金库的 Keeper。同上。 |
| `VAULT_GUARDIAN` | 金库 | 该金库的 Guardian。同上。 |
| `VAULT_ALLOCATOR` | 金库 | 该金库的 Allocator。同上。 |
| `SETTLEMENT_OPERATORS` | 金库 | 该金库的结算 Operator 列表，英文逗号分隔。同上。 |
| `SETTLEMENT_THRESHOLD` | 金库 | 该金库一笔结算需要的签名数，取值 1 到 Operator 个数。同上。 |
| `DATA_PROVIDER_SIGNER` | 金库 | 该金库 Adapter 的成交数据签名者。同上。 |
| `CLAIM_GRACE_PERIOD` | 金库 | 可选，默认 30 天（2,592,000 秒）。见[第 8 节](#8-上线前必须设置的参数)。 |
| `ADAPTER_STALENESS_WINDOW` | 金库 | 可选，默认 36 小时。 |
| `TOKEN_AGENT` / `NAV_SIGNER` | core | 仅 `demo`。演示资产的 Token Agent 与 NAV 签名者。 |

> 建平台时**不需要**填任何金库角色。`production` 下不带 `--vault` 的运行只检查 `USDT`，
> 角色和 Operator 名单等到真正建金库时再给。

### 结算代币小数位

`USDT` 指向的结算代币**不限定 6 位小数**。金库在构造函数里读一次 `IERC20Metadata.decimals()`，
把 1:1 的初始份额价格定为 `10 ** decimals()`，并写入 `parityPrice`（公开可读）。份额本身固定
18 位小数，所有价格的含义都是“每 1e18 份额对应多少个结算代币最小单位”。

- BSC 主网 USDT `0x55d398326f99059fF775485246999027B3197955` 是 **18 位小数**，
  金库的 `parityPrice` 为 `1e18`。
- BSC 测试网的 `MockUSDT` 是 6 位小数，`parityPrice` 为 `1e6`。

部署后可以顺手核一下（与结算代币自身的 `decimals()` 对得上即可）：

```bash
cast call $CASH_VAULT 'parityPrice()(uint256)' --rpc-url $RPC   # 18 位代币应为 1000000000000000000
cast call $USDT 'decimals()(uint8)'            --rpc-url $RPC
```

控制台 `control-panel/index.html` 会在加载时读一次结算代币的 `decimals()`：顶部状态栏多了一行
“Settlement token”，显示代币地址与位数；所有金额输入框的标注（`assets (18-dec)`）与默认值
（1000 个整币对应的最小单位数）都按这个位数生成。读不到时输入框留空、标注为 `token units`，
而不是填一个数量级错误的默认值。**输入框里填的仍然是最小单位**，与以往一致。

### 只在建金库时用的命令行变量

| 变量 | 说明 |
|---|---|
| `VAULT` | 可选。指定一个**已经存在**的金库地址，脚本就不再新建，只对它做接线。前端或钱包直接调 `VaultFactory.deployVault` 建出来的金库，用它一键补齐配置。 |
| `CASH_VAULT` | `lp` 金库必填（驱动脚本会默认取 label 为 `cash` 的那个）。LP 金库桥接进哪个 Cash 金库，可以指向任意一个已有的。 |
| `VAULT_NAME` / `VAULT_SYMBOL` | 可选。金库 ERC-20 的名称与代号，默认按类型取值。 |

### 命令行环境中设置

| 变量 | 说明 |
|---|---|
| `TEST_PK` / `PRIVATE_KEY` | 部署钱包私钥。`TEST_PK` 优先。**不要写进网络文件**，也**不能只写进仓库根目录的 `.env`**——`script/deploy.sh` 不读那个文件，必须 `export` 到当前 shell，否则会静默回退到公开的 Anvil 私钥。见[第 1 节](#1-前置准备)。 |

### 自动传递的变量

下列变量由 `script/deploy.sh` 从上一步的输出里读出并传给下一步，**不需要手工设置**：

```
HYPER_ACCESS_CONTROL  REVENUE_POOL  PROTOCOL_FEE_CONFIG  USDT
STATE_MANAGER  QUEUE  UNIFIED_POOL  SETTLEMENT  ADAPTER_FACTORY
VAULT_FACTORY  CLAIM_REGISTRY  LIQUIDITY_BRIDGE
```

这是整合的主要目的之一：历代部署都靠人工把上一阶段的地址抄进下一阶段的环境变量，
抄错一个就是一代作废。

---

## 4. 部署结构：共享平台与逐个金库

### 共享平台（每套部署只建一次）

| 步骤 | 脚本 | 部署内容 | 输出文件 |
|---|---|---|---|
| 1 core | `script/deploy/DeployCore.s.sol` | `HyperAccessControl`、`RevenuePool`、`ProtocolFeeConfig`、`AssetRegistry`（内部部署 `MintBurnController`）、`NAVOracle`、`PoRRegistry`、`ReservePSM`；`demo` 下另有 `MockUSDT`、`StubStateManager`、`Queue`、两个演示资产、演示 `RWAAdapter`、包装代币 | `control-panel/deployments.json` |
| 2 platform | `script/deploy/DeployPlatform.s.sol` | `StateManager`、`ClaimRegistry`、`NAVOracle`、`Queue`、`LiquidityBridge`、`UnifiedPool`（UUPS 代理）、两个 Deployer、`VaultFactory`、`Settlement`、`AdapterFactory`；`setVaultFactory`、`RevenuePool.addAuthorizedSource`、`UnifiedPool.setSettlementWhitelisted`、稳定币手续费代币 | `control-panel/deployments-platform.json` |

**平台这一步不创建任何金库，也不需要填任何金库角色。**

### 金库（每个金库跑一次）

| | 脚本 | 内容 | 输出文件 |
|---|---|---|---|
| 金库 | `script/deploy/DeployVault.s.sol` | 部署（或接管）一个金库；池准入与白名单、绑定 `Settlement` 与该金库的 Operator 集合、部署并接好 Adapter、`setUnifiedPool`、`configureClaimRegistry`、桥接白名单、四个金库级角色 | `control-panel/deployments-vault-<label>.json` |

每个金库写自己的一份文件，**永远不会覆盖已有金库的记录**。`script/deploy.sh` 把所有文件
汇总成 `control-panel/config.js` 里的 `vaults` 数组；label 为 `cash` / `note` / `lp` 的三个
另外填进 `CashVault` / `NoteVault` / `LPVault` 等扁平 key，控制台与链下服务照旧读这些 key。

### 为什么这样切

每条边界都对应一个合约约束，不是为了好看：

- **core → platform**：`Queue`、`ClaimRegistry`、`UnifiedPool` 的 `StateManager` 绑定都只写一次
  且没有 setter（`ClaimRegistry` 与 `Queue` 在构造函数里，`UnifiedPool` 在 `initialize()` 里）。
  如果在 core 用 `StubStateManager` 建好它们，后面注册的真实金库会被全部拒绝
  （`enqueue` / `receiveVaultPrincipal` 抛 `UnregisteredVault`）——v3 那一代测试网就是这样
  静默损坏的。所以这三个合约必须和真实 `StateManager` 在同一步部署。
- **`Settlement` 与 `AdapterFactory` 属于平台，不属于金库**：
  `Settlement(stateManager, unifiedPool, queue)` 与 `AdapterFactory()` 的构造参数里都没有金库，
  一个 `Settlement` 服务所有金库。每个金库自己的绑定、Operator 名单与阈值是
  `Settlement` 的**按金库**状态，由金库脚本写入。
- **金库脚本内部的顺序**：`setAdapter` / `addAdapter` / `setDataProvider` 都由 Curator 把关，
  而发起交易的是部署钱包。所以脚本先把部署钱包设成该金库的 Curator 完成接线，
  最后一步才把四个角色交给正式地址。

### 脚本不做的事

以下三项是有意留给接手方的，部署脚本一律不碰：

1. **`ProductParams`**（含 `subscriptionCapShare` 募集上限）—— 产品参数，见[第 8 节](#8-上线前必须设置的参数)。
2. **`LiquidityAdapter.setBridgeTarget`** —— Curator 自己的初始参数配置（客户反馈 2026-07-10，§3.4.1）。
3. **所有权与 Governor 角色移交** —— 见[第 9 节](#9-角色移交)。

此外，**KYT 申购筛查默认不启用**（每个金库的 `gate` 都是 `address(0)`）。需要的金库在部署
完成后单独追加，见[第 12 节](#12-可选模块kyt-申购筛查)。

---

## 5. 执行部署

```bash
# 本地 Anvil：demo profile 会顺带建好 cash / note / lp 三个金库
anvil --port 8545 &
./script/deploy.sh --network anvil

# BNB 测试网：同上
./script/deploy.sh --network bsc-testnet

# 主网：production profile 只建共享平台，一个金库都不建
./script/deploy.sh --network bsc-mainnet --dry-run      # 先模拟第一步
./script/deploy.sh --network bsc-mainnet                # core + platform
```

`production` 下不带 `--vault` 就停在平台，金库留给[第 6 节](#6-新增一个金库)逐个建。
`demo` 下会继续建三个金库，本地开发网与测试网因此一条命令即可用。

> ⏱ **BSC 测试网上一整套 `demo` 部署约需 20–30 分钟，中途长时间没有任何输出属于正常。**
> `FORGE_FLAGS` 里的 `--slow` 会把 83 笔交易逐笔串行广播，每个步骤在打印完 gas 估算之后
> 可能静默 10 分钟以上。**不要以为它卡住就去中断它**——第 11 节那条
> `wait_for_pending` 说的是另一回事（节点漏掉了某一笔）。

> 脚本打印的 `stages: 1..2` 与 `==> Stage 1/2`、`==> Stage 2/2` **只涵盖共享平台**。
> `demo` 下随后建的三个金库是以 `==> Vault — cash (cash)` 这样的形式单独打印的，不计入
> stage 编号。用 `--from 2` 重跑平台时，后面这三个金库同样会跟着重建。

### 参数

| 参数 | 说明 |
|---|---|
| `--network <名称>` | 必填。对应 `script/deploy/networks/<名称>.env`。 |
| `--vault cash\|note\|lp` | 建一个金库（见下一节）。不带它就是建共享平台。 |
| `--label <名称>` | 配合 `--vault`，给这个金库起名，默认与类型同名。地址簿与输出文件都用它。 |
| `--kyt <金库 label>` | 可选追加模块：给这个金库部署 KYT 筛查网关。金库部署完之后再跑，见[第 12 节](#12-可选模块kyt-申购筛查)。 |
| `--from <N>` / `--to <N>` | 共享平台两步的区间（1 = core，2 = platform）。某一步失败后用 `--from` 续跑。 |
| `--dry-run` | 只模拟、不广播、不写任何输出文件。 |

> **关于 `--dry-run`**：它只模拟区间内的**第一步**就停止。后面的步骤在空链上无法模拟——
> 每一步都要调用上一步部署出来的合约，而模拟并没有真的把它们广播上链。
> 要演练第 N 步，用 `--dry-run --from N` 对着一条已经有前 N-1 步的链（fork 或部署到一半的链）跑。

### 某一步失败了怎么办

各步骤之间互相独立，失败不会作废已经成功广播的合约。修好问题后：

```bash
./script/deploy.sh --network bsc-testnet --from 2      # 只重跑 platform
./script/deploy.sh --network bsc-testnet --vault lp    # 只重跑某个金库
```

地址会自动从前面步骤的输出文件里重新读出来。**不要从第 1 步重跑**——那会部署出一整套
新合约，把已经成功的部分全部作废。

> 🛑 **失败的步骤仍然会写出一份完整的输出文件，里面的地址一个都不存在。**
> `forge script` 先完整模拟、再广播，而输出文件是在模拟阶段用 `vm.writeJson` 写的。
> 广播中途失败（最常见的是下面那条 `nonce too low`），
> `control-panel/deployments-platform.json` 照样会带着 9 个地址落盘，看上去和成功的一模一样，
> 但链上什么都没有。如果此时去跑 `build-abis.sh` 并 `git add control-panel/config.js`，
> 就会把一整套幽灵地址提交给整个团队，直到控制台毫无反应才会发现。
>
> **任何一步失败之后，先验证再信任输出文件：**
>
> ```bash
> # 失败步骤写出的每个地址都必须有 runtime code；返回 0x 就是幽灵地址
> jq -r '.addresses | to_entries[] | "\(.key) \(.value)"' control-panel/deployments-platform.json |
>   while read -r name addr; do
>     code="$(cast code "$addr" --rpc-url "$RPC_URL")"
>     [ "${#code}" -gt 3 ] && echo "ok      $name $addr" || echo "PHANTOM $name $addr"
>   done
> ```
>
> 只要出现 `PHANTOM`，就用 `--from N` 重跑那一步把文件覆盖掉，**重跑成功之前不要**
> `build-abis.sh`，也不要 `git add control-panel/config.js`。

### 部署完成后

```bash
./control-panel/build-abis.sh      # 生成 control-panel/abis.js
git add control-panel/config.js    # 提交给团队共用
```

控制台可以直接打开 `control-panel/index.html`（用 MetaMask 连接），
或者跑 `./control-panel/bundle.sh` 打包成单文件 `standalone.html` 丢到任意静态托管上。

---

## 6. 新增一个金库

平台建好之后，每加一个金库就是跑一次同一条命令。**不会重新部署任何共享合约，也不会动任何
已有金库。**

```bash
# 建第一个 Cash 金库
./script/deploy.sh --network bsc-mainnet --vault cash

# 建 Note 金库
./script/deploy.sh --network bsc-mainnet --vault note

# 建 LP 金库：桥接进 label 为 cash 的那个（也可以显式指定 CASH_VAULT）
./script/deploy.sh --network bsc-mainnet --vault lp
CASH_VAULT=0xAbc... ./script/deploy.sh --network bsc-mainnet --vault lp

# 再建一个 Cash 金库，起个不同的 label
./script/deploy.sh --network bsc-mainnet --vault cash --label cash-q2
```

### 每种类型只检查自己要的参数

| 类型 | 额外必填 | **不**需要 |
|---|---|---|
| `cash` | `LIQUIDITY_BRIDGE` | `CASH_VAULT` |
| `note` | 无 | `LIQUIDITY_BRIDGE`、`CASH_VAULT` |
| `lp` | `LIQUIDITY_BRIDGE`、`CASH_VAULT` | 无 |

`LIQUIDITY_BRIDGE` 由驱动脚本自动从平台输出里读出来，正常不用手工填。建一个 Note 金库
不会因为桥相关的参数没配而被拦下。

### 接管一个已经建好的金库

`VaultFactory.deployVault` 是无许可的，谁都可以从钱包或前端直接建一个金库。这样建出来的
金库只是个空壳——没有绑 `Settlement`、没有进池子白名单、没有 Adapter。把它交给同一个脚本
补齐配置：

```bash
VAULT=0xAbc... ./script/deploy.sh --network bsc-mainnet --vault cash --label cash-q2
```

脚本会先校验再动手，校验不过直接中止：

- `StateManager.registeredVaults(VAULT)` 为 `true`（确实是这套平台的 VaultFactory 建的）
- `VAULT.owner()` 是部署钱包
- `VAULT` 的 `stateManager` / `queue` / `usdt` 与平台一致

接管模式针对的是**还在 `CONFIGURING` 状态**的金库，也就是 `VaultFactory` 刚建出来的样子。
金库一旦离开 `CONFIGURING`，Owner 类操作就要走该金库自己的 `VaultTimelock`，不能再由脚本
直接发交易。

### 新增金库之后

```bash
./control-panel/build-abis.sh
git add control-panel/config.js
```

然后按[第 8 节](#8-上线前必须设置的参数)给这个新金库设置 `ProductParams`——
**新金库的 `subscriptionCapShare` 同样是 `0`，同样代表不限额。**

---

## 7. 部署后验证

**这一节不能跳过，每新增一个金库也要重跑一次金库相关的那几条。**

先把本次部署的地址读进环境变量——直接从合并后的地址簿取，不用手工抄：

```bash
RPC=<你的 RPC>

# 变量名与 config.js / deployments-merged.json 里的 key 并不同名，这里一次性对好
eval "$(jq -r '.addresses |
  "UNIFIED_POOL=\(.UnifiedPool)
   SETTLEMENT=\(.Settlement)
   CLAIM_REGISTRY=\(.ClaimRegistry)
   LIQUIDITY_BRIDGE=\(.LiquidityBridge)
   FEE_CONFIG=\(.ProtocolFeeConfig)
   USDT=\(.MockUSDT // .USDT)
   CASH_VAULT=\(.CashVault)
   NOTE_VAULT=\(.NoteVault)
   LP_VAULT=\(.LPVault)"' control-panel/deployments-merged.json)"
```

然后逐条执行：

```bash
# ① UnifiedPool 双白名单 —— 这两项没设好，协议一上线就是死的
cast call $UNIFIED_POOL 'vaultWhitelisted(address)(bool)'      $CASH_VAULT --rpc-url $RPC   # true
cast call $UNIFIED_POOL 'vaultWhitelisted(address)(bool)'      $NOTE_VAULT --rpc-url $RPC   # true
cast call $UNIFIED_POOL 'vaultWhitelisted(address)(bool)'      $LP_VAULT   --rpc-url $RPC   # true
cast call $UNIFIED_POOL 'settlementWhitelisted(address)(bool)' $SETTLEMENT --rpc-url $RPC   # true

# ② 三个 Vault 的 Settlement 绑定（三个都要查，不是只查 cash）
for V in $CASH_VAULT $NOTE_VAULT $LP_VAULT; do
  cast call $V 'settlement()(address)' --rpc-url $RPC        # 三个都 == $SETTLEMENT
done

# ③ 金库脚本设置的角色与参数（三个金库各查一遍）
for V in $CASH_VAULT $NOTE_VAULT $LP_VAULT; do
  cast call $V 'curator()(address)'       --rpc-url $RPC
  cast call $V 'guardian()(address)'      --rpc-url $RPC
  cast call $V 'allocator()(address)'     --rpc-url $RPC
  cast call $V 'claimRegistry()(address)' --rpc-url $RPC     # == $CLAIM_REGISTRY
done
cast call $FEE_CONFIG 'paymentTokenOf(uint8)(address)' 2 --rpc-url $RPC   # == $USDT（2 = Stable）

# ④ 桥接白名单：只有 cash 与 lp 进桥，note 不进
cast call $LIQUIDITY_BRIDGE 'bridgeWhitelisted(address)(bool)' $CASH_VAULT --rpc-url $RPC   # true
cast call $LIQUIDITY_BRIDGE 'bridgeWhitelisted(address)(bool)' $LP_VAULT   --rpc-url $RPC   # true
cast call $LIQUIDITY_BRIDGE 'bridgeWhitelisted(address)(bool)' $NOTE_VAULT --rpc-url $RPC   # false —— 这是对的，note 金库与桥无关

# ⑤ 合约确实部署上去了
# 注意：地址上没有合约时 `cast code` 返回的是 "0x"，管道过来是 3 个字符，不是 0。
# 所以判据是「远大于 3」，几万才正常。这一条就是抓幽灵地址的（见第 5 节失败处理）。
for V in $CASH_VAULT $NOTE_VAULT $LP_VAULT; do
  cast code $V --rpc-url $RPC | wc -c
done
```

`UnifiedPool` 的双白名单（审计反馈 V3 #1/#2）是最容易被忽略、后果又最严重的一项：
`attributeInterest` / `attributePrincipal` / `receiveVaultPrincipal` / `distribute`
**同时**要求调用方 Vault 在 `vaultWhitelisted` 内、且该 Vault 当前的 `settlement()` 在
`settlementWhitelisted` 内，缺一不可。部署脚本已经接好线，但每次换代都要复核。

---

## 8. 上线前必须设置的参数

部署脚本**不碰任何产品参数**。开放认购之前必须由 Curator 逐项设置，否则协议行为不符合预期。

### ⚠️ `subscriptionCapShare = 0` 代表不限额

```
CashVault / NoteVault / LPVault .subscriptionCapShare() == 0
```

`0` 不是“未设置”，是**不限额**。Curator 必须在开放认购之前把募集上限写进
`ProductParams.subscriptionCapShare`，否则认购金额不受任何限制。

`ProductParams` 的完整字段（`subscriptionStart` / `subscriptionEnd` / `walletSubscriptionCap` /
`minRaiseAmount` / `subscriptionCapShare` / `cycleDuration` / `maturityTimestamp` /
`claimingStart` / `claimingEnd` / `feeParams`）都要一并确认，通过
`StateManager.setProductParams` 设置。

### ⚠️ `claimGracePeriod = 30 天` 是暂定值

```
claimGracePeriod = 2,592,000 秒（30 天）
```

这是交付方暂定的运营参数，**请接手方确认**。它决定 `recordOverdueClaims` 最早可以在到期后
多久登记逾期未领请求。部署时可以通过 `CLAIM_GRACE_PERIOD` 改；部署后修改要走该 Vault 的
`VaultTimelock`（`configureClaimRegistry` 已加入 OWNER 类白名单）。

### `LiquidityAdapter.setBridgeTarget`

LP Vault 的 Adapter 需要 Curator 指定桥接目标：

```bash
cast send $LP_ADAPTER 'setBridgeTarget(address,address)' $LIQUIDITY_BRIDGE $CASH_VAULT \
  --rpc-url $RPC --private-key $CURATOR_PK
```

### 上线前检查清单

**每个金库都要单独走一遍这份清单，包括以后新增的。**

- [ ] 每个金库的 `ProductParams` 都已设置完毕
- [ ] 每个金库的 `subscriptionCapShare` 已设为真实募集上限（不是 0）
- [ ] `claimGracePeriod` 已确认
- [ ] `LiquidityAdapter.setBridgeTarget` 已调用
- [ ] [第 7 节](#7-部署后验证)的验证全部通过
- [ ] [第 9 节](#9-角色移交)的角色移交已完成
- [ ] 若该金库启用 KYT：[第 12.6 节](#126-启用后的运营准备)的运营准备已完成

---

## 9. 角色移交

部署结束时，部署钱包同时持有下列身份。**上线前必须逐个移交给正式名单。**

| 身份 | 范围 | 移交方式 | 由谁操作 |
|---|---|---|---|
| Vault Owner | 每个 Vault | `BaseVault.transferOwnership(address)` | 当前 Owner（部署钱包） |
| `GOVERNOR_ROLE` | `HyperAccessControl` 全局 | `grantRole(GOVERNOR_ROLE, 新地址)`，确认新地址可用后再 `revokeRole(GOVERNOR_ROLE, 部署钱包)` | 部署钱包 |
| Curator / Keeper / Guardian / Allocator | 每个 Vault | 金库脚本已按网络文件设置；如需变更用 `setCurator` / `setKeeper` / `setGuardian` / `setAllocator` | Vault Owner |
| Settlement Operator | 每个 Vault | `Settlement.setOperator` / `setThreshold` | Vault Owner |
| Data Provider | 每个 Adapter | `IAdapter.setDataProvider` | 该 Vault 的 Curator |
| Token Agent | 每个资产 | `MintBurnController.setTokenAgent` | 资产的 Issuer |
| NAV Signer | 每个 RWA 代币 | `NAVOracle.setSigner` | NAVOracle 的 owner |

### 撤销部署钱包的引导期权限

金库脚本为了完成接线，把部署钱包设成了该金库的 Curator 与 Keeper。脚本最后会把 Curator 交给
`VAULT_CURATOR`，但 Keeper 用的是 `setKeeper(account, true)`，是**追加**而不是替换，
所以部署钱包的 Keeper 权限还在。移交时逐个撤销（新增金库后同样要做一次）：

```bash
for V in $CASH_VAULT $NOTE_VAULT $LP_VAULT; do
  cast send $V 'setKeeper(address,bool)' $DEPLOYER false --rpc-url $RPC --private-key $OWNER_PK
done
```

部署脚本故意不自动做这件事：万一移交中途出错，一个既不是 Owner 也不是 Keeper 的部署钱包
会让整套部署卡在半成品状态，无法补救。

### 移交顺序

先给新地址授权，确认新地址能正常操作，**最后**才撤销部署钱包的权限。顺序反了会把自己锁在门外。

---

## 10. 升级与换代

### 全新换代

重跑 `./script/deploy.sh` 即可，但注意：

- 除 `MockUSDT` 外，上一代的所有地址全部作废，包括所有金库。
- **换代之前先清掉上一代的金库输出文件**：

  ```bash
  rm -f control-panel/deployments-vault-*.json
  ```

  `script/deploy.sh` 是把 `control-panel/deployments-vault-*.json` **全部**合并进
  `config.js` 的（见[第 4 节](#4-部署结构共享平台与逐个金库)“永远不会覆盖已有金库的记录”）。
  新一代如果没有沿用完全相同的 label，旧 label 的那份文件不会被覆盖，会被当成一个仍然有效的
  金库静默合并进新的 `config.js`，而它绑的是上一代那个已经作废的 `Settlement`。
- 只想加金库、不想换代的话不要走这条路——直接用[第 6 节](#6-新增一个金库)加一个金库即可。
- 在 `demo` profile 下把网络文件里的 `USDT` 指向已有的那颗 `MockUSDT`，测试钱包余额就不会
  随换代归零（`bsc-testnet.env` 默认就是这样配的）。
- 换代后前端与链下服务必须同版本升级——Adapter 的 ABI 在历代之间发生过不兼容变更。
- 按仓库既有惯例，每一代在 `docs/deployment-bsctestnet-<日期>-v<N>.md` 留一份部署记录。
  这类记录是时点快照，不要回头改写旧的。

### `UnifiedPool` 升级

`UnifiedPool` 是 UUPS 代理，可以通过 Governor 把关的 `upgradeToAndCall` 升级，代理地址不变。
`reinitializeStateManager` 只用于修复已经上线的旧部署，正常部署流程**不调用**它。

### 改动合约之后

```bash
forge build --sizes
./script/check-sizes.sh     # EarnVaultDeployer 余量不足 100 字节，务必确认
forge test
cd offchain && npm run typecheck && npm test
```

---

## 11. 疑难排查

| 现象 | 原因与处理 |
|---|---|
| `deploy: missing required env var X` | `production` profile 下 `X` 没设。在网络文件里补上。 |
| `deploy: DEPLOY_PROFILE must be 'demo' or 'production'` | profile 拼错了，只有这两个值。 |
| 建金库时 `Unauthorized()` | Curator 不是发起交易的钱包。脚本内部会先把部署钱包设成 Curator 再接线，如果是接管模式，先确认 `VAULT.owner()` 确实是部署钱包。 |
| `deploy: VAULT is not registered in this STATE_MANAGER` | 接管模式给的地址不是这套平台的 `VaultFactory` 建的，或者根本不是金库。 |
| `VaultAlreadyConfigured` | 该金库已经进过 `UnifiedPool`。脚本本身会跳过重复的 `addVault`，出现这个说明是手工调的。 |
| 建 lp 金库报缺 `CASH_VAULT` | 还没有 label 为 `cash` 的金库可供默认。先建一个 Cash 金库，或显式给 `CASH_VAULT=0x…`。 |
| `UnregisteredVault` | `Queue` / `UnifiedPool` 绑的是 `StubStateManager` 而不是真实 `StateManager`。说明 platform 步骤的输出没有正确传给金库步骤，或者复用了 core 步骤的 `QUEUE` / `UNIFIED_POOL`。 |
| BSC 上 `nonce too low` / `EOA nonce changed unexpectedly`，但交易并未上链 | 该 RPC 的负载均衡后端偶发拒绝，未耗 gas。`FORGE_FLAGS` 里的 `--slow` 能压低发生率，但**压不死**——即使已经带着 `--slow`，整套部署里偶尔仍会有一步这样失败，属于已知现象。处理：用 `./script/deploy.sh --network <名称> --from N` 重跑失败的那一步（见[第 5 节](#5-执行部署)）。**重跑成功之前，该步骤写出的输出文件里全是不存在的幽灵地址**，先按第 5 节的 `cast code` 办法核一遍。 |
| forge 卡在 `wait_for_pending` 不动 | 批量广播时节点漏掉了一笔。确保 `FORGE_FLAGS` 含 `--slow`。 |
| BSC 上 gas 估算异常 / EIP-1559 报错 | `FORGE_FLAGS` 里加 `--legacy`。 |
| 控制台显示“— not loaded —” | `config.js` 或 `abis.js` 没生成。跑 `./script/deploy.sh` 与 `./control-panel/build-abis.sh`。 |
| 合约部署失败，提示超出大小 | 撞上 EIP-170。跑 `./script/check-sizes.sh` 看是哪个合约。 |
| 启用 KYT 后申购一律 `GateBlocked` | 这是对的。挂上 Gateway 之后直接调 `Vault.requestDeposit` 一律回滚，申购只能走 `Gateway.requestDeposit`。前端要按 `vault.gate()` 切换入口，见[第 12.1 节](#121-开启后行为会怎么变)。 |
| `deploy: KYT_VAULT already has a gate installed` | 该金库已经挂过一个 Gateway。要换一个，先经 VaultTimelock 把 gate 改回 `address(0)`，见[第 12.4 节](#124-金库已经离开-configuring-怎么办)。 |
| `--kyt` 报 `no vault labelled '…'` | 该 label 的金库还没部署，或记录文件被清掉了。先跑 `--vault`。 |
| KYT 申请一直停在 PENDING | 查看 JSON 日志：可能为离线遗漏、API 失败/非 COMPLETE、本地处理超时、广播不明确或合约回滚。链下超时不改链上状态，不会补扫或重发 fulfill；已广播交易按哈希核对。服务启动会校验网络及 Gateway/Vault/asset/gate/oracle。 |
| 筛查通过但 `fulfill` 回滚 | Vault 拒绝入金：申购窗口已关、上限已满、payer 撤销授权或余额不足、金库已清算。**资金未动、结论未落链**，申请保持 PENDING 直到过期。见 `docs/kyt-deposit-gateway.md` §8.3。 |
| `forge` 用错了私钥 | `forge` 会自动加载仓库根目录的 `.env`，但 `script/deploy.sh` **不会**——它只认当前 shell 里的 `TEST_PK` / `PRIVATE_KEY`，`demo` 下找不到就静默回退到公开的 Anvil 私钥。核对脚本打印的 `deployer:` 一行。见[第 1 节](#1-前置准备)。 |

---

## 12. 可选模块：KYT 申购筛查

这是一个**追加模块**，不是部署阶段。平台、金库都部署完并按[第 7 节](#7-部署后验证)验证过之后，
再对**需要**申购前 Chainalysis 筛查的金库单独跑一次。不需要的金库什么都不用做，申购行为与
以往完全一致。

模块只部署一个合约 `KYTDepositGateway`，**不改动任何已审计的合约**：`BaseVault` 本来就留了
`gate` 钩子（`BaseVault.sol:174`/`:474`/`:1146`），Gateway 实现 `IGate` 并通过原有的
`setGate()` 挂上去。

**一个金库一个 Gateway**：金库地址在 Gateway 构造时写进 `immutable`。

设计细节、接口说明与已知约束见 [`docs/kyt-deposit-gateway.md`](./kyt-deposit-gateway.md)。

### 12.1 开启后行为会怎么变

| | `gate == address(0)`（默认，不启用） | `gate == Gateway`（启用） |
|---|---|---|
| 申购入口 | 直接调 `Vault.requestDeposit` | 只能调 `Gateway.requestDeposit`，**直接调 Vault 一律 `GateBlocked` 回滚** |
| payer 授权对象 | Vault | **Gateway** |
| owner 需要做的 | 若 payer ≠ owner，`vault.setOperator(payer, true)` | `vault.setOperator(gateway, true)` |
| 资金何时离开付款钱包 | 调用当笔 | 筛查通过、预言机 `fulfill` 的那一笔 |
| 赎回 / 领取 / 退款 / 份额转账 | 不变 | **不变，一律不筛查** |

> ⚠️ **启用 KYT 之后，Gateway 是唯一的申购入口。** 前端必须按链上 `vault.gate()` 的取值切换
> 申购入口，否则用户的申购交易会直接回滚。前端不调用 Chainalysis，也不决定筛查是否通过。

### 12.2 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `KYT_ORACLE` | 是 | 允许提交筛查结果（调 `fulfill`）的账户。链下监听脚本用的就是这个地址。 |
| `KYT_ADMIN` | `production` 下必填 | 可配置 `oracle` 与有效期。**用多签。** `demo` 下未设时回退到部署钱包。 |
| `KYT_VALIDITY_PERIOD` | 否 | 申请保持可 fulfill 的秒数，默认 3600（1 小时）。合约限制 5 分钟 ~ 7 天。 |
| `KYT_SET_GATE` | 否 | 设为 `false` 则只部署 Gateway、不挂 gate。见 [12.4](#124-金库已经离开-configuring-怎么办)。 |

`KYT_VAULT` 与 `KYT_LABEL` 由 `script/deploy.sh --kyt <label>` 从金库记录文件里自动读出，
不需要手工设置。

### 12.3 部署

```bash
# 前提：label 为 cash 的金库已经部署完成（control-panel/deployments-vault-cash.json 存在）
KYT_ORACLE=0x… KYT_ADMIN=0x… ./script/deploy.sh --network bsc-mainnet --kyt cash
```

脚本会：

1. 从 `control-panel/deployments-vault-<label>.json` 读出金库地址；
2. 校验它确实是这套平台 `StateManager` 注册过的金库，且**当前没有装过 gate**（装过就中止，
   避免把一个金库的两个 Gateway 搞混）；
3. 部署 `KYTDepositGateway(vault, oracle, admin, validityPeriod)`；
4. 校验 `gateway.asset() == vault.usdt()`；
5. 金库仍在 `CONFIGURING` 且部署钱包是 Owner 时，直接 `setGate`；否则**不失败**，只打印出
   走 VaultTimelock 所需的 calldata（见 12.4）；
6. 写出 `control-panel/deployments-kyt-<label>.json`，并合并进地址簿——`kytGateways` 数组，
   label 为 cash/note/lp 的另外填进 `CashKYTGateway` 等扁平 key。

每个 Gateway 写自己的一份文件，**不会覆盖已有记录**，与金库记录的做法一致。

### 12.4 金库已经离开 `CONFIGURING` 怎么办

`setGate` 是 `_onlyOwnerDirectOrTimelock`：只有在金库处于 `CONFIGURING` 时 Owner 才能直接调，
之后必须走该金库自己的 `VaultTimelock`（`setGate` 已在 `VaultTimelock.sol:95` 注册为 OWNER 类
动作）。脚本无法代跑「schedule → 等延迟 → execute」这一串，所以它只部署 Gateway 并把 calldata
打出来，这是正常流程，不是失败：

```bash
# 脚本打印的 calldata 形如 0x…（setGate(address) + gateway 地址）
cast send $VAULT_TIMELOCK 'scheduleParamChange(address,bytes)' $VAULT $CALLDATA \
  --rpc-url $RPC --private-key $OWNER_PK
# 等过 delay 之后
cast send $VAULT_TIMELOCK 'executeParamChange(bytes32)' $ID --rpc-url $RPC --private-key $OWNER_PK
```

关闭 KYT 走同一条路径，把 gate 改回 `address(0)`。

### 12.5 部署后验证

```bash
GW=$(jq -r '.kyt.gateway' control-panel/deployments-kyt-cash.json)
V=$(jq -r '.kyt.vault'    control-panel/deployments-kyt-cash.json)

cast call $V  'gate()(address)'            --rpc-url $RPC   # == $GW（未挂 gate 时为 0x0）
cast call $GW 'vault()(address)'           --rpc-url $RPC   # == $V
cast call $GW 'asset()(address)'           --rpc-url $RPC   # == vault.usdt()
cast call $GW 'oracle()(address)'          --rpc-url $RPC   # == $KYT_ORACLE
cast call $GW 'admin()(address)'           --rpc-url $RPC   # == $KYT_ADMIN（必须是多签，不是部署钱包）
cast call $GW 'validityPeriod()(uint64)'   --rpc-url $RPC

# isAllowed 在执行上下文之外必须恒为 false —— 它不是地址白名单
cast call $GW 'isAllowed(address)(bool)' $ANY_ADDRESS --rpc-url $RPC   # false

# 没挂 KYT 的金库必须不受影响
cast call $NOTE_VAULT 'gate()(address)' --rpc-url $RPC   # 0x0
```

### 12.6 启用后的运营准备

挂上 gate **之后**、通知用户申购**之前**：

- [ ] 每个 owner 已执行 `vault.setOperator(gateway, true)`；payer 已把代币授权给 **Gateway**
      （不是 Vault）。这两步用户自己做，脚本不代劳。
- [ ] 采用 PR45 配套的机器人和完整运行入口，安装 Node.js 24+，按锁文件安装依赖并完成类型检查、构建和测试。
- [ ] 在受控环境变量中配置 `RPC_URL`（HTTPS）、`WSS_URL`、`KYT_CHAIN_ID`（56/97/143）、
      `KYT_GATEWAY`、`KYT_VAULT`、`KYT_ASSET`、`KYT_ORACLE_PK`、`CHAINALYSIS_API_KEY` 和 `KYT_RPC_RPS`。
      私钥不放在命令参数或仓库中；使用 `offchain/.env.kyt.example` 核对配置项，不填入真实凭证后提交。
- [ ] gate 接线完成后启动入口：
      ```bash
      cd offchain
      node --import tsx scripts/runKytScreening.ts
      ```
      核对 connected/ready 日志及网络、Gateway/Vault/asset/gate/oracle；启动成功后仍需以受控样本验证真实 API。
      已移除 `--pk`、`--poll`、`--from-block`、`--once` 等旧参数。
- [ ] 使用 WSS 新事件订阅、并发筛查及完成顺序发送。API 默认 30 RPS（当前配额上限 40）；
      `KYT_RPC_RPS` 是本实例 HTTP RPC 预算，不表示独立端点。QuickNode 账户额度在所有端点间共享。
- [ ] 明确运行边界：不建数据库、不补扫、不按编号去重、不在每笔处理前 getRequest 预读；
      API 瞬时故障最多额外 GET 一次，非 COMPLETE/无效结果直接结束；fulfill 不重发。
      `KYT_BLOCK_RISK` 默认 Severe,High，改配置后需正常停止再启动。
- [ ] AWS 单实例、独占 oracle；采用 `Restart=no`，不自动开机拉起。
      WSS 由进程重连；submission-uncertain 或崩溃后先核对未决哈希和 nonce，再人工启动。
- [ ] 完成真实 API、链上资金路径、日志告警与 100 笔/秒短时突发验收。
      默认第 50 秒停止启动新广播，第 60 秒是确认目标；不改变链上有效期，也不能撤回已广播交易。
      完整操作和 systemd 模板见 [两个脚本说明与 AWS 部署方案](./kyt-offchain-scripts-and-aws-deployment.md)。
- [ ] 预言机钱包有足够 gas。**筛查通过的每一笔申购都由预言机出 gas**，钱包空了等于全部申购停摆。
- [ ] 前端已按 `vault.gate()` 切换申购入口。
- [ ] 已向客户书面确认 `docs/kyt-deposit-gateway.md` §8 的约束，其中两条最容易被误解：
      **筛查只覆盖申购路径**（赎回/领取/退款/份额转账都不筛查，被拒地址仍可经份额转账或
      `claimDeposit` 的任意 `receiver` 取得份额）；**退款付给 owner 而不是 payer**。

### 12.7 换代时

Gateway 绑死一个金库。换代之后金库全是新的，新金库的 `gate` 默认为 `address(0)`，需要重新跑
一次本节。清理旧记录与[第 10 节](#10-升级与换代)同理：

```bash
rm -f control-panel/deployments-kyt-*.json
```

---

### 12.8 SDK、ABI 与控制面板同步

运行 `./control-panel/build-abis.sh` 更新 `abis.json` 和 `abis.js`，再运行 `./control-panel/bundle.sh` 更新已提交的 `standalone.html`。普通目录托管还需同时发布 `kyt.js`。钱包网络必须与该实例的 `config.js` 一致，仓库中的测试网地址簿不能当作主网地址簿。

SDK 与控制面板均按实时 `Vault.gate()` 判断申购入口，非零 Gate 需通过 Gateway 接口和金库/代币绑定检查，不需要预登记启用 KYT 的产品名单。控制面板的连接/关闭按钮在 CONFIGURING 由 Owner 直接执行，其他状态自动提交该金库 Timelock；排队编号来自实际回执，等待后需另行执行。关闭 Gate 不取消旧申请。

本次配套更新无需修改或重新部署已有合约，也不会自动修改客户网站。详细接口、面板操作、发布与测试命令见 [KYT SDK 与控制面板接入](./kyt-sdk-panel.md)。

## 13. 延伸阅读

| 文档 | 内容 |
|---|---|
| [`docs/kyt-deposit-gateway.md`](./kyt-deposit-gateway.md) | KYT 申购筛查模块：设计、接口、监听脚本与已知约束（见[第 12 节](#12-可选模块kyt-申购筛查)） |
| [`docs/kyt-offchain-scripts-and-aws-deployment.md`](./kyt-offchain-scripts-and-aws-deployment.md) | KYT 两个脚本、完整配置、AWS/systemd 部署、故障处理及容量验收 |
| [`docs/offchain-operations-runbook.md`](./offchain-operations-runbook.md) | 链下运营手册：KeeperBot 与 SettlementOperator 的部署与运行 |
| [`docs/settlement-operator-runbook.md`](./settlement-operator-runbook.md) | 结算操作要点与批次编排规则 |
| [`docs/offchain-indexer-guide.md`](./offchain-indexer-guide.md) | `OnChainEventIndexer` 使用指南 |
| [`docs/function-reference.md`](./function-reference.md) | 全部已交付合约的逐函数说明 |
| [`docs/development-plan.md`](./development-plan.md) | 完整技术方案、模块划分与变更历史 |
| [`control-panel/README.md`](../control-panel/README.md) | 控制台使用与托管方式 |
| [`offchain/README.md`](../offchain/README.md) | 链下 TypeScript 层结构与本地开发网 |
| `docs/deployment-bsctestnet-*.md` | 历次测试网部署记录（时点快照，含实际 gas、区块与交易哈希） |
