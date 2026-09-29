import type { IChatProject, IConversation } from '@librechat/data-schemas';
import type { TEndpointOption } from 'librechat-data-provider';
import type { CanonicalProjectResource, GetProjectFiles } from './resources';
import { PARTIAL_RESOLVED_CONVERSATION } from '../agents/conversationSymbols';
import { resolveChatProjectResources } from './resources';

export interface ResolvedChatProjectContext {
  projectId: string;
  contextRevision: number;
  instructions: string;
  file_ids: string[];
  /** Owner-scoped canonical file metadata, with no extracted content. */
  resources: readonly CanonicalProjectResource[];
}
export type ConversationSnapshot = Partial<IConversation> & {
  conversationId?: string;
  chatProjectId?: string | null;
  user?: string;
  tenantId?: string | null;
};

type ProjectSnapshot = Pick<IChatProject, 'instructions' | 'contextRevision' | 'file_ids'> & {
  _id?: { toString(): string } | string;
  tenantId?: string | null;
};

export interface ResolveChatProjectContextInput {
  userId: string;
  tenantId?: string | null;
  conversationId?: string | null;
  requestedProjectId?: string | null;
  resolvedConversation?: ConversationSnapshot | null;
  /** Trusted server-side control for callers that only need project guidance. */
  includeResources?: boolean;
}
export interface ResolveChatProjectContextDeps {
  getConvo: (userId: string, conversationId: string) => Promise<ConversationSnapshot | null>;
  getChatProject: (userId: string, projectId: string) => Promise<ProjectSnapshot | null>;
  getProjectFiles: GetProjectFiles;
}

export const CHAT_PROJECT_CONTEXT_UNAVAILABLE = 'Project context unavailable';

export interface ChatProjectTenantSource {
  user: { id: string; tenantId?: string | null };
  _agentEventBindingParentConversationId?: string | null;
  _agentEventBindingTenantId?: string | null;
}

/** Bound child conversations resolve project context in the event binding's tenant. */
export function getChatProjectTenantId(req: ChatProjectTenantSource): string | null | undefined {
  return req._agentEventBindingParentConversationId != null
    ? req._agentEventBindingTenantId
    : req.user.tenantId || undefined;
}

export interface AgentProjectContextRequest extends ChatProjectTenantSource {
  body?: { chatProjectId?: string | null };
  chatProjectContext?: ResolvedChatProjectContext | null;
  chatProjectContextPromise?: Promise<ResolvedChatProjectContext | null>;
  chatProjectContextResourcesPromise?: Promise<ResolvedChatProjectContext>;
  chatProjectContextEnabled?: boolean;
  resolvedConversation?: ConversationSnapshot | null;
}

export async function hydrateChatProjectContextResources(
  context: ResolvedChatProjectContext,
  {
    userId,
    tenantId,
    getProjectFiles,
  }: {
    userId: string;
    tenantId?: string | null;
    getProjectFiles: GetProjectFiles;
  },
): Promise<ResolvedChatProjectContext> {
  if (context.resources.length === new Set(context.file_ids).size) {
    return context;
  }
  return {
    ...context,
    resources: await resolveChatProjectResources({
      project: { file_ids: context.file_ids },
      userId,
      tenantId: tenantId ?? undefined,
      getProjectFiles,
    }),
  };
}
export function startAgentProjectContextResolution({
  req,
  endpointOption,
  conversationId,
  isNewConvo,
  conversationAnchorPromise,
  getConvo,
  getChatProject,
  getProjectFiles,
}: {
  req: AgentProjectContextRequest;
  endpointOption?: Partial<TEndpointOption>;
  conversationId: string;
  isNewConvo: boolean;
  conversationAnchorPromise: Promise<{
    conversation: ConversationSnapshot | null | undefined;
  }>;
  getConvo: ResolveChatProjectContextDeps['getConvo'];
  getChatProject: ResolveChatProjectContextDeps['getChatProject'];
  getProjectFiles: GetProjectFiles;
}): Promise<ResolvedChatProjectContext | null> {
  if (req.chatProjectContext !== undefined) {
    return Promise.resolve(req.chatProjectContext);
  }
  if (req.chatProjectContextPromise !== undefined) {
    return req.chatProjectContextPromise;
  }

  const requestedProjectId =
    endpointOption?.chatProjectId !== undefined
      ? endpointOption.chatProjectId
      : req.body?.chatProjectId;
  const contextPromise = conversationAnchorPromise
    .then(({ conversation }) => {
      // An existing chat's undefined anchor is a failed read, not confirmed absence.
      if (conversation !== undefined || isNewConvo) {
        req.resolvedConversation = conversation ?? null;
      }
      return resolveChatProjectContext(
        {
          userId: req.user.id,
          tenantId: getChatProjectTenantId(req),
          conversationId,
          requestedProjectId,
          resolvedConversation: isNewConvo ? (conversation ?? null) : conversation,
          includeResources: false,
        },
        {
          getConvo: async (...args) => {
            const loaded = await getConvo(...args);
            if (!isNewConvo) {
              req.resolvedConversation = loaded;
            }
            return loaded;
          },
          getChatProject,
          getProjectFiles,
        },
      );
    })
    .then((context) => {
      req.chatProjectContext = context;
      req.chatProjectContextEnabled = true;
      return context;
    });
  req.chatProjectContextPromise = contextPromise;
  // Admission/idempotency may return before this promise is awaited. Attach a
  // rejection handler to avoid an unhandled rejection while preserving the
  // original promise for the eventual preflight await.
  contextPromise.catch(() => {});
  return contextPromise;
}
/**
 * Resolves the project bound to a turn. A full conversation read, including an explicit
 * absence of membership, is authoritative over all request-carried project fields.
 */
