import { ChannelRunConflict } from '@librechat/data-schemas';
import {
  discordConfirmationControl,
  discordConfirmationParts,
  discordGuildTextActorUsable,
  discordThreadUsable,
} from 'librechat-data-provider';
import type {
  DiscordInboxFence,
  DiscordNativeAuthority,
  DiscordPrivateReply,
  DiscordChannelExternalIdentity,
  ChannelRunPrincipal,
} from 'librechat-data-provider';
import type {
  AgentChannelMethods,
  ChannelRunStorage,
  DiscordCommandStorage,
  DiscordInboxRecord,
} from '@librechat/data-schemas';
import type { ChannelAuthority } from '../authority';
import { channelExternalIdentity } from '../authority';
import { slackPublicURL } from '../workspaces';

const unavailable = (): DiscordPrivateReply => ({
  content: 'This interaction is no longer available. Run the command again.',
});
const disclosure = 'Agent replies are visible to members of this Discord channel.';
export function createDiscordCommandExecutor(deps: {
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  authority: ChannelAuthority;
  runs: Pick<ChannelRunStorage, 'admit'>;
  commands: DiscordCommandStorage;
  enabled: () => Promise<boolean>;
  publicBaseUrl?: string;
  feedback?: (
    record: DiscordInboxRecord,
    fence: DiscordInboxFence,
    principal: ChannelRunPrincipal,
  ) => Promise<DiscordPrivateReply>;
  now?: () => number;
}): (
  record: DiscordInboxRecord,
  fence: DiscordInboxFence,
  native?: DiscordNativeAuthority,
) => Promise<DiscordPrivateReply> {
  const now = deps.now ?? Date.now;
  const base = deps.publicBaseUrl
    ? slackPublicURL(deps.publicBaseUrl).href.replace(/\/+$/, '') + '/'
    : undefined;
  async function link(
    identity: DiscordChannelExternalIdentity,
    record: DiscordInboxRecord,
    fence: DiscordInboxFence,
  ): Promise<DiscordPrivateReply> {
    const inspected = await deps.authority.identity.inspectActor(identity);
    if (!inspected.ok || inspected.value?.state === 'unavailable') return unavailable();
    if (inspected.value?.state === 'active')
      return {
        content: `Your account is linked. Use /librechat ask to send a new prompt. ${disclosure}`,
      };
    if (inspected.value?.state === 'accepted') {
      const view = inspected.value;
      const label = (view.accountLabel || 'Linked account').replace(/[`\\\r\n]/g, ' ');
      return {
        content: `Confirm that you want to link the LibreChat account \`${label}\`. ${disclosure} After confirmation, send your prompt again.`,
        actions: [
          {
            label: 'Confirm account',
            style: 'primary',
            reference: discordConfirmationControl(view.linkId, view.revision),
          },
        ],
      };
    }
    const issued = await deps.authority.identity.issue(identity, {
      applicationRevision: record.applicationRevision,
      fence,
    });
    if (!issued.ok) return unavailable();
    return {
      content: `Open LibreChat to choose your account, then run /librechat link here to confirm it. ${disclosure} Your prompt will not run automatically.`,
      actions: [{ label: 'Link LibreChat account', url: issued.value.url }],
    };
  }
  return async (record, fence, native) => {
    if (!record.action || !(await deps.enabled())) return unavailable();
    const channel = await deps.channels.getAgentChannelMetadata(record.channelId);
    if (
      !channel ||
      channel.type !== 'discord' ||
      channel.status !== 'active' ||
      (channel.tenantId || '_') !== (record.tenantId || '_') ||
      channel.revision !== record.channelRevision ||
      channel.agentId !== record.agentId ||
      channel.discord.applicationId !== record.applicationId ||
      channel.discord.guildId !== record.guildId ||
      channel.discord.externalChannelId !==
        (record.thread?.parentChannelId ?? record.externalChannelId)
    )
      return unavailable();
    const identity = channelExternalIdentity(channel, record.externalUserId);
    if (identity.provider !== 'discord') return unavailable();
    const action = record.action;
    if (action.kind === 'link') return link(identity, record, fence);
    if (action.kind === 'confirm') {
      const reference = discordConfirmationParts(action.reference);
      if (!reference) return unavailable();
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
          return unavailable();
      }
      return {
        content: `Your account is linked. Send your prompt again with /librechat ask. ${disclosure}`,
      };
    }
    const actor = {
      provider: 'discord' as const,
      applicationId: record.applicationId,
      guildId: record.guildId,
      externalUserId: record.externalUserId,
    };
    const principal = await deps.authority.resolvePrincipal(channel, actor);
    if (!principal) return link(identity, record, fence);
    if (!(await deps.enabled())) return unavailable();
    if (action.kind === 'ask') {
      let usable = false;
      if (native?.kind === 'guild_text')
        usable =
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
        native.source.guildId !== record.guildId ||
        native.source.authorId !== record.externalUserId
      )
        return unavailable();
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
            admission: {
              actor,
              eventId: record.eventId,
              input: action.prompt,
              ...(record.thread
                ? { discordDestination: { kind: 'guild_thread' as const, ...record.thread } }
                : {}),
              externalChannelId: record.externalChannelId,
              externalThreadKey: `${record.externalChannelId}:${record.eventId}`,
              externalMessageKey: `${record.externalChannelId}:${record.eventId}`,
            },
          },
          now(),
        );
      } catch (error) {
        if (error instanceof ChannelRunConflict && error.code === 'invalid_transition')
          return {
            content:
              'This prompt is no longer authorized. Run /librechat link to confirm your account, then send a new /librechat ask.',
          };
        throw error;
      }
      return {
        content: `Your prompt is queued. ${disclosure} Use /librechat status to check progress or /librechat cancel to stop the current run.`,
      };
    }
    const scope = { record, fence, principal };
    if (action.kind === 'cancel') {
      const result = await deps.commands.cancel(scope, now());
      if (!result.ok) return unavailable();
      return {
        content: result.value.cancelled
          ? 'Cancellation requested for your run.'
          : 'There is no active run to cancel in this channel.',
      };
    }
    if (action.kind === 'feedback')
      return deps.feedback ? deps.feedback(record, fence, principal) : unavailable();
    const latest = await deps.commands.latest(scope, now());
    if (!latest.ok) return unavailable();
    if (!latest.value) return { content: 'You have no retained run in this channel.' };
    const run = latest.value;
    const labels = {
      queued: 'queued',
      executing: 'running',
      requires_action: 'waiting for your review in LibreChat',
      delivering: 'sending its answer',
      delivered: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      blocked: 'waiting for delivery reconciliation',
    };
    let path: string | undefined;
    if (run.state === 'requires_action' && run.responseId)
      path = `responses/${encodeURIComponent(run.responseId)}/review`;
    else if (run.conversationId) path = `c/${encodeURIComponent(run.conversationId)}`;
    return {
      content: run.cancellationRequested
        ? 'Cancellation has been requested for your run.'
        : `Your latest run is ${labels[run.state]}.`,
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
    };
  };
}
