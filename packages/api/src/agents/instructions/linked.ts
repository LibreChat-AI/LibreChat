import { scopedCacheKey } from '@librechat/data-schemas';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  AgentInstructionsPromptSelection,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { ResolvedPrompt, NativeResolvedPrompt, PromptServiceError } from '~/prompts/types';
import type { PromptService } from '~/prompts/service';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { isContentFilterError } from '~/middleware/contentFilter';
import { LangfusePromptRequestError } from '~/langfuse/prompts';
import { inspectPromptContent } from '~/prompts/protection';
import { toPromptSelection } from './selection';

/**
 * Narrows `link` to a resolvable link — native or Langfuse — the same test
 * `initializeAgent` uses to decide whether an agent's stored inline
 * `instructions` are live text or dead text superseded by a link. A
 * `RestrictedAgentInstructionsPrompt` stub (`{ source, restricted: true }`,
 * no `groupId`) is never valid: it never reaches `initializeAgent` (that
 * shape exists only for an editor without VIEW on the linked group), so it
 * must not be treated as a link that suppresses inline text elsewhere either
 * — most importantly in the HITL resume preflight, which inspects a stored
 * agent snapshot rather than a live `Agent`. A Langfuse link stays "valid"
 * here even while `endpoints.agents.linkedInstructions.langfuse.enabled` is
 * off: the inline text stays suppressed and `resolve` below reports the
 * link as `disabled` rather than falling back to it.
 */
export function isValidInstructionsPromptLink(
  link: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): link is AgentInstructionsPrompt {
  return (
    link != null && (link.source === 'native' || link.source === 'langfuse') && 'groupId' in link
  );
}

/** Facts about a resolved link, retained on the initialized agent. Never persisted.
 *  Shaped per source: a native link's resolved revision has a `promptId`; a
 *  Langfuse link's has a `version` (the revision Langfuse served, whether
 *  pinned or the current Production). */
export type LinkedInstructionsFacts =
  | { source: 'native'; groupId: string; promptId: string }
  | { source: 'langfuse'; groupId: string; version: number };

export type LinkedInstructionsUnavailableReason =
  | 'unavailable_selection'
  | 'blocked_content'
  | 'timeout'
  | 'disabled'
  | 'error';

export type LinkedInstructionsResult =
  | { status: 'resolved'; prompt: string; facts: LinkedInstructionsFacts }
  | { status: 'unavailable'; reason: LinkedInstructionsUnavailableReason };

/**
 * Budget and cache/rollout configuration for the linked-instructions resolver,
 * mirroring the `endpoints.agents.linkedInstructions` config block.
 */
export type LinkedInstructionsConfig = {
  timeoutMs?: number;
  native?: { cacheTtlMs?: number };
  langfuse?: { enabled?: boolean };
};

/**
 * Resolves an agent's linked prompt-group instructions — native or Langfuse.
 * Usage is no longer recorded here — call `.recordUse(facts)` (below) once
 * the caller's own initialization that used a `resolved` result has itself
 * succeeded.
 */
export type ResolveLinkedInstructions = ((input: {
  link: AgentInstructionsPrompt;
  signal?: AbortSignal;
  filters?: FiltersConfig;
  config?: LinkedInstructionsConfig;
}) => Promise<LinkedInstructionsResult>) & {
  /**
   * Records a usage generation for a resolved link's prompt group. The
   * resolver never calls this itself: `resolve` only reads and caches
   * content, so a caller that never calls `recordUse` records no usage at
   * all. Fire-and-forget — errors are caught and logged, never thrown, and
   * this returns before the increment settles.
   */
  recordUse(facts: LinkedInstructionsFacts): void;
};

/**
 * Minimal cache contract this module needs — `resolve` reads and writes, and
 * `invalidateLinkedPrompt` (below) deletes; a Keyv instance already satisfies this shape.
 */
