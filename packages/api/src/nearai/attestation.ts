import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import {
  ErrorTypes,
  EModelEndpoint,
  extractEnvVariable,
  DEFAULT_NEAR_AI_VERIFICATION_TIMEOUT_MS,
  DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS,
} from 'librechat-data-provider';
import type {
  TEndpoint,
  TNearAIAttestationParams,
  TNearAIVerificationReport,
} from 'librechat-data-provider';
import type {
  NearAIService,
  NearAICredentials,
  NearAIAttestationStatus,
  NearAIFetch,
} from './types';
import type { NearAIReceipt } from './receipts';
import type { NearAISDK } from './sdk';
import { createReplyReport, createFailureReport, getVerificationErrorCode } from './report';
import { getNearAIReceiptCollector, observeCompletionBody } from './receipts';
import { getSafeErrorMetadata } from '~/utils/errors';
import { detachOnAbort } from '~/utils/promises';
import { verifyModelReports } from './models';
import { createReportCache } from './cache';

export type { NearAIService, NearAICredentials } from './types';

type InferenceClient = ReturnType<NearAISDK['inference']>;

/** NEAR AI Cloud Gateway hosts whose attestation the SDK can verify. */
const NEAR_AI_HOSTS = new Set(['cloud-api.near.ai', 'cloud-stg-api.near.ai']);

/** Matches the SDK's default deployment-verification cache lifetime. */
const ATTESTATION_TTL_MS = 60 * 60 * 1000;

/** Stable error code the client can recognize when attestation blocks a Chat request. */
export const NEAR_AI_ATTESTATION_FAILED: ErrorTypes.NEAR_AI_ATTESTATION_FAILED =
  ErrorTypes.NEAR_AI_ATTESTATION_FAILED;

/**
 * A local 403 in the OpenAI error format. Returning it, rather than throwing, keeps the
 * OpenAI client from treating the block as a connection error that LangChain would retry.
 */
