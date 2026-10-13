import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { graphic } from '../media/image.fixtures';
import { evaluateFilter, icuRegex, smartCaseRegex } from './filters';

test('ICU patterns from macOS are read as JavaScript ones', () => {
  const cases: [string, string, boolean][] = [
    ['(?i)SCREEN', 'screenshot.png', true],
    ['(?is)^a.b', 'A\nB', true],
    ['^a++b$', 'aaab', true],
    ['^\\d{2}+x', '12x', true],
    ['^[+*]+$', '+*+', true],
    ['^\\++$', '+++', true],
    ['^(?:ab)?+c', 'abc', true],
    ['\\Qa.b(\\E$', 'xa.b(', true],
    ['\\Qa.b\\E', 'axb', false],
    ['\\Ashot', 'shot.png', true],
    ['png\\z', 'shot.png', true],
    ['^[\\]a]+$', ']a]', true],
    ['^\\p{Lu}', 'Écran.png', true],
  ];
  for (const [pattern, text, expected] of cases) assert.equal(icuRegex(pattern).test(text), expected, pattern);
  for (const pattern of ['(?>a)b', '(?x) a', '\\h+', 'a(?i)b', '[unclosed', '[[:alpha:]]', '[a-z&&[^aeiou]]', '\\x{41}']) assert.throws(() => icuRegex(pattern), /cannot read/, pattern);
});

test('regex is smart case', () => {
  assert.equal(smartCaseRegex('^screen\\s?shot').test('Screen Shot.png'), true);
  assert.equal(smartCaseRegex('^Screen').test('screenshot.png'), false);
  assert.equal(smartCaseRegex('\\S+\\W').test('ABC.png'), true, 'escapes do not count as upper case');
});

test('conditions read the file, its name and the copying app', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-filter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'shot-12.png');
  await graphic(300, 200).withMetadata({ density: 144 }).png().toFile(png);
  const pass = async (condition: Parameters<typeof evaluateFilter>[0], app?: { id?: string; name?: string }) => (await evaluateFilter(condition, png, app)).matches;
  assert.equal(await pass({ types: ['jpeg', 'png'] }), true);
  assert.equal(await pass({ types: ['public.png'] }), true);
  assert.equal(await pass({ types: ['image'] }), true);
  assert.equal(await pass({ types: ['jpg', 'video'] }), false);
  assert.equal(await pass({ nameContains: 'SHOT' }), true);
  assert.equal(await pass({ nameIs: 'shot-12.PNG' }), false);
  assert.equal(await pass({ widthGreaterThan: 299, heightLowerThan: 201 }), true);
  assert.equal(await pass({ widthGreaterThan: 300 }), false);
  assert.equal(await pass({ minResolution: 200 }), true);
  assert.equal(await pass({ minResolution: 201 }), false);
  assert.equal(await pass({ dpiGreaterThan: 100, dpiLowerThan: 200 }), true);
  assert.equal(await pass({ fileSizeLowerThan: 10 }), false);
  assert.equal(await pass({ copiedBy: 'paint' }, { id: 'C:\\Windows\\System32\\mspaint.exe', name: 'Paint' }), true);
  assert.equal(await pass({ copiedBy: 'paint' }), false);
  assert.deepEqual(await evaluateFilter({ regex: '^(shot)-(x)?(\\d+)' }, png), { matches: true, captures: ['shot', '12'] }, 'a group that took no part is left out');

  const text = path.join(dir, 'notes.txt');
  await writeFile(text, 'hello');
  assert.equal((await evaluateFilter({ widthGreaterThan: 0 }, text)).matches, false, 'a width that cannot be read fails');
  await assert.rejects(evaluateFilter({ regex: '(?>a)' }, png), /cannot read/);
});
