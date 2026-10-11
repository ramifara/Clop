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
    if (isRemotePath(item) || (cwd !== undefined && !/^file:/i.test(item) && isRemotePath(path.resolve(cwd, item)))) return remotePathRefusal(item);
  }
  return undefined;
}
