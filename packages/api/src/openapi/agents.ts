import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { EndpointContract } from './adapter';
import {
  agentManagementCreateSchema,
  agentManagementUpdateSchema,
  agentManagementListSchema,
  agentManagementResponseSchema,
  agentManagementListEnvelopeSchema,
  agentManagementDeleteResponseSchema,
  agentManagementErrorSchema,
} from '../agents/management';
import {
  errorMessageResponseSchema,
  accountDeletionResponseSchema,
  genericServerErrorContent,
  messageResponseSchema,
  jsonParseErrorSchema,
} from './errors';

const TAG = 'Agents';
const SECURITY = ['oidcBearer'];

/**
 * `edges[].prompt` accepts a string or a function at runtime (see agents/validation.ts).
 * OpenAPI cannot express a function, so the document uses a string-only variant of the edge.
 * This changes the document only. The runtime schema is untouched.
 */
const documentedEdgeSchema = z.object({
  from: z.union([z.string(), z.array(z.string())]),
  to: z.union([z.string(), z.array(z.string())]),
  description: z.string().optional(),
  edgeType: z.enum(['handoff', 'direct']).optional(),
  prompt: z.string().optional(),
  excludeResults: z.boolean().optional(),
  promptKey: z.string().optional(),
});

/**
 * Replace only the `edges` field for the document. The schemas are `ZodObject` at runtime
 * (built with `.extend(...).strict()`), but their exported type is the wider `ZodType`, so
 * one cast is needed to reach `.extend`.
 */
function withDocumentedEdges(schema: ZodTypeAny): ZodTypeAny {
  return (schema as unknown as z.AnyZodObject).extend({
    edges: z.array(documentedEdgeSchema).optional(),
  });
}

const agentCreateRequestSchema = withDocumentedEdges(agentManagementCreateSchema);
const agentUpdateRequestSchema = withDocumentedEdges(agentManagementUpdateSchema);
const agentResponseSchema = withDocumentedEdges(agentManagementResponseSchema);

/**
 * Reuse the enforced list envelope; override only `data` with the documented-edge agent.
 * The envelope is exported as `ZodType`, so reach `.extend` the same way `withDocumentedEdges` does.
 */
const agentListResponseSchema = (
  agentManagementListEnvelopeSchema as unknown as z.AnyZodObject
).extend({
  data: z.array(agentResponseSchema),
});

/** The file endpoints are not validated with Zod at runtime; these schemas describe their hand-built responses. */
const agentFileSchema = z.object({
  id: z.string(),
  object: z.literal('agent.file'),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  mime_type: z.string(),
  purposes: z.array(z.string()),
  created_at: z.string().datetime().nullable(),
});
const agentFileListSchema = z.object({
  object: z.literal('list'),
  data: z.array(agentFileSchema),
});
const agentFileDeletedSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export const agentComponentSchemas: Record<string, ZodTypeAny> = {
  AgentCreateRequest: agentCreateRequestSchema,
  AgentUpdateRequest: agentUpdateRequestSchema,
  Agent: agentResponseSchema,
  AgentList: agentListResponseSchema,
  AgentDeleted: agentManagementDeleteResponseSchema,
  AgentFile: agentFileSchema,
  AgentFileList: agentFileListSchema,
  AgentFileDeleted: agentFileDeletedSchema,
  Error: agentManagementErrorSchema,
};

const errorResponses = [
  {
    status: 400,
    description: 'Invalid request, or a malformed JSON body',
    schema: z.union([agentManagementErrorSchema, jsonParseErrorSchema]),
  },
  { status: 401, description: 'Authentication failed', schema: errorMessageResponseSchema },
  {
    status: 403,
    description: 'Permission denied, the caller is banned, or the request fails tenant isolation',
    schema: z.union([
      agentManagementErrorSchema,
      messageResponseSchema,
      errorMessageResponseSchema,
    ]),
  },
  { status: 404, description: 'Not found', schema: agentManagementErrorSchema },
  {
    status: 409,
    description: 'The bound account is being deleted',
    schema: accountDeletionResponseSchema,
  },
  {
    status: 500,
    description:
      'Internal server error. Errors normalized by the route use JSON; the final application error controller sends a text body with the text/html media type.',
    schema: z.union([agentManagementErrorSchema, errorMessageResponseSchema]),
    additionalContent: genericServerErrorContent,
  },
];

export const agentContracts: EndpointContract[] = [
  {
    operationId: 'createAgent',
    method: 'post',
    path: '/agents',
    tags: [TAG],
    summary: 'Create an agent',
    security: SECURITY,
    body: agentCreateRequestSchema,
    responses: [
      { status: 201, description: 'The created agent', schema: agentResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'listAgents',
    method: 'get',
    path: '/agents',
    tags: [TAG],
    summary: 'List agents',
    security: SECURITY,
    query: agentManagementListSchema,
    responses: [
      { status: 200, description: 'A page of agents', schema: agentListResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'getAgent',
    method: 'get',
    path: '/agents/{id}',
    tags: [TAG],
    summary: 'Get an agent',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The agent id' }],
    responses: [
      { status: 200, description: 'The agent', schema: agentResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'updateAgent',
    method: 'patch',
    path: '/agents/{id}',
    tags: [TAG],
    summary: 'Update an agent',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The agent id' }],
    body: agentUpdateRequestSchema,
    responses: [
      { status: 200, description: 'The updated agent', schema: agentResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'deleteAgent',
    method: 'delete',
    path: '/agents/{id}',
    tags: [TAG],
    summary: 'Delete an agent',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The agent id' }],
    responses: [
      {
        status: 200,
        description: 'The agent was deleted',
        schema: agentManagementDeleteResponseSchema,
      },
      ...errorResponses,
    ],
  },
  {
    operationId: 'uploadAgentFile',
    method: 'post',
    path: '/agents/{id}/files',
    tags: [TAG],
    summary: 'Upload a file to an agent',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The agent id' }],
    rawBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            required: ['file', 'purpose'],
            properties: {
              file: { type: 'string', format: 'binary' },
              purpose: {
                type: 'string',
                enum: ['file_search', 'execute_code', 'context'],
                description: 'The tool resource the file is uploaded for.',
              },
            },
          },
        },
      },
    },
    responses: [
      { status: 200, description: 'The uploaded file', schema: agentFileSchema },
      ...errorResponses,
      {
        status: 429,
        description: 'Too many upload requests',
        schema: agentManagementErrorSchema,
      },
    ],
  },
  {
    operationId: 'listAgentFiles',
    method: 'get',
    path: '/agents/{id}/files',
    tags: [TAG],
    summary: "List an agent's files",
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The agent id' }],
    responses: [
      { status: 200, description: "The agent's files", schema: agentFileListSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'deleteAgentFile',
    method: 'delete',
    path: '/agents/{id}/files/{fileId}',
    tags: [TAG],
    summary: "Delete an agent's file",
    security: SECURITY,
    pathParams: [
      { name: 'id', description: 'The agent id' },
      { name: 'fileId', description: 'The file id' },
    ],
    responses: [
      { status: 200, description: 'The file was deleted', schema: agentFileDeletedSchema },
      ...errorResponses,
    ],
  },
];
