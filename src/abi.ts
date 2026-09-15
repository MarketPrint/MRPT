import { parseAbi } from 'viem';

/// Read directly off MarketPrintToken: it is where the PRINT record, the status machine and the
/// four immutable asset addresses actually live. The hook only mirrors a subset of this.
export const abi = parseAbi([
  'event PrintOpened(uint256 indexed printId, uint64 openedAt)',
  'event PrintClosed(uint256 indexed printId, uint8 assetIndex, address indexed asset, uint256 reserveEth, uint256 totalWeight)',
  'event PrintConverting(uint256 indexed printId, uint256 reserveEth)',
  'event PrintFinalized(uint256 indexed printId, address indexed asset, uint256 acquired)',
  'event FeeReceived(uint256 indexed printId, uint256 amount, uint256 reserveEth)',
  'event HookBound(address indexed hook, address indexed poolManager)',
  'function getPrint(uint256 printId) view returns (uint64 openedAt, uint64 closedAt, uint64 finalizedAt, address asset, uint8 status, uint256 reserveEth, uint256 acquired, uint256 totalWeight, uint256 claimed)',
  'function currentPrintId() view returns (uint256)',
  'function currentPrintStatus() view returns (uint8)',
  'function currentReserve() view returns (uint256)',
  'function assetUniverse() view returns (address[4])',
  'function assetAt(uint8 index) view returns (address)',
  'function hook() view returns (address)',
  'function ASSET_COUNT() view returns (uint256)',
  'function symbol() view returns (string)',
]);
