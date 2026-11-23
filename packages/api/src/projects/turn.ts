import type { TEndpointOption } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type {
  AgentProjectContextRequest,
  ConversationSnapshot,
  ResolvedChatProjectContext,
  ResolveChatProjectContextDeps,
} from './context';
import type { ContentPolicyError } from '../middleware/contentFilter';
import {
  getChatProjectTenantId,
  resolveChatProjectContext,
  formatChatProjectInstructions,
  CHAT_PROJECT_CONTEXT_UNAVAILABLE,
} from './context';
import { getContentFilterError, isContentFilterError } from '../middleware/contentFilter';
import { assertModelBoundContent } from '../middleware/modelBoundContent';
import { getSafeErrorMetadata } from '../utils/errors';

export const PROJECT_RESOURCES_CHANGED = 'PROJECT_RESOURCES_CHANGED';
export const CHAT_PROJECT_CONTEXT_UNAVAILABLE_RESPONSE: string = 'Conversation context unavailable';

/** Admitted project files moved between admission and runtime hydration; a new turn can retry. */
export class ChatProjectResourcesChangedError extends Error {
  public readonly code: typeof PROJECT_RESOURCES_CHANGED = PROJECT_RESOURCES_CHANGED;
  public readonly status = 409 as const;
  public readonly retryable = true as const;

  constructor() {
    super('Project resources changed during initialization');
    this.name = 'ChatProjectResourcesChangedError';
    Object.setPrototypeOf(this, ChatProjectResourcesChangedError.prototype);
  }
}

export interface ProjectLogger {
  warn: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
}

export type ChatProjectTurnFailure =
  | { status: 404; error: string }
  | { status: 409; code: string; error: string; retryable: true }
  | ({ status: number } & ContentPolicyError['body']);

/** Maps project-owned turn startup failures to the HTTP status and body sent before the ACK. */
export function getChatProjectTurnFailure(error: unknown): ChatProjectTurnFailure | null {
  if (error instanceof ChatProjectResourcesChangedError) {
    return {
      status: 409,
      code: PROJECT_RESOURCES_CHANGED,
      error: 'Project files changed while this turn was starting. Please retry.',
      retryable: true,
    };
  }
  if (error instanceof Error && error.message === CHAT_PROJECT_CONTEXT_UNAVAILABLE) {
    return { status: 404, error: CHAT_PROJECT_CONTEXT_UNAVAILABLE_RESPONSE };
  }
  if (!isContentFilterError(error)) {
    return null;
  }
  const policyError = getContentFilterError(error) ?? error;
  return { status: policyError.statusCode, ...policyError.body };
}

/**
 * Inspects project guidance as agent instructions. Legacy `messageFilter.pii` is scoped to
 * message, assembled-context and tool-argument sources, so it never applies to instructions.
 */
export function assertChatProjectInstructions({
  context,
  filters,
}: {
  context: ResolvedChatProjectContext | null | undefined;
  filters?: AppConfig['filters'];
}): void {
  if (!context?.instructions.trim()) {
    return;
  }
  assertModelBoundContent({ filters, agents: [{ instructions: context.instructions }] });
}

export function joinChatProjectInstructions(
  base: string | null | undefined,
  instructions: string,
): string {
  return [base, instructions].filter(Boolean).join('\n\n');
}

export type ApiConversationProjectResult =
  | {
      ok: true;
      conversation: ConversationSnapshot;
      context: ResolvedChatProjectContext | null;
    }
  | {
      ok: false;
      status: 404 | 409 | 500;
      reason: 'not_found' | 'read_only' | 'unavailable' | 'server_error';
      message: string;
    };

/**
 * Loads the continued conversation for the OpenAI-compatible and Responses APIs and resolves
 * its authoritative project guidance, mapping every failure to the response the caller sends.
 */
