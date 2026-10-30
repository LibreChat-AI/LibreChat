import { getSafeErrorMetadata } from '~/utils/errors';
import { invokeOAuthStart } from './publication';
import { getMCPOAuthLeaseId } from './tokens';
import { logger, getTenantId } from '@librechat/data-schemas';

import type { MCPOAuthFlowMetadata, MCPOAuthTokens } from './types';
import type { FlowStateManager } from '~/flow/manager';
import type { FlowState } from '~/flow/types';
import type * as t from '~/mcp/types';

import { PENDING_STALE_MS } from '~/flow/manager';
import { MCPOAuthHandler } from './handler';

const MCP_OAUTH_FLOW_TYPE = 'mcp_oauth';

type PendingOAuthFlowState = Pick<
  FlowState<MCPOAuthTokens | null>,
  'createdAt' | 'metadata' | 'status'
>;

type PendingOAuthFlowManager = Pick<FlowStateManager<MCPOAuthTokens | null>, 'getFlowState'> &
  Partial<Pick<FlowStateManager<MCPOAuthTokens | null>, 'acquireLease'>>;

export type PendingOAuthStart = {
  authURL: string;
  options?: t.OAuthStartOptions;
};

export type ReplayablePendingMCPOAuthStartOptions = {
  flowManager?: PendingOAuthFlowManager | null;
  userId: string;
  serverName: string;
};

export function getReplayablePendingMCPOAuthStartFromFlow(
  flow: PendingOAuthFlowState | null | undefined,
  now: number = Date.now(),
): PendingOAuthStart | undefined {
  if (flow?.status !== 'PENDING') {
    return undefined;
  }

  const expiresAt = flow.createdAt + PENDING_STALE_MS;
  if (expiresAt <= now) {
    return undefined;
  }

  const metadata = flow.metadata as Partial<MCPOAuthFlowMetadata>;
  const authorizationUrl = metadata.authorizationUrl;
  if (!authorizationUrl) {
    return undefined;
  }

  return { authURL: authorizationUrl, options: { expiresAt } };
}

export async function getReplayablePendingMCPOAuthStart({
  flowManager,
  userId,
  serverName,
}: ReplayablePendingMCPOAuthStartOptions): Promise<PendingOAuthStart | undefined> {
  if (!flowManager || typeof flowManager.getFlowState !== 'function') {
    return undefined;
  }

  try {
    const flowId = MCPOAuthHandler.generateFlowId(userId, serverName, getTenantId());
    const flowState = await flowManager.getFlowState(flowId, MCP_OAUTH_FLOW_TYPE);
    return getReplayablePendingMCPOAuthStartFromFlow(flowState);
  } catch {
    logger.warn('[MCP OAuth] Failed to inspect pending flow');
    return undefined;
  }
}

/**
 * Reads the pending OAuth flows of several servers at once, skipping any `skip` rejects.
 * The result keeps the order of `serverNames`, and holds only servers with a replayable start.
 */
export async function getReplayablePendingMCPOAuthStarts({
  flowManager,
  userId,
  serverNames,
  skip,
}: Omit<ReplayablePendingMCPOAuthStartOptions, 'serverName'> & {
  serverNames: Iterable<string>;
  skip?: (serverName: string) => boolean;
}): Promise<Map<string, PendingOAuthStart>> {
  const names = Array.from(serverNames).filter((serverName) => !skip?.(serverName));
  const starts = await Promise.all(
    names.map((serverName) =>
      getReplayablePendingMCPOAuthStart({ flowManager, userId, serverName }),
    ),
  );
  const pending = new Map<string, PendingOAuthStart>();
  names.forEach((serverName, index) => {
    const start = starts[index];
    if (start) {
      pending.set(serverName, start);
    }
  });
  return pending;
}

type OAuthEndHandler = () => Promise<void>;

export class OAuthLifecycleRelay {
  private readonly oauthStarts = new Set<t.OAuthStartHandler>();
  private readonly oauthEnds = new Set<OAuthEndHandler>();
  private readonly emittedAuthUrls = new WeakMap<t.OAuthStartHandler, string>();
  private readonly emittedOAuthEnds = new WeakSet<OAuthEndHandler>();
  private oauthEnded = false;

