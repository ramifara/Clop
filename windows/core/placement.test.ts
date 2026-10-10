import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, samePath } from './fileops';
import { OptimisedMarker } from './marker';
import { effectiveBehaviour, executePlacement, isTemplatedCopy, placeOutput, planPlacement, type FileBehaviour, type PlacementEnv, type PlacementOverride } from './placement';
import { defaultSettings, type ClopSettings } from './settings/schema';
import { Workdir } from './workdir';

async function setup(t: TestContext, settings: Partial<ClopSettings> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-placement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), source = path.join(dir, 'Pictures');
  await mkdir(source, { recursive: true });
  const workdir = await new Workdir(path.join(dir, 'work')).ensure();
  const marker = new OptimisedMarker(path.join(dir, 'optimised.json'));
  const env: PlacementEnv = { settings: { ...defaultSettings({ home, userData: dir }), ...settings }, workdir, counter: { value: 0 }, marker, home };
  const original = path.join(source, 'shot.png'), bytes = Buffer.from('original pixels, quite a few of them');
  await writeFile(original, bytes);
  const when = new Date(2023, 0, 2, 3, 4, 5); await utimes(original, when, when);
  const produced = path.join(workdir.temp, 'result.png'), result = Buffer.from('smaller');
  await writeFile(produced, result);
  return { dir, home, source, workdir, marker, env, original, bytes, produced, result };
}
const behaviour = (value: FileBehaviour): Partial<ClopSettings> => ({ optimisedImageBehaviour: value });

test('temporary leaves the original alone and the produced file where it is', async t => {
  const { env, original, bytes, produced, marker } = await setup(t, behaviour('temporary'));
  const plan = await planPlacement(env, { produced, original, type: 'image' });
  assert.deepEqual(plan, { behaviour: 'temporary' });
  const placed = await executePlacement(env, plan, produced, original);
  assert.deepEqual(placed, { path: produced, originalRemoved: false });
  assert.deepEqual(await readFile(original), bytes);
  assert.equal(await marker.isOptimised(original), false);
});

test('inPlace replaces the original, keeps a backup that restores byte for byte, and marks the result', async t => {
  const { env, original, bytes, produced, result, workdir, marker } = await setup(t, behaviour('inPlace'));
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(placed.path, original);
  assert.equal(placed.originalRemoved, true);
  assert.deepEqual(await readFile(original), result);
  assert.equal(path.dirname(placed.backup!), workdir.backups);
  assert.deepEqual(await readFile(placed.backup!), bytes);
  assert.equal(await marker.isOptimised(original), true);
  assert.equal(await exists(produced), true, 'the produced file is copied, not consumed');
  await workdir.restore(placed.backup!, original);
  assert.deepEqual(await readFile(original), bytes);
  assert.equal((await stat(original)).mtimeMs, new Date(2023, 0, 2, 3, 4, 5).getTime());
  assert.equal(await marker.isOptimised(original), false, 'the restored original is not marked');
});

test('inPlace with a different format replaces the original with a file of the new extension', async t => {
  const { env, original, bytes, source, workdir } = await setup(t, behaviour('inPlace'));
  const webp = path.join(workdir.temp, 'result.webp');
  await writeFile(webp, 'webp bytes');
  const placed = await placeOutput(env, { produced: webp, original, type: 'image' });
  assert.equal(placed.path, path.join(source, 'shot.webp'));
  assert.deepEqual(await readdir(source), ['shot.webp']);
  assert.deepEqual(await readFile(placed.backup!), bytes);
});

test('inPlace when the optimiser already rewrote the original reports the backup taken before', async t => {
  const { env, original, bytes, workdir } = await setup(t, behaviour('inPlace'));
  const backup = await workdir.backup(original);
  await writeFile(original, 'rewritten in place');
  const placed = await placeOutput(env, { produced: original, original, type: 'image' });
  assert.equal(placed.path, original);
  assert.equal(placed.backup, backup);
  assert.equal(placed.originalRemoved, false);
  assert.deepEqual(await readFile(placed.backup!), bytes);
  assert.equal(await readFile(original, 'utf8'), 'rewritten in place');
});

test('inPlace undoes the backup move when the copy fails', async t => {
  const { env, original, bytes, workdir, source } = await setup(t, behaviour('inPlace'));
  const missing = path.join(workdir.temp, 'never-written.png');
  const plan = await planPlacement(env, { produced: missing, original, type: 'image' });
  await assert.rejects(executePlacement(env, plan, missing, original));
  assert.deepEqual(await readFile(original), bytes);
  assert.deepEqual(await readdir(source), ['shot.png']);
});

