import os from 'node:os';
import path from 'node:path';

/** Folders that path-valued setting defaults are built from. Electron passes its own; headless callers use the environment. */
export interface DefaultPaths { home: string; desktop: string; userData: string }

export function defaultPaths(): DefaultPaths {
  const home = os.homedir();
  const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return { home, desktop: path.join(home, 'Desktop'), userData: path.join(appData, 'Clop for Windows') };
}

/** Port of `String.resolvedPath` (Shared.swift): a leading `~`, `$HOME` or `${HOME}` becomes the user profile folder. Other paths come back unchanged. */
export function expandHome(value: string, home = os.homedir(), pathApi: Pick<typeof path, 'join'> = path): string {
  const prefix = /^(~|\$HOME|\$\{HOME\})(?=$|[\\/])/.exec(value)?.[0];
  return prefix ? pathApi.join(home, value.slice(prefix.length)) : value;
}

/** Port of `String.portablePath` (Shared.swift): a path inside `home` becomes `~/…` (forward slashes, as on macOS); other paths come back unchanged. */
export function portablePath(value: string, home = os.homedir()): string {
  const relative = path.relative(home, value);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value;
  return relative ? `~/${relative.split(path.sep).join('/')}` : '~';
}