  constructor({
    oauthStart,
    oauthEnd,
    logPrefix,
  }: {
    oauthStart?: t.OAuthStartHandler;
    oauthEnd?: OAuthEndHandler;
    logPrefix: string;
  }) {
    this.logPrefix = logPrefix;
    if (oauthStart) {
      this.oauthStarts.add(oauthStart);
    }
    if (oauthEnd) {
      this.oauthEnds.add(oauthEnd);
    }
  }

  private readonly logPrefix: string;

  public readonly start: t.OAuthStartHandler = async (authURL, options) => {
    const publications = Array.from(this.oauthStarts, (handler) => this.emit(handler, authURL, options));
    const published = await Promise.allSettled(publications.map((entry) => entry.published));
    const failed = published.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    for (const result of failed)
      logger.warn(`${this.logPrefix} Failed to publish OAuth prompt`, getSafeErrorMetadata(result.reason));
    if (publications.length > 0 && failed.length === publications.length) throw failed[0].reason;
    // The outer flow lease covers every listener's publication, never its authorization callback.
    options?.onPublished?.();
    const completed = await Promise.allSettled(publications.map((entry) => entry.completed));
    const errors = completed.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (completed.length > 0 && errors.length === completed.length) throw errors[0].reason;
  };

  /** Completion notifications are best effort and cannot invalidate received OAuth tokens. */
  public readonly end: OAuthEndHandler = async () => {
    this.oauthEnded = true;
    for (const oauthEnd of Array.from(this.oauthEnds)) {
      try {
        await this.emitEnd(oauthEnd);
      } catch (error) {
        logger.warn(`${this.logPrefix} Failed to notify OAuth completion listener`, getSafeErrorMetadata(error));
      }
    }
  };

  public async add({
    oauthStart,
    oauthEnd,
    flowManager,
    userId,
    serverName,
  }: ReplayablePendingMCPOAuthStartOptions & {
    oauthStart?: t.OAuthStartHandler;
    oauthEnd?: OAuthEndHandler;
  }): Promise<void> {
    if (oauthStart) {
      this.oauthStarts.add(oauthStart);
    }
    if (oauthEnd) {
      this.oauthEnds.add(oauthEnd);
    }
    if (this.oauthEnded) {
      if (oauthEnd) {
        try {
          await this.emitEnd(oauthEnd);
        } catch (error) {
          logger.warn(`${this.logPrefix} Failed to re-issue OAuth completion`, getSafeErrorMetadata(error));
        }
      }
      return;
    }

    if (!oauthStart) {
      return;
    }
    // A cached URL/deadline is not publication authority after teardown. Late listeners re-read
    // the canonical flow while holding the same lease used by publication and removal.
    if (!flowManager?.acquireLease) return;
    const lease = await flowManager.acquireLease(getMCPOAuthLeaseId(userId, serverName));
    if (!lease) return;
    let publication: ReturnType<OAuthLifecycleRelay['emit']> | undefined;
    try {
      const flowId = MCPOAuthHandler.generateFlowId(userId, serverName, getTenantId());
      const flow = await flowManager.getFlowState(flowId, MCP_OAUTH_FLOW_TYPE);
      const replay = getReplayablePendingMCPOAuthStartFromFlow(flow);
      if (!replay || this.oauthEnded) return;
      publication = this.emit(oauthStart, replay.authURL, replay.options);
      await publication.published;
    } catch (error) {
      logger.warn(`${this.logPrefix} Failed to re-issue pending OAuth URL`, getSafeErrorMetadata(error));
    } finally {
      await lease.release();
    }
    if (publication) {
      try {
        await publication.completed;
      } catch (error) {
        logger.warn(`${this.logPrefix} OAuth listener completion failed`, getSafeErrorMetadata(error));
      }
    }
  }

  private emit(
    oauthStart: t.OAuthStartHandler,
    authURL: string,
    options?: t.OAuthStartOptions,
  ): ReturnType<typeof invokeOAuthStart> {
    if (this.emittedAuthUrls.get(oauthStart) === authURL)
      return { published: Promise.resolve(), completed: Promise.resolve() };
    const publication = invokeOAuthStart(oauthStart, authURL, { expiresAt: options?.expiresAt });
    return {
      ...publication,
      published: publication.published.then(() => { this.emittedAuthUrls.set(oauthStart, authURL); }),
    };
  }

  private async emitEnd(oauthEnd: OAuthEndHandler): Promise<void> {
    if (this.emittedOAuthEnds.has(oauthEnd)) {
      return;
    }
    await oauthEnd();
    this.emittedOAuthEnds.add(oauthEnd);
  }
}
