> **⚠️ 本文件已作廢（superseded）。**
> 本紀錄的 chainId 97 地址（commit `4501efa` 那一代）已被 2026-08-17 稍晚的重新部署取代。
> 最新地址請看 **[`deployment-bsctestnet-2026-08-17-v2.md`](./deployment-bsctestnet-2026-08-17-v2.md)**（commit `af3d3db`）。
> 下面所有地址請勿再使用；保留本文件僅供對照與稽核。

# BNB Smart Chain Testnet 全新部署紀錄（2026-08-17）

- **Chain**：BNB Smart Chain Testnet，chainId `97`
- **RPC**：`https://data-seed-prebsc-1-s1.binance.org:8545`
- **部署錢包**：`0x425beB70d264362E4eb7953C4f7aFBDe01145538`（Governor + 三個 Vault 的 Owner）
- **原始碼 commit**：`4501efa`
- **腳本**：`script/Deploy.s.sol`，依序執行 `Deploy` → `DeployW3` → `DeployW4`，全部帶 `--legacy --slow`
- **gas price**：0.1 gwei（全程 legacy 交易）

## 為什麼是整代重新部署

`BaseVault` / `BaseAdapter` 改動後，immutable 綁定形成連鎖：Vault bytecode 變 → 兩個 Deployer 變 →
`VaultFactory`（deployer 位址 immutable）→ `StateManager`（`setVaultFactory` 一次性）→ `Queue`（`sm` immutable）
→ `Settlement`（`sm`/`unifiedPool`/`queue` 全 immutable）；`BaseAdapter` 變則帶動 `AdapterFactory`。
部分替換做不到，故整代重來。**舊的 chainId 97 地址（`0x46788c9f…` 那一代）全部作廢。**

## 腳本改動

`script/Deploy.s.sol`：把新增的 `AdapterRegistryFactory` 加進 `DeployW3`。

理由：它屬於 Vault 層，跟 `VaultFactory` 同一階段最合理；`DeployW3` 原本就是直接
`new AdapterRegistry(governor)` 的地方。改成先部署 `AdapterRegistryFactory`，再用
`factory.deployRegistry(governor)` 產出共用的 `AdapterRegistry`——這樣工廠在鏈上被實際跑過一次，
且共用 registry 的 `isRegistry[...] == true`，SDK 之後可以直接用同一個工廠替各 Vault Owner 開自己的 registry。
輸出多加 `AdapterRegistryFactory` 一個 key（`control-panel/deployments-w3.json`）。

除此之外沒有改動腳本邏輯；三個階段都是一次跑成功，沒有遇到腳本 bug。

---

## 完整地址表

### 前端 `deployments.js` 可直接貼入的區塊

```js
export const DEPLOYMENTS = Object.freeze({
  97: Object.freeze({
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    explorerUrl: 'https://testnet.bscscan.com',
    profile: 'target',
    sourceCommit: '4501efa',
    addresses: Object.freeze({
      hyperAccessControl: '0x9A0e75908ab9c8c76e8497F19Fe0997a430c23ca',
      stateManager: '0x8B480aE2d824bBb2b27aa044fC560AcAb681bcC8',
      navOracle: '0xC48641Bc70FC41E224DeC2B38aEAA71ae921f401',
      mintBurnController: '0xEFE765568c374C691c4fF41D68eaE4cCb76889A7',
      assetRegistry: '0xe37A7e451069eD47A9ba0dC54071bA5cB98c6220',
      protocolFeeConfig: '0x1950b8b9d060A3f6c880FB1d3c7E6af80606F5c0',
      reservePSM: '0xf80744860eE6DDd5427a8A211451B824e8AB4c1E',
      poRRegistry: '0x51F579A8819E85F0c75c7BFDE687c6ad5A69dE89',
      queue: '0x3D9A55C524b4833cF345e8d23e5E2abCD2C599f0',
      revenuePool: '0xB8E15d8415D81b25a2c3fACE5420E3B35b7E4989',
      unifiedPool: '0x46900C8D93DBB01517e55D7C7Cb12B668bF5Fa93',
      settlement: '0xcD3F2Ad12cB9DAcC3A1c597886dbB21dF914258B',
      vaultFactory: '0x459f5583838d93d4a8128dCA51AE48Be214817B3',
      adapterFactory: '0xa9FaA8f28c42A61719e0776b581ECa728B64f664',
      adapterRegistryFactory: '0x472F9b9FAEA48b5a86666807f42D164AF93b6642',
      adapterRegistry: '0x5de92B119F3809A98Ea4b6f7B7eDd38DA375a200',
      liquidityBridge: '0xd3da3bC9b4aA01cBaF60CD4113d7EFc36f86047D',
      mockUsdt: '0x3Baed3ec73197c7FD1B3b4Fc4db0649349C6414e',
      cashVault: '0xD099668cAB6BA6F11eaf6b0Ae6FbC84093Aa68C8',
      noteVault: '0x027e374055010A15811e85c424903974A20388FE',
      lpVault: '0xa9F9F30f2943212d8E471B450cD045F2eB37A142',
      cashAdapter: '0x2905E3bE4427eF95F28A627273162D52111B4faa',
      noteAdapter: '0x33279512B8f5821F75591b913d2E08DeCDc3c7C0',
      lpAdapter: '0xDBf5519F7aA37B88e0ba4e7BEC6422AD97e5f5b4',
    }),
  }),
});
```

