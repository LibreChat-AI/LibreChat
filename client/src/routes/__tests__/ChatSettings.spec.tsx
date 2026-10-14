import React from 'react';
import { useAtomValue, getDefaultStore } from 'jotai';
import { RetentionMode } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilValue, type MutableSnapshot } from 'recoil';
import type { TStartupConfig, TUser } from 'librechat-data-provider';
import { defaultChatSettings, useChatSettings } from '~/Providers/ChatSettingsContext';
import { duringRunActionAtom } from '~/store/duringRun';
import ChatSettingsProvider from '../ChatSettings';
import store from '~/store';

let mockStartupConfig: Partial<TStartupConfig> | undefined;
let mockUser: TUser | undefined;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: mockUser }),
}));

const renderSettings = (initialize?: (snapshot: MutableSnapshot) => void) =>
  renderHook(
    () => ({
      settings: useChatSettings(),
      storedAction: useAtomValue(duringRunActionAtom),
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
  beforeEach(() => {
    getDefaultStore().set(duringRunActionAtom, 'steer');
    mockStartupConfig = undefined;
    mockUser = undefined;
  });
  it('supplies the stored preferences to the chat', () => {
    const { result } = renderSettings(() => {
      getDefaultStore().set(duringRunActionAtom, 'interrupt');
    });

    expect(result.current.settings).toMatchObject({
      duringRunDefaultAction: 'interrupt',
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

  it('keeps feedback and running-chat rename off until the deployment answers', () => {
    const { result } = renderSettings();

    expect(result.current.settings.config).toEqual({
      feedbackEnabled: false,
      canRenameRunningChat: false,
    });
  });

  it('supplies the deployment config the chat hooks act on', () => {
    const modelSpecs = [{ name: 'spec', label: 'Spec', preset: { endpoint: 'openAI' } }];
    mockStartupConfig = {
      conversationTitleOwnershipVersion: 1,
      modelSpecs: { list: modelSpecs },
      interface: {
        retentionMode: RetentionMode.EPHEMERAL,
        runningChatRename: true,
        queuedSendLockTimeoutMs: 1_000,
        queuedTurnReconciliationTimeoutMs: 2_000,
        steerArmConfirmationTimeoutMs: 3_000,
      },
    } as Partial<TStartupConfig>;

    const { result } = renderSettings();

    expect(result.current.settings.config).toEqual({
      retentionMode: RetentionMode.EPHEMERAL,
      feedbackEnabled: true,
      canRenameRunningChat: true,
      modelSpecs,
      queuedSendLockTimeoutMs: 1_000,
      queuedTurnReconciliationTimeoutMs: 2_000,
      steerArmConfirmationTimeoutMs: 3_000,
    });
  });

  it('turns feedback off when the deployment does', () => {
    mockStartupConfig = { interface: { feedback: false } } as Partial<TStartupConfig>;

    const { result } = renderSettings();

    expect(result.current.settings.config.feedbackEnabled).toBe(false);
  });

  it('supplies the signed-in account', () => {
    mockUser = { id: 'user-1', name: 'Ada' } as TUser;

    const { result } = renderSettings();

    expect(result.current.settings.auth.user).toBe(mockUser);
  });

  it('falls back to the stock defaults without a host', () => {
    const { result } = renderHook(() => useChatSettings());

    expect(result.current).toBe(defaultChatSettings);
  });
});
