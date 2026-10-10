// Prints tools.json entries for MSYS2 UCRT64 tools and every DLL they load, with sha256, from the current repository.
// repo.msys2.org prunes old versions, so rerun this when a pinned package URL stops downloading:
//   npx tsx scripts/resolve-msys2.ts libheif:heif-dec,heif-enc pngquant:pngquant
// Each argument is <package>:<tool>[,<tool>...]; the tools are the package's bin/<tool>.exe. Following real PE imports
// rather than package dependencies keeps out libraries the tools never load (SDL2 for heif-view, for example).
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { peImports } from './pe-imports';

const REPO = 'https://repo.msys2.org/mingw/ucrt64/', PREFIX = 'mingw-w64-ucrt-x86_64-';
interface Package { name: string; version: string; filename: string; sha256: string; license: string; files: string[]; depends: string[] }

function untar(tar: Buffer) {
  const entries = new Map<string, Buffer>();
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length && tar[at];) {
    const field = (start: number, length: number) => tar.toString('latin1', at + start, at + start + length).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8), type = field(156, 1), body = tar.subarray(at + 512, at + 512 + size);
    const prefix = field(345, 155), name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
    else if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '') entries.set(name, body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const wanted = process.argv.slice(2).map(arg => { const [name, tools] = arg.split(':'); return { name, tools: tools?.split(',').filter(Boolean) ?? [] }; });
if (!wanted.length || wanted.some(w => !w.tools.length)) {
  console.error('Usage: npx tsx scripts/resolve-msys2.ts <package>:<tool>[,<tool>...] ...');
  process.exit(1);
}

const packages = new Map<string, Package>(), owners = new Map<string, Package[]>();
const db = untar(zstdDecompressSync(await download(`${REPO}ucrt64.files`)));
for (const [entry, body] of db) {
  if (!entry.endsWith('/desc')) continue;
  const fields = new Map(body.toString('utf8').split('\n\n').map(block => { const [key, ...values] = block.trim().split('\n'); return [key, values] as const; }));
  const pkg: Package = { name: fields.get('%NAME%')![0], version: fields.get('%VERSION%')![0], filename: fields.get('%FILENAME%')![0], sha256: fields.get('%SHA256SUM%')![0], license: (fields.get('%LICENSE%') ?? []).join(' AND ').replace(/spdx:/g, ''), files: db.get(entry.replace(/desc$/, 'files'))!.toString('utf8').split('\n').slice(1).filter(Boolean), depends: (fields.get('%DEPENDS%') ?? []).map(dep => dep.split(/[<>=]/)[0]) };
  packages.set(pkg.name, pkg);
  for (const file of pkg.files) if (/^ucrt64\/bin\/[^/]+\.dll$/i.test(file)) owners.set(file.slice(11).toLowerCase(), [...owners.get(file.slice(11).toLowerCase()) ?? [], pkg]);
}

const contents = new Map<string, Map<string, Buffer>>();
async function open(pkg: Package) {
  if (!contents.has(pkg.name)) {
    const archive = await download(REPO + pkg.filename);
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== pkg.sha256) throw new Error(`${pkg.filename}: sha256 is ${actual}, the repository says ${pkg.sha256}`);
    contents.set(pkg.name, untar(zstdDecompressSync(archive)));
  }
  return contents.get(pkg.name)!;
}

const needed = new Map<string, { pkg: Package; files: Set<string>; usedBy: Set<string> }>();
for (const { name, tools } of wanted) {
  const root = packages.get(PREFIX + name);
  if (!root) throw new Error(`MSYS2 has no package ${PREFIX}${name}.`);
  // Several packages can ship the same DLL (zlib and zlib-ng-compat both ship zlib1.dll); take the one the tool depends on.
  const dependencies = new Set([root.name]);
  for (const name of dependencies) for (const dep of packages.get(name)?.depends ?? []) dependencies.add(dep);
  const queue = tools.map(tool => ({ pkg: root, file: `ucrt64/bin/${tool}.exe` })), seen = new Set<string>();
  for (let item; (item = queue.shift());) {
    if (seen.has(item.file)) continue;
    seen.add(item.file);
    const body = (await open(item.pkg)).get(item.file);
    if (!body) throw new Error(`${item.pkg.name} has no ${item.file}.`);
    if (!needed.has(item.pkg.name)) needed.set(item.pkg.name, { pkg: item.pkg, files: new Set(), usedBy: new Set() });
    const entry = needed.get(item.pkg.name)!;
    entry.files.add(item.file);
    for (const tool of tools) entry.usedBy.add(tool);
    for (const dll of peImports(body)) {
      const candidates = owners.get(dll.toLowerCase()) ?? [], owner = candidates.find(pkg => dependencies.has(pkg.name)) ?? candidates[0];
      if (owner) queue.push({ pkg: owner, file: `ucrt64/bin/${owner.files.find(file => file.toLowerCase() === `ucrt64/bin/${dll.toLowerCase()}`)!.slice(11)}` });
    }
  }
}

const json = (value: unknown) => JSON.stringify(value).replace(/","/g, '", "').replace(/":"/g, '": "');
const lines = [...needed.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name)).map(({ pkg, files, usedBy }) => {
  const short = pkg.name.slice(PREFIX.length), root = wanted.find(w => w.name === short);
  // A tool's package records the upstream version, which is what the tool prints and what CI checks.
  const fields = { name: `msys2-${short}`, version: root ? pkg.version.replace(/-\d+$/, '') : pkg.version, ...(root ? { provides: root.tools } : { usedBy: [...usedBy].sort() }), license: pkg.license, url: REPO + pkg.filename, sha256: pkg.sha256, archive: 'tar.zst', files: Object.fromEntries([...files].sort().map(file => [file, file.slice(11)])) };
  return `    { ${Object.entries(fields).map(([key, value]) => `"${key}": ${json(value)}`).join(', ')} }`;
});
console.log(lines.join(',\n'));
