import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import type { MutableSnapshot } from 'recoil';
import type { ReactNode } from 'react';
import { resolveComposerKeyDown } from '~/utils/shortcuts';
import useComposerBindings from './useComposerBindings';
import store from '~/store';

function createWrapper(initializeState: (snapshot: MutableSnapshot) => void) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <RecoilRoot initializeState={initializeState}>{children}</RecoilRoot>;
  };
}

describe('useComposerBindings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('disables default and custom submit chords while preserving Enter to send', () => {
    const { result } = renderHook(() => useComposerBindings(), {
      wrapper: createWrapper((snapshot) => {
        snapshot.set(store.shortcutsEnabled, false);
        snapshot.set(store.customShortcuts, {
          submitMessage: { mac: 'Alt+Enter', other: 'Alt+Enter' },
          focusChat: { mac: 'Meta+Shift+Enter', other: 'Control+Shift+Enter' },
        });
      }),
    });
    const context = {
      isComposing: false,
      isSubmitting: false,
      allowSubmitWhileGenerating: false,
      hasDuringRunModifier: false,
      enterToSend: true,
      ...result.current,
    };

    expect(result.current.shortcutsEnabled).toBe(false);
    expect(result.current.submitOverride).toBeNull();
    expect(result.current.yieldedChords).toEqual(new Set());
    expect(
      resolveComposerKeyDown(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
        context,
      ),
    ).toBe('newline');
    expect(
      resolveComposerKeyDown(new KeyboardEvent('keydown', { key: 'Enter', altKey: true }), context),
    ).toBe('newline');
    expect(resolveComposerKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }), context)).toBe(
      'submit',
    );
  });
});
