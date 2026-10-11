import assert from 'node:assert/strict';
import test from 'node:test';
import { readObject, removeMember, sanitized, setMember } from './jsonc';
import { commandWords, removeCommand, setCommand, shellQuote } from './shellrc';
import { removeTable, setTable, tableValues, tomlStrings } from './toml';
import { childFields, removeChild, setChild } from './yaml';

test('JSONC: comments and trailing commas are blanked in place, strings with // are not comments', () => {
  const text = '{\n  "url": "https://x//y", // note\n  /* a\n  b */ "list": [1, 2,],\n}\n';
  const clean = sanitized(text);
  assert.equal(clean.length, text.length);
  assert.deepEqual(JSON.parse(clean), { url: 'https://x//y', list: [1, 2] });
  assert.deepEqual(readObject('// only a comment\n'), {}, 'comments alone parse as an object to fill');
  assert.equal(setMember('// header\n', 'servers', 'clop', '{}'), '// header\n{\n  "servers": {\n    "clop": {}\n  }\n}\n');
  assert.throws(() => setMember('{"servers": []}', 'servers', 'clop', '{}'), /servers is not a JSON object/);
  assert.equal(removeMember('{"servers": {"a": 1}}', 'servers', 'clop'), undefined);
});

test('JSONC: the last member is cut with the comma before it, a sole member takes its container along', () => {
  const two = '{\n  "servers": {\n    "a": 1,\n    "clop": {\n      "x": 2\n    }\n  },\n  "b": 3\n}\n';
  assert.equal(removeMember(two, 'servers', 'clop'), '{\n  "servers": {\n    "a": 1\n  },\n  "b": 3\n}\n');
  assert.equal(removeMember('{\n  "b": 3,\n  "servers": { "clop": 1 }\n}\n', 'servers', 'clop'), '{\n  "b": 3\n}\n');
});

test('TOML: a table is replaced where it was, its sub-tables and dotted keys go with it, the next comment stays', () => {
  const text = 'a = 1\nmcp_servers.clop.extra = true\n\n[mcp_servers.clop]\ncommand = "old"\n\n[mcp_servers.clop.env]\nX = "1"\n\n# next\n[other]\nb = 2\nmcp_servers.clop.kept = 1\n';
  assert.deepEqual(tableValues(text, ['mcp_servers', 'clop']), { extra: 'true', command: '"old"' });
  assert.equal(setTable(text, ['mcp_servers', 'clop'], ['command = "new"']), 'a = 1\n\n[mcp_servers.clop]\ncommand = "new"\n\n# next\n[other]\nb = 2\nmcp_servers.clop.kept = 1\n', 'a dotted key under [other] belongs to other');
  assert.equal(removeTable(text, ['mcp_servers', 'clop']), 'a = 1\n\n# next\n[other]\nb = 2\nmcp_servers.clop.kept = 1\n');
  assert.equal(removeTable('a = 1\n', ['mcp_servers', 'clop']), undefined);
  assert.deepEqual(tomlStrings('[ "a\\\\b", \'c\' ]'), ['a\\b', 'c']);
  assert.deepEqual(tomlStrings('"\\u00e9"'), ['é']);
  assert.equal(tomlStrings('42'), undefined);
  assert.throws(() => setTable('s = """\nunterminated\n', ['x'], []), /unsupported layout/);
});

test('TOML: CRLF files keep CRLF', () => {
  assert.equal(setTable('a = 1\r\n', ['mcp_servers', 'clop'], ['command = "c"']), 'a = 1\r\n\r\n[mcp_servers.clop]\r\ncommand = "c"\r\n');
});

test('YAML: fields read back, quoted keys, sole child removal takes the parent', () => {
  const text = 'extensions:\n  "clop":\n    cmd: "C:\\\\clop.exe"\n    args: ["mcp", serve]\n    envs: {}\nother: 1\n';
  assert.deepEqual(childFields(text, 'extensions', 'clop'), { cmd: ['C:\\clop.exe'], args: ['mcp', 'serve'], envs: ['{}'] });
  assert.equal(removeChild(text, 'extensions', 'clop'), 'other: 1\n');
  assert.equal(setChild('', 'extensions', 'clop', ['a: 1']), 'extensions:\n  clop:\n    a: 1\n');
  assert.equal(removeChild('x: 1\n', 'extensions', 'clop'), undefined);
});

test('Bash: commands match by words however they are quoted, every copy goes on removal', () => {
  const text = "# c\nmcp add 'clop' --command \"/a b\" \\\n  --args mcp\nset x 1\nmcp add clop --command old\n";
  assert.deepEqual(commandWords(text, ['mcp', 'add', 'clop']), ['mcp', 'add', 'clop', '--command', '/a b', '--args', 'mcp']);
  assert.equal(setCommand(text, ['mcp', 'add', 'clop'], 'mcp add clop --command new'), '# c\nmcp add clop --command new\nset x 1\n');
  assert.equal(removeCommand(text, ['mcp', 'add', 'clop']), '# c\nset x 1\n');
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('C:/x.exe'), 'C:/x.exe');
});
