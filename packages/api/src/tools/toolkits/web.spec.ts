import { buildWebSearchContext, buildWebSearchDynamicContext } from './web';

describe('web search context', () => {
  it('keeps static context free of volatile date replacements', () => {
    const context = buildWebSearchContext(true);

    expect(context).toContain('web_search');
    expect(context).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(context).not.toContain('{{');
    expect(context).toContain('<context_update>');
  });

  it('keeps the previous recency hint when stableContext is off', () => {
    const context = buildWebSearchContext();

    expect(context).toContain(
      'Use the conversation date/time from the dynamic runtime context when recency matters.',
    );
    expect(context).not.toContain('<context_update>');
  });

  it('guides the model to answer directly when a search is not warranted', () => {
    const context = buildWebSearchContext();

    expect(context).toContain('respond directly without searching');
    expect(context).toContain('current, real-time, or otherwise beyond your own knowledge');
  });

  it('anchors the runtime context to the conversation start in the user timezone', () => {
    const params = {
      conversationStartedAt: '2024-01-02T03:04:05.000Z',
      turnStartedAt: '2024-02-03T04:05:06.000Z',
      timezone: 'America/New_York',
      stableContext: true,
    };
    const context = buildWebSearchDynamicContext(params);

    expect(context).toBe(
      '# `web_search` Runtime Context\nConversation started: 2024-01-01 22:04 -05:00 (Mon)',
    );
    expect(
      buildWebSearchDynamicContext({ ...params, turnStartedAt: '2024-05-06T07:08:09.000Z' }),
    ).toBe(context);
  });

  it('states the turn start time when stableContext is off', () => {
    expect(
      buildWebSearchDynamicContext({
        conversationStartedAt: '2024-01-02T03:04:05.000Z',
        turnStartedAt: '2024-02-03T04:05:06.000Z',
        timezone: 'America/New_York',
      }),
    ).toBe('# `web_search` Runtime Context\nConversation Date & Time: 2024-02-03T04:05:06.000Z');
  });

  it('falls back to UTC without a timezone', () => {
    expect(
      buildWebSearchDynamicContext({
        conversationStartedAt: Date.parse('2024-01-02T03:04:05.000Z'),
        stableContext: true,
      }),
    ).toBe('# `web_search` Runtime Context\nConversation started: 2024-01-02 03:04 +00:00 (Tue)');
  });
});
