import { normalizeRumPath } from './routes';

export const MAX_MESSAGE_LENGTH = 512;
export const MAX_NAME_LENGTH = 64;
const MAX_FRAME_LENGTH = 200;
const MAX_FRAMES = 12;

const URL_PATTERN =
  /\b(?:https?|wss?|chrome-extension|moz-extension|safari-web-extension):\/\/[^\s"'<>()]+/gi;
const QUERY_PATTERN = /\?[\w.~%-]+=[^\s"'<>()]*/g;
const JWT_PATTERN = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|Token)\s+[\w~+/.=-]{6,}/gi;
const ASSIGNMENT_PATTERN =
  /["']?\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization|cookie|session[_-]?id|signature)\b["']?(\s*[:=]\s*)((?:Bearer|Basic|Token)\s+[^\s,;&]+|"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const EMAIL_PATTERN = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PROVIDER_KEY_PATTERN = /\b(?:sk|pk|rk|xox[abprs]|gh[pousr]|glpat)[-_][\w-]{8,}/gi;
const AWS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const TOKEN_LIKE_PATTERN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const DOUBLE_QUOTED_PATTERN = /"[^"\n]+"/g;
const LONG_SINGLE_QUOTED_PATTERN = /'[^'\n]{24,}'/g;
const FRAME_LOCATION = String.raw`(?:[a-z][\w+.-]*:\/\/|\/|[a-z]:\\)[^\s()]*?(?::\d+){1,2}`;
/**
 * Complete frame shapes only, each ending in a URL or absolute path with a line number:
 * V8 (`at fn (https://…/a.js:1:2)`, `at https://…/a.js:1:2`) and Gecko/WebKit
 * (`fn@https://…/a.js:1:2`). A message line that merely ends in `:123` matches neither.
 */
const STACK_FRAME_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`^at (?:[^()]{1,300} \()?${FRAME_LOCATION}\)?$`, 'i'),
  /^at (?:[^()]{1,300} \()?(?:native|<anonymous>)\)?$/,
  new RegExp(String.raw`^[\w$.<>/*[\] -]{0,300}@${FRAME_LOCATION}$`, 'i'),
];
const IDENTIFIER = String.raw`(?:\(intermediate value\))?[\w$.[\]]{1,120}`;
/**
 * Message shapes the JS engine, the browser or a library generates from code identifiers.
 * An error class proves nothing about provenance (any code can throw `new TypeError(text)`), so
 * a message is exported only when its whole text matches one of these; every other error keeps
 * its type, status and stack but never its message, which can echo prompt or response text.
 */
const SAFE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)(?: \((?:reading|setting) '[\w$-]{1,80}'\))?$/,
  /^Cannot (?:read|set) property '[\w$-]{1,80}' of (?:undefined|null)$/,
  new RegExp(`^${IDENTIFIER} is not (?:a function|a constructor|iterable|defined|an object)$`),
  new RegExp(`^(?:undefined|null) is not an object \\(evaluating '${IDENTIFIER}'\\)$`),
  /^Can't find variable: [\w$]{1,80}$/,
  /^Assignment to constant variable\.$/,
  /^Maximum call stack size exceeded\.?$/,
  /^Too much recursion$/i,
  /^Invalid array length$/,
  /^Failed to fetch$/,
  /^Load failed$/,
  /^NetworkError when attempting to fetch resource\.?$/,
  /^Network Error$/,
  /^Request failed with status code \d{3}$/,
  /^timeout of \d+ms exceeded$/,
  /^(?:The operation was aborted|The user aborted a request|signal is aborted without reason)\.?$/,
  /^Unexpected end of JSON input$/,
  /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/,
  /^Failed to fetch dynamically imported module: \S+$/,
  /^Importing a module script failed\.?$/,
  /^error loading dynamically imported module(?:: \S+)?$/,
  /^Unable to preload CSS for \S+$/,
  /^Loading (?:CSS )?chunk [\w-]+ failed\.?(?: \(\S+\))?$/,
  /^Failed to load a code-split module$/,
];

/** Error names are writable too; unknown names must not become a free-text channel. */
const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AxiosError',
  'ChunkLoadError',
  'DOMException',
  'AbortError',
  'NetworkError',
  'NotAllowedError',
  'NotFoundError',
  'SecurityError',
  'TimeoutError',
  'DataError',
  'InvalidStateError',
  'QuotaExceededError',
  'NotSupportedError',
  'OperationError',
]);

