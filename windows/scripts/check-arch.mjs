import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackedDir } from './unpacked.mjs';

// CI: every executable the packaged app ships for an architecture is built for it, except the bundled tools that stay x64 and run under
// emulation on Windows 11 on ARM: those with no ARM64 Windows build (Ghostscript, gifsicle, gifski, ExifTool), ffmpeg and ffprobe (the only
// ARM64 builds lack encoders the x64 one has, such as libvpx-vp9) and jpegoptim (the ARM64 build cannot open paths outside the ANSI code
// page, which the x64 build's UTF-8 manifest allows). They are listed here so a tool changing sides is noticed.
const MACHINES = new Map([[0x8664, 'x64'], [0xaa64, 'arm64'], [0x14c, 'x86']]);
export const X64_ON_ARM64 = [
  'ffmpeg.exe', 'ffprobe.exe', 'avcodec-63.dll', 'avdevice-63.dll', 'avfilter-12.dll', 'avformat-63.dll', 'avutil-61.dll', 'swresample-7.dll', 'swscale-10.dll',
  'jpegoptim.exe', 'gswin64c.exe', 'gsdll64.dll', 'gifsicle.exe', 'gifski.exe', 'exiftool.exe', 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll',
];

/** The CPU a PE file (exe or dll) is built for: 'x64', 'arm64', 'x86', or the raw machine value in hex. */
export async function machineOf(file) {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(64);
    await handle.read(head, 0, 64, 0);
    if (head.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file} is not a Windows program.`);
    const at = head.readUInt32LE(0x3c), pe = Buffer.alloc(6);
    await handle.read(pe, 0, 6, at);
    if (pe.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error(`${file} has no PE header.`);
    return MACHINES.get(pe.readUInt16LE(4)) ?? `0x${pe.readUInt16LE(4).toString(16)}`;
  } finally {
    await handle.close();
  }
}

/** Problems with the architecture of the files in an unpacked app, as messages; none means it is as expected. */
export async function checkArch(arch, dir) {
  const problems = [], seen = { checked: 0 };
  const expect = async (file, wanted) => {
    seen.checked++;
    const actual = await machineOf(file).catch(error => error.message);
    if (actual !== wanted) problems.push(`${path.relative(dir, file)} is ${actual}, expected ${wanted}`);
  };
  await expect(path.join(dir, 'Clop for Windows.exe'), arch);
  const bin = path.join(dir, 'resources', 'bin');
  for (const file of (await readdir(bin)).filter(file => /\.(exe|dll)$/i.test(file)).sort()) {
    await expect(path.join(bin, file), arch === 'arm64' && X64_ON_ARM64.includes(file.toLowerCase()) ? 'x64' : arch);
  }
  const unpackedModules = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules', '@img');
  const sharps = (await readdir(unpackedModules)).filter(name => name.startsWith('sharp-win32-')).sort();
  if (sharps.join() !== `sharp-win32-${arch}`) problems.push(`@img holds ${sharps.join(', ') || 'no Windows sharp package'}, expected sharp-win32-${arch}`);
  for (const name of sharps) {
    const lib = path.join(unpackedModules, name, 'lib');
    for (const file of (await readdir(lib)).filter(file => /\.(node|dll)$/i.test(file)).sort()) await expect(path.join(lib, file), name.slice('sharp-win32-'.length));
  }
  return { problems, checked: seen.checked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arch = process.argv[2] ?? process.arch, dir = unpackedDir(arch);
  const { problems, checked } = await checkArch(arch, dir);
  if (problems.length) {
    console.error(`The ${arch} app in ${dir} has files of the wrong architecture:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`All ${checked} programs and libraries checked in the ${arch} app are built for ${arch}${arch === 'arm64' ? ` (except the ${X64_ON_ARM64.length} x64 files that run under emulation)` : ''}.`);
}
