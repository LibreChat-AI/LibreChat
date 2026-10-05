import { createHash } from 'crypto';
import { MediaPersistenceError, positiveMediaLimit as positive } from '~/utils/media';

export const terminal: string[] = ['succeeded', 'failed', 'cancelled'];

export const claimable: string[] = ['queued', 'submitting', 'running', 'ingesting', 'reconciling'];

/** Journalled acknowledgement works on standalone Mongo as well as replica sets. */
export const durable: { w: 'majority'; j: true } = { w: 'majority', j: true };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function duplicate(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
}

export function mediaDate(value: string | Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new MediaPersistenceError('invalid_input', 'Invalid media timestamp');
  }
  return date;
}

/** Bounds a title to `maxTitleChars` UTF-16 units without splitting a surrogate pair. */
export function deriveMediaThreadTitle(prompt: string, maxTitleChars: number): string {
  return prompt.slice(0, positive(maxTitleChars)).replace(/[\uD800-\uDBFF]$/, '');
}

export function cursorOf(time: string | Date, id: string): string {
  return Buffer.from(JSON.stringify([time, id])).toString('base64url');
}

export function cursorParts(cursor?: string): [string, string] | undefined {
  if (!cursor) {
    return;
  }
  try {
    const result: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (
      Array.isArray(result) &&
      result.length === 2 &&
      result.every((v) => typeof v === 'string')
    ) {
      return result as [string, string];
    }
  } catch {
    /* The same validation error applies to malformed encodings. */
  }
  throw new MediaPersistenceError('invalid_input', 'Invalid media cursor');
}
