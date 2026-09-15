import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logPages, retry, safeNumber } from '../src/rpc.ts';
import type { RawLog } from '../src/rpc.ts';

const noSleep = async (): Promise<void> => {};
const TOKEN = '0x1234567890abcdef1234567890abcdef12345678' as const;

async function collect(from: bigint, to: bigint, reader: (a: bigint, b: bigint) => Promise<RawLog[]>): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for await (const page of logPages(TOKEN, from, to, reader, noSleep)) out.push(...page);
  return out;
}

test('refuses to scan from block 0', async () => {
  await assert.rejects(collect(0n, 10n, async () => []), /Refusing to scan from block 0/);
});

test('covers the whole range exactly once', async () => {
  const ranges: [bigint, bigint][] = [];
  await collect(1n, 2500n, async (a, b) => { ranges.push([a, b]); return []; });
  assert.equal(ranges[0][0], 1n);
  assert.equal(ranges.at(-1)![1], 2500n);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1n);
});

test('halves the window when a whole page keeps failing, instead of giving up', async () => {
  const widths: bigint[] = [];
  // retry() absorbs 5 attempts, so the window only shrinks once a page fails past that budget.
  let failures = 5;
  await collect(1n, 1000n, async (a, b) => {
    widths.push(b - a + 1n);
    if (failures-- > 0) throw new Error('too many results');
    return [];
  });
  assert.equal(widths[0], 1000n);
  assert.ok(widths.some(w => w < 1000n), 'window should shrink after the retry budget is spent');
  assert.equal(widths.at(-1), 500n);
});

test('rejects a log outside the requested range', async () => {
  await assert.rejects(
    collect(1n, 10n, async () => [{ blockNumber: 999n, logIndex: 0, transactionHash: null, topics: [], data: '0x', address: TOKEN }]),
    /outside the requested range/,
  );
});

test('gives up only after repeated failures at a single block', async () => {
  await assert.rejects(collect(5n, 5n, async () => { throw new Error('down'); }), /no progress published/);
});

test('retry backs off then succeeds', async () => {
  let attempts = 0;
  const value = await retry(async () => { if (++attempts < 3) throw new Error('flaky'); return 'ok'; }, noSleep);
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
});

test('safeNumber refuses values beyond the safe integer range', () => {
  assert.equal(safeNumber(123n), 123);
  assert.throws(() => safeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n), /exceeds safe integer/);
});
