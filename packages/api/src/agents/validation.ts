import { z } from 'zod';
import {
  CODE_WORKSPACE_ID_PATTERN,
  MemoryScope,
  SkillsScope,
  getMaxSubagents,
  agentGitIdentitySchema,
  resolveModelCatalogKey,
  ViolationTypes,
  ErrorTypes,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_GRAPH_SUBAGENT_MEMBERS,
} from 'librechat-data-provider';
import type {
  Agent,
  AgentGitIdentity,
  TModelsConfig,
  AgentSubagentsConfig,
} from 'librechat-data-provider';
import type { Request, Response } from 'express';

/**
 * Permissive Request alias used by {@link validateAgentModel}. Accepts either
 * the default Express `Request` or the project-specific `ServerRequest`
 * (see `~/types/http`), whose `params` type is widened to `unknown`.
 */
type LooseRequest = Request<unknown, unknown, unknown>;

const agentCodeWorkspaceIdSchema: z.ZodUnion<[z.ZodLiteral<''>, z.ZodString]> = z.union([
  z.literal(''),
  z.string().regex(CODE_WORKSPACE_ID_PATTERN),
]);

/** Avatar schema shared between create and update */
export const agentAvatarSchema: z.ZodObject<
  {
    filepath: z.ZodString;
    source: z.ZodString;
  },
  'strip'
> = z.object({
  filepath: z.string(),
  source: z.string(),
});

/** Persisted resource schema. Full file records are populated only after database authorization. */
export const agentBaseResourceSchema: z.ZodObject<
  {
    file_ids: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
  },
  'strip'
> = z.object({
  file_ids: z.array(z.string()).optional(),
});

/** File resource schema extends base with vector_store_ids. */
export const agentFileResourceSchema: z.ZodObject<
  {
    file_ids: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    vector_store_ids: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
  },
  'strip'
> = agentBaseResourceSchema.extend({
  vector_store_ids: z.array(z.string()).optional(),
});

/** Persisted tool resources accepted by Agent create and update APIs. */
export const agentToolResourcesSchema: z.ZodOptional<
  z.ZodObject<
    {
      image_edit: z.ZodOptional<typeof agentBaseResourceSchema>;
      execute_code: z.ZodOptional<typeof agentBaseResourceSchema>;
      file_search: z.ZodOptional<typeof agentFileResourceSchema>;
      context: z.ZodOptional<typeof agentBaseResourceSchema>;
      ocr: z.ZodOptional<typeof agentBaseResourceSchema>;
    },
    'strip'
  >
> = z
  .object({
    image_edit: agentBaseResourceSchema.optional(),
    execute_code: agentBaseResourceSchema.optional(),
    file_search: agentFileResourceSchema.optional(),
    context: agentBaseResourceSchema.optional(),
    /** @deprecated Use context instead */
    ocr: agentBaseResourceSchema.optional(),
  })
  .optional();

/** Support contact schema for agent */
export const agentSupportContactSchema: z.ZodOptional<
  z.ZodObject<
    {
      name: z.ZodOptional<z.ZodString>;
      email: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<''>, z.ZodString]>>;
    },
    'strip',
    z.ZodTypeAny,
    {
      name?: string | undefined;
      email?: string | undefined;
    },
    {
      name?: string | undefined;
      email?: string | undefined;
    }
  >
> = z
  .object({
    name: z.string().optional(),
    email: z.union([z.literal(''), z.string().email()]).optional(),
  })
  .optional();

/** Graph edge schema for agent handoffs */
export const graphEdgeSchema: z.ZodObject<
  {
    from: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
    to: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
    description: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, string | undefined>;
    edgeType: z.ZodOptional<z.ZodEnum<['handoff', 'direct']>>;
    prompt: z.ZodEffects<
      z.ZodOptional<
        z.ZodUnion<[z.ZodString, z.ZodFunction<z.ZodTuple<[], z.ZodUnknown>, z.ZodUnknown>]>
      >,
      string | ((...args: unknown[]) => unknown) | undefined,
      string | ((...args: unknown[]) => unknown) | undefined
    >;
    excludeResults: z.ZodOptional<z.ZodBoolean>;
    promptKey: z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, string | undefined>;
  },
  'strip'
