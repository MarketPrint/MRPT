import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyLocal } from '../src/verify.ts';
import { writePrint, writeJson, printDirectories, json, publish } from '../src/storage.ts';
import type { PrintRecord } from '../src/state.ts';
import type { Config } from '../src/config.ts';

const CONFIG: Config = { tokenAddress: '0x1234567890abcDEF1234567890aBcdef12345678', deployBlock: 100 };
const NVDA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX = (n: number) => `0x${String(n).padStart(64, '0')}` as `0x${string}`;

const record = (id: number, over: Partial<PrintRecord> = {}): PrintRecord => ({
  printId: id, status: 'FINALIZED', openedAt: 1700000000, closedAt: 1700021600, finalizedAt: 1700021700,
  assetIndex: 0, asset: 'NVDA', assetAddress: NVDA as `0x${string}`,
  reserveEth: '1000000000000000000', acquired: '4242', totalWeight: '99',
  openedBlock: 101, openedTx: TX(1), closedBlock: 102, closedTx: TX(2),
  finalizedBlock: 103, finalizedTx: TX(3), verification: 'VERIFIED', ...over,
});

function sandbox(records: PrintRecord[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mprt-'));
  mkdirSync(join(root, 'prints'), { recursive: true });
  for (const r of records) writePrint(join(root, 'prints'), r, [], CONFIG);
  return root;
}

test('a well-formed tape verifies clean', () => {
  const root = sandbox([record(1), record(2, { assetIndex: 3, asset: 'GOOGL' })]);
  try {
    assert.deepEqual(verifyLocal(root), []);
    assert.deepEqual(printDirectories(join(root, 'prints')), ['000001', '000002']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('records round-trip through the three JSON files', () => {
  const root = sandbox([record(1)]);
  try {
    const base = join(root, 'prints', '000001');
    const receipt = json<Record<string, unknown>>(join(base, 'receipt.json'));
    assert.equal(receipt['selectedAsset'], 'NVDA');
    assert.equal(receipt['rewardReserveWei'], '1000000000000000000');
    assert.equal(receipt['acquiredRewardAmount'], '4242');
    assert.equal(receipt['finalizedBlock'], 103);
    assert.equal(receipt['verificationStatus'], 'VERIFIED');
    const selection = json<Record<string, unknown>>(join(base, 'selection.json'));
    assert.deepEqual(selection['assetUniverse'], ['NVDA', 'SPY', 'AAPL', 'GOOGL']);
    const session = json<Record<string, unknown>>(join(base, 'session.json'));
    assert.equal(session['status'], 'FINALIZED');
    assert.equal(session['openedAtISO'], new Date(1700000000000).toISOString());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catches a gap in the PRINT sequence', () => {
  const root = sandbox([record(1), record(3)]);
  try {
    assert.match(verifyLocal(root).map(p => p.message).join('|'), /out of sequence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catches an asset outside the universe', () => {
  const root = sandbox([record(1)]);
  try {
    const base = join(root, 'prints', '000001');
    const selection = json<Record<string, unknown>>(join(base, 'selection.json'));
    selection['selectedAsset'] = 'TSLA';
    writeJson(join(base, 'selection.json'), selection);
    assert.match(verifyLocal(root).map(p => p.message).join('|'), /outside the universe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catches a mismatched reserve and a non-VERIFIED status', () => {
  const root = sandbox([record(1)]);
  try {
    const base = join(root, 'prints', '000001');
    const receipt = json<Record<string, unknown>>(join(base, 'receipt.json'));
    receipt['rewardReserveWei'] = '999';
    receipt['verificationStatus'] = 'INVALID';
    writeJson(join(base, 'receipt.json'), receipt);
    const messages = verifyLocal(root).map(p => p.message).join('|');
    assert.match(messages, /reward reserve differs/);
    assert.match(messages, /verification status is INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catches a missing record file', () => {
  const root = sandbox([record(1)]);
  try {
    rmSync(join(root, 'prints', '000001', 'receipt.json'));
    assert.match(verifyLocal(root).map(p => p.message).join('|'), /missing receipt.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('publishes the open PRINT and preserves gaps backed by pending conversions', () => {
  const root = sandbox([]);
  try {
    const pending = record(1, { status: 'CLOSED', acquired: null, finalizedBlock: null,
      finalizedTx: null, finalizedAt: null, verification: 'PENDING' });
    const current = record(3, { status: 'OPEN', closedAt: null, acquired: null, finalizedBlock: null,
      finalizedTx: null, finalizedAt: null, asset: null, assetAddress: null, assetIndex: null,
      verification: 'PENDING', reserveEth: '123' });
    publish(root, { config: CONFIG, prints: [pending, record(2), current], eventsByPrint: new Map(),
      block: 150, blockHash: TX(150), rebuild: true, engineStatus: 'SYNCED' });
    assert.equal(json<Record<string, unknown>>(join(root, 'live/current.json'))['printId'], 3);
    assert.equal(json<Record<string, unknown>>(join(root, 'live/current.json'))['rewardReserveWei'], '123');
    assert.deepEqual(json<Array<{ printId: number }>>(join(root, 'live/pending.json')).map(p => p.printId), [1]);
    assert.deepEqual(printDirectories(join(root, 'prints')), ['000002']);
    assert.deepEqual(verifyLocal(root), []);
    // Missing pending metadata must not turn an incomplete history into a verified one.
    writeJson(join(root, 'live/pending.json'), []);
    assert.match(verifyLocal(root).map(p => p.message).join('|'), /out of sequence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
