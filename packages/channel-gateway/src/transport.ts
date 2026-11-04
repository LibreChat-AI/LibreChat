import { CHANNEL_RUN_MAX_JSON_BYTES } from 'librechat-data-provider';

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code = '',
  ) {
    super(`Channel service returned HTTP ${status}`);
  }
}

/** Expected stale/authorization failures may be acknowledged privately; outages must propagate. */
export function expectedServiceFailure(error: unknown): boolean {
  return error instanceof ServiceError && [400, 403, 404, 409, 410].includes(error.status);
}

export interface ServiceConnection {
  LIBRECHAT_INTERNAL_URL: string;
  CHANNEL_SERVICE_TOKEN: string;
  CHANNEL_TENANT_ID?: string;
  API_CALL_TIMEOUT_MS: number;
}

export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Remote response exceeds size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ServiceClient {
  private readonly base: string;
  constructor(
    protected readonly connection: ServiceConnection,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.base = connection.LIBRECHAT_INTERNAL_URL.replace(/\/$/, '');
  }

  protected async raw(
    path: string,
    body: object | undefined,
    signal?: AbortSignal,
    key = this.connection.CHANNEL_SERVICE_TOKEN,
    requestKey?: string,
    timeout = this.connection.API_CALL_TIMEOUT_MS,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    if (this.connection.CHANNEL_TENANT_ID && this.connection.CHANNEL_TENANT_ID !== '_')
      headers['X-Tenant-Id'] = this.connection.CHANNEL_TENANT_ID;
    if (requestKey) headers['Idempotency-Key'] = requestKey;
    return this.transport(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
  }

  protected async decode<T>(response: Response, empty?: T): Promise<T> {
    if (response.status === 204 && empty !== undefined) return empty;
    const bytes = await boundedBody(response, response.ok ? CHANNEL_RUN_MAX_JSON_BYTES : 64 * 1024);
    if (!response.ok) {
      let code = '';
      try {
        const failure: { error?: string } = JSON.parse(bytes.toString());
        if (
          (response.status === 403 && failure.error === 'channel_link_required') ||
          (response.status === 409 && failure.error === 'trace_unavailable') ||
          (response.status === 503 && failure.error === 'transactions_unavailable')
        )
          code = failure.error;
      } catch {
        /* Untrusted error bodies are never exposed. */
      }
      throw new ServiceError(response.status, code);
    }
    try {
      const value: T = JSON.parse(bytes.toString());
      return value;
    } catch {
      throw new Error('Invalid channel service response');
    }
  }

  async request<T>(path: string, body?: object, signal?: AbortSignal, empty?: T): Promise<T> {
    return this.decode<T>(await this.raw(path, body, signal), empty);
  }
}
