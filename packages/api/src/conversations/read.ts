import { logger } from '@librechat/data-schemas';

import type { ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

type SeenHandlerDependencies = Pick<ConversationMethods, 'markConvoSeen'>;
type UnreadHandlerDependencies = Pick<ConversationMethods, 'markConvoUnread'>;

type ReadStateArg = {
  conversationId?: string;
  lastResponseAt?: string;
};

const readArg = (req: ServerRequest): ReadStateArg =>
  (req.body as { arg?: ReadStateArg } | undefined)?.arg ?? {};

/**
 * Records that the user has caught up with a conversation's newest message.
 *
 * The catch-up itself is server-stamped, which keeps this idempotent and independent of client
 * clocks. `lastResponseAt` names the reply the client actually had on screen, so a newer one
 * persisted from another device in the meantime is not acknowledged along with it.
 */
export function createMarkConvoSeenHandler(
  deps: SeenHandlerDependencies,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async function markConvoSeenHandler(req: ServerRequest, res: Response) {
    const { conversationId, lastResponseAt } = readArg(req);

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    const observedResponseAt = lastResponseAt != null ? new Date(lastResponseAt) : undefined;
    if (observedResponseAt && Number.isNaN(observedResponseAt.getTime())) {
      return res.status(400).json({ error: 'lastResponseAt must be a valid date' });
    }

    try {
      const result = await deps.markConvoSeen(req.user!.id, conversationId, observedResponseAt);
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Error marking conversation seen', error);
      return res.status(500).send('Error marking conversation seen');
    }
  };
}

/**
 * Flags a conversation as unread again for this user.
 *
 * The server clears the catch-up and, for a conversation without a reply yet, treats the flag
 * itself as the unread marker, so no client timestamp is trusted. The resulting `lastResponseAt`
 * comes back with it, which is what the next acknowledgement has to name.
 */
export function createMarkConvoUnreadHandler(
  deps: UnreadHandlerDependencies,
): (req: ServerRequest, res: Response) => Promise<Response> {
  return async function markConvoUnreadHandler(req: ServerRequest, res: Response) {
    const { conversationId } = readArg(req);

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    try {
      const result = await deps.markConvoUnread(req.user!.id, conversationId);
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Error marking conversation unread', error);
      return res.status(500).send('Error marking conversation unread');
    }
  };
}
