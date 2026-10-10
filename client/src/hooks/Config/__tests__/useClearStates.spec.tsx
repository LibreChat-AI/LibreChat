import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { ReasoningEffort } from 'librechat-data-provider';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { pendingReasoningOverrideFamily } from '~/components/Chat/Input/Composer/state';
import { filesDialogTriggerAtom, showFilesDialogAtom } from '~/store/filesDialog';
import { abortScrollFamily, showStopButtonByIndex } from '~/store/generation';
import useClearStates from '../useClearStates';
import store from '~/store';

describe('useClearStates', () => {
  /* Jotai's default store outlives the authenticated route, so a file manager
     left open at logout would otherwise reopen for the next session with the
     previous session's opener still attached. */
  it('closes the file manager and drops its opener at the session boundary', async () => {
    const jotaiStore = createStore();
    jotaiStore.set(showFilesDialogAtom, true);
    jotaiStore.set(filesDialogTriggerAtom, { current: document.createElement('button') });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <JotaiProvider store={jotaiStore}>
        <RecoilRoot>{children}</RecoilRoot>
      </JotaiProvider>
    );

    const { result } = renderHook(() => useClearStates(), { wrapper });
    await act(async () => {
      await result.current();
    });

    expect(jotaiStore.get(showFilesDialogAtom)).toBe(false);
    expect(jotaiStore.get(filesDialogTriggerAtom)).toBeNull();
  });

  /* A staged selection survives navigation, so a conversation that is no longer
     on screen still holds one; only the mounted panes used to be cleared. */
  it('drops staged reasoning for every conversation, mounted or not', async () => {
    const jotaiStore = createStore();
    const staged = { key: 'reasoning_effort' as const, value: ReasoningEffort.high };
    jotaiStore.set(pendingReasoningOverrideFamily('unmounted-conversation'), staged);
    jotaiStore.set(pendingReasoningOverrideFamily('new:1'), staged);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <JotaiProvider store={jotaiStore}>
        <RecoilRoot>{children}</RecoilRoot>
      </JotaiProvider>
    );

    const { result } = renderHook(() => useClearStates(), { wrapper });
    await act(async () => {
      await result.current();
    });

    expect(Array.from(pendingReasoningOverrideFamily.getParams())).toEqual([]);
    expect(
      jotaiStore.get(pendingReasoningOverrideFamily('unmounted-conversation')),
    ).toBeUndefined();
  });

  /* `skipFirst` keeps the landing pane's run state; every other pane's stop
     button and scroll latch reset so the next session starts idle. */
  it.each([
    [false, [false, false]],
    [true, [true, false]],
  ])('resets per-pane run state (skipFirst %s)', async (skipFirst, expected) => {
    const jotaiStore = createStore();
    for (const key of [0, 1]) {
      jotaiStore.set(showStopButtonByIndex(key), true);
      jotaiStore.set(abortScrollFamily(key), true);
    }
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <JotaiProvider store={jotaiStore}>
        <RecoilRoot initializeState={({ set }) => set(store.conversationKeysAtom, [0, 1])}>
          {children}
        </RecoilRoot>
      </JotaiProvider>
    );

    const { result } = renderHook(() => useClearStates(), { wrapper });
    await act(async () => {
      await result.current(skipFirst);
    });

    expect([0, 1].map((key) => jotaiStore.get(showStopButtonByIndex(key)))).toEqual(expected);
    expect([0, 1].map((key) => jotaiStore.get(abortScrollFamily(key)))).toEqual(expected);
  });
});
