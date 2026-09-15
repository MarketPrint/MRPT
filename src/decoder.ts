import { decodeEventLog, getAddress } from 'viem';
import type { Hex } from 'viem';
import { abi } from './abi.ts';
import { safeNumber } from './rpc.ts';
import type { RawLog } from './rpc.ts';

export type TapeEvent =
  | { kind: 'PrintOpened'; printId: number; openedAt: number; block: number; logIndex: number; tx: Hex }
  | { kind: 'PrintClosed'; printId: number; assetIndex: number; asset: Hex; reserveEth: string; totalWeight: string; block: number; logIndex: number; tx: Hex }
  | { kind: 'PrintConverting'; printId: number; reserveEth: string; block: number; logIndex: number; tx: Hex }
  | { kind: 'PrintFinalized'; printId: number; asset: Hex; acquired: string; block: number; logIndex: number; tx: Hex };

const KINDS = new Set(['PrintOpened', 'PrintClosed', 'PrintConverting', 'PrintFinalized']);

/// Order logs the way the chain produced them: block, then position within the block.
export function compareEvents(a: TapeEvent, b: TapeEvent): number {
  return a.block - b.block || a.logIndex - b.logIndex;
}

/// Decode one raw log into a tape event, or null when it is an event this tape does not track
/// (FeeReceived, HookBound, ERC-20 Transfer, claims). Unknown topics are ignored, never guessed at.
export function decode(log: RawLog): TapeEvent | null {
  if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
    throw new Error('RPC returned a pending log; only finalized state is published');
  }
  let event: { eventName: string; args: Record<string, unknown> };
  try {
    event = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data }) as typeof event;
  } catch { return null; }
  if (!KINDS.has(event.eventName)) return null;

  const base = { block: safeNumber(log.blockNumber), logIndex: log.logIndex, tx: log.transactionHash };
  const a = event.args;
  const printId = safeNumber(a['printId'] as bigint);
  if (printId < 1) throw new Error(`Invalid printId ${printId}`);

  switch (event.eventName) {
    case 'PrintOpened':
      return { kind: 'PrintOpened', printId, openedAt: safeNumber(a['openedAt'] as bigint), ...base };
    case 'PrintClosed':
      return {
        kind: 'PrintClosed', printId,
        assetIndex: Number(a['assetIndex'] as number),
        asset: getAddress(a['asset'] as Hex).toLowerCase() as Hex,
        reserveEth: (a['reserveEth'] as bigint).toString(),
        totalWeight: (a['totalWeight'] as bigint).toString(),
        ...base,
      };
    case 'PrintConverting':
      return { kind: 'PrintConverting', printId, reserveEth: (a['reserveEth'] as bigint).toString(), ...base };
    case 'PrintFinalized':
      return {
        kind: 'PrintFinalized', printId,
        asset: getAddress(a['asset'] as Hex).toLowerCase() as Hex,
        acquired: (a['acquired'] as bigint).toString(),
        ...base,
      };
    default:
      return null;
  }
}
