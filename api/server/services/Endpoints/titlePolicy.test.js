const mockResolveTitlePolicy = jest.fn();

jest.mock('@librechat/api', () => ({
  SAFE_CONVERSATION_TITLE: 'New Chat',
  resolveConversationTitle: (...args) => mockResolveTitlePolicy(...args),
}));

const { resolveConversationTitle } = require('./titlePolicy');

describe('titlePolicy adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTitlePolicy.mockReturnValue('Resolved title');
  });

  it('delegates the policy decision to the TypeScript implementation', () => {
    const filters = { conversationTitles: { pii: {} } };

    expect(resolveConversationTitle({ config: { filters } }, 'Candidate', 'Fallback')).toBe(
      'Resolved title',
    );
    expect(mockResolveTitlePolicy).toHaveBeenCalledWith({
      filters,
      candidate: 'Candidate',
      fallback: 'Fallback',
    });
  });
});
