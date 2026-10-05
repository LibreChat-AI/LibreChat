import { z } from 'zod';
import { isAxiosError } from 'axios';
import type { AxiosInstance, AxiosRequestConfig, AxiosRequestHeaders } from 'axios';
import type { Readable } from 'node:stream';
import type { MediaDiagnosticLimits } from './diagnostics';
import { mediaDiagnosticSecrets, parseMediaProviderDiagnostic } from './diagnostics';
import { isSSRFTarget, validateEndpointURL } from '~/auth/domain';
import { applySSRFSafeAgentIfDirect } from '~/auth/agent';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { MediaProviderError } from './errors';

export interface MediaTransportRequest {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | FormData;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  emptyResponse?: { status: number; body: string };
  successStatus?: number;
  /** Direct hosted-reference fetch with connect-time SSRF protection; bypasses PROXY and HTTP(S)_PROXY. */
  publicOnly?: boolean;
  allowedAddresses?: string[];
  diagnosticLimits?: MediaDiagnosticLimits;
}

export interface MediaTransport {
  json<T>(request: MediaTransportRequest, schema: z.ZodType<T>): Promise<T>;
  stream(request: MediaTransportRequest): Promise<Readable>;
}

/** Bind effective principal policy once for every provider operation, including downloads. */
export function scopeMediaTransport(
  transport: MediaTransport,
  allowedAddresses: string[] = [],
  diagnosticLimits?: MediaDiagnosticLimits,
): MediaTransport {
  return {
    json: (request, schema) =>
      transport.json(
        {
          ...request,
          allowedAddresses,
          diagnosticLimits: diagnosticLimits ?? request.diagnosticLimits,
        },
        schema,
      ),
    stream: (request) =>
      transport.stream({
        ...request,
        allowedAddresses,
        diagnosticLimits: diagnosticLimits ?? request.diagnosticLimits,
      }),
  };
}

export function isMediaTransferLimitError(error: Error, maxBytes: number): boolean {
  return (
    (error instanceof MediaProviderError && error.status === 413) ||
    (isAxiosError(error) &&
      error.code === 'ERR_BAD_RESPONSE' &&
      error.message === `maxContentLength size of ${maxBytes} exceeded`)
  );
}

/**
 * Classify a transport failure for logs without copying any payload: status codes, axios error
 * codes and error class names are safe; messages, bodies and headers are not.
 */
