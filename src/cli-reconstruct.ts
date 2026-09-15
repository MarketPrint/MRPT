import { run, fail } from './sync.ts';
// Rebuilds /prints and /live from DEPLOY_BLOCK, discarding any stored tape.
run(true).catch(fail);
