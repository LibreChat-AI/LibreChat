import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { EndpointContract, ResponseContract } from './adapter';
import {
  accountDeletionResponseSchema,
  errorMessageResponseSchema,
  genericServerErrorContent,
  jsonParseErrorSchema,
  messageResponseSchema,
} from './errors';
import {
  conversationMetadataListSchema,
  conversationMetadataQuery,
  conversationMetadataSchema,
} from '../conversations/metadata';
import { agentManagementErrorSchema } from '../agents/management';

export const conversationComponentSchemas: Record<string, ZodTypeAny> = {
  ConversationMetadata: conversationMetadataSchema,
  ConversationMetadataList: conversationMetadataListSchema,
};

const errors: ResponseContract[] = [
  {
    status: 400,
    description: 'Invalid request or malformed JSON body',
    schema: z.union([agentManagementErrorSchema, jsonParseErrorSchema]),
  },
  { status: 401, description: 'Authentication failed', schema: errorMessageResponseSchema },
  {
    status: 403,
    description:
      'The client is not enabled to read conversations, or the account cannot access the API',
    schema: z.union([
      agentManagementErrorSchema,
      errorMessageResponseSchema,
      messageResponseSchema,
    ]),
  },
  {
    status: 409,
    description: 'The bound account is being deleted',
    schema: accountDeletionResponseSchema,
  },
  {
    status: 500,
    description: 'Internal server error',
    schema: z.union([agentManagementErrorSchema, errorMessageResponseSchema]),
    additionalContent: genericServerErrorContent,
  },
];

const common: Pick<EndpointContract, 'method' | 'tags' | 'security'> = {
  method: 'get',
  tags: ['Conversations'],
  security: ['oidcBearer'],
};
export const conversationContracts: EndpointContract[] = [
  {
    ...common,
    operationId: 'listConversationMetadata',
    path: '/conversations',
    summary: 'List the bound account’s conversation metadata',
    description:
      'Requires conversationRead on the OIDC client binding. Archived conversations are included unless filtered.',
    query: conversationMetadataQuery,
    responses: [
      {
        status: 200,
        description: 'A page of conversation metadata',
        schema: conversationMetadataListSchema,
      },
      ...errors,
    ],
  },
  {
    ...common,
    operationId: 'getConversationMetadata',
    path: '/conversations/{id}',
    summary: 'Get the bound account’s conversation metadata',
    description: 'Requires conversationRead on the OIDC client binding.',
    pathParams: [{ name: 'id', description: 'The conversation ID' }],
    responses: [
      { status: 200, description: 'The conversation metadata', schema: conversationMetadataSchema },
      { status: 404, description: 'Conversation not found', schema: agentManagementErrorSchema },
      ...errors,
    ],
  },
];
