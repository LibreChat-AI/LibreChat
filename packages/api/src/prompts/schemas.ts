import { z } from 'zod';
import { Constants } from 'librechat-data-provider';

export type TPromptPayloadSchema = {
  prompt: string;
  type: 'text' | 'chat';
};

const PROMPT_TEXT_MESSAGE = 'Prompt text is required and must be a non-empty string';
const PROMPT_TYPE_MESSAGE = 'Prompt type must be "text" or "chat"';

/** Validates a new revision. Unknown keys, such as the editor's `groupId`, are removed. */
const promptPayloadSchema: z.ZodType<TPromptPayloadSchema> = z.object(
  {
    prompt: z
      .string({ required_error: PROMPT_TEXT_MESSAGE, invalid_type_error: PROMPT_TEXT_MESSAGE })
      .refine((value) => value.trim().length > 0, { message: PROMPT_TEXT_MESSAGE }),
    type: z.enum(['text', 'chat'], { errorMap: () => ({ message: PROMPT_TYPE_MESSAGE }) }),
  },
  { invalid_type_error: PROMPT_TEXT_MESSAGE },
);

export function safeValidatePromptPayload(
  data: unknown,
): z.SafeParseReturnType<unknown, TPromptPayloadSchema> {
  return promptPayloadSchema.safeParse(data);
}

/**
 * Schema for validating prompt group update payloads.
 * Only allows fields that users should be able to modify.
 * Sensitive fields like author, authorName, _id, productionId, etc. are excluded.
 */
export const updatePromptGroupSchema: z.ZodObject<
  {
    /** The name of the prompt group */
    name: z.ZodOptional<z.ZodString>;
    /** Short description/oneliner for the prompt group */
    oneliner: z.ZodOptional<z.ZodString>;
    /** Category for organizing prompt groups */
    category: z.ZodOptional<z.ZodString>;
    /** Command shortcut for the prompt group */
    command: z.ZodNullable<z.ZodOptional<z.ZodString>>;
  },
  'strict'
> = z
  .object({
    /** The name of the prompt group */
    name: z.string().min(1).max(255).optional(),
    /** Short description/oneliner for the prompt group */
    oneliner: z.string().max(500).optional(),
    /** Category for organizing prompt groups */
    category: z.string().max(100).optional(),
    /** Command shortcut for the prompt group */
    command: z
      .string()
      .max(Constants.COMMANDS_MAX_LENGTH as number)
      .regex(/^[a-z0-9-]*$/, {
        message: 'Command must only contain lowercase alphanumeric characters and hyphens',
      })
      .optional()
      .nullable(),
  })
  .strict();

export type TUpdatePromptGroupSchema = z.infer<typeof updatePromptGroupSchema>;

/**
 * Validates and sanitizes a prompt group update payload.
 * Returns only the allowed fields, stripping any sensitive fields.
 * @param data - The raw request body to validate
 * @returns The validated and sanitized payload
 * @throws ZodError if validation fails
 */
export function validatePromptGroupUpdate(data: unknown): TUpdatePromptGroupSchema {
  return updatePromptGroupSchema.parse(data);
}

/**
 * Safely validates a prompt group update payload without throwing.
 * @param data - The raw request body to validate
 * @returns A SafeParseResult with either the validated data or validation errors
 */
export function safeValidatePromptGroupUpdate(data: unknown): z.SafeParseReturnType<
  {
    name?: string | undefined;
    category?: string | undefined;
    command?: string | null | undefined;
    oneliner?: string | undefined;
  },
  {
    name?: string | undefined;
    category?: string | undefined;
    command?: string | null | undefined;
    oneliner?: string | undefined;
  }
> {
  return updatePromptGroupSchema.safeParse(data);
}
