import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendInBatches } from '../../src/shared/batches.ts';

test('yields between bounded batches and preserves exact order and offsets', () => {
  const frames = [], calls = [];
  appendInBatches([1, 2, 3, 4, 5], (batch, offset) => calls.push([batch, offset]), (callback) => frames.push(callback), 2);
  assert.deepEqual(calls, []);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(calls, [[[1, 2], 0]]);
  while (frames.length) frames.shift()();
  assert.deepEqual(calls, [[[1, 2], 0], [[3, 4], 2], [[5], 4]]);
});
test('replacing a view cancels queued work without appending stale tasks', () => {
  const frames = [], calls = [];
  const cancel = appendInBatches([1, 2, 3], (batch) => calls.push(...batch), (callback) => frames.push(callback), 1);
  frames.shift()(); cancel();
  while (frames.length) frames.shift()();
  assert.deepEqual(calls, [1]);
});
test('empty lists schedule no work and invalid batch sizes fail explicitly', () => {
  const frames = [];
  appendInBatches([], () => assert.fail('empty list'), (callback) => frames.push(callback));
  assert.equal(frames.length, 0);
  for (const size of [0, -1, 1.5, NaN]) assert.throws(() => appendInBatches([1], () => {}, () => {}, size), RangeError);
});
test('cancelling from inside append does not schedule another frame', () => {
  const frames = [];
  let cancel;
  cancel = appendInBatches([1, 2], () => cancel(), (callback) => frames.push(callback), 1);
  frames.shift()();
  assert.equal(frames.length, 0);
});
