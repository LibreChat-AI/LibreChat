import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelBundle, Logger } from './types';
import type { GatewayRuntimeConfig } from './config';
import type { ReviewInteraction } from './review';
import { eventTimestampUs, normalizeEvent, parseEnvelope, parseWebhookRequest } from './events';
import { ServiceError } from './transport';
import { IdentityFlow } from './identity';
import { ChannelClient } from './client';
import { SlackHTTPServer } from './http';
import { ReviewFlow } from './review';
import { SlackClient } from './slack';

const id = z.string().min(1).max(256);
const stateValue = z
  .object({
    value: z.string().nullable().optional(),
    selected_option: z.object({ value: z.string() }).nullable().optional(),
    selected_options: z
      .array(z.object({ value: z.string() }))
      .nullable()
      .optional(),
  })
  .transform((value) => ({
    value: value.value ?? undefined,
    selected_option: value.selected_option ?? undefined,
    selected_options: value.selected_options ?? undefined,
  }));
export const interactionSchema = z.object({
  type: z.enum(['block_actions', 'view_submission', 'view_closed']),
  team: z.object({ id }),
  api_app_id: id,
  user: z.object({ id }),
  channel: z.object({ id }).optional(),
  trigger_id: z.string().optional(),
  response_url: z.string().max(2048).optional(),
  container: z.object({ channel_id: id.optional(), message_ts: z.string().optional() }).optional(),
  message: z.object({ ts: z.string().optional() }).optional(),
  actions: z
    .array(
      z.object({ action_id: id, value: z.string().optional(), action_ts: z.string().optional() }),
    )
    .max(1)
    .optional(),
  view: z
    .object({
      callback_id: z.string(),
      private_metadata: z.string().max(3000),
      state: z
        .object({ values: z.record(z.string(), z.record(z.string(), stateValue)) })
        .optional(),
    })
    .optional(),
});

export class GatewayApp {
  ready = false;
  connected = false;
  private active = 0;
  private readonly ingress: SlackHTTPServer;
  private socketAppId?: string;
  private readonly identity: IdentityFlow;
  private readonly review: ReviewFlow;
  constructor(
    private readonly config: GatewayRuntimeConfig,
    private readonly client: ChannelClient,
    slack: SlackClient,
    private readonly log: Logger,
  ) {
    this.identity = new IdentityFlow(client, slack);
    this.review = new ReviewFlow(client, slack);
    this.ingress = new SlackHTTPServer({
      ready: () =>
        this.ready &&
        (this.config.SLACK_TRANSPORT !== 'socket_mode' ||
          (this.connected && this.socketAppId !== undefined)),
      capacity: 64,
      log,
      match: (path) => {
        const route = path.match(/^\/slack\/(events|interactions)\/([^/]+)\/([^/]+)$/);
        if (
          !route ||
          this.config.SLACK_TRANSPORT !== 'webhook' ||
          route[2] !== encodeURIComponent(this.config.CHANNEL_TENANT_ID) ||
          route[3] !== encodeURIComponent(this.config.CHANNEL_ID)
        )
          return undefined;
        return route[1] === 'interactions';
      },
      dispatch: async (body, headers, interactive, signal) => {
        const bundle = await this.client.channel(signal);
        signal.throwIfAborted();
        this.assertPolicy(bundle);
        const parsed = parseWebhookRequest(body, headers, bundle, interactive);
        if (!parsed.ok) return { status: parsed.status, body: { error: parsed.code } };
        if (parsed.request.kind === 'challenge')
          return { status: 200, body: { challenge: parsed.request.challenge } };
        const payload =
          parsed.request.kind === 'event' ? parsed.request.envelope : parsed.request.payload;
        return {
          status: 200,
          body: (await this.dispatch(payload, interactive, signal, bundle)) ?? {},
        };
      },
    });
  }

