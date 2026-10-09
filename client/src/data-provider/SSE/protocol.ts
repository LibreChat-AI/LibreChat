import { request } from 'librechat-data-provider';

export const GENERATION_PROTOCOL_VERSION = 2 as const;
export const GENERATION_PROTOCOL_HEADER = 'X-LibreChat-Generation-Protocol';

export type GenerationProtocolVersion = 1 | typeof GENERATION_PROTOCOL_VERSION;

/**
 * Protocol negotiation is deliberately fail-closed: only an exact numeric
 * echo of `2` enables v2 behavior. Old servers, stripped fields, strings, and
 * future versions all remain on the legacy path until the client understands
 * their contract.
 */
export const getGenerationProtocolVersion = (value: unknown): GenerationProtocolVersion => {
  if (
    value != null &&
    typeof value === 'object' &&
    (value as { generationProtocolVersion?: unknown }).generationProtocolVersion ===
      GENERATION_PROTOCOL_VERSION
  ) {
    return GENERATION_PROTOCOL_VERSION;
  }
  return 1;
};

export const supportsGenerationProtocolV2 = (value: unknown): boolean =>
  getGenerationProtocolVersion(value) === GENERATION_PROTOCOL_VERSION;

export const generationProtocolHeaders = (): Record<string, string> => ({
  [GENERATION_PROTOCOL_HEADER]: String(GENERATION_PROTOCOL_VERSION),
});

export const withGenerationProtocolQuery = (url: string): string =>
  `${url}${url.includes('?') ? '&' : '?'}generationProtocolVersion=${GENERATION_PROTOCOL_VERSION}`;

const withGenerationProtocolBody = (body: unknown): unknown => {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  return {
    ...(body as Record<string, unknown>),
    generationProtocolVersion: GENERATION_PROTOCOL_VERSION,
  };
};

type GenerationRequestError = Error & {
  code?: string;
  response?: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
};

const parseResponseBody = (text: string): unknown => {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const responseHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

/**
 * JSON POST used by generation-control routes. `authenticatedFetch` preserves
 * these custom headers when it transparently refreshes a 401 token; the small
 * Axios-shaped error wrapper keeps existing mutation/retry callers compatible.
 */
export async function postGenerationRequest<T>(
  url: string,
  body: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  let response: Response;
  try {
    response = await request.authenticatedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...generationProtocolHeaders(),
      },
      body: JSON.stringify(withGenerationProtocolBody(body)),
      signal: options?.signal,
    });
  } catch (error) {
    /** Fetch does not expose Axios' `ERR_NETWORK`, which the start retry loop
     * already uses to distinguish an ambiguous transport failure. */
    if (error instanceof Error && error.name !== 'AbortError') {
      (error as GenerationRequestError).code ??= 'ERR_NETWORK';
    }
    throw error;
  }

  const data = parseResponseBody(await response.text());
  if (!response.ok) {
    const message =
      data != null &&
      typeof data === 'object' &&
      typeof (data as { message?: unknown }).message === 'string'
        ? (data as { message: string }).message
        : `Generation request failed with status ${response.status}`;
    const error = new Error(message) as GenerationRequestError;
    error.response = {
      status: response.status,
      data,
      headers: responseHeaders(response.headers),
    };
    throw error;
  }

  return data as T;
}
