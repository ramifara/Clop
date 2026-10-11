import { ConfigLines, type Span } from './lines';

// `ShellRCEditor` (Clop/MCPClients.swift): adds and removes one command in a Bash file such as Crush's `crushrc`, as
// text. A command is matched by its first words with quotes resolved, however it was quoted or split over lines.

const startsWith = (words: string[], prefix: string[]) => prefix.every((word, n) => words[n] === word);

/** The words of the first command starting with `prefix`, or undefined when none does. */
export function commandWords(text: string, prefix: string[]): string[] | undefined {
  return commands(new ConfigLines(text).lines).find(command => startsWith(command.words, prefix))?.words;
}

/** Puts `line` where the first matching command was, dropping any others, or at the end of the file. */
export function setCommand(text: string, prefix: string[], line: string): string {
  const file = new ConfigLines(text), matches = commands(file.lines).filter(command => startsWith(command.words, prefix));
  if (!matches.length) { file.lines.push(file.fresh(line)); return file.text; }
  const [first, ...rest] = matches, shift = first.lines[1] - first.lines[0] - 1;
  file.lines.splice(first.lines[0], first.lines[1] - first.lines[0], file.fresh(line));
  file.remove(rest.map(({ lines: [start, end] }) => [start - shift, end - shift] as Span));
  return file.text;
}

/** Drops every command starting with `prefix`. Undefined when there was none. */
export function removeCommand(text: string, prefix: string[]): string | undefined {
  const file = new ConfigLines(text), matches = commands(file.lines).filter(command => startsWith(command.words, prefix));
  if (!matches.length) return undefined;
  file.remove(matches.map(command => command.lines));
  return file.text;
}

/** One word as Bash reads it back: bare when it is plain, single-quoted otherwise. */
export const shellQuote = (word: string) => /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

/** Each command's lines and the words of its first simple command. */
function commands(lines: string[]) {
  const out: { lines: Span; words: string[] }[] = [];
  for (let n = 0; n < lines.length; n++) {
    const start = n;
    let joined = lines[n], result = split(joined);
    // A trailing `\` or a quote still open carries the command onto the next line.
    while (result.continues && n + 1 < lines.length) { joined += `\n${lines[++n]}`; result = split(joined); }
    if (result.words.length) out.push({ lines: [start, n + 1], words: result.words });
  }
  return out;
}

/** The words up to the first `;`, `&`, `|` or comment, quotes resolved. `continues` when the text ends inside a quote or on a line-continuing backslash. */
function split(text: string): { words: string[]; continues: boolean } {
  const words: string[] = [];
  let word = '', inWord = false, quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (quote === '"' && c === '\\' && '"\\$`\n\r'.includes(text[i + 1] ?? 'x')) {
        const next = text[++i];
        if (next === '\r' && text[i + 1] === '\n') i++;
        else if (next !== '\n' && next !== '\r') word += next;
      } else word += c;
      continue;
    }
    switch (c) {
      case "'": case '"': quote = c; inWord = true; break;
      case '\\': {
        const next = text[++i];
        if (next === undefined || (next === '\r' && i + 1 >= text.length)) return { words, continues: true };
        if (next === '\r' && text[i + 1] === '\n') i++;
        else if (next !== '\n') { word += next; inWord = true; }
        break;
      }
      case ' ': case '\t': case '\r': case '\n':
        if (inWord) { words.push(word); word = ''; inWord = false; }
        break;
      case '#':
        if (inWord) { word += c; break; }
        return { words, continues: false };
      case ';': case '&': case '|':
        if (inWord) words.push(word);
        return { words, continues: false };
      default: word += c; inWord = true;
    }
  }
  if (quote) return { words, continues: true };
  if (inWord) words.push(word);
  return { words, continues: false };
}
