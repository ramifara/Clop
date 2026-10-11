import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists } from './fileops';

test('exists is false only when the file is absent', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-fileops-'));
  t.after(async () => { await chmod(path.join(dir, 'locked'), 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, 'file.txt'), 'x');
  assert.equal(await exists(path.join(dir, 'file.txt')), true);
  assert.equal(await exists(path.join(dir, 'missing.txt')), false);
  assert.equal(await exists(path.join(dir, 'file.txt', 'inside')), false);
});

test('exists propagates errors that do not mean the file is absent', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-fileops-'));
  t.after(async () => { await chmod(path.join(dir, 'locked'), 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await mkdir(path.join(dir, 'locked'));
  await writeFile(path.join(dir, 'locked', 'file.txt'), 'x');
  await chmod(path.join(dir, 'locked'), 0o000);
  await assert.rejects(exists(path.join(dir, 'locked', 'file.txt')), { code: 'EACCES' });
});
