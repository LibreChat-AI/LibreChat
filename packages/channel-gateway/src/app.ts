import { z } from 'zod';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelBundle, Logger } from './types';
import type { ReviewInteraction } from './review';
import type { GatewayConfig } from './config';
import { eventTimestampUs, normalizeEvent, parseEnvelope, verifySignature } from './events';
import { ChannelClient, ServiceError } from './client';
import { IdentityFlow } from './identity';
import { ReviewFlow } from './review';
import { SlackClient } from './slack';

const maxBody = 1024 * 1024;
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
const interactionSchema = z.object({
  type: z.enum(['block_actions', 'view_submission', 'view_closed']),
  team: z.object({ id }),
  api_app_id: id,
  user: z.object({ id }),
  channel: z.object({ id }).optional(),
  trigger_id: z.string().optional(),
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
  private httpActive = 0;
  private readonly identity: IdentityFlow;
  private readonly review: ReviewFlow;
  constructor(
    private readonly config: GatewayConfig,
    private readonly client: ChannelClient,
    slack: SlackClient,
    private readonly log: Logger,
  ) {
    this.identity = new IdentityFlow(client, slack);
    this.review = new ReviewFlow(client, slack, config.APP_TITLE);
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
      const bundle = verifiedBundle ?? (await this.client.channel(signal));
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
          return this.review.submit(interaction, bundle, signal);
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
        } else if (action.action_id === 'channel_link_confirm')
          await this.identity.confirm(
            channelId,
            callback.user.id,
            action.value ?? '',
            bundle,
            signal,
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
        else if (!['channel_link_open', 'channel_run_open'].includes(action.action_id))
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
        if (this.config.SLACK_NATIVE_SESSIONS) {
          // Preserve Slack's occurrence time: substituting receipt time could stop later work.
          while (event.eventAt > Date.now()) {
            const wait = event.eventAt - Date.now();
            if (wait >= 2000)
              throw new Error('Native Stop timestamp exceeds acknowledgement window');
            await delay(wait, undefined, { signal });
          }
          signal.throwIfAborted();
          try {
            const result = await this.client.stop(
              event.actor,
              event.externalThreadKey,
              event.eventAt,
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
        } else this.log.warn('native_stop_disabled');
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

  private async reaction(record: object, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request(this.client.root + '/reactions', record, signal);
    } catch (error) {
      if (!(error instanceof ServiceError && error.status === 404)) throw error;
    }
  }

  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url?.split('?')[0];
    const send = (status: number, body: object) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && path === '/readyz') {
      send(200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && path === '/healthz') {
      const ready = this.ready && (this.config.SLACK_TRANSPORT !== 'socket_mode' || this.connected);
      send(ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
      return;
    }
    const route = path?.match(/^\/slack\/(events|interactions)\/([^/]+)\/([^/]+)$/);
    if (
      !route ||
      request.method !== 'POST' ||
      this.config.SLACK_TRANSPORT !== 'webhook' ||
      route[2] !== encodeURIComponent(this.config.CHANNEL_TENANT_ID) ||
      route[3] !== encodeURIComponent(this.config.CHANNEL_ID)
    ) {
      send(404, { error: 'not_found' });
      return;
    }
    if (this.httpActive >= 64) {
      send(503, { error: 'capacity_exhausted' });
      return;
    }
    this.httpActive++;
    const controller = new AbortController();
    const stopReading = () => {
      if (!request.complete) request.destroy();
    };
    controller.signal.addEventListener('abort', stopReading, { once: true });
    const timeout = setTimeout(() => controller.abort(), 2000);
    request.on('aborted', () => controller.abort());
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBody) {
          send(413, { error: 'payload_too_large' });
          return;
        }
        chunks.push(bytes);
        controller.signal.throwIfAborted();
      }
      const body = Buffer.concat(chunks);
      const interactive = route[1] === 'interactions';
      if (!interactive) {
        const challenge = z
          .object({ type: z.literal('url_verification'), challenge: z.string().max(2048) })
          .safeParse(JSON.parse(body.toString()));
        if (challenge.success) {
          send(200, { challenge: challenge.data.challenge });
          return;
        }
      }
      const bundle = await this.client.channel(controller.signal);
      const signature = request.headers['x-slack-signature'];
      const timestamp = request.headers['x-slack-request-timestamp'];
      if (
        typeof signature !== 'string' ||
        typeof timestamp !== 'string' ||
        !verifySignature(
          body,
          signature,
          timestamp,
          bundle.credentials.signingSecret ?? '',
          this.config.SLACK_SIGNATURE_TOLERANCE_SECS,
        )
      ) {
        send(401, { error: 'invalid_signature' });
        return;
      }
      let payload: unknown;
      if (interactive) {
        if (
          request.headers['content-type']?.split(';')[0].trim() !==
          'application/x-www-form-urlencoded'
        ) {
          send(400, { error: 'invalid_interaction' });
          return;
        }
        const form = new URLSearchParams(body.toString());
        if (form.getAll('payload').length !== 1) throw new Error('Invalid Slack payload');
        payload = JSON.parse(form.get('payload') ?? '');
      } else payload = JSON.parse(body.toString());
      const ack = await this.dispatch(payload, interactive, controller.signal, bundle);
      controller.signal.throwIfAborted();
      send(200, ack ?? {});
    } catch {
      this.log.warn('slack_delivery_not_accepted');
      if (!response.headersSent) send(503, { error: 'delivery_not_accepted' });
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', stopReading);
      this.httpActive--;
    }
  }
}