export async function resolveApiConversationProject(
  {
    userId,
    tenantId,
    conversationId,
    rejectSubagentThread = false,
  }: {
    userId: string;
    tenantId?: string | null;
    conversationId: string;
    rejectSubagentThread?: boolean;
  },
  deps: ResolveChatProjectContextDeps & { logger: ProjectLogger; logPrefix: string },
): Promise<ApiConversationProjectResult> {
  try {
    const conversation = await deps.getConvo(userId, conversationId);
    if (!conversation) {
      return { ok: false, status: 404, reason: 'not_found', message: 'Conversation not found' };
    }
    if (rejectSubagentThread && conversation.subagentThread != null) {
      return { ok: false, status: 409, reason: 'read_only', message: 'Conversation is read-only' };
    }
    const context = await resolveChatProjectContext(
      {
        userId,
        tenantId,
        conversationId,
        resolvedConversation: conversation,
        includeResources: false,
      },
      deps,
    );
    return { ok: true, conversation, context };
  } catch (error) {
    deps.logger.error(
      `${deps.logPrefix} Conversation context resolution failed`,
      getSafeErrorMetadata(error),
    );
    const unavailable =
      error instanceof Error && error.message === CHAT_PROJECT_CONTEXT_UNAVAILABLE;
    return unavailable
      ? {
          ok: false,
          status: 404,
          reason: 'unavailable',
          message: CHAT_PROJECT_CONTEXT_UNAVAILABLE_RESPONSE,
        }
      : {
          ok: false,
          status: 500,
          reason: 'server_error',
          message: CHAT_PROJECT_CONTEXT_UNAVAILABLE_RESPONSE,
        };
  }
}

export type AssistantProjectTurn =
  | { rejection: { status: number; body: object } }
  | {
      rejection?: undefined;
      conversation: ConversationSnapshot | null;
      context: ResolvedChatProjectContext | null;
      instructions: string;
      /** Membership written with the final conversation: seeded only on a new conversation. */
      membershipProjectId: string | null | undefined;
    };

/**
 * Resolves project guidance for a hosted Assistants turn and inspects it before any provider
 * side effect. Content-policy and unavailable-project outcomes return the response to send.
 */
export async function resolveAssistantProjectTurn(
  {
    userId,
    tenantId,
    conversationId,
    requestedProjectId,
    resolvedConversation,
    filters,
  }: {
    userId: string;
    tenantId?: string | null;
    conversationId?: string | null;
    requestedProjectId?: string | null;
    resolvedConversation?: ConversationSnapshot | null;
    filters?: AppConfig['filters'];
  },
  deps: ResolveChatProjectContextDeps,
): Promise<AssistantProjectTurn> {
  let conversation = resolvedConversation;
  if (conversation === undefined) {
    conversation = conversationId ? await deps.getConvo(userId, conversationId) : null;
  }
  const existingConversation = conversation ?? null;
  let context: ResolvedChatProjectContext | null;
  try {
    context = await resolveChatProjectContext(
      {
        userId,
        tenantId,
        conversationId,
        requestedProjectId,
        resolvedConversation: existingConversation,
        includeResources: false,
      },
      deps,
    );
    assertChatProjectInstructions({ context, filters });
  } catch (error) {
    const failure = getChatProjectTurnFailure(error);
    if (failure == null || failure.status === 409) {
      throw error;
    }
    const { status, ...body } = failure;
    return { rejection: { status, body } };
  }
  return {
    conversation: existingConversation,
    context,
    instructions: formatChatProjectInstructions(context),
    membershipProjectId:
      existingConversation === null ? context?.projectId : existingConversation.chatProjectId,
  };
}

/**
 * Resolves guidance for an agent initialization that did not arrive with a resolved project
 * context, reusing an already-resolved context (including an explicit `undefined`) as-is.
 */
export function resolveInitializationProjectContext(
  {
    req,
    endpointOption,
    conversationId,
    conversationPromise,
  }: {
    req: AgentProjectContextRequest;
    endpointOption: Partial<TEndpointOption>;
    conversationId?: string | null;
    conversationPromise: Promise<ConversationSnapshot | null | undefined>;
  },
  deps: ResolveChatProjectContextDeps,
): Promise<ResolvedChatProjectContext | null | undefined> {
  if (Object.prototype.hasOwnProperty.call(req, 'chatProjectContext')) {
    return Promise.resolve(req.chatProjectContext);
  }
  const requestedProjectId =
    endpointOption.chatProjectId !== undefined
      ? endpointOption.chatProjectId
      : req.body?.chatProjectId;
  return conversationPromise.then((resolvedConversation) =>
    resolveChatProjectContext(
      {
        userId: req.user.id,
        tenantId: getChatProjectTenantId(req),
        conversationId,
        requestedProjectId,
        resolvedConversation,
        includeResources: false,
      },
      deps,
    ),
  );
}
