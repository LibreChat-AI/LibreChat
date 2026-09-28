const mockEmitChunk = jest.fn();

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'search-attachment'),
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    emitChunk: (...args) => mockEmitChunk(...args),
  },
}));

const { createOnSearchResults } = require('./search');

describe('createOnSearchResults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fences resumable search attachments to the owning generation', () => {
    const callbacks = createOnSearchResults({ headersSent: true }, 'conversation-1', 1234);
    const runnableConfig = {
      metadata: {
        user_id: 'user-1',
        thread_id: 'conversation-1',
        run_id: 'response-1',
      },
      toolCall: {
        id: 'tool-call-1',
        name: 'web_search',
        stepId: 'step-search-1',
        turn: 0,
      },
    };

    callbacks.onSearchResults(
      {
        success: true,
        data: {
          organic: [{ link: 'https://example.com' }],
          topStories: [],
        },
      },
      runnableConfig,
    );
    callbacks.onGetHighlights('https://example.com');

    expect(mockEmitChunk).toHaveBeenCalledTimes(2);
    for (const call of mockEmitChunk.mock.calls) {
      expect(call).toEqual([
        'conversation-1',
        {
          event: 'attachment',
          data: expect.objectContaining({
            messageId: 'response-1',
            toolCallId: 'tool-call-1',
            stepId: 'step-search-1',
            conversationId: 'conversation-1',
          }),
        },
        { expectedCreatedAt: 1234 },
      ]);
    }
  });

  it('keeps repeated search calls owned by their handoff agent through highlights', () => {
    const snapshots = [];
    const res = {
      headersSent: true,
      write: (event) => snapshots.push(JSON.parse(event.split('\ndata: ')[1])),
    };
    for (const agentId of ['agent-a', 'agent-b']) {
      const callbacks = createOnSearchResults(res);
      callbacks.onSearchResults(
        {
          success: true,
          data: { organic: [{ link: `https://example.com/${agentId}` }], topStories: [] },
        },
        {
          metadata: { agent_id: agentId, run_id: 'response-1', thread_id: 'conversation-1' },
          toolCall: { id: 'call_0', name: 'web_search', turn: 0 },
        },
      );
      callbacks.onGetHighlights(`https://example.com/${agentId}`);
    }

    expect(snapshots.map(({ agentId }) => agentId)).toEqual([
      'agent-a',
      'agent-a',
      'agent-b',
      'agent-b',
    ]);
    expect(snapshots[1].web_search.organic[0].processed).toBe(true);
    expect(snapshots[3].web_search.organic[0].processed).toBe(true);
  });
});
