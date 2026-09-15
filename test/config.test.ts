import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, ASSET_NAMES, PRINT_STATUS } from '../src/config.ts';
import { PUBLIC_RPC_URLS } from '../src/rpc.ts';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function withEnv(token: string | undefined, block: string | undefined, run: () => void): void {
  const before = { t: process.env['MARKET_PRINT_TOKEN_ADDRESS'], b: process.env['DEPLOY_BLOCK'] };
  if (token === undefined) delete process.env['MARKET_PRINT_TOKEN_ADDRESS'];
  else process.env['MARKET_PRINT_TOKEN_ADDRESS'] = token;
  if (block === undefined) delete process.env['DEPLOY_BLOCK'];
  else process.env['DEPLOY_BLOCK'] = block;
  try { run(); } finally {
    if (before.t === undefined) delete process.env['MARKET_PRINT_TOKEN_ADDRESS'];
    else process.env['MARKET_PRINT_TOKEN_ADDRESS'] = before.t;
    if (before.b === undefined) delete process.env['DEPLOY_BLOCK'];
    else process.env['DEPLOY_BLOCK'] = before.b;
  }
}

test('accepts the two Repository variables', () => {
  withEnv(ADDRESS, '18000000', () => {
    const cfg = config();
    assert.equal(cfg.deployBlock, 18000000);
    assert.equal(cfg.tokenAddress.toLowerCase(), ADDRESS);
  });
});

test('refuses a missing or zero token address', () => {
  withEnv(undefined, '1', () => assert.throws(config, /MARKET_PRINT_TOKEN_ADDRESS/));
  withEnv('0x0000000000000000000000000000000000000000', '1', () => assert.throws(config, /MARKET_PRINT_TOKEN_ADDRESS/));
  withEnv('not-an-address', '1', () => assert.throws(config, /MARKET_PRINT_TOKEN_ADDRESS/));
});

test('refuses scanning from block 0 or a non-integer block', () => {
  withEnv(ADDRESS, '0', () => assert.throws(config, /DEPLOY_BLOCK/));
  withEnv(ADDRESS, '-5', () => assert.throws(config, /DEPLOY_BLOCK/));
  withEnv(ADDRESS, 'abc', () => assert.throws(config, /DEPLOY_BLOCK/));
  withEnv(ADDRESS, undefined, () => assert.throws(config, /DEPLOY_BLOCK/));
});

test('the asset universe is exactly the four fixed names', () => {
  assert.deepEqual([...ASSET_NAMES], ['NVDA', 'SPY', 'AAPL', 'GOOGL']);
  assert.deepEqual([...PRINT_STATUS], ['OPEN', 'CLOSED', 'CONVERTING', 'FINALIZED']);
});

test('every RPC endpoint is public https with no API key', () => {
  assert.ok(PUBLIC_RPC_URLS.length >= 2, 'needs fallbacks');
  for (const url of PUBLIC_RPC_URLS) {
    assert.match(url, /^https:\/\//, `${url} must be https`);
    assert.doesNotMatch(url, /alchemy|infura|quicknode|etherscan|thegraph/i, `${url} must not be a gated provider`);
    // A key would show up as a query string, or as a long opaque path segment.
    assert.doesNotMatch(url, /[?]/, `${url} must not carry query parameters`);
    for (const segment of new URL(url).pathname.split('/').filter(Boolean)) {
      assert.ok(segment.length < 24, `${url} looks like it embeds a key: ${segment}`);
      assert.doesNotMatch(segment, /^[0-9a-f]{16,}$/i, `${url} looks like it embeds a key`);
    }
  }
});
