import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';

import type { MCPRuntimeRequestBody, RequestScopedMCPConnectionStore } from './types';

export type { MCPRuntimeRequestBody } from './types';

/**
 * Builds the complete request context that runtime MCP placeholders may resolve.
 * An explicit null parent means a known root turn and becomes the root sentinel.
 * An omitted parent stays omitted so protocols without parent-message identity
 * fail closed for configurations that require that BODY placeholder.
 */
export function createMCPRuntimeRequestBody({
  messageId,
  conversationId,
  parentMessageId,
  codeEnvironmentMode,
  codeWorkspaces,
}: {
  messageId: string;
  conversationId: string;
  parentMessageId?: string | null;
  codeEnvironmentMode?: MCPRuntimeRequestBody['codeEnvironmentMode'];
  codeWorkspaces?: MCPRuntimeRequestBody['codeWorkspaces'];
}): MCPRuntimeRequestBody {
  return {
    messageId,
    conversationId,
    ...(codeEnvironmentMode !== undefined && { codeEnvironmentMode }),
    ...(codeWorkspaces !== undefined && { codeWorkspaces }),
    ...(parentMessageId !== undefined && {
      parentMessageId: parentMessageId ?? Constants.NO_PARENT,
    }),
  };
}

export interface MCPRequestContext extends RequestScopedMCPConnectionStore {
  cleanupStarted: boolean;
  cleanupOnResponse: boolean;
  responseCleanupAttached: boolean;
}

export interface MCPRequestContextOptions {
  cleanupOnResponse?: boolean;
}

interface MCPResponseLike {
  writableEnded?: boolean;
  finished?: boolean;
  destroyed?: boolean;
  once?: (event: 'finish' | 'close', listener: () => void) => unknown;
}

interface Disconnectable {
  disconnect: () => Promise<unknown> | unknown;
  dispose?: () => Promise<unknown> | unknown;
}

const contexts = new WeakMap<object, MCPRequestContext>();
const cleanupFlights = new WeakMap<RequestScopedMCPConnectionStore, Promise<void>>();
const requestControllers = new WeakMap<RequestScopedMCPConnectionStore, AbortController>();

/** Owned by the occurrence, not an individual connection or mint waiter. */
export function getMCPRequestSignal(context: RequestScopedMCPConnectionStore): AbortSignal {
  let controller = requestControllers.get(context);
  if (!controller) {
    controller = new AbortController();
    requestControllers.set(context, controller);
    if (context.cleanupStarted || context.quiesceStarted)
      controller.abort(new MCPRequestQuiescedError());
  }
  return controller.signal;
}

function abortMCPRequest(context: RequestScopedMCPConnectionStore): void {
  requestControllers.get(context)?.abort(new MCPRequestQuiescedError());
}

/** Completion cancellation is not evidence of withdrawn consent. */
export class MCPRequestQuiescedError extends Error {
  constructor() {
    super('MCP request has settled.');
    this.name = 'AbortError';
  }
}

export function createMCPRequestContext(): MCPRequestContext {
  return {
    connections: new Map<string, unknown>(),
    pending: new Map<string, Promise<unknown>>(),
    cleanupStarted: false,
    cleanupOnResponse: true,
    responseCleanupAttached: false,
  };
}

function isDisconnectable(value: unknown): value is Disconnectable {
  return (
    value != null &&
    typeof value === 'object' &&
    'disconnect' in value &&
    typeof value.disconnect === 'function'
  );
}

/** Stops occurrence work and exposes admission failure to the settlement owner. */
export function quiesceMCPRequestContext(context?: RequestScopedMCPConnectionStore): Promise<void> {
  if (!context) return Promise.resolve();
  context.quiesceStarted = true;
  context.cleanupStarted = true;
  let flight = cleanupFlights.get(context);
  if (!flight) {
    flight = Promise.resolve().then(() => disposeContext(context, true));
    cleanupFlights.set(context, flight);
  }
  // Publish the cutoff and joinable flight before synchronous abort listeners run.
  abortMCPRequest(context);
  return flight;
}

async function disposeContext(
  context: RequestScopedMCPConnectionStore,
  strict = false,
): Promise<void> {
  const connections = new Map<Disconnectable, string>();
  for (const [key, connection] of context.connections) {
    if (isDisconnectable(connection)) connections.set(connection, key);
  }
  try {
    const pending = Array.from(context.pending.entries());
    const settled = await Promise.allSettled(pending.map(([, promise]) => promise));
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === 'fulfilled' && isDisconnectable(result.value))
        connections.set(result.value, pending[index][0]);
    }
    const disposed = await Promise.allSettled(
      Array.from(connections).map(async ([connection, key]) => {
        // Pool eviction is best-effort. Settlement must observe the connection's admission result.
        if (strict && connection.dispose) {
          try {
            await connection.dispose();
          } finally {
            await context.disposeConnection?.(key, connection);
          }
        } else if (context.disposeConnection) await context.disposeConnection(key, connection);
        else if (connection.dispose) await connection.dispose();
        else await connection.disconnect();
      }),
    );
    const failed = disposed.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } finally {
    context.connections.clear();
    context.pending.clear();
  }
}

export async function cleanupMCPRequestContext(context?: MCPRequestContext): Promise<void> {
  if (!context) return;
  let flight = cleanupFlights.get(context);
  if (!flight) {
    if (context.cleanupStarted) {
      abortMCPRequest(context);
      return;
    }
    context.cleanupStarted = true;
    flight = Promise.resolve().then(() => disposeContext(context));
    cleanupFlights.set(context, flight);
  }
  abortMCPRequest(context);
  await flight.catch(() => {
    logger.warn('[MCP Request Context] Failed to dispose request-scoped connection');
  });
}

function isResponseFinished(res?: MCPResponseLike): boolean {
  return Boolean(res?.writableEnded || res?.finished || res?.destroyed);
}

function runCleanup(context: MCPRequestContext): void {
  cleanupMCPRequestContext(context).catch(() => {
    logger.warn('[MCP Request Context] Cleanup failed');
  });
}

function attachResponseCleanup(context: MCPRequestContext, res?: MCPResponseLike): void {
  if (!res || context.responseCleanupAttached || context.cleanupOnResponse === false) {
    return;
  }

  const cleanup = () => runCleanup(context);
  if (isResponseFinished(res)) {
    cleanup();
    return;
  }

  if (typeof res.once !== 'function') {
    return;
  }

  context.responseCleanupAttached = true;
  res.once('finish', cleanup);
  res.once('close', cleanup);

  if (isResponseFinished(res)) {
    cleanup();
  }
}

export function getMCPRequestContext(
  req?: object,
  res?: MCPResponseLike,
  options: MCPRequestContextOptions = {},
): MCPRequestContext | undefined {
  if (!req) {
    return undefined;
  }

  const cleanupOnResponse = options.cleanupOnResponse !== false;
  let context = contexts.get(req);
  if (!context) {
    if (cleanupOnResponse && isResponseFinished(res)) {
      return undefined;
    }

    context = createMCPRequestContext();
    context.cleanupOnResponse = cleanupOnResponse;
    contexts.set(req, context);
  } else if (!cleanupOnResponse) {
    context.cleanupOnResponse = false;
  }

  if (cleanupOnResponse) {
    attachResponseCleanup(context, res);
  }

  return context.cleanupStarted ? undefined : context;
}

export async function cleanupMCPRequestContextForReq(req?: object): Promise<void> {
  if (!req) {
    return;
  }

  const context = contexts.get(req);
  if (!context) {
    return;
  }

  try {
    await cleanupMCPRequestContext(context);
  } finally {
    contexts.delete(req);
  }
}
