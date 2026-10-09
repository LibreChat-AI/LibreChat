import { z } from 'zod';
import { MAX_PATTERN_LENGTH } from '@librechat/agents';

const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_COMMAND_LENGTH = 32_768;
const MAX_HANDLER_TYPE_LENGTH = 64;
const MAX_STATUS_MESSAGE_LENGTH = 500;
const MAX_EVENT_NAME_LENGTH = 80;
const MAX_GROUPS_PER_EVENT = 128;
const MAX_HANDLERS_PER_GROUP = 32;
const MAX_TOTAL_HANDLERS = 512;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_COMMAND_ARGS = 256;
const MAX_HTTP_HEADERS = 256;

export interface PluginHookHandler {
  type: string;
  command?: string;
  commandWindows?: string;
  args?: string[];
  shell?: 'bash' | 'powershell';
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  prompt?: string;
  model?: string;
  timeout?: number;
  statusMessage?: string;
  if?: string;
  once?: boolean;
  continueOnBlock?: boolean;
  async?: boolean;
  asyncRewake?: boolean;
  rewakeMessage?: string;
  rewakeSummary?: string;
}

export interface PluginHookGroup {
  matcher?: string;
  if?: string;
  hooks: PluginHookHandler[];
}

export interface PluginHooksDocument {
  $schema?: string;
  description?: string;
  hooks: Record<string, PluginHookGroup[]>;
}

export const pluginHookHandlerSchema: z.ZodType<PluginHookHandler> = z
  .object({
    type: z.string().trim().min(1).max(MAX_HANDLER_TYPE_LENGTH),
    command: z.string().min(1).max(MAX_COMMAND_LENGTH).optional(),
    commandWindows: z.string().min(1).max(MAX_COMMAND_LENGTH).optional(),
    args: z.array(z.string().max(MAX_COMMAND_LENGTH)).max(MAX_COMMAND_ARGS).optional(),
    shell: z.enum(['bash', 'powershell']).optional(),
    url: z.string().trim().min(1).max(MAX_COMMAND_LENGTH).optional(),
    headers: z
      .record(
        z.string().trim().min(1).max(MAX_STATUS_MESSAGE_LENGTH),
        z.string().max(MAX_COMMAND_LENGTH),
      )
      .refine((headers) => Object.keys(headers).length <= MAX_HTTP_HEADERS, {
        message: `HTTP hooks may declare at most ${MAX_HTTP_HEADERS} headers`,
      })
      .optional(),
    allowedEnvVars: z
      .array(z.string().trim().min(1).max(MAX_STATUS_MESSAGE_LENGTH))
      .max(MAX_COMMAND_ARGS)
      .optional(),
    server: z.string().trim().min(1).max(MAX_STATUS_MESSAGE_LENGTH).optional(),
    tool: z.string().trim().min(1).max(MAX_STATUS_MESSAGE_LENGTH).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    prompt: z.string().min(1).max(MAX_COMMAND_LENGTH).optional(),
    model: z.string().trim().min(1).max(MAX_STATUS_MESSAGE_LENGTH).optional(),
    timeout: z.number().int().positive().max(MAX_TIMEOUT_SECONDS).optional(),
    statusMessage: z.string().max(MAX_STATUS_MESSAGE_LENGTH).optional(),
    if: z.string().trim().min(1).max(MAX_COMMAND_LENGTH).optional(),
    once: z.boolean().optional(),
    continueOnBlock: z.boolean().optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    rewakeMessage: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    rewakeSummary: z.string().max(MAX_STATUS_MESSAGE_LENGTH).optional(),
  })
  .strict()
  .superRefine((handler, context) => {
    if (handler.type === 'command' && !handler.command?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'Command hooks require a non-empty command',
      });
    }
    if (handler.type === 'prompt' && !handler.prompt?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Prompt hooks require a non-empty prompt',
      });
    }
    if (handler.type === 'agent' && !handler.prompt?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Agent hooks require a non-empty prompt',
      });
    }
    if (handler.type === 'http' && !handler.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'HTTP hooks require a non-empty URL',
      });
    }
    if (handler.type === 'mcp_tool' && !handler.server) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['server'],
        message: 'MCP tool hooks require a non-empty server',
      });
    }
    if (handler.type === 'mcp_tool' && !handler.tool) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool'],
        message: 'MCP tool hooks require a non-empty tool',
      });
    }
  });

export const pluginHookGroupSchema: z.ZodType<PluginHookGroup> = z
  .object({
    matcher: z.string().trim().max(MAX_PATTERN_LENGTH).optional(),
    /** Retained for older hook bundles; current Claude plugins declare `if` per handler. */
    if: z.string().trim().min(1).max(MAX_COMMAND_LENGTH).optional(),
    hooks: z.array(pluginHookHandlerSchema).min(1).max(MAX_HANDLERS_PER_GROUP),
  })
  .strict();

const pluginHookEventsSchema = z.record(
  z.string().trim().min(1).max(MAX_EVENT_NAME_LENGTH),
  z.array(pluginHookGroupSchema).min(1).max(MAX_GROUPS_PER_EVENT),
);

export const pluginHooksDocumentSchema: z.ZodType<PluginHooksDocument> = z
  .object({
    $schema: z.string().trim().min(1).max(MAX_COMMAND_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    hooks: pluginHookEventsSchema,
  })
  .strict()
  .superRefine((document, context) => {
    let total = 0;
    for (const groups of Object.values(document.hooks)) {
      for (const group of groups) {
        total += group.hooks.length;
        if (total <= MAX_TOTAL_HANDLERS) {
          continue;
        }
        context.addIssue({
          code: z.ZodIssueCode.too_big,
          type: 'array',
          maximum: MAX_TOTAL_HANDLERS,
          inclusive: true,
          path: ['hooks'],
          message: `Hook documents may declare at most ${MAX_TOTAL_HANDLERS} handlers`,
        });
        return;
      }
    }
  });

export interface PluginHookValidationIssue {
  path: string;
  message: string;
}

export type PluginHooksParseResult =
  | { success: true; document: PluginHooksDocument }
  | { success: false; issues: PluginHookValidationIssue[] };

/** Parse Claude's plugin-specific `{"hooks": {...}}` wrapper. */
export function parsePluginHooks(input: unknown): PluginHooksParseResult {
  const parsed = pluginHooksDocumentSchema.safeParse(input);
  if (parsed.success) {
    return { success: true, document: parsed.data };
  }
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
