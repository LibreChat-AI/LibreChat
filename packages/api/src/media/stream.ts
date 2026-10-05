import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { mediaIdSchema, mediaRenditionKindSchema } from 'librechat-data-provider';
import type { MediaMethods, MediaOwnerScope } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { MediaStorage } from './storage';
import { classifyMediaError, sendMediaError } from './http';
import { getContentDisposition } from '~/utils/files';
import { storageRangeResponse } from '~/storage/read';
import { MediaServiceError } from './errors';

/** Browser-native reads only; mutations remain behind bearer authentication. */
export function createMediaContentRouter({
  repository,
  storage,
  resolveScope,
  log,
}: {
  repository: Pick<MediaMethods, 'getMediaAssetContent'>;
  storage: Pick<MediaStorage, 'open'>;
  resolveScope(request: Request): MediaOwnerScope;
  log(message: string, error?: Error): void;
}): Router {
  const router = Router();
  router.get('/:fileId/content', async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    try {
      const scope = resolveScope(req);
      const fileId = mediaIdSchema.parse(req.params.fileId);
      const rendition = mediaRenditionKindSchema.optional().parse(req.query.rendition);
      const asset = await repository.getMediaAssetContent(scope, fileId);
      const content = rendition ? asset?.mediaRenditions?.[rendition] : asset;
      if (!asset || !content) {
        throw new MediaServiceError('not_found', 404, 'Media content was not found.');
      }
      const framing = storageRangeResponse(req.headers.range, content.bytes);
      const { range } = framing;
      res.status(framing.status).set(framing.headers);
      res.set({
        'Content-Type': content.type,
        'Content-Disposition': getContentDisposition(
          asset.filename,
          content.type === 'image/svg+xml' ? 'attachment' : 'inline',
        ),
      });
      if (framing.status === 416) {
        res.end();
        return;
      }
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = await storage.open(scope, asset, {
        rendition,
        range,
        signal: controller.signal,
      });
      await pipeline(stream, res, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof Error ? error : new Error('Media streaming failed.');
      if (!classifyMediaError(failure)) log('[media] Content streaming failed.', failure);
      if (res.headersSent || res.destroyed) {
        res.destroy();
      } else {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
        sendMediaError(res, failure);
      }
    } finally {
      res.removeListener('close', close);
    }
  });
  return router;
}
