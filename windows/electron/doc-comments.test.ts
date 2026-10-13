import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

test('no doc comment opens twice in a row', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const doubled: string[] = [];
  for (const dir of ['core', 'electron', 'cli', 'src']) for (const file of sources(path.join(root, dir))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, n) => { if (line.trim() === '/**' && lines[n + 1]?.trim() === '/**') doubled.push(`${path.relative(root, file)}:${n + 1}`); });
  }
  assert.deepEqual(doubled, []);
});
