import { randomUUID } from 'node:crypto';
import type { CodeBridgeFetch } from './bridge';

interface RequestStatus {
  requestId: string;
  state: 'queued' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: { code: string };
}

/** A failed body read is transport uncertainty, not malformed application data. */
export class WorkspaceResponseTransportError extends Error {}

export interface DurableWorkspaceTransport<TRequest, TResult> {
  baseURL: string;
  request: TRequest;
  /** Fresh caller-owned identity, never an already accepted handle. */
  requestId?: string;
  /** An accepted handle to look up only. Missing/unsupported handles are never submitted. */
  resumeRequestId?: string;
  authHeaders: (signal: AbortSignal) => Promise<Record<string, string>>;
  fetchImpl: CodeBridgeFetch;
  signal?: AbortSignal;
  deadlineAtMs: number;
  completionReserveMs: number;
  transportTimeoutMs: number;
  queueWaitMs: number;
  rateLimitWaitMs: number;
  pollIntervalMs: number;
  readJson: (response: Response, signal: AbortSignal) => Promise<unknown>;
  validateResult: (request: TRequest, value: unknown) => value is TResult;
  rejected: (
    response: Response,
    signal: AbortSignal,
    attempt?: number,
  ) => Promise<{
    error: Error;
    rateLimitDelayMs?: number;
  }>;
  terminalFailure: (code?: string) => Error;
  invalid: () => Error;
  insufficient: () => Error;
  timeout: () => Error;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRequest?: (method: string) => void;
  onRateLimitRejection?: () => void;
  onRateLimitWait?: (waitMs: number) => void;
}

function status(value: unknown, id: string): RequestStatus | undefined {
  if (value == null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    record.requestId !== id ||
    !['queued', 'admitted', 'completed', 'failed', 'cancelled'].includes(String(record.state))
  )
    return;
  const error = record.error;
  if (
    error !== undefined &&
    (error == null ||
      typeof error !== 'object' ||
      typeof (error as Record<string, unknown>).code !== 'string')
  )
    return;
  return {
    requestId: id,
    state: record.state as RequestStatus['state'],
    result: record.result,
    ...(error === undefined ? {} : { error: { code: (error as { code: string }).code } }),
  };
}

function transportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof WorkspaceResponseTransportError ||
    (error instanceof DOMException && error.name === 'TimeoutError')
  );
}

