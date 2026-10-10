import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run';
import { TOOL_NAMES, executableName, hasTool, toolDirs, toolPath, toolsDir, type ToolName } from './tools';

const windowsRoot = fileURLToPath(new URL('..', import.meta.url));
const bundle = path.join(windowsRoot, '.tools', 'win32-x64', 'bin');
const packages: { version: string; provides?: ToolName[] }[] = JSON.parse(readFileSync(path.join(windowsRoot, 'scripts', 'tools.json'), 'utf8'))['win32-x64'];
const VERSION_ARGS: Record<ToolName, string[]> = { ffmpeg: ['-version'], ffprobe: ['-version'], gs: ['--version'], gifsicle: ['--version'], gifski: ['--version'], jpegoptim: ['--version'], pngquant: ['--version'], exiftool: ['-ver'], 'heif-dec': ['--version'], 'heif-enc': ['--version'], cjxl: ['--version'], djxl: ['--version'] };

/** Missing tools skip locally; CI must have every tool. */
function requireTool(t: TestContext, name: ToolName) {
  if (hasTool(name)) return true;
  if (process.env.CI) assert.fail(`${name} is missing. Run node scripts/fetch-tools.mjs.`);
  t.skip(`${name} is not installed`);
  return false;
}

function useEnvironment(t: TestContext, values: { CLOP_TOOLS_DIR?: string; PATH: string; resourcesPath?: string }) {
  const proc = process as { resourcesPath?: string };
  const saved = { CLOP_TOOLS_DIR: process.env.CLOP_TOOLS_DIR, PATH: process.env.PATH, resourcesPath: proc.resourcesPath };
  const apply = (next: typeof values) => {
    if (next.CLOP_TOOLS_DIR === undefined) delete process.env.CLOP_TOOLS_DIR; else process.env.CLOP_TOOLS_DIR = next.CLOP_TOOLS_DIR;
    process.env.PATH = next.PATH;
    proc.resourcesPath = next.resourcesPath;
  };
  apply(values);
  t.after(() => apply(saved as typeof values));
}

/** DLL names in a PE file's import table. */
function peImports(pe: Buffer) {
  const header = pe.readUInt32LE(0x3c);
  if (pe.toString('latin1', header, header + 4) !== 'PE\0\0') return [];
  const sections = pe.readUInt16LE(header + 6), optional = header + 24, table = optional + pe.readUInt16LE(header + 20);
  const offset = (rva: number) => {
    for (let s = table; s < table + sections * 40; s += 40) {
      const start = pe.readUInt32LE(s + 12);
      if (rva >= start && rva < start + Math.max(pe.readUInt32LE(s + 8), pe.readUInt32LE(s + 16))) return rva - start + pe.readUInt32LE(s + 20);
    }
    throw new Error(`RVA ${rva} is outside every section`);
  };
  const imports = pe.readUInt32LE(optional + (pe.readUInt16LE(optional) === 0x20b ? 120 : 104));
  const names: string[] = [];
  if (imports) for (let entry = offset(imports); pe.readUInt32LE(entry + 12); entry += 20) {
    const name = offset(pe.readUInt32LE(entry + 12));
    names.push(pe.toString('latin1', name, pe.indexOf(0, name)));
  }
  return names;
}

test('Windows executable names keep the tool names, except Ghostscript', () => {
  assert.equal(executableName('ffmpeg'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  assert.equal(executableName('gs'), process.platform === 'win32' ? 'gswin64c.exe' : 'gs');
});

test('resolves tools from CLOP_TOOLS_DIR, then the packaged resources, then the development cache, then PATH', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const override = path.join(root, 'override'), resources = path.join(root, 'resources'), onPath = path.join(root, 'path');
  for (const dir of [override, path.join(resources, 'bin'), onPath]) await mkdir(dir, { recursive: true });
  useEnvironment(t, { CLOP_TOOLS_DIR: override, resourcesPath: resources, PATH: onPath });
  assert.deepEqual(toolDirs(), [override, path.join(resources, 'bin'), path.join(windowsRoot, '.tools', `${process.platform}-${process.platform === 'win32' ? 'x64' : process.arch}`, 'bin')]);
  assert.equal(toolsDir(), override);

  // A name no real bundle contains, so the development cache never answers first.
  const fake = 'clop-test-tool' as ToolName, exe = executableName(fake);
  const copies = [override, path.join(resources, 'bin'), onPath].map(dir => path.join(dir, exe));
  for (const file of copies) await writeFile(file, '');
  for (const file of copies) {
    assert.equal(toolPath(fake), file);
    await rm(file);
  }
  assert.equal(hasTool(fake), false);
  assert.throws(() => toolPath(fake), /Clop could not find clop-test-tool/);
});

for (const name of TOOL_NAMES) test(`${name} runs and reports its version`, async t => {
  if (!requireTool(t, name)) return;
  const file = toolPath(name);
  let env: NodeJS.ProcessEnv | undefined;
  if (process.platform === 'win32' && existsSync(bundle)) {
    // Only the bundle and Windows itself on PATH, so a DLL the bundle lacks cannot be borrowed from another install.
    const windows = process.env.SystemRoot ?? 'C:\\Windows';
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    env.PATH = [bundle, path.join(windows, 'System32'), windows].join(';');
  }
  const { stdout } = await run(name, VERSION_ARGS[name], { env, timeoutMs: 60_000 });
  const version = stdout.toString().trim().split(/\r?\n/)[0];
  t.diagnostic(`${name}: ${version} (${file})`);
  assert.ok(version);
  if (process.env.CI && process.platform === 'win32') {
    assert.equal(path.dirname(file), bundle);
    const pinned = packages.find(pkg => pkg.provides?.includes(name))!.version;
    assert.ok(version.includes(pinned), `${name} reported ${version}, expected ${pinned}`);
  }
});

test('the Windows bundle carries every DLL its programs load, apart from Windows system DLLs', { skip: process.platform !== 'win32' && 'checks a Windows bundle against System32' }, async t => {
  if (!existsSync(bundle)) {
    if (process.env.CI) assert.fail('The tool bundle is missing. Run node scripts/fetch-tools.mjs.');
    return t.skip('the tool bundle has not been fetched');
  }
  const files = await readdir(bundle);
  const shipped = new Set(files.map(file => file.toLowerCase()));
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const missing: string[] = [];
  for (const file of files.filter(file => /\.(exe|dll)$/i.test(file))) for (const dll of peImports(await readFile(path.join(bundle, file)))) {
    const lower = dll.toLowerCase();
    if (shipped.has(lower) || /^(api|ext)-ms-/.test(lower)) continue;
    // The Visual C++ runtime is often installed system-wide, but end users cannot be assumed to have it.
    if (!/^(vcruntime|msvcp|concrt|vccorlib)/.test(lower) && existsSync(path.join(system32, dll))) continue;
    missing.push(`${file} needs ${dll}`);
  }
  assert.deepEqual(missing, []);
});
