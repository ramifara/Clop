import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ZoneView } from '../../core/pipeline/editor-state';
import { LostJson, mayLeave, zoneRowKey } from './guards';

test('leaving the library with unsaved changes asks first, and without them does not', () => {
  const asked: string[] = [];
  assert.equal(mayLeave(false, question => { asked.push(question); return false; }), true);
  assert.equal(asked.length, 0);
  assert.equal(mayLeave(true, question => { asked.push(question); return false; }), false, 'declined: stay');
  assert.equal(mayLeave(true, () => true), true);
  assert.equal(asked.length, 1);
});

test('a zone row keeps its key when only its revision changes', () => {
  const zone = (revision: string) => ({ readable: true, key: 'z1', revision, name: 'Zone' }) as ZoneView;
  assert.equal(zoneRowKey(zone('a')), zoneRowKey(zone('b')));
});

test('the JSON typed for an entry changed elsewhere stays on screen to be copied', () => {
  const html = renderToStaticMarkup(<LostJson json={'{"id": "x", // mine\n "steps": []}'} copy={() => {}} discard={() => {}}/>);
  assert.match(html, /readOnly/);
  assert.ok(html.includes('{&quot;id&quot;: &quot;x&quot;, // mine\n &quot;steps&quot;: []}'));
  assert.match(html, /Copy/);
});
