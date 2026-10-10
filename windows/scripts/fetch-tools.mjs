// Downloads the command-line tools pinned in tools.json, checks their sha256 and copies the listed files into
// .tools/<platform>-<arch>/bin, which electron-builder ships as resources/bin. Packages already installed at
// the pinned hash are skipped, so repeated runs and CI cache hits do no network work.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import SevenZip from '7z-wasm';

const root = path.resolve(import.meta.dirname, '..');
const { values: options } = parseArgs({ options: { platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch } } });
if (options.platform !== 'win32') {
  console.log(`Clop bundles tools only for Windows. On ${options.platform}, development uses ffmpeg, gs and the other tools from PATH. Pass --platform win32 to prepare the Windows set here.`);
  process.exit(0);
}
const target = `${options.platform}-${options.arch}`;
const packages = JSON.parse(await readFile(path.join(root, 'scripts', 'tools.json'), 'utf8'))[target];
if (!packages) {
  console.error(`scripts/tools.json has no tools for ${target}.`);
  process.exit(1);
}
const base = path.join(root, '.tools', target), bin = path.join(base, 'bin'), stamps = path.join(base, 'stamps'), work = path.join(base, 'work');
const owners = new Map();
for (const pkg of packages) for (const file of Object.values(pkg.files)) {
  if (owners.has(file)) throw new Error(`tools.json: ${pkg.name} and ${owners.get(file)} both install ${file}.`);
  owners.set(file, pkg.name);
}

const readStamp = async name => { try { return JSON.parse(await readFile(path.join(stamps, `${name}.json`), 'utf8')); } catch { return undefined; } };
async function uninstall(name) {
  for (const file of (await readStamp(name))?.files ?? []) await rm(path.join(bin, file), { recursive: true, force: true });
  await rm(path.join(stamps, `${name}.json`), { force: true });
}

async function download(pkg, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(pkg.url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = createHash('sha256');
      await pipeline(Readable.fromWeb(response.body), async function* (chunks) { for await (const chunk of chunks) { hash.update(chunk); yield chunk; } }, createWriteStream(file));
      const actual = hash.digest('hex');
      if (actual !== pkg.sha256) throw new Error(`sha256 is ${actual}, expected ${pkg.sha256}`);
      return;
    } catch (error) {
      if (attempt === 3) throw new Error(`${pkg.name}: could not download ${pkg.url}: ${error.message}`);
      await delay(2000 * attempt);
    }
  }
}

// 7-Zip compiled to WebAssembly reads every archive type used here (zip, 7z, NSIS installers, xz, zstd, tar)
// without needing 7-Zip or a newer tar.exe on the machine.
async function sevenZip(cwd, args) {
  const output = [];
  const module = await SevenZip({ print: line => output.push(line), printErr: line => output.push(line) });
  // The WASM build sets mode 000 on folders it creates from tar archives, which would make them unwritable.
  const chmod = module.FS.chmod;
  module.FS.chmod = (file, mode, dontFollow) => { if (mode) chmod(file, mode, dontFollow); };
  module.FS.mkdir('/work');
  module.FS.mount(module.NODEFS, { root: cwd.split(path.sep).join('/') }, '/work');
  module.FS.chdir('/work');
  let code;
  try { code = module.callMain(['x', '-y', '-bso0', '-bsp0', ...args]); } catch { code = -1; }
  if (code !== 0) throw new Error(`7-Zip could not extract ${args[0]}:\n${output.filter(Boolean).slice(-5).join('\n')}`);
}

// Extracts only the listed paths (folders come with their contents); package archives also hold hard links that NODEFS cannot create.
async function extract(dir, archive, type, paths) {
  const only = async folder => (await readdir(path.join(dir, folder)))[0];
  if (type === 'conda') {
    await sevenZip(dir, [archive, '-oconda']);
    return extract(dir, `conda/${(await readdir(path.join(dir, 'conda'))).find(file => /^pkg-.*\.tar\.zst$/.test(file))}`, 'tar.zst', paths);
  }
  if (type === 'tar.xz' || type === 'tar.zst') {
    await sevenZip(dir, [archive, '-otar']);
    archive = `tar/${await only('tar')}`;
  } else if (!['zip', '7z', 'nsis'].includes(type)) throw new Error(`Unknown archive type ${type}.`);
  await sevenZip(dir, [archive, '-oout', ...paths]);
  return path.join(dir, 'out');
}

async function install(pkg) {
  const files = Object.entries(pkg.files);
  const stamp = await readStamp(pkg.name);
  if (stamp?.sha256 === pkg.sha256 && files.every(([, to]) => existsSync(path.join(bin, to)))) return false;
  await uninstall(pkg.name);
  const dir = path.join(work, pkg.name), archive = path.basename(new URL(pkg.url).pathname);
  await mkdir(dir, { recursive: true });
  await download(pkg, path.join(dir, archive));
  const out = await extract(dir, archive, pkg.archive, files.map(([from]) => from));
  for (const [from, to] of files) {
    if (!existsSync(path.join(out, from))) throw new Error(`${pkg.name}: ${from} is not in ${pkg.url}.`);
    await cp(path.join(out, from), path.join(bin, to), { recursive: true, force: true });
  }
  await writeFile(path.join(stamps, `${pkg.name}.json`), `${JSON.stringify({ version: pkg.version, sha256: pkg.sha256, files: files.map(([, to]) => to) })}\n`);
  await rm(dir, { recursive: true, force: true });
  console.log(`${pkg.name} ${pkg.version}`);
  return true;
}

await rm(work, { recursive: true, force: true });
await mkdir(bin, { recursive: true });
await mkdir(stamps, { recursive: true });
for (const file of await readdir(stamps)) {
  const name = file.replace(/\.json$/, '');
  if (!packages.some(pkg => pkg.name === name)) await uninstall(name);
}
const pending = [...packages];
let fetched = 0;
await Promise.all(Array.from({ length: 4 }, async () => { for (let pkg; (pkg = pending.shift());) if (await install(pkg)) fetched++; })).catch(error => {
  console.error(error.message);
  process.exit(1);
});
await rm(work, { recursive: true, force: true });
console.log(fetched ? `Fetched ${fetched} of ${packages.length} tool packages into ${path.relative(root, bin)}.` : `All ${packages.length} tool packages in ${path.relative(root, bin)} are up to date.`);
