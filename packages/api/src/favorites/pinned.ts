import { logger } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

/** Pinning a conversation has no membership cap and the sidebar query drains
 *  every cursor, so an account can legitimately present any number of keys: a
 *  count limit would reject a valid sidebar rather than bound anything. What
 *  needs bounding is the user document this is stored in, so the guard is on
 *  total size, which only an abusive payload reaches. */
const MAX_PINNED_ORDER_BYTES = 256 * 1024;

/** The longest key a valid entry can produce is a model favorite's
 *  `model:${endpoint.length}:${endpoint}:${model}`: the favorites endpoint
 *  accepts 256 characters for each half, so 6 + 3 + 1 + 256 + 1 + 256, plus
 *  headroom. */
const MAX_PINNED_ORDER_KEY_LENGTH = 560;

export interface PinnedOrderHandlersDeps {
  /** User read/write — from `@librechat/data-schemas` `createMethods` output. */
  getUserById: (userId: string, fieldsToSelect?: string) => Promise<IUser | null>;
  updateUser: (userId: string, updateData: Partial<IUser>) => Promise<IUser | null>;
  invalidateCachedAuthUserDoc: (userId: string) => Promise<void>;
}

function validatePinnedOrder(pinnedOrder: unknown, res: Response): string[] | null {
  if (!Array.isArray(pinnedOrder)) {
    res.status(400).json({ message: 'pinnedOrder must be an array' });
    return null;
  }

  let totalBytes = 0;
  for (const key of pinnedOrder) {
    if (typeof key !== 'string' || key.length === 0) {
      res.status(400).json({ message: 'Each pinnedOrder entry must be a non-empty string' });
      return null;
    }
    if (key.length > MAX_PINNED_ORDER_KEY_LENGTH) {
      res.status(400).json({
        message: `pinnedOrder entry exceeds maximum length of ${MAX_PINNED_ORDER_KEY_LENGTH}`,
      });
      return null;
    }
    totalBytes += Buffer.byteLength(key, 'utf8');
    if (totalBytes > MAX_PINNED_ORDER_BYTES) {
      res
        .status(400)
        .json({ message: `pinnedOrder exceeds maximum size of ${MAX_PINNED_ORDER_BYTES} bytes` });
      return null;
    }
  }

  if (new Set(pinnedOrder).size !== pinnedOrder.length) {
    res.status(400).json({ message: 'pinnedOrder entries must be unique' });
    return null;
  }

  return pinnedOrder as string[];
}

/** Combined display order for the sidebar's Pinned section. Keys interleave
 *  favorites and pinned chats (`agent:`, `spec:`, `model:`, `convo:`), so the
 *  two systems keep their own membership while sharing one ordering. */
export function createPinnedOrderHandlers(deps: PinnedOrderHandlersDeps): {
  getPinnedOrder: (req: ServerRequest, res: Response) => Promise<Response>;
  updatePinnedOrder: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  async function getPinnedOrder(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
      const user = await deps.getUserById(userId, '+pinnedOrder');
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      return res.status(200).json(user.pinnedOrder ?? []);
    } catch (error) {
      logger.error('[PinnedOrder] Error fetching pinned order:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  async function updatePinnedOrder(req: ServerRequest, res: Response): Promise<Response> {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    /* A request with no JSON body, or a literal `null` one, leaves `req.body`
     * nullish. Destructuring it would throw past this handler and answer with
     * Express's generic error page instead of the 400 the validator gives. */
    const pinnedOrder = (req.body as { pinnedOrder?: unknown } | null | undefined)?.pinnedOrder;
    const validated = validatePinnedOrder(pinnedOrder, res);
    if (validated == null) {
      return res;
    }
    try {
      const user = await deps.updateUser(userId, { pinnedOrder: validated });
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      await deps.invalidateCachedAuthUserDoc(userId);
      /* The field is deselected at schema level, so the updated document does
       * not carry it back. What was just stored is what to answer with. */
      return res.status(200).json(validated);
    } catch (error) {
      logger.error('[PinnedOrder] Error updating pinned order:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  return { getPinnedOrder, updatePinnedOrder };
}
