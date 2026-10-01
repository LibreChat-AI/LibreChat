import { z } from 'zod';
import type {
  AgentSubagentGraph,
  AgentSubagentGraphEdge,
  AgentSubagentsConfig,
} from 'librechat-data-provider';
import { agentCreateSchema, agentUpdateSchema } from './validation';

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;
const MAX_CURSOR_LENGTH = 512;

export type AgentManagementCreate = Omit<z.output<typeof agentCreateSchema>, 'model'> & {
  model: string;
};
type AgentManagementCreateInput = Omit<z.input<typeof agentCreateSchema>, 'model'> & {
  model: string;
};
export type AgentManagementUpdate = Omit<
  z.output<typeof agentUpdateSchema>,
  'name' | 'description' | 'instructions' | 'model' | 'avatar'
> & {
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  avatar?: null;
};
export type AgentManagementList = {
  limit: number;
  cursor?: string;
};
export type AgentManagementResponse = Omit<
  z.output<typeof agentUpdateSchema>,
  'provider' | 'model'
> & {
  id: string;
  provider: string;
  model: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type AgentManagementProjectionSource = Partial<
  Omit<
    AgentManagementResponse,
    'id' | 'provider' | 'model' | 'version' | 'createdAt' | 'updatedAt' | 'avatar'
  >
> & {
  id?: string;
  provider?: string;
  model?: string | null;
  avatar?: AgentManagementResponse['avatar'] | string;
  version?: number;
  versions?: readonly object[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
};
export type AgentManagementListProjectionSource = {
  data?: AgentManagementProjectionSource[];
  has_more?: boolean;
  after?: string | null;
};
export type AgentManagementListResponse = {
  object: 'list';
  data: AgentManagementResponse[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
  after: string | null;
};
export type AgentManagementDeleteResponse = {
  id: string;
  deleted: true;
};
export type AgentManagementErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'permission_denied'
  | 'internal_error'
  | 'conflict';
export type AgentManagementError = {
  error: {
    code: AgentManagementErrorCode;
    message: string;
    details?: Array<{ path: Array<string | number>; message: string }>;
  };
};

/**
 * Agent Management accepts the browser-supported configuration fields, but unlike the
 * browser endpoints it rejects unknown top-level fields instead of silently stripping them.
 */
export const agentManagementCreateSchema: z.ZodType<
  AgentManagementCreate,
  z.ZodTypeDef,
  AgentManagementCreateInput
> = agentCreateSchema.extend({ model: z.string() }).strict();
export const agentManagementUpdateSchema: z.ZodType<AgentManagementUpdate> = agentUpdateSchema
  .extend({
    name: z.string().optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    model: z.string().optional(),
    avatar: z.null().optional(),
  })
  .strict();

const agentManagementCursorSchema = z
  .string()
  .min(1)
  .max(MAX_CURSOR_LENGTH)
  .superRefine((cursor, context) => {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as unknown;
      const result = z
        .object({
          updatedAt: z.string().datetime(),
          _id: z.string().regex(/^[a-f\d]{24}$/i),
        })
        .strict()
        .safeParse(decoded);

      if (!result.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid cursor' });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid cursor' });
    }
  });

export const agentManagementListSchema: z.ZodType<AgentManagementList, z.ZodTypeDef, unknown> = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
    cursor: agentManagementCursorSchema.optional(),
  })
  .strict();

const timestampSchema = z.string().datetime();
const agentManagementGraphEdgeResponseSchema: z.ZodType<AgentSubagentGraphEdge> = z
  .object({
    from: z.union([z.string(), z.array(z.string())]),
    to: z.union([z.string(), z.array(z.string())]),
    description: z.string().optional(),
    edgeType: z.literal('direct'),
    prompt: z.string().optional(),
    excludeResults: z.boolean().optional(),
  })
  .strict();
const agentManagementGraphResponseSchema: z.ZodType<AgentSubagentGraph> = z
  .object({
    type: z.string(),
    name: z.string(),
    description: z.string(),
    agent_ids: z.array(z.string()),
    edges: z.array(agentManagementGraphEdgeResponseSchema),
    entry_agent_id: z.string(),
    result_agent_id: z.string(),
  })
  .strict();
const agentManagementSubagentsResponseSchema: z.ZodType<AgentSubagentsConfig | undefined> = z
  .object({
    enabled: z.boolean().optional(),
    allowSelf: z.boolean().optional(),
    agent_ids: z.array(z.string()).optional(),
    graphs: z.array(agentManagementGraphResponseSchema).optional(),
  })
  .strict()
  .optional();

/** The externally supported Agent shape. Persistence and ownership fields are intentionally absent. */
export const agentManagementResponseSchema: z.ZodType<AgentManagementResponse> = agentUpdateSchema
  .extend({
    id: z.string().min(1),
    provider: z.string(),
    model: z.string().nullable(),
    version: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    subagents: agentManagementSubagentsResponseSchema,
  })
  .strict();

