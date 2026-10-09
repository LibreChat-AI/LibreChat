import type { FiltersConfig } from 'librechat-data-provider';
import { resolveConversationTitle, SAFE_CONVERSATION_TITLE } from './title';

const filters = {
  conversationTitles: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
    },
  },
} satisfies FiltersConfig;

describe('resolveConversationTitle', () => {
  it('leaves non-empty titles unchanged when title protection is disabled', () => {
    expect(resolveConversationTitle({ candidate: 'Original title' })).toBe('Original title');
  });

  it('rejects empty title candidates', () => {
    expect(resolveConversationTitle({ filters, candidate: '' })).toBeNull();
    expect(resolveConversationTitle({ filters, candidate: null })).toBeNull();
  });

  it('uses the fixed fallback when the candidate is blocked', () => {
    expect(resolveConversationTitle({ filters, candidate: 'BLOCKED-TITLE' })).toBe(
      SAFE_CONVERSATION_TITLE,
    );
  });

  it('suppresses the write when the configured policy blocks the fallback', () => {
    expect(
      resolveConversationTitle({
        filters,
        candidate: 'BLOCKED-TITLE',
        fallback: 'BLOCKED-FALLBACK',
      }),
    ).toBeNull();
  });

  it('does not reinspect an identical blocked fallback', () => {
    expect(
      resolveConversationTitle({
        filters,
        candidate: 'BLOCKED-TITLE',
        fallback: 'BLOCKED-TITLE',
      }),
    ).toBeNull();
  });
});
