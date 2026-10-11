import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaName } from '../core/settings/entries';
import { settingsMeta } from '../core/settings/meta';
import { expandHome, portablePath } from '../core/settings/paths';
import type { ClopSettings, SettingKey } from '../core/settings/schema';
import { expandPathTemplate, expandTemplate } from '../core/template';
import type { AppEntry, PrefsReply, PrefsRequest } from '../src/types';

// The Settings window's actions that need the main process (the policy in `electron/settings.ts`): the folder and program pickers,
// the lists whose entries must be real, and the template preview. Each action is checked here, whatever the window sent.

export interface PrefsHost {
  settings(): ClopSettings;
  defaults(): ClopSettings;
  set(partial: Partial<ClopSettings>): Promise<unknown>;
  /**
   * A change that depends on the stored value (one entry of a list): `change` gets the settings as they are when its turn comes,
   * after every change before it, and returns the values to replace. It throws to refuse. Two clicks in a row never undo each other.
   */
  update(change: (current: ClopSettings) => Partial<ClopSettings>): Promise<unknown>;
  /** Shows the picker and gives the chosen path, or undefined when it was cancelled. */
  chooseFolder(title: string, defaultPath?: string): Promise<string | undefined>;
  chooseProgram(title: string): Promise<string | undefined>;
  apps(): Promise<AppEntry[]>;
  /** Opens the pipeline editor window, on its preset zones when `tab` is `zones`. */
  openEditor(tab?: 'zones'): void | Promise<void>;
  openExternal(url: string): Promise<void>;
  version(): { name: string; platform: string };
  /** Checks for updates now and gives the message for the Settings window, or nothing when a dialog took over (a new version). */
  checkUpdates(): Promise<string | undefined>;
  /** Writes the debug dump and shows it in Explorer; gives the file. */
  saveDebugDump(): Promise<string>;
  home: string;
  platform?: NodeJS.Platform;
}

export const LINKS = { releases: 'https://github.com/ramifara/Clop/releases', source: 'https://github.com/ramifara/Clop', upstream: 'https://github.com/FuzzyIdeas/Clop', issues: 'https://github.com/ramifara/Clop/issues' } as const;
const KINDS = ['image', 'video', 'audio', 'pdf'] as const;
const DIRS = { image: 'imageDirs', video: 'videoDirs', audio: 'audioDirs', pdf: 'pdfDirs' } as const;
const EDITORS = { image: 'editorAppImage', video: 'editorAppVideo', audio: 'editorAppAudio', pdf: 'editorAppPDF' } as const;
const MAX_FOLDERS = 100, MAX_IGNORED = 500, MAX_TEMPLATE = 1024, MAX_PATH = 32_767;

