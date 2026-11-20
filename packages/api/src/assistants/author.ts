import { logger, SystemCapabilities } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type { CapabilityUser, HasCapabilityFn } from '../middleware/capabilities';
import {
  ResourcePermissionsBusyError,
  ResourcePermissionsUnavailableError,
} from '../acl/accessControlService';

interface AssistantAuthorRequest {
  params: { id?: unknown; assistant_id?: unknown };
  body?: { endpoint?: string; assistant_id?: unknown };
  query?: { endpoint?: string; assistant_id?: unknown };
  user: CapabilityUser;
  config: { endpoints?: Record<string, { privateAssistants?: boolean } | undefined> };
}

interface AssistantAuthorInput {
  req: AssistantAuthorRequest;
  openai: {
    beta: {
      assistants: {
        retrieve: (id: string) => Promise<{ metadata?: { author?: string } | null }>;
      };
    };
  };
  overrideAssistantId?: string;
}

interface AssistantAuthorQuery {
  assistantId: string;
  user?: string;
}

interface AssistantAuthorDeps {
  getAssistant: (query: { assistantId: string; user: string }) => Promise<object | null>;
  hasCapability: HasCapabilityFn;
}

interface AssistantAvatarIdentityInput {
  query: { assistantId: string; user?: string };
  user: Pick<CapabilityUser, 'id' | 'tenantId'>;
  endpoint: string;
  author?: unknown;
  privateAssistants?: boolean;
  getAssistant: (
    query: { assistantId: string },
    projection: { user: 1 },
  ) => Promise<{ user?: { toString(): string } | null } | null>;
  getUserById: (id: string, select: string) => Promise<{ tenantId?: string } | null>;
}

/** Provider authors initialize references; populated local identity remains authoritative. */
export async function resolveAssistantAvatarIdentity({
  query,
  user,
  endpoint,
  author,
  privateAssistants,
  getAssistant,
  getUserById,
}: AssistantAvatarIdentityInput): Promise<{ user: string; endpoint: string }> {
  const identity = { user: query.user ?? user.id, endpoint };
  if (query.user !== undefined || author === user.id) {
    return identity;
  }
  if (typeof author === 'string' && /^[a-f0-9]{24}$/i.test(author)) {
    const providerAuthor = await getUserById(author, 'tenantId');
    if (providerAuthor && providerAuthor.tenantId === user.tenantId) {
      return { user: author, endpoint };
    }
  }
  if (!privateAssistants) {
    return identity;
  }
  const reference = await getAssistant({ assistantId: query.assistantId }, { user: 1 });
  const owner = reference?.user?.toString();
  if (!owner || !/^[a-f0-9]{24}$/i.test(owner)) {
    throw new Error('Assistant owner could not be verified');
  }
  return { user: owner, endpoint };
}

export class AssistantIdValidationError extends Error {
  readonly code = 'invalid_assistant_id';

  constructor(message: string) {
    super(message);
    this.name = 'AssistantIdValidationError';
  }
}

export function getAssistantErrorStatus(error: unknown): number {
  if (
    error instanceof ResourcePermissionsBusyError ||
    error instanceof ResourcePermissionsUnavailableError
  ) {
    return error.statusCode;
  }
  return error instanceof AssistantIdValidationError ? 400 : 500;
}

interface AssistantIdInput {
  req: {
    params: { id?: unknown; assistant_id?: unknown };
    body?: { assistant_id?: unknown };
    query?: { assistant_id?: unknown };
  };
  overrideAssistantId?: string;
}

function resolveAssistantId({ req, overrideAssistantId }: AssistantIdInput): string {
  let assistantId: string | undefined;
  for (const value of [
    overrideAssistantId,
    req.params.id,
    req.params.assistant_id,
    req.body?.assistant_id,
    req.query?.assistant_id,
  ]) {
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
      throw new AssistantIdValidationError('Invalid Assistant ID');
    }
    if (assistantId !== undefined && value !== assistantId) {
      throw new AssistantIdValidationError('Conflicting Assistant IDs');
    }
    assistantId = value;
  }
  if (assistantId === undefined) {
    throw new AssistantIdValidationError('Assistant ID is required');
  }
  return assistantId;
}

/** Rejects invalid selectors before an assistant controller starts HTTP or streaming work. */
export const validateAssistantId: RequestHandler = (req, res, next): void => {
  try {
    resolveAssistantId({ req });
  } catch (error) {
    if (!(error instanceof AssistantIdValidationError)) {
      next(error);
      return;
    }
    res.status(400).json({ error: error.code, message: error.message });
    return;
  }
  next();
};

/** Returns the exact resource and owner scope authorized for a subsequent local mutation. */
export function createAssistantAuthorValidator({
  getAssistant,
  hasCapability,
}: AssistantAuthorDeps): (input: AssistantAuthorInput) => Promise<AssistantAuthorQuery> {
  return async (input) => {
    const { req, openai } = input;
    const assistantId = resolveAssistantId(input);
    const endpoint = req.body?.endpoint ?? req.query?.endpoint;
    const assistantsConfig = endpoint === undefined ? undefined : req.config.endpoints?.[endpoint];
    if (!assistantsConfig?.privateAssistants) {
      return { assistantId };
    }

    let canManageAssistants = false;
    try {
      canManageAssistants = await hasCapability(req.user, SystemCapabilities.MANAGE_ASSISTANTS);
    } catch {
      logger.warn('[validateAuthor] Capability check failed, denying bypass');
    }
    if (canManageAssistants) {
      return { assistantId };
    }

    const query = { assistantId, user: req.user.id };
    const assistantDoc = await getAssistant(query);
    if (assistantDoc) {
      return query;
    }
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    if (req.user.id !== assistant?.metadata?.author) {
      throw new Error('Assistant is not authored by the user');
    }
    return query;
  };
}
