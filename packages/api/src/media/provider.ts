import type {
  MediaOperation,
  MediaConfig,
  MediaSubmissionRequest,
  MediaCapability,
  MediaErrorCode,
  MediaProviderOptions,
  MediaProviderDiagnostic,
} from 'librechat-data-provider';
import type { Readable } from 'node:stream';
import type { MediaRoutingPolicy } from './routing';
import type { MediaTransport } from './transport';

export interface MediaConnection {
  id: string;
  api: MediaConfig['integrations'][number]['api'];
  baseURL: string;
  headers: Record<string, string>;
  binding: string;
  allowedAddresses?: string[];
  routing?: MediaRoutingPolicy;
  options?: MediaProviderOptions;
}

export interface MediaProviderInput {
  role: MediaSubmissionRequest['inputs'][number]['role'];
  file_id: string;
  type: string;
  data: Buffer;
  sourceURL?: string;
}

export type MediaProviderPart =
  | { kind: 'text'; ordinal: number; text: string; thoughtSignature?: string }
  | {
      kind: 'image' | 'video';
      ordinal: number;
      type: string;
      data?: Buffer;
      url?: string;
      thoughtSignature?: string;
    };

export interface MediaProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  textInputTokens?: number;
  imageInputTokens?: number;
  cachedTextInputTokens?: number;
  cachedImageInputTokens?: number;
  cachedInputTokens?: number;
  costUSD?: number;
}

export type MediaProviderResult =
  | { status: 'running'; operationId: string; progress?: number }
  | { status: 'completed'; parts: MediaProviderPart[]; usage?: MediaProviderUsage }
  | { status: 'failed'; usage?: MediaProviderUsage; diagnostic?: MediaProviderDiagnostic }
  | { status: 'cancelled'; usage?: MediaProviderUsage };

export type MediaProviderCancellationResult =
  | MediaProviderResult
  | { status: 'cancellation_requested' }
  | { status: 'cancellation_deferred' };

export interface MediaProviderContext {
  /** Durable server identity, shared by submission and recovery of the same job. */
  jobId: string;
  transport: MediaTransport;
  connection: MediaConnection;
  config: MediaConfig;
  signal: AbortSignal;
  providerTag?: string;
  continuation?: { prompt: string; inputs: MediaProviderInput[]; parts: MediaProviderPart[] };
}

export function isMediaConnectionBinding(connection: MediaConnection, binding: string): boolean {
  return connection.binding === binding;
}

export interface MediaModelProfile {
  modelId: string;
  modelName: string;
  capabilities: MediaCapability[];
  unavailableReason?: MediaErrorCode;
}

export interface MediaProviderAdapter {
  api: MediaConnection['api'];
  operations: readonly MediaOperation[];
  configuration?: {
    baseURL: string;
    keyHeader?: string;
    keyPrefix?: string;
    headers?: Record<string, string>;
  };
  catalog?: (config: MediaConfig) => MediaModelProfile[];
  submit(
    request: MediaSubmissionRequest,
    inputs: MediaProviderInput[],
    context: MediaProviderContext,
  ): Promise<MediaProviderResult>;
  poll?(operationId: string, context: MediaProviderContext): Promise<MediaProviderResult>;
  cancel?: {
    retry: 'idempotent' | 'never';
    request(
      operationId: string,
      context: MediaProviderContext,
      /** Fence and persist immediately before the first provider mutation. */
      beforeRequest: () => Promise<void>,
    ): Promise<MediaProviderCancellationResult>;
  };
  download(
    part: Extract<MediaProviderPart, { kind: 'image' | 'video' }>,
    context: MediaProviderContext,
  ): Promise<Readable>;
}

const absoluteReference = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function mediaAPIURL(connection: MediaConnection, path: string): string {
  const base = new URL(
    connection.baseURL.endsWith('/') ? connection.baseURL : `${connection.baseURL}/`,
  );
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('Media API roots cannot contain credentials, query parameters or fragments.');
  }
  if (absoluteReference.test(path)) {
    throw new Error('Media API paths must be relative to the connection root.');
  }
  return new URL(path.replace(/^\//, ''), base).href;
}
