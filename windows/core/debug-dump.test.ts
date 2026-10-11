import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync, crc32 } from 'node:zlib';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import SevenZip from '7z-wasm';
import { REDACTED, appInfo, binariesReport, dumpName, readLogs, redact, writeDump, zip, type ZipEntry } from './debug-dump';
import { defaultSettings } from './settings/schema';

/** Reads a zip through its central directory, as unzip tools do, checking each entry's size and CRC. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = archive.readUInt16LE(end + 10), files = new Map<string, Buffer>();
  let at = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10), crc = archive.readUInt32LE(at + 16), packed = archive.readUInt32LE(at + 20), size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28), local = archive.readUInt32LE(at + 42), name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    assert.equal(method, 8);
    const data = inflateRawSync(archive.subarray(start, start + packed));
    assert.equal(data.length, size, name);
    assert.equal(crc32(data), crc, name);
    files.set(name, data);
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return files;
}

test('secrets are blanked by key name at any depth, and nothing else changes', () => {
  const settings = { apiToken: 'abc', nested: { clientSecret: 's', list: [{ Password: 'p', keep: 1 }], licenseKey: 'k' }, userEmail: 'a@b.c', workdir: 'C:\\work', enabledKeys: ['C'], monkey: 1 };
  assert.deepEqual(redact(settings), { apiToken: REDACTED, nested: { clientSecret: REDACTED, list: [{ Password: REDACTED, keep: 1 }], licenseKey: REDACTED }, userEmail: REDACTED, workdir: 'C:\\work', enabledKeys: ['C'], monkey: 1 });
  assert.equal(settings.apiToken, 'abc', 'the original is untouched');
  // No setting Clop has today is named like a secret, so a dump shows them all.
  assert.deepEqual(redact(defaultSettings()), JSON.parse(JSON.stringify(defaultSettings())));
});

test('the zip reads back with every entry intact, names in UTF-8 and empty files allowed', () => {
  const entries: ZipEntry[] = [{ name: 'a.txt', data: Buffer.from('hello hello hello hello') }, { name: 'logs/ü ñ.log', data: Buffer.from('päivää') }, { name: 'empty.txt', data: Buffer.alloc(0) }, { name: 'big.bin', data: Buffer.alloc(300_000, 7) }];
  const files = unzip(zip(entries, new Date(2026, 9, 11, 12, 30, 40)));
  assert.deepEqual([...files.keys()], ['a.txt', 'logs/ü ñ.log', 'empty.txt', 'big.bin']);
  for (const entry of entries) assert.ok(files.get(entry.name)!.equals(entry.data), entry.name);
});

test('an independent unzip tool accepts the archive', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-zip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'dump.zip'), zip([{ name: 'app-info.txt', data: Buffer.from('x'.repeat(5000)) }, { name: 'logs/clop.log', data: Buffer.from('line\n'.repeat(1000)) }]));
  const output: string[] = [];
  const module = await SevenZip({ print: line => output.push(line), printErr: line => output.push(line) });
  module.FS.mkdir('/work');
  module.FS.mount(module.NODEFS, { root: dir }, '/work');
  module.FS.chdir('/work');
  assert.equal(module.callMain(['t', '-bso0', '-bsp0', 'dump.zip']), 0, output.join('\n'));
  assert.equal(module.callMain(['x', '-y', '-bso0', '-bsp0', 'dump.zip', '-oout']), 0, output.join('\n'));
  assert.equal(await readFile(path.join(dir, 'out', 'logs', 'clop.log'), 'utf8'), 'line\n'.repeat(1000));
});

test('logs: the newest files, each cut to its last 5 MB', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'clop.log'), Buffer.concat([Buffer.alloc(6 * 1024 * 1024, 'a'), Buffer.from('THE END\n')]));
  await writeFile(path.join(dir, 'clop.log.1'), 'older\n');
  await writeFile(path.join(dir, 'notes.txt'), 'not a log');
  await mkdir(path.join(dir, 'folder.log'));
  await utimes(path.join(dir, 'clop.log.1'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const logs = await readLogs(dir);
  assert.deepEqual(logs.map(log => log.name), ['logs/clop.log', 'logs/clop.log.1']);
  assert.equal(logs[0].data.length, 5 * 1024 * 1024);
  assert.equal(logs[0].data.subarray(-8).toString(), 'THE END\n');
  assert.deepEqual(await readLogs(path.join(dir, 'missing')), []);
});

test('a dump holds the app facts, redacted settings, the tool report and the logs, and the folder keeps the newest five', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-dump-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs');
  await mkdir(logs);
  await writeFile(path.join(logs, 'clop.log'), '2026-10-11T10:00:00.000Z log started\n');
  const facts = { version: '0.2.0', electron: '44.7.0', node: '24.1.0', platform: 'win32', arch: 'x64', packaged: true, portable: false, workdir: 'C:\\work', created: new Date(Date.UTC(2026, 9, 11)), settingsFile: 'C:\\settings.json' };
  const input = { info: appInfo(facts), settings: { workdir: 'C:\\work', proxyPassword: 'hunter2', nested: { accessToken: 't' } }, binaries: binariesReport([{ name: 'ffmpeg', path: 'C:\\bin\\ffmpeg.exe' }, { name: 'gs' }]), logs, recent: '2026-10-11T10:00:01.000Z warn the latest line\n' };
  const out = path.join(dir, 'dumps');
  let latest = '';
  for (let day = 1; day <= 7; day++) latest = await writeDump(out, input, new Date(Date.UTC(2026, 9, day, 8)));
  assert.equal(path.basename(latest), dumpName(new Date(Date.UTC(2026, 9, 7, 8))));
  assert.deepEqual((await readdir(out)).sort(), [3, 4, 5, 6, 7].map(day => dumpName(new Date(Date.UTC(2026, 9, day, 8)))));
  const files = unzip(await readFile(latest));
  assert.deepEqual([...files.keys()], ['app-info.txt', 'settings.json', 'binaries.txt', 'recent-console.log', 'logs/clop.log']);
  assert.equal(files.get('recent-console.log')!.toString(), '2026-10-11T10:00:01.000Z warn the latest line\n');
  assert.match(files.get('app-info.txt')!.toString(), /^Clop for Windows v0\.2\.0\nsystem: win32 \(win32 x64\)\nelectron: 44\.7\.0/);
  assert.deepEqual(JSON.parse(files.get('settings.json')!.toString()), { workdir: 'C:\\work', proxyPassword: REDACTED, nested: { accessToken: REDACTED } });
  assert.doesNotMatch(files.get('settings.json')!.toString(), /hunter2/);
  assert.equal(files.get('binaries.txt')!.toString(), 'ffmpeg     C:\\bin\\ffmpeg.exe\ngs         MISSING\n');
  assert.equal(files.get('logs/clop.log')!.toString(), '2026-10-11T10:00:00.000Z log started\n');
});
