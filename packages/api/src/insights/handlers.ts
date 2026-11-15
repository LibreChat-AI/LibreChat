import { logger } from '@librechat/data-schemas';
import {
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
  INSIGHTS_AGENT_ID_MAX_LENGTH,
  FEEDBACK_REASON_KEYS,
  SystemRoles,
} from 'librechat-data-provider';
import type {
  TInsightsParams,
  TInsightsAggregateResponse,
  TInsightsAgent,
} from 'librechat-data-provider';
import type { InsightsMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { InsightsConfigResolver } from './config';
import type { InsightsAccess } from './access';
import type { ServerRequest } from '~/types';
import { toAggregateInsightsResponse } from './privacy';
import { getSafeErrorMetadata } from '~/utils/errors';

type InsightsHandlerDeps = {
  resolveInsightsConfig: InsightsConfigResolver;
  getInsights: InsightsMethods['getInsights'];
  getInsightsAccess: (user: NonNullable<ServerRequest['user']>) => Promise<InsightsAccess>;
};

type InsightsAccessHandlerDeps = Pick<
  InsightsHandlerDeps,
  'resolveInsightsConfig' | 'getInsightsAccess'
>;

const firstQueryValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return firstQueryValue(value[0]);
  }
  return typeof value === 'string' ? value : undefined;
};

const positiveInteger = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(firstQueryValue(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const stringValue = (input: unknown): string | undefined => {
  const value = firstQueryValue(input)?.trim();
  return value ? value : undefined;
};

const stringValues = (input: unknown): string[] => {
  const values = Array.isArray(input) ? input : [input];
  return [
    ...new Set(values.map(stringValue).filter((value): value is string => value != null)),
  ].sort((a, b) => a.localeCompare(b));
};

const validRanges = new Set<TInsightsParams['range']>(['24h', '7d', '30d', 'custom']);

const insightsRange = (value: unknown): TInsightsParams['range'] | undefined => {
  const range = stringValue(value) as TInsightsParams['range'] | undefined;
  return range && validRanges.has(range) ? range : undefined;
};

const timeZoneValue = (value: unknown): string | undefined => {
  const timeZone = stringValue(value)?.slice(0, 100);
  if (!timeZone) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
};

function selectionResponse(agents: TInsightsAgent[]): TInsightsAggregateResponse {
  return {
    agents: agents.map(({ id, name }) => ({ id, name })),
    selectionRequired: true,
    allAgentsAllowed: false,
    summary: {
      totalUsers: 0,
      totalConversations: 0,
      totalMessages: 0,
      totalTokens: 0,
      totalResponses: 0,
      completedResponses: 0,
      failedResponses: 0,
      interruptedResponses: 0,
      lastUsed: null,
      spendUSD: null,
      feedback: {
        thumbsUp: 0,
        thumbsDown: 0,
        categories: FEEDBACK_REASON_KEYS.map((key) => ({ key, count: 0 })),
      },
    },
    daily: [],
    models: [],
  };
}

export function createInsightsAccessHandler({
  resolveInsightsConfig,
  getInsightsAccess,
}: InsightsAccessHandlerDeps) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    try {
      if (!resolveInsightsConfig(req).enabled) {
        res.status(404).json({ message: 'Not found' });
        return;
      }

      if (!req.user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      const { agents } = await getInsightsAccess(req.user);
      if (agents.length === 0) {
        res.status(403).json({ message: 'Forbidden' });
        return;
      }

      res.json({ access: true });
    } catch (error) {
      logger.error('[Insights] Failed to load access status', getSafeErrorMetadata(error));
      res.status(500).json({ message: 'Failed to load insights access' });
    }
  };
}

export function createInsightsHandler({
  resolveInsightsConfig,
  getInsights,
  getInsightsAccess,
}: InsightsHandlerDeps) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    try {
      const {
        enabled,
        showDetails: configuredShowDetails,
        adminAllowAllAgents,
      } = resolveInsightsConfig(req);
      if (!enabled) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      if (!req.user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      const { agents, detailAgentIds } = await getInsightsAccess(req.user);
      if (agents.length === 0) {
        res.status(403).json({ message: 'Forbidden' });
        return;
      }
      const requestedAgentIds = stringValues(req.query.agentIds);
      const authorizedAgentIds = new Set(agents.map((agent) => agent.id));
      if (
        requestedAgentIds.some(
          (agentId) =>
            agentId.length > INSIGHTS_AGENT_ID_MAX_LENGTH || !authorizedAgentIds.has(agentId),
        )
      ) {
        res.status(403).json({ message: 'Forbidden' });
        return;
      }
      const requiresSelection =
        req.user.role === SystemRoles.ADMIN && adminAllowAllAgents === false;
      if (requiresSelection && requestedAgentIds.length === 0) {
        res.json(selectionResponse(agents));
        return;
      }
      if (
        requiresSelection &&
        authorizedAgentIds.size > 1 &&
        requestedAgentIds.length === authorizedAgentIds.size
      ) {
        res.status(403).json({ message: 'Forbidden' });
        return;
      }
      const agentIds = requestedAgentIds.length > 0 ? requestedAgentIds : [...authorizedAgentIds];
      const inspectableAgents = new Set(detailAgentIds);
      const showDetails =
        configuredShowDetails && agentIds.every((id) => inspectableAgents.has(id));

      const page = showDetails ? positiveInteger(req.query.page, 1) : 1;
      const pageSize = showDetails
        ? Math.min(50, Math.max(5, positiveInteger(req.query.pageSize, 10)))
        : 10;
      const tenantId = stringValue(req.user?.tenantId);
      const requestedSearch = stringValue(req.query.search)?.slice(0, INSIGHTS_SEARCH_MAX_LENGTH);
      const search =
        showDetails && requestedSearch && requestedSearch.length >= INSIGHTS_SEARCH_MIN_LENGTH
          ? requestedSearch
          : undefined;
      const insights = await getInsights({
        showDetails,
        page,
        pageSize,
        tenantId,
        agents,
        agentIds,
        search,
        range: insightsRange(req.query.range),
        fromTimestamp: stringValue(req.query.fromTimestamp),
        toTimestamp: stringValue(req.query.toTimestamp),
        timeZone: timeZoneValue(req.query.timeZone),
      });
      const response = {
        ...insights,
        ...(requiresSelection && { allAgentsAllowed: false }),
      };
      res.json(showDetails ? response : toAggregateInsightsResponse(response));
    } catch (error) {
      logger.error('[Insights] Failed to load dashboard', getSafeErrorMetadata(error));
      res.status(500).json({ message: 'Failed to load insights' });
    }
  };
}