function attestationFailedResponse(model: string, code: string): Response {
  const message = `NEAR AI attestation failed for ${model} (${code}). The message was not sent.`;
  return new Response(
    JSON.stringify({ error: { message, type: NEAR_AI_ATTESTATION_FAILED, code } }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}

export function isNearAIBaseURL(baseURL?: string | null): boolean {
  if (!baseURL) {
    return false;
  }
  try {
    const url = new URL(baseURL);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/v1\/?$/.test(url.pathname) &&
      NEAR_AI_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isNearAIEndpoint(endpoint?: Partial<TEndpoint>): boolean {
  return (
    endpoint?.nearai === true &&
    endpoint.provider !== EModelEndpoint.anthropic &&
    isNearAIBaseURL(extractEnvVariable(endpoint.baseURL ?? ''))
  );
}

type Session = { client: InferenceClient; scope: 'model' | 'gateway'; checkedAt?: string };
type CachedSession = { createdAt: number; pending: Promise<Session>; invalidated?: boolean };
export function createNearAIService(sdk: NearAISDK): NearAIService {
  const clients = new Map<string, CachedSession>();
  const reports = createReportCache();
  const clientKey = ({ apiKey, baseURL, owner }: NearAICredentials, model: string) =>
    JSON.stringify([baseURL, createHash('sha256').update(apiKey).digest('hex'), owner, model]);

  function invalidateSession(key: string): void {
    const entry = clients.get(key);
    if (entry) entry.invalidated = true;
    clients.delete(key);
  }

  function getSession(credentials: NearAICredentials, model: string, fresh = false): CachedSession {
    const key = clientKey(credentials, model);
    const previous = clients.get(key);
    if (previous && !fresh && Date.now() - previous.createdAt < ATTESTATION_TTL_MS) return previous;
    invalidateSession(key);
    const pending = sdk
      .attestation(credentials)
      .fetchModelMetadata(model)
      .then((metadata): Session => {
        const provider = metadata.providerType.trim().toLowerCase();
        if (!['vllm', 'external', 'chutes'].includes(provider)) {
          throw sdk.verificationError('policy.model_attestation_required');
        }
        const privateModel = provider === 'vllm';
        return {
          scope: privateModel ? 'model' : 'gateway',
          client: sdk.inference(credentials, privateModel),
        };
      });
    const entry = { createdAt: Date.now(), pending };
    clients.set(key, entry);
    while (clients.size > (credentials.sessionCacheMax ?? 256)) {
      const oldest = clients.keys().next().value;
      if (oldest == null) break;
      invalidateSession(oldest);
    }
    void pending.catch(() => {
      if (clients.get(key) === entry) clients.delete(key);
    });
    return entry;
  }

  /** Display reports leave Chat's SDK session intact unless explicitly refreshed. */
  async function verifyNearAIModelReports(
    credentials: NearAICredentials,
    model: string,
    options: Pick<TNearAIAttestationParams, 'scope' | 'refresh' | 'force'> = {},
  ): Promise<TNearAIVerificationReport[]> {
    try {
      return await reports(
        {
          identity: clientKey(credentials, model),
          scope: options.scope,
          ttl: credentials.reportCacheTtlMs ?? DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS,
          max: credentials.reportCacheMax ?? 128,
          refresh: options.refresh === true || options.force === true,
        },
        () =>
          verifyModelReports(
            sdk,
            sdk.attestation(credentials),
            model,
            options.scope,
            AbortSignal.timeout(
              credentials.verificationTimeoutMs ?? DEFAULT_NEAR_AI_VERIFICATION_TIMEOUT_MS,
            ),
          ),
      );
    } finally {
      if (options.refresh) {
        invalidateSession(clientKey(credentials, model));
      }
    }
  }

  /**
   * Verifies the Gateway and model deployment for `model`, reusing the SDK cache unless
   * `refresh` is set. Never throws; failures are returned as a `failed` status.
   */
  async function verifyNearAIModel(
    credentials: NearAICredentials,
    model: string,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<NearAIAttestationStatus> {
    return (await verifySession(credentials, model, refresh, signal)).status;
  }

  async function verifySession(
    credentials: NearAICredentials,
    model: string,
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<{ status: NearAIAttestationStatus; client?: InferenceClient }> {
    signal ??= AbortSignal.timeout(
      credentials.verificationTimeoutMs ?? DEFAULT_NEAR_AI_VERIFICATION_TIMEOUT_MS,
    );
    let entry: CachedSession | undefined;
    let result: { status: NearAIAttestationStatus; client?: InferenceClient };
    try {
      signal.throwIfAborted();
      entry = getSession(credentials, model, refresh);
      const session = await detachOnAbort(entry.pending, signal);
      await detachOnAbort(session.client.verify(model), signal);
      session.checkedAt ??= new Date().toISOString();
      result = {
        client: session.client,
        status: {
          model,
          status: session.scope === 'model' ? 'verified' : 'partial',
          scope: session.scope,
          checkedAt: session.checkedAt,
        },
      };
    } catch (error) {
      if (signal.aborted && clients.get(clientKey(credentials, model)) === entry) {
        invalidateSession(clientKey(credentials, model));
      }
      const code = getVerificationErrorCode(error);
      logger.warn(`[nearai] Attestation failed: ${code}`, getSafeErrorMetadata(error));
      result = {
        status: {
          model,
          status: 'failed',
          checkedAt: new Date().toISOString(),
          errorCode: code,
        },
      };
    }
    // Refresh can invalidate the entry before metadata resolves; its own rejection is not a refresh.
    if (!signal.aborted && entry?.invalidated) {
      return verifySession(credentials, model, false, signal);
    }
    return result;
  }

  function readModel(body: RequestInit['body']): string | undefined {
    if (typeof body !== 'string') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(body) as { model?: unknown };
      return typeof parsed.model === 'string' ? parsed.model : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A fetch for the OpenAI client that sends Chat requests through the NEAR AI SDK.
   * The deployment is verified first; on failure the request is never sent upstream.
   */
  function createNearAIFetch(credentials: NearAICredentials): NearAIFetch {
    return async (input, init) => {
      const model = readModel(init?.body);
      if (!model) return attestationFailedResponse('', 'input.invalid');
      const signal = AbortSignal.any([
        AbortSignal.timeout(
          credentials.verificationTimeoutMs ?? DEFAULT_NEAR_AI_VERIFICATION_TIMEOUT_MS,
        ),
        ...(init?.signal ? [init.signal] : []),
      ]);
      const { status, client } = await verifySession(credentials, model, false, signal);
      if (status.status === 'failed' || !client) {
        return attestationFailedResponse(model, status.errorCode ?? 'unknown');
      }
      const response = await client.fetch(input, init);
      const collector = getNearAIReceiptCollector();
      if (!collector || !response.ok) {
        return response;
      }
      return observeCompletionBody(response, (completionId) =>
        collector.add(verifyNearAICompletion(client, model, completionId), () =>
          failedReceipt(
            new DOMException('Signature verification timed out', 'TimeoutError'),
            completionId,
            model,
          ),
        ),
      );
    };
  }

  /** Checks the completion's signature against the exact request and response bytes. */
  async function verifyNearAICompletion(
    client: InferenceClient,
    model: string,
    completionId: string,
  ): Promise<NearAIReceipt> {
    try {
      const result = await client.verifyResponse(completionId);
      const verifiedAt = new Date().toISOString();
      const report = createReplyReport(result, verifiedAt);
      if (!report.ok) {
        logger.warn('[nearai] Verification report unavailable', { code: report.error.code });
      }
      return {
        completionId,
        model,
        status: 'verified',
        verifiedAt,
        signatureKind: result.signatureKind,
        signingAlgo: result.signature.signer.signingAlgo,
        signingAddress: result.signature.signer.signingAddress,
        signedText: result.signature.signedText,
        signature: result.signature.signature,
        ...(report.ok ? { report: report.value } : {}),
      };
    } catch (error) {
      return failedReceipt(error, completionId, model);
    }
  }

  function failedReceipt(error: unknown, completionId: string, model: string): NearAIReceipt {
    const code = getVerificationErrorCode(error);
    logger.warn(`[nearai] Signature verification failed: ${code}`, getSafeErrorMetadata(error));
    const verifiedAt = new Date().toISOString();
    return {
      completionId,
      model,
      status: 'failed',
      verifiedAt,
      errorCode: code,
      report: createFailureReport(error, completionId, model, verifiedAt),
    };
  }

  return {
    createFetch: createNearAIFetch,
    verify: verifyNearAIModel,
    reports: verifyNearAIModelReports,
  };
}
