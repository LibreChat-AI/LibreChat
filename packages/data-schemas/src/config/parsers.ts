import { klona } from 'klona';
import winston from 'winston';
import type { TraverseContext } from '../utils/object-traverse';
import { appendLogContext } from './requestLogContext';
import { SYSTEM_TENANT_ID } from './tenantContext';
import traverse from '../utils/object-traverse';

const SPLAT_SYMBOL = Symbol.for('splat');
const MESSAGE_SYMBOL = Symbol.for('message');
const CONSOLE_JSON_STRING_LENGTH: number =
  parseInt(process.env.CONSOLE_JSON_STRING_LENGTH || '', 10) || 255;
const DEBUG_MESSAGE_LENGTH: number = parseInt(process.env.DEBUG_MESSAGE_LENGTH || '', 10) || 150;
const REDACTED_VALUE = '[REDACTED]';
const REDACTION_TRUNCATED_KEY = '__redaction_truncated__';
const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_ENTRIES = 50;
/**
 * Objects one log record may visit while redacting, so a broad payload cannot stall the event loop.
 * Env-only like CONSOLE_JSON_STRING_LENGTH: the logger is built at import, before librechat.yaml loads.
 */
const MAX_REDACTION_NODES: number = parseInt(process.env.LOG_REDACTION_MAX_NODES || '', 10) || 5000;
let redactionNodeBudget = Number.POSITIVE_INFINITY;
const DEFAULT_REDACTION_STRING_LENGTH = 8192;
const MAX_REDACTION_STRING_LENGTH = Math.max(
  CONSOLE_JSON_STRING_LENGTH,
  DEFAULT_REDACTION_STRING_LENGTH,
);
const MAX_REDACTION_BUFFER_BYTES = MAX_REDACTION_STRING_LENGTH;

const HEAVY_ERROR_KEYS = new Set<string>([
  'httpsAgent',
  'httpAgent',
  'agent',
  'socket',
  'sockets',
  '_httpMessage',
  '_httpAgent',
  'parser',
  '_tlsOptions',
  '_handle',
  'ssl',
]);
const AXIOS_ONLY_HEAVY_KEYS = new Set<string>(['config', 'request']);
const MAX_STRIP_DEPTH = 6;
const PRESERVED_ERROR_PROPS = ['message', 'stack', 'name', 'code'] as const;

