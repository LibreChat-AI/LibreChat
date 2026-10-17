import { z } from 'zod';
import type { AppConfig } from '@librechat/data-schemas';
import {
  redirectPolicyFor,
  resolveLangfuseHeaders,
  resolveTenantCredentials,
  toBasicAuthorization,
} from './utils';
import { hasLangfuseEnvCredentials, usesLangfuseMultiTenantRouting } from './policy';
import { scopeHeadersToDestination, getCentralEnvBaseUrl } from './destinations';
import { resolveLangfuseTenantDestination } from './tenantDestinations';
import { mergeHeaders } from '~/utils/headers';
import { normalizeString } from '~/utils/text';

const PROMPTS_PATH = '/api/public/v2/prompts';

export type LangfusePromptConnection = {
  baseUrl: string;
  authorization: string;
  headers?: Record<string, string>;
};

export type LangfusePromptListQuery = {
  name?: string;
  label?: string;
  tag?: string;
  page?: number;
  limit?: number;
  fromUpdatedAt?: string;
  toUpdatedAt?: string;
};

export type LangfusePromptListItem = {
  name: string;
  type: 'text' | 'chat';
  versions: number[];
  labels: string[];
  tags: string[];
  lastUpdatedAt: string;
};

export type LangfusePromptListResult = {
  items: LangfusePromptListItem[];
  meta: { page: number; limit: number; totalItems: number; totalPages: number };
};

export type LangfuseTextPromptSelector = { label: 'production' } | { version: number };

export type LangfuseTextPromptValue = {
  name: string;
  version: number;
  labels: string[];
  prompt: string;
};

export type LangfuseTextPromptResult =
  | { ok: true; value: LangfuseTextPromptValue }
  | { ok: false; error: { code: 'not_found' | 'unsupported_type' } };

export type LangfusePromptRequestErrorCode =
  | 'unauthorized'
  | 'timeout'
  | 'upstream'
  | 'invalid_response';

export class LangfusePromptRequestError extends Error {
  readonly code: LangfusePromptRequestErrorCode;
  readonly status?: number;

  constructor(code: LangfusePromptRequestErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LangfusePromptRequestError';
    this.code = code;
    if (status != null) {
      this.status = status;
    }
  }
}

const promptListItemSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['text', 'chat']),
  versions: z.array(z.number()),
  labels: z.array(z.string()),
  tags: z.array(z.string()),
  lastUpdatedAt: z.string(),
});

const promptListResponseSchema = z.object({
  data: z.array(promptListItemSchema),
  meta: z.object({
    page: z.number(),
    limit: z.number(),
    totalItems: z.number(),
    totalPages: z.number(),
  }),
});

const promptBaseSchema = z.object({
  name: z.string().min(1),
  version: z.number(),
  type: z.enum(['text', 'chat']),
  labels: z.array(z.string()),
});

const textPromptSchema = promptBaseSchema.extend({
  type: z.literal('text'),
  prompt: z.string(),
});

/** Resolves the deployment's single Langfuse project from the environment keys. */
function resolveCentralEnvConnection(
  headers?: Record<string, string>,
): LangfusePromptConnection | null {
  const publicKey = normalizeString(process.env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeString(process.env.LANGFUSE_SECRET_KEY);
  if (!publicKey || !secretKey) {
    return null;
  }
  const baseUrl = getCentralEnvBaseUrl();
  const scopedHeaders = scopeHeadersToDestination(headers, baseUrl);
  return {
    baseUrl,
    authorization: toBasicAuthorization(publicKey, secretKey),
    ...(scopedHeaders ? { headers: scopedHeaders } : {}),
  };
}

/** Resolves the tenant's own Langfuse project from its stored connection. */
function resolveTenantConnection(
  appConfig?: AppConfig,
  headers?: Record<string, string>,
): LangfusePromptConnection | null {
  const config = appConfig?.langfuse;
  const credentials = resolveTenantCredentials(config);
  const destination = resolveLangfuseTenantDestination(config?.destination);
  if (!credentials || !destination) {
    return null;
  }
  const scopedHeaders = scopeHeadersToDestination(headers, destination.baseUrl);
  return {
    baseUrl: destination.baseUrl,
    authorization: toBasicAuthorization(credentials.publicKey, credentials.secretKey),
    ...(scopedHeaders ? { headers: scopedHeaders } : {}),
  };
}

/**
 * The connection prompt reads use. A request from a tenant user, or any request
 * in multi-tenant mode (`usesLangfuseMultiTenantRouting`), uses only the
 * tenant's stored connection: prompt reads return data, so a tenant must never
 * read the central env project, even while `TENANT_ISOLATION_STRICT` is off.
 * Unlike tracing, this does not require `langfuse.enabled` or fanout.
 */
export function resolveLangfusePromptConnection(
  appConfig?: AppConfig,
  options?: { tenantId?: string },
): LangfusePromptConnection | null {
  const headers = resolveLangfuseHeaders(appConfig?.langfuse?.headers);
  if (options?.tenantId || usesLangfuseMultiTenantRouting()) {
    return resolveTenantConnection(appConfig, headers);
  }
  return hasLangfuseEnvCredentials()
    ? resolveCentralEnvConnection(headers)
    : resolveTenantConnection(appConfig, headers);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Node's fetch returns a connection to its pool only once the body is consumed or cancelled. */
async function release(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function statusError(status: number): LangfusePromptRequestError {
  if (status === 401 || status === 403) {
    return new LangfusePromptRequestError(
      'unauthorized',
      `Langfuse responded with ${status}`,
      status,
    );
  }
  return new LangfusePromptRequestError('upstream', `Langfuse responded with ${status}`, status);
}

async function requestLangfuse(
  conn: LangfusePromptConnection,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: mergeHeaders(conn.headers, { Authorization: conn.authorization }),
      signal,
      ...redirectPolicyFor(conn.headers),
    });
  } catch (error) {
    throw isTimeout(error)
      ? new LangfusePromptRequestError('timeout', 'Langfuse did not respond in time')
      : new LangfusePromptRequestError('upstream', 'Langfuse request failed');
  }
}

