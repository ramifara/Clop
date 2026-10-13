import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled CLI imports sharp through this file (an esbuild alias). Installed, `cli.mjs` sits in the resources folder
// beside `app.asar`, whose node_modules hold sharp; Electron in Node mode reads the archive and loads sharp's native
// part from `app.asar.unpacked`. In development the usual lookup from `dist-electron` finds windows/node_modules.
const here = path.dirname(fileURLToPath(import.meta.url)), asar = path.join(here, 'app.asar');
const load = createRequire(existsSync(asar) ? path.join(asar, 'package.json') : import.meta.url);
export default load('sharp') as typeof import('sharp');
