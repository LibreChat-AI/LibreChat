import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { MCPOptionsSchema } from 'librechat-data-provider';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MCPClientCapabilityProfile } from './capabilities';
import type { MCPOptions, ParsedServerConfig } from './types';
import { STANDARD_MCP_CAPABILITY_PROFILE } from './capabilities';
import { processMCPEnv } from '../utils/env';

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 30_000;

type StableConfigValue =
  | string
  | number
  | boolean
  | null
  | StableConfigValue[]
  | { [key: string]: StableConfigValue | undefined };

function sortConfigValue(value: StableConfigValue): StableConfigValue {
  if (Array.isArray(value)) {
    return value.map(sortConfigValue);
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  const sorted: { [key: string]: StableConfigValue | undefined } = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortConfigValue(value[key] as StableConfigValue);
  }
  return sorted;
}

/** Returns a stable token for the connection-relevant portion of an MCP config. */
export function getMCPAppToolsPublicationGeneration(config: ParsedServerConfig): string {
  /** App replicas can resolve the same stored config through different process environments during
   * a rolling deployment. Address the catalog by the effective runtime config so an old replica's
   * live connection cannot publish into the new replica's slice. DB-sourced configs deliberately
   * remain literal because processMCPEnv derives that rule from dbId. */
  /** Keep both header maps: a request override can hide a catalog-only change. */
  let runtimeConfig = processMCPEnv({ options: config });
  if ('requestHeaders' in config && config.requestHeaders != null) {
    const requestConfig = processMCPEnv({
      options: { ...config, apiKey: undefined, headers: config.requestHeaders },
    });
    if ('headers' in requestConfig && 'requestHeaders' in runtimeConfig) {
      runtimeConfig = { ...runtimeConfig, requestHeaders: requestConfig.headers };
    }
  }
  const parsedConfig = MCPOptionsSchema.parse(runtimeConfig) as StableConfigValue;
  return createHash('sha256')
    .update(JSON.stringify(sortConfigValue(parsedConfig)))
    .digest('hex');
}

/** Addresses catalogs by both configuration and the capabilities that produced them. */
export function getMCPToolCatalogGeneration(
  config: ParsedServerConfig,
  capabilityProfile: MCPClientCapabilityProfile = STANDARD_MCP_CAPABILITY_PROFILE,
): string {
  return createHash('sha256')
    .update(JSON.stringify([getMCPAppToolsPublicationGeneration(config), capabilityProfile]))
    .digest('hex');
}

/** A complete tool-list snapshot and the cache scope it belongs to. */
export interface MCPToolsChangedEvent {
  serverName: string;
  tools: Tool[];
  serverConfig: MCPOptions;
  userId?: string;
  capabilityProfile?: MCPClientCapabilityProfile;
  /** Connection-bound token used to fence stale cross-replica cache publications. */
  publicationGeneration?: string;
  /** Monotonic ticket assigned before an app-level tools/list request begins. */
  publicationRevision?: string;
}

export type MCPToolsChangedHandler = (event: MCPToolsChangedEvent) => Promise<void> | void;

interface PendingToolsChange {
  latest: MCPToolsChangedEvent;
  generation: number;
  handledGeneration: number;
  failures: number;
  refreshPromise: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

let handler: MCPToolsChangedHandler | null = null;
const pendingChanges = new Map<string, PendingToolsChange>();

type MCPToolsChangedScope = Pick<MCPToolsChangedEvent, 'serverName' | 'userId'>;
type MCPToolsChangedPublicationScope = MCPToolsChangedScope & {
  capabilityProfile?: MCPClientCapabilityProfile;
};

export type MCPToolsChangedGenerationHandler = (
  scope: MCPToolsChangedScope,
) => Promise<string | undefined> | string | undefined;

let generationHandler: MCPToolsChangedGenerationHandler | null = null;

export type MCPToolsChangedGenerationRenewalHandler = (
  scope: MCPToolsChangedScope & { publicationGeneration: string },
) => Promise<boolean> | boolean;

let generationRenewalHandler: MCPToolsChangedGenerationRenewalHandler | null = null;

export type MCPToolsChangedRevisionHandler = (scope: {
  serverName: string;
  configGeneration: string;
}) => Promise<string> | string;

let revisionHandler: MCPToolsChangedRevisionHandler | null = null;

function getChangeKey(event: MCPToolsChangedPublicationScope): string {
  return JSON.stringify([
    event.userId ?? null,
    event.serverName,
    event.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE,
  ]);
}

function clearRetryTimer(change: PendingToolsChange): void {
  if (change.retryTimer) {
    clearTimeout(change.retryTimer);
    change.retryTimer = null;
  }
}

function scheduleRetry(key: string, change: PendingToolsChange): void {
  if (change.retryTimer || !handler || pendingChanges.get(key) !== change) {
    return;
  }

  const delay = Math.min(
    RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, change.failures - 1)),
    RETRY_MAX_DELAY_MS,
  );
  change.retryTimer = setTimeout(() => {
    change.retryTimer = null;
    startDispatch(key, change);
  }, delay);
  change.retryTimer.unref?.();
}

