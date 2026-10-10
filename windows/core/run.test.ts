import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { queue, retryBusy, run, ToolError, type QueueKind } from './run';

const node = process.execPath;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitForExit(pid: number) {
  for (const end = Date.now() + 5000; Date.now() < end; await delay(50)) if (!alive(pid)) return;
  assert.fail(`process ${pid} is still running`);
}
const busy = (code: string) => Object.assign(new Error(`file is locked (${code})`), { code });

test('returns stdout bytes and stderr text, and feeds input on stdin', async () => {
  const echo = await run(node, ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("note")'], { input: Buffer.from([0, 1, 255]) });
  assert.deepEqual([...echo.stdout], [0, 1, 255]);
  assert.equal(echo.stderr, 'note');
  assert.equal(echo.code, 0);
});

test('rejects with the last stderr lines when the tool fails', async () => {
  await assert.rejects(run(node, ['-e', 'for (let i = 1; i <= 8; i++) console.error("problem " + i); process.exit(3)']), (error: ToolError) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.exitCode, 3);
    assert.match(error.message, /exited with code 3:\nproblem 4\n.*\nproblem 8$/s);
    assert.doesNotMatch(error.message, /problem 3/);
    return true;
  });
});

test('reports stderr progress line by line, including carriage-return updates split across writes', async () => {
  const lines: string[] = [];
  const script = 'process.stderr.write("frame=1\\rfra"); setTimeout(() => process.stderr.write("me=2\\r\\nframe=3\\nDone"), 50)';
  await run(node, ['-e', script], { onStderrLine: line => lines.push(line) });
  assert.deepEqual(lines, ['frame=1', 'frame=2', 'frame=3', 'Done']);
});

test('reports stdout progress line by line while still returning all stdout bytes', async () => {
  const lines: string[] = [];
  const result = await run(node, ['-e', 'process.stdout.write("Frame 1 / 2\\rFra"); setTimeout(() => process.stdout.write("me 2 / 2\\rdone"), 50)'], { onStdoutLine: line => lines.push(line) });
  assert.deepEqual(lines, ['Frame 1 / 2', 'Frame 2 / 2', 'done']);
  assert.equal(result.stdout.toString(), 'Frame 1 / 2\rFrame 2 / 2\rdone');
});

test('a progress callback that throws stops the tool and fails the run with its error', async () => {
  const started = Date.now();
  await assert.rejects(run(node, ['-e', 'console.error("frame=1"); setInterval(() => {}, 1000)'], { onStderrLine: () => { throw new Error('bad progress line'); } }), /bad progress line/);
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(run(node, ['-e', 'process.stderr.write("last line without newline")'], { onStderrLine: () => { throw new Error('bad final line'); } }), /bad final line/);
});

test('aborting kills the whole process tree', async () => {
  const controller = new AbortController();
  let grandchild = 0;
  const script = 'const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.error("pid " + g.pid); setInterval(() => {}, 1000)';
  const running = run(node, ['-e', script], { signal: controller.signal, onStderrLine: line => {
    const pid = /^pid (\d+)$/.exec(line)?.[1];
    if (pid) { grandchild = Number(pid); controller.abort(); }
  } });
  await assert.rejects(running, { name: 'AbortError' });
  assert.ok(grandchild > 0);
  await waitForExit(grandchild);
});

test('a timeout stops the tool, and an aborted signal never starts it', async () => {
  await assert.rejects(run(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }), /took too long/);
  await assert.rejects(run('a-tool-that-does-not-exist', [], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(run('a-tool-that-does-not-exist', []), { code: 'ENOENT' });
});

test('each media type has its own concurrency limit', async () => {
  const peak = async (kind: QueueKind) => {
    let active = 0, max = 0;
    await Promise.all(Array.from({ length: 5 }, () => queue(kind)(async () => { max = Math.max(max, ++active); await delay(20); active--; })));
    return max;
  };
  assert.deepEqual(await Promise.all((['image', 'video', 'pdf', 'audio'] as const).map(peak)), [2, 1, 2, 2]);
  assert.equal(queue('video'), queue('video'));
});

test('a failed task releases its queue slot', async () => {
  await assert.rejects(queue('video')(async () => { throw new Error('encode failed'); }), /encode failed/);
  assert.equal(await queue('video')(async () => 'next'), 'next');
});

test('retryBusy waits out a locked file with doubling backoff', async () => {
  let calls = 0;
  const started = Date.now();
  assert.equal(await retryBusy(async () => { calls++; if (calls === 1) throw busy('EBUSY'); if (calls === 2) throw busy('EPERM'); return 'written'; }), 'written');
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 290);
});

test('retryBusy gives up after five tries and never retries other errors', async () => {
  let calls = 0;
  await assert.rejects(retryBusy(async () => { calls++; throw busy('EBUSY'); }), /locked/);
  assert.equal(calls, 5);
  calls = 0;
  await assert.rejects(retryBusy(async () => { calls++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }), /missing/);
  assert.equal(calls, 1);
});
