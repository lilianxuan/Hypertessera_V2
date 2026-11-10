import { spawn, type ChildProcess } from "node:child_process";
import { HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet, type TransactionReceipt } from "ethers";

export interface AnvilInstance {
  process: ChildProcess;
  provider: JsonRpcProvider;
  wallets: Wallet[];
  stop: () => void;
}

/**
 * anvil's public deterministic dev mnemonic — the same one `scripts/local/wallets.ts` hardcodes.
 * Deriving the accounts from it is what lets this harness discard anvil's output entirely (stdio
 * "ignore" — /dev/null at the OS level) instead of parsing the printed keys off a pipe. A piped
 * stdout that nobody keeps draining fills up, at which point anvil blocks on write and stops
 * mining, and the deploy hangs waiting for receipts.
 */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const ACCOUNTS = 10;
const RECEIPT_WAIT_MS = 10_000;

/**
 * anvil can answer eth_sendRawTransaction before the automined block is queryable. When ethers'
 * tx.wait() then finds no receipt it falls back to new-block events, and its block poller's first
 * read only records the head: if that read already sees the block holding the transaction, wait()
 * hangs until a later block, which a test that sends nothing more never produces (otherwise it costs
 * one 4 s poll). For a transaction anvil already knows, keep reading until the receipt appears so
 * wait() stays on its direct path — the same rule as scripts/local/transaction.ts.
 */
class AnvilProvider extends JsonRpcProvider {
  override async getTransactionReceipt(hash: string): Promise<null | TransactionReceipt> {
    const deadline = Date.now() + RECEIPT_WAIT_MS;
    for (;;) {
      const receipt = await super.getTransactionReceipt(hash);
      if (receipt || Date.now() > deadline || !(await this.send("eth_getTransactionByHash", [hash]))) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Starts a local anvil node and returns ready-to-use signers for its deterministic dev accounts. */
export async function startAnvil(port = 8552): Promise<AnvilInstance> {
  const proc = spawn("anvil", ["--port", String(port)], { stdio: "ignore" });

  let exited: Error | undefined;
  proc.on("exit", (code) => {
    if (code !== null && code !== 0) exited = new Error(`anvil exited early with code ${code}`);
  });

  // cacheTimeout must be disabled: ethers caches read-only RPC results (incl. getTransactionCount)
  // for 250ms by default, which is longer than an anvil block on this fast local loop and causes
  // stale-nonce ("nonce too low") errors across back-to-back deploy transactions.
  const provider = new AnvilProvider(`http://127.0.0.1:${port}`, undefined, { batchMaxCount: 1, cacheTimeout: -1 });

  // Readiness by RPC probe rather than by matching a startup banner on stdout.
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (exited) throw exited;
    try {
      await provider.getBlockNumber();
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("anvil did not start within 15s");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const mnemonic = Mnemonic.fromPhrase(ANVIL_MNEMONIC);
  const wallets = Array.from(
    { length: ACCOUNTS },
    (_, i) => HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${i}`).connect(provider) as unknown as Wallet,
  );

  return {
    process: proc,
    provider,
    wallets,
    stop: () => proc.kill(),
  };
}