async function dispatchPendingChange(key: string, change: PendingToolsChange): Promise<void> {
  while (handler && change.handledGeneration < change.generation) {
    const targetGeneration = change.generation;
    const event = change.latest;
    try {
      await handler(event);
      change.handledGeneration = targetGeneration;
      change.failures = 0;
    } catch (error) {
      change.failures++;
      logger.error(
        `[MCP][${event.serverName}] Failed to publish tools after list_changed; retrying:`,
        error,
      );
      scheduleRetry(key, change);
      return;
    }
  }
}

function startDispatch(key: string, change: PendingToolsChange): Promise<void> {
  if (change.refreshPromise) {
    return change.refreshPromise;
  }

  change.refreshPromise = dispatchPendingChange(key, change).finally(() => {
    change.refreshPromise = null;
    if (!handler || pendingChanges.get(key) !== change) {
      return;
    }
    if (change.handledGeneration >= change.generation) {
      pendingChanges.delete(key);
    } else if (!change.retryTimer) {
      return startDispatch(key, change);
    }
  });
  return change.refreshPromise;
}

/** Registers the app-layer publisher for refreshed MCP tool snapshots. */
export function setMCPToolsChangedHandler(fn: MCPToolsChangedHandler | null): void {
  handler = fn;
  if (!fn) {
    for (const change of pendingChanges.values()) {
      clearRetryTimer(change);
    }
    pendingChanges.clear();
  }
}

export function hasMCPToolsChangedHandler(): boolean {
  return handler != null;
}

/** Registers the app-layer provider for connection-bound publication generations. */
export function setMCPToolsChangedGenerationHandler(
  fn: MCPToolsChangedGenerationHandler | null,
): void {
  generationHandler = fn;
}

/** Registers the app-layer lease renewer for active durable user connections. */
export function setMCPToolsChangedGenerationRenewalHandler(
  fn: MCPToolsChangedGenerationRenewalHandler | null,
): void {
  generationRenewalHandler = fn;
}

/** Registers the shared app-catalog revision allocator. */
export function setMCPToolsChangedRevisionHandler(fn: MCPToolsChangedRevisionHandler | null): void {
  revisionHandler = fn;
}

/** Captures the current cache generation before a durable user connection is created. */
export async function getMCPToolsChangedGeneration(
  scope: MCPToolsChangedScope,
): Promise<string | undefined> {
  return generationHandler?.(scope);
}

/** Renews a connection's publication lease without allowing a stale generation to revive. */
export async function renewMCPToolsChangedGeneration(
  scope: MCPToolsChangedScope & { publicationGeneration: string },
): Promise<boolean | undefined> {
  return generationRenewalHandler?.(scope);
}

/** Reserves ordering before an app-level tools/list request starts. */
export async function reserveMCPToolsChangedRevision(scope: {
  serverName: string;
  serverConfig: ParsedServerConfig;
  userId?: string;
  capabilityProfile?: MCPClientCapabilityProfile;
}): Promise<string | undefined> {
  if (scope.userId || !revisionHandler) {
    return undefined;
  }
  return revisionHandler({
    serverName: scope.serverName,
    configGeneration: getMCPToolCatalogGeneration(scope.serverConfig, scope.capabilityProfile),
  });
}

/**
 * Publishes the latest snapshot for a server. Concurrent notifications are single-flighted and
 * cache-write failures retain the latest snapshot for bounded-backoff retries.
 */
export async function notifyMCPToolsChanged(event: MCPToolsChangedEvent): Promise<void> {
  if (!handler) {
    logger.debug(
      `[MCP][${event.serverName}] Tool list changed but no handler is registered; tools stay as they were`,
    );
    return;
  }

  const key = getChangeKey(event);
  let change = pendingChanges.get(key);
  if (!change) {
    change = {
      latest: event,
      generation: 0,
      handledGeneration: 0,
      failures: 0,
      refreshPromise: null,
      retryTimer: null,
    };
    pendingChanges.set(key, change);
  }

  change.latest = event;
  change.generation++;
  clearRetryTimer(change);
  await startDispatch(key, change);
}

/** Cancels queued retries and drains an in-flight publication before cache invalidation. */
export async function cancelMCPToolsChanged(scope: MCPToolsChangedPublicationScope): Promise<void> {
  const key = getChangeKey(scope);
  const change = pendingChanges.get(key);
  if (!change) {
    return;
  }
  pendingChanges.delete(key);
  clearRetryTimer(change);
  change.generation = change.handledGeneration;
  await change.refreshPromise;
}
