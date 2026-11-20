import { z } from 'zod';
import { channelLinkMessage, isSlackReplyURL } from 'librechat-data-provider';
import type { ChannelLinkView, ChannelLinkTicket } from 'librechat-data-provider';
import type { SlackClient, SlackBlocks } from './slack';
import type { ChannelClient } from './client';
import type { ChannelBundle } from './types';
import { expectedServiceFailure } from './transport';

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

export function safeIdentityTicket(
  ticket: Pick<ChannelLinkTicket, 'url' | 'expiresAtMs'>,
  now = Date.now(),
): boolean {
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

  async open(
    actorId: string,
    value: string,
    responseUrl: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!responseUrl) return;
    if (!isSlackReplyURL(responseUrl)) throw new TypeError('Invalid Slack reply');
    const reference = z
      .object({ linkId: z.string().min(1).max(256), attempt: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(JSON.parse(value));
    await this.client.identity(actorId, '/reply', { ...reference, responseUrl }, signal);
  }

  private async replace(
    url: string | undefined,
    text: string,
    bundle: ChannelBundle,
    channelId: string,
    actorId: string,
    signal?: AbortSignal,
    blocks?: SlackBlocks,
  ) {
    if (url && isSlackReplyURL(url)) {
      try {
        await this.slack.replacePrivateReply(
          url,
          { text, blocks: blocks ?? [{ type: 'section', text: { type: 'plain_text', text } }] },
          signal,
        );
        return;
      } catch {
        /* Consent is authoritative; use a fresh private notice when replacement fails. */
      }
    }
    await this.notify(channelId, actorId, text, bundle, undefined, signal);
  }

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

  private unavailable(
    channelId: string,
    actorId: string,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ) {
    return this.notify(
      channelId,
      actorId,
      'This account-link action is stale or unavailable. Retry your mention to check your own account link. The original request was not run.',
      bundle,
      undefined,
      signal,
    );
  }

  private async withAvailability(
    channelId: string,
    actorId: string,
    bundle: ChannelBundle,
    signal: AbortSignal | undefined,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!expectedServiceFailure(error)) throw error;
      await this.unavailable(channelId, actorId, bundle, signal);
    }
  }

  async prompt(
    channelId: string,
    actorId: string,
    bundle: ChannelBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.withAvailability(channelId, actorId, bundle, signal, async () => {
      const current = await this.client.identity<ChannelLinkView | null>(
        actorId,
        '',
        undefined,
        signal,
      );
      if (!current.ok) return this.unavailable(channelId, actorId, bundle, signal);
      const view = current.value;
      if (view?.state === 'accepted') {
        if (
          !validActorView(view, this.client.config.CHANNEL_TENANT_ID, actorId, bundle) ||
          !safeAccountLabel(view.accountLabel)
        )
          throw new Error('Accepted account identity cannot be safely confirmed');
        const message = channelLinkMessage(view);
        await this.slack.ephemeral(
          bundle.credentials.botToken,
          { channel: channelId, user: actorId, ...message },
          signal,
        );
        return;
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
      const issued = await this.client.identity<ChannelLinkTicket>(actorId, '/ticket', {}, signal);
      if (!issued.ok) return this.unavailable(channelId, actorId, bundle, signal);
      const ticket = issued.value;
      if (!safeIdentityTicket(ticket)) throw new Error('Invalid private account-link ticket');
      await this.notify(
        channelId,
        actorId,
        'Connect your LibreChat account to use this bot.',
        bundle,
        {
          label: 'Link account',
          action: 'channel_link_open',
          url: ticket.url,
          value: JSON.stringify({ linkId: ticket.linkId, attempt: ticket.attempt }),
        },
        signal,
      );
    });
  }

  async confirm(
    channelId: string,
    actorId: string,
    value: string,
    bundle: ChannelBundle,
    signal?: AbortSignal,
    responseUrl?: string,
  ): Promise<void> {
    if (value.length > 1024) throw new Error('Invalid account confirmation reference');
    const confirmation = confirmationSchema.parse(JSON.parse(value));
    return this.withAvailability(channelId, actorId, bundle, signal, async () => {
      const current = await this.client.identity<ChannelLinkView | null>(
        actorId,
        '',
        undefined,
        signal,
      );
      if (!current.ok) return this.unavailable(channelId, actorId, bundle, signal);
      const view = current.value;
      if (
        view?.state === 'active' &&
        view.linkId === confirmation.linkId &&
        validActorView(view, this.client.config.CHANNEL_TENANT_ID, actorId, bundle)
      ) {
        const message = channelLinkMessage(view);
        await this.replace(
          responseUrl,
          message.text,
          bundle,
          channelId,
          actorId,
          signal,
          message.blocks,
        );
        return;
      }
      if (
        !validActorView(view, this.client.config.CHANNEL_TENANT_ID, actorId, bundle) ||
        view.linkId !== confirmation.linkId ||
        view.revision !== confirmation.revision ||
        view.state !== 'accepted'
      ) {
        return this.replace(
          responseUrl,
          'This confirmation is stale or unavailable. Mention the bot again to check your account link.',
          bundle,
          channelId,
          actorId,
          signal,
        );
      }
      const result = await this.client.identity<ChannelLinkView>(
        actorId,
        '/confirm',
        confirmation,
        signal,
      );
      if (!result.ok) return this.unavailable(channelId, actorId, bundle, signal);
      const confirmed = result.value;
      if (
        !validActorView(confirmed, this.client.config.CHANNEL_TENANT_ID, actorId, bundle) ||
        confirmed.linkId !== confirmation.linkId ||
        confirmed.state !== 'active'
      )
        throw new Error('Account confirmation not committed');
      const message = channelLinkMessage(confirmed);
      await this.replace(
        responseUrl,
        message.text,
        bundle,
        channelId,
        actorId,
        signal,
        message.blocks,
      );
    });
  }
}
