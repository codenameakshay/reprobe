import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, stepApplies } from '../src/verify.ts';

const marker = 'REPROBE_REPLAY:fixture';
const started = `${marker}:START\n`;
const passed = `${started}${marker}:PASS\n`;
const failed = `${started}${marker}:FAIL\n`;

test('classify: exit 0 without proof that a replay ran is broken', () => {
  assert.equal(classify(0, '').outcome, 'broken');
});

test('classify: a completed Jest replay is a pass', () => {
  assert.equal(classify(0, `${passed}PASS src/example.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 1 passed, 1 total`, marker).outcome, 'pass');
});

test('classify: a completed Dart replay is a pass', () => {
  assert.equal(classify(0, `${passed}00:00 +1: All tests passed!`, marker).outcome, 'pass');
});

test('classify: a jest value diff is a fail', () => {
  const out = '- Expected  - 3\n+ Received  + 1\n\n- Array [\n-   "x",\n- ]\n+ Array []';
  assert.equal(classify(1, `${failed}FAIL src/example.spec.ts\n${out}\nTest Suites: 1 failed`, marker).outcome, 'fail');
});

test('classify: assertion-looking output without a marker is broken', () => {
  assert.equal(classify(1, 'Expected: {\'a\'}\n  Actual: {}').outcome, 'broken');
});

test('classify: a ReferenceError is broken, not a fail', () => {
  assert.equal(classify(1, 'ReferenceError: makeService is not defined').outcome, 'broken');
});

test('classify: a missing generated getter is broken, not a fail', () => {
  assert.equal(classify(1, "Error: The getter 'allIds' isn't defined for the type 'GroupsSyncResponse'").outcome, 'broken');
});

test('classify: an Expected/Actual assertion is a fail and its Actual line is the detail', () => {
  const result = classify(1, `${failed}00:00 +0 -1: Expected: {'a'}\n  Actual: {}\nSome tests failed.`, marker);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.detail, 'Actual: {}');
});

test('classify: a non-zero exit with no marker is broken', () => {
  assert.equal(classify(1, 'something exploded').outcome, 'broken');
});

test('classify: aggregate totals or another replay marker cannot prove this replay ran', () => {
  const summary = 'PASS src/example.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 5 passed, 1 total';
  assert.equal(classify(0, summary).outcome, 'broken');
  assert.equal(classify(0, summary, marker).outcome, 'broken');
  assert.equal(classify(0, `${passed}${summary}`, 'REPROBE_REPLAY:other').outcome, 'broken');
  assert.equal(classify(0, `${started}${summary}`, marker).outcome, 'broken');
});

test('classify: an unrelated suite failure after the replay passed is broken', () => {
  assert.equal(classify(1, `${passed}FAIL src/example.spec.ts\nExpected: true\nReceived: false\nTest Suites: 1 failed`, marker).outcome, 'broken');
});

test('classify: a runtime error stays broken even after a FAIL marker', () => {
  assert.equal(classify(1, `${failed}ReferenceError: value is not defined`, marker).outcome, 'broken');
});

test('classify: a FAIL marker is enough for fail without a jest or dart summary line', () => {
  assert.equal(classify(1, `${failed}FAIL src/example.spec.ts\nTest Suites: 1 failed`, marker).outcome, 'fail');
});

test('classify: a FAIL marker with trailing text uses that text as the detail when there is no assertion', () => {
  const result = classify(1, `${started}${marker}:FAIL the widget did not save\nthrown away`, marker);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.detail, 'the widget did not save');
});

test('classify: a bare FAIL marker with no assertion or text reports the exit code', () => {
  assert.deepEqual(classify(1, `${started}${marker}:FAIL`, marker), { outcome: 'fail', detail: 'assertion failed (exit 1)' });
});

test('classify: two START markers, two FAIL markers, or PASS with FAIL are all broken', () => {
  assert.equal(classify(0, `${started}${started}${passed}`, marker).outcome, 'broken');
  assert.equal(classify(1, `${started}${failed}${failed}`, marker).outcome, 'broken');
  assert.equal(classify(0, `${passed}${failed}`, marker).outcome, 'broken');
});

test('classify: an indented Jest assertion diff containing error-looking data is still fail', () => {
  const output = `${failed}FAIL src/example.spec.ts\n    expect(received).toEqual(expected) // deep equality\n\n    - Expected  - 1\n    + Received  + 1\n\n    - \"ReferenceError: recorded provider response\"\n    + \"safe message\"\nTest Suites: 1 failed`;
  assert.equal(classify(1, output, marker).outcome, 'fail');
});

test('classify: Flutter compact reporter carriage returns preserve exact markers', () => {
  const output = `00:01 +0: replay is running\r${marker}:START\r${marker}:PASS\r00:01 +1: All tests passed!`;
  assert.equal(classify(0, output, marker).outcome, 'pass');
});

test('stepApplies: a "." step applies to every replay directory', () => {
  assert.equal(stepApplies('.', 'server'), true);
  assert.equal(stepApplies('.', '.'), true);
});

test('stepApplies: a directory step applies to that directory and its children only', () => {
  assert.equal(stepApplies('server', 'server'), true);
  assert.equal(stepApplies('server', 'server/x'), true);
  assert.equal(stepApplies('server', 'serverless'), false);
  assert.equal(stepApplies('server', 'app'), false);
});
