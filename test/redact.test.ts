import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue, initials } from '../src/redact.ts';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

test('redactText: postgres password redacted, scheme and user kept', () => {
  assert.equal(
    redactText('connect to postgres://app:s3cret@db.internal:5432/app now'),
    'connect to postgres://app:[redacted]@db.internal:5432/app now',
  );
  assert.equal(
    redactText('dsn postgresql://admin:hunter2@10.0.0.5/main ok'),
    'dsn postgresql://admin:[redacted]@10.0.0.5/main ok',
  );
});

test('redactText: HTTP URL userinfo passwords are redacted', () => {
  assert.equal(redactText('fetch https://service-user:opaque-password@api.example.com/path'), 'fetch https://service-user:[redacted]@api.example.com/path');
});

test('redactText: Basic authorization in JSON-like logs is redacted', () => {
  assert.equal(redactText('request headers {"Authorization":"Basic dXNlcjpwYXNz"}'), 'request headers {"Authorization":"Basic [redacted]"}');
});

test('redactText: JWT replaced with [jwt]', () => {
  assert.equal(redactText(`session ${JWT} ended`), 'session [jwt] ended');
});

test('redactText: Bearer token replaced with Bearer [redacted]', () => {
  assert.equal(
    redactText('Authorization: Bearer abc.def-123_xyz.'),
    'Authorization: Bearer [redacted].',
  );
  assert.equal(
    redactText(`Authorization: Bearer ${JWT}`),
    'Authorization: Bearer [redacted]',
  );
});

test('redactText: secret-looking keys replaced with [secret]', () => {
  assert.equal(
    redactText('keys sk-proj-abc123XYZ and ghp_0123456789abcdef used'),
    'keys [secret] and [secret] used',
  );
  assert.equal(
    redactText('pk-lf-12345678 sk-lf-abcdefgh sntryu_abcdefgh lsv2_pt_abcdefgh xoxb-1234567890 gho_abcdefgh'),
    '[secret] [secret] [secret] [secret] [secret] [secret]',
  );
  assert.equal(redactText('task-manager sk-short'), 'task-manager sk-short');
});

test('redactText: query params token/access_token/key/sig/signature keep name', () => {
  assert.equal(
    redactText('GET https://files.example.com/a?alt=media&token=e347f2df-503e-4f47 done'),
    'GET https://files.example.com/a?alt=media&token=[redacted] done',
  );
  assert.equal(
    redactText('https://x.example/?access_token=abc&sig=xyz&signature=qq&key=k1 end'),
    'https://x.example/?access_token=[redacted]&sig=[redacted]&signature=[redacted]&key=[redacted] end',
  );
});

test('redactText: signed object-storage URL credentials and signatures are redacted', () => {
  assert.equal(
    redactText('https://bucket.example/a?X-Amz-Credential=AKIASECRET%2Fscope&X-Amz-Security-Token=session-secret&X-Amz-Signature=abc123&X-Goog-Signature=def456&AWSAccessKeyId=key123&Expires=1700000000'),
    'https://bucket.example/a?X-Amz-Credential=[redacted]&X-Amz-Security-Token=[redacted]&X-Amz-Signature=[redacted]&X-Goog-Signature=[redacted]&AWSAccessKeyId=[redacted]&Expires=1700000000',
  );
});

test('redactValue: JSON-encoded nested source previews are parsed and redacted', () => {
  assert.equal(
    redactValue('{"meta":{"phoneNumber":"+1 415 555 2671","access_token":"opaque-token"}}'),
    '{"meta":{"phoneNumber":"[redacted]","access_token":"[redacted]"}}',
  );
  assert.equal(
    redactValue('"{\\"password\\":\\"opaque-example\\"}"'),
    '"{\\"password\\":\\"[redacted]\\"}"',
  );
});

test('redactValue: deep preview passwords with spaces and encoded source JSON are redacted', () => {
  const deep = { a: { b: { c: { d: { outputPreview: '{"password":"correct horse battery staple"}' } } } } };
  assert.equal(deep.a.b.c.d.outputPreview, '{"password":"correct horse battery staple"}');
  assert.deepEqual(redactValue(deep), { a: { b: { c: { d: { outputPreview: '{"password":"[redacted]"}' } } } } });
  assert.equal(redactText('{"password":"correct horse battery staple"}'), '{"password":"[redacted]"}');
});

test('redaction removes full secrets from truncated JSON and escaped quoted values', () => {
  assert.equal(redactText('{"password":"opaque-unclosed-secret'), '{"password":"[redacted]');
  assert.equal(redactText('{"access_token":"first\\\"second-unclosed-secret'), '{"access_token":"[redacted]');
  assert.equal(redactValue({ deep: { preview: '{"password":"opaque-unclosed-secret' } }).deep.preview, '{"password":"[redacted]');
});

