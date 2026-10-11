import { hasLongPathAware } from './after-pack.mjs';

// CI: the packed app must say it is long path aware (see after-pack.mjs).
const file = process.argv[2] ?? 'release/win-unpacked/Clop for Windows.exe';
if (!await hasLongPathAware(file)) {
  console.error(`${file} is not marked longPathAware in its manifest.`);
  process.exit(1);
}
console.log(`${file} is marked longPathAware.`);