/** Reads and parses a response's JSON body. The signal that bounds the
 *  request also bounds reading its body, so a parse failure can itself be the
 *  deadline firing mid-read rather than a malformed payload. */
async function readLangfuseJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw isTimeout(error)
      ? new LangfusePromptRequestError('timeout', 'Langfuse did not respond in time')
      : new LangfusePromptRequestError('invalid_response', 'Langfuse returned an invalid response');
  }
}

async function requestLangfuseJson(
  conn: LangfusePromptConnection,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await requestLangfuse(conn, url, timeoutMs);
  if (!response.ok) {
    await release(response);
    throw statusError(response.status);
  }
  return readLangfuseJsonBody(response);
}

function appendDefined(
  params: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value != null) {
    params.set(key, String(value));
  }
}

/**
 * Lists prompt metadata from Langfuse. Query params are sent as-is, only those
 * defined; `filter` is never sent (deferred to the sync slice), and every
 * prompt type — including `chat` — is returned.
 */
export async function listLangfusePrompts(
  conn: LangfusePromptConnection,
  query: LangfusePromptListQuery,
  { timeoutMs }: { timeoutMs: number },
): Promise<LangfusePromptListResult> {
  const params = new URLSearchParams();
  appendDefined(params, 'name', query.name);
  appendDefined(params, 'label', query.label);
  appendDefined(params, 'tag', query.tag);
  appendDefined(params, 'page', query.page);
  appendDefined(params, 'limit', query.limit);
  appendDefined(params, 'fromUpdatedAt', query.fromUpdatedAt);
  appendDefined(params, 'toUpdatedAt', query.toUpdatedAt);

  const search = params.size > 0 ? `?${params.toString()}` : '';
  const url = `${conn.baseUrl.replace(/\/+$/, '')}${PROMPTS_PATH}${search}`;
  const body = await requestLangfuseJson(conn, url, timeoutMs);
  const parsed = promptListResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new LangfusePromptRequestError(
      'invalid_response',
      'Langfuse returned an unexpected prompt list response',
    );
  }
  return { items: parsed.data.data, meta: parsed.data.meta };
}

/**
 * Resolves one text prompt. A chat prompt is rejected as `unsupported_type`
 * and its message content is never parsed or returned.
 */
export async function getLangfuseTextPrompt(
  conn: LangfusePromptConnection,
  name: string,
  selector: LangfuseTextPromptSelector,
  { timeoutMs }: { timeoutMs: number },
): Promise<LangfuseTextPromptResult> {
  const params = new URLSearchParams();
  if ('label' in selector) {
    params.set('label', selector.label);
  } else {
    params.set('version', String(selector.version));
  }
  const url = `${conn.baseUrl.replace(/\/+$/, '')}${PROMPTS_PATH}/${encodeURIComponent(name)}?${params.toString()}`;

  const response = await requestLangfuse(conn, url, timeoutMs);
  if (response.status === 404) {
    await release(response);
    return { ok: false, error: { code: 'not_found' } };
  }
  if (!response.ok) {
    await release(response);
    throw statusError(response.status);
  }
  const body = await readLangfuseJsonBody(response);

  const base = promptBaseSchema.safeParse(body);
  if (!base.success) {
    throw new LangfusePromptRequestError(
      'invalid_response',
      'Langfuse returned an unexpected prompt response',
    );
  }
  if (base.data.type !== 'text') {
    return { ok: false, error: { code: 'unsupported_type' } };
  }
  const text = textPromptSchema.safeParse(body);
  if (!text.success) {
    throw new LangfusePromptRequestError(
      'invalid_response',
      'Langfuse returned an unexpected prompt response',
    );
  }
  return {
    ok: true,
    value: {
      name: text.data.name,
      version: text.data.version,
      labels: text.data.labels,
      prompt: text.data.prompt,
    },
  };
}
