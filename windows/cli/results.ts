import os from 'node:os';
import { urlPath, type CLIResult, type OptimisationResponse, type OptimisationResponseError, type ServerMessage } from '../core/ipc/protocol';
import { ARROW, bold, CHECKMARK, dim, ERROR_X, EXCLAMATION, foreground, LINE_CLEAR, LINE_UP, underline, yellow } from './colors';

// `ProgressPrinter` (ClopCLI/main.swift): progress on stderr while files run, then one line per result on stdout.

/** `JSONSerialization`/`JSONEncoder` with `.prettyPrinted, .sortedKeys`. */
export const sortedJSON = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item, 2);

export interface IO { out(text: string): void; err(text: string): void; errTTY: boolean }

/** `Int.humanSize`. */
export function humanSize(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  if (bytes < 1_000_000) return `${Math.trunc(bytes / 1000)}KB`;
  const [value, unit] = bytes < 1_000_000_000 ? [bytes / 1_000_000, 'MB'] : [bytes / 1_000_000_000, 'GB'];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${unit}`;
}

/** `String.shellString`: the user profile folder at the start of a path reads as `~`. */
export function shellString(file: string, home = os.homedir()): string {
  const lower = process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s;
  return lower(file).startsWith(lower(home)) && /^([\\/]|$)/.test(file.slice(home.length)) ? `~${file.slice(home.length)}` : file;
}
const shown = (url: string) => { const file = urlPath(url); return file === undefined ? url : shellString(file); };
const percentSaved = (oldBytes: number, newBytes: number) => 100 - newBytes / (oldBytes === 0 ? 1 : oldBytes) * 100;

export class ProgressPrinter {
  readonly responses = new Map<string, OptimisationResponse>();
  readonly errors = new Map<string, OptimisationResponseError>();
  private readonly progress = new Map<string, number>();
  private lines = 0;
  private timer?: NodeJS.Timeout;
  constructor(private readonly urls: string[], private readonly io: IO, private readonly show: boolean) {}

  /** Takes one answer from the app or the headless service. */
  readonly onMessage = (message: ServerMessage) => {
    switch (message.kind) {
      case 'progress': this.progress.set(message.forURL, message.fractionCompleted); break;
      case 'response': this.progress.delete(message.response.forURL); this.responses.set(message.response.forURL, message.response); break;
      case 'error': this.progress.delete(message.error.forURL); this.errors.set(message.error.forURL, message.error); break;
      default: return;
    }
    if (this.show && this.io.errTTY) this.timer ??= setTimeout(() => { this.timer = undefined; this.print(); }, 100);
  };

  /** `printProgress`. On a terminal it redraws in place; elsewhere only the final count is written. */
  print() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.io.errTTY && this.responses.size + this.errors.size < this.urls.length) return;
    const lines = [`Processed ${this.responses.size + this.errors.size} of ${this.urls.length} | Success: ${this.responses.size} | Failed: ${this.errors.size}`];
    for (const [url, fraction] of this.progress) {
      const filled = Math.trunc(fraction * 20), bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      let item = shown(url);
      if (item.length > 50) item = `...${item.slice(-40)}`;
      lines.push(`${item}: ${bar} ${Math.round(fraction * 100)}%`);
    }
    this.io.err((this.io.errTTY ? `${LINE_UP}${LINE_CLEAR}`.repeat(this.lines) : '') + lines.map(line => `${line}\n`).join(''));
    this.lines = lines.length;
  }

  /** True when every input failed: the exit code is then non-zero, but partial success exits 0 so callers do not retry finished work. */
  get allFailed() { return this.responses.size === 0 && this.errors.size > 0; }

  /** `printResults`. */
  printResults(json: boolean) {
    // Sorted as Swift's `<` sorts `forURL.path`: by full path, code unit by code unit.
    const key = (url: string) => urlPath(url) ?? (() => { try { return new URL(url).pathname; } catch { return url; } })();
    const byPath = <T extends { forURL: string }>(items: Iterable<T>) => [...items].sort((a, b) => key(a.forURL) < key(b.forURL) ? -1 : key(a.forURL) > key(b.forURL) ? 1 : 0);
    const done = byPath(this.responses.values()), failed = byPath(this.errors.values());
    if (json) { const result: CLIResult = { done, failed }; this.io.out(`${sortedJSON(result)}\n`); return; }
    const out = (line: string) => this.io.out(`${line}\n`);
    for (const r of done) {
      if (r.newBytes === r.oldBytes || r.newBytes <= 0 || Math.abs(r.newBytes - r.oldBytes) <= 100) {
        out(dim(`${EXCLAMATION()} ${underline(shown(r.forURL))}: ${yellow(humanSize(r.oldBytes || r.newBytes))} (no change)`));
        continue;
      }
      const smaller = r.newBytes < r.oldBytes, good = foreground(smaller ? 'green' : 'red'), bad = foreground(smaller ? 'red' : 'green');
      const percent = dim(` (${good(`${percentSaved(r.oldBytes, r.newBytes).toFixed(2)}%`)} ${smaller ? 'smaller' : 'larger'})`);
      const [oldSize, newSize] = [r.oldWidthHeight, r.newWidthHeight];
      const resolution = oldSize && newSize && (oldSize[0] !== newSize[0] || oldSize[1] !== newSize[1]) ? ` [${dim(`${oldSize[0]}×${oldSize[1]}`)} ${ARROW()} ${yellow(`${newSize[0]}×${newSize[1]}`)}]` : '';
      const bitrate = r.oldBitrate !== undefined && r.newBitrate !== undefined && r.oldBitrate !== r.newBitrate ? ` [${dim(`${r.oldBitrate} kbps`)} ${ARROW()} ${yellow(`${r.newBitrate} kbps`)}]` : '';
      const dpi = r.oldDPI !== undefined && r.newDPI !== undefined && r.oldDPI !== r.newDPI ? ` [${dim(`${r.oldDPI} DPI`)} ${ARROW()} ${yellow(`${r.newDPI} DPI`)}]`
        : r.oldDPI !== undefined ? ` [${dim(`${r.oldDPI} DPI`)}]` : '';
      const original = urlPath(r.forURL) ?? r.convertedFrom;
      const savedAs = original !== undefined && original !== r.path ? dim(` saved as ${underline(shellString(r.path))}`) : '';
      out(`${CHECKMARK()} ${underline(shown(r.forURL))}: ${bad(humanSize(r.oldBytes))} ${ARROW()} ${bold(good(humanSize(r.newBytes)))}${resolution}${bitrate}${dpi}${percent}${savedAs}`);
    }
    for (const e of failed) {
      const file = urlPath(e.forURL), error = file === undefined ? e.error : e.error.replaceAll(`: ${file}`, '').replaceAll(`: ${shellString(file)}`, '');
      out(`${ERROR_X()} ${underline(shown(e.forURL))}: ${foreground('red')(error)}`);
    }
    if (done.length > 1) {
      const oldBytes = done.reduce((sum, r) => sum + r.oldBytes, 0), newBytes = done.reduce((sum, r) => sum + r.newBytes, 0);
      if (oldBytes === newBytes) return;
      const smaller = newBytes < oldBytes, good = foreground(smaller ? 'green' : 'red'), bad = foreground(smaller ? 'red' : 'green');
      out(`${CHECKMARK()} ${underline('TOTAL')}: ${bad(humanSize(oldBytes))} ${ARROW()} ${bold(good(humanSize(newBytes)))} ${smaller ? 'saving' : 'adding'}: ${good(humanSize(Math.abs(oldBytes - newBytes)))} ${dim(`(${good(`${percentSaved(oldBytes, newBytes).toFixed(2)}%`)})`)}`);
    }
  }
}
