import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const { build } = pkg;
// electron-builder matches its file patterns with the minimatch it depends on, with these options.
const { Minimatch } = createRequire(import.meta.resolve('app-builder-lib'))('minimatch') as typeof import('minimatch');
const expand = (pattern: string, arch: string) => pattern.replaceAll('${arch}', arch);

test('dist:win builds both architectures through one script, and installer names carry the architecture', () => {
  assert.equal(pkg.scripts['dist:win'], 'node scripts/dist-win.mjs');
  const script = readFileSync(path.join(root, 'scripts', 'dist-win.mjs'), 'utf8');
  assert.match(script, /\['x64', 'arm64'\]/);
  assert.match(script, /'--win', 'nsis', 'portable', \.\.\.archs\.map\(arch => `--\$\{arch\}`\)/);
  for (const name of [build.nsis.artifactName, build.portable.artifactName]) assert.match(name, /\$\{arch\}/);
});

test('each architecture ships its own tool set', () => {
  const tools = build.extraResources.find((entry: { to: string }) => entry.to === 'bin');
  assert.equal(tools.from, '.tools/win32-${arch}/bin');
  for (const arch of ['x64', 'arm64']) assert.match(expand(tools.from, arch), /^\.tools\/win32-(x64|arm64)\/bin$/);
});

test('each architecture ships only its own sharp package', () => {
  const excludes = (build.files as string[]).filter(pattern => pattern.startsWith('!node_modules/@img/'));
  assert.ok(excludes.length);
  const dropped = (arch: string, file: string) => excludes.some(pattern => new Minimatch(expand(pattern, arch).slice(1), { dot: true }).match(file));
  for (const [arch, other] of [['x64', 'arm64'], ['arm64', 'x64']]) {
    assert.equal(dropped(arch, `node_modules/@img/sharp-win32-${other}`), true);
    assert.equal(dropped(arch, `node_modules/@img/sharp-win32-${other}/lib/sharp-win32-${other}.node`), true);
    assert.equal(dropped(arch, `node_modules/@img/sharp-win32-${arch}`), false);
    assert.equal(dropped(arch, `node_modules/@img/sharp-win32-${arch}/lib/sharp-win32-${arch}.node`), false);
    assert.equal(dropped(arch, 'node_modules/@img/colour/index.cjs'), false);
    assert.equal(dropped(arch, 'node_modules/sharp/lib/index.js'), false);
  }
});

test('the lockfile pins both Windows sharp packages the build needs, with integrity', () => {
  const { packages } = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const arch of ['x64', 'arm64']) {
    const locked = packages[`node_modules/@img/sharp-win32-${arch}`];
    assert.equal(locked?.version, pkg.dependencies.sharp, `sharp-win32-${arch} is not at sharp's version`);
    assert.match(locked.integrity, /^sha512-/);
  }
});