type ErrorShape = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  status?: unknown;
  response?: { status?: unknown } | null;
};

export type ErrorSummary = {
  type?: string;
  message?: string;
  stacktrace?: string;
  statusCode?: number;
};

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function urlToPath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return normalizeRumPath(url.pathname);
  } catch {
    return '[url]';
  }
}

function redactTokenLike(match: string): string {
  return /\d/.test(match) && /[A-Za-z]/.test(match) ? '[redacted]' : match;
}

/**
 * Removes values that can identify a user or grant access: URLs collapse to their route
 * template, and emails, credentials, JWTs, ids, long secrets and quoted payload fragments are
 * replaced with placeholders. Applied to every free-text field before it leaves the browser.
 */
export function scrubText(value: string): string {
  return value
    .replace(URL_PATTERN, urlToPath)
    .replace(QUERY_PATTERN, '')
    .replace(JWT_PATTERN, '[jwt]')
    .replace(ASSIGNMENT_PATTERN, '$1$2[redacted]')
    .replace(AUTH_SCHEME_PATTERN, '$1 [redacted]')
    .replace(EMAIL_PATTERN, '[email]')
    .replace(PROVIDER_KEY_PATTERN, '[key]')
    .replace(AWS_KEY_PATTERN, '[key]')
    .replace(UUID_PATTERN, ':id')
    .replace(HEX_PATTERN, '[hex]')
    .replace(TOKEN_LIKE_PATTERN, redactTokenLike)
    .replace(DOUBLE_QUOTED_PATTERN, '"[redacted]"')
    .replace(LONG_SINGLE_QUOTED_PATTERN, "'[redacted]'");
}

export function scrubField(value: string, maxLength: number): string {
  return truncate(scrubText(value), maxLength);
}

/** V8 prefixes the stack with `name: message`, which can span lines; it is never a frame. */
function stripStackHeader(stack: string, header?: string): string {
  return header && stack.startsWith(header) ? stack.slice(header.length) : stack;
}

/**
 * Keeps only complete stack frames, with URLs reduced to paths. The `name: message` header is
 * removed first, so neither it nor any line of a multi-line message can pass as a frame.
 */
export function reduceStack(stack: string, header?: string): string | undefined {
  const frames = stripStackHeader(stack, header)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => STACK_FRAME_PATTERNS.some((pattern) => pattern.test(line)))
    .slice(0, MAX_FRAMES)
    .map((line) => scrubField(line, MAX_FRAME_LENGTH));
  return frames.length > 0 ? frames.join('\n') : undefined;
}

function statusCodeOf(error: ErrorShape): number | undefined {
  const status = error.response?.status ?? error.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function stackHeader(error: ErrorShape): string | undefined {
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const message = typeof error.message === 'string' ? error.message : '';
  return message ? `${name}: ${message}` : name;
}

export function isErrorLike(value: unknown): value is ErrorShape {
  if (value instanceof Error) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const shape: ErrorShape = value;
  return typeof shape.message === 'string' && typeof shape.name === 'string';
}

export function isSafeErrorMessage(message: string): boolean {
  const trimmed = message.trim();
  return SAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Allowlisted, scrubbed view of an error: request config, headers and bodies are never read, and
 * the message is kept only when it matches a known engine-, browser- or library-generated shape.
 */
export function summarizeError(error: unknown): ErrorSummary | undefined {
  if (!isErrorLike(error)) {
    return undefined;
  }
  const message =
    typeof error.message === 'string' && isSafeErrorMessage(error.message)
      ? scrubField(error.message.trim(), MAX_MESSAGE_LENGTH)
      : undefined;
  return {
    type: typeof error.name === 'string' && ERROR_TYPES.has(error.name) ? error.name : 'Error',
    message,
    stacktrace:
      typeof error.stack === 'string' ? reduceStack(error.stack, stackHeader(error)) : undefined,
    statusCode: statusCodeOf(error),
  };
}

const BROWSER_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const OS_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function matchFamily(userAgent: string, families: ReadonlyArray<[RegExp, string]>): string {
  return families.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Other';
}

/** Coarse browser and OS families only; the full user agent never leaves the browser. */
export function getClientPlatform(userAgent: string): { browser: string; os: string } {
  return {
    browser: matchFamily(userAgent, BROWSER_FAMILIES),
    os: matchFamily(userAgent, OS_FAMILIES),
  };
}
