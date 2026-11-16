import { createHash } from 'node:crypto';
import {
  channelSnowflakeSchema,
  discordChannelConfigSchema,
  parseDiscordControl,
  discordDmCodeSchema,
  discordDmConsumeSchema,
} from 'librechat-data-provider';
import type {
  DiscordApplicationSecurity,
  DiscordInboxSubmission,
  DiscordDmInboxSubmission,
  DiscordIngressAction,
  DiscordChannelConfig,
  DiscordDmConsume,
} from 'librechat-data-provider';
import type { DiscordIngressOutcome, DiscordObserver } from './observe';
import type { DiscordInteraction } from './events';
import type { WebhookReply } from '../http';
import type { Logger } from '../types';
import { parseDiscordInteraction, verifyDiscordSignature } from './events';
import { safeDiscordObserver } from './observe';
import { WebhookHTTPServer } from '../http';

/** Every reply names how the request ended, so the closed vocabulary is checked at compile time. */
type DiscordReply = WebhookReply<DiscordIngressOutcome> & { outcome: DiscordIngressOutcome };

/** Command parsing is shared; BOT_DM authorization and metadata-only selection remain separate. */
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

/** Update only a Discord-signed private decision card; public review entry always creates a private reply. */
function privateAcknowledgement(event: DiscordInteraction, action: DiscordIngressAction) {
  if (event.type === 3 && action.kind === 'decide' && ((event.message?.flags ?? 0) & 64) === 64)
    return { type: 6 };
  return { type: 5, data: { flags: 64 } };
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
  /** Staged separately until DM controls and feedback composition are complete. */
  submitDm?: (
    input: DiscordDmInboxSubmission,
    signal: AbortSignal,
  ) => Promise<'accepted' | 'conflict' | 'capacity'>;
  select?: (
    input: DiscordDmConsume,
    signal: AbortSignal,
  ) => Promise<'accepted' | 'conflict' | 'capacity'>;
  log: Logger;
  now?: () => number;
  /** Optional telemetry for ingress outcomes and acknowledgement time. It never changes a response. */
  observe?: DiscordObserver;
}

