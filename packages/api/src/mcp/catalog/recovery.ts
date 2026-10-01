import { logger } from '@librechat/data-schemas';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IUser } from '@librechat/data-schemas';
import type { LCAvailableTools, ParsedServerConfig, ToolDiscoveryOptions } from '../types';
import type { MCPClientCapabilityProfile } from '../capabilities';
import { MCP_APPS_CAPABILITY_PROFILE, STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { hasCustomUserVars, waitUntilDeadline, getMissingCustomUserVars } from '../utils';
import { usesDirectOpenIDBearerRecovery } from '../openid';
import { getServerCustomUserVars } from '../auth';
import { mcpConfig } from '../mcpConfig';

/** Bounds all outbound catalog reads across this runtime. */
const CATALOG_FANOUT_CONCURRENCY = 3;
const activeCatalogLanes = new Set<CatalogWorkLane>();
const pendingCatalogLanes: CatalogWorkLane[] = [];
let activeCatalogWork = 0;
/**
 * Bounds one server's discovery end to end — connect, `tools/list` pagination, and the
 * unauthenticated fallback all draw down this single budget. Recovery targets a server that is
 * reachable and authorized but whose catalog cache expired, and such a server answers well inside
 * this window. The settle grace lets a discovery that honored the budget finish closing its
 * connections; past it, recovery releases the slot even if some dependency is still stalled. By
 * default no more released discoveries may still run than there are catalog slots, the most work a
 * stalled dependency could hold before discoveries were released.
 */
const DEFAULT_RECOVERY_POLICY: MCPServerCatalogRecoveryPolicy = {
  discoveryBackoffMs: [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000],
  discoveryTimeoutMs: 3_000,
  discoverySettleGraceMs: 10_000,
  reauthRetryMs: 30 * 60_000,
  maxStateEntries: 10_000,
  maxDetachedDiscoveries: CATALOG_FANOUT_CONCURRENCY,
  generationReadTimeoutMs: 500,
  authorizationFenceRetryMs: [0, 50, 200],
  authorizationFenceTimeoutMs: 1_000,
  authorizationFenceRetryIntervalMs: 30_000,
  authorizationFenceRetryBatchSize: 100,
};

export interface MCPServerCatalogRecoveryInput {
  serverName: string;
  serverConfig: ParsedServerConfig;
  capabilityProfile?: MCPClientCapabilityProfile;
}

export interface MCPServerCatalogRecoveryDeps {
  loadUserMCPAuthMap: (
    userId: string,
    serverNames: readonly string[],
  ) => Promise<Record<string, Record<string, string>>>;
  discoverServerTools: (options: ToolDiscoveryOptions) => Promise<{
    tools: Tool[] | null;
    oauthRequired?: boolean;
    authenticationKind?: 'oauth' | 'obo' | 'server';
  }>;
  formatServerTools: (serverName: string, tools: Tool[]) => LCAvailableTools;
  recoveryTracker?: MCPServerCatalogRecoveryTracker;
  getRecoveryGeneration?: MCPRecoveryGenerationReader;
  /** Fences a credential refresh performed during discovery; recovery observes what it publishes. */
  onOAuthCredentialsChanging?: ToolDiscoveryOptions['onOAuthCredentialsChanging'];
}

export interface MCPRecoveryGenerationScope {
  userId: string;
  serverName: string;
}

export type MCPRecoveryGenerationReader = (
  scope: MCPRecoveryGenerationScope,
) => Promise<string | undefined>;

const AUTHORIZATION_FENCE_RETRY_DELAYS_MS = [0, 50, 200] as const;

/** Rejects with `message` when `operation` has not settled within `timeoutMs`. */
async function withinTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

export async function publishMCPAuthorizationMutation(
  scope: MCPRecoveryGenerationScope,
  deps: {
    invalidateRecoveryGeneration: (scope: MCPRecoveryGenerationScope) => Promise<unknown>;
    /** Receives the generation the publication wrote, when it reports one. */
    clearLocalRecovery?: (userId: string, serverName: string, generation?: string) => void;
    persistPublicationRetry?: (scope: MCPRecoveryGenerationScope) => Promise<string>;
    clearPublicationRetry?: (
      scope: MCPRecoveryGenerationScope,
      publicationRetryVersion: string,
    ) => Promise<void>;
    retryDelaysMs?: readonly number[];
    attemptTimeoutMs?: number;
  },
): Promise<string | undefined> {
  /** Persist retry intent before touching the shared cache. A credential writer can keep this
   * inside its rollback boundary, so a cache outage never leaves a committed mutation with no
   * durable path to fence other replicas. */
  const publicationRetryVersion = await deps.persistPublicationRetry?.(scope);
  const attemptTimeoutMs =
    deps.attemptTimeoutMs ?? DEFAULT_RECOVERY_POLICY.authorizationFenceTimeoutMs;
  let lastError: unknown;
  for (const delayMs of deps.retryDelaysMs ?? AUTHORIZATION_FENCE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const published = await withinTimeout(
        deps.invalidateRecoveryGeneration(scope),
        attemptTimeoutMs,
        'MCP authorization generation publication timed out',
      );
      const generation =
        typeof published === 'string' && published.length > 0 ? published : undefined;
      try {
        if (publicationRetryVersion != null && deps.clearPublicationRetry != null) {
          await withinTimeout(
            deps.clearPublicationRetry(scope, publicationRetryVersion),
            attemptTimeoutMs,
            'MCP authorization retry intent cleanup timed out',
          );
        }
      } catch (error) {
        /** A leftover retry only advances the opaque generation again and is therefore safe, so
         *  cleanup is bounded rather than allowed to hold every waiter on this publication. */
        logger.warn(
          `[MCP authorization] Published generation for ${scope.serverName} but could not clear its retry intent`,
          error,
        );
      }
      deps.clearLocalRecovery?.(scope.userId, scope.serverName, generation);
      return generation;
    } catch (error) {
      lastError = error;
      logger.warn(
        `[MCP authorization] Failed to publish credential generation for ${scope.serverName}; retrying`,
        error,
      );
    }
  }
  throw lastError;
}

