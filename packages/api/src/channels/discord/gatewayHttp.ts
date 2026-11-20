import { z } from 'zod';
import {
  discordGatewayOwnerSchema,
  discordCredentialStateSchema,
  discordCredentialSequenceSchema,
  discordGatewayBatchSchema,
  discordChannelConfigSchema,
  discordGuildRemovalTargetSchema,
  channelSnowflakeSchema,
} from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { DiscordGatewayService } from './gateway';
import { acceptsChannelServiceToken } from '../service';

/** Mount these POST handlers under /api/channels/discord/service/gateway. */
export function createDiscordGatewayHandlers(deps: {
  service: DiscordGatewayService;
  serviceToken: () => string | undefined;
}): Record<
  | 'acquire'
  | 'renew'
  | 'release'
  | 'bootstrap'
  | 'load'
  | 'save'
  | 'observeCredentials'
  | 'prepareGuildRemoval'
  | 'removeGuild',
  RequestHandler
> {
  const ownerSchema = z.object({ owner: discordGatewayOwnerSchema }).strict();
  const leaseSchema = ownerSchema.extend({
    leaseMs: discordChannelConfigSchema.shape.gateway
      .unwrap()
      .shape.ownershipLeaseMs.removeDefault(),
  });
  const saveSchema = ownerSchema.extend({ batch: discordGatewayBatchSchema });
  function handle<T>(
    schema: z.ZodType<T>,
    work: (input: T) => Promise<boolean | object | null>,
  ): RequestHandler {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (!acceptsChannelServiceToken(req.get('authorization'), deps.serviceToken()))
        return void res.sendStatus(401);
      const input = schema.safeParse(req.body);
      if (!input.success) return void res.status(400).json({ error: 'invalid_discord_gateway' });
      try {
        const result = await work(input.data);
        if (result === null || result === false)
          return void res.status(409).json({ error: 'discord_gateway_unavailable' });
        if (result === true) return void res.status(204).end();
        res.json(result);
      } catch {
        res.status(503).json({ error: 'discord_gateway_unavailable' });
      }
    };
  }
  return {
    observeCredentials: handle(
      ownerSchema.extend({
        state: discordCredentialStateSchema,
        sequence: discordCredentialSequenceSchema,
      }),
      ({ owner, state, sequence }) => deps.service.observeCredentials(owner, state, sequence),
    ),
    prepareGuildRemoval: handle(
      ownerSchema.extend({ guildId: channelSnowflakeSchema }),
      ({ owner, guildId }) => deps.service.prepareGuildRemoval(owner, guildId),
    ),
    removeGuild: handle(
      ownerSchema.extend({ target: discordGuildRemovalTargetSchema }),
      ({ owner, target }) => deps.service.removeGuild(owner, target),
    ),
    acquire: handle(leaseSchema, ({ owner, leaseMs }) => deps.service.acquire(owner, leaseMs)),
    renew: handle(leaseSchema, ({ owner, leaseMs }) => deps.service.renew(owner, leaseMs)),
    release: handle(ownerSchema, ({ owner }) => deps.service.release(owner)),
    bootstrap: handle(ownerSchema, ({ owner }) => deps.service.bootstrap(owner)),
    load: handle(ownerSchema, ({ owner }) => deps.service.load(owner)),
    save: handle(saveSchema, ({ owner, batch }) => deps.service.save(owner, batch)),
  };
}
