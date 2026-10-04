import { z } from 'zod';
import type { MessageMethods } from '@librechat/data-schemas';
import type { RequestHandler, Request } from 'express';
import { createPrivateTextCipher } from './crypto';
import { privateTextBinding } from './submission';

/** Defense in depth for search hits and mutation responses that bypass normal Mongo projections. */
export function stripPrivateMessageFields<
  T extends { privateText?: unknown; contextMeta?: unknown },
>(message: T): Omit<T, 'privateText' | 'contextMeta'> {
  const { privateText: _privateText, contextMeta: _contextMeta, ...publicMessage } = message;
  return publicMessage;
}

const inputSchema = z
  .object({
    messageIds: z.array(z.string().min(1).max(256)).min(1).max(50),
  })
  .strict();

export function createPrivateTextView(options: {
  read: MessageMethods['getPrivateMessageTexts'];
  getKey(): string;
}): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const request = req as Request & { user?: { id?: string; tenantId?: string | null } };
    const userId = request.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const input = inputSchema.safeParse(req.body);
    const conversationId = req.params.conversationId;
    if (!input.success || typeof conversationId !== 'string') {
      res.status(400).json({ error: 'Invalid private message request' });
      return;
    }
    try {
      const tenantId = request.user?.tenantId ?? '';
      const rows = await options.read({
        userId,
        tenantId: tenantId || undefined,
        conversationId,
        messageIds: input.data.messageIds,
      });
      const cipher = createPrivateTextCipher(options.getKey());
      const messages = rows.map((row) => {
        try {
          const text = cipher.open(
            row.privateText,
            privateTextBinding(userId, tenantId, { ...row, conversationId }),
          );
          return {
            messageId: row.messageId,
            revision: row.privacyRevision,
            canonicalText: row.text,
            text,
          };
        } catch {
          return {
            messageId: row.messageId,
            revision: row.privacyRevision,
            canonicalText: row.text,
          };
        }
      });
      res.status(200).json({ messages });
    } catch {
      res.status(503).json({ error: 'Private message text is unavailable.' });
    }
  };
}