export interface MCPServerCatalogRecoveryPolicy {
  discoveryBackoffMs: readonly number[];
  discoveryTimeoutMs: number;
  /** How long past its budget a discovery may keep its catalog slot and coalesced requests. */
  discoverySettleGraceMs: number;
  reauthRetryMs: number;
  maxStateEntries: number;
  /** How many released discoveries may still run before no new discovery starts. */
  maxDetachedDiscoveries: number;
  generationReadTimeoutMs: number;
  authorizationFenceRetryMs: readonly number[];
  authorizationFenceTimeoutMs: number;
  authorizationFenceRetryIntervalMs: number;
  authorizationFenceRetryBatchSize: number;
}

export interface MCPServerCatalogSnapshot {
  tools: LCAvailableTools | null;
  publicationGeneration?: string;
  publicationRevision?: string;
}

export interface MCPServerCatalogLoaderDeps extends MCPServerCatalogRecoveryDeps {
  getCachedServerTools: (
    userId: string,
    serverName: string,
    serverConfig: ParsedServerConfig,
    capabilityProfile?: MCPClientCapabilityProfile,
  ) => Promise<LCAvailableTools | null>;
  getServerToolFunctionsSnapshot: (
    userId: string,
    serverName: string,
    serverConfig: ParsedServerConfig,
    options?: {
      deadlineMs?: number;
      signal?: AbortSignal;
      capabilityProfile?: MCPClientCapabilityProfile;
    },
  ) => Promise<MCPServerCatalogSnapshot>;
  cacheServerTools: (params: {
    userId: string;
    serverName: string;
    serverTools: LCAvailableTools;
    serverConfig: ParsedServerConfig;
    publicationGeneration?: string;
    publicationRevision?: string;
    capabilityProfile?: MCPClientCapabilityProfile;
  }) => Promise<void>;
}

export interface MCPServerCatalogLoaderResult {
  serverTools: Map<string, LCAvailableTools>;
  serversWithoutTools: string[];
  reauthRequiredServers: Set<string>;
  reauthRequiredGenerations: Map<string, string | undefined>;
}

interface MCPServerCatalogRecoveryResult {
  serverTools: Map<string, LCAvailableTools>;
  reauthRequiredServers: Set<string>;
  reauthRequiredGenerations: Map<string, string | undefined>;
}

interface MCPServerCatalogEntry extends MCPServerCatalogSnapshot {
  serverName: string;
  serverConfig: ParsedServerConfig;
  capabilityProfile?: MCPClientCapabilityProfile;
  source: 'cache' | 'snapshot';
}

interface RecoveryCandidate extends MCPServerCatalogRecoveryInput {
  customUserVars?: Record<string, string>;
}

type RecoveryOutcome = {
  serverName: string;
  tools: LCAvailableTools | null;
  state?: 'reauth_required' | 'backoff';
  recoveryGeneration?: string;
  /** Marks a flight's own result when its generation came from its own publication; never retained. */
  adopted?: boolean;
  /** Marks a flight's own result when a clear for another generation spared it; never retained. */
  unconfirmed?: boolean;
};

interface RecoveryStateEntry {
  configFingerprint: string;
  recoveryGeneration?: string;
  failureCount: number;
  nextRetryAt: number;
  lastTouchedAt: number;
  outcome?: RecoveryOutcome;
  inFlight?: Promise<RecoveryOutcome>;
  /** Whether this flight's own discovery has a credential publication open. */
  publishing?: boolean;
  /** Generations carried by publication clears that spared this flight while it was in flight. */
  sparedClears?: string[];
}

/** Runs a credential publication made by a flight's own discovery and returns what it wrote. */
type PublicationTracker = (
  publish: () => Promise<string | undefined>,
) => Promise<string | undefined>;

/** Hands the tracker a discovery released past its settle grace that is still running. */
type DiscoveryDetacher = (discovery: Promise<unknown>) => void;

/** The observed state a released discovery ran under; it holds only an attempt that matches it. */
interface DetachedDiscovery {
  configFingerprint: string;
  recoveryGeneration?: string;
}

