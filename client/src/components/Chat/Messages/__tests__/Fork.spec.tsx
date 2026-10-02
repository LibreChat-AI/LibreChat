import React from 'react';
import { RecoilRoot } from 'recoil';
import { ForkOptions } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import store from '~/store';
import Fork from '../Fork';

const mockMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useForkConvoMutation: () => ({ mutate: mockMutate }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNavigateToConvo: () => ({ navigateToConvo: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

describe('Fork', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  /** The row holding this button does not re-render when the tail moves, so the
   *  split target is read when the fork starts rather than captured at render. */
  it('sends the tail current at click time as the split target', () => {
    let latestMessageId = 'assistant-2';
    render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.rememberDefaultFork, true);
          set(store.forkSetting, ForkOptions.TARGET_LEVEL);
          set(store.splitAtTarget, true);
        }}
      >
        <Fork
          messageId="user-1"
          conversationId="convo-1"
          forkingSupported={true}
          getLatestMessageId={() => latestMessageId}
        />
      </RecoilRoot>,
    );

    latestMessageId = 'assistant-3';
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_fork_open_menu' }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'user-1',
        splitAtTarget: true,
        latestMessageId: 'assistant-3',
      }),
    );
  });
});
