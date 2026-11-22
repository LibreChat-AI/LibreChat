import { logger } from '@librechat/data-schemas';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { getSafeErrorMetadata } from '~/utils/errors';
import { resolveDownloadPath } from '~/storage/path';
import { pipeToResponse } from '~/utils/streams';

interface RemoteAgentFile {
  file_id: string;
  filepath: string;
  source?: string;
  storageKey?: string | null;
  type?: string;
}

type GetDownloadStream = (req: ServerRequest, path: string) => Promise<Readable>;

export interface RemoteAgentFileDownloadDependencies {
  getStrategyFunctions: (source?: string) => {
    getDownloadStream?: GetDownloadStream | null;
  };
}

export function getRemoteAgentFileUrl(fileId: string): string {
  return `/api/agents/v1/files/${encodeURIComponent(fileId)}/content`;
}

/**
 * Streams a file already authorized by the route's file-access middleware.
 * Remote Agent credentials deliberately receive bytes, never a storage path or signed URL.
 */
export async function sendRemoteAgentFile({
  req,
  res,
  file,
  getStrategyFunctions,
}: {
  req: ServerRequest;
  res: Response;
  file: RemoteAgentFile;
  getStrategyFunctions: RemoteAgentFileDownloadDependencies['getStrategyFunctions'];
}): Promise<void> {
  const { getDownloadStream } = getStrategyFunctions(file.source);
  if (!getDownloadStream) {
    logger.warn('[remoteAgentFile] File has no streaming strategy', {
      fileId: file.file_id,
      source: file.source,
    });
    res.status(501).send('Not Implemented');
    return;
  }

  try {
    const stream = await getDownloadStream(req, resolveDownloadPath(file));
    if (res.destroyed) {
      stream.destroy();
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', file.type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    pipeToResponse(stream, res, (error) => {
      logger.error('[remoteAgentFile] File stream failed', {
        fileId: file.file_id,
        ...getSafeErrorMetadata(error),
      });
    });
  } catch (error) {
    logger.error('[remoteAgentFile] Could not open file stream', {
      fileId: file.file_id,
      ...getSafeErrorMetadata(error),
    });
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.destroy();
      }
      return;
    }
    res.status(500).send('Error downloading file');
  }
}
