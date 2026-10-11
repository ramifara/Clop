import path from 'node:path';
import { expandHome } from '../settings/paths';
import type { ClopSettings } from '../settings/schema';

// openWith: a pipeline can only open a file with an app Windows knows (a running app, a Start menu app or packaged app, an
// App Paths entry), or, for the user's own pipelines, with a program it names by full path.

export interface AppLookup {
  apps: () => Promise<Array<{ name: string; path: string }>>;
  /** The program an App Paths registry entry (`HKCU`/`HKLM\…\App Paths\<name>.exe`) names. */
  appPath: (exeName: string) => Promise<string | undefined>;
  isFile: (file: string) => Promise<boolean>;
  /** Watched folders, where a program is never run from: a file arriving there could be loaded into it. */
  watched: string[];
  allowExe: boolean;
}
/**
 * Programs that run whatever they are handed, or launch other programs: interpreters, shells, script hosts, and the system's
 * launchers. Without script permission (`allowExe`) a file is never opened with one, however it is named or found (a bare name, an
 * App Paths entry, a Start menu entry), since it would run the file or its contents instead of showing it.
 */
const LAUNCHERS = new Set([
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'pwsh-preview', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'conhost', 'explorer',
  'schtasks', 'certutil', 'bitsadmin', 'msbuild', 'installutil', 'regasm', 'regsvcs', 'cmstp', 'forfiles', 'hh', 'wmic', 'wsl', 'bash', 'wt',
  'node', 'py', 'pyw', 'python', 'pythonw', 'ruby', 'perl', 'java', 'javaw', 'deno', 'bun', 'ssh', 'curl', 'regedit', 'mmc', 'pcalua',
  'odbcconf', 'msxsl', 'ieexec', 'mavinject', 'presentationhost', 'winrs', 'csc', 'vbc', 'jsc',
]);
/** Whether a program or app name (with or without a folder and `.exe`) is one of the launcher-class programs. */
export function isLauncher(nameOrPath: string): boolean {
  // Windows ignores trailing dots and spaces in a file name, and the extension decides little here: `cmd.com` runs too.
  const base = path.win32.basename(nameOrPath.trim().replace(/^"(.*)"$/, '$1')).replace(/[. ]+$/, '').toLowerCase().replace(/\.(exe|com|bat|cmd|scr)$/, '');
  return LAUNCHERS.has(base) || /^python\d+(\.\d+)*w?$/.test(base);
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const exeName = (file: string) => path.win32.basename(file).replace(/\.exe$/i, '');
/** The exe path or AUMID that `openWith(app:)` means, or an error saying the app was not found. */
export async function resolveApp(app: string, lookup: AppLookup): Promise<string> {
  const wanted = app.trim().replace(/^"(.*)"$/, '$1');
  if (!wanted) throw new Error('openWith needs the name of an app.');
  // Whatever names a program, it is never run from a watched folder: a file arriving there could be loaded into it. AUMIDs are not paths.
  const inWatched = (target: string) => {
    const inside = isAumid(target) ? undefined : lookup.watched.find(dir => { const relative = path.win32.relative(dir.toLowerCase(), target.toLowerCase()); return !!relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative); });
    if (inside) throw new Error(`${target} is inside the watched folder ${inside}, so Clop does not run it.`);
    return target;
  };
  const refuse = () => new Error(`This pipeline cannot open files with ${exeName(wanted)}: it is a program that runs other programs. Use an app's name from the Start menu.`);
  if (!lookup.allowExe && isLauncher(wanted)) throw refuse();
  // The same rule for what a name turned out to be (an App Paths entry or Start menu app named something harmless).
  const checked = (target: string) => { if (!lookup.allowExe && !isAumid(target) && isLauncher(target)) throw refuse(); return inWatched(target); };
  const apps = await lookup.apps();
  const known = apps.find(entry => same(entry.path, wanted)) ?? apps.find(entry => same(entry.name, wanted))
    ?? apps.find(entry => !isAumid(entry.path) && same(exeName(entry.path), exeName(wanted)) && !/[\\/]/.test(wanted));
  if (known) return checked(known.path);
  if (/^[\w .+-]+$/.test(exeName(wanted)) && !/[\\/]/.test(wanted)) {
    const registered = await lookup.appPath(`${exeName(wanted)}.exe`);
    if (registered && await lookup.isFile(registered)) return checked(registered);
  }
  if (path.win32.isAbsolute(wanted) && /\.exe$/i.test(wanted)) {
    if (!lookup.allowExe) throw new Error(`This pipeline cannot open programs by path: ${wanted}. Use an app's name from the Start menu.`);
    checked(wanted);
    if (await lookup.isFile(wanted)) return wanted;
  }
  throw new Error(`App '${app}' not found. Use the name of an app in the Start menu, or one you have running.`);
}
/** A packaged app's ID (`Publisher.App_hash!App`), as opposed to a program's path. */
export const isAumid = (target: string) => !path.win32.isAbsolute(target);
/** Watched folders of every kind, expanded. */
export const watchedFolders = (settings: Pick<ClopSettings, 'imageDirs' | 'videoDirs' | 'pdfDirs' | 'audioDirs'>, home?: string) =>
  [...settings.imageDirs, ...settings.videoDirs, ...settings.pdfDirs, ...settings.audioDirs].map(dir => path.resolve(expandHome(dir, home)));

/**
 * Whether an `app` value names a program by path (a folder separator or a drive) rather than an app by name. Such a value
 * runs whatever file is there, so only the user's own pipelines may use it (`resolveApp`'s `allowExe`), and an agent saving one
 * needs the permission for script steps.
 */
export const namesProgramByPath = (app: string) => { const wanted = app.trim().replace(/^"(.*)"$/, '$1'); return /[\\/]/.test(wanted) || /^[a-z]:/i.test(wanted); };