export async function resolveChatProjectContext(
  input: ResolveChatProjectContextInput,
  deps: ResolveChatProjectContextDeps,
): Promise<ResolvedChatProjectContext | null> {
  const {
    userId,
    tenantId,
    conversationId,
    requestedProjectId,
    resolvedConversation: suppliedConversation,
    includeResources = true,
  } = input;

  let conversation: ConversationSnapshot | null | undefined = suppliedConversation;
  if (
    suppliedConversation != null &&
    (suppliedConversation as Record<symbol, boolean | undefined>)[PARTIAL_RESOLVED_CONVERSATION] !==
      true
  ) {
    const suppliedUserId = suppliedConversation.user;
    if (
      (suppliedUserId != null && suppliedUserId !== userId) ||
      (suppliedConversation.tenantId ?? null) !== (tenantId ?? null)
    ) {
      throw new Error(CHAT_PROJECT_CONTEXT_UNAVAILABLE);
    }
  }
  if (
    conversation != null &&
    (conversationId == null || conversation.conversationId === conversationId) &&
    (conversation as Record<symbol, boolean | undefined>)[PARTIAL_RESOLVED_CONVERSATION] !== true
  ) {
    // Reuse the complete ingress snapshot without another conversation query.
  } else if (
    Object.prototype.hasOwnProperty.call(input, 'resolvedConversation') &&
    suppliedConversation === null
  ) {
    conversation = null;
  } else if (typeof conversationId === 'string' && conversationId !== '') {
    conversation = await deps.getConvo(userId, conversationId);
  } else {
    conversation = undefined;
  }

  const conversationIsAuthoritative =
    conversation != null &&
    (conversationId == null || conversation.conversationId === conversationId) &&
    (conversation as Record<symbol, boolean | undefined>)[PARTIAL_RESOLVED_CONVERSATION] !== true;
  const rawProjectId = conversationIsAuthoritative
    ? conversation?.chatProjectId
    : requestedProjectId;
  const projectId =
    typeof rawProjectId === 'string' && rawProjectId.trim() !== '' ? rawProjectId : null;

  if (projectId == null) {
    return null;
  }

  const project = await deps.getChatProject(userId, projectId);
  if (project == null || (project.tenantId ?? null) !== (tenantId ?? null)) {
    if (conversationIsAuthoritative) {
      return null;
    }
    throw new Error(CHAT_PROJECT_CONTEXT_UNAVAILABLE);
  }

  const projectIdFromRecord =
    typeof project._id === 'string' && project._id !== ''
      ? project._id
      : (project._id?.toString() ?? projectId);
  const file_ids = Array.isArray(project.file_ids)
    ? project.file_ids.filter((fileId): fileId is string => typeof fileId === 'string')
    : [];
  const resources =
    includeResources === false
      ? []
      : await resolveChatProjectResources({
          project: { file_ids },
          userId,
          tenantId: tenantId ?? undefined,
          getProjectFiles: deps.getProjectFiles,
        });
  return {
    projectId: projectIdFromRecord,
    contextRevision:
      typeof project.contextRevision === 'number' && Number.isSafeInteger(project.contextRevision)
        ? project.contextRevision
        : 0,
    instructions: typeof project.instructions === 'string' ? project.instructions : '',
    file_ids,
    resources,
  };
}

export function getChatProjectContextKey(
  context: ResolvedChatProjectContext | null | undefined,
): string {
  if (context == null) {
    return 'chat-project:none';
  }
  const resourceKey = context.resources.map((resource) => [
    resource.file_id,
    resource.identity,
    resource.availability,
    resource.version,
  ]);
  return `chat-project:${context.projectId}:${context.contextRevision}:${JSON.stringify(context.file_ids)}:${JSON.stringify(resourceKey)}`;
}

export function formatChatProjectInstructions(
  context: ResolvedChatProjectContext | null | undefined,
): string {
  if (context == null || context.instructions.trim() === '') {
    return '';
  }
  return `Project guidance (user-provided context; subordinate to system, platform, agent, and tool policies):
${context.instructions}`;
}