/** Uncertain acceptance is reconciled under one ID; a retained handle is never recreated. */
export async function executeDurableWorkspaceRequest<TRequest, TResult>(
  options: DurableWorkspaceTransport<TRequest, TResult>,
): Promise<{ supported: false } | { supported: true; result: TResult }> {
  const root = options.baseURL.trim().replace(/\/+$/, '');
  const resuming = options.resumeRequestId !== undefined;
  const id = options.resumeRequestId ?? options.requestId ?? randomUUID();
  if ((resuming && options.requestId !== undefined) || !/^[A-Za-z0-9_-]{16,128}$/.test(id))
    throw options.invalid();
  const url = `${root}/workspace-tools/requests/${encodeURIComponent(id)}`;
  const body = JSON.stringify(options.request);
  let submissionStarted = false;
  let accepted = resuming;
  let uncertainSubmission = false;
  let rateLimitWaitedMs = 0;
  let rateLimitRejections = 0;
  let activeMethod: string | undefined;
  let terminal = false;
  let submissionQueueWaitMs: number | undefined;
  let current: RequestStatus | undefined;
  const send = async (
    endpoint: string,
    method: string,
    cancelling = false,
  ): Promise<{ response: Response; signal: AbortSignal } | undefined> => {
    const remaining = cancelling ? options.transportTimeoutMs : options.deadlineAtMs - Date.now();
    if (remaining < 1) throw options.timeout();
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.floor(Math.min(options.transportTimeoutMs, remaining))),
    );
    const signal =
      cancelling || options.signal == null ? timeout : AbortSignal.any([options.signal, timeout]);
    signal.throwIfAborted();
    const headers = await options.authHeaders(signal);
    signal.throwIfAborted();
    if (method === 'POST') {
      const available = Math.floor(options.deadlineAtMs - Date.now() - options.completionReserveMs);
      if (submissionQueueWaitMs === undefined) {
        if (available < 1) throw options.insufficient();
        submissionQueueWaitMs = Math.min(options.queueWaitMs, available);
      } else if (available < submissionQueueWaitMs) {
        // Same-ID resubmission must keep its fingerprint without extending admission.
        // A delayed first POST may still commit. Keep observing it until Stop/deadline.
        return;
      }
      submissionStarted = true;
    }
    activeMethod = method;
    options.onRequest?.(method);
    const response = await options.fetchImpl(endpoint, {
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(method === 'POST'
          ? {
              'X-LibreChat-Workspace-Request-Id': id,
              'X-LibreChat-Workspace-Queue-Wait-Ms': String(submissionQueueWaitMs),
            }
          : {}),
      },
      ...(method === 'POST' ? { body } : {}),
      signal,
      redirect: 'error',
    });
    return { response, signal };
  };
  try {
    const probe = (await send(`${root}/workspace-tools/capabilities`, 'GET'))!;
    if (probe.response.status === 404) {
      await probe.response.body?.cancel().catch(() => undefined);
      if (resuming) throw options.invalid();
      return { supported: false };
    }
    if (!probe.response.ok) throw (await options.rejected(probe.response, probe.signal)).error;
    const capability = await options.readJson(probe.response, probe.signal);
    if (capability == null || typeof capability !== 'object') throw options.invalid();
    const version = (capability as Record<string, unknown>).durableWorkspaceRequests;
    if (version === 0 && !resuming) return { supported: false };
    if (version !== 1) throw options.invalid();
    while (true) {
      options.signal?.throwIfAborted();
      if (current?.state === 'completed') {
        terminal = true;
        if (!options.validateResult(options.request, current.result)) throw options.invalid();
        return { supported: true, result: current.result };
      }
      if (current?.state === 'cancelled') {
        terminal = true;
        throw new DOMException('Workspace request cancelled', 'AbortError');
      }
      if (current?.state === 'failed') {
        terminal = true;
        throw options.terminalFailure(current.error?.code);
      }
      if (Date.now() >= options.deadlineAtMs) throw options.timeout();
      try {
        const lookup = accepted || submissionStarted ? (await send(url, 'GET'))! : undefined;
        if (lookup && lookup.response.status !== 404) {
          if (!lookup.response.ok)
            throw (await options.rejected(lookup.response, lookup.signal)).error;
          // Lookup headers prove the identity existed, even if its body is lost.
          accepted = true;
          current = status(await options.readJson(lookup.response, lookup.signal), id);
          if (current == null) throw options.invalid();
        } else {
          await lookup?.response.body?.cancel().catch(() => undefined);
          if (accepted) throw options.invalid();
          const submitted = await send(`${root}/workspace-tools/requests`, 'POST');
          if (submitted != null) {
            if (submitted.response.status !== 202) {
              const rejection = await options.rejected(
                submitted.response,
                submitted.signal,
                rateLimitRejections + 1,
              );
              if (rejection.rateLimitDelayMs === undefined) throw rejection.error;
              // A typed limiter rejection is definitely pre-admission. Only a fresh,
              // never-uncertain submission may recompute its admission fingerprint.
              if (!uncertainSubmission) {
                submissionStarted = false;
                submissionQueueWaitMs = undefined;
              }
              const delayMs = rejection.rateLimitDelayMs;
              rateLimitRejections++;
              options.onRateLimitRejection?.();
              if (
                !Number.isFinite(delayMs) ||
                delayMs <= 0 ||
                delayMs > options.rateLimitWaitMs - rateLimitWaitedMs ||
                delayMs >= options.deadlineAtMs - Date.now() - options.completionReserveMs
              )
                throw rejection.error;
              const waitedAt = Date.now();
              await options.wait(delayMs, options.signal);
              const waitedMs = Math.max(delayMs, Date.now() - waitedAt);
              rateLimitWaitedMs += waitedMs;
              options.onRateLimitWait?.(waitedMs);
              if (Date.now() >= options.deadlineAtMs - options.completionReserveMs)
                throw rejection.error;
              continue;
            }
            accepted = true;
            current = status(await options.readJson(submitted.response, submitted.signal), id);
            if (current == null) throw options.invalid();
          }
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!transportFailure(error)) throw error;
        if (activeMethod === 'POST') uncertainSubmission = true;
      }
      if (current?.state === 'queued' || current?.state === 'admitted' || current == null) {
        await options.wait(
          Math.min(options.pollIntervalMs, Math.max(1, options.deadlineAtMs - Date.now())),
          options.signal,
        );
      }
    }
  } finally {
    if ((submissionStarted || resuming) && !terminal) {
      // Stop, deadline and protocol failures all retire the same potentially accepted call.
      try {
        const cancelled = (await send(url, 'DELETE', true))!;
        await cancelled.response.body?.cancel();
      } catch {
        /* Unknown cancellation must never authorize replay. */
      }
    }
  }
}
