// Redaction helpers for bug-repro output. Replacement order in redactText matters.

const SENSITIVE_KEYS = new Set([
  'phone',
  'phonenumber',
  'email',
  'token',
  'firebaseuid',
  'password',
  'accesstoken',
  'authorization',
  'clientsecret',
  'idtoken',
  'refreshtoken',
  'upiid',
  'apikey',
  'awsaccesskeyid',
  'googleaccessid',
  'secret',
]);

const POSTGRES_PASSWORD = /(\bpostgres(?:ql)?:\/\/[^\s:/@]+):[^\s@]+@/g;
const URL_PASSWORD = /(\bhttps?:\/\/[^\s:/@]+):[^\s/@]+@/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER = /\bBearer\s+[\w~+\/=\[\]-]+(?:\.[\w~+\/=\[\]-]+)*/g;
const SECRET_ASSIGNMENT = /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|password|secret)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^&,\s;"'<>]+)/gi;
const BASIC_AUTH = /(["']?Authorization["']?\s*:\s*["']?Basic\s+)[A-Za-z0-9+/=]+/gi;
const SECRET_KEY = /(?<![A-Za-z0-9_-])(?:sk-lf-|pk-lf-|sk-|sntryu_|lsv2_|ghp_|gho_|xox)[A-Za-z0-9_-]{8,}/g;
const QUERY_PARAM = /([?&](?:access_token|token|key|sig|signature|x-amz-(?:credential|signature|security-token)|x-goog-(?:credential|signature)|awsaccesskeyid|googleaccessid|key-pair-id|policy)=)[^&#\s"'<>]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_PLUS91 = /\+91(?:[ -]?\d){10}(?!\d)/g;
const PHONE_PLUS_LONG = /\+\d{11,13}(?!\d)/g;
const PHONE_PLUS_FORMATTED = /\+(?:\d[ .()-]?){8,15}(?!\d)/g;
const PHONE_US_FORMATTED = /(?<!\d)(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-][2-9]\d{2}[ .-]\d{4}(?!\d)/g;
const PHONE_LOCAL = /(?<![\w.-])[6-9]\d{9}(?![\w-]|\.\d)/g;

export function redactText(s: string): string {
  return s
    .replace(POSTGRES_PASSWORD, '$1:[redacted]@')
    .replace(URL_PASSWORD, '$1:[redacted]@')
    .replace(JWT, '[jwt]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(BASIC_AUTH, '$1[redacted]')
    .replace(SECRET_ASSIGNMENT, (_match, key: string, value: string) => {
      if (value.startsWith('"')) return `${key}"[redacted]${value.endsWith('"') ? '"' : ''}`;
      if (value.startsWith("'")) return `${key}'[redacted]${value.endsWith("'") ? "'" : ''}`;
      return `${key}[redacted]`;
    })
    .replace(SECRET_KEY, '[secret]')
    .replace(QUERY_PARAM, '$1[redacted]')
    .replace(EMAIL, '[email]')
    .replace(PHONE_PLUS91, '[phone]')
    .replace(PHONE_PLUS_LONG, '[phone]')
    .replace(PHONE_PLUS_FORMATTED, '[phone]')
    .replace(PHONE_US_FORMATTED, '[phone]')
    .replace(PHONE_LOCAL, '[phone]');
}

export function redactValue<T>(v: T): T {
  return walk(v, 0) as T;
}

function walk(v: unknown, depth: number): unknown {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (depth < 3 && (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"{') || trimmed.startsWith('"['))) {
      try {
        const parsed = JSON.parse(v) as unknown;
        return JSON.stringify(walk(parsed, depth + 1));
      } catch {
        // Truncated JSON is still handled by the text patterns below.
      }
    }
    return redactText(v);
  }
  if (Array.isArray(v)) return v.map((item) => walk(item, depth));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const normalizedKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      const sensitive = SENSITIVE_KEYS.has(normalizedKey) && val !== null && val !== undefined;
      out[redactText(k)] = sensitive ? '[redacted]' : walk(val, depth);
    }
    return out;
  }
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
  if (words.length === 0) return '?';
  return words.map((w) => `${w.charAt(0).toUpperCase()}.`).join('');
}
