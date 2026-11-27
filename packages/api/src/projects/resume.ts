import type { TFile } from 'librechat-data-provider';
import type {
  ConversationSnapshot,
  ChatProjectTenantSource,
  ResolvedChatProjectContext,
  ResolveChatProjectContextDeps,
} from './context';
import type { ProjectLogger } from './turn';
import {
  getChatProjectTenantId,
  getChatProjectContextKey,
  resolveChatProjectContext,
  CHAT_PROJECT_CONTEXT_UNAVAILABLE,
} from './context';
import { getSafeErrorMetadata } from '../utils/errors';

export const PROJECT_CONTEXT_CHANGED_REASON: string =
  'Project context changed before approval could be resumed';

export const PROJECT_CONTEXT_CHANGED_RESPONSE: Readonly<{ code: string; error: string }> = {
  code: 'PROJECT_CONTEXT_CHANGED',
  error: 'Project context changed; start a new turn.',
};

export interface ResumeProjectContextRequest extends ChatProjectTenantSource {
  chatProjectContext?: ResolvedChatProjectContext | null;
  resolvedConversation?: ConversationSnapshot | null;
  chatProjectContextResourcesPromise?: Promise<ResolvedChatProjectContext>;
  chatProjectFiles?: TFile[];
  chatProjectFilesPromise?: Promise<TFile[]>;
}

/**
 * Re-reads the authoritative conversation and project after the approval claim, replacing the
 * request's cached project state. An unavailable project resolves to no project context.
 */
export async function resolveResumeProjectContext(
  req: ResumeProjectContextRequest,
  conversationId: string,
  includeResources: boolean,
  deps: ResolveChatProjectContextDeps,
): Promise<ResolvedChatProjectContext | null> {
  let context: ResolvedChatProjectContext | null;
  let refreshedConversation: ConversationSnapshot | null | undefined;
  try {
    context = await resolveChatProjectContext(
      {
        userId: req.user.id,
        tenantId: getChatProjectTenantId(req),
        conversationId,
        includeResources,
      },
      {
        ...deps,
        getConvo: async (userId, id) => {
          refreshedConversation = await deps.getConvo(userId, id);
          return refreshedConversation;
        },
      },
    );
    req.chatProjectContextResourcesPromise = undefined;
    req.chatProjectFiles = undefined;
    req.chatProjectFilesPromise = undefined;
    req.resolvedConversation = refreshedConversation ?? null;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== CHAT_PROJECT_CONTEXT_UNAVAILABLE) {
      throw error;
    }
    context = null;
  }
  req.chatProjectContext = context;
  return context;
}

/**
 * Compares the claimed pause's recorded project key against the current project context.
 * The originating turn resolves guidance first and hydrates resources only once File Search is
 * known, so a guidance-only mismatch rehydrates resources before the final comparison. A pause
 * recorded before keys existed resumes under the current project context.
 */
export async function hasResumeProjectContextChanged(
  {
    req,
    conversationId,
    expectedKey,
  }: {
    req: ResumeProjectContextRequest;
    conversationId: string;
    expectedKey: string | null | undefined;
  },
  deps: ResolveChatProjectContextDeps & { logger: ProjectLogger },
): Promise<boolean> {
  let context = await resolveResumeProjectContext(req, conversationId, false, deps);
  let currentKey = getChatProjectContextKey(context);
  if (typeof expectedKey !== 'string') {
    if (context != null && (context.instructions.trim() !== '' || context.file_ids.length > 0)) {
      deps.logger.warn(
        '[ResumeAgentController] Resuming a pause without a recorded project context key under the current project context',
        { conversationId, projectId: context.projectId },
      );
    }
    return false;
  }
  if (expectedKey === currentKey) {
    return false;
  }
  context = await resolveResumeProjectContext(req, conversationId, true, deps);
  currentKey = getChatProjectContextKey(context);
  return expectedKey !== currentKey;
}

/**
 * Stops a claimed resume whose project context changed. Only the terminal-CAS winner prunes
 * the generation's checkpoint; a failed terminalization propagates so the caller's failure
 * path owns the running -> error transition instead of answering a non-retryable 409.
 */
export async function rejectChangedResumeProjectContext(
  params: {
    req: ResumeProjectContextRequest;
    conversationId: string;
    expectedKey: string | null | undefined;
  },
  deps: ResolveChatProjectContextDeps & {
    logger: ProjectLogger;
    finalizeJob: (reason: string) => Promise<boolean>;
    deleteCheckpoint: () => Promise<void>;
  },
): Promise<boolean> {
  if (!(await hasResumeProjectContextChanged(params, deps))) {
    return false;
  }
  let finalized: boolean;
  try {
    finalized = await deps.finalizeJob(PROJECT_CONTEXT_CHANGED_REASON);
  } catch (error) {
    deps.logger.error(
      '[ResumeAgentController] Failed to finalize stale project-context resume',
      getSafeErrorMetadata(error),
    );
    throw error;
  }
  if (finalized) {
    await deps.deleteCheckpoint().catch((error: unknown) => {
      deps.logger.warn(
        '[ResumeAgentController] Failed to prune stale project-context checkpoint',
        getSafeErrorMetadata(error),
      );
    });
  }
  return true;
}
