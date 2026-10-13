import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoInsertArrow, commitStep, completeWithTab, currentStepPrefix, finishText, insertSuggestion, suggestions, type Edit } from './complete';
import { parseSteps } from './parser';

const labels = (prefix: string, fileType?: Parameters<typeof suggestions>[1]) => suggestions(prefix, fileType).map(entry => entry.label);
/** Text with `|` marking the cursor, as an edit. */
const at = (marked: string): Edit => ({ text: marked.replace('|', ''), cursor: marked.indexOf('|') });
const show = ({ text, cursor }: Edit) => `${text.slice(0, cursor)}|${text.slice(cursor)}`;

test('the step being typed starts after the last arrow or line break', () => {
  assert.equal(currentStepPrefix('optimise -> crop(wid', 20), 'crop(wid');
  assert.equal(currentStepPrefix('optimise\nconv', 13), 'conv');
  assert.equal(currentStepPrefix('copy(to: "a") -> ', 17), '');
});

test('step names are offered for the file type, matching anywhere in the name', () => {
  assert.ok(labels('').includes('optimise') && labels('').includes('removeAudio'));
  assert.ok(!labels('', 'image').includes('removeAudio'), 'removeAudio is a video step');
  assert.deepEqual(labels('size'), ['targetSize']);
  assert.ok(labels('scale').includes('downscale'));
  const copy = suggestions('cop', 'image').find(entry => entry.label === 'copy')!;
  assert.deepEqual([copy.insertText, copy.opensParens, copy.needsQuotes], ['copy(to: "', false, true], 'a single mandatory parameter is written out');
  const crop = suggestions('crop')[0];
  assert.deepEqual([crop.insertText, crop.opensParens], ['crop', true]);
});

test('parameters exclude the ones already given and those for other file types', () => {
  assert.deepEqual(labels('crop(width: 100, '), ['height', 'longEdge', 'aspectRatio', 'smartCrop', 'location']);
  assert.ok(labels('optimise(', 'pdf').includes('dpi'));
  assert.ok(!labels('optimise(', 'image').includes('dpi'), 'dpi is PDF only');
  assert.deepEqual(labels('optimise(enc'), ['encoder']);
  assert.deepEqual(labels('teleport('), [], 'an unknown step has nothing to offer');
});

test('values follow the parameter, typed prefix and file type, and say when they close the step', () => {
  assert.deepEqual(labels('optimise(encoder: '), ['aggressive', 'medium', 'lossless']);
  assert.deepEqual(labels('optimise(encoder: ', 'video'), ['fast', 'slowHighQuality', 'visuallyLossless']);
  assert.deepEqual(labels('optimise(encoder: l'), ['lossless']);
  const [only] = suggestions('changeSpeed(factor: 2.0, frames: ', 'video');
  assert.equal(only.closesParens, true, 'frames is the last parameter left');
  assert.equal(suggestions('changeSpeed(frames: ', 'video')[0].closesParens, false, 'factor is still missing');
  assert.equal(suggestions('convert(to: webp, location: ')[3].needsQuotes, true, 'a template location needs quotes');
});

test('template variables are offered inside quotes when empty or after %', () => {
  assert.equal(labels('move(to: "').length, 15);
  assert.deepEqual(labels('move(to: "~/Pictures/%y/%m'), ['%m', '%n', '%M'], '%m, %n (monthName) and %M (minutes) all match "m"');
  assert.deepEqual(labels('move(to: "%month'), ['%m', '%n'], 'by name too');
  assert.deepEqual(labels('move(to: "~/Pictures'), [], 'a path being typed gets no suggestions');
});

test('inserting a suggestion replaces what it completes and places the cursor', () => {
  const pick = (marked: string, label: string, fileType?: Parameters<typeof suggestions>[1]) => {
    const edit = at(marked), suggestion = suggestions(currentStepPrefix(edit.text, edit.cursor), fileType).find(entry => entry.label === label)!;
    return show(insertSuggestion(edit.text, edit.cursor, suggestion));
  };
  assert.equal(pick('optimise -> cr|', 'crop'), 'optimise -> crop(|');
  assert.equal(pick('cop|', 'copy'), 'copy(to: "|"');
  assert.equal(pick('opt| -> crop(width: 100)', 'optimise'), 'optimise(| -> crop(width: 100)', 'only the step under the cursor is replaced');
  assert.equal(pick('crop(|', 'width'), 'crop(width: |');
  assert.equal(pick('crop(width: 100,|', 'height'), 'crop(width: 100, height: |');
  assert.equal(pick('if(|', 'regex'), 'if(regex: "|"');
  assert.equal(pick('optimise(encoder: agg|', 'aggressive'), 'optimise(encoder: aggressive, |');
  assert.equal(pick('changeSpeed(factor: 2.0, frames: |', 'drop', 'video'), 'changeSpeed(factor: 2.0, frames: drop)|');
  assert.equal(pick('convert(to: webp, location: |', 'template'), 'convert(to: webp, location: "|"');
  assert.equal(pick('move(to: "~/Pictures/%y/%|', '%m'), 'move(to: "~/Pictures/%y/%m|');
});

test('typing a letter after a closed step puts an arrow in between', () => {
  assert.equal(show(autoInsertArrow('optimise(encoder: lossless)c', 28)!), 'optimise(encoder: lossless) -> c|');
  assert.equal(show(autoInsertArrow('crop(width: 10)  d', 18)!), 'crop(width: 10) -> d|');
  assert.equal(autoInsertArrow('crop(width: 10) -> d', 20), undefined);
  assert.equal(autoInsertArrow('crop(width: 1', 13), undefined, 'digits never start a step');
});

test('committing a step closes it, its quote, and starts the next one', () => {
  assert.equal(show(commitStep('crop(width: 100, ', 17)!), 'crop(width: 100) -> |');
  assert.equal(show(commitStep('move(to: "~/out', 15)!), 'move(to: "~/out") -> |');
  assert.equal(commitStep('optimise', 8), undefined);
  // With a step after it, the cursor stays beside the committed step and the later steps are left where they are.
  assert.equal(show(commitStep('capFps(fps: 3 -> convert(to: webp)', 13)!), 'capFps(fps: 3)| -> convert(to: webp)');
  assert.equal(show(commitStep('capFps(fps: 3, \nconvert(to: webp)', 14)!), 'capFps(fps: 3)|\nconvert(to: webp)');
  assert.equal(finishText('  crop(width: 100) ->  '), 'crop(width: 100)');
});

test('Tab takes the first suggestion and closes a step once every parameter is filled', () => {
  assert.equal(show(completeWithTab('downsc', 6)!), 'downscale(|');
  assert.equal(show(completeWithTab('changeSpeed(factor: 2.0, frames: ', 33, 'video')!), 'changeSpeed(factor: 2.0, frames: keep) -> |');
  assert.equal(show(completeWithTab('capFps(fps: 3', 13, 'video')!), 'capFps(fps: 30) -> |');
  assert.equal(completeWithTab('zzz', 3), undefined, 'nothing to complete outside parentheses');
  // Whatever Tab writes parses.
  let edit: Edit = { text: 'lowerBit', cursor: 8 };
  for (let i = 0; i < 5; i++) edit = completeWithTab(edit.text, edit.cursor, 'audio') ?? edit;
  assert.deepEqual(parseSteps(finishText(edit.text), { fileType: 'audio' }), [{ lowerBitrate: { kbps: 192, location: 'inPlace' } }]);
});
