import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NtExecutable, NtExecutableResource } from 'resedit';

// electron-builder's afterPack hook: marks the packed app `longPathAware`, so Windows lets its own file calls (libuv's mkdtemp, libvips,
// Electron's shell) pass MAX_PATH once the user has turned on LongPathsEnabled. electron-builder edits the same executable's version info
// and icon with resedit next, then signs it, so this runs first and the signature covers the manifest.

const WS2 = 'http://schemas.microsoft.com/SMI/2016/WindowsSettings';
const ASM3 = 'urn:schemas-microsoft-com:asm.v3';
const SETTING = `<ws2:longPathAware xmlns:ws2="${WS2}">true</ws2:longPathAware>`;
const RT_MANIFEST = 24;

// Comments, declarations, CDATA, then a start, end or empty-element tag with its name and attributes.
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * The elements of a manifest with their namespaces and positions. Manifests are small, and Electron's binds `asm.v3` to a prefix
 * (`<asmv3:application xmlns:asmv3=…>`) while others bind it as the default namespace, so elements are matched by namespace and
 * local name, never by how they are spelled.
 */
function parse(xml) {
  const root = { children: [] }, stack = [{ node: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }];
  for (const token of xml.matchAll(TOKEN)) {
    if (token[2] === undefined) continue;
    const [text, closing, name, attributes, empty] = token, top = stack.at(-1);
    if (closing) {
      if (stack.length < 2 || top.node.name !== name) throw new Error(`The manifest is not well formed near </${name}>.`);
      top.node.closeStart = token.index; top.node.closeEnd = token.index + text.length;
      stack.pop();
      continue;
    }
    const scope = { ...top.scope };
    for (const [, key, double, single] of attributes.matchAll(ATTRIBUTE)) {
      if (key === 'xmlns') scope[''] = double ?? single;
      else if (key.startsWith('xmlns:')) scope[key.slice(6)] = double ?? single;
    }
    const colon = name.indexOf(':'), prefix = colon < 0 ? '' : name.slice(0, colon);
    const node = { name, prefix, local: name.slice(colon + 1), uri: scope[prefix], openStart: token.index, openEnd: token.index + text.length, empty: !!empty, children: [] };
    top.node.children.push(node);
    if (!empty) stack.push({ node, scope });
  }
  if (stack.length > 1) throw new Error('The manifest is not well formed: an element is not closed.');
  return root.children;
}
const everywhere = (nodes, test) => nodes.flatMap(node => [...(test(node) ? [node] : []), ...everywhere(node.children, test)]);
const is = (node, uri, local) => node.uri === uri && node.local === local;
const textOf = (xml, node) => (node.empty ? '' : xml.slice(node.openEnd, node.closeStart)).trim();

/** What a manifest says about long paths: its `asm.v3` application elements and the value of each `longPathAware` element. */
export function inspectManifest(xml) {
  const tree = parse(xml);
  return {
    applications: everywhere(tree, node => is(node, ASM3, 'application')).length,
    longPathAware: everywhere(tree, node => is(node, WS2, 'longPathAware')).map(node => textOf(xml, node)),
  };
}

/**
 * An application manifest with `longPathAware` set to true: in the `windowsSettings` of the manifest's own `asm.v3` application
 * element, however the namespace is spelled, and never in a second application element. The `compatibility` section's
 * `application` is another namespace and is left alone.
 */
export function withLongPathAware(xml) {
  const tree = parse(xml), assembly = tree.find(node => node.local === 'assembly');
  if (!assembly) throw new Error('The manifest has no assembly element.');
  const edits = [];
  const existing = everywhere(tree, node => is(node, WS2, 'longPathAware'));
  for (const node of existing) {
    if (node.empty) throw new Error('The manifest has an empty longPathAware element.');
    if (textOf(xml, node) !== 'true') edits.push({ from: node.openEnd, to: node.closeStart, text: 'true' });
  }
  if (!existing.length) {
    const application = assembly.children.find(node => is(node, ASM3, 'application'));
    if (!application) edits.push(...insert(assembly, `<application xmlns="${ASM3}"><windowsSettings>${SETTING}</windowsSettings></application>`));
    else {
      const settings = application.children.find(node => is(node, ASM3, 'windowsSettings'));
      if (settings) edits.push(...insert(settings, SETTING));
      else {
        const tag = application.prefix ? `${application.prefix}:windowsSettings` : 'windowsSettings';
        edits.push(...insert(application, `<${tag}>${SETTING}</${tag}>`));
      }
    }
  }
  return edits.sort((a, b) => b.from - a.from).reduce((text, edit) => text.slice(0, edit.from) + edit.text + text.slice(edit.to), xml);
}

/** Puts `markup` last inside `node`, opening up an empty-element tag first. */
function insert(node, markup) {
  if (!node.empty) return [{ from: node.closeStart, to: node.closeStart, text: markup }];
  return [{ from: node.openEnd - 2, to: node.openEnd, text: `>${markup}</${node.name}>` }]; // in place of "/>"
}

/** Whether a manifest sets `longPathAware` to true, exactly once. */
export const isLongPathAware = xml => { const { longPathAware } = inspectManifest(xml); return longPathAware.length === 1 && longPathAware[0] === 'true'; };

async function manifestOf(file) {
  const executable = NtExecutable.from(await readFile(file));
  const resources = NtExecutableResource.from(executable);
  const entry = resources.entries.find(candidate => candidate.type === RT_MANIFEST && candidate.id === 1);
  if (!entry) throw new Error(`${path.basename(file)} has no manifest to add longPathAware to.`);
  return { executable, resources, entry, xml: Buffer.from(entry.bin).toString('utf8') };
}

/** Whether the executable's own manifest says it is long path aware, once, and has just one `asm.v3` application element (a second one would be a manifest Windows may refuse). */
export async function hasLongPathAware(file) { const { xml } = await manifestOf(file); return isLongPathAware(xml) && inspectManifest(xml).applications === 1; }

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
