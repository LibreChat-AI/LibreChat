import { z } from 'zod';
import type { ChannelLinkView, ChannelLinkTicket } from 'librechat-data-provider';
import type { SlackClient, SlackBlocks } from './slack';
import type { ChannelClient } from './client';
import type { ChannelBundle } from './types';

const confirmationSchema = z
  .object({ linkId: z.string().min(1), revision: z.string().min(1) })
  .strict();

export function safePrivateURL(raw: string): boolean {
  if (raw.length > 2048 || /[<>|\p{Cc}\p{Cf}]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export function safeIdentityTicket(ticket: ChannelLinkTicket, now = Date.now()): boolean {
  try {
    const url = new URL(ticket.url);
    if (
      ticket.expiresAtMs <= now ||
      url.search ||
      !url.pathname.endsWith('/channels/link') ||
      !/^#[A-Za-z0-9_-]{43}$/.test(url.hash)
    )
      return false;
    url.hash = '';
    return safePrivateURL(url.toString());
  } catch {
    return false;
  }
}

export function validActorView(
  view: ChannelLinkView | null,
  tenantId: string,
  actorId: string,
  bundle: ChannelBundle,
  now = Date.now(),
): view is ChannelLinkView {
  if (!view) return false;
  const identity = view.identity;
  return (
    identity?.tenantId === tenantId &&
    identity.channelId === bundle.channel.channelId &&
    identity.teamId === bundle.channel.slack.teamId &&
    identity.externalUserId === actorId &&
    identity.agentId === bundle.agent.id &&
    identity.channelRevision === bundle.channel.revision &&
    !!view.linkId &&
    !!view.revision &&
    view.expiresAtMs > now
  );
}

function safeAccountLabel(label: string | undefined): label is string {
  return !!label?.trim() && [...label].length <= 200 && !/[@\p{Cc}\p{Cf}]/u.test(label);
}

export class IdentityFlow {
  constructor(
    private readonly client: ChannelClient,
    private readonly slack: SlackClient,
  ) {}

  async notify(
    channelId: string,
    actorId: string,
    text: string,
    bundle: ChannelBundle,
    button?: { label: string; action: string; value?: string; url?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const blocks: SlackBlocks = [{ type: 'section', text: { type: 'plain_text', text } }];
    if (button)
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: button.label },
            action_id: button.action,
            ...(button.value ? { value: button.value } : {}),
            ...(button.url ? { url: button.url } : {}),
          },
        ],
      });
    await this.slack.ephemeral(
      bundle.credentials.botToken,
      {
        channel: channelId,
        user: actorId,
        text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        blocks,
      },
      signal,
    );
  }

  async prompt(
    channelId: string,
    actorId: string,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    const view = await this.client.identity<ChannelLinkView | null>(actorId, '', undefined, signal);
    if (view?.state === 'accepted') {
      if (
        !validActorView(view, this.client.config.CHANNEL_TENANT_ID, actorId, bundle) ||
        !safeAccountLabel(view.accountLabel)
      )
        throw new Error('Accepted account identity cannot be safely confirmed');
      const label = `Confirm linking ${view.accountLabel} to you`;
      return this.notify(
        channelId,
        actorId,
        `${label}. Confirm only if this is the account you intended to use. Then retry your mention.`,
        bundle,
        {
          label: [...label].length <= 75 ? label : 'Confirm the account shown above',
          action: 'channel_link_confirm',
          value: JSON.stringify({ linkId: view.linkId, revision: view.revision }),
        },
        signal,
      );
    }
    if (view?.state === 'active') {
      if (!validActorView(view, this.client.config.CHANNEL_TENANT_ID, actorId, bundle))
        throw new Error('Channel account link changed');
      return this.notify(
        channelId,
        actorId,
        'Your account is linked, but this channel has not authorized this request. Check your channel access with its owner, then retry your mention.',
        bundle,
        undefined,
        signal,
      );
    }
    const ticket = await this.client.identity<ChannelLinkTicket>(actorId, '/ticket', {}, signal);
    if (!safeIdentityTicket(ticket)) throw new Error('Invalid private account-link ticket');
    await this.notify(
      channelId,
      actorId,
      'Link your account in the browser, then mention me again to confirm the exact account here in Slack. Your original request will not run automatically.',
      bundle,
      { label: 'Link your account', action: 'channel_link_open', url: ticket.url },
      signal,
    );
  }

  async confirm(
    channelId: string,
    actorId: string,
    value: string,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    if (value.length > 1024) throw new Error('Invalid account confirmation reference');
    const confirmation = confirmationSchema.parse(JSON.parse(value));
    const view = await this.client.identity<ChannelLinkView | null>(actorId, '', undefined, signal);
    if (
      !validActorView(view, this.client.config.CHANNEL_TENANT_ID, actorId, bundle) ||
      view.linkId !== confirmation.linkId ||
      view.revision !== confirmation.revision ||
      view.state !== 'accepted'
    ) {
      return this.notify(
        channelId,
        actorId,
        'This confirmation is stale or does not belong to you. Please retry your mention to check your own account link.',
        bundle,
        undefined,
        signal,
      );
    }
    const confirmed = await this.client.identity<ChannelLinkView>(
      actorId,
      '/confirm',
      confirmation,
      signal,
    );
    if (
      !validActorView(confirmed, this.client.config.CHANNEL_TENANT_ID, actorId, bundle) ||
      confirmed.linkId !== confirmation.linkId ||
      confirmed.state !== 'active'
    )
      throw new Error('Account confirmation not committed');
    await this.notify(
      channelId,
      actorId,
      'Your account link is confirmed. Please retry your mention; the earlier request was not run.',
      bundle,
      undefined,
      signal,
    );
  }
}
