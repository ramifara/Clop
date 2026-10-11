/**
 * Gathers the files of launches that arrive within `quietMs` of each other and hands them over together. Explorer starts one launch per
 * selected file for a right-click verb, all reaching the one running instance; this turns them back into one selection, so the
 * app asks its question (which pipeline) once.
 */
/**
 * How long a verb's launches may be apart and still be one selection. A portable launch unpacks the whole app before it reaches the running
 * one, and fifteen do so at once, so the gaps are wider; "Run pipeline" asks a question per selection, so it waits longest.
 */
export function quietWindow(verb: string, portable: boolean) { return portable ? (verb === 'run-pipeline' ? 3000 : 1500) : 600; }

export class FileCollector {
  private files = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly fire: (files: string[]) => void, private readonly quietMs = 600) {}
  add(files: readonly string[]) {
    if (!files.length) return;
    for (const file of files) this.files.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { const all = [...this.files]; this.files.clear(); this.timer = undefined; this.fire(all); }, this.quietMs);
  }
  cancel() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.files.clear(); }
}
