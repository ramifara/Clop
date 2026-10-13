import { SETTING_ENTRIES, type SettingEntry } from './entries';
import { SETTINGS_TABS } from './tabs';

// Port of `SettingsSearchIndex.search` (Clop/SettingsSearchIndex.swift): the ranking behind the Settings search field.
// Words are scored against the title, keywords, subtitle and section (graded: whole word, prefix, shared stem, substring), a
// subsequence pass catches typos and abbreviations, and a word that few rows carry counts for more than one every row has.

/** Words a query carries and a row does not, dropped rather than down-weighted so "replacing the original video" still finds its row. */
const STOP_WORDS = new Set(['an', 'and', 'any', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'get', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'why', 'will', 'with', 'would', 'you', 'your']);

/** Lowercase words, split at anything that is not a letter or digit. Shared by the index and the query so both are cut the same way. */
export const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

interface Field { weight: number; words: string[]; text: string }
const fieldsOf = (entry: SettingEntry): Field[] => {
  const section = `${entry.section} ${SETTINGS_TABS[entry.tab]}`;
  return [
    { weight: 3, words: words(entry.title), text: entry.title.toLowerCase() },
    { weight: 2.5, words: entry.keywords.flatMap(words), text: entry.keywords.join(' ').toLowerCase() },
    { weight: 1, words: words(entry.subtitle), text: entry.subtitle.toLowerCase() },
    { weight: 0.6, words: words(section), text: section.toLowerCase() },
  ];
};
const fields = new Map(SETTING_ENTRIES.map(entry => [entry, fieldsOf(entry)]));

function sharedPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How well a query word matches an indexed word, 0 when it does not. Graded so "send" ranks "Send securely" above a row that mentions "sender". */
export function wordScore(query: string, indexed: string): number {
  if (query === indexed) return 1;
  if (indexed.startsWith(query)) return 0.9;
  // "replacing" and "replace" part ways at the seventh letter: scored by how much of the longer word the stem covers.
  const stem = sharedPrefix(query, indexed), ratio = stem / Math.max(query.length, indexed.length);
  if (stem >= 4 && ratio >= 0.5) return 0.85 * ratio;
  if (query.length >= 4 && indexed.includes(query)) return 0.5;
  return 0;
}

/** Whether `query` is a subsequence of `text`, and how tightly packed (the fzf trick, for typos like "clipbord"); undefined when it is not in there. Four characters minimum. */
export function subsequenceScore(query: string, text: string): number | undefined {
  const q = [...query], t = [...text];
  if (q.length < 4 || t.length < q.length) return undefined;
  let score = 0, streak = 0, ti = 0;
  for (const ch of q) {
    let found = false;
    while (ti < t.length) {
      if (t[ti] === ch) {
        const atWordStart = ti === 0 || !/[\p{L}\p{N}]/u.test(t[ti - 1]);
        streak++;
        score += 1 + streak * 3 + (atWordStart ? 6 : 0);
        ti++; found = true;
        break;
      }
      streak = 0; ti++;
    }
    if (!found) return undefined;
  }
  // Against a perfect contiguous run starting at a word boundary, so a long subtitle containing the letters cannot outscore a short title spelling them out.
  const perfect = q.reduce((sum, _, i) => sum + 1 + (i + 1) * 3, 6);
  return Math.min(1, score / perfect);
}

/** The best any field of `entry` does with one query word. */
export function tokenScore(token: string, entry: SettingEntry): number {
  let best = 0;
  const parts = fields.get(entry) ?? fieldsOf(entry);
  for (const field of parts) for (const word of field.words) {
    const score = wordScore(token, word);
    if (score > 0) best = Math.max(best, field.weight * score);
  }
  if (best > 0) return best;
  // Only once no whole word matched, and held below the weakest whole-word rung: a subsequence hit is a guess.
  for (const field of parts) {
    const score = subsequenceScore(token, field.text);
    if (score !== undefined) best = Math.max(best, field.weight * score * 0.4);
  }
  return best;
}

/** Rows matching the query, best first. `requireAll` is what the search field passes: someone typing two words expects both to count. */
export function rank(query: string, requireAll: boolean, limit = 25, entries: readonly SettingEntry[] = SETTING_ENTRIES): SettingEntry[] {
  let tokens = [...new Set(words(query).filter(word => word.length > 1 && !STOP_WORDS.has(word)))];
  // Unless the query is nothing but function words, in which case they are all there is to go on.
  if (!tokens.length) tokens = [...new Set(words(query).filter(word => word.length > 1))];
  if (!tokens.length) return [];
  // Scored once per row and word: the weighting needs to know how many rows each word hits.
  const scores = entries.map(entry => tokens.map(token => tokenScore(token, entry)));
  const hits = tokens.map((_, t) => scores.reduce((sum, row) => sum + (row[t] > 0 ? 1 : 0), 0));
  // Squared, so the one word that decides the answer dominates the ones every row carries.
  const weights = hits.map(count => (Math.log((entries.length + 1) / (count + 1)) + 0.1) ** 2);
  const ranked: [SettingEntry, number][] = [];
  entries.forEach((entry, index) => {
    let total = 0, matched = 0;
    scores[index].forEach((score, t) => { if (score > 0) { matched++; total += score * weights[t]; } });
    if (matched && !(requireAll && matched < tokens.length)) ranked.push([entry, total]);
  });
  return ranked.sort((a, b) => b[1] - a[1] || (a[0].title < b[0].title ? -1 : a[0].title > b[0].title ? 1 : 0)).slice(0, limit).map(([entry]) => entry);
}

/** What the search field calls: rows matching every word, best first, falling back to the partial match so a phrase with one unknown word still finds its row. */
export function searchSettings(query: string, entries: readonly SettingEntry[] = SETTING_ENTRIES): SettingEntry[] {
  const strict = rank(query, true, 25, entries);
  return strict.length ? strict : rank(query, false, 25, entries);
}
