// Prints the Defaults key names declared in a macOS Swift source, one per line.
// Usage: node scripts/extract-mac-settings.mjs [swift file, default ../Clop/Settings.swift]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] ?? fileURLToPath(new URL('../../Clop/Settings.swift', import.meta.url));
const names = [...readFileSync(file, 'utf8').matchAll(/static let (\w+) = Key</g)].map(match => match[1]);
process.stdout.write(names.map(name => `${name}\n`).join(''));
