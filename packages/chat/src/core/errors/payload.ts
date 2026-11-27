import { alternateName } from 'librechat-data-provider';

/** A value as `JSON.parse` produces it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | ErrorPayload;

/** A parsed error payload. Producers are free-form, so every field is read defensively. */
export type ErrorPayload = { [key: string]: JsonValue | undefined };

/**
 * Provider error codes that are not LibreChat's own. They reach the client when a provider's error
 * body is persisted as the message text, which is also why they are plain strings rather than
 * `ErrorTypes` members.
 */
export const ProviderErrorCodes = {
  INVALID_API_KEY: 'invalid_api_key',
  INSUFFICIENT_QUOTA: 'insufficient_quota',
} as const;

export function readString(json: ErrorPayload | undefined, key: string): string | undefined {
  const value = json?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNumber(json: ErrorPayload | undefined, key: string): number | undefined {
  const value = json?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  /** Limiter payloads cross the wire as JSON, but a stored `max` may be a numeric string. */
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function readObject(json: ErrorPayload | undefined, key: string): ErrorPayload | undefined {
  const value = json?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** The name a reader recognizes for an endpoint id. */
export function getProviderName(endpoint: string): string {
  return (alternateName as Record<string, string | undefined>)[endpoint] ?? endpoint;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Formats a stored timestamp in the reader's locale. Only epoch milliseconds and ISO 8601 strings
 * are parsed: rows persisted by older servers carry an expiry in the server's own locale format,
 * which another locale can misread (a day-first date read month-first), so any other string is
 * shown as persisted.
 */
export function formatTimestamp(value: string | number): string {
  if (typeof value === 'string' && !isoTimestamp.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

/** `m:ss`, or `h:mm:ss` past an hour — the shape a countdown is read in. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
