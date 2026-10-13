import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileCollector } from './file-collector';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('launches that arrive close together become one selection, in order, without repeats', async () => {
  const fired: string[][] = [];
  const collector = new FileCollector(files => fired.push(files), 40);
  collector.add(['a.png']);
  await wait(15);
  collector.add(['b.png', 'a.png']);
  await wait(15);
  collector.add(['c.png']);
  assert.deepEqual(fired, [], 'still waiting for more');
  await wait(90);
  assert.deepEqual(fired, [['a.png', 'b.png', 'c.png']]);
});

test('a later launch starts a new selection, nothing fires for no files, and cancelling drops what was gathered', async () => {
  const fired: string[][] = [];
  const collector = new FileCollector(files => fired.push(files), 20);
  collector.add([]);
  collector.add(['a.png']);
  await wait(60);
  collector.add(['b.png']);
  await wait(60);
  collector.add(['c.png']);
  collector.cancel();
  await wait(60);
  assert.deepEqual(fired, [['a.png'], ['b.png']]);
});
