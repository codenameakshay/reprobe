import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/report.ts';
import type { Diagnosis } from '../src/diagnosis.ts';
import type { Evidence, Gathered } from '../src/types.ts';

const g = (evidence: Evidence[]): Gathered => ({
  input: { complaint: 'groups are missing', sinceMs: 1 },
  window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z' },
  subject: { sessionIds: [], traceIds: [] },
  sources: [{ source: 'db', state: 'ok', detail: 'read' }],
  evidence,
});

test('report timeline is byte-stable when evidence input order changes', () => {
  const evidence: Evidence[] = [
    { id: 'db:z', source: 'db', at: '2026-01-01T00:02:00.000Z', kind: 'row', summary: 'later', data: {} },
    { id: 'db:a', source: 'db', at: '2026-01-01T00:01:00.000Z', kind: 'row', summary: 'earlier', data: {} },
  ];
  const first = renderMarkdown('case', g(evidence), [], null);
  const second = renderMarkdown('case', g([...evidence].reverse()), [], null);
  assert.equal(first, second);
});

test('report timeline sorts timestamps by instant across UTC offsets', () => {
  const evidence: Evidence[] = [
    { id: 'db:z', source: 'db', at: '2026-01-01T00:02:00.000Z', kind: 'row', summary: 'later', data: {} },
    { id: 'db:a', source: 'db', at: '2026-01-01T05:31:00.000+05:30', kind: 'row', summary: 'earlier', data: {} },
  ];
  const report = renderMarkdown('case', g(evidence), [], null);
  assert.ok(report.indexOf('`db:a`') < report.indexOf('`db:z`'));
});

test('report preserves absent timestamps as absent rather than inventing UTC times', () => {
  const evidence: Evidence[] = [{ id: 'db:x', source: 'db', at: null, kind: 'row', summary: 'untimed', data: {} }];
  assert.match(renderMarkdown('case', g(evidence), [], null), /\| - \| db \| untimed \|/);
});

test('report does not call a known user unresolved just because its label is absent', () => {
  const gathered = g([]);
  gathered.subject.userId = 'user-123';
  assert.match(renderMarkdown('case', gathered, [], null), /\*\*Subject:\*\* user user-123/);
});

test('report marks unknown finding and narrative citations unavailable and limits its validation claim', () => {
  const evidence: Evidence[] = [{ id: 'db:known', source: 'db', at: null, kind: 'row', summary: 'known', data: {} }];
  const findings = [{ signature: 'audit', title: 'finding', confidence: 'low' as const, rootCause: 'cause', evidence: ['fake:id'], unknowns: [] }];
  const narrative = { model: 'test', summary: [{ text: 'Claim.', evidence: ['fake:id'] }], hypotheses: [], dropped: [] };
  const report = renderMarkdown('case', g(evidence), findings, narrative);
  assert.match(report, /\[evidence unavailable\]/);
  assert.match(report, /claim accuracy is not independently verified/);
  assert.doesNotMatch(report, /`fake:id`/);
});

