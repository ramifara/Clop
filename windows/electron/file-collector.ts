/**
 * Gathers the files of launches that arrive within `quietMs` of each other and hands them over together. Explorer starts one launch per
 * selected file for a right-click verb, all reaching the one running instance; this turns them back into one selection, so the
 * app asks its question (which pipeline) once.
 */
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
