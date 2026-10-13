import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findPaperSize, PAPER_SIZE_GROUPS, PAPER_SIZE_NAMES, PAPER_SIZES, PAPER_SIZES_BY_CATEGORY, paperSizeGroup } from './paperSizes';

// A Windows checkout has CRLF line endings; the parsers below expect \n.
const swift = readFileSync(fileURLToPath(new URL('../../../Shared/PaperSizes.swift', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const section = (from: string, to: string) => swift.slice(swift.indexOf(from), swift.indexOf(to));
const unescape = (text: string) => text.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

test('the paper size table matches Shared/PaperSizes.swift', () => {
  const categories = [...section('let PAPER_SIZES_BY_CATEGORY', 'let PAPER_SIZES:').matchAll(/"([^"]+)": \[(.*?)\n {4}\]/gs)];
  assert.deepEqual(Object.keys(PAPER_SIZES_BY_CATEGORY), categories.map(m => m[1]));
  for (const [, category, body] of categories) {
    const entries = [...body.matchAll(/"([^"]+)": NSSize\(width: ([\d.]+), height: ([\d.]+)\)/g)].map(([, name, w, h]) => [name, { width: Number(w), height: Number(h) }]);
    assert.deepEqual(PAPER_SIZES_BY_CATEGORY[category], Object.fromEntries(entries), category);
  }
  const cases = [...section('enum PaperSize', 'var aspectRatio').matchAll(/case \w+ = "([^"]+)"/g)].map(m => m[1]);
  assert.equal(cases.length, 104);
  assert.deepEqual(PAPER_SIZE_NAMES, cases);
  assert.equal(Object.keys(PAPER_SIZES).length, cases.length);
});

test('the paper size groups match Shared/PaperSizes.swift', () => {
  const lists = [...section('let ISO_PAPER_GROUPS', 'let PAPER_SIZE_GROUPS').matchAll(/let (\w+): \[CropSizeGroup\] = \[(.*?)\n\]/gs)];
  const order = [...section('let PAPER_SIZE_GROUPS', 'func paperSizeGroup').matchAll(/\("([^"]+)", (\w+)\)/g)];
  assert.deepEqual(PAPER_SIZE_GROUPS.map(c => c.category), order.map(m => m[1]));
  for (const [i, [, , listName]] of order.entries()) {
    const body = lists.find(l => l[1] === listName)![2];
    const groups = [...body.matchAll(/CropSizeGroup\(\s*name: "([^"]+)", width: (\d+), height: (\d+),\s*members: \[([^\]]*)\](?:,\s*summary: "([^"]+)")?/gs)].map(([, name, w, h, members, summary]) => ({
      name: unescape(name), width: Number(w), height: Number(h), members: [...members.matchAll(/"([^"]+)"/g)].map(m => m[1]), ...(summary ? { summary: unescape(summary) } : {}),
    }));
    assert.ok(groups.length > 0, listName);
    assert.deepEqual(PAPER_SIZE_GROUPS[i].groups, groups, listName);
  }
  for (const member of PAPER_SIZE_GROUPS.flatMap(c => c.groups.flatMap(g => g.members))) assert.ok(PAPER_SIZES[member], `${member} is a paper size`);
});

test('paper sizes resolve by name, case-insensitively, or by group', () => {
  assert.deepEqual(findPaperSize('A4'), { width: 210, height: 297 });
  assert.deepEqual(findPaperSize('us broadsheet'), { width: 381, height: 578 });
  assert.deepEqual(findPaperSize('Photo 2:3'), { width: 200, height: 300 });
  assert.equal(findPaperSize('A99'), undefined);
  assert.equal(paperSizeGroup('a4')?.name, 'A & B series (1:√2)');
});
