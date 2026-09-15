import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tape, statusFromOrdinal } from '../src/state.ts';
import type { TapeEvent } from '../src/decoder.ts';

const TX = (n: number): `0x${string}` => `0x${String(n).padStart(64, '0')}` as `0x${string}`;
const NVDA = '0x1111111111111111111111111111111111111111' as const;
const SPY = '0x2222222222222222222222222222222222222222' as const;

const opened = (id: number, block: number): TapeEvent =>
  ({ kind: 'PrintOpened', printId: id, openedAt: 1000 + block, block, logIndex: 0, tx: TX(block) });
const closed = (id: number, block: number, assetIndex = 0, asset: string = NVDA, reserveEth = '500'): TapeEvent =>
  ({ kind: 'PrintClosed', printId: id, assetIndex, asset: asset as `0x${string}`, reserveEth, totalWeight: '9', block, logIndex: 0, tx: TX(block) });
const converting = (id: number, block: number, reserveEth = '500'): TapeEvent =>
  ({ kind: 'PrintConverting', printId: id, reserveEth, block, logIndex: 0, tx: TX(block) });
const finalizedEvent = (id: number, block: number, asset: string = NVDA, acquired = '77'): TapeEvent =>
  ({ kind: 'PrintFinalized', printId: id, asset: asset as `0x${string}`, acquired, block, logIndex: 0, tx: TX(block) });

const full = (id: number, base: number, assetIndex = 0, asset: string = NVDA): TapeEvent[] =>
  [closed(id, base, assetIndex, asset), converting(id, base + 1), finalizedEvent(id, base + 2, asset)];

function apply(events: TapeEvent[]): Tape {
  const tape = new Tape();
  for (const event of events) tape.apply(event);
  return tape;
}

test('reconstructs a full PRINT lifecycle', () => {
  const tape = apply([opened(1, 10), ...full(1, 11), opened(2, 13)]);
  const first = tape.prints.get(1)!;
  assert.equal(first.status, 'FINALIZED');
  assert.equal(first.asset, 'NVDA');
  assert.equal(first.assetAddress, NVDA);
  assert.equal(first.reserveEth, '500');
  assert.equal(first.acquired, '77');
  assert.equal(first.finalizedBlock, 13);
  assert.equal(tape.currentPrintId, 2);
  assert.equal(tape.finalized.length, 1);
  assert.equal(tape.current!.status, 'OPEN');
});

test('rejects a duplicate PRINT', () => {
  assert.throws(() => apply([opened(1, 10), opened(1, 11)]), /Duplicate PRINT #1/);
});

test('rejects an out-of-order PRINT', () => {
  assert.throws(() => apply([opened(1, 10), ...full(1, 11), opened(3, 14)]), /out of order/);
});

test('rejects opening a PRINT before the previous finalizes', () => {
  assert.throws(() => apply([opened(1, 10), closed(1, 11), opened(2, 12)]), /opened while #1 is CLOSED/);
});

test('rejects an illegal state transition', () => {
  assert.throws(() => apply([opened(1, 10), converting(1, 11)]), /Illegal transition/);
  assert.throws(() => apply([opened(1, 10), closed(1, 11), finalizedEvent(1, 12)]), /Illegal transition/);
});

test('rejects an asset index outside the universe', () => {
  assert.throws(() => apply([opened(1, 10), closed(1, 11, 4)]), /outside NVDA\/SPY\/AAPL\/GOOGL/);
});

test('rejects a reserve that changes during conversion', () => {
  assert.throws(() => apply([opened(1, 10), closed(1, 11), converting(1, 12, '999')]), /reserve changed/);
});

test('rejects finalizing a different asset than was selected', () => {
  assert.throws(
    () => apply([opened(1, 10), closed(1, 11, 0, NVDA), converting(1, 12), finalizedEvent(1, 13, SPY)]),
    /finalized a different asset/,
  );
});

test('rejects an event for an unknown PRINT', () => {
  assert.throws(() => apply([closed(5, 11)]), /unknown PRINT #5/);
});

test('maps every asset index to its name', () => {
  for (const [index, name] of ['NVDA', 'SPY', 'AAPL', 'GOOGL'].entries()) {
    const tape = apply([opened(1, 10), closed(1, 11, index, NVDA)]);
    assert.equal(tape.prints.get(1)!.asset, name);
  }
});

test('maps PrintStatus ordinals and refuses unknown ones', () => {
  assert.deepEqual([0, 1, 2, 3].map(statusFromOrdinal), ['OPEN', 'CLOSED', 'CONVERTING', 'FINALIZED']);
  assert.throws(() => statusFromOrdinal(4), /Unknown PrintStatus/);
});
