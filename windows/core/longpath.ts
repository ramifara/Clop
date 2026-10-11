import path from 'node:path';
import type { ToolName } from './tools';

// Windows stops at MAX_PATH (260 characters, 248 for a folder) unless a path starts with `\\?\` and the program opens it through the
// wide-character calls. Node's fs adds the prefix itself, so this is for what Node does not open: the arguments of tools,
// and the files libvips opens. The app's manifest says it is `longPathAware` too (scripts/after-pack.mjs).

/** The length from which a path gets the prefix: a folder name cannot exceed 248 characters, so a longer path may be one. */
export const LONG_PATH = 248;
const VERBATIM = /^\\\\[?.]\\/;
const UNC = /^\\\\[^\\/]+[\\/]+[^\\/]+/;
const DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * `file` as Windows opens it past MAX_PATH: `\\?\C:\…` or `\\?\UNC\server\share\…`, with `\\?\` switching off Windows' own
 * clean-up, so slashes and `.` and `..` are resolved here. Shorter paths, relative paths and other platforms are returned as they are.
 */
export function extendedPath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || file.length < LONG_PATH || VERBATIM.test(file)) return file;
  if (UNC.test(file)) return `\\\\?\\UNC\\${path.win32.normalize(file).slice(2)}`;
  if (DRIVE.test(file)) return `\\\\?\\${path.win32.normalize(file)}`;
  return file;
}

/** A path without `extendedPath`'s prefix, for messages. */
export function plainPath(file: string): string {
  if (file.startsWith('\\\\?\\UNC\\')) return `\\\\${file.slice(8)}`;
  return /^\\\\\?\\[A-Za-z]:\\/.test(file) ? file.slice(4) : file;
}

// `--output=C:\…`, `-sOutputFile=C:\…`: an option that carries its path after the first `=`.
const OPTION = /^(-{1,2}[A-Za-z][\w.-]*=)([^]+)$/;
/** One command-line argument with `extendedPath` applied to it, or to the path an option carries. */
export function extendedArgument(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || arg.length < LONG_PATH) return arg;
  const option = OPTION.exec(arg);
  return option ? option[1] + extendedPath(option[2], platform) : extendedPath(arg, platform);
}

/**
 * ExifTool's Windows build is a Perl program that reaches long paths through its own layer, and nothing shows that layer takes the
 * prefix, so its arguments stay as they are. Every other bundled tool opens files with the C runtime or the wide-character API,
 * which take it.
 */
const OWN_LONG_PATHS: readonly string[] = ['exiftool'] satisfies ToolName[];
/** The arguments of a bundled tool with long paths made openable. */
export function toolArguments(tool: string, args: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform !== 'win32' || OWN_LONG_PATHS.includes(tool) ? args : args.map(arg => extendedArgument(arg, platform));
}