  /** No queue before admission: overload is left unacknowledged for Slack redelivery. */
  async dispatch(
    body: unknown,
    interactive: boolean,
    parent?: AbortSignal,
    verifiedBundle?: ChannelBundle,
  ): Promise<object | undefined> {
    if (this.active >= 64) throw new Error('Gateway capacity exhausted');
    this.active++;
    const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(parent ? [parent] : [])]);
    try {
      signal.throwIfAborted();
      const bundle = verifiedBundle ?? (await this.client.channel(signal));
      this.assertPolicy(bundle);
      if (interactive) {
        const callback = interactionSchema.parse(body);
        if (
          callback.team.id !== bundle.channel.slack.teamId ||
          callback.api_app_id !== bundle.channel.slack.appId
        )
          throw new Error('Interaction workspace or app changed');
        const channelId = callback.channel?.id ?? callback.container?.channel_id ?? '';
        if (
          callback.channel?.id &&
          callback.container?.channel_id &&
          callback.channel.id !== callback.container.channel_id
        )
          throw new Error('Interaction channel mismatch');
        const interaction: ReviewInteraction = {
          teamId: callback.team.id,
          appId: callback.api_app_id,
          actorId: callback.user.id,
          channelId,
          triggerId: callback.trigger_id,
          view: callback.view
            ? {
                callbackId: callback.view.callback_id,
                privateMetadata: callback.view.private_metadata,
                values: callback.view.state?.values,
              }
            : undefined,
        };
        if (callback.type === 'view_closed') return;
        if (callback.type === 'view_submission')
          return await this.review.submit(interaction, bundle, signal);
        const action = callback.actions?.[0];
        if (!action) throw new Error('Missing Slack action');
        if (action.action_id === 'channel_feedback') {
          const target = callback.container?.message_ts;
          if (
            !channelId ||
            !target ||
            (callback.message?.ts && callback.message.ts !== target) ||
            !action.action_ts ||
            !['+1', '-1'].includes(action.value ?? '')
          )
            throw new Error('Invalid answer feedback');
          const eventId =
            'slack-feedback:' +
            createHash('sha256')
              .update(
                [
                  callback.team.id,
                  callback.api_app_id,
                  channelId,
                  target,
                  callback.user.id,
                  action.action_ts,
                  action.value,
                ].join(':'),
              )
              .digest('hex');
          await this.reaction(
            {
              eventId,
              eventTimestampUs: eventTimestampUs(action.action_ts),
              externalMessageKey: `${channelId}:${target}`,
              externalUserId: callback.user.id,
              reaction: action.value!,
              action: 'added',
            },
            signal,
          );
        } else if (action.action_id === 'channel_link_open') {
          await this.identity.open(
            callback.user.id,
            action.value ?? '',
            callback.response_url,
            signal,
          );
        } else if (action.action_id === 'channel_link_confirm')
          await this.identity.confirm(
            channelId,
            callback.user.id,
            action.value ?? '',
            bundle,
            signal,
            callback.response_url,
          );
        else if (action.action_id.startsWith('channel_native_choice_'))
          await this.review.choice(action.value ?? '', interaction, bundle, signal);
        else if (
          ['channel_run_cancel', 'channel_run_review', 'channel_native_write'].includes(
            action.action_id,
          )
        )
          await this.review.control(
            action.action_id,
            action.value ?? '',
            interaction,
            bundle,
            signal,
          );
        else if (
          ![
            'channel_link_open',
            'channel_run_open',
            'channel_presentation_link_0',
            'channel_presentation_link_1',
            'channel_presentation_link_2',
          ].includes(action.action_id)
        )
          throw new Error('Unsupported Slack action');
        signal.throwIfAborted();
        return;
      }
      const nativeStop = z
        .object({ event: z.object({ type: z.literal('agent_session_stopped') }) })
        .safeParse(body).success;
      let envelope;
      try {
        envelope = parseEnvelope(body, bundle);
      } catch (error) {
        if (nativeStop)
          this.log.warn(
            error instanceof z.ZodError
              ? 'native_stop_envelope_rejected'
              : 'native_stop_binding_rejected',
          );
        throw error;
      }
      let event;
      try {
        event = normalizeEvent(envelope, bundle);
      } catch (error) {
        if (nativeStop) this.log.warn('native_stop_event_rejected');
        throw error;
      }
      if (envelope.event.type === 'agent_session_stopped' && !event)
        this.log.warn('native_stop_actor_ignored');
      if (!event) return;
      if (event.kind === 'stop') {
        if (event.eventAt > Date.now()) this.log.warn('native_stop_future_timestamp');
        // Emission policy does not revoke cancellation for an already-created native session.
        // The service binds clock-skew normalization to one durable target across retries.
        signal.throwIfAborted();
        try {
          const result = await this.client.stop(
            event.actor,
            event.externalThreadKey,
            event.eventAt,
            event.externalChannelId,
            signal,
          );
          this.log.info(
            result.cancellationRequested ? 'native_stop_requested' : 'native_stop_no_active_run',
          );
        } catch (error) {
          if (!(error instanceof ServiceError && [400, 403].includes(error.status))) throw error;
          this.log.warn(
            error.status === 400 ? 'native_stop_invalid_request' : 'native_stop_forbidden',
          );
          if (error.status === 400) throw error;
        }
      } else if (event.kind === 'reaction') await this.reaction(event.reaction, signal);
      else {
        try {
          const admitted = await this.client.admit(event.admission, signal);
          if (!admitted.runId) throw new Error('Admission not confirmed');
        } catch (error) {
          if (!(error instanceof ServiceError && error.code === 'channel_link_required'))
            throw error;
          await this.identity.prompt(
            event.admission.externalChannelId,
            event.admission.actor.externalUserId,
            bundle,
            signal,
          );
        }
      }
      signal.throwIfAborted();
    } finally {
      this.active--;
    }
  }

  bindSocketApp(appId: string): void {
    if (
      !appId ||
      this.config.SLACK_TRANSPORT !== 'socket_mode' ||
      (this.socketAppId !== undefined && this.socketAppId !== appId)
    ) {
      this.ready = false;
      this.connected = false;
      throw new Error('Socket application binding changed; restart required');
    }
    this.socketAppId = appId;
  }

  private assertPolicy(bundle: ChannelBundle): void {
    if (
      bundle.gateway.transport !== this.config.SLACK_TRANSPORT ||
      (this.config.SLACK_TRANSPORT === 'socket_mode' &&
        bundle.channel.slack.appId !== this.socketAppId)
    ) {
      this.ready = false;
      this.connected = false;
      throw new Error('Gateway ingress policy changed; restart required');
    }
  }

  private async reaction(record: object, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request(this.client.root + '/reactions', record, signal);
    } catch (error) {
      if (!(error instanceof ServiceError && error.status === 404)) throw error;
    }
  }

  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.ingress.http(request, response);
  }
}
