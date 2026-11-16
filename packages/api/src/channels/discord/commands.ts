import { discordCommandAdmission, ChannelRunConflict } from '@librechat/data-schemas';
import {
  discordConfirmationControl,
  discordConfirmationParts,
  discordGuildTextActorUsable,
  discordThreadUsable,
} from 'librechat-data-provider';
import type {
  AgentChannelMethods,
  ChannelRunStorage,
  DiscordCommandStorage,
  DiscordInboxRecord,
  DiscordCommandScope,
  AgentChannelRecord,
} from '@librechat/data-schemas';
import type {
  DiscordInboxFence,
  DiscordNativeAuthority,
  DiscordPrivateReply,
  DiscordChannelExternalIdentity,
  ChannelRunPrincipal,
} from 'librechat-data-provider';
import type { DiscordObserver, DiscordCommandOutcome } from './observe';
import type { ChannelAuthority } from '../authority';
import { channelExternalIdentity } from '../authority';
import { safeDiscordObserver } from './observe';
import { slackPublicURL } from '../workspaces';

const disclosure = 'Agent replies are visible to members of this Discord channel.';
export function createDiscordCommandExecutor(deps: {
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  authority: ChannelAuthority;
  runs: Pick<ChannelRunStorage, 'admit'>;
  commands: DiscordCommandStorage;
  enabled: () => Promise<boolean>;
  dmEnabled?: () => Promise<boolean>;
  publicBaseUrl?: string;
  feedback?: (
    record: DiscordInboxRecord,
    fence: DiscordInboxFence,
    principal: ChannelRunPrincipal,
  ) => Promise<DiscordPrivateReply>;
  review?: (
    scope: DiscordCommandScope,
    channel: AgentChannelRecord,
    runId?: string,
  ) => Promise<DiscordPrivateReply>;
  now?: () => number;
  observe?: DiscordObserver;
}): (
  record: DiscordInboxRecord,
  fence: DiscordInboxFence,
  native?: DiscordNativeAuthority,
) => Promise<DiscordPrivateReply> {
  const now = deps.now ?? Date.now;
  const observe = safeDiscordObserver(deps.observe);
  function reply(
    record: DiscordInboxRecord,
    outcome: DiscordCommandOutcome,
    value: DiscordPrivateReply,
  ) {
    observe({ type: 'command', action: record.action?.kind ?? 'other', outcome });
    return value;
  }
  const unavailable = (record: DiscordInboxRecord) =>
    reply(record, 'unavailable', {
      content: 'This interaction is no longer available. Run the command again.',
    });
  const base = deps.publicBaseUrl
    ? slackPublicURL(deps.publicBaseUrl).href.replace(/\/+$/, '') + '/'
    : undefined;
  async function link(
    identity: DiscordChannelExternalIdentity,
    record: DiscordInboxRecord,
    fence: DiscordInboxFence,
  ): Promise<DiscordPrivateReply> {
    const inspected = await deps.authority.identity.inspectActor(identity);
    if (!inspected.ok || inspected.value?.state === 'unavailable') return unavailable(record);
    if (inspected.value?.state === 'active')
      return reply(record, 'already_linked', {
        content: `Your account is linked. Use /librechat ask to send a new prompt. ${disclosure}`,
      });
    if (inspected.value?.state === 'accepted') {
      const view = inspected.value;
      const label = (view.accountLabel || 'Linked account').replace(/[`\\\r\n]/g, ' ');
      return reply(record, 'confirm_required', {
        content: `Confirm that you want to link the LibreChat account \`${label}\`. ${disclosure} After confirmation, send your prompt again.`,
        actions: [
          {
            label: 'Confirm account',
            style: 'primary',
            reference: discordConfirmationControl(view.linkId, view.revision),
          },
        ],
      });
    }
    const issued = await deps.authority.identity.issue(identity, {
      applicationRevision: record.applicationRevision,
      fence,
    });
    if (!issued.ok) return unavailable(record);
    return reply(record, 'link_required', {
      content: `Open LibreChat to choose your account, then run /librechat link here to confirm it. ${disclosure} Your prompt will not run automatically.`,
      actions: [{ label: 'Link LibreChat account', url: issued.value.url }],
    });
  }
  async function execute(
    record: DiscordInboxRecord,
    fence: DiscordInboxFence,
    native?: DiscordNativeAuthority,
  ): Promise<DiscordPrivateReply> {
    if (!record.action || !(await deps.enabled())) return unavailable(record);
    const channel = await deps.channels.getAgentChannelMetadata(record.channelId);
    if (
      !channel ||
      channel.type !== 'discord' ||
      channel.status !== 'active' ||
      (channel.tenantId || '_') !== (record.tenantId || '_') ||
      channel.revision !== record.channelRevision ||
      channel.agentId !== record.agentId ||
      channel.discord.applicationId !== record.applicationId ||
      channel.discord.guildId !== (record.dm?.source.guildId ?? record.guildId) ||
      channel.discord.externalChannelId !==
        (record.dm?.parentChannelId ?? record.thread?.parentChannelId ?? record.externalChannelId)
    )
      return unavailable(record);
    const identity = channelExternalIdentity(channel, record.externalUserId);
    if (identity.provider !== 'discord') return unavailable(record);
    const action = record.action;
    if (record.dm && ['link', 'confirm'].includes(action.kind)) return unavailable(record);
    if (action.kind === 'link') return link(identity, record, fence);
    if (action.kind === 'confirm') {
      const reference = discordConfirmationParts(action.reference);
      if (!reference) return unavailable(record);
      const confirmed = await deps.authority.identity.confirm(
        identity,
        reference.linkId,
        reference.revision,
        { applicationRevision: record.applicationRevision, fence },
      );
      if (!confirmed.ok) {
        const current = await deps.authority.identity.inspectActor(identity);
        if (
          !current.ok ||
          current.value?.state !== 'active' ||
          current.value.linkId !== reference.linkId
        )
          return unavailable(record);
      }
      return reply(record, 'linked', {
        content: `Your account is linked. Send your prompt again with /librechat ask. ${disclosure}`,
      });
    }
    const admission = discordCommandAdmission(
      record,
      action.kind === 'ask' ? action.prompt : 'control',
    );
    if (!admission) return unavailable(record);
    const principal = await deps.authority.resolvePrincipal(channel, admission.actor, admission);
    if (!principal)
      return record.dm || action.kind === 'review' || action.kind === 'decide'
        ? unavailable(record)
        : link(identity, record, fence);
    if (!(await deps.enabled())) return unavailable(record);
    if (['ask', 'status', 'review', 'decide'].includes(action.kind)) {
      if (action.kind === 'ask' && record.dm && !(await deps.dmEnabled?.()))
        return unavailable(record);
      let usable = false;
      if (native?.kind === 'dm')
        usable = Boolean(
          record.dm &&
            native.source.channelId === record.dm.parentChannelId &&
            discordGuildTextActorUsable(native.source),
        );
      if (native?.kind === 'guild_text')
        usable =
          !record.dm &&
          !record.thread &&
          native.source.channelId === record.externalChannelId &&
          discordGuildTextActorUsable(native.source);
      if (native?.kind === 'guild_thread')
        usable = Boolean(
          record.thread &&
            native.source.threadChannelId === record.externalChannelId &&
            native.source.parentChannelId === record.thread.parentChannelId &&
            discordThreadUsable(native.source),
        );
      if (
        !native ||
        !usable ||
        native.owner.applicationId !== record.applicationId ||
        native.owner.applicationRevision !== record.applicationRevision ||
        native.source.applicationId !== record.applicationId ||
        native.source.botUserId !== channel.discord.botUserId ||
        native.source.guildId !== (record.dm?.source.guildId ?? record.guildId) ||
        native.source.authorId !== record.externalUserId
      )
        return unavailable(record);
    }
    if (action.kind === 'ask') {
      if (!native) return unavailable(record);
      try {
        await deps.runs.admit(
          {
            tenantId: record.tenantId || '_',
            channelId: channel.channelId,
            agentId: channel.agentId,
            applicationRevision: record.applicationRevision,
            discordInbox: fence,
            discordAuthority: native,
            principal,
            admission,
          },
          now(),
        );
      } catch (error) {
        if (error instanceof ChannelRunConflict && error.code === 'invalid_transition')
          return reply(record, 'conflict', {
            content: record.dm
              ? 'This prompt is no longer authorized. Reconnect your server account and choose this agent in LibreChat again, then send a new /librechat ask.'
              : 'This prompt is no longer authorized. Run /librechat link to confirm your account, then send a new /librechat ask.',
          });
        throw error;
      }
      return reply(record, 'queued', {
        content: `Your request is queued. ${record.dm ? 'Replies are sent to this private DM.' : disclosure} Use /librechat status to check progress or /librechat cancel to stop the current request.`,
      });
    }
    const scope = { record, fence, principal };
    if (action.kind === 'review' || action.kind === 'decide')
      return deps.review
        ? reply(record, 'reported', await deps.review(scope, channel))
        : unavailable(record);
    if (action.kind === 'cancel') {
      const result = await deps.commands.cancel(scope, now());
      if (!result.ok) return unavailable(record);
      return reply(record, result.value.cancelled ? 'cancelled' : 'no_active_run', {
        content: result.value.cancelled
          ? 'Stop requested. Waiting for the agent to confirm.'
          : 'There is no active request to stop here.',
      });
    }
    if (action.kind === 'feedback')
      return deps.feedback
        ? reply(record, 'feedback_reply', await deps.feedback(record, fence, principal))
        : unavailable(record);
    const latest = await deps.commands.latest(scope, now());
    if (!latest.ok) return unavailable(record);
    if (!latest.value)
      return reply(record, 'no_retained_run', {
        content: 'You have no recent requests here.',
      });
    const run = latest.value;
    if (run.state === 'requires_action' && deps.review)
      return reply(record, 'reported', await deps.review(scope, channel, run.runId));
    const labels = {
      queued: 'queued',
      executing: 'running',
      requires_action: 'waiting for your review',
      delivering: 'sending its answer',
      delivered: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      blocked: 'waiting for delivery confirmation',
    };
    let path: string | undefined;
    if (run.state === 'requires_action' && run.responseId)
      path = `responses/${encodeURIComponent(run.responseId)}/review`;
    else if (run.conversationId) path = `c/${encodeURIComponent(run.conversationId)}`;
    return reply(record, 'reported', {
      content: run.cancellationRequested
        ? 'Stop requested. Waiting for the agent to confirm.'
        : `Your latest request is ${labels[run.state]}.`,
      ...(base && path
        ? {
            actions: [
              {
                label:
                  run.state === 'requires_action' ? 'Review in LibreChat' : 'Open in LibreChat',
                url: new URL(path, base).href,
              },
            ],
          }
        : {}),
    });
  }
  return async (record, fence, native) => {
    try {
      return await execute(record, fence, native);
    } catch (error) {
      observe({
        type: 'command',
        action: record.action?.kind ?? 'other',
        outcome: error instanceof ChannelRunConflict ? 'conflict' : 'unavailable',
      });
      throw error;
    }
  };
}
