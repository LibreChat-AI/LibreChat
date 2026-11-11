import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { Constants, ReasoningEffort } from 'librechat-data-provider';
import {
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
  filesFamily,
  presetFamily,
  abortScrollFamily,
  optionSettingsFamily,
  showStopButtonByIndex,
  submissionStartFamily,
} from '@librechat/chat/react';
import type { TPreset } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { filesDialogTriggerAtom, showFilesDialogAtom } from '~/store/filesDialog';
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

  /* Quotes and skill picks are keyed by conversation, so a chat staged and then
     left (the shared new-chat key included) still holds them at sign-out. */
  it('drops staged quotes and skill picks for every conversation, mounted or not', async () => {
    const jotaiStore = createStore();
    jotaiStore.set(pendingQuotesByConvoId(Constants.NEW_CONVO), ['quote']);
    jotaiStore.set(pendingManualSkillsByConvoId(Constants.NEW_CONVO), ['writer']);
    jotaiStore.set(pendingQuotesByConvoId('unmounted-conversation'), ['quote']);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <JotaiProvider store={jotaiStore}>
        <RecoilRoot>{children}</RecoilRoot>
      </JotaiProvider>
    );

    const { result } = renderHook(() => useClearStates(), { wrapper });
    await act(async () => {
      await result.current();
    });

    expect(Array.from(pendingQuotesByConvoId.getParams())).toEqual([]);
    expect(Array.from(pendingManualSkillsByConvoId.getParams())).toEqual([]);
    expect(jotaiStore.get(pendingQuotesByConvoId(Constants.NEW_CONVO))).toEqual([]);
    expect(jotaiStore.get(pendingManualSkillsByConvoId(Constants.NEW_CONVO))).toEqual([]);
  });

  /* `skipFirst` keeps the landing pane's run state; every other pane's stop
     button, scroll latch and elapsed baseline reset so the next session starts idle. */
  it.each([
    [false, [false, false]],
    [true, [true, false]],
  ])('resets per-pane run state (skipFirst %s)', async (skipFirst, expected) => {
    const jotaiStore = createStore();
    for (const key of [0, 1]) {
      jotaiStore.set(showStopButtonByIndex(key), true);
      jotaiStore.set(abortScrollFamily(key), true);
      jotaiStore.set(submissionStartFamily(key), 1000);
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
    expect([0, 1].map((key) => jotaiStore.get(submissionStartFamily(key)))).toEqual(
      expected.map((kept) => (kept ? 1000 : null)),
    );
  });
  /* The preset, option toggles and staged files of each pane are per-session
     state: a pane that survives sign-out must not hand them to the next account. */
  it.each([
    [false, [null, null]],
    [true, ['kept', null]],
  ])('resets per-pane preset, options and files (skipFirst %s)', async (skipFirst, expected) => {
    const jotaiStore = createStore();
    for (const key of [0, 1]) {
      jotaiStore.set(presetFamily(key), { title: 'kept' } as TPreset);
      jotaiStore.set(optionSettingsFamily(key), { showExamples: true });
      jotaiStore.set(filesFamily(key), new Map([['kept', { file_id: 'kept' } as ExtendedFile]]));
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

    expect([0, 1].map((key) => jotaiStore.get(presetFamily(key))?.title ?? null)).toEqual(expected);
    expect(
      [0, 1].map((key) => jotaiStore.get(optionSettingsFamily(key)).showExamples ?? null),
    ).toEqual(expected.map((kept) => (kept ? true : null)));
    expect([0, 1].map((key) => jotaiStore.get(filesFamily(key)).has('kept') || null)).toEqual(
      expected.map((kept) => (kept ? true : null)),
    );
  });
});
