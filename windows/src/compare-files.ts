import { fileActions, type MenuNode } from '../core/cards/actions';

// The compare window's path fields and file menus (`PathFieldMenu` and `fileActions` in CompareView.swift).

/** A long path with its middle left out, so the drive and the file name both show (`.truncationMode(.middle)`). */
export function shortPath(file: string, max = 64): string {
  if (file.length <= max) return file;
  const keep = max - 1, tail = Math.ceil(keep * 0.6), head = keep - tail;
  return `${file.slice(0, head)}…${file.slice(file.length - tail)}`;
}

/**
 * The right-click menu over the compare window's media: the side's file actions, or, over the split view where both sides show, the
 * original's and the result's under their own headings, as macOS puts them in an "Original" and an "Optimised" section.
 */
export function compareMenu(side: 'original' | 'result' | 'both'): MenuNode[] {
  if (side !== 'both') return fileActions(side);
  return [{ header: 'Original' }, ...fileActions('original'), { separator: true }, { header: 'Optimised' }, ...fileActions('result')];
}
