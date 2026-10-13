import path from 'node:path';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './media/detect';

// Explorer integration (spec step 39): the right-click verbs for files and the Send To shortcut, as plain data. The installer
// (`native/installer.nsh`, kept equal to this by a test) and the portable app's `reg.exe` calls both write this plan, and removing
// the integration removes exactly the keys it names. Only the current user's hive is touched. Every verb launches the app itself
// with its own flag and the files after `--`, so a file named like an option stays a file, and no shell is involved. Explorer starts one
// launch per selected file; they all reach the one running app (Electron's single-instance lock), which gathers them into one selection.
// Without a running app the first launch becomes the app.

const ROOT = 'Software\\Classes\\*\\shell';
const SEND_TO_NAME = 'Optimise with Clop.lnk';
const PDF = ['pdf'];
const extensions = (...lists: string[][]) => lists.flat();

export interface VerbPaths {
  /** The app's own exe: what every verb runs, and the icon. For the portable app, the exe the user started. */
  app: string;
}
export type VerbId = 'optimise' | 'aggressive' | 'downscale' | 'strip-exif' | 'run-pipeline';
/** The argument the app reads for each verb. */
export const VERB_FLAGS: Record<VerbId, string> = {
  optimise: '--clop-optimise', aggressive: '--clop-optimise-aggressive', downscale: '--clop-downscale', 'strip-exif': '--clop-strip-exif', 'run-pipeline': '--clop-run-pipeline',
};
interface Verb { id: string; verb: VerbId; label: string; types: string[] }

// Labels stay ASCII ("Run pipeline..."): the NSIS installer script is not read as UTF-8.
// Strip EXIF works on images and videos; downscale on images, videos and audio; the rest on every supported type.
const ALL = extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, PDF);
const VERBS: Verb[] = [
  { id: 'Optimise', verb: 'optimise', label: 'Optimise with Clop', types: ALL },
  { id: 'OptimiseAggressive', verb: 'aggressive', label: 'Optimise (aggressive)', types: ALL },
  { id: 'Downscale', verb: 'downscale', label: 'Downscale', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS) },
  { id: 'StripExif', verb: 'strip-exif', label: 'Strip EXIF', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS) },
  { id: 'RunPipeline', verb: 'run-pipeline', label: 'Run pipeline...', types: ALL },
];
const command = (app: string, verb: VerbId) => `"${app}" ${VERB_FLAGS[verb]} -- "%1"`;

/**
 * The verb an app launch asks for and the files it names: the paths after `--`. Explorer starts one launch per selected file, so a launch
 * names one file; the app gathers them. Undefined when the launch is not a verb. Only an argument before the first `--` is a flag (a file
 * named like one is just a file) and only full paths count, so a stray word is never taken for a file.
 */
export function explorerVerb(argv: readonly string[]): { verb: VerbId; files: string[] } | undefined {
  const dashes = argv.indexOf('--'), options = dashes < 0 ? argv : argv.slice(0, dashes);
  const verb = (Object.keys(VERB_FLAGS) as VerbId[]).find(id => options.includes(VERB_FLAGS[id]));
  if (!verb) return undefined;
  const files = dashes < 0 ? [] : argv.slice(dashes + 1).filter(file => path.win32.isAbsolute(file) || path.posix.isAbsolute(file));
  return { verb, files: [...new Set(files)] };
}

/** The Explorer filter for the verb: only the file types Clop handles show it. */
export const appliesTo = (types: readonly string[]) => types.map(type => `System.FileExtension:=".${type}"`).join(' OR ');

export interface RegistryValue {
  /** Under HKEY_CURRENT_USER. */
  key: string;
  /** The value's name; empty is the key's default value. */
  name: string;
  value: string;
}
export interface SendToShortcut { file: string; target: string; args: string; icon: string }
export interface VerbPlan {
  values: RegistryValue[];
  /** The verb keys, which removing the integration deletes with everything under them. */
  roots: string[];
  sendTo: SendToShortcut;
}

export function verbPlan(paths: VerbPaths): VerbPlan {
  const values: RegistryValue[] = [], roots: string[] = [];
  for (const verb of VERBS) {
    const key = `${ROOT}\\Clop.${verb.id}`;
    roots.push(key);
    values.push(
      { key, name: '', value: verb.label },
      { key, name: 'Icon', value: `${paths.app},0` },
      { key, name: 'AppliesTo', value: appliesTo(verb.types) },
      { key: `${key}\\command`, name: '', value: command(paths.app, verb.verb) },
    );
  }
  return { values, roots, sendTo: { file: SEND_TO_NAME, target: paths.app, args: `${VERB_FLAGS.optimise} --`, icon: paths.app } };
}

// reg.exe, run with an argument array (no shell) at its absolute path. The calls only build arguments; running them is `electron/explorer.ts`.
export const regExe = () => path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
const hkcu = (key: string) => `HKCU\\${key}`;
/** `reg add`: a REG_SZ value, replacing any existing one. Quotes inside the value reach reg.exe escaped, as it expects. */
export const regAdd = ({ key, name, value }: RegistryValue) => ['add', hkcu(key), ...(name ? ['/v', name] : ['/ve']), '/t', 'REG_SZ', '/d', value, '/f'];
export const regDelete = (key: string) => ['delete', hkcu(key), '/f'];
/** `reg query` of a verb's command: succeeds when the verb is registered. */
export const regQuery = (key: string) => ['query', hkcu(`${key}\\command`), '/ve'];

// The same plan as NSIS statements, between the markers in `native/installer.nsh`; a test keeps the two equal.
/** Where the installer puts the app. */
export const NSIS_PATHS: VerbPaths = { app: '$INSTDIR\\Clop for Windows.exe' };
const nsis = (text: string) => {
  if (text.includes('"') && text.includes("'")) throw new Error(`Cannot quote for NSIS: ${text}`);
  return text.includes('"') ? `'${text}'` : `"${text}"`;
};
export function nsisInstall(plan: VerbPlan): string[] {
  const { file, target, args, icon } = plan.sendTo;
  return [...plan.values.map(({ key, name, value }) => `WriteRegStr HKCU ${nsis(key)} ${nsis(name)} ${nsis(value)}`), `CreateShortCut ${nsis(`$SENDTO\\${file}`)} ${nsis(target)} ${nsis(args)} ${nsis(icon)} 0`];
}
export const nsisUninstall = (plan: VerbPlan): string[] => [...plan.roots.map(key => `DeleteRegKey HKCU ${nsis(key)}`), `Delete ${nsis(`$SENDTO\\${plan.sendTo.file}`)}`];

/** The value `reg query <key> /ve` printed (the text after REG_SZ), or undefined when there is none. */
export const regQueryValue = (output: string) => /\bREG_SZ[ \t]+(.*?)\s*$/m.exec(output)?.[1];
/** The first verb's command for `paths`: what a query of its key must print when the entries are current. */
export const firstCommand = (paths: VerbPaths) => command(paths.app, VERBS[0].verb);
/** The program a verb command runs (its quoted first token). */
export const commandExe = (value: string) => /^"([^"]+)"/.exec(value)?.[1];
