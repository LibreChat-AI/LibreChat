import { logger } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';

/** Report the generation actually applied here, without disclosing the YAML or its hash. */
export function createConfigRevisionHandler(
  getStatus: () => Promise<{
    distributed: boolean;
    generation: number | null;
    pollIntervalMs: number;
  }>,
): RequestHandler {
  return async (req, res) => {
    if (!req.user) {
      res.sendStatus(401);
      return;
    }
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await getStatus());
    } catch (error) {
      logger.error('[configReload] Could not read local model catalog revision:', error);
      res.sendStatus(500);
    }
  };
}