test('redactText: emails replaced with [email]', () => {
  assert.equal(redactText('contact dana@example.com today'), 'contact [email] today');
  assert.equal(redactText('mail a.b+tag@sub.example.co.in now'), 'mail [email] now');
});

test('redactText: +91 phone with optional single spaces or dashes', () => {
  assert.equal(redactText('+91 98765-43210 is mine'), '[phone] is mine');
  assert.equal(redactText('sms +919876543210 now'), 'sms [phone] now');
});

test('redactText: + followed by 11-13 digits', () => {
  assert.equal(redactText('us +14155552671 ok'), 'us [phone] ok');
  assert.equal(redactText('de +4915112345678 ok'), 'de [phone] ok');
});

test('redactText: clearly formatted US phone numbers are redacted', () => {
  assert.equal(redactText('call (415) 555-2671 or +1 (650) 555-0100'), 'call [phone] or [phone]');
});

test('redactText: standalone 10-digit number starting 6-9', () => {
  assert.equal(redactText('call 9876543210 now'), 'call [phone] now');
  assert.equal(
    redactText('not 5876543210 nor 98765432101 nor abc9876543210def'),
    'not 5876543210 nor 98765432101 nor abc9876543210def',
  );
});

test('redactText: UUID passes through unchanged', () => {
  assert.equal(
    redactText('request 9a8b7c6d-1111-4222-8333-444455556666 failed'),
    'request 9a8b7c6d-1111-4222-8333-444455556666 failed',
  );
});

test('redactText: ISO timestamp passes through unchanged', () => {
  assert.equal(
    redactText('created 2026-07-28T08:44:36.147001Z by worker'),
    'created 2026-07-28T08:44:36.147001Z by worker',
  );
});

test('redactText: integer amount passes through unchanged', () => {
  assert.equal(redactText('charged 11946 rupees'), 'charged 11946 rupees');
});

test('redactText: decimal amounts pass through unchanged', () => {
  assert.equal(redactText('totals 302.00 and 5768.50 today'), 'totals 302.00 and 5768.50 today');
});

test('redactText: cuid passes through unchanged', () => {
  assert.equal(redactText('row cxq7w2k9m4n8p3r6t1v5y0z2a saved'), 'row cxq7w2k9m4n8p3r6t1v5y0z2a saved');
});

test('redactText: 32-hex trace id passes through unchanged', () => {
  assert.equal(
    redactText('trace 0123456789abcdef0123456789abcdef seen'),
    'trace 0123456789abcdef0123456789abcdef seen',
  );
});

test('redactText: build string passes through unchanged', () => {
  assert.equal(redactText('built 1.2.0+155 for review'), 'built 1.2.0+155 for review');
});

test('redactValue: key-based and text-based redaction on nested data, input not mutated', () => {
  const input = {
    id: 42,
    ok: true,
    nothing: null,
    note: 'mail dana@example.com or call 9876543210',
    user: {
      email: 'a@b.co',
      firebaseUid: 'fb_123',
      name: 'Dana',
      tags: ['https://x.example/?token=abc123', 'plain'],
    },
    amounts: [11946, '302.00'],
    Password: 'hunter2',
    upiId: 'someone@upi',
    nested: { apiKey: 'k', secret: null, count: 3 },
  };
  const before = structuredClone(input);

  const out = redactValue(input);

  assert.deepEqual(out, {
    id: 42,
    ok: true,
    nothing: null,
    note: 'mail [email] or call [phone]',
    user: {
      email: '[redacted]',
      firebaseUid: '[redacted]',
      name: 'Dana',
      tags: ['https://x.example/?token=[redacted]', 'plain'],
    },
    amounts: [11946, '302.00'],
    Password: '[redacted]',
    upiId: '[redacted]',
    nested: { apiKey: '[redacted]', secret: null, count: 3 },
  });
  assert.deepEqual(input, before);
  assert.notEqual(out, input);
  assert.notEqual(out.user, input.user);
});

test('redactValue: normalized sensitive field names are redacted', () => {
  assert.deepEqual(redactValue({ phoneNumber: '+1 415 555 2671', access_token: 'opaque-token', client_secret: 'secret-value' }), {
    phoneNumber: '[redacted]',
    access_token: '[redacted]',
    client_secret: '[redacted]',
  });
});

test('initials: two words give first letter of each', () => {
  assert.equal(initials('Dana Hart'), 'D.H.');
});

test('initials: single lowercase word uppercased', () => {
  assert.equal(initials('abhay'), 'A.');
});

test('initials: empty, whitespace, null and undefined give ?', () => {
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
  assert.equal(initials(null), '?');
  assert.equal(initials(undefined), '?');
});

test('initials: at most three words', () => {
  assert.equal(initials('mary ann jane doe'), 'M.A.J.');
  assert.equal(initials('  lowercase   names '), 'L.N.');
});
