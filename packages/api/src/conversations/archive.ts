import { logger } from '@librechat/data-schemas';

import type { ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

type ArchiveAllHandlerDependencies = Pick<ConversationMethods, 'archiveAllConvos'>;

export function createArchiveAllHandler(
  deps: ArchiveAllHandlerDependencies,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async function archiveAllHandler(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const result = await deps.archiveAllConvos(req.user!.id);
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Error archiving all conversations', error);
      return res.status(500).send('Error archiving all conversations');
    }
  };
}