/** The example file each template previews, and what a conversion makes of it. */
const SAMPLES = { image: ['Screenshot.png', 'jpeg'], video: ['Recording.mov', 'mp4'], audio: ['Voice memo.wav', 'm4a'], pdf: ['Invoice.pdf', 'pdf'] } as const;
const TEMPLATE_KEY = /^(converted)?[Ss](ame|pecific)FolderNameTemplate(Image|Video|Audio|PDF)$/;
export const TEMPLATE_KEYS = ['customNameTemplateForClipboardImages', ...(['Image', 'Video', 'Audio', 'PDF'] as const).flatMap(kind => [`sameFolderNameTemplate${kind}`, `specificFolderNameTemplate${kind}`, `convertedSameFolderNameTemplate${kind}`, `convertedSpecificFolderNameTemplate${kind}`])] as SettingKey[];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, what: string, max = MAX_PATH) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Choose ${what}.`);
  return value;
};
const oneOf = <T extends string>(value: unknown, options: readonly T[], what: string): T => {
  if (!options.includes(value as T)) throw new Error(`Choose ${what}.`);
  return value as T;
};

export function createPrefs(host: PrefsHost) {
  const platform = host.platform ?? process.platform, p = platform === 'win32' ? path.win32 : path.posix;
  const same = (a: string, b: string) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const resolve = (value: string) => p.normalize(expandHome(value, host.home, p)).replace(/(?<=.)[\\/]+$/, '');
  const portable = (value: string) => portablePath(value, host.home);

  async function directory(chosen: string | undefined, what: string) {
    if (!chosen) return undefined;
    if (!p.isAbsolute(chosen) || chosen.length > MAX_PATH || chosen.includes('\0')) throw new Error(`${what} must be a folder with a full path.`);
    if (!(await stat(chosen).catch(() => undefined))?.isDirectory()) throw new Error(`${chosen} is not a folder.`);
    return p.normalize(chosen);
  }
  async function program(chosen: string | undefined) {
    if (!chosen) return undefined;
    if (!p.isAbsolute(chosen) || chosen.length > MAX_PATH || chosen.includes('\0')) throw new Error('Choose a program with a full path.');
    if (platform === 'win32' && !/\.exe$/i.test(chosen)) throw new Error('Choose a program (.exe).');
    if (!(await stat(chosen).catch(() => undefined))?.isFile()) throw new Error(`${chosen} is not a file.`);
    return p.normalize(chosen);
  }

  async function workdir(op: unknown): Promise<PrefsReply> {
    if (oneOf(op, ['choose', 'reset'], 'what to do with the working directory') === 'reset') {
      await host.set({ workdir: host.defaults().workdir });
      return { message: 'Clop will use its default working directory after it restarts.' };
    }
    const folder = await directory(await host.chooseFolder('Choose the working directory', resolve(host.settings().workdir)), 'The working directory');
    if (!folder) return {};
    await access(folder, constants.W_OK).catch(() => { throw new Error(`Clop cannot write to ${folder}. Choose a folder you can change.`); });
    await host.set({ workdir: portable(folder) });
    return { message: `Clop will use ${folder} after it restarts.` };
  }

  async function folder(kind: MediaName, op: unknown, given: unknown): Promise<PrefsReply> {
    const key = DIRS[oneOf(kind, KINDS, 'a file type')];
    const tooMany = (current: readonly string[]) => { if (current.length >= MAX_FOLDERS) throw new Error(`Clop watches up to ${MAX_FOLDERS} folders for each file type.`); };
    if (oneOf(op, ['add', 'remove'], 'what to do with the folder') === 'add') {
      tooMany(host.settings()[key]);
      const chosen = await directory(await host.chooseFolder(`Choose a folder to watch for new ${kind === 'pdf' ? 'PDFs' : `${kind} files`}`), 'A watched folder');
      if (!chosen) return {};
      await host.update(settings => {
        const current = settings[key];
        tooMany(current);
        if (current.some(dir => same(resolve(dir), resolve(chosen)))) throw new Error(`${chosen} is already watched.`);
        return { [key]: [...current, portable(chosen)] };
      });
      return {};
    }
    const target = resolve(text(given, 'a folder to stop watching'));
    await host.update(settings => {
      const current = settings[key];
      if (!current.some(dir => same(resolve(dir), target))) throw new Error('That folder is not in the list.');
      // A folder left in no list takes its quiet setting with it.
      const stillWatched = KINDS.some(other => other !== kind && settings[DIRS[other]].some(dir => same(resolve(dir), target)));
      return { [key]: current.filter(dir => !same(resolve(dir), target)), ...(stillWatched ? {} : { dirsHideFloatingResult: settings.dirsHideFloatingResult.filter(dir => !same(resolve(dir), target)) }) };
    });
    return {};
  }

  async function quiet(given: unknown, hide: unknown): Promise<PrefsReply> {
    if (typeof hide !== 'boolean') throw new Error('Choose whether results from this folder show.');
    const target = resolve(text(given, 'a watched folder'));
    await host.update(s => {
      const stored = KINDS.flatMap(kind => s[DIRS[kind]]).find(dir => same(resolve(dir), target));
      if (!stored) throw new Error('That folder is not watched.');
      const others = s.dirsHideFloatingResult.filter(dir => !same(resolve(dir), target));
      return { dirsHideFloatingResult: hide ? [...others, stored] : others };
    });
    return {};
  }

  async function editor(kind: MediaName, op: unknown): Promise<PrefsReply> {
    const key = EDITORS[oneOf(kind, KINDS, 'a file type')];
    if (oneOf(op, ['choose', 'clear'], 'what to do with the editor') === 'clear') { await host.set({ [key]: '' }); return {}; }
    const chosen = await program(await host.chooseProgram(`Choose the program that edits ${kind === 'pdf' ? 'PDFs' : `${kind} files`}`));
    if (chosen) await host.set({ [key]: chosen });
    return {};
  }

  async function ignore(op: unknown, given: unknown): Promise<PrefsReply> {
    const has = (list: readonly string[], entry: string) => list.some(other => other.toLowerCase() === entry.toLowerCase());
    const action = oneOf(op, ['add', 'remove', 'choose'], 'what to do with the ignored apps');
    if (action === 'remove') {
      const entry = text(given, 'an app to stop ignoring');
      await host.update(settings => {
        if (!has(settings.clipboardIgnoredAppBundleIds, entry)) throw new Error('That app is not in the list.');
        return { clipboardIgnoredAppBundleIds: settings.clipboardIgnoredAppBundleIds.filter(other => other.toLowerCase() !== entry.toLowerCase()) };
      });
      return {};
    }
    const tooMany = (current: readonly string[]) => { if (current.length >= MAX_IGNORED) throw new Error(`Clop ignores up to ${MAX_IGNORED} apps.`); };
    tooMany(host.settings().clipboardIgnoredAppBundleIds);
    // From the list the Windows helper made, or a program the user picked: nothing the window typed is stored.
    const entry = action === 'choose' ? await program(await host.chooseProgram('Choose a program to ignore')) : (await host.apps()).find(app => app.path.toLowerCase() === text(given, 'an app to ignore').toLowerCase())?.path;
    if (action === 'add' && !entry) throw new Error('Clop does not know that app. Pick it from the list, or choose its program.');
    if (!entry) return {};
    await host.update(settings => {
      const current = settings.clipboardIgnoredAppBundleIds;
      if (has(current, entry)) return {};
      tooMany(current);
      return { clipboardIgnoredAppBundleIds: [...current, entry] };
    });
    return {};
  }

  function template(key: unknown, value: unknown): PrefsReply {
    if (!TEMPLATE_KEYS.includes(key as SettingKey)) throw new Error('Choose a name template setting.');
    if (typeof value !== 'string' || value.length > MAX_TEMPLATE) throw new Error(`Use a template up to ${MAX_TEMPLATE} characters long.`);
    const match = TEMPLATE_KEY.exec(key as string), kind = (match ? match[3].toLowerCase() : 'image') as MediaName, converted = !!match?.[1];
    const specific = match?.[2] === 'pecific', [input, target] = SAMPLES[kind], windows = platform === 'win32';
    const folderOf = windows ? 'C:\\Users\\You\\Pictures' : '/home/you/Pictures';
    const ext = converted ? target : path.extname(input).slice(1);
    const from = p.join(folderOf, input), made = p.join(folderOf, `${p.parse(input).name}.${ext}`);
    const defaults = host.defaults()[key as keyof ClopSettings] as string, effective = value.trim() ? value : defaults;
    const counter = { value: host.settings().lastAutoIncrementingNumber };
    const ctx = { path: made, counter, platform, home: host.home };
    const output = specific ? expandPathTemplate(effective, ctx) : expandTemplate(effective || '%f', ctx);
    return { preview: { input: p.basename(from), output: specific ? output : p.basename(output) } };
  }

  /** Handles one request from the Settings window. */
  return async function prefs(request: unknown): Promise<PrefsReply> {
    if (!isObject(request)) throw new Error('Choose a settings action.');
    switch (request.action) {
      case 'meta': return { meta: settingsMeta() };
      case 'template': return template(request.key, request.template);
      case 'workdir': return workdir(request.op);
      case 'folder': return folder(request.kind as MediaName, request.op, request.folder);
      case 'quiet': return quiet(request.folder, request.quiet);
      case 'editor': return editor(request.kind as MediaName, request.op);
      case 'ignore': return ignore(request.op, request.entry);
      case 'pipeline-editor': await host.openEditor(request.tab === undefined ? undefined : oneOf(request.tab, ['zones'] as const, 'a pipeline editor tab')); return {};
      case 'open': await host.openExternal(LINKS[oneOf(request.target, Object.keys(LINKS) as (keyof typeof LINKS)[], 'a link')]); return {};
      case 'version': return { version: host.version() };
      case 'check-updates': { const message = await host.checkUpdates(); return message ? { message } : {}; }
      case 'debug-dump': return { message: `Saved ${path.basename(await host.saveDebugDump())} and showed it in Explorer. Attach it when you report a problem.` };
      default: throw new Error('Unknown settings action.');
    }
  };
}
