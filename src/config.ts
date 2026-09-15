import { fileURLToPath } from 'node:url';
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CHAIN_ID = 1;

/// The fixed reward universe, in the exact order MarketPrintToken indexes it.
/// assetAt(0..3) => NVDA, SPY, AAPL, GOOGL. Nothing outside this plate can be selected.
export const ASSET_NAMES = ['NVDA', 'SPY', 'AAPL', 'GOOGL'] as const;
export type AssetName = (typeof ASSET_NAMES)[number];

/// PrintStatus enum, mirroring MarketPrintToken.PrintStatus by ordinal.
export const PRINT_STATUS = ['OPEN', 'CLOSED', 'CONVERTING', 'FINALIZED'] as const;
export type PrintStatus = (typeof PRINT_STATUS)[number];

export interface Config { tokenAddress: Address; deployBlock: number }

export function config(): Config {
  // GitHub Actions injects exactly two Repository variables into the sync process.
  const address = (process.env.MARKET_PRINT_TOKEN_ADDRESS ?? '').trim();
  const block = (process.env.DEPLOY_BLOCK ?? '').trim();
  if (!isAddress(address, { strict: false }) || /^0x0+$/i.test(address)) {
    throw new Error('Set the MARKET_PRINT_TOKEN_ADDRESS Repository variable to the deployed MarketPrintToken address.');
  }
  if (!/^[1-9]\d*$/.test(block) || !Number.isSafeInteger(Number(block))) {
    throw new Error('The DEPLOY_BLOCK Repository variable must be a positive integer; scanning from block 0 is forbidden.');
  }
  return { tokenAddress: getAddress(address.toLowerCase()), deployBlock: Number(block) };
}
