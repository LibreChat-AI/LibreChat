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
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization|cookie|session[_-]?id|signature)\b(\s*[:=]\s*)((?:Bearer|Basic|Token)\s+[^\s,;&]+|"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const EMAIL_PATTERN = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PROVIDER_KEY_PATTERN = /\b(?:sk|pk|rk|xox[abprs]|gh[pousr]|glpat)[-_][\w-]{8,}/gi;
const AWS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const TOKEN_LIKE_PATTERN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const DOUBLE_QUOTED_PATTERN = /"[^"\n]{8,}"/g;
const LONG_SINGLE_QUOTED_PATTERN = /'[^'\n]{24,}'/g;
const STACK_FRAME_PATTERN = /^at\s|:\d+(?::\d+)?\)?$/;

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

/** Keeps only stack frames (never the leading message line), with URLs reduced to paths. */
export function reduceStack(stack: string): string | undefined {
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => STACK_FRAME_PATTERN.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => scrubField(line, MAX_FRAME_LENGTH));
  return frames.length > 0 ? frames.join('\n') : undefined;
}

function statusCodeOf(error: ErrorShape): number | undefined {
  const status = error.response?.status ?? error.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
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

/** Allowlisted, scrubbed view of an error; request config, headers and bodies are never read. */
export function summarizeError(error: unknown): ErrorSummary | undefined {
  if (!isErrorLike(error)) {
    return undefined;
  }
  return {
    type: typeof error.name === 'string' ? scrubField(error.name, MAX_NAME_LENGTH) : undefined,
    message:
      typeof error.message === 'string' && error.message !== ''
        ? scrubField(error.message, MAX_MESSAGE_LENGTH)
        : undefined,
    stacktrace: typeof error.stack === 'string' ? reduceStack(error.stack) : undefined,
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
