import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

interface Listener { file: (file: string) => void; lost: () => void }
const trees = new Map<string, { watcher: FSWatcher; listeners: Set<Listener> }>();
const keyOf = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;

function close(key: string) {
  const tree = trees.get(key);
  trees.delete(key);
  tree?.watcher.close();
  return tree;
}

/**
 * Watches `root` and every folder inside it with one recursive `fs.watch`, a single ReadDirectoryChangesW handle on Windows
 * that does not walk the tree or follow junctions, shared by everyone watching the same folder. `file` hears the path of
 * each entry that changes; `lost` hears that the folder can no longer be watched (deleted, or its drive gone). Throws when
 * the folder cannot be watched at all. Returns a function that stops listening.
 */
export function watchTree(root: string, file: (file: string) => void, lost: () => void): () => void {
  const key = keyOf(root);
  let tree = trees.get(key);
  if (!tree) {
    const listeners = new Set<Listener>();
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => {
      if (name) for (const listener of listeners) listener.file(path.join(root, name.toString()));
    });
    watcher.on('error', () => { if (trees.get(key)?.watcher === watcher) close(key); for (const listener of listeners) listener.lost(); });
    trees.set(key, tree = { watcher, listeners });
  }
  const listener = { file, lost }, current = tree;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size && trees.get(key) === current) close(key);
  };
}

/** How many folders are being watched, for tests. */
export const watchedTrees = () => trees.size;
