import { z } from 'zod';
import { discordRuntimeCursorSchema } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { DiscordRuntimeService } from './discovery';
import { acceptsChannelServiceToken } from '../service';

/** Mount GET handlers under /api/channels/discord/service/runtime. */
export function createDiscordRuntimeHandlers(deps: {
  service: DiscordRuntimeService;
  serviceToken: () => string | undefined;
}): Record<'bootstrap' | 'applications' | 'channels', RequestHandler> {
  const query = z.object({ cursor: discordRuntimeCursorSchema.optional() }).strict();
  const handle =
    (method: keyof DiscordRuntimeService): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken()))
        return void res.sendStatus(401);
      const parsed = (method === 'bootstrap' ? z.object({}).strict() : query).safeParse(req.query);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_discord_discovery' });
      try {
        res.json(
          method === 'bootstrap'
            ? await deps.service.bootstrap()
            : await deps.service[method]('cursor' in parsed.data ? parsed.data.cursor : undefined),
        );
      } catch {
        res.status(503).json({ error: 'discord_discovery_unavailable' });
      }
    };
  return {
    bootstrap: handle('bootstrap'),
    applications: handle('applications'),
    channels: handle('channels'),
  };
}
