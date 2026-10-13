import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { graphic } from '../core/media/image.fixtures';
import { needTools } from '../core/testing';
import { connect, folder } from './mcp.fixtures';

// An agent's strings are data. Whatever they look like, they must reach `clop` as the file, value or name they are,
// never as a flag, so a path cannot turn on `--output` and a value cannot ask for help.

const exists = (file: string) => stat(file).then(() => true, () => false);

test('a path that looks like a flag is a file name, not a flag', async t => {
  const f = await folder(t, { mcpEnabled: true });
  await graphic(40, 30).png().toFile(f.file('a.png'));
  const { call } = await connect(t, f);
  const help = await call('clop_optimise', { paths: ['-h'], compression: '60' });
  assert.equal(help.error, true, help.text);
  assert.doesNotMatch(help.text, /USAGE|OVERVIEW/, 'not the help text');
  assert.match(help.text, /-h/);
  const before = await readFile(f.file('a.png'));
  const smuggled = await call('clop_optimise', { paths: [f.file('a.png'), `--output=${f.file('stolen.png')}`], compression: '60' });
  assert.equal(smuggled.error, true, smuggled.text);
  assert.equal(await exists(f.file('stolen.png')), false, 'the second path was not read as --output');
  assert.deepEqual(await readFile(f.file('a.png')), before, 'nothing ran');
  const async = await call('clop_pipeline_run', { pipeline: 'optimise()', paths: ['--async'] });
  assert.equal(async.error, true);
  assert.match(async.text, /--async/);
  assert.doesNotMatch(async.text, /^\s*\{?\s*"?queued/);
  const tools = ['clop_downscale', 'clop_crop', 'clop_strip_exif', 'clop_crop_pdf', 'clop_uncrop_pdf'];
  for (const name of tools) {
    const result = await call(name, { paths: ['-h'], factor: 0.5, size: '10x10', forDevice: 'iPad Air' });
    assert.doesNotMatch(result.text, /USAGE|OVERVIEW/, `${name} did not print help`);
  }
});

test('a file named like a flag is optimised', async t => {
  if (!needTools(t, 'pngquant')) return;
  const f = await folder(t, { mcpEnabled: true });
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(f.file('-x.png'));
  const { call } = await connect(t, f);
  const result = await call('clop_optimise', { paths: ['-x.png'], compression: '60' });
  assert.equal(result.error, false, result.text);
  assert.equal(JSON.parse(result.text).done.length, 1);
});

test('values that start with a dash reach settings and pipeline commands as values', async t => {
  const f = await folder(t, { mcpEnabled: true });
  const { call } = await connect(t, f);
  const set = await call('clop_settings_set', { key: 'customNameTemplateForClipboardImages', value: '-foo' });
  assert.equal(set.error, false, set.text);
  assert.equal((await f.settings()).customNameTemplateForClipboardImages, '-foo');
  const get = await call('clop_settings_get', { key: '-h' });
  assert.equal(get.error, true);
  assert.match(get.text, /no setting named '-h'/);
  const written = await call('clop_pipeline_write', { name: '-dash', steps: 'optimise()' });
  assert.equal(written.error, false, written.text);
  assert.equal(JSON.parse((await call('clop_pipeline_show', { name: '-dash' })).text).name, '-dash');
  const flagged = await call('clop_pipeline_write', { name: 'second', steps: 'optimise()', fileType: '--force' });
  assert.equal(flagged.error, true, 'an option value is one token, so `--force` is a file type');
  await writeFile(f.file('x.txt'), 'x');
});
