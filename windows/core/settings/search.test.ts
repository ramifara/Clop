import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTING_ENTRIES, type SettingEntry } from './entries';
import { rank, searchSettings, subsequenceScore, wordScore, words } from './search';

const ids = (query: string, limit = 3) => searchSettings(query).slice(0, limit).map(entry => entry.id);
const entry = (id: string, title: string, keywords: string[] = [], subtitle = ''): SettingEntry => ({ id, keys: [], title, subtitle, keywords, tab: 'general', section: '' });

test('words are lowercase runs of letters and digits', () => {
  assert.deepEqual(words('Auto-conversion, 4K & MP4!'), ['auto', 'conversion', '4k', 'mp4']);
  assert.deepEqual(words('Größe  Wähle'), ['größe', 'wähle']);
});

test('word scores are graded: whole word, prefix, shared stem, substring, nothing', () => {
  assert.equal(wordScore('send', 'send'), 1);
  assert.equal(wordScore('sen', 'send'), 0.9);
  assert.ok(wordScore('replacing', 'replace') > 0.4 && wordScore('replacing', 'replace') < 0.9);
  assert.equal(wordScore('lace', 'replace'), 0.5);
  assert.equal(wordScore('compression', 'compatibility'), 0);
});

test('a subsequence needs four letters and every letter in order, and tight runs score higher', () => {
  assert.equal(subsequenceScore('met', 'metadata'), undefined);
  assert.equal(subsequenceScore('metdata', 'strip exif metadata') !== undefined, true);
  assert.equal(subsequenceScore('xyzw', 'metadata'), undefined);
  assert.ok(subsequenceScore('meta', 'metadata')! > subsequenceScore('meta', 'mxexxtxxa')!);
});

test('a title hit outranks the same word in a subtitle', () => {
  const rows = [entry('b', 'Something else', [], 'Send the thing'), entry('a', 'Send securely')];
  assert.deepEqual(rank('send', true, 25, rows).map(row => row.id), ['a', 'b']);
});

test('requiring every word drops rows missing one, and the field falls back to the partial match', () => {
  const rows = [entry('a', 'Strip metadata'), entry('b', 'Strip nothing')];
  assert.deepEqual(rank('strip metadata', true, 25, rows).map(row => row.id), ['a']);
  assert.deepEqual(searchSettings('strip metadata zebra', rows).map(row => row.id), ['a', 'b']);
  assert.deepEqual(rank('zebra', false, 25, rows), []);
});

test('stop words are dropped unless they are all there is', () => {
  const rows = [entry('a', 'Replace the original', ['placement'])];
  assert.deepEqual(rank('how do I replace the original', true, 25, rows).map(row => row.id), ['a']);
  assert.deepEqual(rank('the', true, 25, rows).map(row => row.id), ['a']);
  assert.deepEqual(rank('', true, 25, rows), []);
  assert.deepEqual(rank('a', true, 25, rows), []);
});

test('questions in a user\'s words find the rows that answer them', () => {
  assert.ok(ids('replacing the original video').some(id => id.startsWith('files.')));
  assert.equal(ids('clipbord', 5).includes('clipboard.clipboard.enableClipboardOptimiser') || ids('clipbord', 5).some(id => id.startsWith('clipboard.')), true);
  assert.equal(ids('metdata')[1], 'general.optimisation.stripMetadata');
  assert.equal(ids('mp4')[0], 'video.compatibility.formatsToConvertToMP4');
  assert.equal(ids('fps')[0], 'video.optimisationrules.capVideoFPS');
  assert.equal(ids('hdr')[0], 'images.optimisationrules.convertHDRToSDR');
  assert.equal(ids('nvidia')[0], 'video.optimisationrules.videoEncoder');
  assert.equal(ids('startup')[0], 'general.main.launchAtLogin');
  assert.equal(ids('tray')[0], 'general.main.showMenubarIcon');
  assert.equal(ids('agents')[0], 'mcp.main.mcpEnabled');
});

test('results are capped and ties break by title', () => {
  assert.ok(searchSettings('optimise').length <= 25);
  const rows = [entry('b', 'Beta thing'), entry('a', 'Alpha thing')];
  assert.deepEqual(rank('thing', true, 25, rows).map(row => row.id), ['a', 'b']);
  assert.ok(SETTING_ENTRIES.length > 100);
});
