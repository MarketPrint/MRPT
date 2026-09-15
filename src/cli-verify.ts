import { ROOT } from './config.ts';
import { verifyLocal, verifyOnchain, printLabel } from './verify.ts';
import { printDirectories } from './storage.ts';
import { join } from 'node:path';
import { fail } from './sync.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const online = args.includes('--onchain');
  if (args.some(arg => arg.startsWith('--') && arg !== '--onchain')) {
    throw new Error('Usage: npm run verify -- [--onchain]');
  }
  const total = printDirectories(join(ROOT, 'prints')).length;
  const problems = online ? await verifyOnchain(ROOT) : verifyLocal(ROOT);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`${printLabel(problem.printId)}: ${problem.message}`);
    throw new Error(`STATUS\nINVALID — ${problems.length} problem(s) across ${total} PRINT(s)`);
  }
  console.log(`MARKET PRINT TAPE\n\nPRINTS\n${total}\n\nMODE\n${online ? 'ONCHAIN' : 'OFFLINE'}\n\nSTATUS\nVERIFIED\n`);
}

main().catch(fail);
