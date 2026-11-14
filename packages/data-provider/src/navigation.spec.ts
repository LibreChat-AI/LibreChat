import { interfaceSchema, navigationSchema, resolveNavigation } from './config';

describe('navigation presentation configuration', () => {
  it.each([undefined, {}])('keeps upstream defaults when omitted: %p', (value) => {
    const navigation = interfaceSchema.parse(value).navigation;
    expect(navigation.layout).toBe('current');
    expect(navigation.pages.agentBuilder).toEqual({ enabled: false, defaultView: 'panel' });
    expect(navigation.pages.skills.enabled).toBe(true);
    expect(navigation.pages.prompts.enabled).toBe(true);
    expect(Object.values(navigation.pages).every((page) => page.defaultView === 'panel')).toBe(
      true,
    );
  });

  it('fills sibling pages and fields around a partial override', () => {
    const navigation = navigationSchema.parse({ pages: { agentBuilder: { enabled: true } } });
    expect(navigation.pages.agentBuilder).toEqual({ enabled: true, defaultView: 'panel' });
    expect(navigation.pages.skills.enabled).toBe(true);
    expect(navigation.pages.memories.enabled).toBe(false);
  });

  it('merges each page field with configured defaults and preserves false', () => {
    const navigation = resolveNavigation(
      { pages: { agentBuilder: { defaultView: 'page' }, skills: { enabled: false } } },
      { layout: 'console', pages: { agentBuilder: { enabled: true } } },
    );
    expect(navigation.layout).toBe('console');
    expect(navigation.pages.agentBuilder).toEqual({ enabled: true, defaultView: 'page' });
    expect(navigation.pages.skills).toEqual({ enabled: false, defaultView: 'panel' });
  });

  it.each([
    { layout: 'other' },
    { pages: { agentBuilder: { enabled: 'true' } } },
    { pages: { agentBuilder: { defaultView: 'other' } } },
    { pages: { agentBuilder: { defaultView: 'page' } } },
    { pages: { skills: { enabled: false, defaultView: 'page' } } },
  ])('rejects invalid presentation settings: %p', (value) => {
    expect(navigationSchema.safeParse(value).success).toBe(false);
  });
});
