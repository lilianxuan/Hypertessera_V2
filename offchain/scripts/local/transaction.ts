import type { JsonRpcProvider, TransactionReceipt, TransactionResponse } from "ethers";

type ReceiptProvider = Pick<JsonRpcProvider, "getTransactionReceipt" | "getBlockNumber" | "getTransactionCount">;
type SentTransaction = Pick<TransactionResponse, "hash" | "nonce" | "from">;

/** Bounds a single phase; a timed-out send is never submitted a second time. */
async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Local Anvil bootstrap only: read receipts directly, without relying on a new-block event. */
export async function sendLocalTransaction(
  provider: ReceiptProvider,
  label: string,
  send: () => Promise<SentTransaction>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TransactionReceipt> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("Local transaction timeout and poll interval must be positive");
  }
  let tx: SentTransaction | undefined;
  const started = Date.now();
  console.log(`[local:deploy] ${label}: sending`);
  try {
    tx = await bounded(send(), timeoutMs, `${label}: send`);
    console.log(`[local:deploy] ${label}: sent hash=${tx.hash} from=${tx.from} nonce=${tx.nonce}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await bounded(
        provider.getTransactionReceipt(tx.hash),
        Math.min(10_000, deadline - Date.now()),
        `${label}: receipt ${tx.hash}`,
      );
      if (receipt) {
        if (receipt.status !== 1) throw new Error(`${label}: transaction ${tx.hash} failed (status=${receipt.status})`);
        console.log(`[local:deploy] ${label}: mined block=${receipt.blockNumber} elapsedMs=${Date.now() - started}`);
        return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    throw new Error(`${label}: receipt ${tx.hash} timed out after ${timeoutMs} ms`);
  } catch (error) {
    // Diagnostics must not turn a bounded failure into another indefinite wait.
    const reads: Array<[string, Promise<unknown>]> = [["block", provider.getBlockNumber()]];
    if (tx) {
      reads.push(
        ["receipt", provider.getTransactionReceipt(tx.hash)],
        ["latestNonce", provider.getTransactionCount(tx.from, "latest")],
        ["pendingNonce", provider.getTransactionCount(tx.from, "pending")],
      );
    }
    const diagnostics = await Promise.all(reads.map(async ([name, read]) => {
      try { return [name, await bounded(read, 2_000, `diagnostic ${name}`)]; }
      catch (failure) { return [name, String(failure)]; }
    }));
    console.error(`[local:deploy] ${label}: failed; hash=${tx?.hash ?? "unknown (send did not return)"}; diagnostics=`, Object.fromEntries(diagnostics));
    throw error;
  }
}
