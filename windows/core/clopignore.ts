import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MediaKind } from './media/types';

// The `.clopignore-<type>` files of FileOptimisationWatcher.swift: gitignore-style rules in a folder that keep files out of
// automatic optimisation (watched folders) and out of batches made from a dropped folder.

const glob = (pattern: string) => pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/|\/\*\*|\*\*|\*|\?/g, token =>
  token === '**/' ? '(?:.*/)?' : token === '/**' ? '(?:/.*)?' : token === '**' ? '.*' : token === '*' ? '[^/]*' : '[^/]');

/**
 * Whether `relative` (a `/`-separated path inside a watched folder) is ignored by gitignore-style `rules`, as the
 * `.clopignore-<type>` file in a watched folder holds them: `#` comments, `!` to re-include, a leading or inner `/` anchors a
 * pattern to the folder, a trailing `/` matches folders only, and `*`, `?` and `**` wildcards. The last matching rule wins.
 */
export function ignoredBy(rules: string, relative: string, platform: NodeJS.Platform = process.platform): boolean {
  const parts = relative.split('/');
  let ignored = false;
  for (let line of rules.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!'); if (negate) line = line.slice(1);
    const folder = line.endsWith('/'); if (folder) line = line.slice(0, -1);
    const anchored = line.includes('/'), expression = new RegExp(`^${glob(line.replace(/^\//, ''))}$`, platform === 'win32' ? 'i' : '');
    // A folder rule matches the folders above the file; any other rule also matches the file itself.
    const candidates = parts.slice(0, folder ? -1 : undefined).map((part, i) => anchored ? parts.slice(0, i + 1).join('/') : part);
    if (candidates.some(candidate => expression.test(candidate))) ignored = !negate;
  }
  return ignored;
}

/** Whether `file` is ignored by the `.clopignore-<kind>` file in the folder `root`, read afresh each time as macOS does. */
export async function clopIgnored(kind: MediaKind, root: string, file: string) {
  const rules = await readFile(path.join(root, `.clopignore-${kind}`), 'utf8').catch(() => '');
  return !!rules && ignoredBy(rules, path.relative(root, file).split(path.sep).join('/'));
}
