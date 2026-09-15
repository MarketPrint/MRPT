import { closeSync, openSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { config, ROOT, CHAIN_ID, ASSET_NAMES } from './config.ts';
import { abi } from './abi.ts';
import { client, retry, logPages, safeNumber } from './rpc.ts';
import { decode, compareEvents } from './decoder.ts';
import type { TapeEvent } from './decoder.ts';
import { Tape, requireEqual, statusFromOrdinal } from './state.ts';
import type { PrintRecord } from './state.ts';
import { publish, recover, json, printDirectories } from './storage.ts';
import type { Checkpoint } from './storage.ts';
import { updateReadme } from './readme.ts';

export function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

export async function run(reconstruct: boolean): Promise<void> {
  const cfg = config();
  const lock = join(ROOT, '.tape.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx'); }
  catch { throw new Error('Another sync run holds .tape.lock. If a process was killed, remove that file after confirming it has stopped.'); }

  try {
    recover(ROOT);
    requireEqual(await retry(() => client.getChainId()), CHAIN_ID, 'RPC is not Ethereum Mainnet');

    // Publish finalized state only. Never mix log reads and state reads at different heights.
    const finalized = await retry(() => client.getBlock({ blockTag: 'finalized' }));
    const target = safeNumber(finalized.number);
    if (target < cfg.deployBlock) throw new Error('DEPLOY_BLOCK is not finalized yet');

    const statusPath = join(ROOT, 'live/status.json');
    // The repository ships an UNCONFIGURED placeholder; treat it as "no checkpoint yet".
    const stored = !reconstruct && existsSync(statusPath)
      ? json<Checkpoint | { status: 'UNCONFIGURED' }>(statusPath) : null;
    const previous = stored !== null && !('status' in stored && stored.status === 'UNCONFIGURED')
      ? (stored as Checkpoint) : null;
    if (previous) {
      requireEqual(
        [previous.schemaVersion, previous.chainId, previous.tokenAddress, previous.deployBlock],
        [1, 1, cfg.tokenAddress, cfg.deployBlock],
        'Configuration changed; run npm run reconstruct',
      );
      if (target < previous.lastVerifiedBlock) throw new Error('RPC finalized height is behind the checkpoint; retry later');
      const checkpointBlock = await retry(() => client.getBlock({ blockNumber: BigInt(previous.lastVerifiedBlock) }));
      if (checkpointBlock.hash !== previous.lastVerifiedBlockHash) {
        console.log('Checkpoint block changed; rebuilding the tape from DEPLOY_BLOCK.');
      } else if (target === previous.lastVerifiedBlock) {
        updateReadme(ROOT);
        console.log('Already synchronized.');
        return;
      }
    }

    // The tape is always rebuilt in full from DEPLOY_BLOCK: PRINT history is small (four a day at
    // most) and a full replay is what makes duplicate and out-of-order detection meaningful.
    console.log(`Reading Ethereum Mainnet blocks ${cfg.deployBlock}..${target} from public RPC`);
    const tape = new Tape();
    const events: TapeEvent[] = [];
    for await (const logs of logPages(cfg.tokenAddress, BigInt(cfg.deployBlock), BigInt(target))) {
      for (const log of logs) {
        if (getAddress(log.address) !== cfg.tokenAddress) throw new Error('RPC returned a log from another contract');
        const event = decode(log);
        if (event) events.push(event);
      }
    }
    events.sort(compareEvents);
    for (let i = 1; i < events.length; i++) {
      if (compareEvents(events[i - 1], events[i]) === 0) throw new Error('RPC returned duplicate logs');
    }
    for (const event of events) tape.apply(event);

    const blockNumber = BigInt(target);
    const read = <T>(fn: () => Promise<T>): Promise<T> => retry(fn);

    // The four names are immutable in the token. Confirm the plate this repository labels by
    // matches the plate the contract actually holds, before any label is written to disk.
    const universe = await read(() => client.readContract({
      address: cfg.tokenAddress, abi, functionName: 'assetUniverse', blockNumber,
    })) as readonly Hex[];
    requireEqual(universe.length, ASSET_NAMES.length, 'Asset universe is not four entries');
    const universeLower = universe.map(a => a.toLowerCase());

    const onchainCurrent = safeNumber(await read(() => client.readContract({
      address: cfg.tokenAddress, abi, functionName: 'currentPrintId', blockNumber,
    })) as bigint);
    requireEqual(tape.currentPrintId, onchainCurrent, 'Reconstructed current PRINT differs from contract; nothing published');

    const onchainStatus = statusFromOrdinal(Number(await read(() => client.readContract({
      address: cfg.tokenAddress, abi, functionName: 'currentPrintStatus', blockNumber,
    })) as number));

    // Verify every print against getPrint(), and fill in the timestamps only state carries.
    const eventsByPrint = new Map<number, TapeEvent[]>();
    for (const event of events) {
      const list = eventsByPrint.get(event.printId) ?? [];
      list.push(event);
      eventsByPrint.set(event.printId, list);
    }

    let degraded = false;
    for (const print of tape.ordered) {
      const record = await read(() => client.readContract({
        address: cfg.tokenAddress, abi, functionName: 'getPrint', args: [BigInt(print.printId)], blockNumber,
      })) as readonly [bigint, bigint, bigint, Hex, number, bigint, bigint, bigint, bigint];

      const [openedAt, closedAt, finalizedAt, asset, statusOrdinal, reserveEth, acquired, totalWeight] = record;
      const status = statusFromOrdinal(Number(statusOrdinal));

      const problems: string[] = [];
      if (status !== print.status) problems.push(`status ${print.status} != on-chain ${status}`);
      if (safeNumber(openedAt) !== print.openedAt) problems.push('openedAt differs');
      if (print.assetAddress !== null) {
        if (asset.toLowerCase() !== print.assetAddress) problems.push('asset address differs');
        const index = universeLower.indexOf(print.assetAddress);
        if (index !== print.assetIndex) problems.push(`asset is not universe[${print.assetIndex}]`);
        if (index < 0) problems.push('selected asset is outside NVDA/SPY/AAPL/GOOGL');
      }
      if (print.reserveEth !== null && reserveEth.toString() !== print.reserveEth) problems.push('reward reserve differs');
      if (print.totalWeight !== null && totalWeight.toString() !== print.totalWeight) problems.push('totalWeight differs');
      if (print.acquired !== null && acquired.toString() !== print.acquired) problems.push('acquired amount differs');

      print.closedAt = safeNumber(closedAt) || null;
      print.finalizedAt = safeNumber(finalizedAt) || null;

      if (print.status === 'FINALIZED') {
        if (print.acquired === null) problems.push('finalized without an acquired amount');
        if (print.finalizedBlock === null) problems.push('finalized without a block');
        print.verification = problems.length === 0 ? 'VERIFIED' : 'INVALID';
      } else {
        print.verification = problems.length === 0 ? 'PENDING' : 'INVALID';
      }
      if (problems.length > 0) {
        degraded = true;
        console.error(`PRINT #${print.printId} INVALID: ${problems.join('; ')}`);
      }
    }

    const current = tape.current;
    if (current && current.status !== 'FINALIZED') {
      requireEqual(current.status, onchainStatus, 'Current PRINT status differs from contract');
    }

    // Catch an RPC that shifted its view mid-run before anything is committed.
    requireEqual((await retry(() => client.getBlock({ blockNumber }))).hash, finalized.hash, 'Target block changed while reading');

    const rebuild = reconstruct || previous === null
      || printDirectories(join(ROOT, 'prints')).length !== tape.finalized.length;

    publish(ROOT, {
      config: cfg,
      prints: tape.ordered,
      eventsByPrint,
      block: target,
      blockHash: finalized.hash,
      rebuild,
      engineStatus: degraded ? 'DEGRADED' : 'SYNCED',
    });

    updateReadme(ROOT);
    console.log(`Synchronized: PRINT #${tape.currentPrintId}, ${tape.finalized.length} finalized, verified through block ${target}.`);
    if (degraded) throw new Error('INVALID PRINT saved for inspection; automatic GitHub commit is blocked');
  } finally { closeSync(fd); rmSync(lock, { force: true }); }
}
