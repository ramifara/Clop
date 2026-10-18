// CI, release job: node scripts/release.mjs --tag v<version> --out <dir> <build dir>...
// Each architecture is built on a runner of its own, and electron-builder writes a `latest.yml` there that lists only that runner's installer.
// electron-updater reads one `latest.yml` per release (a beta looks for `beta.yml` first and falls back to it) and picks the file whose name
// carries its own `process.arch`, so the release gets one file listing every installer. This also checks the tag names the version in
// package.json and takes the release notes from that version's CHANGELOG.md entry, so a release cannot go out without one.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dump, load } from 'js-yaml';

const ARCHS = ['x64', 'arm64'];
/** The architecture an installer is for, read from its name the way electron-updater matches it. */
const archOf = url => ARCHS.find(arch => url.includes(`-${arch}-`));
/** A `latest.yml` as an object. js-yaml comes with electron-updater, which reads these files with it. */
export const readUpdateInfo = text => load(text);

/** Combines the `latest.yml` texts of each architecture's build into one. x64 comes first and provides the single-file fields older updaters read. */
export function mergeUpdateInfo(texts, version) {
  const infos = texts.map(readUpdateInfo);
  const files = [];
  for (const info of infos) {
    if (info?.version !== version) throw new Error(`A build's latest.yml is for ${info?.version}, not ${version}.`);
    for (const file of info.files ?? []) {
      const arch = archOf(file.url);
      if (!arch) throw new Error(`${file.url} does not name its architecture, so electron-updater could not tell which one to take.`);
      if (files.some(other => archOf(other.url) === arch)) throw new Error(`Two builds list a ${arch} installer.`);
      files.push(file);
    }
  }
  files.sort((a, b) => ARCHS.indexOf(archOf(a.url)) - ARCHS.indexOf(archOf(b.url)));
  if (!files.length) throw new Error('No installer is listed in the builds\' latest.yml.');
  const releaseDate = infos.map(info => info.releaseDate).filter(Boolean).sort().at(-1);
  return dump({ version, files, path: files[0].url, sha512: files[0].sha512, ...(releaseDate && { releaseDate }) }, { lineWidth: -1 });
}

/** The body of `version`'s CHANGELOG.md entry. Throws if there is none, or it is still marked not yet released. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no entry for ${version}.`);
  if (/not yet released/i.test(lines[start])) throw new Error(`CHANGELOG.md still marks ${version} as not yet released.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() + '\n';
}

/** Whether the tag is `v` and package.json's version; returns the version. */
export function versionOfTag(tag, packageVersion) {
  if (tag !== `v${packageVersion}`) throw new Error(`The tag ${tag} does not match package.json's version ${packageVersion}; releases are tagged v<version>.`);
  return packageVersion;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { tag: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true });
  if (!values.tag || !values.out || !positionals.length) throw new Error('Usage: node scripts/release.mjs --tag v<version> --out <dir> <build dir>...');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const version = versionOfTag(values.tag, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  const notes = releaseNotes(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  const latest = mergeUpdateInfo(await Promise.all(positionals.map(dir => readFile(path.join(dir, 'latest.yml'), 'utf8'))), version);
  await writeFile(path.join(values.out, 'latest.yml'), latest);
  await writeFile(path.join(values.out, 'notes.md'), notes);
  console.log(latest);
  const prerelease = version.split('+')[0].includes('-');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`);
}
