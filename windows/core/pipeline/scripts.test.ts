import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { graphic } from '../media/image.fixtures';
import { pipelineWorkspace } from './executor.fixtures';
import { PipelineStepError } from './executor';
import { makeStep } from './model';
import { checkWindowsScript, decodeOutput, markedAsDownloaded, readableStderr, zoneMarksDownload } from './scripts';

// Inline code is PowerShell on Windows. Elsewhere it is PowerShell when pwsh is installed, otherwise sh, which these tests write for.
const windows = process.platform === 'win32';
const hasPwsh = !windows && (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const powershell = windows || hasPwsh;
const inline = (ps: string, sh: string) => makeStep('runScript', { code: powershell ? ps : sh });
/** Long, resolved and (on Windows) case-folded, since a shell can report a folder under its short 8.3 name. */
const canonical = (dir: string) => { const real = realpathSync.native(dir); return windows ? real.toLowerCase() : real; };

/** A script file for this platform: PowerShell on Windows, an executable sh script elsewhere. */
async function script(file: string, ps: string, sh: string) {
  const target = file + (windows ? '.ps1' : '.sh');
  await writeFile(target, windows ? ps : `#!/bin/sh\n${sh}\n`);
  if (!windows) await chmod(target, 0o755);
  return target;
}

test('runScript runs inline code from an empty folder, and a printed absolute path carries on', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const result = await w.run([inline(
    "(Get-Location).Path | Set-Content ($env:CLOP_INPUT_FILE -replace 'in.png$', 'cwd.txt'); $out = $env:CLOP_INPUT_FILE -replace 'in.png$', 'out.png'; Copy-Item $env:CLOP_INPUT_FILE $out; Write-Output $out",
    'pwd > "${CLOP_INPUT_FILE%in.png}cwd.txt"; out="${CLOP_INPUT_FILE%in.png}out.png"; cp "$1" "$out"; echo "$out"',
  )], input);
  assert.equal(result.file, w.file('out.png'));
  assert.deepEqual(await readFile(result.file), await readFile(input));
  // The empty folder is gone after the run, so its parent is compared.
  const cwd = (await readFile(w.file('cwd.txt'), 'utf8')).trim();
  assert.notEqual(path.basename(cwd), path.basename(w.files), 'never the folder the input arrived in');
  assert.ok(cwd.toLowerCase().includes(`${path.sep}pipeline-`) && cwd.toLowerCase().includes(`${path.sep}temp${path.sep}`), cwd);

  assert.deepEqual(result.warnings, []);

  // A printed path of another kind of file, or one that is not found, leaves the file as it was, with a warning.
  await writeFile(w.file('notes.mp3'), 'not audio');
  const otherKind = await w.run([inline("Write-Output ($env:CLOP_INPUT_FILE -replace 'in.png$', 'notes.mp3')", 'echo "${CLOP_INPUT_FILE%in.png}notes.mp3"')], input);
  assert.equal(otherKind.file, input);
  assert.match(otherKind.warnings.join(), /printed a path to another kind of file \(audio, not image\)/);
  const missing = await w.run([inline('Write-Output out.png', 'echo out.png')], input);
  assert.equal(missing.file, input);
  assert.deepEqual(missing.warnings, [`Script 'inline code' printed a path that was not found, so the pipeline carried on with ${input}: out.png`]);
  const log = await w.run([inline("Write-Output 'one'; Write-Output 'two'", 'echo one; echo two')], input);
  assert.deepEqual([log.file, log.warnings], [input, []], 'several lines are the script\'s own log');
});

test('a script file runs from its own folder with the input as its first argument and the bundled tools folder', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in file.png'), log = path.join(w.dir, 'log.txt'), scripts = path.join(w.dir, 'my scripts');
  await graphic(40, 30).png().toFile(input);
  await mkdir(scripts);
  const file = await script(path.join(scripts, 'log'),
    `Set-Content -LiteralPath '${log}' -Value ($args[0] + '|' + $env:CLOP_INPUT_FILE + '|' + $env:CLOP_BIN + '|' + (Get-Location).Path)`,
    `printf '%s|%s|%s|%s' "$1" "$CLOP_INPUT_FILE" "$CLOP_BIN" "$(pwd)" > '${log}'`);
  const previous = process.env.CLOP_TOOLS_DIR;
  process.env.CLOP_TOOLS_DIR = w.dir;
  t.after(() => { if (previous === undefined) delete process.env.CLOP_TOOLS_DIR; else process.env.CLOP_TOOLS_DIR = previous; });
  await w.run([makeStep('runScript', { path: file })], input);
  const [first, env, bin, cwd] = (await readFile(log, 'utf8')).trim().split('|');
  assert.deepEqual([first, env, bin], [input, input, w.dir]);
  assert.equal(canonical(cwd), canonical(scripts));
});

