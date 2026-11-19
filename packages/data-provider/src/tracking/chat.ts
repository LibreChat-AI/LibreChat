import { z } from 'zod';
import {
  productBuiltinToolNameSchema,
  productProviderSchema,
  productAgentIdSchema,
  productModelSchema,
} from './privacy';

const id = z.string().min(1).max(256);
const feature = z.literal('chat');
const outcome = z.enum(['completed', 'cancelled', 'failed']);
const context = {
  conversationId: id.optional(),
  runId: id.optional(),
  parentRunId: id.optional(),
  agentId: productAgentIdSchema.optional(),
  model: productModelSchema.optional(),
  provider: productProviderSchema.optional(),
};

export const chatSubmissionKindSchema = z.enum(['send', 'retry', 'regenerate', 'edit', 'continue']);
export type ChatSubmissionKind = z.infer<typeof chatSubmissionKindSchema>;

export const chatBrowserFacts = [
  z.strictObject({
    name: z.literal('librechat.chat.message.steered'),
    feature,
    conversationId: id,
    clientSteerId: id,
    generationCreatedAt: z.number().finite().nonnegative().optional(),
  }),
  z.strictObject({
    name: z.literal('librechat.chat.message.submitted'),
    feature,
    submissionId: z.uuid(),
    kind: chatSubmissionKindSchema,
    ...context,
  }),
  z.strictObject({
    name: z.literal('librechat.chat.submission.failed'),
    feature,
    submissionId: z.uuid(),
    reason: z.enum(['rejected', 'unconfirmed']),
    ...context,
  }),
] as const;

const tokens = z.number().int().nonnegative().optional();

export const chatServerFacts = [
  z.strictObject({
    name: z.literal('librechat.chat.conversation.started'),
    feature,
    conversationId: id,
  }),
  z.strictObject({
    name: z.literal('librechat.chat.response.finished'),
    feature,
    ...context,
    runId: id,
    outcome,
    durationMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    name: z.literal('librechat.chat.model.usage.recorded'),
    feature,
    ...context,
    callId: id,
    usage_scope: z.enum(['call', 'run']).optional(),
    parentCallId: id.optional(),
    input_tokens: tokens,
    output_tokens: tokens,
    total_tokens: tokens,
    input_token_details: z
      .strictObject({
        cache_creation: tokens,
        cache_creation_1h: tokens,
        cache_creation_12h: tokens,
        cache_read: tokens,
      })
      .optional(),
    usage_type: z
      .enum([
        'title',
        'summarization',
        'subagent',
        'sequential',
        'activity-label',
        'activity-phase',
        'reasoning-label',
      ])
      .optional(),
    outcome,
  }),
  z.strictObject({
    name: z.literal('librechat.chat.agent.invoked'),
    feature,
    ...context,
    runId: id,
    agentId: productAgentIdSchema.optional(),
    agentInvocationId: id,
  }),
  z.strictObject({
    name: z.literal('librechat.chat.agent.finished'),
    feature,
    ...context,
    runId: id,
    agentId: productAgentIdSchema.optional(),
    agentInvocationId: id,
    outcome,
  }),
  z
    .strictObject({
      name: z.literal('librechat.chat.tool.invoked'),
      feature,
      ...context,
      toolCallId: id,
      toolCategory: z.enum(['builtin', 'mcp', 'action', 'custom']),
      toolName: productBuiltinToolNameSchema.optional(),
      parentToolCallId: id.optional(),
      mode: z.enum(['foreground', 'background', 'programmatic']),
    })
    .refine((fact) => (fact.toolCategory === 'builtin') === (fact.toolName !== undefined), {
      message: 'Only built-in tools carry a public name',
      path: ['toolName'],
    }),
  z
    .strictObject({
      name: z.literal('librechat.chat.tool.finished'),
      feature,
      ...context,
      toolCallId: id,
      toolCategory: z.enum(['builtin', 'mcp', 'action', 'custom']),
      toolName: productBuiltinToolNameSchema.optional(),
      parentToolCallId: id.optional(),
      mode: z.enum(['foreground', 'background', 'programmatic']),
      outcome,
      durationMs: z.number().finite().nonnegative(),
    })
    .refine((fact) => (fact.toolCategory === 'builtin') === (fact.toolName !== undefined), {
      message: 'Only built-in tools carry a public name',
      path: ['toolName'],
    }),
] as const;

export type ChatBrowserFact = z.infer<(typeof chatBrowserFacts)[number]>;
export type ChatServerFact = z.infer<(typeof chatServerFacts)[number]>;
