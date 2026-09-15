import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, keccak256, toHex } from 'viem';
import { abi } from '../src/abi.ts';
import { decode, compareEvents } from '../src/decoder.ts';
import type { RawLog } from '../src/rpc.ts';

const TOKEN = '0x1234567890abcdef1234567890abcdef12345678' as const;
const NVDA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const TX = '0x'.padEnd(66, 'c') as `0x${string}`;

// encodeEventTopics is typed loosely enough to admit nulls/arrays; a real log never carries them.
type Topics = ReturnType<typeof encodeEventTopics>;
const asTopics = (topics: Topics | readonly `0x${string}`[]): readonly `0x${string}`[] =>
  topics as readonly `0x${string}`[];

const log = (topics: Topics | readonly `0x${string}`[], data: `0x${string}`, block = 100n, logIndex = 3): RawLog =>
  ({ topics: asTopics(topics), data, blockNumber: block, logIndex, transactionHash: TX, address: TOKEN });

test('decodes PrintClosed with its indexed asset', () => {
  const topics = encodeEventTopics({ abi, eventName: 'PrintClosed', args: { printId: 7n, asset: NVDA } });
  const data = encodeAbiParameters(parseAbiParameters('uint8, uint256, uint256'), [1, 500n, 9n]);
  const event = decode(log(topics, data));
  assert.equal(event?.kind, 'PrintClosed');
  assert.equal(event!.printId, 7);
  assert.equal((event as { assetIndex: number }).assetIndex, 1);
  assert.equal((event as { asset: string }).asset, NVDA);
  assert.equal((event as { reserveEth: string }).reserveEth, '500');
});

test('decodes PrintFinalized', () => {
  const topics = encodeEventTopics({ abi, eventName: 'PrintFinalized', args: { printId: 2n, asset: NVDA } });
  const data = encodeAbiParameters(parseAbiParameters('uint256'), [4242n]);
  const event = decode(log(topics, data));
  assert.equal(event?.kind, 'PrintFinalized');
  assert.equal((event as { acquired: string }).acquired, '4242');
});

test('decodes PrintOpened and PrintConverting', () => {
  const opened = decode(log(
    encodeEventTopics({ abi, eventName: 'PrintOpened', args: { printId: 1n } }),
    encodeAbiParameters(parseAbiParameters('uint64'), [1700000000n]),
  ));
  assert.equal(opened?.kind, 'PrintOpened');
  assert.equal((opened as { openedAt: number }).openedAt, 1700000000);

  const converting = decode(log(
    encodeEventTopics({ abi, eventName: 'PrintConverting', args: { printId: 1n } }),
    encodeAbiParameters(parseAbiParameters('uint256'), [800n]),
  ));
  assert.equal(converting?.kind, 'PrintConverting');
  assert.equal((converting as { reserveEth: string }).reserveEth, '800');
});

test('ignores untracked and unknown events rather than guessing', () => {
  // FeeReceived is in the ABI but is not a lifecycle step.
  const fee = encodeEventTopics({ abi, eventName: 'FeeReceived', args: { printId: 1n } });
  assert.equal(decode(log(fee, encodeAbiParameters(parseAbiParameters('uint256, uint256'), [1n, 2n]))), null);
  // A topic that belongs to no event in the ABI at all.
  assert.equal(decode(log([keccak256(toHex('Unrelated(uint256)'))], '0x')), null);
});

test('refuses a pending log', () => {
  const topics = encodeEventTopics({ abi, eventName: 'PrintOpened', args: { printId: 1n } });
  const data = encodeAbiParameters(parseAbiParameters('uint64'), [1n]);
  assert.throws(() => decode({ ...log(topics, data), blockNumber: null }), /pending log/);
});

test('orders events by block then log index', () => {
  const at = (block: number, logIndex: number) => ({ block, logIndex }) as never;
  assert.ok(compareEvents(at(1, 0), at(2, 0)) < 0);
  assert.ok(compareEvents(at(2, 5), at(2, 1)) > 0);
  assert.equal(compareEvents(at(2, 1), at(2, 1)), 0);
});
