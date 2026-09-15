import { ROOT } from './config.ts';
import { updateReadme } from './readme.ts';
import { fail } from './sync.ts';
try { console.log(updateReadme(ROOT) ? 'README updated.' : 'README already current.'); }
catch (error) { fail(error); }
