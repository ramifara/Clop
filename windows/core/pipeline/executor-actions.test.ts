import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { graphic } from '../media/image.fixtures';
import { clip } from '../media/video.fixtures';
import { pipelineWorkspace } from './executor.fixtures';
import { PipelineStepError } from './executor';
import { makeStep } from './model';

// Inline code is PowerShell on Windows. Elsewhere it is PowerShell when pwsh is installed, otherwise sh, which these tests write for.
const hasPwsh = process.platform !== 'win32' && (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const powershell = process.platform === 'win32' || hasPwsh;
const inline = (ps: string, sh: string) => makeStep('runScript', { code: powershell ? ps : sh });

test('runScript runs inline code with the input file, and a printed path carries on', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const result = await w.run([inline(
    "$out = $env:CLOP_INPUT_FILE -replace 'in.png$', 'out.png'; Copy-Item $env:CLOP_INPUT_FILE $out; Write-Output $out",
    'out="${CLOP_INPUT_FILE%in.png}out.png"; cp "$1" "$out"; echo "$out"',
  )], input);
  assert.equal(result.file, w.file('out.png'));
  assert.deepEqual(await readFile(result.file), await readFile(input));

  // A printed path of another kind of file, or text that is not a path, leaves the file as it was.
  await writeFile(w.file('notes.mp3'), 'not audio');
  const ignored = await w.run([inline('Write-Output notes.mp3', 'echo notes.mp3')], input);
  assert.equal(ignored.file, input);
});

test('a script file gets the input as its first argument and the bundled tools folder', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in file.png'), log = w.file('log.txt');
  await graphic(40, 30).png().toFile(input);
  const script = process.platform === 'win32' ? w.file('script.ps1') : w.file('script.sh');
  await writeFile(script, process.platform === 'win32'
    ? `Set-Content -LiteralPath '${log}' -Value ($args[0] + '|' + $env:CLOP_INPUT_FILE + '|' + $env:CLOP_BIN)`
    : `#!/bin/sh\nprintf '%s|%s|%s' "$1" "$CLOP_INPUT_FILE" "$CLOP_BIN" > '${log}'\n`);
  if (process.platform !== 'win32') await chmod(script, 0o755);
  const previous = process.env.CLOP_TOOLS_DIR;
  process.env.CLOP_TOOLS_DIR = w.dir;
  t.after(() => { if (previous === undefined) delete process.env.CLOP_TOOLS_DIR; else process.env.CLOP_TOOLS_DIR = previous; });
  await w.run([makeStep('runScript', { path: '%P/' + path.basename(script) })], input);
  assert.equal((await readFile(log, 'utf8')).trim(), `${input}|${input}|${w.dir}`);
});

test('a failing or disallowed script stops the pipeline, naming the step', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const steps = [inline("Write-Error 'nope'; exit 3", 'echo nope >&2; exit 3'), makeStep('copy', { to: 'after/' })];
  await assert.rejects(w.run(steps, input), (error: PipelineStepError) => error instanceof PipelineStepError && error.step === 0 && /^Step 1, runScript\(code: .*\), failed: Script 'inline code' failed \(exit 3\): .*nope/s.test(error.message));
  await assert.rejects(w.run(steps, input, { allowScripts: false }), /scripts are not allowed here/);
  await assert.rejects(w.run([makeStep('runScript', { path: 'missing.ps1' })], input), /Script not found: .*missing\.ps1/);
  await assert.rejects(w.run('runShortcut(name: "Make GIF")', input), /macOS Shortcut, and Windows has no Shortcuts app/);
  assert.deepEqual(await readdir(w.files), ['in.png'], 'the step after the failure never ran');
});

test('clipboard, app and share steps go through the app', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('shot.png');
  await graphic(40, 30).png().toFile(input);
  await w.run(`copyToClipboard -> copyToClipboard(format: markdown, relativeTo: "%P") -> copyToClipboard(format: imageData) -> openWith(app: "Paint") -> shelveWith(app: yoink) -> uploadWith(app: dropshare)`, input);
  assert.deepEqual(w.effects.clipboard, [{ text: input }, { text: '[shot](/shot.png)' }, { image: input }]);
  assert.deepEqual(w.effects.opened, [[input, 'Paint'], [input, 'yoink'], [input, 'dropshare']]);
  assert.equal(await w.marker.isOptimised(input), true);
  await assert.rejects(w.run('openWith(app: "Missing")', input), /Step 1, openWith\(app: Missing\), failed: App 'Missing' not found/);
  await assert.rejects(w.run('copyLinkForSending', input), /Share links need an upload target in Settings/);
});

test('fork hands back the result so far, copied when a later step would change it', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('logo.png');
  await graphic(200, 100).png().toFile(input);
  const untouched = await w.run('fork', input);
  assert.deepEqual(untouched.forks, [input]);
  const before = await readFile(input);
  const copied = await w.run('fork -> downscale(factor: 0.5)', input);
  assert.ok(w.workdir.owns(copied.forks[0]));
  assert.deepEqual(await readFile(copied.forks[0]), before, 'the fork keeps the file as it was at the fork');
  const saved = await w.run('fork(location: "%f-copy")', input);
  assert.deepEqual(saved.forks, [w.file('logo-copy.png')]);
});

test('progress is reported per step, and cancelling stops before the next step', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('in.png');
  await graphic(40, 30).png().toFile(input);
  const events: string[] = [];
  await w.run('copy(to: "%P/a/") -> copy(to: "%P/b/")', input, { onProgress: ({ step, steps, text, fraction }) => events.push(`${step}/${steps} ${text} ${fraction}`) });
  assert.deepEqual(events, ['0/2 copy(to: "%P/a/") 0', '0/2 copy(to: "%P/a/") 1', '1/2 copy(to: "%P/b/") 0', '1/2 copy(to: "%P/b/") 1']);

  const controller = new AbortController();
  await assert.rejects(w.run('copy(to: "%P/c/") -> copy(to: "%P/d/")', input, { signal: controller.signal, onProgress: ({ step, fraction }) => { if (step === 0 && fraction === 1) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual((await readdir(w.files)).sort(), ['a', 'b', 'c', 'in.png']);
});

test('cancelling an encode stops it and leaves no temporary files', async t => {
  const w = await pipelineWorkspace(t, 'ffmpeg', 'ffprobe'); if (!w) return;
  const input = await clip(w.file('long.mp4'), { width: 640, height: 480, seconds: 6 });
  const before = await readFile(input);
  const controller = new AbortController();
  const running = w.run('optimise(encoder: slowHighQuality)', input, { signal: controller.signal, onProgress: () => setTimeout(() => controller.abort(), 50) });
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(await readFile(input), before);
  assert.deepEqual(await w.temp(), []);
});
