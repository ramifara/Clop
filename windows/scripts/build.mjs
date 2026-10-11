import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { trayIcons } from './tray-icons.mjs';
await mkdir('dist-electron', { recursive: true });
await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['electron', 'sharp'], outdir: 'dist-electron' });
await build({ entryPoints: ['electron/native.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist-electron/native-test.js' });
// The CLI ships beside app.asar in resources; cli/sharp.ts finds sharp inside the archive.
await build({ entryPoints: ['cli/index.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', alias: { sharp: './cli/sharp.ts' }, outfile: 'dist-electron/cli.mjs' });
// clop.exe launches it with the installed Electron. The .NET Framework's compiler is part of every Windows install.
if (process.platform === 'win32') {
  const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  // csc reads a leading or embedded '/' as an option switch, so both paths are given in Windows form.
  execFileSync(csc, ['/nologo', '/target:exe', '/optimize+', '/langversion:5', `/out:${path.resolve('dist-electron', 'clop.exe')}`, path.resolve('native', 'clop.cs')], { stdio: 'inherit' });
}
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: 'dist-electron/preload.cjs' });
await build({ entryPoints: ['electron/preload-batch.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: 'dist-electron/preload-batch.cjs' });
await mkdir('assets', { recursive: true });
const png = await sharp('../Clop/Assets.xcassets/clop.imageset/clop_256.png').resize(256, 256).png().toBuffer();
await writeFile('assets/icon.png', png);
await writeFile('dist-electron/icon.png', png);
for (const [variant, bytes] of Object.entries(await trayIcons(png))) await writeFile(`dist-electron/tray-${variant}.png`, bytes);
// Windows ICO supports a PNG payload. Include a 256x256 image directory entry.
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header[8] = 0; header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile('assets/icon.ico', Buffer.concat([header, png]));
