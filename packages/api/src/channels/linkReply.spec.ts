import { channelLinkMessage, isSlackReplyURL } from 'librechat-data-provider';
import type { ChannelLinkView } from 'librechat-data-provider';
import { updateSlackLinkReply } from './linkReply';

const view: ChannelLinkView = {
  identity: {
    tenantId: '_',
    channelId: 'binding',
    channelRevision: 'one',
    teamId: 'T1',
    externalUserId: 'U1',
    agentId: 'agent',
  },
  linkId: 'link',
  revision: 'accepted',
  state: 'accepted',
  expiresAtMs: Date.now() + 60000,
  accountLabel: 'Demo account',
};
it('replaces the private source card with a short confirmation button, then terminal success', async () => {
  const transport = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response('ok'));
  await updateSlackLinkReply(
    'https://hooks.slack.com/actions/T1/B1/secret',
    view,
    10000,
    transport,
  );
  const init = transport.mock.calls[0][1]!;
  expect(init.redirect).toBe('error');
  const body = JSON.parse(String(init.body));
  expect(body.replace_original).toBe(true);
  expect(body.text).toBe('Connect as Demo account?');
  expect(body.blocks[1].elements[0].text.text).toBe('Confirm account');
  expect(channelLinkMessage({ ...view, state: 'active' }).blocks).toHaveLength(1);
});
it.each([
  'http://hooks.slack.com/actions/T/B/s',
  'https://hooks.slack.com.evil.test/actions/T/B/s',
  'https://hooks.slack.com/actions/T/B/s?leak=1',
  'https://hooks.slack.com@evil.test/actions/T/B/s',
  'https://hooks.slack.com:444/actions/T/B/s',
])('rejects unsafe capability %s', (url) => expect(isSlackReplyURL(url)).toBe(false));
it('does not accept an unsuccessful Slack write as delivery', async () => {
  const transport = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(new Response('', { status: 503 }));
  await expect(
    updateSlackLinkReply('https://hooks.slack.com/actions/T1/B1/secret', view, 10000, transport),
  ).rejects.toThrow('unavailable');
});

it('honors the injected deadline when Slack is slower than the configured budget', async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('ok')), 100);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      }),
  );
  await expect(
    updateSlackLinkReply('https://hooks.slack.com/actions/T1/B1/secret', view, 10, transport),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
});

it('renders an invalidated attempt without account details or actions', () => {
  const message = channelLinkMessage({ ...view, state: 'unavailable' });
  expect(message.blocks).toHaveLength(1);
  expect(JSON.stringify(message)).not.toContain(view.accountLabel);
  expect(JSON.stringify(message)).not.toContain('channel_link_confirm');
  expect(message.text).toContain('no longer available');
});
