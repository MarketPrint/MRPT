import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { ROOT, ASSET_NAMES, config } from './config.ts';
import { abi } from './abi.ts';
import { client, retry, safeNumber } from './rpc.ts';
import { json, printDirectories, printName } from './storage.ts';
import { statusFromOrdinal } from './state.ts';

export interface Receipt {
  printId: number; selectedAsset: string; assetAddress: Hex;
  rewardReserveWei: string; acquiredRewardAmount: string;
  finalizedBlock: number; finalizedTx: Hex; finalizedAt: number;
  verificationStatus: string;
}
export interface Selection {
  printId: number; selectedAsset: string; assetIndex: number; assetAddress: Hex; rewardReserveWei: string;
}
export interface Session { printId: number; status: string; openedAt: number }

export interface Problem { printId: number; message: string }

/// Offline checks: everything that must hold about the stored records on their own.
export function verifyLocal(root = ROOT): Problem[] {
  const problems: Problem[] = [];
  const directories = printDirectories(join(root, 'prints'));
  const seen = new Set<number>();
  const pendingPath = join(root, 'live/pending.json');
  const pendingRecords = existsSync(pendingPath) ? json<Array<{ printId: number; status: string }>>(pendingPath) : [];
  const pendingIds = new Set<number>();
  for (const record of pendingRecords) {
    if (!Number.isSafeInteger(record.printId) || record.printId < 1
      || !['CLOSED', 'CONVERTING'].includes(record.status) || pendingIds.has(record.printId)) {
      problems.push({ printId: record.printId, message: 'invalid or duplicate pending PRINT' });
    }
    pendingIds.add(record.printId);
  }
  const allIds = [...directories.map(Number), ...pendingIds].sort((a, b) => a - b);
  allIds.forEach((id, index) => {
    if (id !== index + 1) problems.push({ printId: id, message: `out of sequence; expected #${index + 1}` });
  });

  directories.forEach((directory) => {
    const base = join(root, 'prints', directory);
    const add = (message: string, id = Number(directory)): void => { problems.push({ printId: id, message }); };

    for (const file of ['session.json', 'selection.json', 'receipt.json']) {
      if (!existsSync(join(base, file))) { add(`missing ${file}`); return; }
    }
    const session = json<Session>(join(base, 'session.json'));
    const selection = json<Selection>(join(base, 'selection.json'));
    const receipt = json<Receipt>(join(base, 'receipt.json'));

    // PRINT exists, is numbered consistently, and appears exactly once.
    if (receipt.printId !== Number(directory)) add('printId differs from its directory name');
    if (session.printId !== receipt.printId || selection.printId !== receipt.printId) add('printId differs across records');
    if (seen.has(receipt.printId)) add('duplicate PRINT');
    seen.add(receipt.printId);
    // Gaps in finalized receipts are allowed only when backed by a pending PRINT.

    // Selected asset is only NVDA / SPY / AAPL / GOOGL.
    if (!ASSET_NAMES.includes(selection.selectedAsset as never)) add(`asset ${selection.selectedAsset} outside the universe`);
    if (selection.selectedAsset !== receipt.selectedAsset) add('asset differs between selection and receipt');
    if (ASSET_NAMES[selection.assetIndex] !== selection.selectedAsset) add('asset index does not match its name');
    if (selection.assetAddress?.toLowerCase() !== receipt.assetAddress?.toLowerCase()) add('asset address differs between records');

    // A stored PRINT is finalized by definition, with real values behind it.
    if (session.status !== 'FINALIZED') add(`stored PRINT has status ${session.status}`);
    if (selection.rewardReserveWei !== receipt.rewardReserveWei) add('reward reserve differs between records');
    if (!/^\d+$/.test(receipt.rewardReserveWei ?? '')) add('reward reserve is not an integer');
    if (!/^\d+$/.test(receipt.acquiredRewardAmount ?? '')) add('acquired amount is not an integer');
    if (!Number.isSafeInteger(receipt.finalizedBlock) || receipt.finalizedBlock <= 0) add('finalized block is invalid');
    if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.finalizedTx ?? '')) add('finalized tx is invalid');
    if (receipt.verificationStatus !== 'VERIFIED') add(`verification status is ${receipt.verificationStatus}`);
  });

  return problems;
}

/// Online checks: every stored value re-read from the contract through public RPC.
export async function verifyOnchain(root = ROOT): Promise<Problem[]> {
  const cfg = config();
  const problems = verifyLocal(root);
  const finalized = await retry(() => client.getBlock({ blockTag: 'finalized' }));
  const blockNumber = finalized.number;

  const universe = (await retry(() => client.readContract({
    address: cfg.tokenAddress, abi, functionName: 'assetUniverse', blockNumber,
  })) as readonly Hex[]).map(a => a.toLowerCase());

  for (const directory of printDirectories(join(root, 'prints'))) {
    const base = join(root, 'prints', directory);
    if (!existsSync(join(base, 'receipt.json'))) continue;
    const receipt = json<Receipt>(join(base, 'receipt.json'));
    const selection = json<Selection>(join(base, 'selection.json'));
    const add = (message: string): void => { problems.push({ printId: receipt.printId, message }); };

    const record = await retry(() => client.readContract({
      address: cfg.tokenAddress, abi, functionName: 'getPrint', args: [BigInt(receipt.printId)], blockNumber,
    })) as readonly [bigint, bigint, bigint, Hex, number, bigint, bigint, bigint, bigint];
    const [, , finalizedAt, asset, statusOrdinal, reserveEth, acquired] = record;

    if (statusFromOrdinal(Number(statusOrdinal)) !== 'FINALIZED') add('contract does not report this PRINT as FINALIZED');
    if (asset.toLowerCase() !== receipt.assetAddress.toLowerCase()) add('on-chain asset differs from the stored receipt');
    if (universe[selection.assetIndex] !== receipt.assetAddress.toLowerCase()) add('asset is not the contract universe entry for its index');
    if (reserveEth.toString() !== receipt.rewardReserveWei) add('on-chain reward reserve differs');
    if (acquired.toString() !== receipt.acquiredRewardAmount) add('on-chain acquired amount differs');
    if (safeNumber(finalizedAt) !== receipt.finalizedAt) add('on-chain finalizedAt differs');
  }
  return problems;
}

export const printLabel = (id: number): string => `PRINT #${printName(id)}`;
