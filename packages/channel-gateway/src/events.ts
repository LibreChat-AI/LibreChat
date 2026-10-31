import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelRunAdmission, ChannelReactionEvent } from 'librechat-data-provider';
import type { ChannelBundle } from './types';

const address = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^:\s/\\]+$/);
const timestamp = z.string().regex(/^\d{1,10}\.\d{1,6}$/);
const eventSchema = z.object({
  type: z.string(),
  user: address.optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().max(100000).optional(),
  channel: address.optional(),
  channel_type: z.string().optional(),
  ts: timestamp.optional(),
  thread_ts: timestamp.optional(),
  event_ts: timestamp.optional(),
  reaction: z.string().max(256).optional(),
  item: z.unknown().optional(),
});
const envelopeSchema = z.object({
  type: z.literal('event_callback'),
  event_id: z.string().min(1).max(256),
  team_id: address,
  api_app_id: address,
  event: eventSchema,
});

export type SlackEnvelope = z.infer<typeof envelopeSchema>;
export const SLACK_REQUEST_MAX_BYTES = 1024 * 1024;
export type SlackWebhookRequest =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'event'; envelope: SlackEnvelope }
  | { kind: 'interaction'; payload: unknown };
export type SlackWebhookResult =
  | { ok: true; request: SlackWebhookRequest }
  | {
      ok: false;
      status: 400 | 401 | 413;
      code: 'invalid_signature' | 'invalid_payload' | 'payload_too_large';
    };
export type NormalizedEvent =
  | { kind: 'message'; admission: ChannelRunAdmission }
  | { kind: 'reaction'; reaction: ChannelReactionEvent }
  | {
      kind: 'stop';
      externalChannelId: string;
      actor: ChannelRunAdmission['actor'];
      externalThreadKey: string;
      eventAt: number;
    };

export function eventTimestampUs(value: string): number {
  if (!/^\d{1,10}\.\d{1,6}$/.test(value)) throw new Error('Invalid Slack event timestamp');
  const [seconds, fraction] = value.split('.');
  const result = Number(seconds) * 1000000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error('Invalid Slack event timestamp');
  return result;
}

export function verifySignature(
  body: Buffer,
  signature: string,
  timestamp: string,
  secret: string,
  toleranceSecs: number,
  now = Date.now(),
): boolean {
  if (
    !secret ||
    !/^\d{1,12}$/.test(timestamp) ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    Math.abs(now / 1000 - Number(timestamp)) > toleranceSecs
  )
    return false;
  const digest = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from('v0=' + digest));
}

export function parseEnvelope(body: unknown, bundle: ChannelBundle): SlackEnvelope {
  const envelope = envelopeSchema.parse(body);
  if (
    envelope.team_id !== bundle.channel.slack.teamId ||
    envelope.api_app_id !== bundle.channel.slack.appId
  )
    throw new Error('Slack workspace or application mismatch');
  return envelope;
}

/** Every webhook payload, including installation challenges, must authenticate its original bytes. */
export function parseWebhookRequest(
  body: Buffer,
  headers: { signature?: unknown; timestamp?: unknown; contentType?: unknown },
  bundle: ChannelBundle,
  interactive: boolean,
  now = Date.now(),
): SlackWebhookResult {
  if (body.byteLength > SLACK_REQUEST_MAX_BYTES)
    return { ok: false, status: 413, code: 'payload_too_large' };
  if (
    typeof headers.signature !== 'string' ||
    typeof headers.timestamp !== 'string' ||
    !verifySignature(
      body,
      headers.signature,
      headers.timestamp,
      bundle.credentials.signingSecret ?? '',
      bundle.gateway.signatureToleranceSeconds,
      now,
    )
  )
    return { ok: false, status: 401, code: 'invalid_signature' };
  if (bundle.gateway.transport !== 'webhook')
    return { ok: false, status: 400, code: 'invalid_payload' };
  try {
    if (interactive) {
      if (
        typeof headers.contentType !== 'string' ||
        headers.contentType.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
      )
        return { ok: false, status: 400, code: 'invalid_payload' };
      const form = new URLSearchParams(body.toString());
      if (form.getAll('payload').length !== 1)
        return { ok: false, status: 400, code: 'invalid_payload' };
      const payload: unknown = JSON.parse(form.get('payload') ?? '');
      return { ok: true, request: { kind: 'interaction', payload } };
    }
    const value: unknown = JSON.parse(body.toString());
    const challenge = z
      .object({ type: z.literal('url_verification'), challenge: z.string().min(1).max(2048) })
      .safeParse(value);
    if (challenge.success)
      return { ok: true, request: { kind: 'challenge', challenge: challenge.data.challenge } };
    return { ok: true, request: { kind: 'event', envelope: parseEnvelope(value, bundle) } };
  } catch {
    return { ok: false, status: 400, code: 'invalid_payload' };
  }
}

export function normalizeEvent(
  envelope: SlackEnvelope,
  bundle: ChannelBundle,
): NormalizedEvent | null {
  const event = envelope.event;
  if (!event.user || event.bot_id || event.user === bundle.channel.slack.botUserId) return null;
  const actor = {
    teamId: envelope.team_id,
    appId: envelope.api_app_id,
    externalUserId: event.user,
  };
  if (event.type === 'reaction_added' || event.type === 'reaction_removed') {
    const item = z
      .object({ type: z.literal('message'), channel: address, ts: timestamp })
      .safeParse(event.item);
    if (!item.success || !event.reaction || !event.event_ts) return null;
    return {
      kind: 'reaction',
      reaction: {
        eventId: envelope.event_id,
        eventTimestampUs: eventTimestampUs(event.event_ts),
        externalMessageKey: `${item.data.channel}:${item.data.ts}`,
        externalUserId: event.user,
        reaction: event.reaction,
        action: event.type === 'reaction_added' ? 'added' : 'removed',
      },
    };
  }
  if (event.type === 'agent_session_stopped') {
    if (!event.channel || !event.thread_ts || !event.event_ts)
      throw new Error('Invalid native Stop event');
    return {
      kind: 'stop',
      externalChannelId: event.channel,
      actor,
      externalThreadKey: `${event.channel}:${event.thread_ts}`,
      eventAt: Math.floor(eventTimestampUs(event.event_ts) / 1000),
    };
  }
  if (!event.channel || !event.ts || event.subtype) return null;
  let message = '';
  if (event.type === 'app_mention')
    message = event.text?.split(`<@${bundle.channel.slack.botUserId}>`).join('').trim() ?? '';
  else if (event.type === 'message' && event.channel_type === 'im')
    message = event.text?.trim() ?? '';
  if (!message) return null;
  return {
    kind: 'message',
    admission: {
      eventId: envelope.event_id,
      externalChannelId: event.channel,
      externalThreadKey: `${event.channel}:${event.thread_ts ?? event.ts}`,
      externalMessageKey: `${event.channel}:${event.ts}`,
      actor,
      input: message,
    },
  };
}
