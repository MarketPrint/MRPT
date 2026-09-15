import type { Hex } from 'viem';
import { ASSET_NAMES, PRINT_STATUS } from './config.ts';
import type { AssetName, PrintStatus } from './config.ts';
import type { TapeEvent } from './decoder.ts';

export interface PrintRecord {
  printId: number;
  status: PrintStatus;
  openedAt: number;
  closedAt: number | null;
  finalizedAt: number | null;
  assetIndex: number | null;
  asset: AssetName | null;
  assetAddress: Hex | null;
  reserveEth: string | null;
  acquired: string | null;
  totalWeight: string | null;
  openedBlock: number;
  openedTx: Hex;
  closedBlock: number | null;
  closedTx: Hex | null;
  finalizedBlock: number | null;
  finalizedTx: Hex | null;
  verification: 'VERIFIED' | 'INVALID' | 'PENDING';
}

export function requireEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

/// Each PRINT progresses independently. Its successor opens at close, before conversion.
const NEXT: Record<PrintStatus, PrintStatus | null> = {
  OPEN: 'CLOSED', CLOSED: 'CONVERTING', CONVERTING: 'FINALIZED', FINALIZED: null,
};

export class Tape {
  readonly prints = new Map<number, PrintRecord>();
  currentPrintId = 0;

  /// Apply one event, refusing anything that is not a legal step for that print.
  apply(event: TapeEvent): void {
    if (event.kind === 'PrintOpened') {
      if (this.prints.has(event.printId)) throw new Error(`Duplicate PRINT #${event.printId}: opened twice`);
      // Prints must appear strictly in order, with no gaps in the sequence.
      if (event.printId !== this.currentPrintId + 1) {
        throw new Error(`PRINT #${event.printId} opened out of order; expected #${this.currentPrintId + 1}`);
      }
      const previous = this.prints.get(event.printId - 1);
      if (previous && previous.status === 'OPEN') {
        throw new Error(`PRINT #${event.printId} opened while #${previous.printId} is ${previous.status}`);
      }
      this.prints.set(event.printId, {
        printId: event.printId, status: 'OPEN', openedAt: event.openedAt,
        closedAt: null, finalizedAt: null, assetIndex: null, asset: null, assetAddress: null,
        reserveEth: null, acquired: null, totalWeight: null,
        openedBlock: event.block, openedTx: event.tx,
        closedBlock: null, closedTx: null, finalizedBlock: null, finalizedTx: null,
        verification: 'PENDING',
      });
      this.currentPrintId = event.printId;
      return;
    }

    const print = this.prints.get(event.printId);
    if (!print) throw new Error(`Event for unknown PRINT #${event.printId}`);
    const expected = event.kind === 'PrintClosed' ? 'OPEN' : event.kind === 'PrintConverting' ? 'CLOSED' : 'CONVERTING';
    if (print.status !== expected) {
      throw new Error(`Illegal transition on PRINT #${event.printId}: ${print.status} -> ${event.kind} (needs ${expected})`);
    }
    requireEqual(NEXT[print.status] !== null, true, `PRINT #${event.printId} is terminal`);

    if (event.kind === 'PrintClosed') {
      if (event.assetIndex < 0 || event.assetIndex >= ASSET_NAMES.length) {
        throw new Error(`PRINT #${event.printId} selected asset index ${event.assetIndex} outside NVDA/SPY/AAPL/GOOGL`);
      }
      print.status = 'CLOSED';
      print.assetIndex = event.assetIndex;
      print.asset = ASSET_NAMES[event.assetIndex];
      print.assetAddress = event.asset;
      print.reserveEth = event.reserveEth;
      print.totalWeight = event.totalWeight;
      print.closedBlock = event.block;
      print.closedTx = event.tx;
    } else if (event.kind === 'PrintConverting') {
      print.status = 'CONVERTING';
      // The reserve handed to the hook must match what was frozen at close.
      requireEqual(event.reserveEth, print.reserveEth, `PRINT #${event.printId} reserve changed during conversion`);
    } else {
      print.status = 'FINALIZED';
      requireEqual(event.asset, print.assetAddress, `PRINT #${event.printId} finalized a different asset than selected`);
      print.acquired = event.acquired;
      print.finalizedBlock = event.block;
      print.finalizedTx = event.tx;
    }
  }

  get current(): PrintRecord | null { return this.prints.get(this.currentPrintId) ?? null; }
  get finalized(): PrintRecord[] {
    return [...this.prints.values()].filter(p => p.status === 'FINALIZED').sort((a, b) => a.printId - b.printId);
  }
  get ordered(): PrintRecord[] { return [...this.prints.values()].sort((a, b) => a.printId - b.printId); }
}

export const statusFromOrdinal = (ordinal: number): PrintStatus => {
  const status = PRINT_STATUS[ordinal];
  if (!status) throw new Error(`Unknown PrintStatus ordinal ${ordinal}`);
  return status;
};
