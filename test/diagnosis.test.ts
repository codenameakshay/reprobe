import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDiagnosis } from '../src/diagnosis.ts';

const known = new Set(['e1']);

test('validateDiagnosis keeps claims whose every cited id is known and drops the rest', () => {
  const d = validateDiagnosis({
    agent: 'claude',
    summary: [
      { text: 'ok', evidence: ['e1'] },
      { text: 'bad', evidence: ['nope'] },
      { text: 'none', evidence: [] },
    ],
    hypotheses: [{ text: 'mixed', evidence: ['e1', 'nope'] }],
  }, known);
  assert.deepEqual(d.summary, [{ text: 'ok', evidence: ['e1'] }]);
  assert.deepEqual(d.hypotheses, []);
  assert.deepEqual(d.dropped, ['bad', 'none', 'mixed']);
});

test('validateDiagnosis nulls a root cause that cites an unknown id and lists it as dropped', () => {
  const d = validateDiagnosis({ agent: 'claude', rootCause: { text: 'RC', evidence: ['nope'], confidence: 'high' } }, known);
  assert.equal(d.rootCause, null);
  assert.deepEqual(d.dropped, ['RC']);
});

test('validateDiagnosis keeps a valid root cause with its confidence', () => {
  const d = validateDiagnosis({ agent: 'claude', rootCause: { text: 'RC', evidence: ['e1'], confidence: 'medium' } }, known);
  assert.deepEqual(d.rootCause, { text: 'RC', evidence: ['e1'], confidence: 'medium' });
  assert.deepEqual(d.dropped, []);
});

test('validateDiagnosis turns an unrecognised confidence into low', () => {
  const d = validateDiagnosis({ agent: 'claude', rootCause: { text: 'RC', evidence: ['e1'], confidence: 'certain' } }, known);
  assert.equal(d.rootCause?.confidence, 'low');
});

test('validateDiagnosis returns an empty diagnosis for input that is not an object', () => {
  for (const raw of [null, 'nope', 42, ['a']]) {
    assert.deepEqual(validateDiagnosis(raw, known), {
      agent: 'unknown agent',
      rootCause: null,
      summary: [],
      hypotheses: [],
      unknowns: [],
      fix: null,
      dropped: [],
    });
  }
});
