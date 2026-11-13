import { z } from 'zod';
import type { SharedSlackRouteLookup } from 'librechat-data-provider';
import type { SlackWebhookRequest } from '../events';
import { interactionSchema } from '../app';

const reference = z.object({ runId: z.string().min(1).max(256) });
const linkReference = z.object({ linkId: z.string().min(1).max(256) });
const messageItem = z.object({ type: z.literal('message'), channel: z.string(), ts: z.string() });

/** This chooses a lookup only; the bound dispatch still validates the complete actor/action. */
export function slackRouteLookup(
  request: Exclude<SlackWebhookRequest, { kind: 'challenge' }>,
  appId: string,
): SharedSlackRouteLookup | undefined {
  if (request.kind === 'event') {
    const { envelope } = request;
    if (envelope.api_app_id !== appId) throw new Error('Slack app mismatch');
    const event = envelope.event;
    if (!event.user || event.bot_id || event.subtype) return;
    if (['reaction_added', 'reaction_removed'].includes(event.type)) {
      const item = messageItem.safeParse(event.item);
      if (!item.success) return;
      return {
        appId,
        teamId: envelope.team_id,
        target: { kind: 'message', externalMessageKey: `${item.data.channel}:${item.data.ts}` },
      };
    }
    if (
      !(
        event.type === 'app_mention' ||
        (event.type === 'message' && event.channel_type === 'im') ||
        event.type === 'agent_session_stopped'
      )
    )
      return;
    const timestamp =
      event.thread_ts ?? (event.type !== 'agent_session_stopped' ? event.ts : undefined);
    if (!event.channel || !timestamp) throw new Error('Missing Slack thread');
    return {
      appId,
      teamId: envelope.team_id,
      target: {
        kind: 'thread',
        actorId: event.user,
        externalChannelId: event.channel,
        externalThreadKey: `${event.channel}:${timestamp}`,
      },
    };
  }
  const callback = interactionSchema.parse(request.payload);
  if (callback.api_app_id !== appId) throw new Error('Slack app mismatch');
  if (callback.type === 'view_closed') return;
  const root = { appId, teamId: callback.team.id };
  if (callback.type === 'view_submission') {
    const data = reference.parse(JSON.parse(callback.view?.private_metadata ?? ''));
    return { ...root, target: { kind: 'run', runId: data.runId } };
  }
  const action = callback.actions?.[0];
  if (!action) throw new Error('Missing Slack action');
  if (
    [
      'channel_run_open',
      'channel_presentation_link_0',
      'channel_presentation_link_1',
      'channel_presentation_link_2',
    ].includes(action.action_id)
  )
    return;
  if (action.action_id === 'channel_feedback') {
    const channel = callback.container?.channel_id ?? callback.channel?.id;
    if (!channel || !callback.container?.message_ts) throw new Error('Missing feedback message');
    return {
      ...root,
      target: {
        kind: 'message',
        externalMessageKey: `${channel}:${callback.container.message_ts}`,
      },
    };
  }
  if (['channel_link_confirm', 'channel_link_open'].includes(action.action_id)) {
    const data = linkReference.parse(JSON.parse(action.value ?? ''));
    return { ...root, target: { kind: 'link', linkId: data.linkId } };
  }
  if (
    !['channel_run_cancel', 'channel_run_review', 'channel_native_write'].includes(
      action.action_id,
    ) &&
    !action.action_id.startsWith('channel_native_choice_')
  )
    throw new Error('Unsupported Slack action');
  const data = reference.parse(JSON.parse(action.value ?? ''));
  return { ...root, target: { kind: 'run', runId: data.runId } };
}
