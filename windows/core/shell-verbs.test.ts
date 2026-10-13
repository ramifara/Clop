import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NSIS_PATHS, VERB_FLAGS, appliesTo, commandExe, explorerVerb, firstCommand, nsisInstall, nsisUninstall, regAdd, regDelete, regExe, regQuery, regQueryValue, verbPlan } from './shell-verbs';

const paths = { app: 'C:\\Program Files\\Clop for Windows\\Clop for Windows.exe' };
const plan = verbPlan(paths);
const commandOf = (root: string) => plan.values.find(value => value.key === `${root}\\command`)!.value;

test('the plan has the five verbs of the spec, each under the current user\'s file shell key', () => {
  const labels = plan.roots.map(root => plan.values.find(value => value.key === root && value.name === '')!.value);
  assert.deepEqual(labels, ['Optimise with Clop', 'Optimise (aggressive)', 'Downscale', 'Strip EXIF', 'Run pipeline...']);
  for (const root of plan.roots) assert.match(root, /^Software\\Classes\\\*\\shell\\Clop\.[A-Za-z]+$/);
  assert.equal(new Set(plan.roots).size, plan.roots.length);
});

test('every verb runs the app itself with its own flag and the file after --, so a file named like an option stays a file', () => {
  const flags = Object.values(VERB_FLAGS);
  assert.equal(new Set(flags).size, 5);
  plan.roots.forEach((root, index) => {
    const command = commandOf(root);
    assert.equal(command, `"${paths.app}" ${flags[index]} -- "%1"`);
    assert.equal(command.split(' -- ').length, 2, command);
  });
  // Neither clop.exe nor a background worker is involved: the one app, reached through its single-instance lock, does the work.
  assert.ok(!plan.values.some(value => /clop\.exe|--async|--hidden/i.test(value.value)));
});

test('removing the integration deletes exactly the keys the plan wrote, and nothing else', () => {
  const written = new Set(plan.values.map(value => value.key.split('\\command')[0]));
  assert.deepEqual([...written].sort(), [...plan.roots].sort());
  assert.deepEqual(plan.roots.map(regDelete), plan.roots.map(root => ['delete', `HKCU\\${root}`, '/f']));
  // Nothing outside Clop's own verb keys, whatever the paths are.
  for (const value of plan.values) assert.ok(plan.roots.some(root => value.key === root || value.key.startsWith(`${root}\\`)), value.key);
});

test('each verb shows only for the file types its command handles', () => {
  const filter = (id: string) => plan.values.find(value => value.key.endsWith(`Clop.${id}`) && value.name === 'AppliesTo')!.value;
  assert.match(filter('Optimise'), /"\.png".*"\.mp4".*"\.mp3".*"\.pdf"/);
  assert.doesNotMatch(filter('Downscale'), /"\.pdf"/);
  assert.match(filter('StripExif'), /"\.jpg"/);
  assert.doesNotMatch(filter('StripExif'), /"\.mp3"|"\.pdf"/);
  assert.equal(appliesTo(['png', 'jpg']), 'System.FileExtension:=".png" OR System.FileExtension:=".jpg"');
});

test('the Send To shortcut starts the app with the whole selection after --', () => {
  assert.deepEqual(plan.sendTo, { file: 'Optimise with Clop.lnk', target: paths.app, args: '--clop-optimise --', icon: paths.app });
});

test('reg.exe arguments are an array at the System32 path, values untouched', () => {
  assert.match(regExe(), /System32\\reg\.exe$/i);
  const command = plan.values.find(value => value.key.endsWith('Clop.Optimise\\command'))!;
  assert.deepEqual(regAdd(command), ['add', `HKCU\\${command.key}`, '/ve', '/t', 'REG_SZ', '/d', command.value, '/f']);
  const icon = plan.values.find(value => value.name === 'Icon')!;
  assert.deepEqual(regAdd(icon), ['add', `HKCU\\${icon.key}`, '/v', 'Icon', '/t', 'REG_SZ', '/d', `${paths.app},0`, '/f']);
  assert.deepEqual(regQuery(plan.roots[0]), ['query', `HKCU\\${plan.roots[0]}\\command`, '/ve']);
});

test('the installer script writes and removes exactly what the plan says', () => {
  const script = readFileSync(new URL('../native/installer.nsh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const block = (name: string) => script.split(`; BEGIN ${name}\n`)[1]?.split(`  ; END ${name}`)[0].trimEnd();
  const nsisPlan = verbPlan(NSIS_PATHS);
  assert.equal(block('explorer-verbs-install'), nsisInstall(nsisPlan).map(line => `  ${line}`).join('\n'));
  assert.equal(block('explorer-verbs-uninstall'), nsisUninstall(nsisPlan).map(line => `  ${line}`).join('\n'));
  // Updates run the old uninstaller first and then the new installer, so only a real uninstall removes the verbs.
  assert.match(script, /\$\{ifNot\} \$\{isUpdated\}[^]*clopVerbsRemove/);
  assert.match(script, /!macro customInstall[^]*clopVerbsAdd/);
});

test('a launch names its verb before -- and the full paths after it, and anything else is not a verb', () => {
  const app = 'C:\\Apps\\Clop for Windows.exe';
  assert.deepEqual(explorerVerb([app, '--clop-run-pipeline', '--', 'C:\\Pictures\\a b.png']), { verb: 'run-pipeline', files: ['C:\\Pictures\\a b.png'] });
  assert.deepEqual(explorerVerb([app, '--clop-optimise-aggressive', '--', 'C:\\a.png', 'C:\\a.png', 'D:\\b.mp4']), { verb: 'aggressive', files: ['C:\\a.png', 'D:\\b.mp4'] });
  for (const [verb, flag] of Object.entries(VERB_FLAGS)) assert.equal(explorerVerb([app, flag, '--', 'C:\\a.png'])?.verb, verb);
  // Without --, nothing after the flag is a file: a name like an option stays inert.
  assert.deepEqual(explorerVerb([app, '--clop-optimise', 'C:\\a.png']), { verb: 'optimise', files: [] });
  assert.deepEqual(explorerVerb([app, '--clop-downscale', '--', 'relative.png', '--aggressive', '\\\\server\\share\\c.png']), { verb: 'downscale', files: ['\\\\server\\share\\c.png'] });
  assert.equal(explorerVerb([app, 'C:\\a.png']), undefined);
  assert.equal(explorerVerb([app, '--', '--clop-optimise']), undefined, 'a file named like the flag is a file');
  assert.equal(explorerVerb([app, '--', 'C:\\a.png', '--clop-strip-exif']), undefined);
});

test('a reg query prints the command, which tells current entries from moved or foreign ones', () => {
  const printed = `\r\nHKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\Clop.Optimise\\command\r\n    (Default)    REG_SZ    ${firstCommand(paths)}\r\n\r\n`;
  assert.equal(regQueryValue(printed), firstCommand(paths));
  assert.equal(regQueryValue('ERROR: The system was unable to find the specified registry key or value.'), undefined);
  assert.equal(commandExe(firstCommand(paths)), paths.app);
  assert.equal(commandExe('not quoted'), undefined);
});
