import { z } from 'zod';
import {
  channelSnowflakeSchema,
  discordInboxFenceSchema,
  discordInboxSubmissionSchema,
} from 'librechat-data-provider';
import type { RequestHandler, Response } from 'express';
import type { DiscordInboxService } from './inbox';
import { acceptsChannelServiceToken } from '../service';

/** Every endpoint is internal and includes bearer-token protection, including receipt settlement. */
export function createDiscordInboxHandlers(deps: {
  service: DiscordInboxService;
  serviceToken: () => string | undefined;
}): Record<'submit' | 'claim' | 'finish' | 'defer', RequestHandler> {
  function handle<T>(
    schema: z.ZodType<T>,
    work: (input: T, res: Response) => Promise<void>,
  ): RequestHandler {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken()))
        return void res.sendStatus(401);
      const input = schema.safeParse(req.body);
      if (!input.success)
        return void res.status(400).json({ error: 'invalid_discord_interaction' });
      try {
        await work(input.data, res);
      } catch {
        res.status(503).json({ error: 'discord_interaction_unavailable' });
      }
    };
  }
  return {
    submit: handle(discordInboxSubmissionSchema, async (input, res) => {
      const result = await deps.service.submit(input);
      if (result.ok) res.status(result.value.duplicate ? 200 : 201).json(result);
      else res.status(result.error.code === 'capacity' ? 429 : 409).json(result);
    }),
    claim: handle(
      z
        .object({
          applicationId: channelSnowflakeSchema,
          owner: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[\w-]+$/),
        })
        .strict(),
      async (input, res) => {
        const result = await deps.service.claim(input.applicationId, input.owner);
        if (!result) return void res.status(204).end();
        res.json(result);
      },
    ),
    finish: handle(
      z
        .object({
          fence: discordInboxFenceSchema,
          result: z.enum(['completed', 'expired', 'unavailable']),
        })
        .strict(),
      async (input, res) => {
        res.status((await deps.service.finish(input.fence, input.result)) ? 204 : 409).end();
      },
    ),
    defer: handle(
      z.object({ fence: discordInboxFenceSchema, retryAt: z.number().int().positive() }).strict(),
      async (input, res) => {
        res.status((await deps.service.defer(input.fence, input.retryAt)) ? 204 : 409).end();
      },
    ),
  };
}
