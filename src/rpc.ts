import { createPublicClient, fallback, http } from 'viem';
import { mainnet } from 'viem/chains';
import type { Address, PublicClient } from 'viem';

/// Public Ethereum Mainnet JSON-RPC endpoints, hardcoded on purpose.
/// No API keys, no private RPCs, no indexers: every value in this repository is obtainable
/// by anyone pointing a plain JSON-RPC client at one of these URLs.
export const PUBLIC_RPC_URLS = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.flashbots.net',
  'https://eth.meowrpc.com',
  'https://rpc.mevblocker.io',
  'https://eth.rpc.blxrbdn.com',
  'https://eth-pokt.nodies.app',
  'https://gateway.tenderly.co/public/mainnet',
] as const;

/// `fallback` walks the list in order when an endpoint errors out, so one dead public node
/// does not stall the tape. Retries are handled by `retry` below rather than per-transport,
/// keeping backoff uniform across reads.
export const client: PublicClient = createPublicClient({
  chain: mainnet,
  transport: fallback(
    PUBLIC_RPC_URLS.map(url => http(url, { timeout: 30_000, retryCount: 0 })),
    { rank: false, retryCount: 0 },
  ),
});

export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function retry<T>(read: () => Promise<T>, sleep = delay): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (attempt === 4) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

export const safeNumber = (value: bigint): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Value ${value} exceeds safe integer range`);
  return Number(value);
};

export interface RawLog {
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: `0x${string}` | null;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  address: Address;
}

export type LogReader = (from: bigint, to: bigint) => Promise<RawLog[]>;

/// Sequential requests, bounded pages and exponential backoff avoid flooding a shared public node.
/// Every log for the address is fetched so a malformed relevant event is never silently dropped.
export async function* logPages(
  address: Address,
  from: bigint,
  to: bigint,
  reader: LogReader = (a, b) => client.getLogs({ address, fromBlock: a, toBlock: b }) as Promise<RawLog[]>,
  sleep = delay,
): AsyncGenerator<RawLog[]> {
  if (from <= 0n) throw new Error('Refusing to scan from block 0');
  let width = 1_000n;
  while (from <= to) {
    const end = from + width - 1n < to ? from + width - 1n : to;
    let logs: RawLog[];
    try { logs = await retry(() => reader(from, end), sleep); }
    catch (error) {
      // Halving the window turns a "too many results" refusal into progress instead of a failure.
      if (end === from) throw new Error(`Public RPC failed at block ${from}; no progress published`, { cause: error });
      width = width / 2n || 1n;
      continue;
    }
    for (const log of logs) {
      if (log.blockNumber === null || log.blockNumber < from || log.blockNumber > end) {
        throw new Error('RPC returned a log outside the requested range');
      }
    }
    yield logs;
    from = end + 1n;
    width = width < 1_000n ? (width * 2n > 1_000n ? 1_000n : width * 2n) : width;
    await sleep(150);
  }
}
