import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { byteRange, MediaFiles } from './media-files';

async function session(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'session'), item = path.join(root, 'item');
  await mkdir(item, { recursive: true });
  const video = path.join(item, 'clip.mp4'), outside = path.join(dir, 'secret.txt');
  await writeFile(video, Buffer.from('0123456789'));
  await writeFile(outside, 'not for the renderer');
  return { dir, root, item, video, outside, files: new MediaFiles([root]) };
}
const get = (files: MediaFiles, url: string, headers: Record<string, string> = {}, method = 'GET') => files.handle(new Request(url, { method, headers }));

test('only files inside the session get a URL, and each keeps one opaque token', async t => {
  const { files, video, outside, root, dir } = await session(t);
  const url = files.url(video);
  assert.match(url, /^clop-media:\/\/file\/[0-9a-f-]{36}$/);
  assert.equal(files.url(path.join(path.dirname(video), '.', 'clip.mp4')), url);
  assert.ok(!url.includes('clip'));
  for (const file of [outside, root, path.join(root, '..', 'secret.txt'), path.join(dir, 'session-other', 'x.png'), 'relative.png']) assert.throws(() => files.url(file), /not a file of this session/);
});

test('serves a token\'s file whole, by byte range and by HEAD, and nothing else', async t => {
  const { files, video, outside, root } = await session(t);
  const url = files.url(video);
  const whole = await get(files, url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(await whole.text(), '0123456789');
  const part = await get(files, url, { range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(part.headers.get('content-length'), '4');
  assert.equal(await part.text(), '2345');
  assert.equal(await (await get(files, url, { range: 'bytes=7-' })).text(), '789');
  assert.equal(await (await get(files, url, { range: 'bytes=-3' })).text(), '789');
  const beyond = await get(files, url, { range: 'bytes=10-12' });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), 'bytes */10');
  const head = await get(files, url, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await get(files, url, {}, 'POST')).status, 405);
  // Paths and unknown tokens are never served, even for a file the session could name.
  for (const other of [`clop-media://file/${encodeURIComponent(outside)}`, 'clop-media://file/../secret.txt', 'clop-media://file/00000000-0000-0000-0000-000000000000', 'clop-media://file/%', 'clop-media://file/%E0%A4%A', 'clop-media://file/%zz', `clop-media://file/${encodeURIComponent(path.join(root, 'item', 'clip.mp4'))}`]) {
    assert.equal((await get(files, other)).status, 404, other);
  }
});

test('a revoked folder\'s files stop being served', async t => {
  const { files, video, item } = await session(t);
  const url = files.url(video);
  files.revoke(item);
  assert.equal((await get(files, url)).status, 404);
  assert.notEqual(files.url(video), url);
});

test('a link out of the session is not followed', async t => {
  const { files, outside, root } = await session(t);
  const link = path.join(root, 'link.txt');
  try { await symlink(outside, link); } catch { t.skip('this system cannot create symbolic links'); return; }
  assert.equal((await get(files, files.url(link))).status, 404);
});

test('parses single byte ranges', () => {
  assert.equal(byteRange(null, 10), undefined);
  assert.equal(byteRange('bytes=0-1,4-5', 10), undefined);
  assert.equal(byteRange('items=0-1', 10), undefined);
  assert.deepEqual(byteRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(byteRange('bytes=3-100', 10), { start: 3, end: 9 });
  assert.deepEqual(byteRange('bytes=-100', 10), { start: 0, end: 9 });
  assert.equal(byteRange('bytes=-', 10), 'invalid');
  assert.equal(byteRange('bytes=5-2', 10), 'invalid');
  assert.equal(byteRange('bytes=-0', 10), 'invalid');
  assert.equal(byteRange('bytes=0-', 0), 'invalid');
});
