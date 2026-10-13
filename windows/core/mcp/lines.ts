// `ConfigLines` (Clop/MCPClients.swift): a text file as lines for the TOML, YAML and Bash editors. A `\r` stays on its
// line, so a CRLF file comes back with the endings it had.

/** Lines `[start, end)`. */
export type Span = [number, number];

export class ConfigLines {
  lines: string[];
  readonly crlf: boolean;

  constructor(text: string) {
    const parts = text ? text.split('\n') : [];
    if (text.endsWith('\n')) parts.pop();
    this.lines = parts;
    this.crlf = text.includes('\r\n');
  }

  get text() { return this.lines.length ? `${this.lines.join('\n')}\n` : ''; }

  static isBlank(line: string) { return /^[ \t\r]*$/.test(line); }
  static indent(line: string) { return /^ */.exec(line)![0].length; }

  /** A line written by an editor, ending the way the file's own lines do. */
  fresh(line: string) { return this.crlf ? `${line}\r` : line; }

  /**
   * Drops `spans`, and with each one any blank lines it leaves doubled up, so taking a block out leaves no gap where it
   * was. Returns every line dropped, by its old index.
   */
  remove(spans: Span[]): Set<number> {
    const drop = new Set<number>();
    for (const [start, end] of spans) for (let n = start; n < end; n++) drop.add(n);
    const extra = new Set<number>(), sorted = [...drop].sort((a, b) => a - b);
    for (let r = 0; r < sorted.length;) {
      let last = r;
      while (last + 1 < sorted.length && sorted[last + 1] === sorted[last] + 1) last++;
      const lower = sorted[r], upper = sorted[last] + 1;
      r = last + 1;
      if (upper < this.lines.length && !ConfigLines.isBlank(this.lines[upper])) continue;
      let start = lower;
      while (start > 0 && ConfigLines.isBlank(this.lines[start - 1]) && !drop.has(start - 1)) extra.add(--start);
      // At the top of the file there is nothing above to keep apart, so the gap below goes instead.
      for (let end = upper; start === 0 && end < this.lines.length && ConfigLines.isBlank(this.lines[end]) && !drop.has(end); end++) extra.add(end);
    }
    for (const n of extra) drop.add(n);
    this.lines = this.lines.filter((_, n) => !drop.has(n));
    return drop;
  }
}

/** Why an editor would not touch a file. The installer names the file in the message it shows. */
export class ConfigLayoutError extends Error {
  constructor() { super('unsupported layout'); }
}
