import {
  channelSnowflakeSchema,
  discordChannelConfigSchema,
  parseDiscordControl,
} from 'librechat-data-provider';
import type {
  DiscordApplicationSecurity,
  DiscordInboxSubmission,
  DiscordIngressAction,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import type { DiscordInteraction } from './events';
import type { WebhookReply } from '../http';
import type { Logger } from '../types';
import { parseDiscordInteraction, verifyDiscordSignature } from './events';
import { WebhookHTTPServer } from '../http';

/** Namespaced command v1; rejects malformed options instead of silently discarding them. */
export function discordInteractionAction(event: DiscordInteraction): DiscordIngressAction | null {
  if (event.type !== 2 || event.data.name !== 'librechat') return null;
  const options = event.data.options ?? [];
  if (options.length !== 1 || options[0].type !== 1 || options[0].value !== undefined) return null;
  const command = options[0];
  const argumentsList = command.options ?? [];
  if (command.name === 'ask') {
    if (
      argumentsList.length !== 1 ||
      argumentsList[0].name !== 'prompt' ||
      argumentsList[0].type !== 3 ||
      typeof argumentsList[0].value !== 'string'
    )
      return null;
    const prompt = argumentsList[0].value.trim();
    return prompt && prompt.length <= 6000 ? { kind: 'ask', prompt } : null;
  }
  if (argumentsList.length) return null;
  if (command.name === 'link' || command.name === 'status' || command.name === 'cancel')
    return { kind: command.name };
  return null;
}

export interface DiscordWebhookDependencies {
  policy: Pick<
    DiscordChannelConfig,
    'maxBodyBytes' | 'signatureToleranceSeconds' | 'interactionTimeoutMs'
  >;
  capacity: number;
  ready: () => boolean;
  security: (
    applicationId: string,
    signal: AbortSignal,
  ) => Promise<DiscordApplicationSecurity | null>;
  submit: (
    input: DiscordInboxSubmission,
    signal: AbortSignal,
  ) => Promise<'accepted' | 'conflict' | 'capacity'>;
  log: Logger;
  now?: () => number;
}

export function createDiscordWebhook(deps: DiscordWebhookDependencies): WebhookHTTPServer<string> {
  const policy = discordChannelConfigSchema.parse(deps.policy);
  return new WebhookHTTPServer<string>({
    ready: deps.ready,
    capacity: deps.capacity,
    maxBodyBytes: policy.maxBodyBytes,
    deadlineMs: policy.interactionTimeoutMs,
    signatureHeader: 'x-signature-ed25519',
    timestampHeader: 'x-signature-timestamp',
    failureEvent: 'discord_delivery_not_accepted',
    log: deps.log,
    match: (path) => {
      const match = path.match(/^\/discord\/([0-9]{1,20})\/interactions$/);
      return match && channelSnowflakeSchema.safeParse(match[1]).success ? match[1] : undefined;
    },
    dispatch: async (body, headers, applicationId, signal): Promise<WebhookReply> => {
      if (
        typeof headers.signature !== 'string' ||
        typeof headers.timestamp !== 'string' ||
        !/^[a-f0-9]{128}$/i.test(headers.signature) ||
        !/^[0-9]{1,16}$/.test(headers.timestamp)
      )
        return { status: 401, body: { error: 'invalid_signature' } };
      const app = await deps.security(applicationId, signal);
      signal.throwIfAborted();
      if (
        !app ||
        app.applicationId !== applicationId ||
        !verifyDiscordSignature(body, headers.signature, headers.timestamp, {
          publicKey: app.publicKey,
          maxBodyBytes: policy.maxBodyBytes,
          maxAgeMs: policy.signatureToleranceSeconds * 1000,
          now: deps.now?.(),
        })
      )
        return { status: 401, body: { error: 'invalid_signature' } };
      if (
        typeof headers.contentType !== 'string' ||
        headers.contentType.split(';')[0].trim().toLowerCase() !== 'application/json'
      )
        return { status: 400, body: { error: 'invalid_payload' } };
      let event: DiscordInteraction;
      try {
        event = parseDiscordInteraction(body, policy.maxBodyBytes);
      } catch {
        return { status: 400, body: { error: 'invalid_payload' } };
      }
      if (event.type === 1)
        return event.application_id && event.application_id !== applicationId
          ? { status: 400, body: { error: 'application_mismatch' } }
          : { status: 200, body: { type: 1 } };
      if (
        event.application_id !== applicationId ||
        !event.guild_id ||
        event.context !== 0 ||
        event.authorizing_integration_owners?.['0'] !== event.guild_id ||
        !event.channel_id ||
        !event.member?.user ||
        event.member.user.bot ||
        event.user
      )
        return { status: 400, body: { error: 'invalid_context' } };
      let action: DiscordIngressAction | null;
      if (event.type === 3)
        action =
          event.data.component_type === 2
            ? parseDiscordControl(event.data.custom_id, event.message?.id)
            : null;
      else action = discordInteractionAction(event);
      if (!action) return { status: 400, body: { error: 'unsupported_interaction' } };
      signal.throwIfAborted();
      const result = await deps.submit(
        {
          applicationId,
          expectedApplicationRevision: app.applicationRevision,
          guildId: event.guild_id,
          externalChannelId: event.channel_id,
          externalUserId: event.member.user.id,
          eventId: event.id,
          token: event.token,
          action,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result !== 'accepted')
        return {
          status: result === 'capacity' ? 429 : 409,
          body: { error: 'interaction_not_accepted' },
        };
      return { status: 200, body: { type: 5, data: { flags: 64 } } };
    },
  });
}
