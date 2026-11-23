import { validate as isUUID } from 'uuid';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { Response } from 'express';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { SerializableJobData } from '~/stream/interfaces/IJobStore';
import { getSafeErrorMetadata } from '../utils/errors';

type ConversationRequest = {
  params: { conversationId?: string };
  user?: { id: string; tenantId?: string };
};

type StoredConversation = Pick<TConversation, 'conversationId' | 'subagentThread'>;

interface ConversationDependencies {
  getConvo: (userId: string, conversationId: string) => Promise<StoredConversation | null>;
  jobs: Pick<GenerationJobManagerClass, 'getResumeState'>;
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

      const user = req.user;
      let eligible: Readonly<SerializableJobData> | undefined;
      const state = await deps.jobs.getResumeState(conversationId, undefined, {
        readIf(job) {
          const deadline = job.retentionExpiresAt;
          const expiresAt = deadline == null ? undefined : Date.parse(deadline);
          if (
            job.status !== 'running' ||
            job.streamId !== conversationId ||
            job.conversationId !== conversationId ||
            job.userId !== user.id ||
            (job.tenantId || undefined) !== (user.tenantId || undefined) ||
            job.endpoint !== EModelEndpoint.agents ||
            !job.agent_id ||
            job.isNewConversation !== true ||
            job.isTemporary === true ||
            typeof job.userMessage?.messageId !== 'string' ||
            !job.userMessage.messageId ||
            job.userMessage.conversationId !== conversationId ||
            !Number.isFinite(new Date(job.createdAt).getTime()) ||
            (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= now()))
          )
            return false;
          eligible = job;
          return true;
        },
      });
      const job = eligible;
      if (
        !job ||
        state?.conversationId !== conversationId ||
        state.userMessage?.messageId !== job.userMessage?.messageId ||
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
        agent_id: job.agent_id,
        model: job.model,
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
