const mockEmitChunk = jest.fn();

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'search-attachment'),
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    emitChunk: (...args) => mockEmitChunk(...args),
  },
}));

const axios = require('axios');
const { createSearchTool } = require('@librechat/agents');
const { createOnSearchResults } = require('./search');

describe('createOnSearchResults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([true, false])(
    'streams Kagi results without news (has web results: %s)',
    async (hasResults) => {
      const link = 'https://example.com/article';
      const post = jest.spyOn(axios, 'post');
      post.mockResolvedValueOnce({
        data: {
          data: {
            search: hasResults ? [{ url: link, title: 'Kagi result', snippet: 'Evidence' }] : [],
          },
        },
      });
      if (hasResults) {
        post.mockResolvedValueOnce({
          data: { data: [{ url: link, markdown: '# Kagi result\n\nExtracted evidence.' }] },
        });
      }
      const write = jest.fn();
      const callbacks = createOnSearchResults({ headersSent: true, write });
      const tool = createSearchTool({
        searchProvider: 'kagi',
        scraperProvider: 'kagi',
        kagiApiKey: 'kagi-test-key',
        rerankerType: 'none',
        ...callbacks,
      });
      try {
        const message = await tool.invoke(
          {
            type: 'tool_call',
            id: 'kagi-call',
            name: 'web_search',
            args: { query: 'evidence' },
          },
          {
            metadata: {
              user_id: 'user-1',
              thread_id: 'conversation-1',
              run_id: 'response-1',
            },
            toolCall: { id: 'kagi-call', name: 'web_search', turn: 0 },
          },
        );
        expect(message.artifact.web_search.error).toBeUndefined();
        expect(message.artifact.web_search.organic).toHaveLength(hasResults ? 1 : 0);
        expect(message.artifact.web_search.topStories).toEqual([]);
        expect(write).toHaveBeenCalledTimes(hasResults ? 2 : 1);
        const attachment = JSON.parse(write.mock.calls[0][0].split('\ndata: ')[1]);
        expect(attachment.web_search.organic).toHaveLength(hasResults ? 1 : 0);
        expect(attachment.web_search.topStories).toEqual([]);
        if (hasResults) {
          const highlighted = JSON.parse(write.mock.calls[1][0].split('\ndata: ')[1]);
          expect(highlighted.web_search.organic[0].processed).toBe(true);
          expect(message.content).toContain('Extracted evidence');
        }
        expect(post).toHaveBeenCalledTimes(hasResults ? 2 : 1);
      } finally {
        post.mockRestore();
      }
    },
  );

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
