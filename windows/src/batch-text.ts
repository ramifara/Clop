/** `n word`, with an s unless there is exactly one. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the sheet asks when the previous batch is opened over what is in the window: prepared files that would be removed, or,
 * with none, the finished batch that can still be reverted.
 */
export function reopenQuestion(prepared: number) {
  return prepared > 0
    ? { title: `Open the previous batch and drop the ${plural(prepared, 'prepared file')}?`, text: 'The files you prepared here are removed from the window. You can drop them again afterwards.', keep: 'Keep these files' }
    : { title: 'Open the previous batch?', text: 'This batch can still be reverted. Opening the previous one keeps its backups, and you can open this one again with Open previous batch to give its originals back.', keep: 'Keep this batch' };
}