`adapterRegistryFactory` 是這一代新增的 key，舊前端沒有；其餘 key 名稱與原本 `deployments.js` 一致。

### 全部地址 + bytecode 位元組數

逐一以 `cast code <addr> --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545` 取回並計算長度，
全部非空（38/38）。

| 階段 | 合約 | 地址 | bytecode |
|---|---|---|---|
| Deploy (W1/W2) | HyperAccessControl | `0x9A0e75908ab9c8c76e8497F19Fe0997a430c23ca` | 1109 bytes |
| Deploy | StubStateManager | `0x4cd66d009fA4Ff2528a7b2232C3d949fdE595D4A` | 3201 bytes |
| Deploy | MockUSDT | `0x3Baed3ec73197c7FD1B3b4Fc4db0649349C6414e` | 1720 bytes |
| Deploy | RevenuePool | `0xB8E15d8415D81b25a2c3fACE5420E3B35b7E4989` | 2797 bytes |
| Deploy | ProtocolFeeConfig | `0x1950b8b9d060A3f6c880FB1d3c7E6af80606F5c0` | 1827 bytes |
| Deploy | AssetRegistry | `0xe37A7e451069eD47A9ba0dC54071bA5cB98c6220` | 9485 bytes |
| Deploy | MintBurnController | `0xEFE765568c374C691c4fF41D68eaE4cCb76889A7` | 3427 bytes |
| Deploy | NAVOracle（W2 那顆，前端不用） | `0x6a958e5Ab6B0eCca8a63f771bf69AA91CC8C7f94` | 3983 bytes |
| Deploy | PoRRegistry | `0x51F579A8819E85F0c75c7BFDE687c6ad5A69dE89` | 2985 bytes |
| Deploy | SToken / RWAToken（demo 資產 1） | `0x862DeBcA4F1A8f293157621B8F37988BeEDF51dB` | 4548 bytes |
| Deploy | JToken（demo 資產 2） | `0xB7f05793Ef0fc0d284f8D04907D1D3A5615b58E3` | 4548 bytes |
| Deploy | UnifiedPool implementation | `0x2224c117D5A307231D77D7A1962985dA9fA53cD8` | 8451 bytes |
| Deploy | **UnifiedPool（ERC1967 proxy，用這個）** | `0x46900C8D93DBB01517e55D7C7Cb12B668bF5Fa93` | 163 bytes |
| Deploy | Queue（W2 那顆，綁 StubStateManager，前端不用） | `0x96C6cf3Fe7eF23e64ccc434cD458a6BD4AC88732` | 4178 bytes |
| Deploy | ReservePSM | `0xf80744860eE6DDd5427a8A211451B824e8AB4c1E` | 10577 bytes |
| Deploy | AdapterFactory（W2 demo 用，前端不用） | `0x892bd61707F34051e3CCA74448221d5184D9CB72` | 1366 bytes |
| Deploy | RWAAdapter（W2 demo） | `0x0C9686755f1cbF848fADDa0DBA093f04140091Cc` | 12934 bytes |
| DeployW3 | **StateManager** | `0x8B480aE2d824bBb2b27aa044fC560AcAb681bcC8` | 12693 bytes |
| DeployW3 | ClaimRegistry | `0x26CaA7b3F6D6600769f1665a17F52D3F96643058` | 1946 bytes |
| DeployW3 | **NAVOracle** | `0xC48641Bc70FC41E224DeC2B38aEAA71ae921f401` | 3983 bytes |
| DeployW3 | **Queue** | `0x3D9A55C524b4833cF345e8d23e5E2abCD2C599f0` | 4178 bytes |
| DeployW3 | LiquidityBridge | `0xd3da3bC9b4aA01cBaF60CD4113d7EFc36f86047D` | 1291 bytes |
| DeployW3 | EarnVaultDeployer | `0x6196a81A32c0B72c2A3E6bf69991BDa14a21eE95` | 23971 bytes |
| DeployW3 | LiquidityEarnVaultDeployer | `0xba980EFdE9cC5bece13f7703581598Bd66222257` | 22654 bytes |
| DeployW3 | VaultFactory | `0x459f5583838d93d4a8128dCA51AE48Be214817B3` | 9373 bytes |
| DeployW3 | **AdapterRegistryFactory（新增）** | `0x472F9b9FAEA48b5a86666807f42D164AF93b6642` | 1383 bytes |
| DeployW3 | AdapterRegistry（共用，由工廠產出） | `0x5de92B119F3809A98Ea4b6f7B7eDd38DA375a200` | 777 bytes |
| DeployW3 | CashVault (EarnVault, htCASH) | `0xD099668cAB6BA6F11eaf6b0Ae6FbC84093Aa68C8` | 22139 bytes |
| DeployW3 | NoteVault (EarnVault, htNOTE) | `0x027e374055010A15811e85c424903974A20388FE` | 22139 bytes |
| DeployW3 | LPVault (LiquidityEarnVault, htLP) | `0xa9F9F30f2943212d8E471B450cD045F2eB37A142` | 20675 bytes |
| DeployW3 | CashVaultTimelock | `0xfb2281470a7880B8b23645232D01bA5e222c5253` | 5045 bytes |
| DeployW3 | NoteVaultTimelock | `0x1bb4D78fDd80034fbeFf941561d66038C255C7F3` | 5045 bytes |
| DeployW3 | LPVaultTimelock | `0x8dE5E2CFfe0cD09671B056cDCC82505b89F36Ead` | 5045 bytes |
| DeployW4 | Settlement | `0xcD3F2Ad12cB9DAcC3A1c597886dbB21dF914258B` | 8401 bytes |
| DeployW4 | AdapterFactory | `0xa9FaA8f28c42A61719e0776b581ECa728B64f664` | 1366 bytes |
| DeployW4 | CashAdapter (FirstPeriodAdapter) | `0x2905E3bE4427eF95F28A627273162D52111B4faa` | 11727 bytes |
| DeployW4 | NoteAdapter (FirstPeriodAdapter) | `0x33279512B8f5821F75591b913d2E08DeCDc3c7C0` | 11727 bytes |
| DeployW4 | LPAdapter (LiquidityAdapter) | `0xDBf5519F7aA37B88e0ba4e7BEC6422AD97e5f5b4` | 13577 bytes |

