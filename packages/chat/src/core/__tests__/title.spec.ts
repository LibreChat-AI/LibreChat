import type { ConvoTitleState } from '../turns/title';
import { hasRealTitle, selectConvoTitle } from '../turns/title';

const none = (): ConvoTitleState | undefined => undefined;

describe('selectConvoTitle', () => {
  it('keeps a title the user set over every other source', () => {
    const manual = { title: 'Mine', titleSetByUser: true, titleRevision: 3 };
    const findListed = jest.fn(none);
    expect(
      selectConvoTitle({
        incoming: { title: 'Generated' },
        authoritative: true,
        cached: { title: 'Cached' },
        findManual: () => manual,
        findListed,
      }),
    ).toEqual(manual);
    expect(findListed).not.toHaveBeenCalled();
  });

  it('takes an authoritative incoming title over the cached one', () => {
    expect(
      selectConvoTitle({
        incoming: { title: 'Server' },
        authoritative: true,
        cached: { title: 'Cached' },
        findManual: none,
        findListed: none,
      }).title,
    ).toBe('Server');
  });

  it('falls back from the cached entry to the listed one to the incoming one', () => {
    const base = { incoming: { title: 'New Chat' }, findManual: none };
    expect(selectConvoTitle({ ...base, cached: { title: 'Cached' }, findListed: none }).title).toBe(
      'Cached',
    );
    expect(
      selectConvoTitle({ ...base, cached: { title: '' }, findListed: () => ({ title: 'Listed' }) })
        .title,
    ).toBe('Listed');
    expect(selectConvoTitle({ ...base, cached: null, findListed: none }).title).toBe('New Chat');
  });
});

describe('hasRealTitle', () => {
  it('rejects empty and placeholder titles', () => {
    expect(hasRealTitle('Plans')).toBe(true);
    expect(hasRealTitle('New Chat')).toBe(false);
    expect(hasRealTitle('')).toBe(false);
    expect(hasRealTitle(null)).toBe(false);
  });
});