export function describeMediaTransportFailure(error: unknown): string {
  if (error instanceof z.ZodError) return 'schema_mismatch';
  if (error instanceof SyntaxError) return 'malformed_json';
  if (isAxiosError(error)) {
    return [
      error.response?.status ? `http_${error.response.status}` : undefined,
      error.code,
      error.config?.signal?.aborted ? 'aborted' : undefined,
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (error instanceof Error) return error.name === 'AbortError' ? 'aborted' : error.name;
  return 'unknown';
}

/** Axios merges instance defaults before transforms, so an empty request header map is insufficient. */
function preparePublicRequest(
  this: AxiosRequestConfig,
  data: string | FormData | undefined,
  headers: AxiosRequestHeaders,
): string | FormData | undefined {
  headers.clear();
  this.auth = undefined;
  this.params = undefined;
  this.socketPath = undefined;
  this.transport = undefined;
  return data;
}

export function createMediaTransport({
  http,
  allowedAddresses,
}: {
  http: AxiosInstance;
  allowedAddresses?: string[];
}): MediaTransport {
  const options = async (request: MediaTransportRequest): Promise<AxiosRequestConfig> => {
    if (request.publicOnly) {
      const target = new URL(request.url);
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.hash ||
        isSSRFTarget(target.hostname)
      )
        throw new MediaProviderError('rejected', undefined, 'unsafe_public_url');
    }
    const policy = request.publicOnly ? undefined : (request.allowedAddresses ?? allowedAddresses);
    const config: AxiosRequestConfig = {
      url: request.url,
      method: request.method ?? 'GET',
      headers: request.publicOnly ? {} : request.headers,
      data: request.body,
      signal: request.signal,
      timeout: request.timeoutMs,
      maxContentLength: request.maxBytes,
      maxBodyLength: request.maxBytes,
      validateStatus: () => true,
      ...(request.publicOnly
        ? {
            proxy: false,
            allowAbsoluteUrls: true,
            httpVersion: 1,
            withCredentials: false,
            withXSRFToken: false,
            transformRequest: [preparePublicRequest],
          }
        : {}),
    };
    if (!request.publicOnly) {
      applyAxiosProxyConfig(config, request.url);
      if (config.httpsAgent || config.httpAgent || config.proxy) {
        await validateEndpointURL(request.url, 'media', policy);
      }
    }
    return applySSRFSafeAgentIfDirect(config, request.url, policy);
  };

  const assertStatus = (
    status: number,
    request: MediaTransportRequest,
    body = '',
    requestId?: string,
    secrets: string[] = [],
  ) => {
    if (status >= 200 && status < 300) {
      return;
    }
    const rejected = status >= 400 && status < 500 && status !== 408;
    throw new MediaProviderError(
      rejected ? 'rejected' : 'uncertain',
      status,
      `http_${status}`,
      request.publicOnly
        ? undefined
        : parseMediaProviderDiagnostic(body, {
            status,
            requestId,
            limits: request.diagnosticLimits,
            secrets: [...mediaDiagnosticSecrets(request.headers), ...secrets],
          }),
    );
  };

  return {
    async json<T>(request: MediaTransportRequest, schema: z.ZodType<T>): Promise<T> {
      try {
        const response = await http.request<string>({
          ...(await options(request)),
          responseType: 'text',
          transformResponse: [(text: string) => text],
        });
        const requestId =
          response.headers['x-request-id'] ??
          response.headers['request-id'] ??
          response.headers['x-goog-request-id'] ??
          response.headers['x-ms-request-id'];
        assertStatus(
          response.status,
          request,
          response.data,
          typeof requestId === 'string' ? requestId : undefined,
          mediaDiagnosticSecrets(
            Object.fromEntries(
              Object.entries(response.config.headers.toJSON()).flatMap(([name, value]) =>
                typeof value === 'string' ? [[name, value]] : [],
              ),
            ),
          ).concat(response.config.auth?.password ?? []),
        );
        if (request.successStatus !== undefined && response.status !== request.successStatus) {
          throw new MediaProviderError('uncertain', response.status, 'unexpected_success_status');
        }
        const body =
          response.status === request.emptyResponse?.status && !response.data.trim()
            ? request.emptyResponse.body
            : response.data;
        return schema.parse(JSON.parse(body));
      } catch (error) {
        if (error instanceof MediaProviderError) {
          throw error;
        }
        throw new MediaProviderError('uncertain', undefined, describeMediaTransportFailure(error));
      }
    },
    async stream(request: MediaTransportRequest): Promise<Readable> {
      try {
        let current = request;
        let response = await http.request<Readable>({
          ...(await options(current)),
          responseType: 'stream',
        });
        for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
          response.data.destroy();
          if (
            redirects >= (request.maxRedirects ?? 0) ||
            typeof response.headers.location !== 'string'
          ) {
            throw new MediaProviderError(
              'uncertain',
              response.status,
              redirects >= (request.maxRedirects ?? 0)
                ? 'redirect_limit'
                : 'redirect_without_target',
            );
          }
          const target = new URL(response.headers.location, current.url);
          const previous = new URL(current.url);
          if (previous.protocol === 'https:' && target.protocol !== 'https:') {
            throw new MediaProviderError('rejected', response.status, 'redirect_downgrade');
          }
          current = {
            ...current,
            url: target.href,
            headers: target.origin === previous.origin ? current.headers : {},
          };
          response = await http.request<Readable>({
            ...(await options(current)),
            responseType: 'stream',
          });
        }
        if (response.status < 200 || response.status >= 300) {
          response.data.destroy();
          assertStatus(response.status, request);
        }
        const size = Number(response.headers['content-length']);
        if (Number.isFinite(size) && size > request.maxBytes) {
          response.data.destroy();
          throw new MediaProviderError('rejected', 413, 'content_length_exceeded');
        }
        return response.data;
      } catch (error) {
        if (error instanceof MediaProviderError) {
          throw error;
        }
        throw new MediaProviderError('uncertain', undefined, describeMediaTransportFailure(error));
      }
    },
  };
}