test('sameFolder writes the templated name next to the original and keeps the original', async t => {
  const { env, original, bytes, produced, result, source, marker } = await setup(t, { ...behaviour('sameFolder'), sameFolderNameTemplateImage: '%f-small' });
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(placed.path, path.join(source, 'shot-small.png'));
  assert.equal(placed.backup, undefined);
  assert.equal(placed.originalRemoved, false);
  assert.deepEqual(await readFile(placed.path), result);
  assert.deepEqual(await readFile(original), bytes);
  assert.equal(await marker.isOptimised(placed.path), true);
  assert.equal(await marker.isOptimised(original), false);
});

test('a different file already at the destination is backed up before it is replaced', async t => {
  const { env, original, bytes, produced, result, source, workdir } = await setup(t, { ...behaviour('sameFolder'), sameFolderNameTemplateImage: '%f-small' });
  const existing = path.join(source, 'shot-small.png');
  await writeFile(existing, 'someone else\'s file');
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(placed.path, existing);
  assert.deepEqual(await readFile(existing), result);
  assert.equal(path.dirname(placed.replaced!), workdir.backups);
  assert.equal(await readFile(placed.replaced!, 'utf8'), 'someone else\'s file');
  assert.deepEqual(await readFile(original), bytes);
  assert.equal(placed.backup, undefined);
});

test('inPlace with a changed extension keeps a shot.webp that was already there', async t => {
  const { env, original, bytes, source, workdir } = await setup(t, behaviour('inPlace'));
  const webp = path.join(source, 'shot.webp'), produced = path.join(workdir.temp, 'result.webp');
  await writeFile(webp, 'older webp'); await writeFile(produced, 'new webp');
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(await readFile(webp, 'utf8'), 'new webp');
  assert.equal(await readFile(placed.replaced!, 'utf8'), 'older webp');
  assert.deepEqual(await readFile(placed.backup!), bytes);
});

test('placing over the original or a file without a different occupant makes no extra backup', async t => {
  const { env, original, produced, workdir } = await setup(t, behaviour('inPlace'));
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(placed.replaced, undefined);
  assert.deepEqual(await readdir(workdir.backups), [path.basename(placed.backup!)]);
});

test('sameFolder is idempotent: a file already named by the template keeps its name', async t => {
  const { env, produced, source } = await setup(t, { ...behaviour('sameFolder'), sameFolderNameTemplateImage: '%f-optimised' });
  const already = path.join(source, 'img-optimised.png');
  await writeFile(already, 'x');
  const plan = await planPlacement(env, { produced, original: already, type: 'image' });
  assert.equal(plan.dest, already);
  const fresh = await planPlacement(env, { produced, original: path.join(source, 'img.png'), type: 'image' });
  assert.equal(fresh.dest, path.join(source, 'img-optimised.png'));
});

test('sameFolder counts up with %i and an empty template falls back to the default name', async t => {
  const { env, original, produced, source } = await setup(t, { ...behaviour('sameFolder'), sameFolderNameTemplateImage: 'shot-%i' });
  const first = await planPlacement(env, { produced, original, type: 'image' });
  const second = await planPlacement(env, { produced, original, type: 'image' });
  assert.deepEqual([first.dest, second.dest], [path.join(source, 'shot-1.png'), path.join(source, 'shot-2.png')]);
  assert.equal(env.counter.value, 2);
  const empty = await planPlacement({ ...env, settings: { ...env.settings, sameFolderNameTemplateImage: '' } }, { produced, original, type: 'image' });
  assert.equal(empty.dest, path.join(source, 'shot-optimised.png'));
});

test('specificFolder creates the folder from the template and keeps the original', async t => {
  const { env, original, bytes, produced, result, source } = await setup(t, behaviour('specificFolder'));
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(placed.path, path.join(source, 'optimised', 'shot.png'));
  assert.deepEqual(await readFile(placed.path), result);
  assert.deepEqual(await readFile(original), bytes);
});

test('specificFolder expands ~ and tokens, and is idempotent for a file already in the folder', async t => {
  const { env, original, produced, home } = await setup(t, behaviour('specificFolder'));
  const tilde = await planPlacement({ ...env, settings: { ...env.settings, specificFolderNameTemplateImage: '~/Clop/%e/%f' } }, { produced, original, type: 'image' });
  assert.equal(tilde.dest, path.join(home, 'Clop', 'png', 'shot.png'));
  const custom: PlacementEnv = { ...env, settings: { ...env.settings, specificFolderNameTemplateImage: '$HOME/Clop/out/%f' } };
  const plan = await planPlacement(custom, { produced, original, type: 'image' });
  assert.equal(plan.dest, path.join(home, 'Clop', 'out', 'shot.png'));
  assert.equal(await exists(path.join(home, 'Clop', 'out')), true);
  const again = await planPlacement(custom, { produced, original: plan.dest!, type: 'image' });
  assert.equal(again.dest, plan.dest);
});

