import type { ChannelLinkView } from './types/channelIdentity';

/** Slack response capabilities expire 30 minutes after the signed interaction. */
export const SLACK_REPLY_LIFETIME_MS = 30 * 60_000;

export function isSlackReplyURL(raw: string): boolean {
  if (raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/actions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function channelLinkMessage(view: ChannelLinkView) {
  const active = view.state === 'active';
  const unavailable = view.state === 'unavailable';
  const label = view.accountLabel?.trim();
  if (
    !active &&
    !unavailable &&
    (view.state !== 'accepted' ||
      !label ||
      [...label].length > 200 ||
      /[@\p{Cc}\p{Cf}]/u.test(label))
  )
    throw new TypeError('Invalid account confirmation');
  let text = `Connect as ${label}?`;
  if (active) text = '✓ Account connected. Mention the bot again to send your request.';
  if (unavailable)
    text = 'This account link is no longer available. Mention the bot again to connect.';
  const section = { type: 'section' as const, text: { type: 'plain_text' as const, text } };
  return {
    text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    blocks:
      active || unavailable
        ? [section]
        : [
            section,
            {
              type: 'actions' as const,
              elements: [
                {
                  type: 'button' as const,
                  text: { type: 'plain_text' as const, text: 'Confirm account' },
                  action_id: 'channel_link_confirm',
                  value: JSON.stringify({ linkId: view.linkId, revision: view.revision }),
                },
              ],
            },
          ],
  };
}