> = z.object({
  from: z.union([z.string(), z.array(z.string())]),
  to: z.union([z.string(), z.array(z.string())]),
  description: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  edgeType: z.enum(['handoff', 'direct']).optional(),
  prompt: z
    .union([z.string(), z.function()])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  excludeResults: z.boolean().optional(),
  promptKey: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

/** Per-tool options schema (defer_loading, allowed_callers, run_in_background, describe_intent) */
export const toolOptionsSchema: z.ZodObject<
  {
    defer_loading: z.ZodOptional<z.ZodBoolean>;
    allowed_callers: z.ZodOptional<z.ZodArray<z.ZodEnum<['direct', 'code_execution']>, 'many'>>;
    run_in_background: z.ZodOptional<z.ZodBoolean>;
    describe_intent: z.ZodOptional<z.ZodBoolean>;
  },
  'strip'
> = z.object({
  defer_loading: z.boolean().optional(),
  allowed_callers: z.array(z.enum(['direct', 'code_execution'])).optional(),
  run_in_background: z.boolean().optional(),
  describe_intent: z.boolean().optional(),
});

/** Agent tool options - map of tool_id to tool options */
export const agentToolOptionsSchema: z.ZodOptional<
  z.ZodRecord<
    z.ZodString,
    z.ZodObject<
      {
        defer_loading: z.ZodOptional<z.ZodBoolean>;
        allowed_callers: z.ZodOptional<z.ZodArray<z.ZodEnum<['direct', 'code_execution']>, 'many'>>;
        run_in_background: z.ZodOptional<z.ZodBoolean>;
        describe_intent: z.ZodOptional<z.ZodBoolean>;
      },
      'strip',
      z.ZodTypeAny,
      {
        defer_loading?: boolean | undefined;
        allowed_callers?: ('direct' | 'code_execution')[] | undefined;
        run_in_background?: boolean | undefined;
        describe_intent?: boolean | undefined;
      },
      {
        defer_loading?: boolean | undefined;
        allowed_callers?: ('direct' | 'code_execution')[] | undefined;
        run_in_background?: boolean | undefined;
        describe_intent?: boolean | undefined;
      }
    >
  >
> = z.record(z.string(), toolOptionsSchema).optional();

/**
 * Subagent spawning configuration for an agent. `agent_ids` and `graphs` are
 * capped at the effective subagents limit (10 by default, configurable via
 * `endpoints.agents.maxSubagents`) so a crafted API request cannot trigger
 * hundreds of `processAgent` calls (DB lookup + permission check + tool
 * loading). The UI enforces the same cap, so legitimate payloads never hit
 * the bound.
 */
const graphSubagentEdgeSchema = z
  .object({
    from: z.union([z.string(), z.array(z.string()).min(1)]),
    to: z.union([z.string(), z.array(z.string()).min(1)]),
    description: z.string().optional(),
    edgeType: z.literal('direct'),
    prompt: z.string().optional(),
    excludeResults: z.boolean().optional(),
  })
  .strict();

function validateGraphSubagentTopology(graph: {
  type: string;
  agent_ids: string[];
  edges: Array<{
    from: string | string[];
    to: string | string[];
    prompt?: string;
    excludeResults?: boolean;
  }>;
  entry_agent_id: string;
  result_agent_id: string;
}): string | undefined {
  const memberIds = new Set(graph.agent_ids);
  if (memberIds.size !== graph.agent_ids.length) {
    return `Graph subagent "${graph.type}" contains duplicate member IDs.`;
  }
  const reservedMemberIds = new Set([
    '__start__',
    '__end__',
    'messages',
    'agentMessages',
    'subagentResult',
  ]);
  const invalidMemberId = graph.agent_ids.find(
    (agentId) => reservedMemberIds.has(agentId) || agentId.includes('|') || agentId.includes(':'),
  );
  if (invalidMemberId) {
    return `Graph subagent "${graph.type}" member "${invalidMemberId}" is reserved by the graph runtime.`;
  }
  if (!memberIds.has(graph.entry_agent_id) || !memberIds.has(graph.result_agent_id)) {
    return `Graph subagent "${graph.type}" entry and result must reference configured members.`;
  }
  const adjacency = new Map(graph.agent_ids.map((agentId) => [agentId, new Set<string>()]));
  const reverse = new Map(graph.agent_ids.map((agentId) => [agentId, new Set<string>()]));
  const incomingGroups = new Map<string, string[][]>();
  const directedEdges = new Set<string>();
  for (const edge of graph.edges) {
    const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
    const destinations = Array.isArray(edge.to) ? edge.to : [edge.to];
    if (
      new Set(sources).size !== sources.length ||
      new Set(destinations).size !== destinations.length
    ) {
      return `Graph subagent "${graph.type}" edge endpoints must be unique.`;
    }
    if (edge.excludeResults === true && !edge.prompt) {
      return `Graph subagent "${graph.type}" cannot exclude results without an edge prompt.`;
    }
    if (edge.prompt && destinations.length !== 1) {
      return `Graph subagent "${graph.type}" prompted edges must have one destination.`;
    }
    for (const agentId of [...sources, ...destinations]) {
      if (!memberIds.has(agentId)) {
        return `Graph subagent "${graph.type}" references unknown member "${agentId}".`;
      }
    }
    for (const destination of destinations) {
      const groups = incomingGroups.get(destination) ?? [];
      groups.push(sources);
      incomingGroups.set(destination, groups);
      for (const source of sources) {
        if (source === destination) {
          return `Graph subagent "${graph.type}" cannot contain self-edges.`;
        }
        const edgeKey = `${source}\0${destination}`;
        if (directedEdges.has(edgeKey)) {
          return `Graph subagent "${graph.type}" contains duplicate edges.`;
        }
        directedEdges.add(edgeKey);
        adjacency.get(source)?.add(destination);
        reverse.get(destination)?.add(source);
      }
    }
  }
  for (const [destination, groups] of incomingGroups) {
    const sources = reverse.get(destination);
    if (sources && sources.size > 1 && (groups.length !== 1 || groups[0].length !== sources.size)) {
      return `Graph subagent "${graph.type}" fan-in to "${destination}" must use one array-valued source edge.`;
    }
  }
  const roots = graph.agent_ids.filter((agentId) => reverse.get(agentId)?.size === 0);
  const sinks = graph.agent_ids.filter((agentId) => adjacency.get(agentId)?.size === 0);
  if (roots.length !== 1 || roots[0] !== graph.entry_agent_id) {
    return `Graph subagent "${graph.type}" must use entry_agent_id as its only root.`;
  }
  if (sinks.length !== 1 || sinks[0] !== graph.result_agent_id) {
    return `Graph subagent "${graph.type}" must use result_agent_id as its only sink.`;
  }
  const remainingIncoming = new Map(
    graph.agent_ids.map((agentId) => [agentId, reverse.get(agentId)?.size ?? 0]),
  );
  const ready = roots.slice();
  let visitedCount = 0;
  while (ready.length > 0) {
    const source = ready.pop();
    if (source === undefined) {
      continue;
    }
    visitedCount++;
    for (const destination of adjacency.get(source) ?? []) {
      const count = (remainingIncoming.get(destination) ?? 0) - 1;
      remainingIncoming.set(destination, count);
      if (count === 0) {
        ready.push(destination);
      }
    }
  }
  if (visitedCount !== memberIds.size) {
    return `Graph subagent "${graph.type}" must be acyclic and fully connected.`;
  }
  const isSimpleChain = graph.agent_ids.every(
    (agentId) => (adjacency.get(agentId)?.size ?? 0) <= 1 && (reverse.get(agentId)?.size ?? 0) <= 1,
  );
  if (
    !isSimpleChain &&
    graph.edges.some(
      (edge) =>
        edge.prompt && (Array.isArray(edge.to) ? edge.to[0] : edge.to) !== graph.result_agent_id,
    )
  ) {
    return `Graph subagent "${graph.type}" prompts in a branched graph must target result_agent_id.`;
  }
  return undefined;
}

const graphSubagentSchema = z
  .object({
    type: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    agent_ids: z.array(z.string()).min(1).max(MAX_GRAPH_SUBAGENT_MEMBERS),
    edges: z.array(graphSubagentEdgeSchema),
    entry_agent_id: z.string(),
    result_agent_id: z.string(),
  })
  .superRefine((graph, ctx) => {
    const error = validateGraphSubagentTopology(graph);
    if (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error,
      });
    }
  });

