import path from 'node:path';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './media/detect';

// Explorer integration (spec step 39): the right-click verbs for files and the Send To shortcut, as plain data. The installer
// (`native/installer.nsh`, kept equal to this by a test) and the portable app's `reg.exe` calls both write this plan, and removing
// the integration removes exactly the keys it names. Only the current user's hive is touched, and no verb runs anything but
// `clop.exe` (or the app itself, for the one that needs its window) with the file after `--`, so a file named like an option stays a file.

const ROOT = 'Software\\Classes\\*\\shell';
const SEND_TO_NAME = 'Optimise with Clop.lnk';
const PDF = ['pdf'];
const extensions = (...lists: string[][]) => lists.flat();

export interface VerbPaths {
  /** `clop.exe`: the command-line launcher beside the app (or the portable app's copy of it). */
  clop: string;
  /** The app's own exe, for the icon and for the verb that opens a window. */
  app: string;
}
/** The argument the app reads as "choose a pipeline for the files after `--`". */
export const RUN_PIPELINE_FLAG = '--run-pipeline';
interface Verb { id: string; label: string; types: string[]; command: (paths: VerbPaths) => string }
/** `clop.exe` hides its console window with `--hidden`; the file follows `--` so nothing in its name can be read as an option. */
const launcher = (...args: string[]) => ({ clop }: VerbPaths) => `"${clop}" --hidden ${args.join(' ')} -- "%1"`;

// Labels stay ASCII ("Run pipeline..."): the NSIS installer script is not read as UTF-8.
// Strip EXIF works on images and videos (`clop strip-exif`); downscale on images, videos and audio; the rest on every supported type.
const VERBS: Verb[] = [
  { id: 'Optimise', label: 'Optimise with Clop', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, PDF), command: launcher('optimise', '--gui', '--async') },
  { id: 'OptimiseAggressive', label: 'Optimise (aggressive)', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, PDF), command: launcher('optimise', '--aggressive', '--gui', '--async') },
  { id: 'Downscale', label: 'Downscale', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS), command: launcher('downscale', '--gui', '--async') },
  { id: 'StripExif', label: 'Strip EXIF', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS), command: launcher('strip-exif') },
  // The app asks which pipeline, so this one starts (or reaches) the app. Every launch of a multi-file selection reaches the one instance.
  { id: 'RunPipeline', label: 'Run pipeline...', types: extensions(IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, PDF), command: ({ app }) => `"${app}" ${RUN_PIPELINE_FLAG} -- "%1"` },
];
/**
 * The files an app launch with `--run-pipeline` names: the paths after `--`, all of them (Explorer starts one launch per selected file),
 * or undefined when the launch is not that verb. Only full paths count, so a stray word is never taken for a file.
 */
export function runPipelineFiles(argv: readonly string[]): string[] | undefined {
  // Only an argument before the first `--` is an option; after it, a file named like the flag is just a file.
  const dashes = argv.indexOf('--'), options = dashes < 0 ? argv : argv.slice(0, dashes);
  if (!options.includes(RUN_PIPELINE_FLAG)) return undefined;
  const files = dashes < 0 ? [] : argv.slice(dashes + 1).filter(file => path.win32.isAbsolute(file) || path.posix.isAbsolute(file));
  return [...new Set(files)];
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
      { key: `${key}\\command`, name: '', value: verb.command(paths) },
    );
  }
  return { values, roots, sendTo: { file: SEND_TO_NAME, target: paths.clop, args: '--hidden optimise --gui --async --', icon: paths.app } };
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
/** Where the installer puts the two programs. */
export const NSIS_PATHS: VerbPaths = { clop: '$INSTDIR\\cli\\clop.exe', app: '$INSTDIR\\Clop for Windows.exe' };
const nsis = (text: string) => {
  if (text.includes('"') && text.includes("'")) throw new Error(`Cannot quote for NSIS: ${text}`);
  return text.includes('"') ? `'${text}'` : `"${text}"`;
};
export function nsisInstall(plan: VerbPlan): string[] {
  const { file, target, args, icon } = plan.sendTo;
  return [...plan.values.map(({ key, name, value }) => `WriteRegStr HKCU ${nsis(key)} ${nsis(name)} ${nsis(value)}`), `CreateShortCut ${nsis(`$SENDTO\\${file}`)} ${nsis(target)} ${nsis(args)} ${nsis(icon)} 0`];
}
export const nsisUninstall = (plan: VerbPlan): string[] => [...plan.roots.map(key => `DeleteRegKey HKCU ${nsis(key)}`), `Delete ${nsis(`$SENDTO\\${plan.sendTo.file}`)}`];
