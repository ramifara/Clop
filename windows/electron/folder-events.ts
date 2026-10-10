import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * What a watched tree reports. `file` hears each entry that changes: `created` when it appeared, was renamed or was removed
 * (`rename`), not when only its content or attributes changed (`change`). `overflow` hears that changes were lost because
 * too many came at once. `lost` hears that the folder can no longer be watched: it was deleted, renamed, moved to the Recycle
 * Bin or its drive went away.
 */
export interface TreeListener { file: (file: string, created: boolean) => void; overflow: () => void; lost: () => void }
interface Tree { watcher: FSWatcher; listeners: Set<TreeListener>; identity: string; timer: NodeJS.Timeout }
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
        // libuv reports no name when the change buffer overflowed.
        if (!name) { for (const each of listeners) each.overflow(); return; }
        const file = path.join(root, name.toString()), relative = path.relative(root, file);
        // A rename of the watched folder itself, or one that lands outside it, means the tree is not there any more.
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { lose(key, made); return; }
        for (const each of listeners) each.file(file, event === 'rename');
      });
      const timer = setInterval(() => {
        void stat(root).then(info => identityOf(info) === identity && info.isDirectory(), () => false).then(same => { if (!same) lose(key, made); });
      }, checkMs);
      timer.unref();
      const made: Tree = { watcher, listeners, identity, timer };
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

/** How many folders are being watched, for tests. */
export const watchedTrees = () => trees.size;
