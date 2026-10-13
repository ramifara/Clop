import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { graphic } from '../core/media/image.fixtures';
import { textPDF } from '../core/media/pdf.fixtures';
import { needTools } from '../core/testing';
import { connect, folder } from './mcp.fixtures';
import { main } from './main';

// `output` names where a result goes. For an agent it may never name a file that is already there; for a person it may,
// and the file it replaces is kept in the work folder's backups, as every other replaced file is.

const exists = (file: string) => stat(file).then(() => true, () => false);
const backups = (userData: string) => readdir(path.join(userData, 'work', 'backups')).catch(() => []);
const REFUSED = /already exists/;

test('an agent cannot send a result over a file that exists', async t => {
  if (!needTools(t, 'pngquant')) return;
  const f = await folder(t, { mcpEnabled: true });
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(f.file('a.png'));
  await writeFile(f.file('victim.txt'), 'precious');
  await writeFile(f.file('victim.webp'), 'precious');
  const original = await readFile(f.file('a.png'));
  const { call } = await connect(t, f);
  const refused = [
    await call('clop_optimise', { paths: [f.file('a.png')], compression: '60', output: f.file('victim.txt') }),
    await call('clop_optimise', { paths: [f.file('a.png')], compression: '60', output: 'victim.txt' }),
    await call('clop_downscale', { paths: [f.file('a.png')], factor: 0.5, output: f.file('victim.txt') }),
    await call('clop_crop', { paths: [f.file('a.png')], size: '50x50', output: f.file('victim.txt') }),
    await call('clop_convert', { paths: [f.file('a.png')], kind: 'image', to: 'webp', output: f.file('victim.webp') }),
  ];
  for (const result of refused) { assert.equal(result.error, true, result.text); assert.match(result.text, REFUSED); }
  assert.equal(await readFile(f.file('victim.txt'), 'utf8'), 'precious');
  assert.equal(await readFile(f.file('victim.webp'), 'utf8'), 'precious');
  assert.deepEqual(await readFile(f.file('a.png')), original, 'the input is untouched too');
  // A new name, and the input's own name, are fine.
  const fresh = await call('clop_optimise', { paths: [f.file('a.png')], compression: '60', output: f.file('fresh.png') });
  assert.equal(fresh.error, false, fresh.text);
  assert.equal(await exists(f.file('fresh.png')), true);
  const same = await call('clop_optimise', { paths: [f.file('a.png')], compression: '60', output: f.file('a.png') });
  assert.equal(same.error, false, same.text);
});

test('an agent cannot send a PDF over a file that exists', async t => {
  const f = await folder(t, { mcpEnabled: true });
  await writeFile(f.file('doc.pdf'), await textPDF(2));
  await writeFile(f.file('victim.pdf'), 'precious');
  const { call } = await connect(t, f);
  for (const result of [
    await call('clop_crop_pdf', { paths: [f.file('doc.pdf')], paperSize: 'A4', output: f.file('victim.pdf') }),
    await call('clop_uncrop_pdf', { paths: [f.file('doc.pdf')], output: f.file('victim.pdf') }),
  ]) { assert.equal(result.error, true, result.text); assert.match(result.text, REFUSED); }
  assert.equal(await readFile(f.file('victim.pdf'), 'utf8'), 'precious');
  const fresh = await call('clop_crop_pdf', { paths: [f.file('doc.pdf')], paperSize: 'A4', output: f.file('fresh.pdf') });
  assert.equal(fresh.error, false, fresh.text);
});

async function cli(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-out-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userData = path.join(dir, 'data'), err: string[] = [];
  const clop = (...argv: string[]) => { err.length = 0; return main(argv, { io: { out: () => {}, err: text => { err.push(text); }, errTTY: false }, cwd: dir, options: { userData, home: dir }, env: {}, colours: false }); };
  return { dir, userData, clop, err: () => err.join(''), file: (name: string) => path.join(dir, name) };
}

test('a person can replace a file with output, and the file it replaced is backed up', async t => {
  if (!needTools(t, 'pngquant')) return;
  const c = await cli(t);
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(c.file('a.png'));
  await writeFile(c.file('victim.txt'), 'precious');
  await writeFile(c.file('doc.pdf'), await textPDF(2));
  await writeFile(c.file('victim.pdf'), 'precious pdf');
  assert.equal(await c.clop('optimise', 'files', 'a.png', '--output=victim.txt', '--no-progress'), 0, c.err());
  assert.notEqual(await readFile(c.file('victim.txt'), 'utf8'), 'precious');
  const kept = await Promise.all((await backups(c.userData)).map(name => readFile(path.join(c.userData, 'work', 'backups', name), 'utf8')));
  assert.deepEqual(kept, ['precious']);
  assert.equal(await c.clop('crop-pdf', '--paper-size', 'A4', 'doc.pdf', '--output=victim.pdf'), 0, c.err());
  assert.notEqual(await readFile(c.file('victim.pdf'), 'utf8'), 'precious pdf');
  const all = await Promise.all((await backups(c.userData)).map(name => readFile(path.join(c.userData, 'work', 'backups', name), 'utf8')));
  assert.deepEqual(all.sort(), ['precious', 'precious pdf']);
  assert.equal(await c.clop('uncrop-pdf', 'victim.pdf', '--output=doc.pdf'), 0, c.err());
  assert.equal((await backups(c.userData)).length, 3, 'the PDF over doc.pdf was kept too');
  assert.equal(await c.clop('uncrop-pdf', 'doc.pdf'), 0, c.err());
  assert.equal((await backups(c.userData)).length, 3, 'working on the input itself keeps no extra backup');
});
