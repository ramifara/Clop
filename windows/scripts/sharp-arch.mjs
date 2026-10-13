// sharp keeps its native code in one optional package per platform (@img/sharp-win32-x64, @img/sharp-win32-arm64), and npm installs
// only the one for the machine it runs on. Packaging the other architecture from here needs that package too, so this installs it
// from the registry into node_modules at the version package-lock.json pins and refuses it unless its integrity matches the lock.
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** Runs npm through the node that is running this script, so Windows needs no npm.cmd and no shell. */
function npm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('Run this through npm (npm run dist:win) so npm can be found.');
  execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' });
}

/** Makes sure node_modules holds sharp's Windows package for `arch`. Returns true when it had to install it. */
export async function ensureSharp(arch) {
  const name = `@img/sharp-win32-${arch}`, installed = path.join(root, 'node_modules', name);
  if (existsSync(path.join(installed, 'package.json'))) return false;
  const locked = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')).packages[`node_modules/${name}`];
  if (!locked?.integrity) throw new Error(`package-lock.json does not pin ${name}.`);
  // A scratch project, so the real node_modules and package files stay untouched. The cpu and os flags would stop npm refusing a
  // package for another machine; --force covers older npm versions that ignore them.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'clop-sharp-'));
  try {
    await writeFile(path.join(scratch, 'package.json'), '{"private":true}\n');
    npm(['install', `${name}@${locked.version}`, '--force', '--ignore-scripts', '--no-audit', '--no-fund', '--os=win32', `--cpu=${arch}`], scratch);
    const got = JSON.parse(await readFile(path.join(scratch, 'package-lock.json'), 'utf8')).packages[`node_modules/${name}`];
    if (got?.integrity !== locked.integrity) throw new Error(`${name}@${locked.version} from the registry has integrity ${got?.integrity}, package-lock.json says ${locked.integrity}.`);
    await cp(path.join(scratch, 'node_modules', name), installed, { recursive: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return true;
}
