import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Config } from './config.ts';
import type { PrintRecord } from './state.ts';
import type { TapeEvent } from './decoder.ts';

export interface Checkpoint {
  schemaVersion: 1;
  chainId: 1;
  tokenAddress: Config['tokenAddress'];
  deployBlock: number;
  lastVerifiedBlock: number;
  lastVerifiedBlockHash: Hex;
  currentPrintId: number;
  finalizedPrints: number;
  engineStatus: 'SYNCED' | 'DEGRADED';
  updatedAt: string;
}

export const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
export const printName = (id: number): string => String(id).padStart(6, '0');
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function printDirectories(root: string): string[] {
  return existsSync(root)
    ? readdirSync(root).filter(name => /^\d{6,}$/.test(name)).sort((a, b) => Number(a) - Number(b))
    : [];
}

/// One PRINT becomes three human-readable files: how it ran, what it drew, what it paid.
export function writePrint(root: string, print: PrintRecord, events: TapeEvent[], config: Config): void {
  const directory = join(root, printName(print.printId));
  mkdirSync(directory, { recursive: true });

  writeJson(join(directory, 'session.json'), {
    printId: print.printId,
    status: print.status,
    chainId: 1,
    token: config.tokenAddress,
    openedAt: print.openedAt,
    openedAtISO: new Date(print.openedAt * 1000).toISOString(),
    closedAt: print.closedAt,
    closedAtISO: print.closedAt === null ? null : new Date(print.closedAt * 1000).toISOString(),
    finalizedAt: print.finalizedAt,
    finalizedAtISO: print.finalizedAt === null ? null : new Date(print.finalizedAt * 1000).toISOString(),
    openedBlock: print.openedBlock,
    openedTx: print.openedTx,
    closedBlock: print.closedBlock,
    closedTx: print.closedTx,
    events,
  });

  writeJson(join(directory, 'selection.json'), {
    printId: print.printId,
    selectedAsset: print.asset,
    assetIndex: print.assetIndex,
    assetAddress: print.assetAddress,
    assetUniverse: ['NVDA', 'SPY', 'AAPL', 'GOOGL'],
    rewardReserveWei: print.reserveEth,
    totalWeight: print.totalWeight,
    closedBlock: print.closedBlock,
    closedTx: print.closedTx,
  });

  writeJson(join(directory, 'receipt.json'), {
    printId: print.printId,
    selectedAsset: print.asset,
    assetAddress: print.assetAddress,
    rewardReserveWei: print.reserveEth,
    acquiredRewardAmount: print.acquired,
    finalizedBlock: print.finalizedBlock,
    finalizedTx: print.finalizedTx,
    finalizedAt: print.finalizedAt,
    verificationStatus: print.verification,
  });
}

/// A small journal makes a killed process recoverable: roll both directories back before the next run.
export function recover(root: string): void {
  const stage = join(root, '.stage');
  if (!existsSync(stage)) return;
  if (existsSync(join(stage, 'journal.json'))) {
    const journal = json<Record<string, boolean>>(join(stage, 'journal.json'));
    for (const name of ['live', 'prints']) {
      const old = join(stage, `old-${name}`), target = join(root, name);
      if (existsSync(old)) { rmSync(target, { recursive: true, force: true }); renameSync(old, target); }
      else if (!journal[name]) rmSync(target, { recursive: true, force: true });
    }
  }
  rmSync(stage, { recursive: true, force: true });
}

export interface Publication {
  config: Config;
  prints: PrintRecord[];
  eventsByPrint: Map<number, TapeEvent[]>;
  block: number;
  blockHash: Hex;
  rebuild: boolean;
  engineStatus: Checkpoint['engineStatus'];
}

/// Write everything into .stage, then swap directories in. A reader never sees a half-written tape.
export function publish(root: string, p: Publication): void {
  const stage = join(root, '.stage');
  mkdirSync(join(stage, 'live'), { recursive: true });
  mkdirSync(join(stage, 'prints'), { recursive: true });
  try {
    if (!p.rebuild && existsSync(join(root, 'prints'))) {
      cpSync(join(root, 'prints'), join(stage, 'prints'), { recursive: true });
    }
    for (const print of p.prints) {
      if (print.status !== 'FINALIZED') continue;
      writePrint(join(stage, 'prints'), print, p.eventsByPrint.get(print.printId) ?? [], p.config);
    }

    const current = p.prints.find(x => x.status !== 'FINALIZED') ?? null;
    const finalized = p.prints.filter(x => x.status === 'FINALIZED');
    const latest = finalized.at(-1) ?? null;

    writeJson(join(stage, 'live/current.json'), current === null ? { status: 'NONE' } : {
      printId: current.printId,
      status: current.status,
      openedAt: current.openedAt,
      openedAtISO: new Date(current.openedAt * 1000).toISOString(),
      selectedAsset: current.asset,
      assetAddress: current.assetAddress,
      rewardReserveWei: current.reserveEth,
      openedBlock: current.openedBlock,
      openedTx: current.openedTx,
      lastVerifiedBlock: p.block,
    });

    writeJson(join(stage, 'live/latest.json'), latest === null ? { status: 'NONE' } : {
      printId: latest.printId,
      selectedAsset: latest.asset,
      assetAddress: latest.assetAddress,
      rewardReserveWei: latest.reserveEth,
      acquiredRewardAmount: latest.acquired,
      finalizedBlock: latest.finalizedBlock,
      finalizedTx: latest.finalizedTx,
      finalizedAt: latest.finalizedAt,
      finalizedAtISO: latest.finalizedAt === null ? null : new Date(latest.finalizedAt * 1000).toISOString(),
      verificationStatus: latest.verification,
    });

    const checkpoint: Checkpoint = {
      schemaVersion: 1, chainId: 1,
      tokenAddress: p.config.tokenAddress,
      deployBlock: p.config.deployBlock,
      lastVerifiedBlock: p.block,
      lastVerifiedBlockHash: p.blockHash,
      currentPrintId: current?.printId ?? (latest?.printId ?? 0),
      finalizedPrints: finalized.length,
      engineStatus: p.engineStatus,
      updatedAt: new Date().toISOString(),
    };
    writeJson(join(stage, 'live/status.json'), checkpoint);

    writeJson(join(stage, 'journal.json'), Object.fromEntries(
      ['live', 'prints'].map(name => [name, existsSync(join(root, name))]),
    ));
    for (const name of ['live', 'prints']) {
      const target = join(root, name);
      if (existsSync(target)) renameSync(target, join(stage, `old-${name}`));
      renameSync(join(stage, name), target);
    }
    // Removing the journal is the commit point; the old snapshots are now disposable.
    rmSync(join(stage, 'journal.json'));
    rmSync(stage, { recursive: true });
  } catch (error) { recover(root); throw error; }
}
