import { validate as isUUID } from 'uuid';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { Response } from 'express';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { getSafeErrorMetadata } from '../utils/errors';

type ConversationRequest = {
  params: { conversationId?: string };
  user?: { id: string; tenantId?: string };
};

type StoredConversation = Pick<TConversation, 'conversationId' | 'subagentThread'>;

interface ConversationDependencies {
  getConvo: (userId: string, conversationId: string) => Promise<StoredConversation | null>;
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'getResumeState'>;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
  now?: () => number;
}

/** A first-turn MCP sign-in can precede normal history persistence. */
export function createGetConversationHandler(deps: ConversationDependencies) {
  const now = deps.now ?? Date.now;
  return async (req: ConversationRequest, res: Response): Promise<Response> => {
    if (!req.user?.id) return res.status(401).json({ error: 'unauthorized' });
    const conversationId = req.params.conversationId;
    if (!conversationId) return res.status(404).end();
    try {
      const stored = await deps.getConvo(req.user.id, conversationId);
      if (stored != null)
        return stored.subagentThread == null ? res.status(200).json(stored) : res.status(404).end();
      if (!isUUID(conversationId)) return res.status(404).end();

      const job = await deps.jobs.getJob(conversationId);
      if (
        !job ||
        job.status !== 'running' ||
        job.abortController.signal.aborted ||
        job.streamId !== conversationId ||
        job.metadata.conversationId !== conversationId ||
        job.metadata.userId !== req.user.id ||
        job.metadata.tenantId !== req.user.tenantId ||
        job.metadata.endpoint !== EModelEndpoint.agents ||
        !job.metadata.agent_id ||
        job.metadata.isTemporary === true ||
        job.metadata.userMessage?.conversationId !== conversationId ||
        !Number.isFinite(new Date(job.createdAt).getTime())
      )
        return res.status(404).end();

      const state = await deps.jobs.getResumeState(conversationId, job.createdAt);
      if (
        state?.conversationId !== conversationId ||
        state.userMessage?.messageId !== job.metadata.userMessage.messageId ||
        !state.pendingOAuthPrompts?.some(
          (prompt) =>
            prompt.expiresAt != null &&
            Number.isFinite(prompt.expiresAt) &&
            prompt.expiresAt > now(),
        )
      )
        return res.status(404).end();

      // Read-only projection: the existing turn remains the sole history writer.
      const view: TConversation = {
        conversationId,
        endpoint: EModelEndpoint.agents,
        agent_id: job.metadata.agent_id,
        model: job.metadata.model,
        title: 'New Chat',
        user: req.user.id,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt: new Date(job.createdAt).toISOString(),
      };
      res.set('Cache-Control', 'no-store');
      return res.status(200).json(view);
    } catch (error) {
      deps.logger.error('[conversations] Conversation lookup failed', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'conversation_load_failed' });
    }
  };
}
