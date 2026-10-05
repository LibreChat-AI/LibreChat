import { z } from 'zod';

/** Public setup instructions only; saved credential values never belong in the catalog. */
export const mediaUserKeySchema = z
  .object({
    keyName: z.string().min(1),
    encoding: z.enum(['google', 'apiKey']),
    userProvideURL: z.boolean(),
  })
  .strict();
