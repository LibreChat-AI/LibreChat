import {
  resolveRunConversation,
  resolveConversationAnchor,
  resolveRunCodeWorkspaces,
} from './conversation';

describe('resolveRunCodeWorkspaces', () => {
  const saved = [{ environmentId: 'machine', workspaceId: 'source-project' }];
  const conversation = { conversationId: 'source', codeWorkspaces: saved };
  it('retains a saved selection only for the same conversation', () => {
    expect(resolveRunCodeWorkspaces({ conversationId: 'source', conversation })).toBe(saved);
    expect(resolveRunCodeWorkspaces({ conversationId: 'target', conversation })).toBeUndefined();
  });
  it.each([
    { requestedSelections: [] },
    { requestedSelections: [{ environmentId: 'machine', workspaceId: 'chosen-project' }] },
  ])('preserves an explicit choice, including clearing selections', ({ requestedSelections }) => {
    expect(
      resolveRunCodeWorkspaces({ conversationId: 'target', conversation, requestedSelections }),
    ).toBe(requestedSelections);
  });
});

describe('resolveRunConversation', () => {
  it.each([null, undefined, { conversationId: 'source' }])(
    'preserves authoritative same-conversation state: %s',
    async (resolvedConversation) => {
      const loadConversation = jest.fn();
      expect(
        await resolveRunConversation({
          request: { body: { conversationId: 'source' }, resolvedConversation },
          conversationId: 'source',
          loadConversation,
        }),
      ).toBe(resolvedConversation);
      expect(loadConversation).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { resolvedConversation: null },
    { resolvedConversation: { conversationId: 'source' } },
  ])('loads the effective target instead of source state: %s', async (state) => {
    const target = { conversationId: 'target' };
    const loadConversation = jest.fn().mockResolvedValue(target);
    expect(
      await resolveRunConversation({
        request: { body: { conversationId: 'source' }, ...state },
        conversationId: 'target',
        loadConversation,
      }),
    ).toBe(target);
    expect(loadConversation).toHaveBeenCalledTimes(1);
    expect(loadConversation).toHaveBeenCalledWith('target');
  });

  it('does not fall back to a source when the effective conversation is absent', async () => {
    const loadConversation = jest.fn();
    expect(
      await resolveRunConversation({
        request: {
          body: { conversationId: 'source' },
          resolvedConversation: { conversationId: 'source' },
        },
        loadConversation,
      }),
    ).toBeNull();
    expect(loadConversation).not.toHaveBeenCalled();
  });
});

describe('resolveConversationAnchor', () => {
  const fallback = new Date('2026-07-24T12:00:00.000Z');

  it('anchors a new conversation without loading an existing one', async () => {
    const loadConversation = jest.fn();

    const result = await resolveConversationAnchor({
      isNewConversation: true,
      loadConversation,
      now: () => fallback,
    });

    expect(result).toEqual({
      createdAt: fallback.toISOString(),
      conversation: undefined,
    });
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it('returns an existing conversation with a normalized creation time', async () => {
    const conversation = {
      conversationId: 'conversation-1',
      createdAt: new Date('2025-01-02T03:04:05.000Z'),
    };

    const result = await resolveConversationAnchor({
      isNewConversation: false,
      loadConversation: async () => conversation,
      now: () => fallback,
    });

    expect(result).toEqual({
      createdAt: '2025-01-02T03:04:05.000Z',
      conversation,
    });
  });

  it.each([null, undefined, 'not-a-date'])(
    'uses the fallback time for a missing or invalid creation time: %p',
    async (createdAt) => {
      const conversation = createdAt === undefined ? null : { createdAt };

      const result = await resolveConversationAnchor({
        isNewConversation: false,
        loadConversation: async () => conversation,
        now: () => fallback,
      });

      expect(result).toEqual({
        createdAt: fallback.toISOString(),
        conversation,
      });
    },
  );

  it('reports load failures and degrades to a fresh anchor', async () => {
    const onLoadError = jest.fn();
    const failure = new Error('conversation store unavailable');

    const result = await resolveConversationAnchor({
      isNewConversation: false,
      loadConversation: async () => {
        throw failure;
      },
      now: () => fallback,
      onLoadError,
    });

    expect(result).toEqual({
      createdAt: fallback.toISOString(),
      conversation: undefined,
    });
    expect(onLoadError).toHaveBeenCalledWith(failure);
  });
});
