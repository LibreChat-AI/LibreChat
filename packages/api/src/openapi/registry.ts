import type { ZodTypeAny } from 'zod';
import type { EndpointContract, SecurityScheme } from './adapter';
import {
  errorMessageResponseSchema,
  accountDeletionResponseSchema,
  messageResponseSchema,
  jsonParseErrorSchema,
} from './errors';
import { agentComponentSchemas, agentContracts } from './agents';
import { skillComponentSchemas, skillContracts } from './skills';

/** The agent and skill management endpoints authenticate with an OIDC access token (bearer). */
export const securitySchemes: Record<string, SecurityScheme> = {
  oidcBearer: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'An OIDC access token, sent as a bearer token.',
  },
};

export const componentSchemas: Record<string, ZodTypeAny> = {
  ...agentComponentSchemas,
  ...skillComponentSchemas,
  ErrorMessage: errorMessageResponseSchema,
  AccountDeletionConflict: accountDeletionResponseSchema,
  MessageError: messageResponseSchema,
  JsonParseError: jsonParseErrorSchema,
};

/**
 * Constraints the Zod-to-OpenAPI converter cannot emit, applied to the generated component.
 * `SkillUpdateRequest`'s object-level `.refine()` (at least one update field) is lost in
 * conversion; `minProperties: 2` keeps `expectedVersion` plus at least one real field.
 *
 * `SkillFileUpdateRequest.content` uses `maxLength`, which counts characters, but `updateFile`
 * (skills/management.ts) rejects when the UTF-8 buffer exceeds 1 MiB. The converter drops the
 * field description, so restate the single `content` property here with the byte limit. The
 * component has only this property, so the whole `properties` object is stated, not clobbered.
 */
export const componentSchemaOverrides: Record<string, Record<string, unknown>> = {
  SkillUpdateRequest: { minProperties: 2 },
  SkillFileUpdateRequest: {
    properties: {
      content: {
        type: 'string',
        maxLength: 1024 * 1024,
        description:
          'The file content. The accepted maximum is 1 MiB (1,048,576 bytes) of UTF-8-encoded content. The limit is measured in bytes, not characters, so non-ASCII content reaches it at fewer characters.',
      },
    },
  },
};

export const contracts: EndpointContract[] = [...agentContracts, ...skillContracts];