test('specificFolder keeps a source folder name with &, quotes, # and $', async t => {
  const { env, dir, produced, result } = await setup(t, behaviour('specificFolder'));
  const folder = path.join(dir, "Dev & Stuff", "Rami's Photos #1 $x"), original = path.join(folder, 'shot.png');
  await mkdir(folder, { recursive: true }); await writeFile(original, 'pixels');
  const placed = await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(placed.path, path.join(folder, 'optimised', 'shot.png'));
  assert.deepEqual(await readFile(placed.path), result);
  assert.deepEqual(await readdir(path.dirname(folder)), ["Rami's Photos #1 $x"]);
});

test('a relative specificFolder template matches wherever its folder sits', async t => {
  const { env, produced, source } = await setup(t, { ...behaviour('specificFolder'), specificFolderNameTemplateImage: 'small/%f' });
  const first = await planPlacement(env, { produced, original: path.join(source, 'a.png'), type: 'image' });
  assert.equal(first.dest, path.join(source, 'small', 'a.png'));
  const again = await planPlacement(env, { produced, original: first.dest!, type: 'image' });
  assert.equal(again.dest, first.dest);
});

test('each file type reads its own settings', async t => {
  const { env } = await setup(t, { optimisedVideoBehaviour: 'sameFolder', optimisedPDFBehaviour: 'temporary', optimisedAudioBehaviour: 'specificFolder', sameFolderNameTemplateVideo: '%f-v', sameFolderNameTemplatePDF: 'unused', specificFolderNameTemplateAudio: '%P/audio/%f' });
  const dest = async (type: 'image' | 'video' | 'pdf' | 'audio', file: string) => (await planPlacement(env, { produced: file, original: file, type })).dest;
  const video = path.join(env.workdir.temp, 'clip.mp4');
  await writeFile(video, 'v');
  assert.equal(await dest('video', video), path.join(env.workdir.temp, 'clip-v.mp4'));
  assert.equal(await dest('pdf', video), undefined);
  assert.equal(await dest('audio', video), path.join(env.workdir.temp, 'audio', 'clip.mp4'));
  assert.equal(await dest('image', video), video);
});

test('conversions use the converted settings, and PDF conversions follow the optimise ones', async t => {
  const { env } = await setup(t, { optimisedImageBehaviour: 'inPlace', convertedImageBehaviour: 'sameFolder', manualConvertedImageBehaviour: 'specificFolder', convertedSameFolderNameTemplateImage: '%f-converted', convertedSpecificFolderNameTemplateImage: '%P/converted/%f', optimisedPDFBehaviour: 'sameFolder', sameFolderNameTemplatePDF: '%f-pdf' });
  assert.deepEqual((['optimised', 'autoConvert', 'manualConvert'] as const).map(kind => effectiveBehaviour(env, 'image', kind)), ['inPlace', 'sameFolder', 'specificFolder']);
  assert.equal(effectiveBehaviour(env, 'pdf', 'manualConvert'), 'sameFolder');
  const dir = env.workdir.temp, file = path.join(dir, 'a.png'), webp = path.join(dir, 'a.webp');
  await writeFile(file, 'p'); await writeFile(webp, 'w');
  assert.equal((await planPlacement(env, { produced: webp, original: file, type: 'image', kind: 'autoConvert' })).dest, path.join(dir, 'a-converted.webp'));
  assert.equal((await planPlacement(env, { produced: webp, original: file, type: 'image', kind: 'manualConvert' })).dest, path.join(dir, 'converted', 'a.webp'));
  // PDF has no conversion templates, so the plain file name is used.
  assert.equal((await planPlacement(env, { produced: webp, original: file, type: 'pdf', kind: 'manualConvert' })).dest, webp);
});

const TYPES = [['image', 'Image'], ['video', 'Video'], ['audio', 'Audio'], ['pdf', 'PDF']] as const;
const KINDS = ['optimised', 'autoConvert', 'manualConvert'] as const;

test('every file type and output kind reads its own behaviour setting', async t => {
  const { env } = await setup(t);
  const keys = (type: string, suffix: string, kind: string) => kind === 'optimised' || type === 'pdf' ? `optimised${suffix}Behaviour` : kind === 'autoConvert' ? `converted${suffix}Behaviour` : `manualConverted${suffix}Behaviour`;
  const behaviourKeys = Object.keys(env.settings).filter(key => /^(optimised|converted|manualConverted)(Image|Video|Audio|PDF)Behaviour$/.test(key));
  assert.equal(behaviourKeys.length, 10);
  for (const key of behaviourKeys) {
    const settings = { ...env.settings, ...Object.fromEntries(behaviourKeys.map(other => [other, other === key ? 'specificFolder' : 'temporary'])) } as ClopSettings;
    for (const [type, suffix] of TYPES) for (const kind of KINDS) assert.equal(effectiveBehaviour({ ...env, settings }, type, kind) === 'specificFolder', keys(type, suffix, kind) === key, `${key} for ${type} ${kind}`);
  }
});

