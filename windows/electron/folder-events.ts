import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { recentFiles } from './watch-rules';

/**
 * What a watched tree reports. `file` hears each entry that changes: `created` when it appeared, was renamed or was removed
 * (`rename`), not when only its content or attributes changed (`change`); files found again after lost changes count as
 * created. `lost` hears that the folder can no longer be watched: it was deleted, renamed, moved to the Recycle Bin or its
 * drive went away. The search after lost changes does not enter a folder that every listener `skip`s.
 */
export interface TreeListener { file: (file: string, created: boolean) => void; lost: () => void; skip?: (dir: string) => boolean }
interface Tree { root: string; watcher: FSWatcher; listeners: Set<TreeListener>; identity: string; timer: NodeJS.Timeout; scan?: Promise<void>; again?: boolean }
const trees = new Map<string, Tree>();
const keyOf = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;
const identityOf = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`;

function close(key: string, tree: Tree) {
  if (trees.get(key) !== tree) return false;
  trees.delete(key);
  clearInterval(tree.timer);
  tree.watcher.close();
  return true;
}
function lose(key: string, tree: Tree) { if (close(key, tree)) for (const listener of tree.listeners) listener.lost(); }

/**
 * Watches `root` and every folder inside it with one recursive `fs.watch`, a single ReadDirectoryChangesW handle on Windows
 * that does not walk the tree or follow junctions, shared by everyone watching the same folder. The folder itself is checked
 * every `checkMs`: one that is gone or replaced by another folder of the same name is lost. Throws when the folder cannot be
 * watched at all. Returns a function that stops listening.
 */
export async function watchTree(root: string, listener: TreeListener, { checkMs = 5000 } = {}): Promise<() => void> {
  const key = keyOf(root);
  let tree = trees.get(key);
  if (!tree) {
    const identity = identityOf(await stat(root));
    tree = trees.get(key);
    if (!tree) {
      const listeners = new Set<TreeListener>();
      const watcher = watch(root, { recursive: true, persistent: false }, (event, name) => {
        // On Windows libuv reports no name when the change buffer overflowed; elsewhere a nameless event is about the folder itself.
        if (!name) { if (process.platform === 'win32') void scan(made, true); return; }
        const file = path.join(root, name.toString()), relative = path.relative(root, file);
        // A rename of the watched folder itself, or one that lands outside it, means the tree is not there any more.
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { lose(key, made); return; }
        for (const each of listeners) each.file(file, event === 'rename');
      });
      const timer = setInterval(() => {
        void stat(root).then(info => identityOf(info) === identity && info.isDirectory(), () => false).then(same => { if (!same) lose(key, made); });
      }, checkMs);
      timer.unref();
      const made: Tree = { root, watcher, listeners, identity, timer };
      watcher.on('error', () => lose(key, made));
      trees.set(key, tree = made);
    }
  }
  const current = tree;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size) close(key, current);
  };
}

/**
 * After lost changes, the files of a watched tree changed in the last minute are reported again. One scan runs at a time for
 * every kind watching the tree; asking again meanwhile runs it once more afterwards.
 */
function scan(tree: Tree, lost = false): Promise<void> {
  if (tree.scan) { tree.again = true; return tree.scan; }
  const { root } = tree;
  if (lost) console.warn(`Clop missed changes in ${root} and is looking for files changed in the last minute.`);
  return tree.scan = (async () => {
    try {
      do {
        tree.again = false;
        const skip = (dir: string) => [...tree.listeners].every(listener => listener.skip?.(dir));
        for (const file of await recentFiles(root, Date.now() - 60_000, { skip })) for (const listener of tree.listeners) listener.file(file, true);
      } while (tree.again);
    } finally { tree.scan = undefined; }
  })();
}

/** Looks again at the files of the watched folder `root` changed in the last minute, as after lost changes. */
export function rescan(root: string) { const tree = trees.get(keyOf(root)); return tree ? scan(tree) : Promise.resolve(); }

/** How many folders are being watched, for tests. */
export const watchedTrees = () => trees.size;
