import {
  getChatReturnUrl,
  getPageForNavId,
  getPageForPath,
  getPageSettings,
  getRelatedPage,
} from '../registry';

describe('feature page registry', () => {
  it.each([
    ['agents', 'agentBuilder'],
    ['skills', 'skills'],
    ['prompts', 'prompts'],
    ['schedules', 'schedules'],
    ['memories', 'memories'],
    ['bookmarks', 'bookmarks'],
    ['parameters', 'parameters'],
    ['mcp-builder', 'mcpSettings'],
  ])('maps current nav id %s to %s', (id, page) => {
    expect(getPageForNavId(id)).toBe(page);
  });
  it('leaves existing detail URLs to their feature routes', () => {
    expect(getPageForPath('/prompts/prompt-a')).toBeUndefined();
    expect(getPageForPath('/skills/skill-a/edit')).toBeUndefined();
    expect(getRelatedPage('/skills/skill-a/edit')).toBe('skills');
    expect(getRelatedPage('/prompts/prompt-a')).toBe('prompts');
    expect(getRelatedPage('/skills-extra/skill-a')).toBeUndefined();
    expect(getPageSettings(undefined, 'agentBuilder')).toEqual({
      enabled: false,
      defaultView: 'panel',
    });
  });
  it.each([
    undefined,
    'https://example.com',
    '//example.com/c/new',
    '/agent-builder',
    '/c/new/../../login',
  ])('rejects unsafe return targets: %p', (url) => {
    expect(getChatReturnUrl(url)).toBe('/c/new');
  });
  it('preserves the same internal conversation and query', () => {
    expect(getChatReturnUrl('/c/chat-a?foo=bar&x=1')).toBe('/c/chat-a?foo=bar&x=1');
  });
});