/** The list envelope as a plain object, so the OpenAPI contract can reuse it and override only `data`. */
export const agentManagementListEnvelopeSchema: z.ZodType<AgentManagementListResponse> = z
  .object({
    object: z.literal('list'),
    data: z.array(agentManagementResponseSchema),
    first_id: z.string().nullable(),
    last_id: z.string().nullable(),
    has_more: z.boolean(),
    after: agentManagementCursorSchema.nullable(),
  })
  .strict();

export const agentManagementListResponseSchema: z.ZodType<AgentManagementListResponse> =
  agentManagementListEnvelopeSchema.superRefine(({ has_more, after }, context) => {
    if (has_more !== (after != null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['after'],
        message: 'A next cursor is required exactly when more results are available',
      });
    }
  });

/** Minimal tombstone returned after an Agent is successfully deleted. */
export const agentManagementDeleteResponseSchema: z.ZodType<AgentManagementDeleteResponse> = z
  .object({
    id: z.string().min(1),
    deleted: z.literal(true),
  })
  .strict();

export const agentManagementErrorCodeSchema: z.ZodType<AgentManagementErrorCode> = z.enum([
  'invalid_request',
  'not_found',
  'permission_denied',
  'internal_error',
  'conflict',
]);

const agentManagementValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .strict();

export const agentManagementErrorSchema: z.ZodType<AgentManagementError> = z
  .object({
    error: z
      .object({
        code: agentManagementErrorCodeSchema,
        message: z.string(),
        details: z.array(agentManagementValidationIssueSchema).optional(),
      })
      .strict(),
  })
  .strict();

function toTimestamp(value: string | Date | undefined): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function getVersion(source: AgentManagementProjectionSource): number | undefined {
  if (source.version != null) {
    return source.version;
  }
  return source.versions?.length;
}

/** Build an external response from a persistence result using an explicit allowlist. */
export function projectAgentManagementResponse(
  source: AgentManagementProjectionSource,
): AgentManagementResponse {
  return agentManagementResponseSchema.parse({
    id: source.id,
    provider: source.provider,
    model: source.model,
    version: getVersion(source),
    createdAt: toTimestamp(source.createdAt),
    updatedAt: toTimestamp(source.updatedAt),
    name: source.name,
    description: source.description,
    instructions: source.instructions,
    avatar: typeof source.avatar === 'string' ? undefined : source.avatar,
    model_parameters: source.model_parameters,
    tools: source.tools,
    skills: source.skills,
    skills_enabled: source.skills_enabled,
    skill_authoring_enabled: source.skill_authoring_enabled,
    skills_scope: source.skills_scope,
    memory_scope: source.memory_scope,
    agent_ids: source.agent_ids,
    edges: source.edges,
    end_after_tools: source.end_after_tools,
    hide_sequential_outputs: source.hide_sequential_outputs,
    stateful_code_sessions: source.stateful_code_sessions,
    stateful_code_environment: source.stateful_code_environment,
    code_environment_id: source.code_environment_id,
    code_workspace_id: source.code_workspace_id,
    repositoryInstructions: source.repositoryInstructions,
    git_identity: source.git_identity,
    artifacts: source.artifacts,
    recursion_limit: source.recursion_limit,
    conversation_starters: source.conversation_starters,
    tool_resources: source.tool_resources,
    tool_options: source.tool_options,
    subagents: source.subagents,
    support_contact: source.support_contact,
    category: source.category,
  });
}

export function projectAgentManagementListResponse(
  source: AgentManagementListProjectionSource,
): AgentManagementListResponse {
  const data = (source.data ?? []).map(projectAgentManagementResponse);
  return agentManagementListResponseSchema.parse({
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: source.has_more,
    after: source.has_more === true && typeof source.after === 'string' ? source.after : null,
  });
}

const ERROR_STATUS: Record<AgentManagementErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  permission_denied: 403,
  internal_error: 500,
  conflict: 409,
};

const ERROR_MESSAGE: Record<AgentManagementErrorCode, string> = {
  invalid_request: 'Invalid request',
  not_found: 'Agent not found',
  permission_denied: 'Permission denied',
  internal_error: 'Internal server error',
  conflict: 'Resource conflict',
};

/** Map known failure classes to a stable envelope without exposing internal error messages. */
export function mapAgentManagementError(
  code: AgentManagementErrorCode,
  error?: unknown,
): { status: number; body: AgentManagementError } {
  const details =
    code === 'invalid_request' && error instanceof z.ZodError
      ? error.issues.map(({ path, message }) => ({ path, message }))
      : undefined;
  const body = agentManagementErrorSchema.parse({
    error: {
      code,
      message: ERROR_MESSAGE[code],
      ...(details != null ? { details } : {}),
    },
  });

  return { status: ERROR_STATUS[code], body };
}
