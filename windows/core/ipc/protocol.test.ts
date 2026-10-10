import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURL, helloProof, LineReader, newPipeKey, newPipePath, parseClientMessage, parseHello, parseOptimisationRequest, parseServerMessage, urlPath, validProof } from './protocol';

const request = { id: '1234', urls: ['file:///tmp/a.png', 'https://example.com/b.jpg'], hideFloatingResult: true, copyToClipboard: false, aggressiveOptimisation: false, source: 'cli' };

test('a macOS-shaped request parses, keeping only known fields and dropping nil optionals', () => {
  const parsed = parseOptimisationRequest({
    ...request, size: { width: 1200, height: 630, name: '', longEdge: false, smartCrop: true }, compression: { tier: 'custom', factor: 70 },
    placement: { optimised: 'sameFolder', sameFolderTemplate: '%f_small' }, changePlaybackSpeedFrames: 'drop', originalUrls: [], replyPort: 'x', unknown: 1, output: null,
  });
  assert.deepEqual(parsed, {
    ...request, originalUrls: [], size: { width: 1200, height: 630, name: '', longEdge: false, smartCrop: true }, compression: { tier: 'custom', factor: 70 },
    placement: { optimised: 'sameFolder', sameFolderTemplate: '%f_small' }, replyPort: 'x', changePlaybackSpeedFrames: 'drop',
  });
});

test('malformed requests are refused with the field at fault', () => {
  const refuses = (value: object, pattern: RegExp) => assert.throws(() => parseOptimisationRequest({ ...request, ...value }), pattern);
  refuses({ urls: ['ftp://host/x.png'] }, /file, http or https/);
  refuses({ urls: ['not a url'] }, /not a URL/);
  refuses({ urls: 'file:///a.png' }, /urls must be a list/);
  refuses({ hideFloatingResult: 'yes' }, /hideFloatingResult must be true or false/);
  refuses({ downscaleFactor: 0 }, /downscaleFactor must be greater than 0/);
  refuses({ compression: { tier: 'huge', factor: 50 } }, /compression.tier/);
  refuses({ compression: { tier: 'custom', factor: 101 } }, /between 0 and 100/);
  refuses({ placement: { optimised: 'elsewhere' } }, /placement behaviour/);
  refuses({ size: { width: 1.5, height: 2 } }, /size.width must be a whole number/);
  refuses({ changePlaybackSpeedFrames: 'skip' }, /keep, drop/);
});

test('client messages need a known kind and valid JSON', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ kind: 'stop', request: { ids: ['file:///a.png'], remove: false } })), { kind: 'stop', request: { ids: ['file:///a.png'], remove: false } });
  assert.deepEqual(parseClientMessage(JSON.stringify({ kind: 'settings', request: { action: 'get', key: 'stripMetadata', origin: 'mcp' } })), { kind: 'settings', request: { action: 'get', key: 'stripMetadata', origin: 'mcp' } });
  assert.throws(() => parseClientMessage('{'), /not JSON/);
  assert.throws(() => parseClientMessage('[]'), /must be an object/);
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'shell', request: {} })), /optimise, stop or settings/);
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'settings', request: { action: 'delete' } })), /action must be one of/);
});

test('server answers are checked before the client trusts them', () => {
  const response = { path: '/tmp/a.png', forURL: 'file:///tmp/a.png', oldBytes: 10, newBytes: 5, oldWidthHeight: [4, 2], newWidthHeight: [2, 1] };
  assert.deepEqual(parseServerMessage(JSON.stringify({ kind: 'response', response })), { kind: 'response', response });
  assert.deepEqual(parseServerMessage('{"kind":"done"}'), { kind: 'done' });
  assert.throws(() => parseServerMessage(JSON.stringify({ kind: 'response', response: { ...response, oldWidthHeight: { width: 4 } } })), /\[width, height\]/);
  assert.throws(() => parseServerMessage('{"kind":"exec"}'), /unknown kind/);
});

test('lines split across chunks are joined, and an endless line is refused', () => {
  const lines: string[] = [], reader = new LineReader(line => lines.push(line), 16);
  reader.push('{"a":'); reader.push('1}\r\n\n{"b":2}\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.throws(() => reader.push('x'.repeat(32)), /too long/);
});

test('a character split across chunks is joined, and the limit counts bytes', () => {
  const lines: string[] = [], reader = new LineReader(line => lines.push(line), 8);
  const bytes = Buffer.from('é→\n');
  reader.push(bytes.subarray(0, 1)); reader.push(bytes.subarray(1, 3)); reader.push(bytes.subarray(3));
  assert.deepEqual(lines, ['é→']);
  assert.throws(() => reader.push(Buffer.from('ééééé')), /too long/, 'five characters, ten bytes');
});

test('paths travel as file URLs and come back as the same path', () => {
  const file = path.resolve('some folder', 'é.png');
  assert.match(fileURL(file), /^file:\/\//);
  assert.equal(urlPath(fileURL(file)), file);
  assert.equal(urlPath('https://example.com/a.png'), undefined);
});

test('pipe names are random and per platform', () => {
  assert.match(newPipePath('win32'), /^\\\\\.\\pipe\\clop-[0-9a-f]{32}$/);
  assert.notEqual(newPipePath('linux'), newPipePath('linux'));
  assert.match(newPipePath('linux'), /clop-[0-9a-f]{16}\.sock$/);
});

test('the greeting proof needs the key, and a greeting must come first', () => {
  const key = newPipeKey(), nonce = 'abcdefghijklmnopqrstuvwx';
  assert.equal(validProof(key, nonce, helloProof(key, nonce)), true);
  assert.equal(validProof(newPipeKey(), nonce, helloProof(key, nonce)), false);
  assert.equal(validProof(key, 'another nonce entirely!!', helloProof(key, nonce)), false);
  assert.equal(validProof(key, nonce, undefined), false);
  assert.equal(parseHello(JSON.stringify({ hello: nonce })), nonce);
  assert.throws(() => parseHello('{"kind":"settings"}'), /must start with a greeting/);
  assert.throws(() => parseHello(JSON.stringify({ hello: 'short' })), /must start with a greeting/);
});
