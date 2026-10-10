import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ToolName = 'ffmpeg' | 'ffprobe' | 'gs' | 'gifsicle' | 'gifski' | 'jpegoptim' | 'pngquant' | 'exiftool' | 'heif-dec' | 'heif-enc' | 'cjxl' | 'djxl';
export const TOOL_NAMES: readonly ToolName[] = ['ffmpeg', 'ffprobe', 'gs', 'gifsicle', 'gifski', 'jpegoptim', 'pngquant', 'exiftool', 'heif-dec', 'heif-enc', 'cjxl', 'djxl'];

// core/ and dist-electron/ are both direct children of windows/, so this resolves the same from source and from a bundle.
const devTools = fileURLToPath(new URL('../.tools/', import.meta.url));
const isFile = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };

export function executableName(name: ToolName) {
  if (process.platform !== 'win32') return name;
  return name === 'gs' ? 'gswin64c.exe' : `${name}.exe`;
}

// fetch-tools.mjs prepares only the x64 Windows set; ARM64 Windows runs it under emulation.
const devTarget = () => `${process.platform}-${process.platform === 'win32' ? 'x64' : process.arch}`;

/** Bundled tool directories in resolution order: CLOP_TOOLS_DIR, the packaged app's resources, then the development cache. */
export function toolDirs() {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  return [process.env.CLOP_TOOLS_DIR, resources && path.join(resources, 'bin'), path.join(devTools, devTarget(), 'bin')].filter((dir): dir is string => !!dir);
}

export function toolsDir(): string | undefined {
  return toolDirs().find(dir => existsSync(dir));
}

export function toolPath(name: ToolName): string {
  const exe = executableName(name);
  for (const dir of toolDirs()) if (isFile(path.join(dir, exe))) return path.join(dir, exe);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir && isFile(path.join(dir, exe))) return path.join(dir, exe);
  throw new Error(`Clop could not find ${name} (${exe}). Reinstall Clop for Windows; in development, run node scripts/fetch-tools.mjs or put ${exe} on PATH.`);
}

export function hasTool(name: ToolName) {
  try { toolPath(name); return true; } catch { return false; }
}
