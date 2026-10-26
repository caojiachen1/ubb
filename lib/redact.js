// Sensitive-data redaction for tool results and URLs.

const SENSITIVE_KEY =
  /^(pass(word|wd)?|secret|token|cookie|cookies|authorization|auth|credentials?|credential|api[-_]?key|jwt|bearer|otp|access[-_]?key|private[-_]?key)$/i;
const SENSITIVE_KEY_PART =
  /(password|secret|token|cookie|authorization|credential|api[-_]?key|sessionid)/i;
const SENSITIVE_QUERY_PARAM = /(token|key|secret|pass(word)?|auth|code|sig|signature|session)/i;
const MAX_DEPTH = 8;

/** Deep-clone a JSON-ish value, replacing values of sensitive keys with "[redacted]". */
export function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k) || SENSITIVE_KEY_PART.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Mask sensitive query parameters in a URL string. */
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM.test(key)) u.searchParams.set(key, '[redacted]');
    }
    return u.href;
  } catch {
    return url;
  }
}

/** Truncate a string to maxChars with an explicit marker. */
export function truncate(text, maxChars = 60_000) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} chars]`;
}
