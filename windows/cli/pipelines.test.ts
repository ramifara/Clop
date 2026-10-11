import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_CHANGED, type SettingsRequest, type SettingsResponse } from '../core/ipc/protocol';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import type { Backend } from './backend';
import { main } from './main';

/** A backend that answers settings requests from `answer`; reads give the settings as they are in `current`. */
function stub(current: () => Partial<ClopSettings>, answer: (request: SettingsRequest, attempt: number) => SettingsResponse | undefined) {
  const requests: SettingsRequest[] = [];
  const backend: Backend = {
    app: true, optimise: async () => {}, queue: async () => {}, stop: async () => {},
    settings: async request => {
      requests.push(request);
      if (request.action === 'read') return { ok: true, values: JSON.parse(JSON.stringify({ ...defaultSettings(), ...current() })) as Record<string, unknown> };
      return answer(request, requests.filter(r => r.action === 'update').length) ?? { ok: true };
    },
  };
  return { backend, requests, reads: () => requests.filter(r => r.action === 'read').length, updates: () => requests.filter(r => r.action === 'update') };
}
async function clop(backend: Backend, ...argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { io: { out: t => { out.push(t); }, err: t => { err.push(t); }, errTTY: false }, backend: async () => backend, options: { userData: '/nonexistent', home: '/home' } as never, env: {}, colours: false });
  return { code, out: out.join(''), err: err.join('') };
}

test('a pipeline edit that the app refuses as stale is built again from a fresh read, and only then', async () => {
  let saved: Partial<ClopSettings> = {};
  const s = stub(() => saved, (request, attempt) => {
    if (attempt === 1) {
      // The editor saved a pipeline in between.
      saved = { savedPipelines: [{ id: 'elsewhere', name: 'Other', steps: [], skipOptimisation: false, hideResult: false }] as never };
      return { ok: false, error: SETTINGS_CHANGED };
    }
    return undefined;
  });
  const result = await clop(s.backend, 'pipeline', 'add', 'Mine', 'optimise');
  assert.equal(result.code, 0, result.err);
  assert.equal(s.reads(), 2, 'read again after the refusal');
  const [first, second] = s.updates();
  assert.equal((first.values!.savedPipelines as unknown[]).length, 1);
  assert.equal((second.values!.savedPipelines as unknown[]).length, 2, 'the second attempt is built on the second read');
  assert.deepEqual((second.base!.savedPipelines as unknown[]).length, 1);
});

test('a refusal that is not "changed elsewhere" ends the edit at once, and a stale one gives up after four attempts', async () => {
  const refusing = stub(() => ({}), () => ({ ok: false, error: 'pdfDPI does not accept that value.' }));
  const first = await clop(refusing.backend, 'pipeline', 'add', 'Mine', 'optimise');
  assert.equal(first.code, 64);
  assert.match(first.err, /does not accept that value/);
  assert.equal(refusing.reads(), 1);
  const stale = stub(() => ({}), () => ({ ok: false, error: SETTINGS_CHANGED }));
  const second = await clop(stale.backend, 'pipeline', 'add', 'Mine', 'optimise');
  assert.equal(second.code, 64);
  assert.ok(second.err.includes(SETTINGS_CHANGED));
  assert.equal(stale.reads(), 4);
  assert.equal(stale.updates().length, 4);
});

test('a retry runs the edit\'s checks on the fresh settings: a name taken in between is refused with the usual error', async () => {
  let saved: Partial<ClopSettings> = {};
  const s = stub(() => saved, (_request, attempt) => {
    if (attempt > 1) return undefined;
    saved = { savedPipelines: [{ id: 'taken', name: 'Mine', steps: [{ optimise: {} }], skipOptimisation: false, hideResult: false }] as never };
    return { ok: false, error: SETTINGS_CHANGED };
  });
  const result = await clop(s.backend, 'pipeline', 'add', 'Mine', 'optimise');
  assert.equal(result.code, 64);
  assert.match(result.err, /A pipeline named 'Mine' already exists/);
  assert.equal(s.updates().length, 1);
});

test('a preset zone and an attachment name the settings they read as well as those they write', async () => {
  const library = [{ id: 'resize', name: 'resize', steps: [{ optimise: {} }], skipOptimisation: false, hideResult: false }] as never;
  const zone = stub(() => ({ savedPipelines: library }), () => undefined);
  assert.equal((await clop(zone.backend, 'pipeline', 'preset', 'add', 'web', 'resize')).code, 0);
  assert.deepEqual(Object.keys(zone.updates()[0].base!).sort(), ['presetZones', 'savedPipelines']);
  const attach = stub(() => ({ savedPipelines: library }), () => undefined);
  assert.equal((await clop(attach.backend, 'pipeline', 'attach', 'resize', '--source', '/home/Pictures', '--type', 'image')).code, 0);
  assert.deepEqual(Object.keys(attach.updates()[0].base!).sort(), ['enableAutomaticImageOptimisations', 'imageDirs', 'pipelinesToRunOnImage', 'savedPipelines']);
});
