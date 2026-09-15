import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatEther } from 'viem';
import { json, printDirectories, printName } from './storage.ts';
import type { Checkpoint } from './storage.ts';
import type { Receipt } from './verify.ts';

export const LIVE_START = '<!-- MARKETPRINT:LIVE:START -->';
export const LIVE_END = '<!-- MARKETPRINT:LIVE:END -->';

const WAITING = '**Waiting for the first sync.**\n\n'
  + 'Add `MARKET_PRINT_TOKEN_ADDRESS` and `DEPLOY_BLOCK` under **Settings → Secrets and variables → '
  + 'Actions → Variables → Repository variables**, then run **Actions → Sync Market Print → Run workflow**. '
  + 'No on-chain state has been published yet.';

const ETH = (wei: string | null): string => (wei === null ? '—' : `${formatEther(BigInt(wei))} ETH`);

/// Acquired amounts are raw token units — the asset's own decimals are not read here, so the
/// integer is shown exactly as the contract reported it, only grouped to stay readable.
const units = (raw: string | null): string =>
  raw === null ? '—' : raw.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');

const ASSETS = ['NVDA', 'SPY', 'AAPL', 'GOOGL'] as const;
const STAGES = ['OPEN', 'CLOSED', 'CONVERTING', 'FINALIZED'] as const;

/// The cycle as a ticker, with the stage the tape is actually at bracketed.
/// Each cell is padded to a fixed width so the arrows line up whichever stage is live.
function stageLine(status: string): string {
  const width = Math.max(...STAGES.map(s => s.length)) + 4;
  return STAGES
    .map(stage => (stage === status ? `[${stage}]` : stage).padEnd(width))
    .join('-> ')
    .trimEnd();
}

/// The plate, with the name this PRINT drew marked. Every other name stays visible,
/// because what was not drawn is part of the result.
function plate(selected: string | null): string[] {
  return ASSETS.map(name => (name === selected ? `  >  ${name}` : `     ${name}`));
}

export function liveReadme(root: string): string {
  const statusPath = join(root, 'live/status.json');
  if (!existsSync(statusPath)) return WAITING;
  const raw = json<Checkpoint | { status: 'UNCONFIGURED' }>(statusPath);
  // A fresh clone ships an UNCONFIGURED placeholder; that is the waiting state, not a failure.
  if ('status' in raw && raw.status === 'UNCONFIGURED') return WAITING;
  const status = raw as Checkpoint;
  if (status.schemaVersion !== 1 || status.chainId !== 1) throw new Error('Cannot render unsupported live checkpoint');

  const current = json<Record<string, unknown>>(join(root, 'live/current.json'));
  const directories = printDirectories(join(root, 'prints'));
  const lastId = directories.at(-1);
  const receipt = lastId ? json<Receipt>(join(root, 'prints', lastId, 'receipt.json')) : null;

  const running = current['status'] !== 'NONE';
  const currentStage = running ? String(current['status']) : null;
  const lines: string[] = [];

  // ── the PRINT running right now ──────────────────────────────────────────────────────────────
  lines.push('```');
  if (running) {
    lines.push(`CURRENT PRINT        #${printName(Number(current['printId']))}`);
    lines.push(`RESERVE              ${ETH((current['rewardReserveWei'] as string | null) ?? null)}`);
    lines.push('');
    lines.push(stageLine(currentStage!));
    if (currentStage !== 'OPEN' && current['selectedAsset']) {
      lines.push('');
      lines.push(...plate(String(current['selectedAsset'])));
    }
  } else {
    lines.push('CURRENT PRINT        none open');
  }
  lines.push('```');

  // ── the last PRINT that finished ─────────────────────────────────────────────────────────────
  if (receipt) {
    lines.push('', `### LAST PRINT — #${printName(receipt.printId)}`, '', '```');
    lines.push(...plate(receipt.selectedAsset));
    lines.push('', `RESERVE              ${ETH(receipt.rewardReserveWei)}`);
    lines.push(`ACQUIRED             ${units(receipt.acquiredRewardAmount)}`);
    lines.push(`VERIFICATION         ${receipt.verificationStatus}`);
    lines.push('```', '');
    lines.push(`Selected asset [\`${receipt.assetAddress}\`](https://etherscan.io/address/${receipt.assetAddress})`
      + ` · [finalized transaction](https://etherscan.io/tx/${receipt.finalizedTx})`
      + ` · [receipt](prints/${lastId}/receipt.json)`);
  } else {
    lines.push('', 'No PRINT has finalized yet.');
  }

  const pendingPath = join(root, 'live/pending.json');
  if (existsSync(pendingPath)) {
    const pending = json<Array<{ printId: number; asset: string | null }>>(pendingPath);
    if (pending.length) lines.push('', '**Awaiting conversion:** ' + pending.map(p => `#${printName(p.printId)} (${p.asset ?? '—'})`).join(', '), '', '[Pending PRINTs](live/pending.json)');
  }

  // ── the engine ───────────────────────────────────────────────────────────────────────────────
  lines.push('', '```');
  lines.push(`FINALIZED PRINTS     ${status.finalizedPrints}`);
  lines.push(`LAST VERIFIED BLOCK  ${status.lastVerifiedBlock}`);
  lines.push(`ENGINE STATUS        ${status.engineStatus}`);
  lines.push('```', '');
  lines.push(`Token [\`${status.tokenAddress}\`](https://etherscan.io/address/${status.tokenAddress})`
    + ` · block [${status.lastVerifiedBlock}](https://etherscan.io/block/${status.lastVerifiedBlock})`);
  lines.push('', '[Current](live/current.json) · [Latest](live/latest.json) · [Status](live/status.json) · [All PRINTs](prints/)');
  lines.push('', `*Read from finalized Ethereum state through public RPC. Updated ${status.updatedAt}.*`);

  return lines.join('\n');
}

/// Touch only the marked section. The surrounding README stays authored prose.
export function updateReadme(root: string): boolean {
  const path = join(root, 'README.md');
  if (!existsSync(path)) throw new Error('README.md is missing');
  const before = readFileSync(path, 'utf8');
  const start = before.indexOf(LIVE_START), end = before.indexOf(LIVE_END);
  if (start < 0 || end < start || before.indexOf(LIVE_START, start + 1) !== -1 || before.indexOf(LIVE_END, end + 1) !== -1) {
    throw new Error('README must contain one MARKETPRINT LIVE marker pair');
  }
  const after = before.slice(0, start + LIVE_START.length) + '\n\n' + liveReadme(root) + '\n\n' + before.slice(end);
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}
