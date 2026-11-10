# BNB Testnet 角色分配表（chainId 97）

本文件記錄客戶聯調用的 15 個測試錢包及其角色分配。

**這是建議版本，客戶可自行覆蓋。** 角色與 index 的對應定義在
`offchain/scripts/testnet/wallets.ts` 的 `ROLE_INDEX`；要更動請同時改該檔案，
並重新執行 `fundWallets.ts`（冪等，重跑安全）。

## 助記詞與地址

15 個錢包全部由**同一組 testnet 專用 BIP-39 助記詞**依 `m/44'/60'/0'/0/${index}` 派生。

助記詞**不在 repo 內**，也不會進 git。取得方式：

```bash
cd offchain
npx tsx scripts/testnet/generateMnemonic.ts   # 產生新助記詞並印出 15 個地址
```

把印出的助記詞存進 repo 根目錄的 `.env.testnet`（該檔已被 `.gitignore` 忽略），
格式參考 `offchain/scripts/testnet/.env.testnet.example`。

下表的「地址」欄位刻意留白——地址完全取決於助記詞，
每個環境自行填入 `generateMnemonic.ts` 印出的結果。

## 角色表

| index | 角色 | 地址 | 職責 |
|---|---|---|---|
| 0 | `governor` | | 協議治理者／部署者，持有各 Vault 的 Owner 權限，負責授予全域角色 |
| 1 | `curator` | | Vault-local Curator，設定產品參數與 adapter 綁定 |
| 2 | `guardian` | | Vault-local Guardian，緊急情況下暫停 Vault |
| 3 | `allocator` | | Vault-local Allocator，在 Vault 與 adapter 之間調度資金 |
| 4 | `keeper` | | KeeperBot 執行者，推進 epoch 輪轉與 Queue 處理 |
| 5 | `dataProvider` | | 兼任兩個職務：① 各 Adapter 的 Data Provider（`IAdapter.setDataProvider`，供給 deal data，由 `BaseAdapter.sol:82` 的 `NotDataProvider` 把關）；② 各資產的 PoR 提交者（`PoRRegistry.setProofPublisher`）。兩者是**不同的合約角色**，只是這裡共用同一個錢包 |
| 6 | `tokenAgent` | | 各資產的 Token Agent，經 MintBurnController 執行 mint／burn |
| 7 | `navSigner` | | 簽署 NAV 更新資料，供 NAVOracle 驗證採用 |
| 8 | `settlementOperator1` | | Settlement 多簽成員之一 |
| 9 | `settlementOperator2` | | Settlement 多簽成員之一 |
| 10 | `settlementOperator3` | | Settlement 多簽成員之一 |
| 11 | `settlementOperator4` | | Settlement 多簽成員之一 |
| 12 | `settlementOperator5` | | Settlement 多簽成員之一 |
| 13 | `investor1` | | 一般投資人，測試申購／贖回流程 |
| 14 | `investor2` | | 第二位投資人，測試多投資人與部分結算（partial settlement）情境 |

合計 8 + 5 + 2 = **15** 個錢包。

## Settlement 多簽：3-of-5

以下 5 個為 Settlement operator，門檻為 **3-of-5**（任意 3 位簽署即可執行結算）：

- index 8 — `settlementOperator1`
- index 9 — `settlementOperator2`
- index 10 — `settlementOperator3`
- index 11 — `settlementOperator4`
- index 12 — `settlementOperator5`

程式中可直接引用 `wallets.ts` 匯出的 `SETTLEMENT_OPERATORS` 與 `SETTLEMENT_THRESHOLD`。

## 灌錢

```bash
cd offchain
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts --dry-run  # 先看計畫，不送交易
npx tsx --env-file=../.env.testnet scripts/testnet/fundWallets.ts           # 實際送出
```

預設每個錢包 0.002 testnet BNB（gas 用）＋ 100000 MockUSDT（6 decimals）。
可用 `FUND_BNB_AMOUNT` / `FUND_USDT_AMOUNT` 覆寫。
交易嚴格循序送出（避免同一 from 位址的 nonce 衝突），且會先查餘額、已足額者跳過。

資金錢包的私鑰由 `.env.testnet` 的 `TEST_PK` 提供，需先從
[BNB Testnet faucet](https://testnet.bnbchain.org/faucet-smart) 取得 BNB。

## 安全提醒

這 15 個錢包僅用於 BNB Testnet 聯調，只持有測試幣。
**助記詞絕不可重複用於主網，也絕不可提交進 git。**
