import { hasLongPathAware } from './after-pack.mjs';
import path from 'node:path';
import { unpackedDir } from './unpacked.mjs';

// CI: the packed app's manifest must say it is long path aware, once, in its one asm.v3 application element (see after-pack.mjs).
const file = process.argv[2] ?? path.join(unpackedDir(), 'Clop for Windows.exe');
if (!await hasLongPathAware(file)) {
  console.error(`${file} is not marked longPathAware in its manifest (it needs one longPathAware element set to true and one asm.v3 application element).`);
  process.exit(1);
}
console.log(`${file} is marked longPathAware.`);
