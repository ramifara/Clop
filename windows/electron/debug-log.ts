import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'node:util';

// The debug log `clop logs persist on` turns on (the `persistDebugLogs` setting). macOS keeps Clop's messages in the
// system log; on Windows the main process's console messages go to `logs\clop.log` in the app data folder, which rolls
// over to `clop.log.1` past 5 MB. The latest few hundred lines are also kept in memory for the debug dump.

const LIMIT = 5 * 1024 * 1024, RECENT = 400;
// The last lines are kept in memory whether or not the file log is on, so a debug dump can show what just happened.
const recent: string[] = [];
export const recentConsole = () => recent.join('');

export function mirrorConsoleToFile(file: string, enabled: () => boolean) {
  let writes = Promise.resolve();
  const write = (line: string) => {
    writes = writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      if (((await stat(file).catch(() => undefined))?.size ?? 0) > LIMIT) await rename(file, `${file}.1`);
      await appendFile(file, line);
    }).catch(() => {});
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
      recent.push(line); if (recent.length > RECENT) recent.shift();
      if (enabled()) write(line);
    };
  }
}
