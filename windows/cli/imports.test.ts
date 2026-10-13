import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The project's typecheck does not flag unused locals, so a name left over from a refactor stays in the import line.
test('every name a command module imports is used in it', () => {
  const dir = import.meta.dirname, unused: string[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/^import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s+from/gm)) for (const part of match[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
      if (name && (text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0) < 2) unused.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(unused, []);
});
