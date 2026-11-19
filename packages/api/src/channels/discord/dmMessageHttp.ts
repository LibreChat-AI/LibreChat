import {
  discordDmMessagePrepareSchema,
  discordDmMessageSubmissionSchema,
} from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { z } from 'zod';
import type { DiscordMessageServiceResult } from './messages';
import type { DiscordDmMessageService } from './dmMessages';
import type { DiscordObserver } from './observe';
import { safeDiscordObserver, observeDiscordMessage } from './observe';
import { acceptsChannelServiceToken } from '../service';

/** Protected POST /service/dm/prepare and /service/dm/message, never browser capabilities. */
export function createDiscordDmMessageHandlers(deps: {
  service: DiscordDmMessageService;
  serviceToken: () => string | undefined;
  observe?: DiscordObserver;
}): Record<'prepare' | 'submit', RequestHandler> {
  const observe = safeDiscordObserver(deps.observe);
  function handler<T>(
    schema: z.ZodType<T>,
    action: (input: T) => Promise<DiscordMessageServiceResult<unknown>>,
  ): RequestHandler {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken()))
        return void res.sendStatus(401);
      const input = schema.safeParse(req.body);
      if (!input.success) return void res.status(400).json({ error: 'invalid_discord_dm_message' });
      try {
        const result = await action(input.data);
        if (!result.ok)
          return void res
            .status(result.error.code === 'invalid_input' ? 400 : 409)
            .json({ error: result.error.code });
        res.json(result.value);
      } catch {
        res.status(503).json({ error: 'discord_dm_message_unavailable' });
      }
    };
  }
  return {
    prepare: handler(discordDmMessagePrepareSchema, (input) => deps.service.prepare(input)),
    submit: handler(discordDmMessageSubmissionSchema, async (input) => {
      try {
        const result = await deps.service.submit(input);
        observeDiscordMessage(observe, 'dm', result);
        return result;
      } catch (error) {
        observe({ type: 'message', kind: 'dm', result: 'unavailable' });
        throw error;
      }
    }),
  };
}
