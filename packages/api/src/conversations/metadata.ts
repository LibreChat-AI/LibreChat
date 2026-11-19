import { z } from 'zod';
import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type {
  ConversationMetadata,
  ConversationMetadataBoundary,
  ConversationMetadataMethods,
  ConversationMetadataScope,
} from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { mapAgentManagementError } from '../agents/management';
import { getSafeErrorMetadata } from '~/utils/errors';

const identifier = z.string().trim().min(1).max(512);
// Stored bookmark names are exact strings. Let the request line bound their
// encoded size and cap how many labels can reach a single MongoDB filter.
const tag = z.string();
const date = z.string().datetime().nullable();

type Query = {
  limit: number;
  cursor?: string;
  agent_id?: string;
  tags?: string[];
  isArchived?: boolean;
};

type List = {
  object: 'list';
  data: ConversationMetadata[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
  after: string | null;
};

export const conversationMetadataQuery: z.ZodType<Query, unknown> = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    agent_id: identifier.optional(),
    tags: z
      .union([tag, z.array(tag).min(1).max(100)])
      .transform((value) => [...new Set(Array.isArray(value) ? value : [value])].sort())
      .optional(),
    isArchived: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

export const conversationMetadataSchema: z.ZodType<ConversationMetadata> = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: date,
    updatedAt: date,
    agent_id: z.string().nullable(),
    tags: z.array(z.string()),
    isArchived: z.boolean(),
    endpoint: z.string().nullable(),
    model: z.string().nullable(),
  })
  .strict();

export const conversationMetadataListSchema: z.ZodType<List> = z
  .object({
    object: z.literal('list'),
    data: z.array(conversationMetadataSchema),
    first_id: z.string().nullable(),
    last_id: z.string().nullable(),
    has_more: z.boolean(),
    after: z.string().nullable(),
  })
  .strict();

const boundarySchema = z.object({
  updatedAt: date,
  id: z.string().regex(/^[a-f\d]{24}$/),
});
const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    boundary: boundarySchema,
  })
  .strict();

type Filters = Omit<Query, 'limit' | 'cursor'>;

function cursorScope(scope: ConversationMetadataScope, filters: Filters): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.tenantId,
        scope.user,
        filters.agent_id ?? null,
        filters.tags ?? [],
        filters.isArchived ?? null,
      ]),
    )
    .digest('base64url');
}

function encode(boundary: ConversationMetadataBoundary, scope: string): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, boundary })).toString('base64url');
}

function decode(cursor: string, scope: string): ConversationMetadataBoundary | null {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return parsed.scope === scope ? parsed.boundary : null;
  } catch {
    return null;
  }
}

function respond(
  res: Response,
  code: 'invalid_request' | 'not_found' | 'internal_error' | 'permission_denied',
) {
  if (code === 'not_found') {
    return res.status(404).json({ error: { code, message: 'Conversation not found' } });
  }
  const mapped = mapAgentManagementError(code);
  return res.status(mapped.status).json(mapped.body);
}

function owner(req: ServerRequest): ConversationMetadataScope | null {
  if (!req.user?.id || !req.user.tenantId) return null;
  return { user: req.user.id, tenantId: req.user.tenantId };
}

type Handler = (req: ServerRequest, res: Response) => Promise<Response>;

export function createConversationMetadataHandlers(deps: ConversationMetadataMethods): {
  list: Handler;
  get: Handler;
  missing: (req: ServerRequest, res: Response) => Response;
} {
  const list = async (req: ServerRequest, res: Response) => {
    const scope = owner(req);
    if (!scope) return respond(res, 'permission_denied');
    const parsed = conversationMetadataQuery.safeParse(req.query);
    if (!parsed.success) return respond(res, 'invalid_request');

    const { cursor, limit, ...filters } = parsed.data;
    const scopeKey = cursorScope(scope, filters);
    const boundary = cursor ? decode(cursor, scopeKey) : undefined;
    if (boundary === null) return respond(res, 'invalid_request');

    try {
      const { data, next } = await deps.listConversationMetadata(scope, {
        ...filters,
        limit,
        boundary,
      });
      return res.json({
        object: 'list',
        data,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
        has_more: next !== null,
        after: next ? encode(next, scopeKey) : null,
      });
    } catch (error) {
      logger.error('[conversationMetadata] List failed', getSafeErrorMetadata(error));
      return respond(res, 'internal_error');
    }
  };

  const get = async (req: ServerRequest, res: Response) => {
    const scope = owner(req);
    if (!scope) return respond(res, 'permission_denied');
    const parsed = identifier.safeParse((req.params as { id?: string }).id);
    if (!parsed.success) return respond(res, 'invalid_request');

    try {
      const record = await deps.getConversationMetadata(scope, parsed.data);
      return record ? res.json(record) : respond(res, 'not_found');
    } catch (error) {
      logger.error('[conversationMetadata] Get failed', getSafeErrorMetadata(error));
      return respond(res, 'internal_error');
    }
  };

  return { list, get, missing: (_req: ServerRequest, res: Response) => respond(res, 'not_found') };
}
