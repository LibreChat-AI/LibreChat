import type { AnthropicClientOptions } from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import type { RequestBody, RunLLMConfig } from '~/types';
import { resolveHeaders } from './env';

const TENANT_ID_HEADER_PLACEHOLDERS = [
  '{{LIBRECHAT_USER_TENANTID}}',
  '{{LIBRECHAT_USER_TENANT_ID}}',
] as const;

/**
 * The media type of a `Content-Type` header — the lowercased `type/subtype` pair with any
 * parameters stripped, or `''` when the header is absent or empty.
 *
 * Substring-matching the raw header is wrong in both directions. A `text/plain;
 * boundary=text/event-stream` value contains the SSE type without being one, and a
 * `TEXT/EVENT-STREAM` value is one without containing it in the expected case. Callers
 * classifying a response by its type must compare against this, not the raw header.
 */
export function mediaTypeEssence(header: string | null | undefined): string {
  if (!header) {
    return '';
  }
  return (header.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** Comma-unions two header values (deduped, trimmed), e.g. `anthropic-beta`. */
function unionCsv(a: string, b: string): string {
  const values = [a, b]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(values)).join(',');
}

/**
 * Merges two header maps, with `override` winning on key collisions. Matching is
 * case-insensitive (HTTP header names are), so an `override` key replaces any
 * case variant from `base` rather than leaving both names in the output (which
 * clients may collapse, breaking auth or protocol headers); the `override`
 * casing is kept. The `anthropic-beta` header is special-cased: values from both
 * sides are comma-unioned (deduped) so a custom beta coexists with
 * provider-managed betas instead of clobbering them.
 *
 * Used both to layer endpoint headers over global (`endpoints.all`) headers and
 * to attach admin-configured custom headers beneath provider-managed headers
 * (auth/version/beta), so the provider integration's own headers always win.
 *
 * @returns the merged map, or `undefined` when neither side has any headers.
 */
export function mergeHeaders(
  base?: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: Record<string, string> = { ...(base ?? {}) };
  if (!override) {
    return merged;
  }

  const baseKeyByLower = new Map<string, string>(
    Object.keys(merged).map((key) => [key.toLowerCase(), key]),
  );

  for (const [key, value] of Object.entries(override)) {
    const lower = key.toLowerCase();
    const existingKey = baseKeyByLower.get(lower);
    const nextValue =
      lower === 'anthropic-beta' && existingKey != null
        ? unionCsv(merged[existingKey], value)
        : value;

    if (existingKey != null && existingKey !== key) {
      delete merged[existingKey];
    }
    merged[key] = nextValue;
    baseKeyByLower.set(lower, key);
  }

  return merged;
}

type DefaultHeadersContainer = { defaultHeaders?: Record<string, string> };
type CustomHeadersContainer = { customHeaders?: Record<string, string> };

function resolveTenantPlaceholders(
  headers: Record<string, string>,
  tenantId?: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      TENANT_ID_HEADER_PLACEHOLDERS.reduce(
        (current, placeholder) => current.replaceAll(placeholder, tenantId ?? ''),
        value,
      ),
    ]),
  );
}

/**
 * Resolves model-header templates with the request-scoped tenant supplied by
 * the run host. Tenant substitution is intentionally scoped to model headers;
 * it does not widen the user fields exposed to other template consumers.
 */
export function resolveModelHeaders({
  headers,
  user,
  tenantId,
  body,
  customUserVars,
}: {
  headers: Record<string, string> | undefined;
  user?: Partial<IUser> | { id: string };
  tenantId?: string;
  body?: RequestBody;
  customUserVars?: Record<string, string>;
}): Record<string, string> {
  const resolved = resolveHeaders({
    headers,
    user,
    body,
    customUserVars,
    stripUnresolved: true,
  });

  return resolveTenantPlaceholders(resolved, tenantId);
}

/**
 * Header maps already resolved by `resolveConfigHeaders`. `resolveConfigHeaders`
 * mutates config objects in place, and the same initialized agent (hence the same
 * nested header objects) can flow through `buildAgentInput` more than once (root +
 * subagent, multiple parents). Resolving twice would run env expansion over values
 * already substituted with user/body data, violating the env-before-user invariant
 * documented in `resolveHeaders`. Tracking resolved maps makes resolution
 * idempotent across reuse. Keyed by object identity (per-request fresh objects), so
 * nothing carries across requests.
 */
const resolvedHeaderMaps = new WeakSet<object>();

/**
 * Resolves placeholder templates in the outbound request headers of a built LLM
 * config, mutating it in place. Handles the OpenAI-compatible
 * `configuration.defaultHeaders` (OpenAI / Azure / custom) and the native
 * Anthropic `clientOptions.defaultHeaders` (including Vertex) carriers, plus
 * tenant-only substitution in native Google `customHeaders`. Google's map is
 * otherwise resolved at initialization so provider-managed authorization never
 * passes through environment or user-template expansion.
 *
 * Resolution runs at request time so request-body placeholders (e.g.
 * `{{LIBRECHAT_BODY_CONVERSATIONID}}`) resolve against the live request. It is a
 * no-op for header values without placeholders, and idempotent under config reuse.
 *
 * This is the last resolution pass before the outbound provider request, so any
 * placeholder still unresolved here (missing user context, a user without the
 * configured field) is stripped rather than forwarded as literal template text
 * the upstream could mistake for real user data.
 */
export function resolveConfigHeaders({
  llmConfig,
  user,
  tenantId,
  body,
  customUserVars,
}: {
  /** Partial: this only reads the three provider header carriers, so
   *  callers with a bare ClientOptions (e.g. auxiliary generations like
   *  titles/activity labels) can resolve headers without assembling a
   *  full run config. */
  llmConfig?: Partial<RunLLMConfig> | null;
  user?: Partial<IUser> | { id: string };
  /** Authoritative request tenant used only for model-header templates. */
  tenantId?: string;
  body?: RequestBody;
  customUserVars?: Record<string, string>;
}): void {
  if (llmConfig == null) {
    return;
  }

  const resolveOnce = (headers: Record<string, string>): Record<string, string> => {
    if (resolvedHeaderMaps.has(headers)) {
      return headers;
    }
    const resolved = resolveModelHeaders({ headers, user, tenantId, body, customUserVars });
    resolvedHeaderMaps.add(resolved);
    return resolved;
  };

  const configuration = llmConfig.configuration as DefaultHeadersContainer | undefined;
  if (configuration?.defaultHeaders != null) {
    configuration.defaultHeaders = resolveOnce(configuration.defaultHeaders);
  }

  const clientOptions = (llmConfig as AnthropicClientOptions).clientOptions as
    | DefaultHeadersContainer
    | undefined;
  if (clientOptions?.defaultHeaders != null) {
    clientOptions.defaultHeaders = resolveOnce(clientOptions.defaultHeaders);
  }

  const customHeadersContainer = llmConfig as CustomHeadersContainer;
  if (customHeadersContainer.customHeaders != null) {
    const headers = customHeadersContainer.customHeaders;
    if (!resolvedHeaderMaps.has(headers)) {
      customHeadersContainer.customHeaders = resolveTenantPlaceholders(headers, tenantId);
      resolvedHeaderMaps.add(customHeadersContainer.customHeaders);
    }
  }
}
