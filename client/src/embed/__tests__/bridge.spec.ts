import { EmbedMessage, requestHostToken } from '../bridge';

const state = { app: 'portal', origin: 'https://portal.example.com' };

describe('requestHostToken', () => {
  let posted: Array<{ message: Record<string, unknown>; targetOrigin: string }>;

  beforeEach(() => {
    posted = [];
    jest
      .spyOn(window.parent, 'postMessage')
      .mockImplementation((message: unknown, targetOrigin: unknown) => {
        posted.push({
          message: message as Record<string, unknown>,
          targetOrigin: targetOrigin as string,
        });
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const reply = (
    data: Record<string, unknown>,
    origin = state.origin,
    source: Window = window.parent,
  ) => window.dispatchEvent(new MessageEvent('message', { data, origin, source }));

  it('asks only the host origin for a token and resolves with its reply', async () => {
    const pending = requestHostToken(state);
    expect(posted).toHaveLength(1);
    expect(posted[0].targetOrigin).toBe(state.origin);
    expect(posted[0].message.type).toBe(EmbedMessage.tokenRequest);

    reply({ type: EmbedMessage.token, requestId: posted[0].message.requestId, token: 'signed' });
    await expect(pending).resolves.toBe('signed');
  });

  it('ignores replies from another origin or with another request id', async () => {
    jest.useFakeTimers();
    const pending = requestHostToken(state);
    const requestId = posted[0].message.requestId;

    reply({ type: EmbedMessage.token, requestId, token: 'forged' }, 'https://evil.example');
    reply({ type: EmbedMessage.token, requestId: 'other', token: 'stale' });
    jest.advanceTimersByTime(15_000);

    await expect(pending).rejects.toThrow('Timed out');
    jest.useRealTimers();
  });

  it('rejects when the host reports it could not sign a token', async () => {
    const pending = requestHostToken(state);
    reply({ type: EmbedMessage.tokenError, requestId: posted[0].message.requestId });
    await expect(pending).rejects.toThrow('did not provide');
  });
});
