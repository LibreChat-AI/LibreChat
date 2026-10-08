import { logger } from '@librechat/data-schemas';
import { isSensitiveEnvVar } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { encodeHeaderValue, stripUnresolvedPlaceholders } from '~/utils/env';
import { decryptConfigSecret } from '~/admin/secrets';
import { normalizeString } from '~/utils/text';

type LangfuseAppConfig = NonNullable<AppConfig['langfuse']>;

/** RFC 7230 token characters — the only bytes legal in an HTTP field name. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Legal field-value bytes: visible ASCII, space/tab, and obs-text. A newline,
 *  carriage return, or NUL is both rejected by `Headers` and a request-splitting
 *  vector, so such a value is dropped rather than sanitized. */

const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Names that break the request rather than travel with it. `fetch` throws on
 * `Transfer-Encoding`, and a fixed `Content-Length` misdescribes the body as
 * soon as this shared map is reused on a request with a different one. Since
 * the map is attached to export, verification, lookup, and feedback alike, one
 * such entry disables the whole integration instead of being ignored.
 */
const FORBIDDEN_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Header names already reported, so a per-run resolution cannot spam the log.
 *  Bounded by the deployment's configured header names. */
const droppedHeaderWarnings = new Set<string>();

function warnDroppedHeader(name: string, reason: string): void {
  const key = `${name}\n${reason}`;
  if (droppedHeaderWarnings.has(key)) {
    return;
  }
  droppedHeaderWarnings.add(key);
  logger.warn(`[langfuse] Dropping header "${name}": ${reason}`);
}

/**
 * Names of `${VAR}` references in a *configured* value that will not expand —
 * either unset, or on the infrastructure denylist `extractEnvVariable` refuses
 * to substitute.
 *
 * Deliberately inspects the pre-expansion text. Testing the resolved string for
 * `${...}` cannot tell a failed substitution from a credential that merely
 * contains those characters, and gateway tokens are arbitrary strings — a
 * working `abc${def}ghi` token would be silently dropped.
 */
function unresolvableEnvRefs(configuredValue: string): string[] {
  const unresolved: string[] = [];
  for (const match of configuredValue.matchAll(/\$\{([^}]+)\}/g)) {
    const name = match[1].trim();
    if (isSensitiveEnvVar(name) || !normalizeString(process.env[name])) {
      unresolved.push(name);
    }
  }
  return unresolved;
}

/**
 * Substitutes every `${VAR}` reference, which callers must have already checked
 * with `unresolvableEnvRefs`.
 *
 * Done here rather than left to `extractEnvVariable` because its whole-string
 * branch is anchored (`^\${(.+)}$`) and greedy, so a value composed of two
 * references — `${CLIENT_ID}:${CLIENT_SECRET}` — parses as one variable named
 * `CLIENT_ID}:${CLIENT_SECRET`, resolves to nothing, and the raw template is
 * sent as the credential.
 */
function expandEnvRefs(configuredValue: string): string {
  return configuredValue.replace(
    /\$\{([^}]+)\}/g,
    (fullMatch, rawName: string) => process.env[rawName.trim()] ?? fullMatch,
  );
}

/** Names already reported as duplicate spellings, keyed by lowercase name. */
const duplicateHeaderWarnings = new Set<string>();

/**
 * Collapses case-variant spellings of the same header name, keeping the last.
 *
 * HTTP header names are case-insensitive, but a config map can legally hold
 * `authorization` and `AUTHORIZATION` as distinct keys. Downstream merging
 * indexes one spelling per name and so can only displace one of them; the
 * survivor would then be *appended* by `Headers` into a combined value,
 * breaking the very credential it was meant to set.
 */
function collapseHeaderNameVariants(headers: Record<string, string>): Record<string, string> {
  const byLowerName = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    const existing = byLowerName.get(lower);
    if (existing != null && !duplicateHeaderWarnings.has(lower)) {
      duplicateHeaderWarnings.add(lower);
      logger.warn(
        `[langfuse] Header "${name}" duplicates "${existing}" (names are case-insensitive); using "${name}".`,
      );
    }
    byLowerName.set(lower, name);
  }

  if (byLowerName.size === Object.keys(headers).length) {
    return headers;
  }
  return Object.fromEntries([...byLowerName.values()].map((name) => [name, headers[name]]));
}