test('every file type and output kind reads its own name templates', async t => {
  const { env, workdir } = await setup(t);
  const templateKeys = Object.keys(env.settings).filter(key => /NameTemplate(Image|Video|Audio|PDF)$/.test(key) && !key.includes('Clipboard'));
  assert.equal(templateKeys.length, 14);
  const settings = { ...env.settings, ...Object.fromEntries(templateKeys.map(key => [key, /same/i.test(key) ? `${key}.%f` : `%P/${key}/%f`])) } as ClopSettings;
  for (const [type, suffix] of TYPES) for (const kind of KINDS) {
    const converted = kind !== 'optimised' && type !== 'pdf', file = path.join(workdir.temp, `a.${type}`);
    await writeFile(file, 'x');
    const plan = (mode: 'sameFolder' | 'specificFolder') => planPlacement({ ...env, settings }, { produced: file, original: file, type, kind, overrides: { [kind]: mode } as PlacementOverride });
    assert.equal(path.basename((await plan('sameFolder')).dest!), converted ? `convertedSameFolderNameTemplate${suffix}.a.${type}` : kind === 'optimised' ? `sameFolderNameTemplate${suffix}.a.${type}` : `a.${type}`, `${type} ${kind} same folder`);
    assert.equal(path.basename(path.dirname((await plan('specificFolder')).dest!)), converted ? `convertedSpecificFolderNameTemplate${suffix}` : kind === 'optimised' ? `specificFolderNameTemplate${suffix}` : 'optimised', `${type} ${kind} specific folder`);
  }
});

test('per-request overrides win over the settings', async t => {
  const { env, original, produced, source } = await setup(t, behaviour('inPlace'));
  const plan = async (overrides: PlacementOverride) => planPlacement(env, { produced, original, type: 'image', overrides });
  assert.deepEqual(await plan({ optimised: 'temporary' }), { behaviour: 'temporary' });
  assert.equal((await plan({ optimised: 'sameFolder', sameFolderTemplate: 'copy-of-%f' })).dest, path.join(source, 'copy-of-shot.png'));
  assert.equal((await plan({ optimised: 'specificFolder', specificFolderTemplate: '%P/there/%f' })).dest, path.join(source, 'there', 'shot.png'));
  assert.equal((await plan({ autoConvert: 'temporary' })).behaviour, 'inPlace');
});

test('planning fails up front when the destination folder is not writable', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { env, original, produced, source } = await setup(t, behaviour('inPlace'));
  await chmod(source, 0o555);
  try { await assert.rejects(planPlacement(env, { produced, original, type: 'image' }), /cannot write to/); } finally { await chmod(source, 0o755); }
});

test('isTemplatedCopy is true only for a copy a renaming template made', async t => {
  const { env, source } = await setup(t, { optimisedImageBehaviour: 'sameFolder', sameFolderNameTemplateImage: '%f-optimised', optimisedVideoBehaviour: 'inPlace', optimisedPDFBehaviour: 'temporary', optimisedAudioBehaviour: 'specificFolder', specificFolderNameTemplateAudio: '%P/optimised/%f' });
  const check = (type: 'image' | 'video' | 'pdf' | 'audio', file: string) => isTemplatedCopy(env, type, path.join(source, file));
  assert.equal(check('image', 'a-optimised.png'), true);
  assert.equal(check('image', 'a.png'), false);
  assert.equal(check('video', 'a-optimised.mp4'), false);
  assert.equal(check('pdf', 'a-optimised.pdf'), false);
  assert.equal(check('audio', 'optimised/a.m4a'), true);
  assert.equal(check('audio', 'a.m4a'), false);
  assert.equal(isTemplatedCopy({ ...env, settings: { ...env.settings, sameFolderNameTemplateImage: '%f' } }, 'image', path.join(source, 'a.png')), false);
});

test('a placed result is skipped by a later look at the folder, the way a watcher uses the marker', async t => {
  const { env, original, produced, marker } = await setup(t, behaviour('inPlace'));
  assert.equal(await marker.isOptimised(original), false);
  await placeOutput(env, { produced, original, type: 'image' });
  assert.equal(await new OptimisedMarker(marker.file).isOptimised(original), true);
});

test('samePath ignores case on Windows only and resolves relative segments', () => {
  const upper = path.resolve('a', 'b', 'Shot.PNG'), lower = path.resolve('a', 'b', 'shot.png');
  assert.equal(samePath(upper, lower, 'win32'), true);
  assert.equal(samePath(upper, lower, 'linux'), false);
  assert.equal(samePath(path.resolve('a', 'b', '..', 'b', 'shot.png'), lower, 'linux'), true);
});
