import { crc32, deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The debug dump (spec step 40, `Clop/DebugDump.swift`): one zip the user can attach to a bug report, with the app's facts, its settings
// (anything named like a secret blanked), its bundled-tool report and its logs. It is only ever written to disk; nothing is sent anywhere.

/** Key names that never go into a dump: the macOS list (`DebugDump.settingsSnapshot`) plus the usual secret names. Clop for Windows has none of these today. */
export const SENSITIVE_KEY = /licen[sc]e|serial|e-?mail|activation|paddle|token|secret|passw(or)?d|credential|api[-_]?key|private[-_]?key/i;
export const REDACTED = '<redacted>';

/**
 * A copy of `value` with every property named like a secret blanked, at any depth. Script steps are blanked too: the code
 * and path of a `runScript` step, and the text of a pipeline (`rawText`) that has one, since a script may hold a token.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    SENSITIVE_KEY.test(key) ? REDACTED
      : key === 'runScript' && entry && typeof entry === 'object' ? Object.fromEntries(Object.keys(entry).map(name => [name, REDACTED]))
        : key === 'rawText' && typeof entry === 'string' && /\brunScript\b/.test(entry) ? REDACTED
          : redact(entry)]));
  return value;
}

export interface ZipEntry { name: string; data: Buffer }
const deflate = promisify(deflateRaw);

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
/** DOS time and date of `date`, as zip stores them (two-second resolution, years from 1980). */
function dosTime(date: Date) {
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

/** A zip archive of `entries`, deflated off the main thread (a dump holds megabytes of logs), with UTF-8 names. Small and complete enough for a few log files: no zip64, no encryption. */
export async function zip(entries: readonly ZipEntry[], modified = new Date()): Promise<Buffer> {
  const { time, date } = dosTime(modified), locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  if (entries.length > 0xfffe) throw new Error('Too many files for a zip.');
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8'), packed = await deflate(entry.data), crc = crc32(entry.data);
    if (name.length > 0xffff || entry.data.length > 0x7fffffff) throw new Error(`${entry.name} is too large for a zip.`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const LOG_TAIL = 5 * 1024 * 1024, LOG_FILES = 30;
/** The newest log files of `dir`, each cut to its last 5 MB. A folder that is not there has no logs. */
export async function readLogs(dir: string): Promise<ZipEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = (await Promise.all(names.filter(name => /\.log(\.\d+)?$/i.test(name)).map(async name => ({ name, info: await stat(path.join(dir, name)).catch(() => undefined) }))))
    .flatMap(file => file.info?.isFile() ? [{ name: file.name, size: file.info.size, mtime: file.info.mtimeMs }] : [])
    .sort((a, b) => b.mtime - a.mtime).slice(0, LOG_FILES);
  const entries: ZipEntry[] = [];
  for (const file of files) {
    const handle = await open(path.join(dir, file.name), 'r').catch(() => undefined);
    if (!handle) continue;
    try {
      const length = Math.min(file.size, LOG_TAIL), data = Buffer.alloc(length);
      const { bytesRead } = await handle.read(data, 0, length, file.size - length);
      entries.push({ name: `logs/${file.name}`, data: data.subarray(0, bytesRead) });
    } finally { await handle.close(); }
  }
  return entries;
}

export interface DumpInput {
  /** The app's facts as text (`appInfo`). */
  info: string;
  settings: unknown;
  /** What each bundled tool is and whether it is there. */
  binaries: string;
  /** The folder with the app's log files. */
  logs: string;
  /** The latest console lines held in memory, which exist even when the log file is off. */
  recent?: string;
}
export const dumpEntries = async ({ info, settings, binaries, logs, recent }: DumpInput): Promise<ZipEntry[]> => [
  { name: 'app-info.txt', data: Buffer.from(info, 'utf8') },
  { name: 'settings.json', data: Buffer.from(`${JSON.stringify(redact(settings), null, 2)}\n`, 'utf8') },
  { name: 'binaries.txt', data: Buffer.from(binaries, 'utf8') },
  ...recent ? [{ name: 'recent-console.log', data: Buffer.from(recent, 'utf8') }] : [],
  ...await readLogs(logs),
];

export const dumpName = (now: Date) => `clop-debug-dump-${now.toISOString().replace(/[:.]/g, '-').replace('Z', '')}.zip`;
const KEEP = 5;

/** Writes the dump into `dir` (beside it, a temporary name first, so a crash never leaves half a zip under the real one) and keeps the newest few. Returns the zip's path. */
export async function writeDump(dir: string, input: DumpInput, now = new Date()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, dumpName(now)), partial = `${file}.partial`;
  try {
    await writeFile(partial, await zip(await dumpEntries(input), now));
    await rename(partial, file);
  } catch (error) { await rm(partial, { force: true }); throw error; }
  const old = (await readdir(dir)).filter(name => /^clop-debug-dump-.*\.zip$/.test(name)).sort().reverse().slice(KEEP);
  await Promise.all(old.map(name => rm(path.join(dir, name), { force: true })));
  return file;
}

export interface AppFacts {
  version: string; electron?: string; chrome?: string; node: string; platform: string; arch: string; os?: string;
  packaged: boolean; portable: boolean; locale?: string; workdir: string; created: Date; settingsFile: string;
}
/** `app-info.txt`: the facts a report needs, one per line. */
export const appInfo = (facts: AppFacts) => [
  `Clop for Windows v${facts.version}${facts.packaged ? '' : ' (development build)'}${facts.portable ? ', portable' : ''}`,
  `system: ${facts.os ?? facts.platform} (${facts.platform} ${facts.arch})`,
  `electron: ${facts.electron ?? '?'}  chrome: ${facts.chrome ?? '?'}  node: ${facts.node}`,
  `locale: ${facts.locale ?? '?'}`,
  `dump created: ${facts.created.toISOString()}`,
  '',
  `workdir: ${facts.workdir}`,
  `settings file: ${facts.settingsFile}`,
  '',
].join('\n');
/** `binaries.txt`: each bundled tool and where it was found, or that it is missing. */
export const binariesReport = (tools: readonly { name: string; path?: string }[]) => `${tools.map(tool => `${tool.name.padEnd(10)} ${tool.path ?? 'MISSING'}`).join('\n')}\n`;