test('report renders a diagnosis with its root cause, evidence and dropped claims, and renames the findings heading', () => {
  const evidence: Evidence[] = [{ id: 'db:known', source: 'db', at: '2026-01-01T00:00:30.000Z', kind: 'row', summary: 'known row', data: {} }];
  const diagnosis: Diagnosis = {
    agent: 'test-agent',
    rootCause: { text: 'The handler returns 500 for a deliberate 403.', confidence: 'high', evidence: ['db:known'] },
    summary: [],
    hypotheses: [],
    unknowns: [],
    fix: null,
    dropped: ['An uncited claim'],
  };
  const findings = [{ signature: 'audit', title: 'finding', confidence: 'low' as const, rootCause: 'cause', evidence: [], unknowns: [] }];
  const report = renderMarkdown('case', g(evidence), findings, null, [], diagnosis);
  assert.match(report, /^## Diagnosis$/m);
  assert.match(report, /\*\*Root cause \[HIGH\]:\*\* The handler returns 500 for a deliberate 403\./);
  assert.match(report, /^- `db:known`/m);
  assert.match(report, /^## Detector findings$/m);
  assert.doesNotMatch(report, /## Likely root cause/);
  assert.match(report, /Dropped \(no valid citation\)/);
  assert.match(report, /~~An uncited claim~~/);
});

test('report escapes untrusted markdown and HTML and includes diagnosis citations in timeline', () => {
  const evidence: Evidence[] = [{ id: 'db:known', source: 'db', at: null, kind: 'row', summary: 'known <b>row</b>', data: {}, link: 'javascript:alert(1)' }];
  const diagnosis: Diagnosis = {
    agent: '<svg/onload=alert(1)>', rootCause: { text: '<img src=x onerror=alert(1)>', confidence: 'high', evidence: ['db:known'] },
    summary: [], hypotheses: [], unknowns: [], fix: null, dropped: [],
  };
  const report = renderMarkdown('case', g(evidence), [], null, [], diagnosis);
  assert.doesNotMatch(report, /<script>|<img |<b>|<svg/);
  assert.match(report, /&lt;img src=x onerror=alert\\\(1\\\)&gt;/);
  assert.doesNotMatch(report, /\]\(javascript:/);
  assert.doesNotMatch(report, /\]\(javascript:/);
  assert.match(report, /\| - \| db \|.*`db:known`/);
});

test('report makes table pipes single-escaped and timeline keeps diagnosis and narrative cited info logs only', () => {
  const evidence: Evidence[] = [
    { id: 'log:diag|cited', source: 'logs', at: null, kind: 'log.info', summary: 'diagnosis|detail', data: {} },
    { id: 'log:narrative', source: 'logs', at: null, kind: 'log.info', summary: 'narrative cited', data: {} },
    { id: 'log:uncited', source: 'logs', at: null, kind: 'log.info', summary: 'irrelevant info', data: {} },
  ];
  const diagnosis: Diagnosis = {
    agent: 'test-agent', rootCause: { text: 'cause', confidence: 'high', evidence: ['log:diag|cited'] },
    summary: [], hypotheses: [], unknowns: [], fix: null, dropped: [],
  };
  const narrative = { model: 'test', summary: [{ text: 'summary', evidence: ['log:narrative'] }], hypotheses: [], dropped: [] };
  const report = renderMarkdown('case', g(evidence), [], narrative, [], diagnosis);
  const timeline = report.slice(report.indexOf('## Timeline'));
  assert.match(timeline, /`log:diag\\\|cited`/);
  assert.match(timeline, /`log:narrative`/);
  assert.doesNotMatch(timeline, /log:uncited|irrelevant info/);
  assert.match(timeline, /diagnosis\\\|detail/);
  assert.doesNotMatch(timeline, /diagnosis\\\\\\\|detail/);
});

test('report encodes parentheses in safe link hrefs', () => {
  const evidence: Evidence[] = [{ id: 'db:known', source: 'db', at: null, kind: 'row', summary: 'known', data: {}, link: 'https://example.test/path_(item)' }];
  const findings = [{ signature: 'audit', title: 'finding', confidence: 'low' as const, rootCause: 'cause', evidence: ['db:known'], unknowns: [] }];
  const report = renderMarkdown('case', g(evidence), findings, null);
  assert.match(report, /\]\(https:\/\/example\.test\/path_%28item%29\)/);
});

test('report redacts private values even when supplied directly by a diagnosis caller', () => {
  const diagnosis: Diagnosis = {
    agent: 'agent+private@example.com', rootCause: { text: 'token=report-secret-value', confidence: 'high', evidence: ['db:known'] },
    summary: [], hypotheses: [], unknowns: [], fix: null, dropped: [],
  };
  const report = renderMarkdown('case', g([{ id: 'db:known', source: 'db', at: null, kind: 'row', summary: 'ok', data: {} }]), [], null, [], diagnosis);
  assert.doesNotMatch(report, /agent\+private@example\.com|report-secret-value/);
  assert.match(report, /\\\[email\\\]|\\\[redacted\\\]/);
});
