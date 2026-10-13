import path from 'node:path';

// electron-builder unpacks the x64 app into release/win-unpacked and the ARM64 app into release/win-arm64-unpacked, whether it builds
// one architecture or both. The smokes run the app for the machine they run on, or the folder in CLOP_UNPACKED.
export const unpackedDir = (arch = process.arch) => path.resolve(process.env.CLOP_UNPACKED ?? path.join('release', arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked'));