`UnifiedPool` proxy 只有 163 bytes 是正常的——ERC1967Proxy 本體就這麼小，實作在
`0x2224c117…`。前端／SDK 一律用 proxy 位址。

---

## 部署交易 hash

### 階段一：`Deploy`（21 筆，全部 status 0x1，合計 28,342,567 gas）

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | HyperAccessControl | 374,859 | `0x2673a37d47f03d63e7b93cc2f3a2d0c2a654b82d4efb78b35b38ba2cecefc5b0` |
| 2 | CREATE | StubStateManager | 747,549 | `0xee540ae541191eccc4a4e35ca74df6d2e35810f2d6540f563272078d38f8faf6` |
| 3 | CREATE | MockUSDT | 499,340 | `0x13343d8467da6d9dd1d1fa1ab56444694e246db68e874cb11c9d83c5a964cd67` |
| 4 | CREATE | RevenuePool | 660,471 | `0x694cf9995e1fe14310e5db1bc29bfc158b0d26a55c72901acbceba19efbb5e68` |
| 5 | CREATE | ProtocolFeeConfig | 474,112 | `0x41e1fe73b0dd5413baec3d70cc1ef577021e83018b32e40df117297e542b80e8` |
| 6 | CREATE | AssetRegistry | 2,897,234 | `0xe523738b9ab4bb4ec4cdbeb58a364a66faccc319cc48c24c5f56d34ad9f48705` |
| 7 | CREATE | NAVOracle (W2) | 975,498 | `0x08b5a27358ecf24c979b44cf3d3c36eae77cc0e58c02b0ea6d854b0c139e3945` |
| 8 | CREATE | PoRRegistry | 700,424 | `0xb0eb265b183c8fcbd71360095b463915dc2a478e628458ec366ff48cc8605ef0` |
| 9 | CALL | AssetRegistry.registerAsset (S) | 1,145,608 | `0x4635e41410840c10b6c6e28b62320f1d7637405ffecce347e39d875ecf105385` |
| 10 | CALL | AssetRegistry.registerAsset (J) | 1,145,620 | `0x8c204c598cf1a96b0fb5b877ddb0c1d0e3c1549428d9a18dd55d2cf620a38f27` |
| 11 | CREATE | UnifiedPool impl | 1,906,839 | `0x48d9e0ca0ac4c1926c2c7db28b8e6a9fd0fd9013a331860899cfc0606f106531` |
| 12 | CREATE | ERC1967Proxy (UnifiedPool) | 244,658 | `0x806450bed73036faab0d149532e0e9434e0474c115debe1875f4c7ee7e26d30a` |
| 13 | CREATE | Queue (W2) | 958,950 | `0x6d262e5e855ed53dee6576ecfbfc472401f6bfc50155124d5d8b9409856396bf` |
| 14 | CREATE | ReservePSM | 2,336,141 | `0xdbce6166a2b3897b714b4f930e65b82db382f04195d3f9d3a786e33a3c6341a4` |
| 15 | CALL | RevenuePool.addAuthorizedSource | 51,702 | `0x196760047926d03beb0b0f050b7157f037f9c3ef4f8f0f78b835722af902fec3` |
| 16 | CALL | ReservePSM.deployWrappedToken | 568,290 | `0xab85fd837dd96bbeb501d2e3d6e45e83bf5e4d8dc70bf4ca91b001ff0c3a3cb6` |
| 17 | CREATE | AdapterFactory (W2) | 9,751,394 | `0xdeb1cf39447727381df88e3e5494efddd8e9ecfd19faaaafad86485d646ab48a` |
| 18 | CALL | AdapterFactory.deployRWAAdapter | 2,752,579 | `0xa402119fa62e42eae186c0734650705bf00722deda0ac69d31db507e1393b2bd` |
| 19 | CALL | MintBurnController.setTokenAgent(1) | 51,524 | `0x7a917ff4a112f02150a7e5cece172e6ab0fd09e7405d5ddf757e28c38d662a5a` |
| 20 | CALL | MintBurnController.setTokenAgent(2) | 51,524 | `0x994b4dc33fc45cedc988cdf64c9b3c928fa88d9768512bdba9b86e5224d0a6fd` |
| 21 | CALL | NAVOracle.setSigner | 48,251 | `0xfa932b06729d7923170a7e082266d389971ef058312f1f71328bfe944bb0c095` |

