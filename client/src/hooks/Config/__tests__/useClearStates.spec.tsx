import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { filesDialogTriggerAtom, showFilesDialogAtom } from '~/store/filesDialog';
import useClearStates from '../useClearStates';

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
});
