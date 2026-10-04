import { randomUUID } from 'node:crypto';
import type { WorkspaceToolRequest, WorkspaceToolResult } from './workspace';
import type { CodeBridgeFetch } from './bridge';

interface RequestStatus {
  requestId: string;
  state: 'queued' | 'admitted' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: { code: string; message: string };
}

export interface DurableWorkspaceTransport {
  baseURL: string;
  request: WorkspaceToolRequest;
  requestId?: string;
  authHeaders: (signal: AbortSignal) => Promise<Record<string, string>>;
  fetchImpl: CodeBridgeFetch;
  signal?: AbortSignal;
  deadlineAtMs: number;
  transportTimeoutMs: number;
  queueWaitMs: number;
  pollIntervalMs: number;
  readJson: (response: Response, signal: AbortSignal) => Promise<unknown>;
  validateResult: (request: WorkspaceToolRequest, value: unknown) => value is WorkspaceToolResult;
  rejected: (response: Response, signal: AbortSignal) => Promise<Error>;
  invalid: () => Error;
  timeout: () => Error;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function status(value: unknown, id: string): RequestStatus | undefined {
  if (value == null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    record.requestId !== id ||
    !['queued', 'admitted', 'completed', 'failed', 'cancelled'].includes(String(record.state))
  )
    return;
  if (
    record.error !== undefined &&
    (record.error == null ||
      typeof record.error !== 'object' ||
      typeof (record.error as Record<string, unknown>).code !== 'string')
  )
    return;
  return record as unknown as RequestStatus;
}

/** A transport timeout never creates a second logical invocation or falls back after acceptance. */
export async function executeDurableWorkspaceRequest(
  options: DurableWorkspaceTransport,
): Promise<{ supported: false } | { supported: true; result: WorkspaceToolResult }> {
  const root = options.baseURL.trim().replace(/\/+$/, '');
  const id = options.requestId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw options.invalid();
  const url = `${root}/workspace-tools/requests/${encodeURIComponent(id)}`;
  const body = JSON.stringify(options.request);
  let submissionStarted = false;
  let current: RequestStatus | undefined;
  const send = async (
    endpoint: string,
    method: string,
    payload?: string,
    cancelling = false,
  ): Promise<{ response: Response; signal: AbortSignal }> => {
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
    const response = await options.fetchImpl(endpoint, {
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(method === 'POST'
          ? {
              'X-LibreChat-Workspace-Request-Id': id,
              'X-LibreChat-Workspace-Queue-Wait-Ms': String(options.queueWaitMs),
            }
          : {}),
      },
      ...(payload === undefined ? {} : { body: payload }),
      signal,
      redirect: 'error',
    });
    return { response, signal };
  };
  try {
    const probe = await send(`${root}/workspace-tools/capabilities`, 'GET');
    if (probe.response.status === 404) {
      await probe.response.body?.cancel();
      return { supported: false };
    }
    if (!probe.response.ok) throw await options.rejected(probe.response, probe.signal);
    const capability = await options.readJson(probe.response, probe.signal);
    if (capability == null || typeof capability !== 'object') throw options.invalid();
    const version = (capability as Record<string, unknown>).durableWorkspaceRequests;
    if (version === 0) return { supported: false };
    if (version !== 1) throw options.invalid();
    while (Date.now() < options.deadlineAtMs) {
      options.signal?.throwIfAborted();
      if (current?.state === 'completed') {
        if (!options.validateResult(options.request, current.result)) throw options.invalid();
        return { supported: true, result: current.result };
      }
      if (current?.state === 'cancelled')
        throw new DOMException('Workspace request cancelled', 'AbortError');
      if (current?.state === 'failed') {
        // Only the approved code crosses the boundary. Upstream messages can contain submitted text.
        const response = new Response(
          JSON.stringify({
            code:
              current.error?.code != null && /^[A-Z][A-Z_]{0,63}$/.test(current.error.code)
                ? current.error.code
                : 'WORKSPACE_TOOL_REJECTED',
          }),
          { status: 422 },
        );
        throw await options.rejected(response, AbortSignal.timeout(options.transportTimeoutMs));
      }
      try {
        const lookup = submissionStarted ? await send(url, 'GET') : undefined;
        if (lookup && lookup.response.status !== 404) {
          if (!lookup.response.ok) throw await options.rejected(lookup.response, lookup.signal);
          current = status(await options.readJson(lookup.response, lookup.signal), id);
          if (current == null) throw options.invalid();
        } else {
          await lookup?.response.body?.cancel();
          // Only recover a lost submission response. A formerly observed handle is never recreated after 404.
          if (current != null) throw options.invalid();
          submissionStarted = true;
          const submitted = await send(`${root}/workspace-tools/requests`, 'POST', body);
          if (submitted.response.status !== 202)
            throw await options.rejected(submitted.response, submitted.signal);
          current = status(await options.readJson(submitted.response, submitted.signal), id);
          if (current == null) throw options.invalid();
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        // GET and same-ID recovery are safe, but malformed or explicit rejection responses are not retries.
        if (
          !(error instanceof TypeError) &&
          !(error instanceof DOMException && error.name === 'TimeoutError')
        )
          throw error;
      }
      if (current?.state === 'queued' || current?.state === 'admitted' || current == null) {
        await options.wait(
          Math.min(options.pollIntervalMs, Math.max(1, options.deadlineAtMs - Date.now())),
          options.signal,
        );
      }
    }
    throw options.timeout();
  } finally {
    if (
      submissionStarted &&
      (options.signal?.aborted === true || Date.now() >= options.deadlineAtMs)
    ) {
      // Stop is independent of the expired foreground signal and targets the same upstream identity.
      try {
        const cancelled = await send(url, 'DELETE', undefined, true);
        await cancelled.response.body?.cancel();
      } catch {
        /* Unknown cancellation must never authorize replay. */
      }
    }
  }
}
