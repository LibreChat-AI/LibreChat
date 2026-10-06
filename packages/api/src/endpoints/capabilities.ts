import { logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ReasoningCapabilityResult } from './reasoning';
import type { ServerRequest } from '~/types';

export interface ReasoningCapabilitiesHandlerDeps {
  getReasoningCapabilities: (appConfig?: AppConfig) => Promise<ReasoningCapabilityResult>;
}

/**
 * `GET /api/endpoints/reasoning-capabilities`: the efforts each OpenRouter model accepts.
 * A catalog that could not be read answers 503 with a stable code, never a 200 with the
 * endpoint missing, so the client retries instead of caching an outage as data. Only the
 * code is returned: not the endpoint names, URLs or error text.
 */
export function createReasoningCapabilitiesHandler(deps: ReasoningCapabilitiesHandlerDeps) {
  return async (req: ServerRequest, res: Response): Promise<Response> => {
    try {
      const { capabilities, unavailable } = await deps.getReasoningCapabilities(req.config);
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