export function toBasicAuthorization(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

/**
 * Refuses redirects on requests carrying custom headers.
 *
 * Node strips `Authorization` when a redirect crosses origins but keeps
 * arbitrary headers, so following one would hand the gateway credential to a
 * host that passed no origin check. Requests without custom headers keep the
 * default follow behavior, so this changes nothing for existing deployments.
 */
export function redirectPolicyFor(headers?: Record<string, string>): {
  redirect?: RequestRedirect;
} {
  return headers != null && Object.keys(headers).length > 0 ? { redirect: 'error' } : {};
}

/**
 * Resolves the deployment's custom Langfuse headers: `${ENV_VAR}` interpolation
 * and header-safe encoding, matching what endpoint headers get.
 *
 * No user or request body is involved — one exporter serves every user's spans,
 * so per-user placeholders have no meaning here and are stripped rather than
 * forwarded as template syntax. Anything that cannot be sent safely (unset
 * reference, illegal name, framing header, unencodable value) is dropped with a
 * warning rather than sent malformed: a proxy rejecting a broken credential is
 * far harder to diagnose than a missing one.
 *
 * @returns the resolved headers, or `undefined` when none survive.
 */
export function resolveLangfuseHeaders(
  headers?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (headers == null) {
    return undefined;
  }

  /** `TCustomConfig` is a `DeepPartial`, so record values arrive as
   *  `string | undefined` regardless of what the schema declares. */
  const declared: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      continue;
    }
    const name = rawName.trim();
    if (name === '') {
      continue;
    }
    /** An illegal field name (` X-Token`, `X Proxy Token`) is rejected by the
     *  `Headers` constructor, which would throw on every export, verification,
     *  lookup, and feedback request instead of failing this one header. */
    if (!HEADER_NAME_PATTERN.test(name)) {
      warnDroppedHeader(rawName, 'it is not a valid HTTP header name.');
      continue;
    }
    if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
      warnDroppedHeader(name, 'it controls request framing and cannot be set on a fetch request.');
      continue;
    }
    declared[name] = value;
  }
  if (Object.keys(declared).length === 0) {
    return undefined;
  }

  const collapsed = collapseHeaderNameVariants(declared);
  const entries: Array<[string, string]> = [];
  for (const [name, configured] of Object.entries(collapsed)) {
    /**
     * Every template operation runs on the operator's configured text, and the
     * credential is substituted last and never touched again.
     *
     * Order matters in both directions: expanding first would let a strip or a
     * second expansion reinterpret characters that came out of the secret, so a
     * token containing `{{LIBRECHAT_USER_ID}}` would have that span deleted and
     * one containing `${PATH}` would be rewritten. Gateway credentials are
     * arbitrary strings; none of their bytes are template syntax.
     */
    const template = stripUnresolvedPlaceholders(configured);
    const unresolved = unresolvableEnvRefs(template);
    if (unresolved.length > 0) {
      warnDroppedHeader(name, `${unresolved.join(', ')} is not set in the environment.`);
      continue;
    }
    const value = expandEnvRefs(template);

    /** Trimmed because a credential read from a file or `$(...)` commonly
     *  carries a trailing newline, which would otherwise fail validation. */
    const trimmed = value.trim();
    if (trimmed === '') {
      continue;
    }
    /** Nothing else encodes these values, so a literal or interpolated
     *  character above U+00FF would reach `Headers` unencoded and throw,
     *  taking down export, verification, and feedback alike. */
    const encoded = encodeHeaderValue(trimmed);
    /** `encodeHeaderValue` only encodes above U+00FF, so control bytes below it
     *  still reach `Headers` and throw — an embedded CR/LF would also be a
     *  request-splitting attempt, so this drops rather than strips. */
    if (!HEADER_VALUE_PATTERN.test(encoded)) {
      warnDroppedHeader(name, 'its value contains characters not allowed in an HTTP header.');
      continue;
    }
    entries.push([name, encoded]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function resolveTenantCredentials(
  config?: LangfuseAppConfig,
): { publicKey: string; secretKey: string } | undefined {
  const publicKey = normalizeString(config?.publicKey);
  const secretKey = decryptConfigSecret(config?.secretKey);
  if (!publicKey || !secretKey) {
    return undefined;
  }
  return { publicKey, secretKey };
}

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

export function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return undefined;
}

export function isTrueEnv(value: unknown): boolean {
  return normalizeBoolean(value) === true;
}

export function isFalseEnv(value: unknown): boolean {
  return normalizeBoolean(value) === false;
}