test('an executable gets the input as its first argument', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  // Node runs the input as a script, which records the argument it was given.
  const input = w.file('in.png');
  await writeFile(input, "require('fs').writeFileSync(process.argv[1] + '.arg.txt', process.argv[1])");
  await w.run([makeStep('runScript', { path: process.execPath })], input);
  assert.equal(await readFile(`${input}.arg.txt`, 'utf8'), input);
});

test('a program inside a watched folder is refused', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png'), program = path.join(w.dir, 'watched', 'tools', 'tool.exe');
  await graphic(40, 30).png().toFile(input);
  await mkdir(path.dirname(program), { recursive: true });
  await writeFile(program, 'MZ');
  w.settings.videoDirs = [path.join(w.dir, 'watched')];
  await assert.rejects(w.run([makeStep('runScript', { path: program })], input), /is inside the watched folder .*watched\. A program loads DLLs from its own folder/);
});

test('script paths must be absolute, and runShortcut only runs scripts from Clop\'s scripts folder', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png'), scriptsDir = path.join(w.dir, 'scripts');
  await graphic(40, 30).png().toFile(input);
  await mkdir(scriptsDir);
  // A script that arrived beside the input, in a watched folder, must not run by name.
  await script(w.file('Resize'), "Set-Content -LiteralPath ($env:CLOP_INPUT_FILE + '.ran') -Value x", 'touch "$1.ran"');
  await assert.rejects(w.run([makeStep('runScript', { path: 'Resize.sh' })], input), /needs the full path of a script/);
  await assert.rejects(w.run([makeStep('runScript', { path: '%P/missing.ps1' })], input), /Script not found: .*missing\.ps1/);
  await assert.rejects(w.run('runShortcut(name: "Resize")', input, { scriptsDir }), /macOS Shortcut, and Windows has no Shortcuts app. Put a script named Resize/);
  await assert.rejects(w.run(`runShortcut(name: "../files/Resize")`, input, { scriptsDir }), /macOS Shortcut/);
  assert.deepEqual((await readdir(w.files)).filter(name => name.endsWith('.ran')), []);

  await script(path.join(scriptsDir, 'Resize'), "Set-Content -LiteralPath ($env:CLOP_INPUT_FILE + '.ran') -Value x", 'touch "$1.ran"');
  await w.run('runShortcut(name: "Resize")', input, { scriptsDir });
  assert.deepEqual((await readdir(w.files)).filter(name => name.endsWith('.ran')), ['in.png.ran']);
  await assert.rejects(w.run('runShortcut(name: "Resize")', input, { scriptsDir, allowScripts: false }), /scripts are not allowed here/);
});

test('a failing or disallowed script stops the pipeline, naming the step', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const steps = [inline("Write-Error 'nope'; exit 3", 'echo nope >&2; exit 3'), makeStep('copy', { to: 'after/' })];
  await assert.rejects(w.run(steps, input), (error: PipelineStepError) => {
    assert.ok(error instanceof PipelineStepError && error.step === 0);
    assert.match(error.message, /^Step 1, runScript\(code: .*\), failed: Script 'inline code' failed \(exit 3\): .*nope/s);
    assert.doesNotMatch(error.message, /CLIXML|<Objs/);
    return true;
  });
  await assert.rejects(w.run(steps, input, { allowScripts: false }), /scripts are not allowed here/);
  assert.deepEqual(await readdir(w.files), ['in.png'], 'the step after the failure never ran');
});

test('PowerShell errors written as CLIXML read as text', () => {
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">nope &amp; more_x000D__x000A_</S><S S="Error">    + CategoryInfo : NotSpecified_x000D__x000A_</S></Objs>';
  assert.equal(readableStderr(clixml), 'nope & more\n+ CategoryInfo : NotSpecified');
  assert.equal(readableStderr('plain error'), 'plain error');
  // Without the header, and with plain lines written between the error records.
  assert.equal(readableStderr('before\r\n<Objs Version="1.1.0.1"><S S="Error">bad_x000A_</S><S S="Verbose">noise</S></Objs>\r\nafter'), 'before\nbad\nafter');
});

test('only script types Windows runs itself are allowed', () => {
  for (const file of ['C:\\s\\a.ps1', 'C:\\s\\a.BAT', 'C:\\s\\a.cmd', 'C:\\s\\a.exe', 'C:\\s\\a.com']) assert.doesNotThrow(() => checkWindowsScript(file), file);
  for (const file of ['C:\\s\\a.js', 'C:\\s\\a.vbs', 'C:\\s\\a.lnk', 'C:\\s\\a.url', 'C:\\s\\a.hta', 'C:\\s\\Resize']) assert.throws(() => checkWindowsScript(file), /Clop runs \.ps1, \.bat, \.cmd, \.exe and \.com scripts/, file);
});

