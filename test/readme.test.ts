import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/config.ts';
import { updateReadme, liveReadme, LIVE_START, LIVE_END } from '../src/readme.ts';
import { writeJson, writePrint } from '../src/storage.ts';
import type { Checkpoint } from '../src/storage.ts';
import type { PrintRecord } from '../src/state.ts';
import type { Config } from '../src/config.ts';

const CONFIG: Config = { tokenAddress: '0x1234567890abcDEF1234567890aBcdef12345678', deployBlock: 100 };
const NVDA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const TX = (n: number) => `0x${String(n).padStart(64, '0')}` as `0x${string}`;

const finalizedPrint: PrintRecord = {
  printId: 1, status: 'FINALIZED', openedAt: 1700000000, closedAt: 1700021600, finalizedAt: 1700021700,
  assetIndex: 0, asset: 'NVDA', assetAddress: NVDA,
  reserveEth: '2500000000000000000', acquired: '4242', totalWeight: '99',
  openedBlock: 101, openedTx: TX(1), closedBlock: 102, closedTx: TX(2),
  finalizedBlock: 103, finalizedTx: TX(3), verification: 'VERIFIED',
};

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'mprt-readme-'));
  mkdirSync(join(root, 'live'), { recursive: true });
  mkdirSync(join(root, 'prints'), { recursive: true });
  copyFileSync(join(ROOT, 'README.md'), join(root, 'README.md'));
  const status: Checkpoint = {
    schemaVersion: 1, chainId: 1, tokenAddress: CONFIG.tokenAddress, deployBlock: 100,
    lastVerifiedBlock: 20_000_000, lastVerifiedBlockHash: TX(9),
    currentPrintId: 2, finalizedPrints: 1, engineStatus: 'SYNCED', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  writeJson(join(root, 'live/status.json'), status);
  writeJson(join(root, 'live/current.json'), {
    printId: 2, status: 'OPEN', openedAt: 1700021700, openedAtISO: '2023-11-15T02:55:00.000Z',
    selectedAsset: null, assetAddress: null, rewardReserveWei: '500000000000000000',
    openedBlock: 103, openedTx: TX(3), lastVerifiedBlock: 20_000_000,
  });
  writeJson(join(root, 'live/latest.json'), { printId: 1, selectedAsset: 'NVDA' });
  writePrint(join(root, 'prints'), finalizedPrint, [], CONFIG);
  return root;
}

test('the shipped README carries exactly one live marker pair', () => {
  const text = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.equal(text.split(LIVE_START).length - 1, 1);
  assert.equal(text.split(LIVE_END).length - 1, 1);
  assert.ok(text.indexOf(LIVE_START) < text.indexOf(LIVE_END));
});

test('renders the five public-facing fields', () => {
  const root = sandbox();
  try {
    const rendered = liveReadme(root);
    assert.match(rendered, /CURRENT PRINT/);
    assert.match(rendered, /LAST PRINT/);
    assert.match(rendered, /LAST VERIFIED BLOCK/);
    assert.match(rendered, /ENGINE STATUS/);
    assert.match(rendered, /SYNCED/);
    assert.match(rendered, /20000000/);
    // Wei is rendered as ETH for a human reader.
    assert.match(rendered, /2\.5 ETH/);
    // The drawn name is marked on the plate, and the names not drawn stay visible.
    assert.match(rendered, /> {2}NVDA/);
    for (const name of ['SPY', 'AAPL', 'GOOGL']) assert.match(rendered, new RegExp(name));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the stage ticker brackets the live stage and keeps its columns aligned', () => {
  const root = sandbox();
  try {
    const line = liveReadme(root).split('\n').find(l => l.includes('->'))!;
    assert.match(line, /\[OPEN\]/, 'the running stage is bracketed');
    assert.equal(line.split('->').length - 1, 3, 'four stages, three arrows');
    // Every arrow sits at the same column whichever stage is live.
    const columns = [...line.matchAll(/->/g)].map(m => m.index!);
    const gaps = columns.slice(1).map((c, i) => c - columns[i]);
    assert.ok(gaps.every(g => g === gaps[0]), `arrows must be evenly spaced, got ${gaps.join(',')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hides the plate while a PRINT is still OPEN', () => {
  const root = sandbox();
  try {
    // current.json in the sandbox is OPEN with no asset drawn yet.
    const current = liveReadme(root).split('### LAST PRINT')[0];
    assert.doesNotMatch(current, /> {2}(NVDA|SPY|AAPL|GOOGL)/, 'nothing is drawn before CLOSED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writes into the marked section and is idempotent', () => {
  const root = sandbox();
  try {
    assert.equal(updateReadme(root), true);
    const once = readFileSync(join(root, 'README.md'), 'utf8');
    assert.match(once, /LAST PRINT/);
    assert.match(once, /ENGINE STATUS/);
    assert.doesNotMatch(once, /Waiting for the first sync/);
    assert.equal(updateReadme(root), false, 'second run should change nothing');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), once);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses a README without a single marker pair', () => {
  const root = sandbox();
  try {
    writeFileSync(join(root, 'README.md'), 'no markers here');
    assert.throws(() => updateReadme(root), /one MARKETPRINT LIVE marker pair/);
    writeFileSync(join(root, 'README.md'), `${LIVE_START}a${LIVE_END}${LIVE_START}b${LIVE_END}`);
    assert.throws(() => updateReadme(root), /one MARKETPRINT LIVE marker pair/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('falls back to the waiting notice before the first sync', () => {
  const root = mkdtempSync(join(tmpdir(), 'mprt-empty-'));
  try { assert.match(liveReadme(root), /Waiting for the first sync/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
