import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import path from 'node:path';

// A separate native Windows app supplies real image OLE drags, text selection,
// text OLE drags, window movement and resizing. No production test hooks.

export const DRAG_SKIPPED = 'SKIPPED on ARM64: the test window could not start a real OLE drag on this runner, so there was no drag for Clop to see';

/**
 * Whether the fixture really started the drag a step needs (`started`, from `fixture.dragsSince`). When it did not, a step that needs a drag cannot
 * tell anything about Clop: on an ARM64 machine, where the test window has not been seen to start one on a hosted runner, the caller skips the
 * drag-dependent steps (this prints why and returns false); anywhere else it is a failure.
 */
export function dragStartedOrSkip(started, what) {
  if (started) return true;
  if (process.arch === 'arm64') { console.log(`${DRAG_SKIPPED} (${what}).`); return false; }
  throw new Error(`The test window did not start a drag for ${what}, so Clop had no drag to see.`);
}
export async function dragFixture(image) {
  return sourceFixture('drag-source.ps1', image);
}
/** An Explorer window with `image` selected: a file, or a folder, which Explorer lists in its parent. */
export async function explorerFixture(image) {
  return sourceFixture('explorer-source.ps1', image, true);
}
async function sourceFixture(script, image, graceful = false) {
  const source = spawn('powershell.exe', ['-NoProfile', '-Sta', '-File', path.resolve('scripts', script), '-Image', image], { stdio: 'pipe' });
  let output = '';
  source.stderr.on('data', data => { output += data; });
  const lines = createInterface({ input: source.stdout });
  let sourceDrags = 0;
  lines.on('line', line => { if (line.startsWith('Source drag started')) sourceDrags++; if (!line.startsWith('{')) console.log(line); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Drag source did not start: ${output}`)), 35000);
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
    source.once('exit', code => { clearTimeout(timer); reject(new Error(`Drag source exited ${code}: ${output}`)); });
  }).catch(error => { source.kill(); lines.close(); throw error; });
  console.log(`${script} source: ${JSON.stringify(ready)} ${output}`);
  const gestures = new Set();
  let stopped = false;
  return {
    window: ready.window,
    /** How many drags the source window has started (its "Source drag started" lines). An Explorer window starts its drags itself and prints nothing, so this stays 0 for it. */
    get sourceDrags() { return sourceDrags; },
    /** Whether the source window has started a drag since the count was `before`; its line can arrive a moment after the gesture ends. */
    async dragsSince(before, wait = 2000) {
      for (const end = Date.now() + wait; sourceDrags <= before && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
      return sourceDrags > before;
    },
    gesture(kind, { hold = 600, escape = false, pressDelay = 300, moveX = 90, moveY = 40, to } = {}) {
      const point = ready[kind];
      const args = ['-NoProfile', '-File', path.resolve('scripts/drag-gesture.ps1'), '-Window', String(ready.window), '-Width', String(ready.width), '-Height', String(ready.height), '-X', String(point.x), '-Y', String(point.y), '-Hold', String(hold), '-PressDelay', String(pressDelay), '-MoveX', String(moveX), '-MoveY', String(moveY)];
      if (to) args.push('-ToX', String(Math.round(to.x)), '-ToY', String(Math.round(to.y)));
      if (escape) args.push('-Escape');
      const process = spawn('powershell.exe', args, { stdio: 'pipe' });
      gestures.add(process);
      let errors = ''; process.stderr.on('data', data => { errors += data; }); process.stdout.on('data', data => { errors += data; });
      const timer = setTimeout(() => { errors += '\nGesture exceeded 15 seconds'; process.kill(); }, 15000);
      return once(process, 'exit').then(([code]) => {
        clearTimeout(timer);
        gestures.delete(process);
        if (code !== 0) throw new Error(`Windows ${kind} gesture failed (${code}): ${errors}`);
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const process of gestures) if (process.exitCode === null && process.signalCode === null) process.kill();
      lines.close();
      if (source.exitCode === null && source.signalCode === null) {
        const exited = once(source, 'exit');
        if (graceful) source.stdin.end(); else source.kill();
        const timer = setTimeout(() => source.kill(), 5000);
        await exited; clearTimeout(timer);
      }
    },
  };
}
