import { logger } from '@librechat/data-schemas';
import {
  INSIGHTS_SEARCH_MAX_LENGTH,
  INSIGHTS_SEARCH_MIN_LENGTH,
  INSIGHTS_AGENT_ID_MAX_LENGTH,
  type TInsightsAgent,
  type TInsightsParams,
} from 'librechat-data-provider';
import type { InsightsMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

type InsightsHandlerDeps = {
  isInsightsEnabled: () => boolean;
  getInsights: InsightsMethods['getInsights'];
  getAccessibleAgents: (user: NonNullable<ServerRequest['user']>) => Promise<TInsightsAgent[]>;
};

type InsightsAccessHandlerDeps = Pick<
  InsightsHandlerDeps,
  'isInsightsEnabled' | 'getAccessibleAgents'
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

export function createInsightsAccessHandler({
  isInsightsEnabled,
  getAccessibleAgents,
}: InsightsAccessHandlerDeps) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    try {
      if (!isInsightsEnabled()) {
        res.status(404).json({ message: 'Not found' });
        return;
      }

      if (!req.user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }
      const agents = await getAccessibleAgents(req.user);
      if (agents.length === 0) {
        res.status(403).json({ message: 'Forbidden' });
        return;
      }

      res.json({ access: true });
    } catch (error) {
      logger.error('[Insights] Failed to load access status', error);
      res.status(500).json({ message: 'Failed to load insights access' });
    }
  };
}

export function createInsightsHandler({
  isInsightsEnabled,
  getInsights,
  getAccessibleAgents,
}: InsightsHandlerDeps) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    try {
      if (!isInsightsEnabled()) {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      if (!req.user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      const agents = await getAccessibleAgents(req.user);
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
      const agentIds = requestedAgentIds.length > 0 ? requestedAgentIds : [...authorizedAgentIds];

      const page = positiveInteger(req.query.page, 1);
      const pageSize = Math.min(50, Math.max(5, positiveInteger(req.query.pageSize, 10)));
      const tenantId = stringValue(req.user?.tenantId);
      const requestedSearch = stringValue(req.query.search)?.slice(0, INSIGHTS_SEARCH_MAX_LENGTH);
      const search =
        requestedSearch && requestedSearch.length >= INSIGHTS_SEARCH_MIN_LENGTH
          ? requestedSearch
          : undefined;
      const insights = await getInsights({
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
      res.json(insights);
    } catch (error) {
      logger.error('[Insights] Failed to load dashboard', error);
      res.status(500).json({ message: 'Failed to load insights' });
    }
  };
}
