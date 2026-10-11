import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CANCELLED_PREFIX, FACTOR_OPTIONS_TEXT, FACTOR_SCHEMA, INSTRUCTIONS, SMALLER_OPTIONS_TEXT, SMALLER_SCHEMA } from './mcp-copy';
import { GATE, TOOLS } from './mcp-table';

// Drift test: the tool table, the instructions and the question copy read back out of ClopCLI/MCPToolTable.swift.

const swift = readFileSync(path.join(import.meta.dirname, '..', '..', 'ClopCLI', 'MCPToolTable.swift'), 'utf8');

/** Reads a Swift literal: strings, numbers, booleans, `[…]` arrays and `[k: v]` dictionaries. Anything else is kept as `{ $expr }`. */
function parseSwift(text: string) {
  let i = 0;
  const space = () => { for (;;) { while (/\s/.test(text[i] ?? '')) i++; if (!text.startsWith('//', i)) return; while (i < text.length && text[i] !== '\n') i++; } };
  const string = () => {
    let out = '';
    for (i++; text[i] !== '"'; i++) out += text[i] === '\\' ? ({ n: '\n', t: '\t' } as Record<string, string>)[text[++i]] ?? text[i] : text[i];
    i++;
    return out;
  };
  const value = (): unknown => {
    space();
    if (text.startsWith('[String: Any]()', i)) { i += 15; return {}; }
    if (text[i] === '"') return string();
    if (text[i] === '[') return collection();
    const start = i;
    for (let depth = 0; i < text.length && !(depth === 0 && /[,\]]/.test(text[i])); i++) depth += '([{'.includes(text[i]) ? 1 : ')]}'.includes(text[i]) ? -1 : 0;
    const raw = text.slice(start, i).trim();
    return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : { $expr: raw };
  };
  const collection = (): unknown => {
    i++; space();
    if (text[i] === ']') { i++; return []; }
    if (text[i] === ':') { i++; space(); i++; return {}; }
    const first = value(); space();
    if (text[i] !== ':') {
      const list = [first];
      while (text[i] === ',') { i++; space(); if (text[i] === ']') break; list.push(value()); space(); }
      i++;
      return list;
    }
    const dict: Record<string, unknown> = {};
    let key = first as string;
    for (;;) {
      i++; dict[key] = value(); space();
      if (text[i] === ',') { i++; space(); }
      if (text[i] === ']') { i++; return dict; }
      key = value() as string; space();
    }
  };
  return value();
}

/** A Swift description: string literals and the `gate` constant joined with `+`. */
function description(expression: string, gate: string) {
  const parts = expression.split(/\s*\+\s*(?=["g])/).map(part => part.trim());
  return parts.map(part => part === 'gate' ? gate : parseSwift(part) as string).join('');
}

/** A `"""` string literal: the closing quotes' indent removed and `\` line continuations joined. */
function multiline(name: string) {
  const match = new RegExp(`static let ${name} = """\\n([\\s\\S]*?)\\n( *)"""`).exec(swift);
  assert.ok(match, name);
  return match[1].split('\n').map(line => line.slice(match[2].length)).join('\n').replace(/\\\n/g, '');
}

function swiftTools() {
  const table = swift.slice(swift.indexOf('static let tools: [MCPTool] = ['), swift.indexOf('static let toolsByName'));
  return table.split('MCPTool(').slice(1).map(block => ({
    name: /name: "([^"]+)"/.exec(block)![1],
    description: block.slice(block.indexOf('description:') + 12, block.indexOf(',\n            inputSchema:')),
    schema: parseSwift(block.slice(block.indexOf('inputSchema:') + 12, block.indexOf(',\n            handler:'))) as { required?: string[]; properties: Record<string, unknown> },
  }));
}

const swiftGate = description(/static let gate = ([\s\S]*?)\n\n/.exec(swift)![1], '');

/** Tools whose words say something untrue on Windows (Clop Pro, macOS log persistence), and what changed. */
const REWORDED: Record<string, (text: string) => string> = {
  clop_start_server: text => text.replace(' once they have Clop Pro,', ','),
  clop_status: text => text.replace(' whether the user has Clop Pro,', ''),
};

test('the 23 tools match ClopCLI/MCPToolTable.swift: names, order, required arguments and input schemas', () => {
  const mac = swiftTools();
  assert.equal(mac.length, 23);
  assert.deepEqual(TOOLS.map(tool => tool.name), mac.map(tool => tool.name));
  for (const [index, tool] of TOOLS.entries()) {
    const { schema } = mac[index];
    assert.deepEqual(tool.inputSchema.required ?? [], schema.required ?? [], `${tool.name} required`);
    // The one schema value that is code in Swift: `LogPersistAction.allCases.map(\.rawValue)`.
    const action = (schema.properties.action as { enum?: { $expr: string } } | undefined)?.enum;
    if (action?.$expr === 'LogPersistAction.allCases.map(\\.rawValue)') (schema.properties.action as { enum: unknown }).enum = ['on', 'off', 'status'];
    assert.deepEqual(JSON.parse(JSON.stringify(tool.inputSchema)), schema, `${tool.name} input schema`);
  }
});

test('descriptions are the Swift ones, with the Windows gate and only the Pro and macOS log wording changed', () => {
  assert.equal(swiftGate, "Refused until the user allows agent changes in Clop Settings, MCP, and the whole MCP server needs Clop Pro. Clop's own words come back verbatim when it refuses.");
  assert.equal(GATE, swiftGate.replace(', and the whole MCP server needs Clop Pro', ''));
  for (const [index, mac] of swiftTools().entries()) {
    const tool = TOOLS[index];
    if (tool.name === 'clop_debug_logs') { assert.match(description(mac.description, GATE), /macOS requires root/); continue; }
    const expected = (REWORDED[tool.name] ?? (text => text))(description(mac.description, GATE));
    assert.equal(tool.description, expected, tool.name);
    assert.doesNotMatch(tool.description, /Clop Pro|macOS/, tool.name);
  }
});

test('the instructions and question copy match the Swift', () => {
  assert.equal(INSTRUCTIONS, multiline('instructions'));
  assert.equal(SMALLER_OPTIONS_TEXT, multiline('smallerOptionsText'));
  assert.equal(FACTOR_OPTIONS_TEXT, multiline('factorOptionsText'));
  assert.equal(CANCELLED_PREFIX, multiline('cancelledPrefix'));
  const schema = (name: string) => parseSwift(new RegExp(`static let ${name}: \\[String: Any\\] = (\\[[\\s\\S]*?\\n    \\])\\n`).exec(swift)![1]);
  assert.deepEqual(SMALLER_SCHEMA, schema('smallerSchema'));
  assert.deepEqual(FACTOR_SCHEMA, schema('factorSchema'));
});
