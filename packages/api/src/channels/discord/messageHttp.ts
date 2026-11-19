import { discordMessageSubmissionSchema } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { DiscordMessageService } from './messages';
import type { DiscordObserver } from './observe';
import { safeDiscordObserver, observeDiscordMessage } from './observe';
import { acceptsChannelServiceToken } from '../service';

/** Mount POST /api/channels/discord/service/messages behind the deployment service credential. */
export function createDiscordMessageHandlers(deps: {
  service: DiscordMessageService;
  serviceToken: () => string | undefined;
  observe?: DiscordObserver;
}): Record<'submit', RequestHandler> {
  const observe = safeDiscordObserver(deps.observe);
  return {
    submit: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken()))
        return void res.sendStatus(401);
      const input = discordMessageSubmissionSchema.safeParse(req.body);
      if (!input.success) return void res.status(400).json({ error: 'invalid_discord_message' });
      try {
        const result = await deps.service.submit(input.data);
        observeDiscordMessage(observe, 'guild', result);
        if (!result.ok)
          return void res
            .status(result.error.code === 'invalid_input' ? 400 : 409)
            .json({ error: result.error.code });
        res.json(result.value);
      } catch {
        observe({ type: 'message', kind: 'guild', result: 'unavailable' });
        res.status(503).json({ error: 'discord_message_unavailable' });
      }
    },
  };
}
