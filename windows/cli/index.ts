import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './main';

// The `cli.mjs` entry point. Installed, it sits in the app's resources folder beside the bundled tools in `bin`.
const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.CLOP_TOOLS_DIR && existsSync(path.join(here, 'bin'))) process.env.CLOP_TOOLS_DIR = path.join(here, 'bin');
process.exitCode = await main(process.argv.slice(2));
