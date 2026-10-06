import { logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ReasoningCapabilityResult, ServerRequest } from '~/types';

export interface ReasoningCapabilitiesHandlerDeps {
  getReasoningCapabilities: (
    appConfig?: AppConfig,
    endpoint?: string,
  ) => Promise<ReasoningCapabilityResult>;
}

/**
 * `GET /api/endpoints/reasoning-capabilities?endpoint=<name>`: the efforts each model of one
 * OpenRouter endpoint accepts. Scoped to the endpoint so another endpoint's outage never hides
 * its data. A catalog that could not be read answers 503 with a stable code, never a 200 with the
 * endpoint missing, so the client retries instead of caching an outage as data. Only the
 * code is returned: not the endpoint names, URLs or error text.
 */
export function createReasoningCapabilitiesHandler(deps: ReasoningCapabilitiesHandlerDeps) {
  return async (req: ServerRequest, res: Response): Promise<Response> => {
    const endpoint = req.query?.endpoint;
    if (typeof endpoint !== 'string' || endpoint === '') {
      return res.status(400).json({ error: 'endpoint_required' });
    }
    try {
      const { capabilities, unavailable } = await deps.getReasoningCapabilities(
        req.config,
        endpoint,
      );
      if (unavailable.length > 0) {
        return res.status(503).json({ error: 'reasoning_catalog_unavailable' });
      }
      return res.json(capabilities);
    } catch (error) {
      logger.error('[reasoningCapabilitiesHandler] Failed to resolve reasoning capabilities', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return res.status(500).json({ error: 'reasoning_capabilities_failed' });
    }
  };
}
