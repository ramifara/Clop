import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertsToMP4, imageConversionTarget } from './conversion';
import { audioConversionTarget } from './audioFormat';

test('images convert to JPEG or PNG by the Compatibility lists, with the macOS defaults when a list is missing', () => {
  for (const ext of ['webp', 'avif', 'heic', 'heif', 'bmp', 'WEBP', '.bmp']) assert.equal(imageConversionTarget(ext), 'jpeg', ext);
  for (const ext of ['tiff', 'tif']) assert.equal(imageConversionTarget(ext), 'png', ext);
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'jxl', 'svg']) assert.equal(imageConversionTarget(ext), undefined, ext);
  assert.equal(imageConversionTarget('webp', { formatsToConvertToJPEG: [] }), undefined);
  assert.equal(imageConversionTarget('jxl', { formatsToConvertToJPEG: ['jxl'] }), 'jpeg');
  assert.equal(imageConversionTarget('webp', { formatsToConvertToJPEG: [], formatsToConvertToPNG: ['webp'] }), 'png');
  assert.equal(imageConversionTarget('heic', { formatsToConvertToJPEG: ['jpg'] }), undefined);
  assert.equal(imageConversionTarget('jpeg', { formatsToConvertToJPEG: ['jpg'] }), undefined, 'a type is never converted to itself');
  // JPEG is checked first, as macOS does for a type in both lists.
  assert.equal(imageConversionTarget('bmp', { formatsToConvertToJPEG: ['bmp'], formatsToConvertToPNG: ['bmp'] }), 'jpeg');
});

test('videos convert to MP4 only for the types the caller lists', () => {
  const mac = { formatsToConvertToMP4: ['mov', 'm2v', 'mpg', 'webm'] };
  for (const ext of ['mov', 'MOV', '.webm', 'mpg', 'mpeg', 'm2v', 'qt']) assert.equal(convertsToMP4(ext, mac), true, ext);
  for (const ext of ['mp4', 'mkv', 'avi', 'm4v']) assert.equal(convertsToMP4(ext, mac), false, ext);
  assert.equal(convertsToMP4('mov', { formatsToConvertToMP4: [] }), false);
  assert.equal(convertsToMP4('mov'), false, 'pipeline steps and card edits pass no list and keep the container');
  assert.equal(convertsToMP4('mp4', { formatsToConvertToMP4: ['mp4'] }), false);
});

test('audio in the output-format list converts to the chosen output format after the AAC and MP3 lists', () => {
  const none = { formatsToConvertToAAC: [], formatsToConvertToMP3: [] };
  assert.equal(audioConversionTarget('wav', { ...none, formatsToConvertToOutputAudio: ['wav', 'flac'], audioFormat: 'opus' }), 'opus');
  assert.equal(audioConversionTarget('aiff', { ...none, formatsToConvertToOutputAudio: ['wav', 'flac'], audioFormat: 'opus' }), undefined);
  assert.equal(audioConversionTarget('flac', { ...none, formatsToConvertToOutputAudio: ['flac'], audioFormat: 'sameAsInput' }), undefined);
  assert.equal(audioConversionTarget('flac', { ...none, formatsToConvertToOutputAudio: ['flac'] }), undefined, 'both settings are needed');
  assert.equal(audioConversionTarget('wav', { formatsToConvertToMP3: ['wav'], formatsToConvertToOutputAudio: ['wav'], audioFormat: 'flac' }), 'mp3', 'the MP3 list wins');
  assert.equal(audioConversionTarget('flac', { formatsToConvertToOutputAudio: ['flac'], audioFormat: 'wav' }), 'aac', 'the default AAC list wins');
});
