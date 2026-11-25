import { z } from 'zod';
import type { RawContent } from './adapter';

/** String fallbacks that Express serves as `text/html` from the final application error controller. */
export const genericServerErrorContent: RawContent = {
  'text/html': {
    schema: {
      type: 'string',
      enum: ['An unknown error occurred.', 'Processing error in ErrorController.'],
    },
  },
};

/**
 * The flat `{ error }` envelope the auth middleware sends for 401 (`{ error: 'Unauthorized' }`)
 * and for its own 500 (`{ error: 'Internal server error' }`). One field, distinct from the nested
 * `agentManagementErrorSchema`.
 */
export const errorMessageResponseSchema: z.ZodType<{ error: string }> = z
  .object({ error: z.string() })
  .strict();

/**
 * When the bound account is being deleted, the auth middleware sends 409 with a flat
 * `{ error, code: 'ACCOUNT_DELETION_IN_PROGRESS' }` body. The code is a fixed discriminator.
 */
export const accountDeletionResponseSchema: z.ZodType<{
  error: string;
  code: 'ACCOUNT_DELETION_IN_PROGRESS';
}> = z.object({ error: z.string(), code: z.literal('ACCOUNT_DELETION_IN_PROGRESS') }).strict();

/**
 * The ban middleware (403) and the default file-upload limiter (429) send a flat `{ message }`
 * body, distinct from the other error shapes.
 */
export const messageResponseSchema: z.ZodType<{ message: string }> = z
  .object({ message: z.string() })
  .strict();

/**
 * The global JSON body parser runs before these routes and, on malformed JSON, returns 400 with
 * a flat `{ error: 'Invalid JSON format', message }` body. The `error` field is a fixed discriminator.
 */
export const jsonParseErrorSchema: z.ZodType<{ error: 'Invalid JSON format'; message: string }> = z
  .object({ error: z.literal('Invalid JSON format'), message: z.string() })
  .strict();
