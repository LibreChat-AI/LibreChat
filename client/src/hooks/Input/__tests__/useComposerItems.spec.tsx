import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider as JotaiProvider, createStore, useAtomValue } from 'jotai';
import { pendingQuotesByConvoId, pendingManualSkillsByConvoId } from '@librechat/chat/react';
import useComposerItems from '../useComposerItems';

/**
 * The tray's staged context. Removal is the whole surface here, and quotes are
 * addressed by position, which is the way to dismiss the wrong one.
 */

const CONVO_ID = 'convo-items';

function setup(initialize?: (jotaiStore: ReturnType<typeof createStore>) => void) {
  const jotaiStore = createStore();
  initialize?.(jotaiStore);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <JotaiProvider store={jotaiStore}>{children}</JotaiProvider>
  );
  return renderHook(
    () => ({
      items: useComposerItems(CONVO_ID),
      quotes: useAtomValue(pendingQuotesByConvoId(CONVO_ID)),
      skills: useAtomValue(pendingManualSkillsByConvoId(CONVO_ID)),
    }),
    { wrapper },
  );
}

const withStaged = (quotes: string[], skills: string[] = []) =>
  setup((jotaiStore) => {
    jotaiStore.set(pendingQuotesByConvoId(CONVO_ID), quotes);
    jotaiStore.set(pendingManualSkillsByConvoId(CONVO_ID), skills);
  });

describe('useComposerItems', () => {
  it('stages nothing for an untouched composer', () => {
    expect(setup().result.current.items).toEqual([]);
  });

  it('lists quotes ahead of skills', () => {
    const { result } = withStaged(['a quote'], ['writer']);
    expect(result.current.items.map((item) => item.kind)).toEqual(['quote', 'skill']);
    expect(result.current.items.map((item) => item.label)).toEqual(['a quote', 'writer']);
  });

  it('removes the quote that was dismissed, not the first one', () => {
    const { result } = withStaged(['first', 'second', 'third']);
    act(() => result.current.items[1].remove());
    expect(result.current.quotes).toEqual(['first', 'third']);
  });

  it('removes a skill by name', () => {
    const { result } = withStaged([], ['writer', 'researcher']);
    act(() => result.current.items[1].remove());
    expect(result.current.skills).toEqual(['writer']);
  });

  /* Two identical excerpts are two separate stagings, and dismissing one has to
     leave the other alone. */
  it('keeps two identical quotes separately removable', () => {
    const { result } = withStaged(['same words', 'same words']);
    expect(new Set(result.current.items.map((item) => item.id)).size).toBe(2);

    act(() => result.current.items[0].remove());
    expect(result.current.quotes).toEqual(['same words']);
  });

  it('keeps repeated quote ids distinct from literal suffix text', () => {
    const { result } = withStaged(['same words', 'same words', 'same words#1']);
    expect(new Set(result.current.items.map((item) => item.id)).size).toBe(3);
  });

  /* An index inside the id rewrote every id after a removal, which remounts
     those chips and drops focus off whichever one was being used. */
  it('leaves the ids of the surviving chips alone', () => {
    const { result } = withStaged(['first', 'second', 'third']);
    const before = result.current.items.map((item) => item.id);

    act(() => result.current.items[0].remove());
    expect(result.current.items.map((item) => item.id)).toEqual(before.slice(1));
  });

  it('carries the full text for a chip that has to truncate it', () => {
    const long = 'a quote long enough that the chip will have to cut it short somewhere';
    const { result } = withStaged([long]);
    expect(result.current.items[0].title).toBe(long);
  });
});
