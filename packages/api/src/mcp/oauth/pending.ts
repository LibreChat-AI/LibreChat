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

type PendingOAuthFlowManager = Pick<FlowStateManager<MCPOAuthTokens | null>, 'getFlowState'>;

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

type OAuthEndHandler = () => Promise<void>;

export class OAuthLifecycleRelay {
  private readonly oauthStarts = new Set<t.OAuthStartHandler>();
  private readonly oauthEnds = new Set<OAuthEndHandler>();
  private readonly emittedAuthUrls = new WeakMap<t.OAuthStartHandler, string>();
  private readonly emittedOAuthEnds = new WeakSet<OAuthEndHandler>();
  private lastOAuthStart?: PendingOAuthStart;
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
    this.lastOAuthStart = { authURL, options };
    const errors: unknown[] = [];
    let delivered = false;

    for (const oauthStart of Array.from(this.oauthStarts)) {
      try {
        await this.emit(oauthStart, authURL, options);
        delivered = true;
      } catch (error) {
        errors.push(error);
        logger.warn(`${this.logPrefix} Failed to notify OAuth prompt listener`, error);
      }
    }

    if (!delivered && errors.length > 0) {
      throw errors[0];
    }
  };

  /** Completion notifications are best effort and cannot invalidate received OAuth tokens. */
  public readonly end: OAuthEndHandler = async () => {
    this.oauthEnded = true;
    for (const oauthEnd of Array.from(this.oauthEnds)) {
      try {
        await this.emitEnd(oauthEnd);
      } catch (error) {
        logger.warn(`${this.logPrefix} Failed to notify OAuth completion listener`, error);
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
          logger.warn(`${this.logPrefix} Failed to re-issue OAuth completion`, error);
        }
      }
      return;
    }

    if (!oauthStart) {
      return;
    }
    const lastOAuthStart = this.lastOAuthStart;
    const storedOAuthStart =
      !lastOAuthStart || lastOAuthStart.options?.expiresAt == null
        ? await getReplayablePendingMCPOAuthStart({ flowManager, userId, serverName })
        : undefined;
    const currentOAuthStart = this.lastOAuthStart;
    const replayOAuthStart =
      storedOAuthStart &&
      (!currentOAuthStart || storedOAuthStart.authURL === currentOAuthStart.authURL)
        ? storedOAuthStart
        : currentOAuthStart;
    if (!replayOAuthStart) {
      return;
    }
    if (this.oauthEnded) {
      return;
    }

    this.lastOAuthStart = replayOAuthStart;
    try {
      await this.emit(oauthStart, replayOAuthStart.authURL, replayOAuthStart.options);
    } catch (error) {
      logger.warn(`${this.logPrefix} Failed to re-issue pending OAuth URL`, error);
    }
  }

  private async emit(
    oauthStart: t.OAuthStartHandler,
    authURL: string,
    options?: t.OAuthStartOptions,
  ): Promise<void> {
    if (this.emittedAuthUrls.get(oauthStart) === authURL) {
      return;
    }
    this.emittedAuthUrls.set(oauthStart, authURL);
    await oauthStart(authURL, options);
  }

  private async emitEnd(oauthEnd: OAuthEndHandler): Promise<void> {
    if (this.emittedOAuthEnds.has(oauthEnd)) {
      return;
    }
    this.emittedOAuthEnds.add(oauthEnd);
    await oauthEnd();
  }
}
