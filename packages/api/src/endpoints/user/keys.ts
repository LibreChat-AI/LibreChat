import { z } from 'zod';
import type { KeyMethods } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';

export type UserKeyUpdateDependencies = Pick<KeyMethods, 'updateUserKey'>;

const requestSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  expiresAt: z
    .string()
    .refine((value) => value === '' || Number.isFinite(new Date(value).getTime()))
    .nullable()
    .optional(),
});

export function createUserKeyUpdateHandler(deps: UserKeyUpdateDependencies): RequestHandler {
  return async (req, res) => {
    const user = z.object({ id: z.string().min(1) }).safeParse(req.user);
    if (!user.success) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    try {
      await deps.updateUserKey({ userId: user.data.id, ...parsed.data });
      res.status(201).send();
    } catch {
      res.status(500).json({ error: 'Unable to update the saved key.' });
    }
  };
}