### 階段二：`DeployW3`（23 筆，全部 status 0x1，合計 37,366,225 gas）

環境變數：`HYPER_ACCESS_CONTROL=0x9A0e7590…`、`UNIFIED_POOL=0x46900C8D…`（proxy）、
`USDT=0x3Baed3ec…`、`PROTOCOL_FEE_CONFIG=0x1950b8b9…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | StateManager | 2,826,928 | `0x3e4e95d015165d30b3ca161996a0ccd06bc3ca6331760990cea520df7124a83e` |
| 2 | CREATE | ClaimRegistry | 476,236 | `0x627023781adb1131a36e5c3f660c21d63f713e229f52348d9aa1c7f278e61f89` |
| 3 | CREATE | NAVOracle | 975,498 | `0x7de90529ed280c49a5a1abc0dbc29c45480aea6dd5e5d9082f80e2baff8c1399` |
| 4 | CREATE | Queue | 958,962 | `0x58abf3785715bc1cf40e6a68b9c3bd6e48185770ae854082fb59f3b8cfb3e712` |
| 5 | CREATE | LiquidityBridge | 357,550 | `0x782ef2add79d204c1fcf1b9c4b7e21f2977b770c85859a07155d811a883d1460` |
| 6 | CREATE | EarnVaultDeployer | 5,236,571 | `0x712fdbaa1f59cfcfeebd20d2dbf4a3d3d360d349a99f36bb6234a312e072fb6e` |
| 7 | CREATE | LiquidityEarnVaultDeployer | 4,951,562 | `0x46d52754b199fbe7848bb0a0b6db2be84197dd6a43f2c3a2823a5d7446f7a6f8` |
| 8 | CREATE | VaultFactory | 2,101,263 | `0x52d071dc01cc312fd06c291f9383c1d3f6e9d117efc2871739d573537d51d165` |
| 9 | CREATE | **AdapterRegistryFactory** | 352,058 | `0x3b441ea7e8e32bcf746a7911e6bba8678e5b7588cdebc52e9238a1ddc44d0d2f` |
| 10 | CALL | AdapterRegistryFactory.deployRegistry | 256,209 | `0xbb520d22d2c122dd075d62aee59c443b94b11ff750e36b6164f286b247ae3b74` |
| 11 | CALL | StateManager.setVaultFactory | 51,862 | `0xc673451724f58cb5f6581708bec154bb8340d5fc47b045b9ad1b651731568e69` |
| 12 | CALL | VaultFactory.deployVault (Cash) | 6,112,547 | `0x75fbc8fe9411e03ef4e4547548660ec87323f4062d4780bd577b14b668136e2e` |
| 13 | CALL | VaultFactory.deployVault (Note) | 6,092,407 | `0x994f355de7b0a8e423847dd6b2bf3daa8d2d6043524f7ae08bdd9f96f04fcf1d` |
| 14 | CALL | VaultFactory.deployVault (LP) | 5,842,044 | `0x63c6fef46385cd337a3775983dfaf35b11680c318e25803d2602ff78de0778ea` |
| 15 | CALL | CashVault.setKeeper | 48,585 | `0x829f32ac6f80e106f3fd7af6672c02c22da424418dd72dfe82a73c05a4f99f5d` |
| 16 | CALL | CashVault.setCurator | 48,348 | `0xd35e9ffd66a3de5a42ce7f79ede9f07f90db23290252f56a006b3a5c3de0571a` |
| 17 | CALL | NoteVault.setKeeper | 48,585 | `0xe648275a7dd72fabe5ee5c4a47f7fc7ef78d76453d9d935af6490591cf8beb89` |
| 18 | CALL | NoteVault.setCurator | 48,348 | `0x20cb4c444db09469ce7ca6f233c8ad65fe65ee0df409c000838c863837878efc` |
| 19 | CALL | LPVault.setKeeper | 48,585 | `0x2b351382f661aaf2d10eef80d795ea3d5a903ae0aaedb09a2faf843082320679` |
| 20 | CALL | LPVault.setCurator | 48,348 | `0x4fe8e062ebe6f859cb0655d8f9232d20d7569099d58bd6f9bb03f7277842be3d` |
| 21 | CALL | UnifiedPool.addTrancheVault (Cash) | 147,983 | `0x3a572c222fccd0056ce1c40985f78184bd79c9a6c69541d15825aeb7e81f7051` |
| 22 | CALL | UnifiedPool.addTrancheVault (Note) | 167,895 | `0x92bb14e07aabdb5f56b138ef1f2c8c92242648863e1e8a93b2908153c66f4577` |
| 23 | CALL | UnifiedPool.addTrancheVault (LP) | 167,851 | `0x0fdab8ea5ea02c4f7836ee647a214bc9c32e71329417b0a85a1b9fb7fce3983c` |

### 階段三：`DeployW4`（26 筆，全部 status 0x1，合計 21,012,276 gas）

環境變數另加：`STATE_MANAGER`、`QUEUE`、`NAV_ORACLE`、`CASH_VAULT`、`NOTE_VAULT`、`LP_VAULT`，
以及 `SETTLEMENT_OPERATORS=0x425beB70…`、`SETTLEMENT_THRESHOLD=1`、
`DATA_PROVIDER_SIGNER=0x425beB70…`

| # | 類型 | 目標 | gas | tx hash |
|---|---|---|---|---|
| 1 | CREATE | Settlement | 1,871,860 | `0x948044cb9058c62efeffc758dfb994522cf12afcdc408f8519638a2b77a17c59` |
| 2 | CALL | CashVault.setSettlement | 56,657 | `0x6c357dd0753160c7ace4c07446a73b848558d28784b000d9c3dbaca36eda5b85` |
| 3 | CALL | NoteVault.setSettlement | 56,657 | `0x08af07e9cecb3b0776ded3b884b5e09bdf76b522c2397a50089320b7ab8c5608` |
| 4 | CALL | LPVault.setSettlement | 56,613 | `0xacb3d57ae9b893596c11d2abed72a25811d2cb63f52ca8f6289c81fc0e626422` |
| 5 | CALL | Settlement.setOperator (Cash) | 97,021 | `0xcf4d6c6b9e899a87e52158e746dc5f60d65df8f01e78292279802ba38d23e2a4` |
| 6 | CALL | Settlement.setThreshold (Cash) | 53,924 | `0x438cee28861a292c1f05c91c87f1b05eb1bb5adbf2d3d4bde87ebe5dd977f28d` |
| 7 | CALL | Settlement.setOperator (Note) | 97,021 | `0x3e5f38ffbf65f162da1cea79503e31fa640d12f861793080639d12bee96c899d` |
| 8 | CALL | Settlement.setThreshold (Note) | 53,924 | `0x6439bb8b8e155490262f891e60effcc52454e5732d0d95cde59d3e7ce2a715f6` |
| 9 | CALL | Settlement.setOperator (LP) | 96,977 | `0x14d21d159707a05276bf749ba3ffc235f155b7f30abfffcc465c4a850cef4d5e` |
| 10 | CALL | Settlement.setThreshold (LP) | 53,880 | `0x03ef6fb6cde9c325b02959ad8b326fa534a1ee357a04a03afb16809260865612` |
| 11 | CREATE | AdapterFactory | 9,751,394 | `0xdd2ba80e765367fc07f0f584c8df11e9a0638bf8e3d5e2db124220ee9c12604c` |
| 12 | CALL | AdapterFactory.deployAdapter (Cash) | 2,508,193 | `0xcba35083fe5de92717615560c651688f7822554bb88c85f5a59702687a959bcf` |
| 13 | CALL | AdapterFactory.deployAdapter (Note) | 2,508,193 | `0x7fa59121b92c272f48fe2275283de1e9dfe6cbc0762341b99576065e6d4adfd8` |
| 14 | CALL | AdapterFactory.deployLiquidityAdapter (LP) | 2,879,298 | `0xc9efa6722ebd4ee12efed78b1f3c6d5795087788dc7ec8d0d0778d35abdacbed` |
| 15 | CALL | AdapterRegistry.setAdapterAllowed (Cash) | 48,082 | `0x884e20169ed27ce8cfe2a19938b70e573cf7b17e59e0b5db29f2afff07ce44ae` |
| 16 | CALL | AdapterRegistry.setAdapterAllowed (Note) | 48,082 | `0x786eb8e00779e00378edb01149ba281eebd84a34481a30727330e7af0af556f3` |
| 17 | CALL | AdapterRegistry.setAdapterAllowed (LP) | 48,082 | `0x0df44b28647cb41fe8cbeb820deb8b96a91cb048adc2ffa9ab27d389616be679` |
| 18 | CALL | LPVault.setAdapter | 143,838 | `0x1dcbba38d77ddac59bbfaa374b028ad81fe1cf931a80a229b38c7e9813ee08fd` |
| 19 | CALL | CashVault.addAdapter | 119,217 | `0xf66049cdfc0d2bc7a84d896b69725ef8801ab452cf121392e9feb8a8f3b6e751` |
| 20 | CALL | NoteVault.addAdapter | 119,217 | `0x501765d13b817ecf98ae0deda573baccb2087cda14094b0b91b6af2574122f78` |
| 21 | CALL | CashVault.setUnifiedPool | 55,324 | `0x63fc979e007c5c0551bf7d978ffd1f1080ff3ca1bffc8a4849831acc8b73b2f8` |
| 22 | CALL | NoteVault.setUnifiedPool | 55,324 | `0x9bf085f351308cc93d2ee459f83c2c11ddff9882a910ed6019a2fd7b83648f53` |
| 23 | CALL | LPVault.setUnifiedPool | 55,280 | `0x390ab50e720c9ebb1a316ee82be86354b3293a224d19fd268dc410036d0a5ae0` |
| 24 | CALL | CashAdapter.setDataProvider | 59,421 | `0xc4c1a461316240c7b6a011ebf520a7835bddbe342634b3ad4a665e60e6465953` |
| 25 | CALL | NoteAdapter.setDataProvider | 59,421 | `0xfc57bc47dae42534a2beffe9973e9de6826d25e7357012195fc470c0de789a3d` |
| 26 | CALL | LPAdapter.setDataProvider | 59,376 | `0xe81bc0dd1295cda70ea72fb85a4ccedbb6ec1a837e5b6b8b85d55f41ccf77b84` |

### 階段四：部署後手動配置（7 筆 `cast send`，全部 status 1，合計 342,631 gas）

| 動作 | gas | tx hash |
|---|---|---|
| `ProtocolFeeConfig.setPaymentToken(Stable=2, MockUSDT)` | 52,313 | `0xc6b708d5b81de6d1d1e42c987852ccc5ce852b7e9fd995d663c9f63ad4ff4816` |
| `CashVault.setGuardian(deployer)` | 48,372 | `0x68505a1f3ea3f3c858d2e9b9c7de9b62996bd0f1127fbceb08a483cce2a683e0` |
| `NoteVault.setGuardian(deployer)` | 48,372 | `0xafadc28e3859e508061287c2d86ed5eab1f21e5e643dfa4e58486be14b5650de` |
| `LPVault.setGuardian(deployer)` | 48,438 | `0x4a96e2620eb6255807b0a1fea2875a93fb1bab7621ca2c65b1f67414d22ed8de` |
| `CashVault.setAllocator(deployer)` | 48,349 | `0x0fad1f35b588f41eebd1551458a67aef304bd27d25b70ca6919a1d95a10e91be` |
| `NoteVault.setAllocator(deployer)` | 48,349 | `0xa2755f05f7b545b49757a8a13b5b52311f97aeaab6f6a9d3ca6cb301463744ed` |
| `LPVault.setAllocator(deployer)` | 48,438 | `0x42175f8262fef4b1a21ae10a7f82b1bd5e76d8c85efe6bbf6371bcf9f3a41cca` |

---

## Gas 與餘額

| 項目 | gas | BNB @ 0.1 gwei |
|---|---|---|
| 階段一 `Deploy` | 28,342,567 | 0.0028342567 |
| 階段二 `DeployW3` | 37,366,225 | 0.0037366225 |
| 階段三 `DeployW4` | 21,012,276 | 0.0021012276 |
| 階段四 部署後配置 | 342,631 | 0.0000342631 |
| **合計** | **87,063,699** | **0.0087063699** |

- 部署前餘額：`0.226287364560000000` BNB
- 部署後餘額：`0.217580994660000000` BNB
- 實際扣除：`0.008706369900000000` BNB（與上表加總完全吻合）
- 部署錢包 nonce：398

---

## 驗證結果

### bytecode

38 個地址逐一 `cast code`，**全部非空**，位元組數見上表。

### 關鍵 selector

以 `cast code <addr> | grep <selector>` 確認 selector 出現在部署後的 runtime bytecode 裡：

| 檢查項 | selector | 結果 |
|---|---|---|
| `CashVault.fundAdapter(address,uint256)` | `0xe4dc450c` | PRESENT |
| `NoteVault.fundAdapter(address,uint256)` | `0xe4dc450c` | PRESENT |
| `LPVault.fundAdapter(address,uint256)` | `0xe4dc450c` | PRESENT |
| `AdapterRegistryFactory.deployRegistry(address)` | `0x45e7bfa8` | PRESENT |
| `NAVOracle.updateNAV(address,uint256,uint256,bytes)` | `0x305ffd2c` | PRESENT（EIP-1271 改動確實沒動到 selector） |

另外用 `cast call`（eth_call 模擬）跑 `AdapterRegistryFactory.deployRegistry(deployer)`，
回傳 `0x912B7d9c93cDa28e44E109d466785902C6D6A89c`——函數確實可執行。

### 連線狀態抽查（`cast call`）

```
ProtocolFeeConfig.paymentTokenOf(Stable)  = 0x3Baed3ec73197c7FD1B3b4Fc4db0649349C6414e  (MockUSDT)
ProtocolFeeConfig.revenuePool()           = 0xB8E15d8415D81b25a2c3fACE5420E3B35b7E4989
StateManager.vaultFactory()               = 0x459f5583838d93d4a8128dCA51AE48Be214817B3
Queue.sm()                                = 0x8B480aE2d824bBb2b27aa044fC560AcAb681bcC8  (新 StateManager)
Settlement.sm()                           = 0x8B480aE2d824bBb2b27aa044fC560AcAb681bcC8
Settlement.queue()                        = 0x3D9A55C524b4833cF345e8d23e5E2abCD2C599f0  (新 Queue)
AdapterRegistry.registryOwner()           = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
AdapterRegistryFactory.isRegistry(shared) = true
LPVault.adapter()                         = 0xDBf5519F7aA37B88e0ba4e7BEC6422AD97e5f5b4
CashAdapter.dataProvider()                = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
```

三個 Vault 一致：

```
owner      = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
curator    = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
guardian   = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
allocator  = 0x425beB70d264362E4eb7953C4f7aFBDe01145538
isKeeper(deployer) = true
settlement = 0xcD3F2Ad12cB9DAcC3A1c597886dbB21dF914258B
Settlement.threshold(vault)              = 1
Settlement.isOperator(vault, deployer)   = true
```

---

## 角色配置狀態

### 已配置（全部指向部署錢包 `0x425beB70d264362E4eb7953C4f7aFBDe01145538`）

| 角色 | 範圍 | 值 |
|---|---|---|
| Governor | HyperAccessControl | 部署錢包 |
| Issuer | AssetRegistry（demo 資產 1、2 的 owner） | 部署錢包 |
| Token Agent | MintBurnController，資產 1 與 2 | 部署錢包 |
| NAV Signer | NAVOracle（W2 那顆，對 SToken） | 部署錢包 |
| Vault Owner | Cash / Note / LP | 部署錢包 |
| Curator | Cash / Note / LP | 部署錢包 |
| Guardian | Cash / Note / LP | 部署錢包 |
| Allocator | Cash / Note / LP | 部署錢包 |
| Keeper | Cash / Note / LP | 部署錢包 |
| Data Provider | Cash / Note / LP Adapter | 部署錢包 |
| Settlement Operator | Cash / Note / LP，threshold = 1 | 部署錢包（1-of-1） |
| Registry Owner | 共用 AdapterRegistry | 部署錢包 |
| Fee payment token | ProtocolFeeConfig，`Stable`(kind=2) | MockUSDT `0x3Baed3ec…` |

**全部設成部署錢包是刻意的**：客戶的正式角色名單還沒給我們，這一步只是讓環境單錢包可用。
所有這些角色都可由 Owner／Governor 隨時改，改的時候不需要重新部署。

### 尚未配置（等客戶名單）

- **Settlement 3-of-5 多簽**：目前是 1-of-1（threshold=1、operator 只有部署錢包）。
  客戶給 5 個 operator 位址後，以 Vault Owner 身分對每個 Vault 呼叫
  `Settlement.setOperator(vault, op, true)` ×5 再 `Settlement.setThreshold(vault, 3)`。
- **Curator / Guardian / Allocator / Keeper 的正式持有人**：`offchain/scripts/testnet/ROLE_ASSIGNMENT.md`
  裡的 15 錢包分配表只是建議版，尚未套用到這一代合約上。
- **PoRRegistry proof publisher**：本次沒有設定。
- **NAVOracle（W3 那顆 `0xC48641Bc…`）的 signer**：本次沒有設定（只設了 W2 那顆對 SToken 的 signer）。
- **`lpAdapter.setBridgeTarget(liquidityBridge, cashVault)`**：依 `DeployW4` 註解，這屬於 Curator
  的初始參數設定，不是部署步驟，因此腳本與本次都沒有呼叫。

---

## 同步更新的檔案

- `script/Deploy.s.sol` — `DeployW3` 新增 `AdapterRegistryFactory`
- `offchain/scripts/testnet/addresses.bscTestnet.json` — 換成本次新地址，新增 `adapterRegistryFactory`
- `offchain/scripts/testnet/config.ts` — `RawTestnetAddresses` 補上 `adapterRegistryFactory`
- `control-panel/config.js` — 由 `Deploy` 階段自動重寫（只含 W1/W2 那批地址）