const sensitiveKeys: RegExp[] = [
  /\b(sk-)[a-zA-Z0-9_-]+/g, // OpenAI API key pattern
  /\b(Bearer )[^\s"']+/g, // Header: Bearer token pattern
  /\b(api-key:? )[^\s"']+/gi, // Header: API key pattern
  /\b(api_key=)[^\s"'&]+/gi, // URL query param: API key pattern
  /\b(key=)[^\s"'&]+/g, // URL query param: sensitive key pattern
  /(\b(?:access_token|appid|assertion|client_assertion|client_secret|code|code_verifier|credential|id_token|refresh_token|sig|signature|x-amz-security-token|x-amz-signature|x-goog-signature)\b"?\s*:\s*")(?:\\.|[^"\\])*/gi,
  /\b((?:access_token|appid|assertion|client_assertion|client_secret|code|code_verifier|credential|id_token|refresh_token|sig|signature|x-amz-security-token|x-amz-signature|x-goog-signature)=)[^\s"'&]+/gi,
  /(\b)eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]+/g,
  /\b((?:Proxy-)?Authorization:\s*)[^\r\n]+/gi,
  /\b((?:Cookie|Set-Cookie):\s*)[^\r\n]+/gi,
  /(:\/\/)[^/\s:@]*:[^/\s@]+(?=@)/g,
];

/**
 * Matches a whole delimiter-bounded token that holds an address. The lookbehind lets the scan start
 * only at a token boundary, so long non-email text is scanned once instead of once per character.
 */
const EMAIL_PATTERN =
  /(?:(?<!\\)\\"(?:[^"\\\r\n]|\\{3}"|\\{4}|\\{2}(?!\\)|\\[bfnrt/]|\\u[0-9a-fA-F]{4})*\\"|(?<!\\)"(?:[^"\\\r\n]|\\.)*"|(?<![^\s<>[\],;"])[^\s<>[\],;"]+)@(?:\[[^\]\s@]+\]|[^\s<>[\],;"@]+\.[^\s<>[\],;"@]+)/gu;
/** Set while redacting splat arguments at levels whose later format strips heavy error fields. */
let skipHeavyErrorFields = false;
/** URL-encoded addresses (`user%40host.tld`), anchored at a token start so scans stay linear. */
const ENCODED_EMAIL_PATTERN =
  /(?<![^\s<>"&=?/#])(?:(?!%(?:25)*40)[^\s<>"&=?/#])+%(?:25)*40[^\s<>"&=?/#]+(?:\.|%(?:25)*2e)[^\s<>"&=?/#]+/giu;
const REDACTION_WINDOW_SLACK = 1024;
const REDACTED_EMAIL_VALUE = '[REDACTED_EMAIL]';

const sensitiveMetadataKey =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|appid|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|assertion|client[-_]?assertion|client[-_]?secret|code[-_]?verifier|credential|signature|connection[-_]?string)$/i;
const errorStringProperties = new Set(['name', 'message', 'stack']);

/**
 * Redacts sensitive information from a console message and trims it to a specified length if provided.
 * @param str - The console message to be redacted.
 * @param trimLength - The optional length at which to trim the redacted message.
 * @returns The redacted and optionally trimmed console message.
 */
function redactMessage(str: string, trimLength?: number): string {
  if (!str) {
    return '';
  }

  const redacted = sensitiveKeys
    .reduce((currentMessage, pattern) => currentMessage.replace(pattern, '$1[REDACTED]'), str)
    .replace(EMAIL_PATTERN, REDACTED_EMAIL_VALUE)
    .replace(ENCODED_EMAIL_PATTERN, REDACTED_EMAIL_VALUE);

  if (trimLength !== undefined && redacted.length > trimLength) {
    return `${redacted.substring(0, trimLength)}...`;
  }

  return redacted;
}

/** Whitespace and angle brackets only: commas, quotes and brackets can sit inside one token. */
const EMAIL_TOKEN_DELIMITER = /[\s<>]/u;
/** Completed addresses and escaped (serialized) quotes are skipped; only a lone plain quote is counted. */
const QUOTE_OR_ADDRESS =
  /\\"(?:[^"\\\r\n]|\\{3}"|\\{4}|\\{2}(?!\\)|\\[bfnrt/]|\\u[0-9a-fA-F]{4})*\\"@|\\"|"(?:[^"\\\r\n]|\\.)*"@|"/gu;

/** Drops a token cut by the window edge: its terminator is unseen, so no pattern could match it. */
function trimUnfinishedToken(full: string, window: string): string {
  if (window.length === full.length) {
    return window;
  }
  let end = window.length;
  if (!EMAIL_TOKEN_DELIMITER.test(full[end])) {
    while (end > 0 && !EMAIL_TOKEN_DELIMITER.test(window[end - 1])) {
      end--;
    }
  }
  const trimmed = window.substring(0, end);
  let quotes = 0;
  let lastOpen = -1;
  for (const match of trimmed.matchAll(QUOTE_OR_ADDRESS)) {
    if (match[0] === '"') {
      quotes++;
      lastOpen = match.index;
    }
  }
  /** An odd count of quotes outside completed addresses means the cut fell inside a quoted local. */
  return quotes % 2 === 1 ? trimmed.substring(0, lastOpen) : trimmed;
}

function redactLogString(str: string): string {
  /** A string costs one node plus one per 512 scanned characters, so wide payloads stay bounded. */
  redactionNodeBudget -= 1 + Math.floor(Math.min(str.length, MAX_REDACTION_STRING_LENGTH) / 512);
  if (redactionNodeBudget < 0) {
    return REDACTED_VALUE;
  }
  if (str.length <= MAX_REDACTION_STRING_LENGTH) {
    return redactMessage(str);
  }

  /**
   * Redacts a bounded window past the cutoff before cutting, so an address that straddles the limit
   * is matched whole. The unfinished token at the window edge is dropped rather than kept unmatched.
   */
  const window = trimUnfinishedToken(
    str,
    str.substring(0, MAX_REDACTION_STRING_LENGTH + REDACTION_WINDOW_SLACK),
  );
  const redacted = redactMessage(window);
  const kept = redacted.substring(0, MAX_REDACTION_STRING_LENGTH);
  return `${kept}... [truncated ${str.length - kept.length} chars]`;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `cursors` remembers the next free suffix per base so many colliding keys stay linear. */
function redactLogKey(
  key: string,
  isUsed: (candidate: string) => boolean,
  cursors: Map<string, number>,
): string {
  const base = /@|%(?:25)*40/i.test(key) ? redactLogString(key) : key;
  let candidate = base;
  let suffix = cursors.get(base) ?? 2;
  while (isUsed(candidate)) {
    candidate = `${base}#${suffix}`;
    suffix++;
  }
  if (candidate !== base) {
    cursors.set(base, suffix);
  }
  return candidate;
}

function isSensitiveMetadataKey(key: string): boolean {
  return sensitiveMetadataKey.test(key);
}

function redactRecordValue(
  key: string,
  value: unknown,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  return isSensitiveMetadataKey(key) ? REDACTED_VALUE : redactLogValue(value, seen, depth);
}

function defineRedactedErrorProperty(
  error: Error & Record<string, unknown>,
  key: 'name' | 'message' | 'stack',
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }

  Object.defineProperty(error, key, {
    value: redactLogString(value),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function defineRedactedDescriptor(
  target: Error & Record<string, unknown>,
  key: string | symbol,
  descriptor: PropertyDescriptor,
  seen: WeakMap<object, unknown>,
  depth: number,
  targetKey: string | symbol = key,
): void {
  if (!('value' in descriptor)) {
    Object.defineProperty(target, targetKey, descriptor);
    return;
  }

  Object.defineProperty(target, targetKey, {
    ...descriptor,
    value:
      typeof key === 'string'
        ? redactRecordValue(key, descriptor.value, seen, depth)
        : redactLogValue(descriptor.value, seen, depth),
  });
}

function redactErrorValue(error: Error, seen: WeakMap<object, unknown>, depth: number): Error {
  const redacted = Object.create(Object.getPrototypeOf(error)) as Error & Record<string, unknown>;
  seen.set(error, redacted);
  const cursors = new Map<string, number>();
  neutralizeSerializer(redacted);

  defineRedactedErrorProperty(redacted, 'name', error.name);
  defineRedactedErrorProperty(redacted, 'message', error.message);
  defineRedactedErrorProperty(redacted, 'stack', error.stack);

  Reflect.ownKeys(error).forEach((key) => {
    if (typeof key === 'string' && (errorStringProperties.has(key) || key === 'toJSON')) {
      return;
    }
    let descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined) {
      return;
    }
    if (descriptor.enumerable && descriptor.get !== undefined) {
      /** An enumerable getter is serialized by value, so it is materialized and redacted like data. */
      try {
        descriptor = {
          value: descriptor.get.call(error),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      } catch {
        return;
      }
    }
    if (skipHeavyErrorFields && typeof key === 'string') {
      const isAxios = readsTrue(error as unknown as Record<string, unknown>, 'isAxiosError');
      if (isAxios && key === 'config') {
        const compact = safelyCompact(descriptor.value);
        if (compact !== undefined) {
          defineRedactedDescriptor(
            redacted,
            key,
            { ...descriptor, value: compact },
            seen,
            depth + 1,
          );
        }
        return;
      }
      if (HEAVY_ERROR_KEYS.has(key) || (isAxios && AXIOS_ONLY_HEAVY_KEYS.has(key))) {
        return;
      }
    }
    const targetKey =
      typeof key === 'string'
        ? redactLogKey(key, (c) => Object.prototype.hasOwnProperty.call(redacted, c), cursors)
        : key;
    defineRedactedDescriptor(redacted, key, descriptor, seen, depth + 1, targetKey);
  });
  return redacted;
}

function isBufferValue(value: object): value is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(value);
}

function getJsonValue(value: object): unknown {
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON !== 'function') {
      return undefined;
    }

    const jsonValue = toJSON.call(value);
    return jsonValue === value ? undefined : jsonValue;
  } catch {
    return undefined;
  }
}

function getCustomStringValue(value: object): string | undefined {
  const toString = (value as { toString?: unknown }).toString;
  if (typeof toString !== 'function' || toString === Object.prototype.toString) {
    return undefined;
  }

  try {
    const stringValue = toString.call(value);
    return typeof stringValue === 'string' ? stringValue : undefined;
  } catch {
    return undefined;
  }
}

function redactMapValue(
  value: Map<unknown, unknown>,
  seen: WeakMap<object, unknown>,
  depth: number,
): Map<unknown, unknown> {
  const redacted = new Map<unknown, unknown>();
  const cursors = new Map<string, number>();
  seen.set(value, redacted);
  let count = 0;
  for (const [mapKey, mapValue] of value) {
    if (count >= MAX_REDACTION_ENTRIES) {
      redacted.set(REDACTION_TRUNCATED_KEY, 'Additional map entries omitted');
      break;
    }
    const safeKey =
      typeof mapKey === 'string'
        ? redactLogKey(mapKey, (candidate) => redacted.has(candidate), cursors)
        : redactLogValue(mapKey, seen, depth + 1);
    redacted.set(
      safeKey,
      typeof mapKey === 'string'
        ? redactRecordValue(mapKey, mapValue, seen, depth + 1)
        : redactLogValue(mapValue, seen, depth + 1),
    );
    count += 1;
  }
  return redacted;
}

function redactSetValue(
  value: Set<unknown>,
  seen: WeakMap<object, unknown>,
  depth: number,
): Set<unknown> {
  const redacted = new Set<unknown>();
  seen.set(value, redacted);
  let count = 0;
  for (const setValue of value) {
    if (count >= MAX_REDACTION_ENTRIES) {
      redacted.add('Additional set values omitted');
      break;
    }
    redacted.add(redactLogValue(setValue, seen, depth + 1));
    count += 1;
  }
  return redacted;
}

/** Shadows an inherited `toJSON` with an inert own property so no hook runs after redaction. */
function neutralizeSerializer(target: object): boolean {
  let hooked = true;
  try {
    hooked = typeof (target as { toJSON?: unknown }).toJSON === 'function';
  } catch {
    /* a throwing getter is treated as a hook and shadowed below */
  }
  if (!hooked) {
    return true;
  }
  try {
    Object.defineProperty(target, 'toJSON', {
      value: undefined,
      enumerable: false,
      configurable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function safely(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

function safelyCompact(config: unknown): Record<string, unknown> | undefined {
  try {
    return compactRequestInfo(config);
  } catch {
    return undefined;
  }
}

function readsTrue(record: Record<string | symbol, unknown>, key: string): boolean {
  return safely(() => record[key] === true);
}

function readField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return '[Unreadable]';
  }
}

function redactObjectEntries(
  value: object,
  seen: WeakMap<object, unknown>,
  depth: number,
): Record<string, unknown> | undefined {
  const record = value as Record<string, unknown>;
  let redacted: Record<string, unknown> | undefined;
  const cursors = new Map<string, number>();
  let count = 0;

  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    if (redacted === undefined) {
      redacted = {};
      seen.set(value, redacted);
    }
    /** A serialization hook would run after redaction and could re-emit the raw values. */
    if (key === 'toJSON') {
      continue;
    }
    if (count >= MAX_REDACTION_ENTRIES) {
      redacted[REDACTION_TRUNCATED_KEY] = 'Additional object properties omitted';
      break;
    }
    redacted[
      redactLogKey(
        key,
        (candidate) => Object.prototype.hasOwnProperty.call(redacted, candidate),
        cursors,
      )
    ] = redactRecordValue(key, readField(record, key), seen, depth + 1);
    count += 1;
  }

  return redacted;
}

function redactNonPlainValue(
  value: object,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  if (isBufferValue(value)) {
    return value.length > MAX_REDACTION_BUFFER_BYTES
      ? `[REDACTED Buffer ${value.length} bytes]`
      : redactLogString(value.toString('utf8'));
  }

  if (value instanceof URL || value instanceof URLSearchParams) {
    return redactLogString(value.toString());
  }

  if (value instanceof Map) {
    return redactMapValue(value, seen, depth);
  }

  if (value instanceof Set) {
    return redactSetValue(value, seen, depth);
  }

  const jsonValue = getJsonValue(value);
  if (jsonValue !== undefined) {
    return redactLogValue(jsonValue, seen, depth + 1);
  }

  const redactedEntries = redactObjectEntries(value, seen, depth);
  if (redactedEntries !== undefined) {
    return redactedEntries;
  }

  const stringValue = getCustomStringValue(value);
  return stringValue !== undefined ? redactLogString(stringValue) : value;
}

function redactLogValue(value: unknown, seen = new WeakMap<object, unknown>(), depth = 0): unknown {
  if (typeof value === 'string') {
    return redactLogString(value);
  }

  /** A function's `toString`/`toJSON` would run after redaction, so only a marker is kept. */
  if (typeof value === 'function') {
    return '[Function]';
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached;
  }

  if (depth >= MAX_REDACTION_DEPTH || redactionNodeBudget-- <= 0) {
    return REDACTED_VALUE;
  }

  try {
    return redactObjectValue(value, seen, depth);
  } catch {
    /* revoked proxies and throwing traps must not abort the log call */
    return '[Unreadable]';
  }
}

function redactObjectValue(value: object, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (Array.isArray(value)) {
    const redacted: unknown[] = [];
    seen.set(value, redacted);
    const length = Math.min(value.length, MAX_REDACTION_ENTRIES);
    for (let index = 0; index < length; index++) {
      redacted.push(redactLogValue(value[index], seen, depth + 1));
    }
    if (value.length > MAX_REDACTION_ENTRIES) {
      redacted.push('Additional array values omitted');
    }
    return redacted;
  }

  if (value instanceof Error) {
    return redactErrorValue(value, seen, depth);
  }

  if (!isPlainRecord(value)) {
    return redactNonPlainValue(value, seen, depth);
  }

  return redactObjectEntries(value, seen, depth) ?? {};
}

/** Writes a redacted field back; returns false when a read-only property refuses the write. */
function setLogField(
  target: Record<string, unknown>,
  key: string,
  safeKey: string,
  value: unknown,
): boolean {
  let removed = true;
  try {
    if (safeKey !== key) {
      removed = Reflect.deleteProperty(target, key);
    }
    target[safeKey] = value;
    return removed;
  } catch {
    try {
      Object.defineProperty(target, safeKey, { value, configurable: true, writable: true });
    } catch {
      /* handled by the caller through the false return */
    }
    return false;
  }
}

/** Rebuilds the record as a plain writable copy when some field could not be replaced in place. */
function sanitizedCopy(
  info: Record<string | symbol, unknown>,
  fields: Record<string, unknown>,
  stack: string | undefined,
  message: unknown,
): winston.Logform.TransformableInfo {
  const copy: Record<string | symbol, unknown> = {};
  for (const symbol of Object.getOwnPropertySymbols(info)) {
    copy[symbol] = info[symbol];
  }
  copy.level = info.level;
  copy.message = message;
  if (stack !== undefined) {
    copy.stack = stack;
  }
  return Object.assign(copy, fields) as winston.Logform.TransformableInfo;
}

/**
 * Redacts sensitive information from log messages at every level.
 * Note: Intentionally mutates the object.
 * @param info - The log information object.
 * @returns The modified log information object.
 */
const redactFormat: winston.Logform.FormatWrap = winston.format(
  (info: winston.Logform.TransformableInfo) => {
    const infoRecord = info as Record<string | symbol, unknown>;
    const stripsHeavyFields = info.level === 'error' || info.level === 'warn';
    const outerBudget = redactionNodeBudget;
    redactionNodeBudget = MAX_REDACTION_NODES;
    const topSeen = new WeakMap<object, unknown>();
    const skipsHeavyTopLevel = stripsHeavyFields && safely(() => isErrorLike(info));

    let redactedMessage: unknown;
    let replaceFailed = false;
    let rawMessage: unknown;
    try {
      rawMessage = info.message;
    } catch {
      rawMessage = '[Unreadable]';
      replaceFailed = true;
    }
    if (rawMessage !== undefined) {
      redactedMessage = redactLogValue(rawMessage);
      if (Object.getOwnPropertyDescriptor(info, 'message')?.get !== undefined) {
        replaceFailed = true;
      }
      try {
        info.message = redactedMessage as string;
      } catch {
        replaceFailed = true;
      }
    }

    /** A direct `logger.error(error)` makes `info` the Error, whose stack is non-enumerable. */
    let redactedStack: string | undefined;
    let rawStack: unknown;
    try {
      rawStack = infoRecord.stack;
    } catch {
      rawStack = undefined;
      replaceFailed = true;
    }
    if (typeof rawStack === 'string') {
      redactedStack = redactLogString(rawStack);
      if (Object.getOwnPropertyDescriptor(info, 'stack')?.get !== undefined) {
        replaceFailed = true;
      }
      try {
        infoRecord.stack = redactedStack;
      } catch {
        replaceFailed = true;
      }
    }

    const symbolValue = infoRecord[MESSAGE_SYMBOL];
    if (symbolValue !== undefined) {
      infoRecord[MESSAGE_SYMBOL] = redactLogValue(symbolValue);
    }

    if (infoRecord[SPLAT_SYMBOL] !== undefined) {
      skipHeavyErrorFields = stripsHeavyFields;
      try {
        infoRecord[SPLAT_SYMBOL] = redactLogValue(infoRecord[SPLAT_SYMBOL]);
      } finally {
        skipHeavyErrorFields = false;
      }
    }

    const cursors = new Map<string, number>();
    const fields: Record<string, unknown> = {};
    const isAxios = readsTrue(infoRecord, 'isAxiosError');
    for (const key of Object.keys(info)) {
      if (key === 'message' || key === 'level') {
        continue;
      }
      if (key === 'toJSON') {
        if (!Reflect.deleteProperty(info, key)) {
          replaceFailed = true;
        }
        continue;
      }
      /** Past the budget, further top-level fields are dropped rather than scanned. */
      if (redactionNodeBudget-- <= 0) {
        if (!Reflect.deleteProperty(info, key)) {
          replaceFailed = true;
        }
        continue;
      }
      /**
       * `stripHeavyErrorFields` drops these later. Cloning the graph here would only burn time, and
       * leaving the raw value would depend on that later pass succeeding, so the field is replaced
       * by its redacted compact form (or removed) now.
       */
      if (
        skipsHeavyTopLevel &&
        (HEAVY_ERROR_KEYS.has(key) || (isAxios && AXIOS_ONLY_HEAVY_KEYS.has(key)))
      ) {
        const compact =
          isAxios && key === 'config' ? safelyCompact(readField(infoRecord, key)) : undefined;
        if (compact !== undefined) {
          fields[key] = compact;
          if (!setLogField(infoRecord, key, key, compact)) {
            replaceFailed = true;
          }
        } else if (!Reflect.deleteProperty(info, key)) {
          replaceFailed = true;
        }
        continue;
      }
      /** An accessor keeps serving its original value after assignment, so the record is rebuilt. */
      if (Object.getOwnPropertyDescriptor(info, key)?.get !== undefined) {
        replaceFailed = true;
      }
      let raw: unknown;
      try {
        raw = infoRecord[key];
      } catch {
        raw = '[Unreadable]';
      }
      const value = redactRecordValue(key, raw, topSeen, 0);
      const safeKey = redactLogKey(
        key,
        (candidate) => candidate !== key && Object.prototype.hasOwnProperty.call(info, candidate),
        cursors,
      );
      fields[safeKey] = value;
      if (!setLogField(infoRecord, key, safeKey, value)) {
        replaceFailed = true;
      }
    }
    redactionNodeBudget = outerBudget;
    if (!neutralizeSerializer(info)) {
      replaceFailed = true;
    }
    return replaceFailed ? sanitizedCopy(infoRecord, fields, redactedStack, redactedMessage) : info;
  },
);

/**
 * Truncates long strings, especially base64 image data, within log messages.
 *
 * @param value - The value to be inspected and potentially truncated.
 * @param length - The length at which to truncate the value. Default: 100.
 * @returns The truncated or original value.
 */
const truncateLongStrings = (value: unknown, length = 100): unknown => {
  if (typeof value === 'string') {
    return value.length > length ? value.substring(0, length) + '... [truncated]' : value;
  }

  return value;
};

/**
 * An array mapping function that truncates long strings (objects converted to JSON strings).
 * @param item - The item to be condensed.
 * @returns The condensed item.
 */
const condenseArray = (item: unknown): string | unknown => {
  if (typeof item === 'string') {
    return truncateLongStrings(JSON.stringify(item));
  } else if (typeof item === 'object') {
    return truncateLongStrings(JSON.stringify(item));
  }
  return item;
};

/**
 * Formats log messages for debugging purposes.
 * - Truncates long strings within log messages.
 * - Condenses arrays by truncating long strings and objects as strings within array items.
 * - Message redaction is applied by redactFormat before this formatter.
 * - Converts log information object to a formatted string.
 *
 * @param options - The options for formatting log messages.
 * @returns The formatted log message.
 */
const debugTraverse: winston.Logform.Format = winston.format.printf(
  ({ level, message, timestamp, ...metadata }: Record<string, unknown>) => {
    if (!message) {
      return `${timestamp} ${level}`;
    }

    // Type-safe version of the CJS logic: !message?.trim || typeof message !== 'string'
    if (typeof message !== 'string' || !message.trim) {
      return `${timestamp} ${level}: ${JSON.stringify(message)}`;
    }

    const msgParts: string[] = [
      `${timestamp} ${level}: ${truncateLongStrings(message.trim(), DEBUG_MESSAGE_LENGTH)}`,
    ];

    try {
      if (level !== 'debug') {
        return appendLogContext(msgParts[0], metadata);
      }

      if (!metadata) {
        return msgParts[0];
      }

      // Type-safe access to SPLAT_SYMBOL using bracket notation
      const metadataRecord = metadata as Record<string | symbol, unknown>;
      const splatArray = metadataRecord[SPLAT_SYMBOL];
      const debugValue = Array.isArray(splatArray) ? splatArray[0] : undefined;

      if (!debugValue) {
        return appendLogContext(msgParts[0], metadata);
      }

      if (debugValue && Array.isArray(debugValue)) {
        msgParts.push(`\n${JSON.stringify(debugValue.map(condenseArray))}`);
        return appendLogContext(msgParts.join(''), metadata);
      }

      if (typeof debugValue !== 'object') {
        msgParts.push(` ${debugValue}`);
        return appendLogContext(msgParts.join(''), metadata);
      }

      msgParts.push('\n{');

      const copy = klona(metadata);
      if (copy.tenantId === SYSTEM_TENANT_ID) {
        delete copy.tenantId;
      }
      try {
        const traversal = traverse(copy);
        traversal.forEach(function (this: TraverseContext, value: unknown) {
          if (typeof this?.key === 'symbol') {
            return;
          }

          let _parentKey = '';
          const parent = this.parent;

          if (typeof parent?.key !== 'symbol' && parent?.key !== undefined) {
            _parentKey = String(parent.key);
          }

          const parentKey = `${parent && parent.notRoot ? _parentKey + '.' : ''}`;
          const tabs = `${parent && parent.notRoot ? '    ' : '  '}`;
          const currentKey = this?.key ?? 'unknown';

          if (this.isLeaf && typeof value === 'string') {
            const truncatedText = truncateLongStrings(value);
            msgParts.push(`\n${tabs}${parentKey}${currentKey}: ${JSON.stringify(truncatedText)},`);
          } else if (this.notLeaf && Array.isArray(value) && value.length > 0) {
            const currentMessage = `\n${tabs}// ${value.length} ${String(currentKey).replace(/s$/, '')}(s)`;
            this.update(currentMessage);
            msgParts.push(currentMessage);
            const stringifiedArray = value.map(condenseArray);
            msgParts.push(`\n${tabs}${parentKey}${currentKey}: [${stringifiedArray}],`);
          } else if (this.isLeaf && typeof value === 'function') {
            msgParts.push(`\n${tabs}${parentKey}${currentKey}: function,`);
          } else if (this.isLeaf) {
            msgParts.push(`\n${tabs}${parentKey}${currentKey}: ${value},`);
          }
        });
      } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        msgParts.push(`\n[LOGGER TRAVERSAL ERROR] ${errorMessage}`);
      }

      msgParts.push('\n}');
      return msgParts.join('');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      msgParts.push(`\n[LOGGER PARSING ERROR] ${errorMessage}`);
      return msgParts.join('');
    }
  },
);

const isErrorLike = (value: object): boolean => {
  if (value instanceof Error) {
    return true;
  }
  const record = value as Record<string, unknown>;
  if (record.isAxiosError === true) {
    return true;
  }
  if (typeof record.stack === 'string') {
    return true;
  }
  return typeof record.name === 'string' && record.name.endsWith('Error');
};

const compactRequestInfo = (config: unknown): { method?: unknown; url?: unknown } | undefined => {
  if (config == null || typeof config !== 'object') {
    return undefined;
  }
  const { method, url } = config as Record<string, unknown>;
  if (method === undefined && url === undefined) {
    return undefined;
  }
  return { method: redactLogValue(method), url: redactLogValue(url) };
};

const compactResponse = (response: unknown): Record<string, unknown> | undefined => {
  if (response == null || typeof response !== 'object') {
    return undefined;
  }
  const { status, statusText, headers, data } = response as Record<string, unknown>;
  return { status, statusText, headers, data };
};

const sanitizeErrorNode = (node: Record<string, unknown>): Record<string, unknown> => {
  const sanitized: Record<string, unknown> = {};
  const nodeIsAxios = node.isAxiosError === true;

  for (const key of Object.keys(node)) {
    if (HEAVY_ERROR_KEYS.has(key) || (nodeIsAxios && AXIOS_ONLY_HEAVY_KEYS.has(key))) {
      continue;
    }
    if (nodeIsAxios && key === 'response') {
      const response = compactResponse(node.response);
      if (response !== undefined) {
        sanitized.response = response;
      }
      continue;
    }
    sanitized[key] = node[key];
  }

  if (nodeIsAxios) {
    const requestInfo = compactRequestInfo(node.config);
    if (requestInfo !== undefined) {
      sanitized.requestInfo = requestInfo;
    }
  }

  for (const key of PRESERVED_ERROR_PROPS) {
    const value = (node as Record<string, unknown>)[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
};

const stripHeavy = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (depth > MAX_STRIP_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  // Ancestor-path tracking (added on entry, removed on exit) so genuinely cyclic
  // references are caught without collapsing benign objects shared between siblings.
  seen.add(value);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => stripHeavy(item, depth + 1, seen));
  } else if (isErrorLike(value)) {
    const working = sanitizeErrorNode(value as Record<string, unknown>);
    for (const key of Object.keys(working)) {
      working[key] = stripHeavy(working[key], depth + 1, seen);
    }
    result = working;
  } else if (Object.isFrozen(value)) {
    result = value;
  } else {
    const working = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(working)) {
      working[key] = stripHeavy(working[key], depth + 1, seen);
    }
    result = working;
  }

  seen.delete(value);
  return result;
};

/**
 * Strips heavy, non-serializable fields (e.g. AxiosError `config`/`httpsAgent`,
 * sockets, TLS internals) from error-like log nodes before serialization, while
 * preserving a compact `requestInfo`, a compact `response`, and the error's
 * message/stack/name/code. Operates on copies and never mutates caller-owned objects.
 */
const stripHeavyErrorFields: winston.Logform.FormatWrap = winston.format(
  (info: winston.Logform.TransformableInfo) => {
    if (info.level !== 'error' && info.level !== 'warn') {
      return info;
    }
    try {
      const seen = new WeakSet<object>();
      // Winston merges a logged error's enumerable props (config/httpsAgent/...) onto
      // the top-level info object when the message has no format token, so the info
      // node itself must be sanitized as an error-like node, not just its values.
      const base = isErrorLike(info)
        ? sanitizeErrorNode(info as unknown as Record<string, unknown>)
        : { ...(info as Record<string, unknown>) };
      const result = base as Record<string | symbol, unknown>;

      for (const key of Object.keys(result)) {
        result[key] = stripHeavy(result[key], 0, seen);
      }

      // sanitizeErrorNode rebuilds from enumerable string keys only; re-attach the
      // reserved winston symbols (LEVEL/MESSAGE) that downstream transports read.
      for (const sym of Object.getOwnPropertySymbols(info)) {
        result[sym] = (info as Record<string | symbol, unknown>)[sym];
      }

      const splat = (info as Record<string | symbol, unknown>)[SPLAT_SYMBOL];
      if (Array.isArray(splat)) {
        result[SPLAT_SYMBOL] = splat.map((item) => stripHeavy(item, 0, seen));
      }

      return result as winston.Logform.TransformableInfo;
    } catch {
      return info;
    }
  },
);

/**
 * Truncates long string values in JSON log objects.
 * Prevents outputting extremely long values (e.g., base64, blobs).
 */
const jsonTruncateFormat: winston.Logform.FormatWrap = winston.format(
  (info: winston.Logform.TransformableInfo) => {
    const truncateLongStrings = (str: string, maxLength: number): string =>
      str.length > maxLength ? str.substring(0, maxLength) + '...' : str;

    const seen = new WeakSet<object>();

    const truncateObject = (obj: unknown): unknown => {
      if (typeof obj !== 'object' || obj === null) {
        return obj;
      }

      // Handle circular references - now with proper object type
      if (seen.has(obj)) {
        return '[Circular]';
      }
      seen.add(obj);

      if (Array.isArray(obj)) {
        return obj.map((item) => truncateObject(item));
      }

      const objectRecord = obj as Record<string | symbol, unknown>;
      const newObj: Record<string | symbol, unknown> = {};
      // Only the log record carries transport symbols; nested values stay JSON-shaped.
      const keys = obj === info ? Reflect.ownKeys(objectRecord) : Object.keys(objectRecord);
      for (const key of keys) {
        if (typeof key === 'symbol') {
          newObj[key] = objectRecord[key];
          continue;
        }
        if (!Object.prototype.propertyIsEnumerable.call(objectRecord, key)) {
          continue;
        }
        const value = objectRecord[key];
        if (typeof value === 'string') {
          newObj[key] = truncateLongStrings(value, CONSOLE_JSON_STRING_LENGTH);
        } else {
          newObj[key] = truncateObject(value);
        }
      }
      return newObj;
    };

    return truncateObject(info) as winston.Logform.TransformableInfo;
  },
);

export {
  redactFormat,
  redactMessage,
  redactLogString,
  debugTraverse,
  jsonTruncateFormat,
  stripHeavyErrorFields,
};
