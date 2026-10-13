// npm run dist:win [--x64] [--arm64]: builds the app, prepares the bundled tools and sharp for each architecture and packages the NSIS
// installer and portable app for all of them in one electron-builder run (both by default). On an ARM64 machine the same command
// works unchanged; CI builds each architecture on a runner of its own kind instead, so it runs the individual steps.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureSharp } from './sharp-arch.mjs';

const { values } = parseArgs({ options: { x64: { type: 'boolean' }, arm64: { type: 'boolean' } } });
const archs = ['x64', 'arm64'].filter(arch => values[arch] || (!values.x64 && !values.arm64));
const node = args => execFileSync(process.execPath, args, { stdio: 'inherit' });

if (!process.env.npm_execpath) throw new Error('Run this as npm run dist:win.');
node([process.env.npm_execpath, 'run', 'build']);
for (const arch of archs) {
  node(['scripts/fetch-tools.mjs', '--platform', 'win32', '--arch', arch]);
  if (await ensureSharp(arch)) console.log(`Installed @img/sharp-win32-${arch} for packaging.`);
}
node([fileURLToPath(import.meta.resolve('electron-builder/cli.js')), '--win', 'nsis', 'portable', ...archs.map(arch => `--${arch}`), '--publish', 'never']);