export const agentSubagentsSchema: z.ZodOptional<z.ZodType<AgentSubagentsConfig>> = z
  .object({
    enabled: z.boolean().optional(),
    allowSelf: z.boolean().optional(),
    shareFiles: z.boolean().optional(),
    agent_ids: z.array(z.string()).optional(),
    graphs: z.array(graphSubagentSchema).optional(),
  })
  .superRefine((subagents, ctx) => {
    const maxSubagents = getMaxSubagents();
    if ((subagents.agent_ids?.length ?? 0) > maxSubagents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_ids'],
        message: `agent_ids must contain at most ${maxSubagents} item(s)`,
      });
    }
    if ((subagents.graphs?.length ?? 0) > maxSubagents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['graphs'],
        message: `graphs must contain at most ${maxSubagents} item(s)`,
      });
    }
    const reservedTypes = new Set(subagents.agent_ids ?? []);
    const configuredAgentIds = new Set(subagents.agent_ids ?? []);
    if (subagents.allowSelf !== false) {
      reservedTypes.add('self');
    }
    for (let graphIndex = 0; graphIndex < (subagents.graphs?.length ?? 0); graphIndex++) {
      const graph = subagents.graphs?.[graphIndex];
      if (!graph) {
        continue;
      }
      if (reservedTypes.has(graph.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['graphs', graphIndex, 'type'],
          message: 'Graph subagent types must be unique across all spawn targets',
        });
      }
      reservedTypes.add(graph.type);
      for (const agentId of graph.agent_ids) {
        configuredAgentIds.add(agentId);
      }
    }
    if (configuredAgentIds.size > MAX_SUBAGENT_GRAPH_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Subagent configuration exceeds the maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents`,
      });
    }
  })
  .optional();

/** Base agent schema with all common fields */
const agentCodeEnvironmentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const agentGitIdentityUpdateSchema: z.ZodType<AgentGitIdentity | null | undefined> =
  agentGitIdentitySchema.nullable();

export const agentBaseSchema: z.ZodObject<
  {
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    instructions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    avatar: z.ZodOptional<
      z.ZodNullable<
        z.ZodObject<
          {
            filepath: z.ZodString;
            source: z.ZodString;
          },
          'strip',
          z.ZodTypeAny,
          {
            source: string;
            filepath: string;
          },
          {
            source: string;
            filepath: string;
          }
        >
      >
    >;
    model_parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    skills_enabled: z.ZodOptional<z.ZodBoolean>;
    skill_authoring_enabled: z.ZodOptional<z.ZodBoolean>;
    skills_scope: z.ZodOptional<z.ZodNativeEnum<typeof SkillsScope>>;
    memory_scope: z.ZodOptional<z.ZodNativeEnum<typeof MemoryScope>>;
    /** @deprecated Use edges instead */
    agent_ids: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    edges: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            from: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
            to: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
            description: z.ZodEffects<
              z.ZodOptional<z.ZodString>,
              string | undefined,
              string | undefined
            >;
            edgeType: z.ZodOptional<z.ZodEnum<['handoff', 'direct']>>;
            prompt: z.ZodEffects<
              z.ZodOptional<
                z.ZodUnion<[z.ZodString, z.ZodFunction<z.ZodTuple<[], z.ZodUnknown>, z.ZodUnknown>]>
              >,
              string | ((...args: unknown[]) => unknown) | undefined,
              string | ((...args: unknown[]) => unknown) | undefined
            >;
            excludeResults: z.ZodOptional<z.ZodBoolean>;
            promptKey: z.ZodEffects<
              z.ZodOptional<z.ZodString>,
              string | undefined,
              string | undefined
            >;
          },
          'strip',
          z.ZodTypeAny,
          {
            from: string | string[];
            to: string | string[];
            description?: string | undefined;
            prompt?: string | ((...args: unknown[]) => unknown) | undefined;
            edgeType?: 'direct' | 'handoff' | undefined;
            excludeResults?: boolean | undefined;
            promptKey?: string | undefined;
          },
          {
            from: string | string[];
            to: string | string[];
            description?: string | undefined;
            prompt?: string | ((...args: unknown[]) => unknown) | undefined;
            edgeType?: 'direct' | 'handoff' | undefined;
            excludeResults?: boolean | undefined;
            promptKey?: string | undefined;
          }
        >,
        'many'
      >
    >;
    end_after_tools: z.ZodOptional<z.ZodBoolean>;
    hide_sequential_outputs: z.ZodOptional<z.ZodBoolean>;
    stateful_code_sessions: z.ZodOptional<z.ZodBoolean>;
    stateful_code_environment: z.ZodOptional<z.ZodEnum<['user', 'agent-user', 'conversation']>>;
    code_environment_id: z.ZodOptional<z.ZodString>;
    code_workspace_id: z.ZodOptional<typeof agentCodeWorkspaceIdSchema>;
    repositoryInstructions: z.ZodOptional<z.ZodEnum<['prefer', 'defer', 'off']>>;
    git_identity: typeof agentGitIdentitySchema;
    artifacts: z.ZodOptional<z.ZodString>;
    recursion_limit: z.ZodOptional<z.ZodNumber>;
    conversation_starters: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    tool_resources: typeof agentToolResourcesSchema;
    tool_options: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            defer_loading: z.ZodOptional<z.ZodBoolean>;
            allowed_callers: z.ZodOptional<
              z.ZodArray<z.ZodEnum<['direct', 'code_execution']>, 'many'>
            >;
            run_in_background: z.ZodOptional<z.ZodBoolean>;
            describe_intent: z.ZodOptional<z.ZodBoolean>;
          },
          'strip',
          z.ZodTypeAny,
          {
            defer_loading?: boolean | undefined;
            allowed_callers?: ('direct' | 'code_execution')[] | undefined;
            run_in_background?: boolean | undefined;
            describe_intent?: boolean | undefined;
          },
          {
            defer_loading?: boolean | undefined;
            allowed_callers?: ('direct' | 'code_execution')[] | undefined;
            run_in_background?: boolean | undefined;
            describe_intent?: boolean | undefined;
          }
        >
      >
    >;
    subagents: typeof agentSubagentsSchema;
    support_contact: z.ZodOptional<
      z.ZodObject<
        {
          name: z.ZodOptional<z.ZodString>;
          email: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<''>, z.ZodString]>>;
        },
        'strip',
        z.ZodTypeAny,
        {
          name?: string | undefined;
          email?: string | undefined;
        },
        {
          name?: string | undefined;
          email?: string | undefined;
        }
      >
    >;
    category: z.ZodOptional<z.ZodString>;
  },
  'strip'
> = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  avatar: agentAvatarSchema.nullable().optional(),
  model_parameters: z.record(z.unknown()).optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  skills_enabled: z.boolean().optional(),
  skill_authoring_enabled: z.boolean().optional(),
  skills_scope: z.nativeEnum(SkillsScope).optional(),
  memory_scope: z.nativeEnum(MemoryScope).optional(),
  /** @deprecated Use edges instead */
  agent_ids: z.array(z.string()).optional(),
  edges: z.array(graphEdgeSchema).optional(),
  end_after_tools: z.boolean().optional(),
  hide_sequential_outputs: z.boolean().optional(),
  stateful_code_sessions: z.boolean().optional(),
  stateful_code_environment: z.enum(['user', 'agent-user', 'conversation']).optional(),
  code_environment_id: agentCodeEnvironmentIdSchema.optional(),
  code_workspace_id: agentCodeWorkspaceIdSchema.optional(),
  repositoryInstructions: z.enum(['prefer', 'defer', 'off']).optional(),
  git_identity: agentGitIdentitySchema,
  artifacts: z.string().optional(),
  recursion_limit: z.number().optional(),
  conversation_starters: z.array(z.string()).optional(),
  tool_resources: agentToolResourcesSchema,
  tool_options: agentToolOptionsSchema,
  subagents: agentSubagentsSchema,
  support_contact: agentSupportContactSchema,
  category: z.string().optional(),
});

/** Create schema extends base with required fields for creation */
export const agentCreateSchema: z.ZodObject<
  {
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    instructions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    avatar: z.ZodOptional<
      z.ZodNullable<
        z.ZodObject<
          {
            filepath: z.ZodString;
            source: z.ZodString;
          },
          'strip',
          z.ZodTypeAny,
          {
            source: string;
            filepath: string;
          },
          {
            source: string;
            filepath: string;
          }
        >
      >
    >;
    model_parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    skills_enabled: z.ZodOptional<z.ZodBoolean>;
    skill_authoring_enabled: z.ZodOptional<z.ZodBoolean>;
    skills_scope: z.ZodOptional<z.ZodNativeEnum<typeof SkillsScope>>;
    memory_scope: z.ZodOptional<z.ZodNativeEnum<typeof MemoryScope>>;
    agent_ids: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    edges: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            from: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
            to: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
            description: z.ZodEffects<
              z.ZodOptional<z.ZodString>,
              string | undefined,
              string | undefined
            >;
            edgeType: z.ZodOptional<z.ZodEnum<['handoff', 'direct']>>;
            prompt: z.ZodEffects<
              z.ZodOptional<
                z.ZodUnion<[z.ZodString, z.ZodFunction<z.ZodTuple<[], z.ZodUnknown>, z.ZodUnknown>]>
              >,
              string | ((...args: unknown[]) => unknown) | undefined,
              string | ((...args: unknown[]) => unknown) | undefined
            >;
            excludeResults: z.ZodOptional<z.ZodBoolean>;
            promptKey: z.ZodEffects<
              z.ZodOptional<z.ZodString>,
              string | undefined,
              string | undefined
            >;
          },
          'strip',
          z.ZodTypeAny,
          {
            from: string | string[];
            to: string | string[];
            description?: string | undefined;
            prompt?: string | ((...args: unknown[]) => unknown) | undefined;
            edgeType?: 'direct' | 'handoff' | undefined;
            excludeResults?: boolean | undefined;
            promptKey?: string | undefined;
          },
          {
            from: string | string[];
            to: string | string[];
            description?: string | undefined;
            prompt?: string | ((...args: unknown[]) => unknown) | undefined;
            edgeType?: 'direct' | 'handoff' | undefined;
            excludeResults?: boolean | undefined;
            promptKey?: string | undefined;
          }
        >,
        'many'
      >
    >;
    end_after_tools: z.ZodOptional<z.ZodBoolean>;
    hide_sequential_outputs: z.ZodOptional<z.ZodBoolean>;
    stateful_code_sessions: z.ZodOptional<z.ZodBoolean>;
    stateful_code_environment: z.ZodOptional<z.ZodEnum<['user', 'agent-user', 'conversation']>>;
    code_environment_id: z.ZodOptional<z.ZodString>;
    git_identity: typeof agentGitIdentitySchema;
    code_workspace_id: z.ZodOptional<typeof agentCodeWorkspaceIdSchema>;
    repositoryInstructions: z.ZodOptional<z.ZodEnum<['prefer', 'defer', 'off']>>;
    artifacts: z.ZodOptional<z.ZodString>;
    recursion_limit: z.ZodOptional<z.ZodNumber>;
    conversation_starters: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    tool_resources: typeof agentToolResourcesSchema;
    tool_options: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            defer_loading: z.ZodOptional<z.ZodBoolean>;
            allowed_callers: z.ZodOptional<
              z.ZodArray<z.ZodEnum<['direct', 'code_execution']>, 'many'>
            >;
            run_in_background: z.ZodOptional<z.ZodBoolean>;
            describe_intent: z.ZodOptional<z.ZodBoolean>;
          },
          'strip',
          z.ZodTypeAny,
          {
            defer_loading?: boolean | undefined;
            allowed_callers?: ('direct' | 'code_execution')[] | undefined;
            run_in_background?: boolean | undefined;
            describe_intent?: boolean | undefined;
          },
          {
            defer_loading?: boolean | undefined;
            allowed_callers?: ('direct' | 'code_execution')[] | undefined;
            run_in_background?: boolean | undefined;
            describe_intent?: boolean | undefined;
          }
        >
      >
    >;
    subagents: typeof agentSubagentsSchema;
    support_contact: z.ZodOptional<
      z.ZodObject<
        {
          name: z.ZodOptional<z.ZodString>;
          email: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<''>, z.ZodString]>>;
        },
        'strip',
        z.ZodTypeAny,
        {
          name?: string | undefined;
          email?: string | undefined;
        },
        {
          name?: string | undefined;
          email?: string | undefined;
        }
      >
    >;
    category: z.ZodOptional<z.ZodString>;
  } & {
    provider: z.ZodString;
    model: z.ZodNullable<z.ZodString>;
    tools: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>>;
  },
  'strip'
> = agentBaseSchema.extend({
  provider: z.string(),
  model: z.string().nullable(),
  tools: z.array(z.string()).optional().default([]),
});

/** Update schema extends base with all fields optional and additional update-only fields */
export const agentUpdateSchema: z.ZodObject<
  {
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    instructions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    model_parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    skills_enabled: z.ZodOptional<z.ZodBoolean>;
    skill_authoring_enabled: z.ZodOptional<z.ZodBoolean>;
    skills_scope: z.ZodOptional<z.ZodNativeEnum<typeof SkillsScope>>;
    memory_scope: z.ZodOptional<z.ZodNativeEnum<typeof MemoryScope>>;
    agent_ids: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    edges: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            from: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
            to: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, 'many'>]>;
            description: z.ZodEffects<
              z.ZodOptional<z.ZodString>,
              string | undefined,
              string | undefined
            >;
            edgeType: z.ZodOptional<z.ZodEnum<['handoff', 'direct']>>;
            prompt: z.ZodEffects<
              z.ZodOptional<
                z.ZodUnion<[z.ZodString, z.ZodFunction<z.ZodTuple<[], z.ZodUnknown>, z.ZodUnknown>]>
              >,
              string | ((...args: unknown[]) => unknown) | undefined,
              string | ((...args: unknown[]) => unknown) | undefined
            >;
            excludeResults: z.ZodOptional<z.ZodBoolean>;
            promptKey: z.ZodEffects<
              z.ZodOptional<z.ZodString>,
              string | undefined,
              string | undefined
            >;
          },
          'strip',
          z.ZodTypeAny,
          {
            from: string | string[];
            to: string | string[];
            description?: string | undefined;
            prompt?: string | ((...args: unknown[]) => unknown) | undefined;
            edgeType?: 'direct' | 'handoff' | undefined;
            excludeResults?: boolean | undefined;
            promptKey?: string | undefined;
          },
          {
            from: string | string[];
            to: string | string[];
            description?: string | undefined;
            prompt?: string | ((...args: unknown[]) => unknown) | undefined;
            edgeType?: 'direct' | 'handoff' | undefined;
            excludeResults?: boolean | undefined;
            promptKey?: string | undefined;
          }
        >,
        'many'
      >
    >;
    end_after_tools: z.ZodOptional<z.ZodBoolean>;
    hide_sequential_outputs: z.ZodOptional<z.ZodBoolean>;
    stateful_code_sessions: z.ZodOptional<z.ZodBoolean>;
    stateful_code_environment: z.ZodOptional<z.ZodEnum<['user', 'agent-user', 'conversation']>>;
    code_environment_id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    code_workspace_id: z.ZodOptional<typeof agentCodeWorkspaceIdSchema>;
    repositoryInstructions: z.ZodOptional<z.ZodEnum<['prefer', 'defer', 'off']>>;
    git_identity: typeof agentGitIdentityUpdateSchema;
    artifacts: z.ZodOptional<z.ZodString>;
    recursion_limit: z.ZodOptional<z.ZodNumber>;
    conversation_starters: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>;
    tool_resources: typeof agentToolResourcesSchema;
    tool_options: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            defer_loading: z.ZodOptional<z.ZodBoolean>;
            allowed_callers: z.ZodOptional<
              z.ZodArray<z.ZodEnum<['direct', 'code_execution']>, 'many'>
            >;
            run_in_background: z.ZodOptional<z.ZodBoolean>;
            describe_intent: z.ZodOptional<z.ZodBoolean>;
          },
          'strip',
          z.ZodTypeAny,
          {
            defer_loading?: boolean | undefined;
            allowed_callers?: ('direct' | 'code_execution')[] | undefined;
            run_in_background?: boolean | undefined;
            describe_intent?: boolean | undefined;
          },
          {
            defer_loading?: boolean | undefined;
            allowed_callers?: ('direct' | 'code_execution')[] | undefined;
            run_in_background?: boolean | undefined;
            describe_intent?: boolean | undefined;
          }
        >
      >
    >;
    subagents: typeof agentSubagentsSchema;
    support_contact: z.ZodOptional<
      z.ZodObject<
        {
          name: z.ZodOptional<z.ZodString>;
          email: z.ZodOptional<z.ZodUnion<[z.ZodLiteral<''>, z.ZodString]>>;
        },
        'strip',
        z.ZodTypeAny,
        {
          name?: string | undefined;
          email?: string | undefined;
        },
        {
          name?: string | undefined;
          email?: string | undefined;
        }
      >
    >;
    category: z.ZodOptional<z.ZodString>;
  } & {
    avatar: z.ZodOptional<
      z.ZodUnion<
        [
          z.ZodObject<
            {
              filepath: z.ZodString;
              source: z.ZodString;
            },
            'strip',
            z.ZodTypeAny,
            {
              source: string;
              filepath: string;
            },
            {
              source: string;
              filepath: string;
            }
          >,
          z.ZodNull,
        ]
      >
    >;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  },
  'strip'
> = agentBaseSchema.extend({
  avatar: z.union([agentAvatarSchema, z.null()]).optional(),
  code_environment_id: agentCodeEnvironmentIdSchema.nullable().optional(),
  code_workspace_id: agentCodeWorkspaceIdSchema.optional(),
  repositoryInstructions: z.enum(['prefer', 'defer', 'off']).optional(),
  git_identity: agentGitIdentityUpdateSchema,
  provider: z.string().optional(),
  model: z.string().nullable().optional(),
});

export interface ValidateAgentModelParams {
  req: LooseRequest;
  res: Response;
  agent: Agent;
  modelsConfig: TModelsConfig;
  logViolation: (
    req: LooseRequest,
    res: Response,
    type: string,
    errorMessage: Record<string, unknown>,
    score?: number | string,
  ) => Promise<void>;
}

interface ValidateAgentModelResult {
  isValid: boolean;
  error?: {
    message: string;
  };
}

/**
 * Validates an agent's model against the available models configuration.
 * This is a non-middleware version of validateModel that can be used
 * in service initialization flows.
 *
 * @param params - Validation parameters
 * @returns Object indicating whether the model is valid and any error details
 */
export async function validateAgentModel(
  params: ValidateAgentModelParams,
): Promise<ValidateAgentModelResult> {
  const { req, res, agent, modelsConfig, logViolation } = params;
  const { model, provider: endpoint } = agent;

  if (!model) {
    return {
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.MISSING_MODEL}", "info": "${endpoint}" }`,
      },
    };
  }

  if (!modelsConfig) {
    return {
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.MODELS_NOT_LOADED}" }`,
      },
    };
  }

  const availableModels = modelsConfig[resolveModelCatalogKey(endpoint, modelsConfig)];
  if (!availableModels) {
    return {
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.ENDPOINT_MODELS_NOT_LOADED}", "info": "${endpoint}" }`,
      },
    };
  }

  const validModel = !!availableModels.find((availableModel) => availableModel === model);

  if (validModel) {
    return { isValid: true };
  }

  const { ILLEGAL_MODEL_REQ_SCORE: score = 1 } = process.env ?? {};
  const type = ViolationTypes.ILLEGAL_MODEL_REQUEST;
  const errorMessage = {
    type,
    model,
    endpoint,
  };

  await logViolation(req, res, type, errorMessage, score);

  return {
    isValid: false,
    error: {
      message: `{ "type": "${ViolationTypes.ILLEGAL_MODEL_REQUEST}", "info": "${endpoint}|${model}" }`,
    },
  };
}