export interface LinkedInstructionsCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface LinkedInstructionsLogger {
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

export interface CreateLinkedInstructionsResolverDeps {
  promptService: Pick<PromptService, 'resolvePrompt' | 'incrementPromptGroupUsage'>;
  cache: LinkedInstructionsCache;
  logger: LinkedInstructionsLogger;
}

/**
 * Mirrors the `linkedInstructions` block defaults in the data-provider agents
 * endpoint schema (`packages/data-provider/src/config.ts`). Those defaults
 * are inline zod literals, not exported constants, so this is the one place
 * that carries the runtime copy — nothing else in the resolver hardcodes
 * either number.
 */
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 300_000;

/** The shape written to and read from the content cache. */
interface CachedLinkedPrompt {
  readonly groupId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly type: NativeResolvedPrompt['type'];
}

class LinkedInstructionsTimeoutError extends Error {
  constructor() {
    super('Linked instructions resolution timed out');
    this.name = 'LinkedInstructionsTimeoutError';
  }
}

function buildCacheKey(groupId: string, selection: AgentInstructionsPromptSelection): string {
  const selectionKey =
    selection.type === 'production' ? 'production' : `exact:${selection.promptId}`;
  return `native:${groupId}:${selectionKey}`;
}

/**
 * Clears a native prompt group's cached linked-instructions entries so a promote or
 * delete reaches a linked agent on the next request instead of after the cache's TTL.
 * Always clears the production selection; `promptIds` adds one exact selection per
 * revision ID the caller passes — a promote clears only production (empty
 * `promptIds`), a revision delete passes that revision's ID, and a group delete
 * passes every revision's ID. Keys are built with `buildCacheKey`, the same function
 * `resolve` uses, so both stay in agreement on the key format.
 */
export async function invalidateLinkedPrompt(
  cache: LinkedInstructionsCache,
  groupId: string,
  promptIds: readonly string[],
): Promise<void> {
  const selections: AgentInstructionsPromptSelection[] = [
    { type: 'production' },
    ...promptIds.map((promptId) => ({ type: 'exact' as const, promptId })),
  ];
  await Promise.all(
    selections.map((selection) => cache.delete(scopedCacheKey(buildCacheKey(groupId, selection)))),
  );
}

function isCachedLinkedPrompt(value: unknown): value is CachedLinkedPrompt {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CachedLinkedPrompt>;
  return (
    typeof candidate.groupId === 'string' &&
    typeof candidate.promptId === 'string' &&
    typeof candidate.prompt === 'string'
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Maps every `resolvePrompt` error type this module's `allowedSources: [link.source]`
 * call can return to the resolver's few-reason surface. `blocked_content` and
 * `unavailable_selection` map directly. Every other source-routing or selection
 * failure a resolve can hit — `unsupported_source` (the link's group has since
 * switched source), `unsupported_selection` (a selection invalid for the resolved
 * source), `source_unavailable`, `source_not_found`, and `unsupported_content` (a
 * Langfuse group pointing at a chat prompt) — collapses to `unavailable_selection`:
 * each one means the configured selection cannot be served right now, not that the
 * resolution itself failed unexpectedly. Any other `PromptServiceError` type (the
 * write-only ones, never returned by a resolve) maps to the generic `'error'`
 * reason as a fallback.
 */
function mapServiceErrorReason(
  type: PromptServiceError['type'],
): LinkedInstructionsUnavailableReason {
  if (type === 'blocked_content' || type === 'unavailable_selection') {
    return type;
  }
  if (
    type === 'unsupported_source' ||
    type === 'unsupported_selection' ||
    type === 'source_unavailable' ||
    type === 'source_not_found' ||
    type === 'unsupported_content'
  ) {
    return 'unavailable_selection';
  }
  return 'error';
}

/**
 * Whether `prompt` is blocked under the agent-instructions policy
 * (`filters.agentInstructions.pii`, via `assertModelBoundContent`'s `agents`
 * field — the same check inline agent instructions and repository
 * instructions get at init).
 *
 * Uses `isContentFilterError` — the same helper `access.ts` uses to recognize
 * a content-policy rejection — rather than an `instanceof ContentFilterError`
 * check, so every content-policy error `assertModelBoundContent` can throw
 * (including a traversal-limit or uninspectable-file error) maps to a block
 * consistently. An unrecognized error still throws (the caller,
 * `checkPromptBlocked` below, catches it and maps it to the resolver's
 * generic `'error'` reason rather than rejecting the resolution).
 */
function isBlockedAsAgentInstructions(prompt: string, filters: FiltersConfig | undefined): boolean {
  try {
    assertModelBoundContent({ filters, agents: [{ instructions: prompt }] });
    return false;
  } catch (error) {
    if (isContentFilterError(error)) {
      return true;
    }
    throw error;
  }
}

/**
 * Whether `prompt` is blocked under either policy a linked prompt is subject
 * to: the prompt-library policy (`filters.prompts.pii`, via
 * `inspectPromptContent` — the same check `resolvePrompt` runs on a fresh
 * fetch) or the agent-instructions policy (`isBlockedAsAgentInstructions`).
 */
function isPromptBlocked(prompt: string, filters: FiltersConfig | undefined): boolean {
  return (
    inspectPromptContent({ prompt }, filters) != null ||
    isBlockedAsAgentInstructions(prompt, filters)
  );
}

/**
 * Bounds `operation` by `timeoutMs` and cancels the wait immediately when
 * `signal` aborts — clearing the timeout timer right away rather than leaving
 * it to fire later. The underlying `operation` itself is not cancelled, only
 * this wait is, so a cache/adapter call already in flight cannot outlive its
 * caller's abort handling. Exported so other cache-bound call sites (for
 * example, the prompt handlers' cache clear) share this instead of a copy.
 */
export function runBounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      run();
    };
    const onAbort = (): void => settle(() => reject(signal?.reason));
    const timer = setTimeout(
      () => settle(() => reject(new LinkedInstructionsTimeoutError())),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort);
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** Milliseconds left until `deadline`, floored at 0. Never negative, so a
 *  spent budget still schedules a real (if immediate) bounded call rather
 *  than one with no timeout at all. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** Caps the cache-read phase so a hung cache can never consume the whole
 *  resolution deadline: at most 250ms, or a quarter of `timeoutMs` when that
 *  is smaller. Whatever remains of `timeoutMs` after this phase — at least
 *  three quarters of it — is left for `resolvePrompt`. */
function cacheReadBudgetMs(timeoutMs: number): number {
  return Math.min(250, timeoutMs / 4);
}

/**
 * Builds the runtime resolver for an agent's linked prompt-group
 * instructions — native or Langfuse.
 *
 * A Langfuse link is gated by the rollout switch before anything else runs:
 * `config?.langfuse?.enabled !== true` resolves straight to `{ status:
 * 'unavailable', reason: 'disabled' }`, before the cache or `resolvePrompt`
 * is ever touched — switching the rollout off never triggers a cache read,
 * a cache write, or a Langfuse request.
 *
 * Caching applies to native links only: `useCache = link.source === 'native'
 * && cacheTtlMs > 0` gates the cache key, the read and the write alike. A
 * Langfuse link always calls `resolvePrompt` fresh — AI-2283 owns its cache,
 * not this resolver (see the Decisions table in the AI-2278 plan) — so a
 * Production change in Langfuse is visible on the very next resolution, with
 * no invalidation to wire up. A cache hit is checked under both policies —
 * prompt-library and agent-instructions — with the caller's *current*
 * filters (so a policy change blocks a previously-cached prompt) before
 * being returned. A miss calls `resolvePrompt`, which already applies the
 * prompt-library policy with the same filters, so the miss path checks only
 * the agent-instructions policy and writes the cache only on success, while
 * unaborted.
 *
 * Latency is bounded by one shared deadline (`config.timeoutMs` from the
 * moment `resolve` is called), not by re-arming a fresh timeout per phase —
 * a slow or failed cache read spends part of that budget, and only what
 * remains is left for `resolvePrompt`, so the worst case stays ~`timeoutMs`
 * overall instead of doubling. The cache-read phase itself is additionally
 * capped at `cacheReadBudgetMs` (at most 250ms, or a quarter of `timeoutMs`
 * when that is smaller) so a *hung* cache read — one that never settles —
 * cannot consume the entire deadline and starve `resolvePrompt` of its own
 * chance to run; a cache read failure or timeout is logged and treated as a
 * miss (falls through to `resolvePrompt`) rather than failing the turn — a
 * cache outage must not drop instructions. The cache write itself never
 * blocks the caller: it is fire-and-forget (errors caught and logged),
 * issued only when unaborted. For a Langfuse link, `resolvePrompt` dispatches
 * to the Langfuse adapter, whose own HTTP call runs under its own
 * `AbortSignal.timeout` (`LANGFUSE_PROMPT_SYNC_TIMEOUT_MS`) inside this
 * resolver's shared deadline; `runBounded` stops *waiting* on that call when
 * the deadline or `signal` fires, but it does not cancel the in-flight
 * Langfuse request itself.
 *
 * Abort is checked before work starts and after every await and always
 * throws the signal's abort reason — it is never mapped to an `unavailable`
 * result, and a cancelled call never writes the cache. Failures (timeout on
 * the `resolvePrompt` phase, a thrown `LangfusePromptRequestError` or other
 * adapter error, or an unrecognized error from the content-policy check)
 * resolve to `{ status: 'unavailable', reason }` — the resolution is never
 * rejected by anything other than an abort. Logs never include prompt text —
 * only the reason, groupId, the error's name, and — for a thrown
 * `LangfusePromptRequestError` — its stable `code`, never its message.
 *
 * The returned function never records prompt-group usage itself; call its
 * `.recordUse(facts)` once the caller's own initialization succeeds.
 */
export function createLinkedInstructionsResolver(
  deps: CreateLinkedInstructionsResolverDeps,
): ResolveLinkedInstructions {
  const { promptService, cache, logger } = deps;

  const resolve = async function resolveLinkedInstructions({
    link,
    signal,
    filters,
    config,
  }: {
    link: AgentInstructionsPrompt;
    signal?: AbortSignal;
    filters?: FiltersConfig;
    config?: LinkedInstructionsConfig;
  }): Promise<LinkedInstructionsResult> {
    signal?.throwIfAborted();

    /* The rollout switch is checked before any cache or service call: an off
     * Langfuse link never touches the cache and never reaches `resolvePrompt`. */
    if (link.source === 'langfuse' && config?.langfuse?.enabled !== true) {
      return { status: 'unavailable', reason: 'disabled' };
    }

    const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cacheTtlMs = config?.native?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    /* Langfuse links are never cached here — AI-2283 owns that cache — so caching
     * applies to a native link only, and only when `cacheTtlMs > 0`. This one flag
     * gates key computation, the cache read, and the cache write below. */
    const useCache = link.source === 'native' && cacheTtlMs > 0;
    const deadline = Date.now() + timeoutMs;

    let key: string | undefined;
    let cached: CachedLinkedPrompt | undefined;
    if (useCache && link.source === 'native') {
      key = scopedCacheKey(buildCacheKey(link.groupId, link.selection));
      try {
        const cacheBudget = Math.min(remainingMs(deadline), cacheReadBudgetMs(timeoutMs));
        const raw = await runBounded(cache.get(key), cacheBudget, signal);
        cached = isCachedLinkedPrompt(raw) ? raw : undefined;
      } catch (error) {
        /* An abort must still surface as the abort reason, not be swallowed into
         * the "fall through to resolvePrompt" handling below. */
        signal?.throwIfAborted();
        logger.warn('[linkedInstructions] Cache read failed; resolving without cache', {
          groupId: link.groupId,
          errorName: errorName(error),
        });
      }
    }
    signal?.throwIfAborted();

    /** Neither content-policy check ever rejects the resolution: a recognized
     *  content-policy error maps to `blocked_content`, and anything else — an
     *  unexpected throw from `assertModelBoundContent` — is logged and mapped
     *  to the generic `'error'` reason instead of propagating. `isBlocked` is
     *  `isPromptBlocked` for a cache hit (both policies) or
     *  `isBlockedAsAgentInstructions` for a fresh `resolvePrompt` result
     *  (agent-instructions policy only, since `resolvePrompt` already applied
     *  the prompt-library policy with the same filters). */
    const checkPromptBlocked = (
      prompt: string,
      isBlocked: (prompt: string, filters: FiltersConfig | undefined) => boolean,
    ): 'ok' | 'blocked' | 'error' => {
      try {
        return isBlocked(prompt, filters) ? 'blocked' : 'ok';
      } catch (error) {
        logger.error('[linkedInstructions] Content-policy check failed', {
          groupId: link.groupId,
          errorName: errorName(error),
        });
        return 'error';
      }
    };

    if (cached) {
      const blockCheck = checkPromptBlocked(cached.prompt, isPromptBlocked);
      if (blockCheck !== 'ok') {
        return {
          status: 'unavailable',
          reason: blockCheck === 'blocked' ? 'blocked_content' : 'error',
        };
      }
      return {
        status: 'resolved',
        prompt: cached.prompt,
        facts: { source: 'native', groupId: cached.groupId, promptId: cached.promptId },
      };
    }

    let fetched: ResolvedPrompt;
    try {
      const result = await runBounded(
        promptService.resolvePrompt({
          groupId: link.groupId,
          selection: toPromptSelection(link),
          filters,
          allowedSources: [link.source],
        }),
        remainingMs(deadline),
        signal,
      );
      signal?.throwIfAborted();
      if (!result.ok) {
        logger.warn('[linkedInstructions] resolvePrompt returned a failure result', {
          groupId: link.groupId,
          source: link.source,
          type: result.error.type,
          ...('reason' in result.error ? { reason: result.error.reason } : {}),
        });
        return { status: 'unavailable', reason: mapServiceErrorReason(result.error.type) };
      }
      if (result.value.source !== link.source) {
        /* allowedSources: [link.source] above means the service only ever resolves
         * a group of that same source here; a mismatch means the link's group has
         * since switched source underneath it, not a request-handling bug. */
        return { status: 'unavailable', reason: 'unavailable_selection' };
      }
      fetched = result.value;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof LinkedInstructionsTimeoutError) {
        return { status: 'unavailable', reason: 'timeout' };
      }
      logger.error('[linkedInstructions] resolvePrompt failed', {
        groupId: link.groupId,
        errorName: errorName(error),
        /* A thrown `LangfusePromptRequestError` carries a stable, non-text code
         * (`timeout`, `upstream`, `invalid_response`, ...) — log it for triage,
         * never the error's message, which may echo upstream response text. */
        ...(error instanceof LangfusePromptRequestError ? { code: error.code } : {}),
      });
      return { status: 'unavailable', reason: 'error' };
    }

    const fetchedBlockCheck = checkPromptBlocked(fetched.prompt, isBlockedAsAgentInstructions);
    if (fetchedBlockCheck !== 'ok') {
      return {
        status: 'unavailable',
        reason: fetchedBlockCheck === 'blocked' ? 'blocked_content' : 'error',
      };
    }

    if (useCache && key && !signal?.aborted && fetched.source === 'native') {
      /* `useCache` already implies `link.source === 'native'`, and the mismatch
       * check above guarantees `fetched.source === link.source`, so this
       * condition is never false here at runtime. It stays only to narrow
       * `fetched` to `NativeResolvedPrompt` for `promptId`/`type` below;
       * TypeScript cannot derive that narrowing from `useCache` or `key`. */
      /* Fire-and-forget: the turn must not wait on the cache write, and a
       * write failure is a cache-warmth loss, not a resolution failure. */
      cache
        .set(
          key,
          {
            groupId: fetched.groupId,
            promptId: fetched.promptId,
            prompt: fetched.prompt,
            type: fetched.type,
          },
          cacheTtlMs,
        )
        .catch((error: unknown) => {
          logger.warn('[linkedInstructions] Cache write failed', {
            groupId: fetched.groupId,
            errorName: errorName(error),
          });
        });
    }
    signal?.throwIfAborted();

    const facts: LinkedInstructionsFacts =
      fetched.source === 'native'
        ? { source: 'native', groupId: fetched.groupId, promptId: fetched.promptId }
        : { source: 'langfuse', groupId: fetched.groupId, version: fetched.version };

    return {
      status: 'resolved',
      prompt: fetched.prompt,
      facts,
    };
  };

  const recordUse = (facts: LinkedInstructionsFacts): void => {
    promptService.incrementPromptGroupUsage(facts.groupId).catch((error: unknown) => {
      logger.warn('[linkedInstructions] Failed to record prompt group usage', {
        groupId: facts.groupId,
        errorName: errorName(error),
      });
    });
  };

  return Object.assign(resolve, { recordUse });
}
