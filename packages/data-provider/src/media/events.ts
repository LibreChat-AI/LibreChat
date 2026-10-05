import { z } from 'zod';
import { mediaIdSchema } from './requests';

/** A live refetch hint; durable HTTP snapshots remain the source of truth. */
export const mediaActivitySchema = z
  .object({
    threadId: mediaIdSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();
export type MediaActivity = z.infer<typeof mediaActivitySchema>;
