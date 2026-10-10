// Downloads the command-line tools pinned in tools.json, checks their sha256 and copies the listed files into
// .tools/<platform>-<arch>/bin, which electron-builder ships as resources/bin. Packages already installed at
// the pinned hash are skipped, so repeated runs and CI cache hits do no network work.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import SevenZip from '7z-wasm';

const root = path.resolve(import.meta.dirname, '..');
// x64 is the only Windows set; ARM64 Windows runs it under emulation.
const { values: options } = parseArgs({ options: { platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: 'x64' } } });
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
const NOTICES = 'THIRD_PARTY_NOTICES.txt';
const owners = new Map([['licenses', 'the licence folder'], [NOTICES, 'the notices file']]);
for (const pkg of packages) for (const file of Object.values(pkg.files)) {
  if (owners.has(file)) throw new Error(`tools.json: ${pkg.name} and ${owners.get(file)} both install ${file}.`);
  owners.set(file, pkg.name);
}

const readStamp = async name => { try { return JSON.parse(await readFile(path.join(stamps, `${name}.json`), 'utf8')); } catch { return undefined; } };
async function uninstall(name) {
  for (const file of (await readStamp(name))?.files ?? []) await rm(path.join(bin, file), { recursive: true, force: true });
  await rm(path.join(stamps, `${name}.json`), { force: true });
}

// node:https rather than fetch: undici's fetch body crashed the process with an internal assertion when a paused
// download's socket ended, during parallel downloads on the Windows runner.
function get(url, signal, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { signal }, response => {
      const { statusCode = 0, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects) {
        response.resume();
        resolve(get(new URL(headers.location, url).href, signal, redirects - 1));
      } else if (statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${statusCode}`));
      } else resolve(response);
    }).on('error', reject);
  });
}

// Downloads url to file and checks its sha256; label names the package in messages.
async function download({ name: label, url, sha256 }, file) {
  for (let attempt = 1; ; attempt++) {
    const hash = createHash('sha256');
    try {
      const signal = AbortSignal.timeout(10 * 60_000);
      await pipeline(await get(url, signal), new Transform({ transform(chunk, _, done) { hash.update(chunk); done(null, chunk); } }), createWriteStream(file), { signal });
    } catch (error) {
      if (attempt === 3) throw new Error(`${label}: could not download ${url}: ${error.message}`);
      console.warn(`${label}: download failed (${error.message}), retrying`);
      await delay(2000 * attempt);
      continue;
    }
    // A complete download with the wrong hash will not change on retry.
    const actual = hash.digest('hex');
    if (actual !== sha256) throw new Error(`${label}: sha256 of ${url} is ${actual}, expected ${sha256}.`);
    return;
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
  if (type === 'conda') {
    // A conda package keeps its files in pkg-*.tar.zst and its licence texts in info-*.tar.zst.
    await sevenZip(dir, [archive, '-oconda']);
    const inner = await readdir(path.join(dir, 'conda'));
    for (const [prefix, wanted] of [['pkg-', paths.filter(file => !file.startsWith('info/'))], ['info-', paths.filter(file => file.startsWith('info/'))]]) {
      if (wanted.length) await extract(dir, `conda/${inner.find(file => file.startsWith(prefix) && file.endsWith('.tar.zst'))}`, 'tar.zst', wanted);
    }
    return path.join(dir, 'out');
  }
  if (type === 'tar.xz' || type === 'tar.zst') {
    const tar = `tar-${path.basename(archive)}`;
    await sevenZip(dir, [archive, `-o${tar}`]);
    archive = `${tar}/${(await readdir(path.join(dir, tar)))[0]}`;
  } else if (!['zip', '7z', 'nsis'].includes(type)) throw new Error(`Unknown archive type ${type}.`);
  await sevenZip(dir, [archive, '-oout', ...paths]);
  return path.join(dir, 'out');
}

async function install(pkg) {
  // Licence texts go to licenses/<package>/, from the archive or, where it has none, from pinned URLs.
  const licenseDir = path.join('licenses', pkg.name), licenses = pkg.licenses ?? [], texts = pkg.licenseTexts ?? [];
  const licenseNames = [...licenses.map(from => path.posix.basename(from)), ...texts.map(text => text.file)];
  if (!licenseNames.length || new Set(licenseNames).size !== licenseNames.length) throw new Error(`tools.json: ${pkg.name} needs licence files with distinct names.`);
  const files = [...Object.entries(pkg.files), ...licenses.map(from => [from, path.join(licenseDir, path.posix.basename(from))])];
  const installed = [...Object.values(pkg.files), licenseDir], expected = [...Object.values(pkg.files), ...licenseNames.map(name => path.join(licenseDir, name))];
  const entry = createHash('sha256').update(JSON.stringify(pkg)).digest('hex'), stamp = await readStamp(pkg.name);
  if (stamp?.entry === entry && expected.every(to => existsSync(path.join(bin, to)))) return false;
  await uninstall(pkg.name);
  const dir = path.join(work, pkg.name), archive = path.basename(new URL(pkg.url).pathname);
  await mkdir(dir, { recursive: true });
  await download(pkg, path.join(dir, archive));
  const out = await extract(dir, archive, pkg.archive, files.map(([from]) => from));
  for (const [from, to] of files) {
    if (!existsSync(path.join(out, from))) throw new Error(`${pkg.name}: ${from} is not in ${pkg.url}.`);
    await cp(path.join(out, from), path.join(bin, to), { recursive: true, force: true });
  }
  await mkdir(path.join(bin, licenseDir), { recursive: true });
  for (const text of texts) await download({ name: pkg.name, ...text }, path.join(bin, licenseDir, text.file));
  await writeFile(path.join(stamps, `${pkg.name}.json`), `${JSON.stringify({ version: pkg.version, entry, files: installed })}\n`);
  await rm(dir, { recursive: true, force: true });
  console.log(`${pkg.name} ${pkg.version}`);
  return true;
}

function notices() {
  const header = `Clop for Windows
Copyright (C) the Lowtech Guys and Clop contributors

Clop for Windows is free software: you can redistribute it and/or modify it under the terms of the GNU General
Public License, version 3, as published by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. The licence is in
../LICENSE and the source code is at https://github.com/ramifara/Clop.

Third-party programs

The programs and libraries below run in separate processes started by Clop and are distributed unmodified under
their own licences. Their licence texts and notices are in licenses/<package>/. For programs under the GPL, LGPL
or AGPL, the corresponding source code of the exact version shipped is available from the source addresses listed.`;
  const entries = packages.map(pkg => [
    `${pkg.name} ${pkg.version}`,
    `  Licence: ${pkg.license}, texts in licenses/${pkg.name}/`,
    `  ${pkg.provides ? `Provides: ${pkg.provides.join(', ')}` : `Used by: ${pkg.usedBy.join(', ')}`}`,
    `  Homepage: ${pkg.homepage}`,
    `  Binary: ${pkg.url}`,
    `  SHA-256: ${pkg.sha256}`,
    ...(pkg.sources ?? []).map((source, index) => `  ${index ? '        ' : 'Source: '}${source}`),
  ].join('\n'));
  return `${[header, ...entries].join('\n\n')}\n`.replace(/\n/g, '\r\n');
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
await writeFile(path.join(bin, NOTICES), notices());
console.log(fetched ? `Fetched ${fetched} of ${packages.length} tool packages into ${path.relative(root, bin)}.` : `All ${packages.length} tool packages in ${path.relative(root, bin)} are up to date.`);
