import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, type MutableSnapshot } from 'recoil';
import { defaultChatSettings, useChatSettings } from '~/Providers/ChatSettingsContext';
import ChatSettingsProvider from '../ChatSettings';
import store from '~/store';

const renderSettings = (initialize?: (snapshot: MutableSnapshot) => void) =>
  renderHook(
    () => ({
      settings: useChatSettings(),
      storedAction: useRecoilValue(store.duringRunDefaultAction),
      visibleArtifacts: useRecoilValue(store.visibleArtifacts),
    }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <RecoilRoot initializeState={initialize}>
          <ChatSettingsProvider>{children}</ChatSettingsProvider>
        </RecoilRoot>
      ),
    },
  );

describe('ChatSettingsProvider', () => {
  it('supplies the stored preferences to the chat', () => {
    const { result } = renderSettings(({ set }) => {
      set(store.duringRunDefaultAction, 'queue');
      set(store.steerInterruptsByDefault, true);
    });

    expect(result.current.settings).toMatchObject({
      duringRunDefaultAction: 'queue',
      steerInterruptsByDefault: true,
    });
  });

  it('writes the during-run default back to the app store', () => {
    const { result } = renderSettings();

    act(() => result.current.settings.setDuringRunDefaultAction('queue'));

    expect(result.current.storedAction).toBe('queue');
    expect(result.current.settings.duringRunDefaultAction).toBe('queue');
  });

  it('closes the artifacts panel through the host', () => {
    const { result } = renderSettings(({ set }) => {
      set(store.visibleArtifacts, { a1: undefined });
    });

    act(() => result.current.settings.resetVisibleArtifacts());

    expect(result.current.visibleArtifacts).toBeNull();
  });

  it('falls back to the stock defaults without a host', () => {
    const { result } = renderHook(() => useChatSettings());

    expect(result.current).toBe(defaultChatSettings);
  });
});
