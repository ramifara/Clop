import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NtExecutable, NtExecutableResource } from 'resedit';

// electron-builder's afterPack hook: marks the packed app `longPathAware`, so Windows lets its own file calls (libuv's mkdtemp, libvips,
// Electron's shell) pass MAX_PATH once the user has turned on LongPathsEnabled. electron-builder edits the same executable's version info
// and icon with resedit next, then signs it, so this runs first and the signature covers the manifest.

const LONG_PATH_NAMESPACE = 'http://schemas.microsoft.com/SMI/2016/WindowsSettings';
const SETTING = `<ws2:longPathAware xmlns:ws2="${LONG_PATH_NAMESPACE}">true</ws2:longPathAware>`;
const RT_MANIFEST = 24;

/** An application manifest with `longPathAware` set to true, added to its `windowsSettings` (made, with `application`, when missing). */
export function withLongPathAware(xml) {
  const existing = /(<(?:\w+:)?longPathAware\b[^>]*>)\s*[^<]*?\s*(<\/(?:\w+:)?longPathAware>)/i;
  if (existing.test(xml)) return xml.replace(existing, '$1true$2');
  if (/<(?:\w+:)?longPathAware\b/i.test(xml)) throw new Error('The manifest has an empty longPathAware element.');
  if (/<windowsSettings\b[^>]*>/i.test(xml) && !/<windowsSettings\b[^>]*\/>/i.test(xml)) return xml.replace(/<\/windowsSettings\s*>/i, `${SETTING}</windowsSettings>`);
  const settings = `<windowsSettings>${SETTING}</windowsSettings>`;
  if (/<windowsSettings\b[^>]*\/>/i.test(xml)) return xml.replace(/<windowsSettings\b[^>]*\/>/i, settings);
  if (/<application\b[^>]*[^/]>/i.test(xml) && /<\/application\s*>/i.test(xml)) return xml.replace(/<\/application\s*>/i, `${settings}</application>`);
  const application = `<application xmlns="urn:schemas-microsoft-com:asm.v3">${settings}</application>`;
  if (/<application\b[^>]*\/>/i.test(xml)) return xml.replace(/<application\b[^>]*\/>/i, application);
  if (!/<\/assembly\s*>/i.test(xml)) throw new Error('The manifest has no assembly element.');
  return xml.replace(/<\/assembly\s*>/i, `${application}</assembly>`);
}

/** Whether a manifest sets `longPathAware` to true. */
export const isLongPathAware = xml => /<(?:\w+:)?longPathAware\b[^>]*>\s*true\s*<\/(?:\w+:)?longPathAware>/i.test(xml);

async function manifestOf(file) {
  const executable = NtExecutable.from(await readFile(file));
  const resources = NtExecutableResource.from(executable);
  const entry = resources.entries.find(candidate => candidate.type === RT_MANIFEST && candidate.id === 1);
  if (!entry) throw new Error(`${path.basename(file)} has no manifest to add longPathAware to.`);
  return { executable, resources, entry, xml: Buffer.from(entry.bin).toString('utf8') };
}

/** Whether the executable's own manifest says it is long path aware. */
export async function hasLongPathAware(file) { return isLongPathAware((await manifestOf(file)).xml); }

/** Adds `longPathAware` to the executable's manifest. Returns false when it was set already. */
export async function setLongPathAware(file) {
  const { executable, resources, entry, xml } = await manifestOf(file);
  const updated = withLongPathAware(xml);
  if (updated === xml) return false;
  const bytes = Buffer.from(updated, 'utf8');
  entry.bin = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  resources.outputResource(executable);
  await writeFile(file, Buffer.from(executable.generate()));
  return true;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  await setLongPathAware(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`));
}
