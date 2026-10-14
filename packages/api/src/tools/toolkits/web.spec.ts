import { buildWebSearchContext, buildWebSearchDynamicContext } from './web';

describe('web search context', () => {
  it('keeps static context free of volatile date replacements', () => {
    const context = buildWebSearchContext();

    expect(context).toContain('web_search');
    expect(context).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(context).not.toContain('{{');
    expect(context).toContain('<context_update>');
  });

  it('guides the model to answer directly when a search is not warranted', () => {
    const context = buildWebSearchContext();

    expect(context).toContain('respond directly without searching');
    expect(context).toContain('current, real-time, or otherwise beyond your own knowledge');
  });

  it('anchors the runtime context to the conversation start in the user timezone', () => {
    const context = buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z', 'America/New_York');

    expect(context).toBe(
      '# `web_search` Runtime Context\nConversation started: 2024-01-01 22:04 -05:00 (Mon)',
    );
    expect(buildWebSearchDynamicContext('2024-01-02T03:04:05.000Z', 'America/New_York')).toBe(
      context,
    );
  });

  it('falls back to UTC without a timezone', () => {
    expect(buildWebSearchDynamicContext(Date.parse('2024-01-02T03:04:05.000Z'))).toBe(
      '# `web_search` Runtime Context\nConversation started: 2024-01-02 03:04 +00:00 (Tue)',
    );
  });
});