interface CatalogWorkLane {
  tasks: ReadonlyArray<() => Promise<void>>;
  resolve: (admitted: boolean) => void;
  nextIndex: number;
  inFlight: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class MCPCatalogCapacityError extends Error {
  readonly code = 'MCP_CATALOG_CAPACITY';

  constructor() {
    super('MCP catalog capacity is temporarily exhausted');
    this.name = 'MCPCatalogCapacityError';
  }
}

/** Reads the cross-replica credential fence without making status or recovery depend on shared
 * cache availability. The application supplies the cache implementation at its wiring boundary. */
export async function readMCPRecoveryGeneration(
  scope: MCPRecoveryGenerationScope,
  reader?: MCPRecoveryGenerationReader,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string | undefined> {
  if (reader == null || options?.signal?.aborted) {
    return undefined;
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RECOVERY_POLICY.generationReadTimeoutMs;
  let timeoutId: number | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader(scope),
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(resolve, timeoutMs);
        if (options?.signal != null) {
          onAbort = () => resolve(undefined);
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } catch (error) {
    logger.debug(
      `[MCP catalog recovery] Could not read shared generation for ${scope.serverName}; using process-local state`,
      error,
    );
    return undefined;
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
    if (onAbort != null) {
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export async function readMCPRecoveryGenerationAround<T>(
  scope: MCPRecoveryGenerationScope,
  reader: MCPRecoveryGenerationReader | undefined,
  operation: () => Promise<T>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ value: T; generation?: string }> {
  const before = await readMCPRecoveryGeneration(scope, reader, options);
  const value = await operation();
  const after = await readMCPRecoveryGeneration(scope, reader, options);
  return {
    value,
    ...(before != null && before === after && { generation: before }),
  };
}

/** Bounds one server's discovery, honouring the shorter configured limit. */
function resolveBudget(
  serverConfig: ParsedServerConfig,
  policy: MCPServerCatalogRecoveryPolicy,
): number {
  const { initTimeout } = serverConfig;
  if (typeof initTimeout === 'number') {
    return Math.min(initTimeout, policy.discoveryTimeoutMs);
  }
  return policy.discoveryTimeoutMs;
}

function getRecoveryKey(
  userId: string,
  serverName: string,
  capabilityProfile: MCPClientCapabilityProfile = STANDARD_MCP_CAPABILITY_PROFILE,
): string {
  return JSON.stringify([userId, serverName, capabilityProfile]);
}

function getRecoveryFingerprint(
  serverConfig: ParsedServerConfig,
  policy: MCPServerCatalogRecoveryPolicy,
  capabilityProfile: MCPClientCapabilityProfile = STANDARD_MCP_CAPABILITY_PROFILE,
): string {
  return JSON.stringify([serverConfig, policy, capabilityProfile]);
}

export class MCPServerCatalogRecoveryTracker {
  private readonly states = new Map<string, RecoveryStateEntry>();
  /** Discoveries released past their settle grace that are still running, by recovery key. */
  private readonly detachedDiscoveries = new Map<string, DetachedDiscovery[]>();
  private detachedDiscoveryCount = 0;

  constructor(
    private readonly maxStateEntries: number = DEFAULT_RECOVERY_POLICY.maxStateEntries,
    private readonly maxDetachedDiscoveries: number = DEFAULT_RECOVERY_POLICY.maxDetachedDiscoveries,
  ) {}

  /** Whether a request-bound discovery, which never joins a flight, may start. */
  public admitsDiscovery(
    user: IUser,
    candidate: RecoveryCandidate,
    policy: MCPServerCatalogRecoveryPolicy,
  ): boolean {
    return !this.isDiscoveryHeld(
      getRecoveryKey(user.id, candidate.serverName, candidate.capabilityProfile),
      getRecoveryFingerprint(candidate.serverConfig, policy, candidate.capabilityProfile),
      undefined,
    );
  }

  /** Counts a request-bound discovery released past its settle grace until it settles. */
  public detachDiscovery(
    user: IUser,
    candidate: RecoveryCandidate,
    policy: MCPServerCatalogRecoveryPolicy,
    discovery: Promise<unknown>,
  ): void {
    this.detach(
      getRecoveryKey(user.id, candidate.serverName, candidate.capabilityProfile),
      {
        configFingerprint: getRecoveryFingerprint(
          candidate.serverConfig,
          policy,
          candidate.capabilityProfile,
        ),
      },
      discovery,
    );
  }

  /**
   * A released discovery keeps running, so another attempt under the same observed state would stack
   * on the same stuck dependency. Released discoveries also share one process-wide limit: once that
   * many still run, no new discovery starts until one settles. A changed configuration or credential
   * generation is new state and may discover within that limit. Only settling lifts a hold; clears
   * do not. Discoveries already running when the limit fills can still be released, so the count
   * can exceed it by at most the catalog concurrency.
   */
  private isDiscoveryHeld(
    key: string,
    configFingerprint: string,
    recoveryGeneration: string | undefined,
  ): boolean {
    if (this.detachedDiscoveryCount >= this.maxDetachedDiscoveries) {
      return true;
    }
    return (
      this.detachedDiscoveries
        .get(key)
        ?.some(
          (detached) =>
            detached.configFingerprint === configFingerprint &&
            (recoveryGeneration == null || detached.recoveryGeneration === recoveryGeneration),
        ) === true
    );
  }

  private detach(key: string, detached: DetachedDiscovery, discovery: Promise<unknown>): void {
    const held = this.detachedDiscoveries.get(key);
    if (held == null) {
      this.detachedDiscoveries.set(key, [detached]);
    } else {
      held.push(detached);
    }
    this.detachedDiscoveryCount += 1;
    if (this.detachedDiscoveryCount === this.maxDetachedDiscoveries) {
      logger.warn(
        `[MCP catalog recovery] Released discoveries still running reached the limit of ${this.maxDetachedDiscoveries}; starting no new discovery until one settles`,
      );
    }
    const release = () => {
      const current = this.detachedDiscoveries.get(key);
      const index = current?.indexOf(detached) ?? -1;
      if (current == null || index < 0) {
        return;
      }
      current.splice(index, 1);
      if (current.length === 0) {
        this.detachedDiscoveries.delete(key);
      }
      this.detachedDiscoveryCount -= 1;
    };
    discovery.then(release, release);
  }

  private touch(key: string, entry: RecoveryStateEntry): void {
    if (this.states.get(key) !== entry) {
      return;
    }
    this.states.delete(key);
    this.states.set(key, entry);
  }

  /**
   * Clears suppression after a credential/config mutation commits. A clear from a publication
   * carries the generation it wrote; see `clearState` for the state it spares.
   */
  public clear(
    userId: string,
    serverName?: string,
    generation?: string,
    capabilityProfile?: MCPClientCapabilityProfile,
  ): void {
    if (serverName != null) {
      if (capabilityProfile != null) {
        this.clearState(getRecoveryKey(userId, serverName, capabilityProfile), generation);
        return;
      }
      this.clearState(
        getRecoveryKey(userId, serverName, STANDARD_MCP_CAPABILITY_PROFILE),
        generation,
      );
      this.clearState(getRecoveryKey(userId, serverName, MCP_APPS_CAPABILITY_PROFILE), generation);
      return;
    }
    for (const key of this.states.keys()) {
      if ((JSON.parse(key) as unknown[])[0] === userId) {
        this.clearState(key, generation);
      }
    }
  }

  /**
   * A clear from a publication carries the generation it wrote, which only signals that the shared
   * generation advanced. Generations carry no order, so that signal cannot tell whether a flight
   * still in flight predates it: such a flight, when it has a known generation or is publishing its
   * own change, is spared and records the generation, and settles against it once it finishes
   * (see `run`). Any other state is cleared, as is everything on a clear that carries no generation.
   */
  private clearState(key: string, generation: string | undefined): void {
    const entry = this.states.get(key);
    if (entry == null) {
      return;
    }
    if (
      generation != null &&
      entry.inFlight != null &&
      (entry.recoveryGeneration != null || entry.publishing === true)
    ) {
      entry.sparedClears = [...(entry.sparedClears ?? []), generation];
      return;
    }
    this.states.delete(key);
  }

  public run(
    user: IUser,
    candidate: RecoveryCandidate,
    policy: MCPServerCatalogRecoveryPolicy,
    recoveryGeneration: string | undefined,
    discover: (
      trackPublication: PublicationTracker,
      detach: DiscoveryDetacher,
    ) => Promise<RecoveryOutcome>,
  ): Promise<RecoveryOutcome> {
    const key = getRecoveryKey(user.id, candidate.serverName, candidate.capabilityProfile);
    const configFingerprint = getRecoveryFingerprint(
      candidate.serverConfig,
      policy,
      candidate.capabilityProfile,
    );
    const now = Date.now();
    const existing = this.states.get(key);
    const held = this.isDiscoveryHeld(key, configFingerprint, recoveryGeneration);
    const sameObservedState =
      existing?.configFingerprint === configFingerprint &&
      (recoveryGeneration == null ||
        existing.recoveryGeneration === recoveryGeneration ||
        (existing.inFlight != null && existing.publishing === true));
    if (sameObservedState) {
      existing.lastTouchedAt = now;
      this.touch(key, existing);
      if (existing.inFlight != null) {
        return existing.inFlight;
      }
      if (existing.outcome != null && (held || existing.nextRetryAt > now)) {
        return Promise.resolve(existing.outcome);
      }
    }
    if (held) {
      return Promise.resolve({ serverName: candidate.serverName, tools: null });
    }

    const entry: RecoveryStateEntry = {
      configFingerprint,
      recoveryGeneration:
        recoveryGeneration ?? (sameObservedState ? existing?.recoveryGeneration : undefined),
      failureCount: sameObservedState ? existing.failureCount : 0,
      nextRetryAt: 0,
      lastTouchedAt: now,
    };
    let settled = false;
    let adopted = false;
    /**
     * A credential refresh inside discovery writes a new shared generation, then clears local
     * recovery state with it, and only then reports what it wrote. While that bounded publication is
     * open, requests for the same server join this flight, so a request that already reads the new
     * generation does not start a second discovery; the refresh's own clear spares the flight (see
     * `clearState`). A flight that is still current once the publication completes adopts the
     * generation it wrote.
     */
    const trackPublication: PublicationTracker = async (publish) => {
      if (settled || entry.publishing === true || this.states.get(key) !== entry) {
        return publish();
      }
      entry.publishing = true;
      try {
        const published = await publish();
        if (published != null && !settled && this.states.get(key) === entry) {
          entry.recoveryGeneration = published;
          adopted = true;
        }
        return published;
      } finally {
        entry.publishing = false;
      }
    };
    const detach: DiscoveryDetacher = (discovery) =>
      this.detach(
        key,
        { configFingerprint, recoveryGeneration: entry.recoveryGeneration },
        discovery,
      );
    const flight = Promise.resolve()
      .then(() => discover(trackPublication, detach))
      .finally(() => {
        settled = true;
      })
      .then((outcome) => {
        if (this.states.get(key) !== entry) {
          return { serverName: candidate.serverName, tools: null };
        }
        entry.lastTouchedAt = Date.now();
        this.touch(key, entry);
        outcome.recoveryGeneration = entry.recoveryGeneration;
        /** A clear for a generation this flight did not finish under may be newer than it, so the
         *  outcome must be confirmed against the shared generation and is never retained. */
        const unconfirmed = (entry.sparedClears ?? []).some(
          (generation) => generation !== entry.recoveryGeneration,
        );
        if (unconfirmed) {
          this.states.delete(key);
          if (entry.recoveryGeneration == null) {
            return { serverName: candidate.serverName, tools: null };
          }
        } else if (outcome.state === 'reauth_required') {
          entry.failureCount = 0;
          entry.nextRetryAt = entry.lastTouchedAt + policy.reauthRetryMs;
          /** Keep the authorization decision, but never promote an unfenced discovery catalog
           * into a cross-request cache. The configured server still appears with no tools. */
          entry.outcome = { ...outcome, tools: null };
        } else if (outcome.state === 'backoff') {
          const delay =
            policy.discoveryBackoffMs[
              Math.min(entry.failureCount, policy.discoveryBackoffMs.length - 1)
            ];
          entry.failureCount += 1;
          entry.nextRetryAt = entry.lastTouchedAt + delay;
          entry.outcome = outcome;
        } else {
          this.states.delete(key);
        }
        if (!adopted && !unconfirmed) {
          return outcome;
        }
        return { ...outcome, ...(adopted && { adopted }), ...(unconfirmed && { unconfirmed }) };
      })
      .finally(() => {
        if (this.states.get(key) === entry) {
          entry.inFlight = undefined;
          this.trim();
        }
      });
    entry.inFlight = flight;
    this.states.set(key, entry);
    this.trim();
    return flight;
  }

  private trim(): void {
    while (this.states.size > this.maxStateEntries) {
      let removed = false;
      for (const [key, entry] of this.states) {
        if (entry.inFlight != null) {
          continue;
        }
        this.states.delete(key);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }
}

/** Routes each fence publication a discovery's own refresh makes through its recovery flight. */
function trackPublications(
  onOAuthCredentialsChanging: ToolDiscoveryOptions['onOAuthCredentialsChanging'],
  trackPublication?: PublicationTracker,
): ToolDiscoveryOptions['onOAuthCredentialsChanging'] {
  if (onOAuthCredentialsChanging == null || trackPublication == null) {
    return onOAuthCredentialsChanging;
  }
  return async (scope) => {
    const publish = await onOAuthCredentialsChanging(scope);
    return () => trackPublication(publish);
  };
}

async function discoverCandidate(
  user: IUser,
  { serverName, serverConfig, customUserVars, capabilityProfile }: RecoveryCandidate,
  deps: MCPServerCatalogRecoveryDeps,
  policy: MCPServerCatalogRecoveryPolicy,
  {
    signal,
    trackPublication,
    onDetached,
  }: {
    signal?: AbortSignal;
    trackPublication?: PublicationTracker;
    onDetached?: DiscoveryDetacher;
  } = {},
): Promise<RecoveryOutcome> {
  const deadlineMs = Date.now() + resolveBudget(serverConfig, policy);
  try {
    const pending = deps.discoverServerTools({
      user,
      serverName,
      configServers: { [serverName]: serverConfig },
      customUserVars,
      deadlineMs,
      signal,
      onOAuthCredentialsChanging: trackPublications(
        deps.onOAuthCredentialsChanging,
        trackPublication,
      ),
      onOAuthCredentialsAdopted: async (generation) => {
        // Adoption changes the generation this flight serves without writing another fence.
        await trackPublication?.(async () => generation);
      },
      onDiscoveryDetached: onDetached,
      capabilityProfile,
    });
    /** Discovery can await work that ignores its budget — a token refresh persisting behind a
     *  stalled write — and a shared flight has no request signal to end that wait, so it would hold
     *  every coalesced request and its slot indefinitely. Stop waiting instead of cancelling: that
     *  work still commits what it redeemed. */
    const discovery = await waitUntilDeadline(pending, deadlineMs + policy.discoverySettleGraceMs);
    if (!discovery.settled) {
      onDetached?.(pending);
      logger.warn(
        `[MCP catalog recovery] Discovery for ${serverName} is still running ${policy.discoverySettleGraceMs}ms past its budget; releasing its catalog slot while it finishes in the background`,
      );
      return { serverName, tools: null, ...(!signal?.aborted && { state: 'backoff' as const }) };
    }
    const result = discovery.value;
    const tools = result.tools == null ? null : deps.formatServerTools(serverName, result.tools);
    if (signal?.aborted) {
      return { serverName, tools: null };
    }
    if (result.oauthRequired === true && result.authenticationKind === 'oauth') {
      return { serverName, tools, state: 'reauth_required' };
    }
    return {
      serverName,
      tools,
      ...(tools == null && { state: 'backoff' as const }),
    };
  } catch (error) {
    if (signal?.aborted) {
      return { serverName, tools: null };
    }
    /** Discovery raises `InvalidRequest` precisely when configuration makes the attempt
     *  impossible — domain policy, unresolved placeholders, missing runtime fields. That
     *  failure recurs on every request until an admin changes configuration, so it is
     *  expected state, logged at the same level as this file's other config-proven skips. */
    if (error instanceof McpError && error.code === ErrorCode.InvalidRequest) {
      logger.debug(
        `[MCP catalog recovery] ${serverName} is not recoverable under current configuration: ${error.message}`,
      );
      return { serverName, tools: null, state: 'backoff' };
    }
    logger.error(`[MCP catalog recovery] Failed to discover tools for ${serverName}:`, error);
    return { serverName, tools: null, state: 'backoff' };
  }
}

function finishCatalogLane(lane: CatalogWorkLane): void {
  if (lane.nextIndex < lane.tasks.length || lane.inFlight > 0) {
    return;
  }
  activeCatalogLanes.delete(lane);
  if (lane.signal != null && lane.onAbort != null) {
    lane.signal.removeEventListener('abort', lane.onAbort);
  }
  lane.resolve(true);
}

/** Shares the fixed process budget round-robin across at most three request lanes. */
function scheduleCatalogWork(): void {
  while (activeCatalogWork < CATALOG_FANOUT_CONCURRENCY && pendingCatalogLanes.length > 0) {
    const lane = pendingCatalogLanes.shift();
    if (lane == null) {
      return;
    }
    const task = lane.tasks[lane.nextIndex];
    lane.nextIndex += 1;
    lane.inFlight += 1;
    activeCatalogWork += 1;
    if (lane.nextIndex < lane.tasks.length) {
      pendingCatalogLanes.push(lane);
    }
    void task()
      .catch((error) => {
        logger.error('[MCP catalog] Scheduled outbound work failed:', error);
      })
      .finally(() => {
        lane.inFlight -= 1;
        activeCatalogWork -= 1;
        finishCatalogLane(lane);
        scheduleCatalogWork();
      });
  }
}

function runCatalogWork(
  tasks: ReadonlyArray<() => Promise<void>>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (tasks.length === 0) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) {
    return Promise.resolve(true);
  }
  if (activeCatalogLanes.size >= CATALOG_FANOUT_CONCURRENCY) {
    logger.debug('[MCP catalog] Skipping request: outbound capacity reached');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const lane: CatalogWorkLane = {
      tasks,
      resolve,
      nextIndex: 0,
      inFlight: 0,
      signal,
    };
    lane.onAbort = () => {
      lane.nextIndex = lane.tasks.length;
      for (let index = pendingCatalogLanes.length - 1; index >= 0; index -= 1) {
        if (pendingCatalogLanes[index] === lane) {
          pendingCatalogLanes.splice(index, 1);
        }
      }
      finishCatalogLane(lane);
    };
    signal?.addEventListener('abort', lane.onAbort, { once: true });
    activeCatalogLanes.add(lane);
    pendingCatalogLanes.push(lane);
    scheduleCatalogWork();
  });
}

/**
 * Passively discovers cold MCP catalogs for one request.
 *
 * A recovered catalog cannot enter the authoritative tool cache: a discovery connection owns no
 * publication generation and is disposed. Process-local recovery state therefore retains only
 * enough information to coalesce concurrent requests and suppress repeated failed/OAuth attempts;
 * successful ordinary catalogs remain request-local.
 */
async function recoverMCPServerCatalogsWithState(
  params: {
    user: IUser;
    servers: readonly MCPServerCatalogRecoveryInput[];
    signal?: AbortSignal;
    recoveryPolicy?: Partial<MCPServerCatalogRecoveryPolicy>;
  },
  deps: MCPServerCatalogRecoveryDeps,
): Promise<MCPServerCatalogRecoveryResult> {
  const { user, servers, signal } = params;
  const policy = { ...DEFAULT_RECOVERY_POLICY, ...params.recoveryPolicy };
  if (policy.discoveryBackoffMs.length === 0) {
    policy.discoveryBackoffMs = DEFAULT_RECOVERY_POLICY.discoveryBackoffMs;
  }
  const tracker = deps.recoveryTracker ?? new MCPServerCatalogRecoveryTracker();
  /** Only the config tier retries a failed stub on its own clock. A `yaml`- or `user`-sourced
   *  stub has no such timer, so skipping it unconditionally would hide the server for good —
   *  exactly the state this recovery exists to escape. */
  const recoverable = servers.filter(({ serverName, serverConfig }) => {
    if (!serverConfig.inspectionFailed || serverConfig.source !== 'config') {
      return true;
    }
    logger.debug(`[MCP catalog recovery] Skipping ${serverName}: awaiting config-tier retry`);
    return false;
  });
  if (recoverable.length === 0) {
    return {
      serverTools: new Map(),
      reauthRequiredServers: new Set(),
      reauthRequiredGenerations: new Map(),
    };
  }

  const generationSnapshots = new Map<string, string | undefined>();
  await Promise.all(
    recoverable.map(async ({ serverName, serverConfig }) => {
      if (serverConfig.obo != null || usesDirectOpenIDBearerRecovery(serverConfig)) {
        return;
      }
      generationSnapshots.set(
        serverName,
        await readMCPRecoveryGeneration(
          { userId: user.id, serverName },
          deps.getRecoveryGeneration,
          { timeoutMs: policy.generationReadTimeoutMs, signal },
        ),
      );
    }),
  );

  /** Only credential-bearing servers can consume the auth map, so a list without any avoids
   *  the plugin-auth round trip entirely. */
  const credentialServers = recoverable.filter(({ serverConfig }) =>
    hasCustomUserVars(serverConfig),
  );
  const userMCPAuthMap = credentialServers.length
    ? await deps.loadUserMCPAuthMap(
        user.id,
        credentialServers.map(({ serverName }) => serverName),
      )
    : {};

  /** A server missing its user-provided credentials fails auth on connect (see issue #10969),
   *  so discovering it would spend a doomed connection on every request. */
  const authorized: RecoveryCandidate[] = [];
  for (const candidate of recoverable) {
    const customUserVars = getServerCustomUserVars(userMCPAuthMap, candidate.serverName);
    const missingUserVars = getMissingCustomUserVars(candidate.serverConfig, customUserVars);
    if (missingUserVars.length > 0) {
      logger.debug(
        `[MCP catalog recovery] Skipping ${candidate.serverName}: ${missingUserVars.length} user-provided variable(s) unset`,
      );
      continue;
    }
    authorized.push({ ...candidate, customUserVars });
  }
  if (authorized.length === 0) {
    return {
      serverTools: new Map(),
      reauthRequiredServers: new Set(),
      reauthRequiredGenerations: new Map(),
    };
  }

  const results: Array<RecoveryOutcome | undefined> = [];
  const admitted = await runCatalogWork(
    authorized.map((candidate, index) => async () => {
      /** OBO and direct OpenID bearer discovery consume a request's live upstream-token closure,
       * so they must never join another request's flight or outlive that request's cancellation. */
      const usesRequestCredential =
        candidate.serverConfig.obo != null ||
        usesDirectOpenIDBearerRecovery(candidate.serverConfig);
      if (usesRequestCredential) {
        results[index] = tracker.admitsDiscovery(user, candidate, policy)
          ? await discoverCandidate(user, candidate, deps, policy, {
              signal,
              onDetached: (discovery) =>
                tracker.detachDiscovery(user, candidate, policy, discovery),
            })
          : { serverName: candidate.serverName, tools: null };
        return;
      }
      const observedGeneration = await readMCPRecoveryGeneration(
        { userId: user.id, serverName: candidate.serverName },
        deps.getRecoveryGeneration,
        { timeoutMs: policy.generationReadTimeoutMs, signal },
      );
      const snapshotGeneration = generationSnapshots.get(candidate.serverName);
      const requiresCredentialSnapshotFence = hasCustomUserVars(candidate.serverConfig);
      if (
        requiresCredentialSnapshotFence &&
        (snapshotGeneration == null ||
          observedGeneration == null ||
          snapshotGeneration !== observedGeneration)
      ) {
        tracker.clear(user.id, candidate.serverName, undefined, candidate.capabilityProfile);
        results[index] = { serverName: candidate.serverName, tools: null };
        return;
      }
      const recoveryGeneration = observedGeneration ?? snapshotGeneration;
      const outcome = await tracker.run(
        user,
        candidate,
        policy,
        recoveryGeneration,
        (trackPublication, detach) =>
          discoverCandidate(user, candidate, deps, policy, {
            trackPublication,
            onDetached: detach,
          }),
      );
      const finalGeneration = await readMCPRecoveryGeneration(
        { userId: user.id, serverName: candidate.serverName },
        deps.getRecoveryGeneration,
        { timeoutMs: policy.generationReadTimeoutMs, signal },
      );
      const outcomeGeneration = outcome.recoveryGeneration ?? recoveryGeneration;
      /** An outcome stands without a final read only under a generation this request observed and
       *  no clear has contested. A flight can finish under a generation its own refresh published or
       *  one this request never read, and a clear for another generation can spare it; any of those
       *  stands only while the shared generation still confirms it. A request that read nothing
       *  keeps a generation the tracker merely carried over, so a cache outage keeps retained state. */
      const requiresConfirmation =
        outcome.unconfirmed === true ||
        (outcomeGeneration !== recoveryGeneration &&
          (recoveryGeneration != null || outcome.adopted === true));
      const superseded =
        outcomeGeneration != null &&
        (requiresConfirmation
          ? finalGeneration !== outcomeGeneration
          : finalGeneration != null && finalGeneration !== outcomeGeneration);
      if (superseded) {
        tracker.clear(user.id, candidate.serverName, undefined, candidate.capabilityProfile);
        results[index] = { serverName: candidate.serverName, tools: null };
        return;
      }
      results[index] = outcome;
    }),
    signal,
  );
  if (!admitted) {
    throw new MCPCatalogCapacityError();
  }

  const serverTools = new Map<string, LCAvailableTools>();
  const reauthRequiredServers = new Set<string>();
  const reauthRequiredGenerations = new Map<string, string | undefined>();
  for (const result of results) {
    if (result?.tools != null) {
      serverTools.set(result.serverName, result.tools);
    }
    if (result?.state === 'reauth_required') {
      reauthRequiredServers.add(result.serverName);
      reauthRequiredGenerations.set(result.serverName, result.recoveryGeneration);
    }
  }
  return { serverTools, reauthRequiredServers, reauthRequiredGenerations };
}

/** Preserves the public recovery helper's Map contract for existing package consumers. */
export async function recoverMCPServerCatalogs(
  params: {
    user: IUser;
    servers: readonly MCPServerCatalogRecoveryInput[];
    signal?: AbortSignal;
    recoveryPolicy?: Partial<MCPServerCatalogRecoveryPolicy>;
  },
  deps: MCPServerCatalogRecoveryDeps,
): Promise<Map<string, LCAvailableTools>> {
  return (await recoverMCPServerCatalogsWithState(params, deps)).serverTools;
}

/** Loads cached, connected, then passive MCP catalogs for a marketplace-style list request. */
export async function loadMCPServerCatalogs(
  params: {
    user: IUser;
    servers: readonly MCPServerCatalogRecoveryInput[];
    signal?: AbortSignal;
    recoveryPolicy?: Partial<MCPServerCatalogRecoveryPolicy>;
  },
  deps: MCPServerCatalogLoaderDeps,
): Promise<MCPServerCatalogLoaderResult> {
  const { user, servers, signal } = params;
  const cached: MCPServerCatalogEntry[] = await Promise.all(
    servers.map(async ({ serverName, serverConfig, capabilityProfile }) => {
      try {
        const tools = await deps.getCachedServerTools(
          user.id,
          serverName,
          serverConfig,
          capabilityProfile,
        );
        return { serverName, serverConfig, capabilityProfile, tools, source: 'cache' as const };
      } catch (error) {
        logger.error(`[MCP catalog loader] Failed to read cached tools for ${serverName}:`, error);
        return {
          serverName,
          serverConfig,
          capabilityProfile,
          tools: null,
          source: 'cache' as const,
        };
      }
    }),
  );

  const snapshots = [...cached];
  const snapshotsAdmitted = await runCatalogWork(
    cached.flatMap((entry, index) =>
      entry.tools != null
        ? []
        : [
            async () => {
              try {
                const snapshot = await deps.getServerToolFunctionsSnapshot(
                  user.id,
                  entry.serverName,
                  entry.serverConfig,
                  {
                    deadlineMs: Date.now() + mcpConfig.TOOLS_LIST_TIMEOUT_MS,
                    signal,
                    capabilityProfile: entry.capabilityProfile,
                  },
                );
                snapshots[index] = { ...entry, ...snapshot, source: 'snapshot' as const };
              } catch (error) {
                logger.error(
                  `[MCP catalog loader] Failed to read connected tools for ${entry.serverName}:`,
                  error,
                );
                snapshots[index] = { ...entry, tools: null, source: 'snapshot' as const };
              }
            },
          ],
    ),
    signal,
  );
  if (!snapshotsAdmitted) {
    throw new MCPCatalogCapacityError();
  }

  const coldServers = snapshots
    .filter(({ tools }) => tools == null)
    .map(({ serverName, serverConfig, capabilityProfile }) => ({
      serverName,
      serverConfig,
      capabilityProfile,
    }));
  let recovered: MCPServerCatalogRecoveryResult = {
    serverTools: new Map(),
    reauthRequiredServers: new Set(),
    reauthRequiredGenerations: new Map(),
  };
  if (coldServers.length > 0) {
    try {
      recovered = await recoverMCPServerCatalogsWithState(
        { user, servers: coldServers, signal, recoveryPolicy: params.recoveryPolicy },
        deps,
      );
    } catch (error) {
      if (error instanceof MCPCatalogCapacityError) {
        throw error;
      }
      logger.error('[MCP catalog loader] Failed to recover cold server catalogs:', error);
    }
  }

  const serverTools = new Map<string, LCAvailableTools>();
  const serversWithoutTools: string[] = [];
  for (const snapshot of snapshots) {
    const tools = snapshot.tools ?? recovered.serverTools.get(snapshot.serverName);
    if (tools == null) {
      serversWithoutTools.push(snapshot.serverName);
      continue;
    }
    serverTools.set(snapshot.serverName, tools);
    if (snapshot.tools != null) {
      deps.recoveryTracker?.clear(
        user.id,
        snapshot.serverName,
        undefined,
        snapshot.capabilityProfile,
      );
    }

    if (snapshot.source !== 'snapshot' || snapshot.tools == null) {
      continue;
    }
    void deps
      .cacheServerTools({
        userId: user.id,
        serverName: snapshot.serverName,
        serverTools: snapshot.tools,
        serverConfig: snapshot.serverConfig,
        publicationGeneration: snapshot.publicationGeneration,
        publicationRevision: snapshot.publicationRevision,
        capabilityProfile: snapshot.capabilityProfile,
      })
      .catch((error) =>
        logger.error(
          `[MCP catalog loader] Failed to cache tools for ${snapshot.serverName}:`,
          error,
        ),
      );
  }

  return {
    serverTools,
    serversWithoutTools,
    reauthRequiredServers: recovered.reauthRequiredServers,
    reauthRequiredGenerations: recovered.reauthRequiredGenerations,
  };
}
