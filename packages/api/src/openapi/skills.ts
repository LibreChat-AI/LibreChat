import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { EndpointContract } from './adapter';
import {
  skillManagementUpdateSchema,
  skillManagementCreateSchema,
  skillManagementResponseSchema,
  skillSummarySchema,
  skillFileSchema,
  skillFileContentSchema,
  skillFileUpdateSchema,
  skillFrontmatterValueSchema,
  skillDeleteResponseSchema,
  skillFileDeleteResponseSchema,
} from '../skills/management';
import {
  errorMessageResponseSchema,
  accountDeletionResponseSchema,
  genericServerErrorContent,
  messageResponseSchema,
  jsonParseErrorSchema,
} from './errors';
import { agentManagementListSchema, agentManagementErrorSchema } from '../agents/management';

const TAG = 'Skills';
const SECURITY = ['oidcBearer'];

const skillListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(skillSummarySchema),
  first_id: z.string().nullable(),
  last_id: z.string().nullable(),
  has_more: z.boolean(),
  after: z.string().nullable(),
});
const skillFileListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(skillFileSchema),
});
const skillFileUpdatedSchema = z.object({
  relativePath: z.string(),
  bytes: z.number().int().nonnegative(),
});
export const skillComponentSchemas: Record<string, ZodTypeAny> = {
  SkillFrontmatterValue: skillFrontmatterValueSchema,
  Skill: skillManagementResponseSchema,
  SkillList: skillListResponseSchema,
  SkillCreateRequest: skillManagementCreateSchema,
  SkillUpdateRequest: skillManagementUpdateSchema,
  SkillDeleted: skillDeleteResponseSchema,
  SkillFile: skillFileSchema,
  SkillFileList: skillFileListResponseSchema,
  SkillFileContent: skillFileContentSchema,
  SkillFileUpdateRequest: skillFileUpdateSchema,
  SkillFileUpdated: skillFileUpdatedSchema,
  SkillFileDeleted: skillFileDeleteResponseSchema,
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

export const skillContracts: EndpointContract[] = [
  {
    operationId: 'listSkills',
    method: 'get',
    path: '/skills',
    tags: [TAG],
    summary: 'List skills',
    security: SECURITY,
    query: agentManagementListSchema,
    responses: [
      { status: 200, description: 'A page of skills', schema: skillListResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'createSkill',
    method: 'post',
    path: '/skills',
    tags: [TAG],
    summary: 'Create a skill',
    security: SECURITY,
    body: skillManagementCreateSchema,
    responses: [
      { status: 201, description: 'The created skill', schema: skillManagementResponseSchema },
      ...errorResponses,
      {
        status: 409,
        description: 'The Skill name already exists, or the bound account is being deleted',
        schema: z.union([agentManagementErrorSchema, accountDeletionResponseSchema]),
      },
    ],
  },
  {
    operationId: 'getSkill',
    method: 'get',
    path: '/skills/{id}',
    tags: [TAG],
    summary: 'Get a skill',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The skill id' }],
    responses: [
      { status: 200, description: 'The skill', schema: skillManagementResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'updateSkill',
    method: 'patch',
    path: '/skills/{id}',
    tags: [TAG],
    summary: 'Update a skill',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The skill id' }],
    body: skillManagementUpdateSchema,
    responses: [
      { status: 200, description: 'The updated skill', schema: skillManagementResponseSchema },
      ...errorResponses,
      {
        status: 409,
        description:
          'The skill changed since the provided expectedVersion, or the bound account is being deleted',
        schema: z.union([agentManagementErrorSchema, accountDeletionResponseSchema]),
      },
    ],
  },
  {
    operationId: 'deleteSkill',
    method: 'delete',
    path: '/skills/{id}',
    tags: [TAG],
    summary: 'Delete a skill',
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The skill id' }],
    responses: [
      { status: 200, description: 'The skill was deleted', schema: skillDeleteResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'listSkillFiles',
    method: 'get',
    path: '/skills/{id}/files',
    tags: [TAG],
    summary: "List a skill's files",
    security: SECURITY,
    pathParams: [{ name: 'id', description: 'The skill id' }],
    responses: [
      { status: 200, description: "The skill's files", schema: skillFileListResponseSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'getSkillFile',
    method: 'get',
    path: '/skills/{id}/files/{relativePath}',
    tags: [TAG],
    summary: "Get a skill's file",
    security: SECURITY,
    pathParams: [
      { name: 'id', description: 'The skill id' },
      { name: 'relativePath', description: 'The file path within the skill' },
    ],
    responses: [
      { status: 200, description: 'The file content', schema: skillFileContentSchema },
      ...errorResponses,
    ],
  },
  {
    operationId: 'deleteSkillFile',
    method: 'delete',
    path: '/skills/{id}/files/{relativePath}',
    tags: [TAG],
    summary: "Delete a skill's file",
    security: SECURITY,
    pathParams: [
      { name: 'id', description: 'The skill id' },
      { name: 'relativePath', description: 'The file path within the skill' },
    ],
    responses: [
      { status: 200, description: 'The file was deleted', schema: skillFileDeleteResponseSchema },
      ...errorResponses,
      {
        status: 409,
        description:
          'The file changed while it was being deleted, or the bound account is being deleted',
        schema: z.union([agentManagementErrorSchema, accountDeletionResponseSchema]),
      },
    ],
  },
  {
    operationId: 'updateSkillFile',
    method: 'put',
    path: '/skills/{id}/files/{relativePath}',
    tags: [TAG],
    summary: "Create or update a skill's file",
    security: SECURITY,
    pathParams: [
      { name: 'id', description: 'The skill id' },
      { name: 'relativePath', description: 'The file path within the skill' },
    ],
    body: skillFileUpdateSchema,
    responses: [
      { status: 200, description: 'The file was written', schema: skillFileUpdatedSchema },
      ...errorResponses,
      { status: 429, description: 'Too many file-write requests', schema: messageResponseSchema },
    ],
  },
];
