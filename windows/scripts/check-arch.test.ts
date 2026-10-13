import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { X64_ON_ARM64, checkArch, machineOf } from './check-arch.mjs';

const MACHINE = { x64: 0x8664, arm64: 0xaa64, x86: 0x14c } as const;
/** The smallest header machineOf reads: "MZ", the PE offset at 0x3c, then "PE\0\0" and the machine. */
function pe(machine: keyof typeof MACHINE) {
  const bytes = Buffer.alloc(0x80);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write('PE\0\0', 0x40, 'latin1');
  bytes.writeUInt16LE(MACHINE[machine], 0x44);
  return bytes;
}

async function app(t: { after(fn: () => Promise<void>): void }, arch: 'x64' | 'arm64', files: Record<string, keyof typeof MACHINE>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-arch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [file, machine] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), pe(machine));
  }
  return { dir, arch };
}

test('machineOf reads the CPU of a PE file', async t => {
  const { dir } = await app(t, 'x64', { 'a.exe': 'x64', 'b.dll': 'arm64', 'c.exe': 'x86' });
  assert.deepEqual([await machineOf(path.join(dir, 'a.exe')), await machineOf(path.join(dir, 'b.dll')), await machineOf(path.join(dir, 'c.exe'))], ['x64', 'arm64', 'x86']);
  await writeFile(path.join(dir, 'text.exe'), 'not a program');
  await assert.rejects(machineOf(path.join(dir, 'text.exe')), /not a Windows program/);
});

test('an ARM64 app is native except for the tools that have no ARM64 build, and carries only the ARM64 sharp', async t => {
  const { dir } = await app(t, 'arm64', {
    'Clop for Windows.exe': 'arm64', 'resources/bin/ffmpeg.exe': 'arm64', 'resources/bin/libheif.dll': 'arm64', 'resources/bin/gswin64c.exe': 'x64', 'resources/bin/vcruntime140.dll': 'x64',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-arm64/lib/sharp-win32-arm64-0.35.5.node': 'arm64', 'resources/app.asar.unpacked/node_modules/@img/sharp-win32-arm64/lib/libvips-42.dll': 'arm64',
  });
  assert.deepEqual(await checkArch('arm64', dir), { problems: [], checked: 7 });
  assert.ok(X64_ON_ARM64.includes('gswin64c.exe'));
});

test('a native tool that is really x64, an x64 sharp in an ARM64 app and an emulated tool that became ARM64 are all reported', async t => {
  const { dir } = await app(t, 'arm64', {
    'Clop for Windows.exe': 'arm64', 'resources/bin/ffmpeg.exe': 'x64', 'resources/bin/gifski.exe': 'arm64',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-arm64/lib/sharp-win32-arm64-0.35.5.node': 'arm64', 'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node': 'x64',
  });
  const { problems } = await checkArch('arm64', dir);
  assert.deepEqual(problems.map(problem => problem.replaceAll('\\', '/')), [
    'resources/bin/ffmpeg.exe is x64, expected arm64',
    'resources/bin/gifski.exe is arm64, expected x64',
    '@img holds sharp-win32-arm64, sharp-win32-x64, expected sharp-win32-arm64',
  ]);
});

test('an x64 app has x64 everywhere, tools included', async t => {
  const { dir } = await app(t, 'x64', {
    'Clop for Windows.exe': 'x64', 'resources/bin/gswin64c.exe': 'x64', 'resources/bin/ffmpeg.exe': 'x64',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node': 'x64',
  });
  assert.deepEqual((await checkArch('x64', dir)).problems, []);
});

test('the files expected to be x64 in an ARM64 app are those of the packages in the ARM64 set that are not ARM64 builds', () => {
  const set: { name: string; url: string; files: Record<string, string> }[] = JSON.parse(readFileSync(new URL('tools.json', import.meta.url), 'utf8'))['win32-arm64'];
  const native = (url: string) => /winarm64|clang-aarch64/.test(url);
  const emulated = set.filter(pkg => !native(pkg.url)).flatMap(pkg => Object.values(pkg.files)).filter(file => /\.(exe|dll)$/i.test(file));
  assert.deepEqual(emulated.map(file => file.toLowerCase()).sort(), [...X64_ON_ARM64].sort());
  assert.deepEqual(set.filter(pkg => !native(pkg.url)).map(pkg => pkg.name).sort(), ['exiftool', 'ghostscript', 'gifsicle', 'gifski', 'vc-runtime']);
});
