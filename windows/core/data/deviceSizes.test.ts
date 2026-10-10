import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEVICE_SIZE_GROUPS, DEVICE_SIZES, deviceSizeGroup, findDeviceSize } from './deviceSizes';

const swift = readFileSync(fileURLToPath(new URL('../../../Shared/DeviceSizes.swift', import.meta.url)), 'utf8');
const section = (from: string, to: string) => swift.slice(swift.indexOf(from), swift.indexOf(to));
const unescape = (text: string) => text.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

test('the device size table matches Shared/DeviceSizes.swift', () => {
  const entries = [...section('let DEVICE_SIZES', 'let IPHONE_SIZE_GROUPS').matchAll(/"([^"]+)": NSSize\(width: (\d+), height: (\d+)\)/g)].map(([, name, w, h]) => [name, { width: Number(w), height: Number(h) }] as const);
  assert.equal(entries.length, 101);
  assert.deepEqual(Object.entries(DEVICE_SIZES), entries);
  // The Device enum lists the same names: `case iPad` has no raw value, so its name is its value.
  const cases = [...section('enum Device', 'var aspectRatio').matchAll(/case (\w+)(?: = "([^"]+)")?\n/g)].map(([, name, value]) => value ?? name);
  assert.deepEqual(cases, Object.keys(DEVICE_SIZES));
});

test('the device size groups match Shared/DeviceSizes.swift', () => {
  const lists = [...section('let IPHONE_SIZE_GROUPS', 'let DEVICE_SIZE_GROUPS').matchAll(/let (\w+): \[CropSizeGroup\] = \[(.*?)\n\]/gs)];
  const order = [...section('let DEVICE_SIZE_GROUPS', 'func deviceSizeGroup').matchAll(/\("([^"]+)", (\w+)\)/g)];
  assert.deepEqual(DEVICE_SIZE_GROUPS.map(c => c.category), order.map(m => m[1]));
  for (const [i, [, , listName]] of order.entries()) {
    const body = lists.find(l => l[1] === listName)![2];
    const groups = [...body.matchAll(/CropSizeGroup\(\s*name: "([^"]+)", width: (\d+), height: (\d+),\s*members: \[([^\]]*)\](?:,\s*summary: "([^"]+)")?/gs)].map(([, name, w, h, members, summary]) => ({
      name: unescape(name), width: Number(w), height: Number(h), members: [...members.matchAll(/"([^"]+)"/g)].map(m => m[1]), ...(summary ? { summary: unescape(summary) } : {}),
    }));
    assert.ok(groups.length > 0, listName);
    assert.deepEqual(DEVICE_SIZE_GROUPS[i].groups, groups, listName);
  }
  for (const member of DEVICE_SIZE_GROUPS.flatMap(c => c.groups.flatMap(g => g.members))) assert.ok(DEVICE_SIZES[member], `${member} is a device`);
});

test('device sizes resolve by name, case-insensitively, or by group', () => {
  assert.deepEqual(findDeviceSize('iPhone 15 Pro'), { width: 1179, height: 2556 });
  assert.deepEqual(findDeviceSize('ipad mini 6'), { width: 1488, height: 2266 });
  assert.deepEqual(findDeviceSize('iPhone Plus (16:9)'), { width: 1080, height: 1920 });
  assert.equal(findDeviceSize('Pixel 9'), undefined);
  assert.equal(deviceSizeGroup('iphone x')?.name, 'iPhone 11 Pro & X & XS');
});
