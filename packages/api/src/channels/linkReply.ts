import { channelLinkMessage, isSlackReplyURL } from 'librechat-data-provider';
import type { ChannelLinkView } from 'librechat-data-provider';

/** The response capability stays server-side; redirects must never forward it elsewhere. */
export async function updateSlackLinkReply(
  url: string,
  view: ChannelLinkView,
  timeoutMs: number,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (!isSlackReplyURL(url)) throw new TypeError('Invalid Slack reply URL');
  const result = await transport(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...channelLinkMessage(view), replace_original: true }),
  });
  await result.body?.cancel();
  if (!result.ok) throw new Error('Slack link update unavailable');
}
