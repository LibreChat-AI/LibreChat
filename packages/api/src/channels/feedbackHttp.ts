import type { ChannelFeedbackActor } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { createChannelFeedbackService } from './feedback';
import type { ChannelServiceGuard } from './runs';
import { channelReactionSchema } from './feedback';

export interface ChannelFeedbackHttpDependencies {
  guard: ChannelServiceGuard;
  feedback: ReturnType<typeof createChannelFeedbackService>;
  wake?: () => void;
}

export interface ChannelFeedbackHandlers {
  reaction: RequestHandler;
}

export function createChannelFeedbackHandlers(
  deps: ChannelFeedbackHttpDependencies,
): ChannelFeedbackHandlers {
  return {
    reaction: deps.guard(async (req, res, channel) => {
      res.set('Cache-Control', 'no-store');
      const parsed = channelReactionSchema.safeParse(req.body);
      if (!parsed.success || !channel.revision || !channel.slack?.teamId) {
        res.status(400).json({ error: 'invalid_reaction' });
        return;
      }
      const actor: ChannelFeedbackActor = {
        tenantId: channel.tenantId || '_',
        channelId: channel.channelId,
        channelRevision: channel.revision,
        teamId: channel.slack.teamId,
        agentId: channel.agentId,
      };
      const result = await deps.feedback.record(actor, parsed.data);
      if (!result.ok) {
        let status = 409;
        if (result.error.code === 'forbidden') status = 403;
        else if (result.error.code === 'mapping_not_found') status = 404;
        res.status(status).json({ error: result.error.code });
        return;
      }
      if (!result.value.ignored) deps.wake?.();
      res.json(result.value);
    }),
  };
}