test('the mark of the web is read the way Windows writes it, and an unreadable mark refuses the script', async () => {
  assert.equal(zoneMarksDownload(Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n')), true);
  assert.equal(zoneMarksDownload(Buffer.from('[ZoneTransfer]\r\n  zoneid = 4\r\nReferrerUrl=x\r\n')), true);
  assert.equal(zoneMarksDownload(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[ZoneTransfer]\r\nZoneId=3\r\n', 'utf16le')])), true);
  assert.equal(zoneMarksDownload(Buffer.from('\uFEFF[ZoneTransfer]\nZoneId=3')), true);
  assert.equal(zoneMarksDownload(Buffer.from('[ZoneTransfer]\r\nZoneId=2\r\n')), false, 'trusted sites');
  assert.equal(zoneMarksDownload(Buffer.from('[ZoneTransfer]\r\nZoneId=30\r\n')), false);
  const failing = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(await markedAsDownloaded('C:\\s\\a.ps1', { platform: 'win32', read: failing('ENOENT') }), false);
  await assert.rejects(markedAsDownloaded('C:\\s\\a.ps1', { platform: 'win32', read: failing('EACCES') }), /could not check whether .* was downloaded/);
  assert.equal(await markedAsDownloaded('C:\\s\\a.ps1', { platform: 'win32', read: async () => Buffer.from('ZoneId=3') }), true);
  assert.equal(await markedAsDownloaded('/s/a.sh', { platform: 'linux', read: failing('EACCES') }), false);
});

test('script output is read as UTF-8, or as Windows-1252 when it is not UTF-8', () => {
  assert.equal(decodeOutput(Buffer.from('C:\\Users\\Zoë\\a.png', 'utf8')), 'C:\\Users\\Zoë\\a.png');
  assert.equal(decodeOutput(Buffer.from([0x5a, 0x6f, 0xeb])), 'Zoë');
});

test('Windows: a batch file gets a file name with cmd metacharacters as one argument, and its output is read as UTF-8', { skip: !windows && 'cmd only exists on Windows' }, async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('é & b %PATH% ^.png'), log = path.join(w.dir, 'arg.txt');
  await graphic(40, 30).png().toFile(input);
  const bat = path.join(w.dir, 'copy it.bat');
  await writeFile(bat, ['@echo off', 'setlocal EnableDelayedExpansion', 'set "arg=%~1"', `> "${log}" echo(!arg!`, 'copy /y "!arg!" "!arg!.copy.png" >nul', 'echo(!arg!.copy.png', ''].join('\r\n'));
  const result = await w.run([makeStep('runScript', { path: bat })], input);
  assert.equal((await readFile(log, 'utf8')).trim(), input);
  assert.equal(result.file, `${input}.copy.png`);
});

test('Windows: cmd never runs a chcp or other program from the script\'s folder, and other script types are refused', { skip: !windows && 'cmd only exists on Windows' }, async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  await writeFile(w.file('chcp.bat'), `@echo off\r\n> "${w.file('hijacked.txt')}" echo hijacked\r\n`);
  await writeFile(w.file('run.bat'), `@echo off\r\n> "${w.file('ran.txt')}" echo ran\r\n`);
  await w.run([makeStep('runScript', { path: '%P/run.bat' })], input);
  assert.deepEqual((await readdir(w.files)).filter(name => name.endsWith('.txt')), ['ran.txt']);
  await writeFile(w.file('run.js'), 'WScript.Echo(1)');
  await assert.rejects(w.run([makeStep('runScript', { path: '%P/run.js' })], input), /Clop runs \.ps1, \.bat, \.cmd, \.exe and \.com scripts, not \.js files/);
});

test('Windows: a .ps1 runs with its own exit code', { skip: !windows && 'Windows PowerShell only exists on Windows' }, async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  await writeFile(w.file('fail.ps1'), "Write-Error 'broken'\r\nexit 4\r\n");
  await assert.rejects(w.run([makeStep('runScript', { path: '%P/fail.ps1' })], input), (error: Error) => /failed \(exit 4\): .*broken/s.test(error.message) && !/CLIXML|<Objs/.test(error.message));
});

test('Windows: a script marked as downloaded from the internet is refused', { skip: !windows && 'the mark of the web is an NTFS stream' }, async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const file = await script(path.join(w.dir, 'downloaded'), 'exit 0', 'exit 0');
  await writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  await assert.rejects(w.run([makeStep('runScript', { path: file })], input), /was downloaded from the internet/);
});
