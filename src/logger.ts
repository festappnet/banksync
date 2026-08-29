type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

const REDACTED_KEYS_RE = /^(secret|.*_secret|.*token.*|.*cipher.*|fio_secret|webhook_kek|encryption_key|.*encryption.*key.*|.*_kek|.*_key|raw_email)$/i;
const ALLOW_LIST_KEYS = new Set(['secret_prefix', 'api_token_prefix', 'fio_token_prefix']);

function redactValue(value: LogValue, visited: Set<unknown>): LogValue {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (visited.has(value)) {
    return value;
  }

  visited.add(value);

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, visited));
  }

  const redactedObj: { [key: string]: LogValue } = {};
  for (const [key, val] of Object.entries(value)) {
    if (REDACTED_KEYS_RE.test(key) && !ALLOW_LIST_KEYS.has(key)) {
      redactedObj[key] = '[REDACTED]';
    } else {
      redactedObj[key] = redactValue(val, visited);
    }
  }

  return redactedObj;
}

function redact(data: Record<string, LogValue>): Record<string, LogValue> {
  const visited = new Set<unknown>();
  const redactedObj: Record<string, LogValue> = {};
  for (const [key, val] of Object.entries(data)) {
    if (REDACTED_KEYS_RE.test(key) && !ALLOW_LIST_KEYS.has(key)) {
      redactedObj[key] = '[REDACTED]';
    } else {
      redactedObj[key] = redactValue(val, visited);
    }
  }
  return redactedObj;
}

export function log(event: string, data?: Record<string, LogValue>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...redact(data ?? {}),
    })
  );
}

export function logError(event: string, err: unknown, data?: Record<string, LogValue>): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      error: String(err),
      ...redact(data ?? {}),
    })
  );
}
