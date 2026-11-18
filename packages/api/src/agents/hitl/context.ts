import type { RequestHandler } from 'express';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { applyResumeRequest } from './policy';

/** Chat may restore chat checkpoints only; Responses owns its separate admission journal. */
export function createChatResumeContext(deps: {
  jobs: Pick<GenerationJobManagerClass, 'getJob'>;
  onError: (error: unknown) => void;
}): RequestHandler {
  return async (req, res, next) => {
    if (req.path.replace(/\/+$/, '').toLowerCase() !== '/resume') return next();
    const streamId = req.body?.conversationId;
    if (typeof streamId !== 'string' || !streamId) return next();
    try {
      const job = await deps.jobs.getJob(streamId);
      if (job?.metadata.endpoint === 'responses') {
        res.status(404).json({ error: 'No paused generation for this conversation' });
        return;
      }
      applyResumeRequest(req, job?.metadata.pendingAction?.resumeContext);
    } catch (error) {
      deps.onError(error);
      res.status(503).json({ error: 'resume_context_unavailable' });
      return;
    }
    next();
  };
}