export function createDiscordWebhook(
  deps: DiscordWebhookDependencies,
): WebhookHTTPServer<string, DiscordIngressOutcome> {
  const policy = discordChannelConfigSchema.parse(deps.policy);
  const observe = safeDiscordObserver(deps.observe);
  return new WebhookHTTPServer<string, DiscordIngressOutcome>({
    ready: deps.ready,
    capacity: deps.capacity,
    maxBodyBytes: policy.maxBodyBytes,
    deadlineMs: policy.interactionTimeoutMs,
    signatureHeader: 'x-signature-ed25519',
    timestampHeader: 'x-signature-timestamp',
    failureEvent: 'discord_delivery_not_accepted',
    log: deps.log,
    observe: ({ outcome, ackMs }) => {
      observe({ type: 'ingress', outcome });
      if (ackMs !== undefined) observe({ type: 'ack', durationMs: ackMs });
    },
    match: (path) => {
      const match = path.match(/^\/discord\/([0-9]{1,20})\/interactions$/);
      return match && channelSnowflakeSchema.safeParse(match[1]).success ? match[1] : undefined;
    },
    dispatch: async (body, headers, applicationId, signal): Promise<DiscordReply> => {
      if (
        typeof headers.signature !== 'string' ||
        typeof headers.timestamp !== 'string' ||
        !/^[a-f0-9]{128}$/i.test(headers.signature) ||
        !/^[0-9]{1,16}$/.test(headers.timestamp)
      )
        return { status: 401, body: { error: 'invalid_signature' }, outcome: 'bad_signature' };
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
        return { status: 401, body: { error: 'invalid_signature' }, outcome: 'bad_signature' };
      if (
        typeof headers.contentType !== 'string' ||
        headers.contentType.split(';')[0].trim().toLowerCase() !== 'application/json'
      )
        return { status: 400, body: { error: 'invalid_payload' }, outcome: 'bad_payload' };
      let event: DiscordInteraction;
      try {
        event = parseDiscordInteraction(body, policy.maxBodyBytes);
      } catch {
        return { status: 400, body: { error: 'invalid_payload' }, outcome: 'bad_payload' };
      }
      if (event.type === 1)
        return event.application_id && event.application_id !== applicationId
          ? { status: 400, body: { error: 'application_mismatch' }, outcome: 'bad_context' }
          : { status: 200, body: { type: 1 }, outcome: 'ping' };
      if (event.context === 1) {
        if (
          event.application_id !== applicationId ||
          event.guild_id ||
          event.guild ||
          event.member ||
          !event.user ||
          event.user.bot ||
          !event.channel_id ||
          (event.channel?.id !== undefined && event.channel.id !== event.channel_id) ||
          (event.channel?.type !== undefined && event.channel.type !== 1) ||
          event.authorizing_integration_owners?.['0'] !== '0' ||
          event.authorizing_integration_owners?.['1'] !== undefined
        )
          return { status: 400, body: { error: 'invalid_context' }, outcome: 'bad_context' };
        const action =
          event.type === 3 && event.data.component_type === 2
            ? parseDiscordControl(event.data.custom_id, event.message?.id)
            : discordInteractionAction(event);
        if (
          action &&
          ['ask', 'status', 'cancel', 'feedback', 'review', 'decide'].includes(action.kind)
        ) {
          if (!deps.submitDm)
            return {
              status: 400,
              body: { error: 'unsupported_interaction' },
              outcome: 'unsupported',
            };
          const result = await deps.submitDm(
            {
              scope: 'dm',
              applicationId,
              expectedApplicationRevision: app.applicationRevision,
              externalUserId: event.user.id,
              externalChannelId: event.channel_id,
              eventId: event.id,
              token: event.token,
              action,
            },
            signal,
          );
          signal.throwIfAborted();
          return result === 'accepted'
            ? { status: 200, body: privateAcknowledgement(event, action), outcome: result }
            : {
                status: result === 'capacity' ? 429 : 409,
                body: { error: 'interaction_not_accepted' },
                outcome: result,
              };
        }
        if (!deps.select || event.type !== 2 || event.data.name !== 'librechat')
          return {
            status: 400,
            body: { error: 'unsupported_interaction' },
            outcome: 'unsupported',
          };
        const options = event.data.options ?? [];
        const command = options[0];
        const argument = command?.options?.[0];
        const code = discordDmCodeSchema.safeParse(argument?.value);
        if (
          options.length !== 1 ||
          command.name !== 'select' ||
          command.type !== 1 ||
          command.value !== undefined ||
          command.options?.length !== 1 ||
          argument?.name !== 'code' ||
          argument.type !== 3 ||
          !code.success
        )
          return {
            status: 400,
            body: { error: 'unsupported_interaction' },
            outcome: 'unsupported',
          };
        const input = discordDmConsumeSchema.safeParse({
          applicationId,
          applicationRevision: app.applicationRevision,
          externalUserId: event.user.id,
          dmChannelId: event.channel_id,
          confirmationEventId: event.id,
          codeHash: createHash('sha256').update(code.data).digest('hex'),
        });
        if (!input.success)
          return { status: 400, body: { error: 'invalid_payload' }, outcome: 'bad_payload' };
        const result = await deps.select(input.data, signal);
        signal.throwIfAborted();
        const messages = {
          accepted: 'Your private agent selection is saved. Manage or revoke it in LibreChat.',
          capacity: 'Private selection is temporarily unavailable. Try again later.',
          conflict: 'That selection code is unavailable. Generate a new code in LibreChat.',
        };
        return {
          status: 200,
          body: {
            type: 4,
            data: {
              flags: 64,
              content: messages[result],
              allowed_mentions: { parse: [] },
            },
          },
          outcome: result,
        };
      }
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
        return { status: 400, body: { error: 'invalid_context' }, outcome: 'bad_context' };
      let action: DiscordIngressAction | null;
      if (event.type === 3)
        action =
          event.data.component_type === 2
            ? parseDiscordControl(event.data.custom_id, event.message?.id)
            : null;
      else action = discordInteractionAction(event);
      if (!action)
        return { status: 400, body: { error: 'unsupported_interaction' }, outcome: 'unsupported' };
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
          outcome: result,
        };
      return { status: 200, body: privateAcknowledgement(event, action), outcome: 'accepted' };
    },
  });
}
