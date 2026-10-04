/**
 * Order-independent value canonicalization for identity hashing.
 *
 * Two structurally equivalent values must serialize to the same string
 * regardless of key insertion order, so a digest taken over the result
 * changes only when the value's *meaning* changes. Used by the agent
 * context fingerprint and by the OpenAI prompt-cache key.
 */
export function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, seen)).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (seen.has(value)) {
    throw new TypeError('Cannot canonicalize a value containing circular references');
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  /**
   * Null-prototype: a key named `__proto__` assigned onto an ordinary object
   * invokes the legacy prototype setter instead of becoming an own property,
   * so a schema carrying that field would vanish from the digest and hash like
   * one without it.
   */
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const item = canonicalize(record[key], seen);
    if (item !== undefined) {
      normalized[key] = item;
    }
  }
  seen.delete(value);
  return normalized;
}
