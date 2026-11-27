import { logger } from '@librechat/data-schemas';
import type { TBannerResponse } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { ServerRequest } from '~/types/http';

export function createBannerHandler(
  getBanner: (user?: ServerRequest['user']) => Promise<TBannerResponse>,
): RequestHandler {
  return async (req, res) => {
    try {
      const request = req as ServerRequest;
      const banner = await getBanner(request.user);
      const payload: TBannerResponse = banner
        ? {
            bannerId: banner.bannerId,
            message: banner.message,
            persistable: banner.persistable ?? false,
          }
        : null;
      res.status(200).send(payload);
    } catch (error) {
      logger.error('[getBanner] Error getting banner', error);
      res.status(500).json({ message: 'Error getting banner' });
    }
  };
}
