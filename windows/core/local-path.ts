import path from 'node:path';

// Agents may only name files and folders on this PC's own drives. Merely looking up a network path makes Windows contact
// that server (over SMB, or WebDAV over HTTPS) and offer it the user's credentials, and a write there sends the file off the
// PC. A drive letter mapped to a network share cannot be told apart cheaply, so it counts as local.

/**
 * Whether `text` names a network share or a device instead of a file on this PC's own drives: `\\server\share` (or with
 * forward slashes), `\\?\UNC\server\share`, device paths (`\\.\…`, `\\?\Volume{…}\…`) and `file://server/…` URLs. The
 * long form of a drive path, `\\?\C:\…`, is local. Judged by the text alone, so it works the same on every platform.
 */
export function isRemotePath(text: string): boolean {
  const trimmed = text.trim();
  if (/^file:/i.test(trimmed)) {
    let url: URL;
    try { url = new URL(trimmed); } catch { return true; }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return true; }
    return (!!url.hostname && url.hostname.toLowerCase() !== 'localhost') || isRemotePath(pathname);
  }
  return /^[\\/]{2}/.test(trimmed) && !/^[\\/]{2}\?[\\/][a-z]:([\\/]|$)/i.test(trimmed);
}

/** The tokens that can expand to nothing (`%e` for a file with no extension) and the regex captures (`$1`…), which can match nothing. */
const EMPTY_CAPABLE = /%e|\$\d+/g;
/** Every other token (`%y`, `%f`, `%P`…) always expands to text, and none of it holds a separator but `%P` and `%F`, which are drive paths. */
const OTHER_TOKEN = /%[ymndwHMSprifFP]/g;
/** `text` as it reads when every `%e` and `$1`… expands to nothing, and every other token to a name. */
export const withoutExpansions = (text: string) => text.replace(EMPTY_CAPABLE, '').replace(OTHER_TOKEN, 'x');

/**
 * Whether a path or template could name a network share or a device once it is expanded: as written, or with every token and
 * capture empty. `%e\\host\share` is a drive path to a file with an extension and a share to one without.
 */
export function isRemoteTemplate(text: string): boolean {
  return isRemotePath(text) || isRemotePath(withoutExpansions(text));
}

/** What an agent is told when it names a network or device path. */
export const remotePathRefusal = (shown: string) => `${shown} is on a network share or a device. Agents may only use files and folders on this PC's own drives: a path that starts with a drive letter, such as C:\\.`;

/**
 * The refusal for the first of `paths` an agent may not use, or undefined when it may use them all. Each is judged as
 * written and as resolved against `cwd`, so a relative path inside a network working folder is refused too. URLs other
 * than `file:` ones are not paths and pass.
 */
export function agentPathRefusal(paths: Iterable<string | undefined>, cwd?: string): string | undefined {
  if (cwd !== undefined && isRemotePath(cwd)) return remotePathRefusal(cwd);
  for (const item of paths) {
    if (item === undefined || /^https?:\/\//i.test(item)) continue;
    if (isRemoteTemplate(item) || (cwd !== undefined && !/^file:/i.test(item) && isRemotePath(path.resolve(cwd, item)))) return remotePathRefusal(item);
  }
  return undefined;
}

const DRIVE_PATH = /^(?:\\\\\?\\)?[A-Za-z]:[\\/]/;
/**
 * Where an agent's path is used, once its tokens and captures are expanded: throws when it names a network share or a device.
 * `file` is judged as it reads and as Windows normalises it. Anyone else's path passes.
 */
export function requireNotRemote(agent: boolean | undefined, ...files: (string | undefined)[]): void {
  if (!agent) return;
  for (const file of files) if (file !== undefined && (isRemotePath(file) || isRemotePath(path.win32.normalize(file)))) throw new Error(remotePathRefusal(file));
}

/**
 * The same for a path about to be looked up or written, already resolved and normalised: for an agent it must be a local
 * drive-letter path (`C:\…`, or its long form `\\?\C:\…`). Off Windows there are no drive letters, so a network or device
 * form is all that is refused. The early check on the text stays; this one sees what expansion made of it.
 */
export function requireLocalDrive(agent: boolean | undefined, file: string, platform: NodeJS.Platform = process.platform): void {
  if (!agent) return;
  requireNotRemote(agent, file);
  if (platform === 'win32' && path.win32.isAbsolute(file) && !DRIVE_PATH.test(file)) throw new Error(remotePathRefusal(file));
}
