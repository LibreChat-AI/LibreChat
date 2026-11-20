import React from 'react';
import { getDefaultStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';
import { navigationGenerationAtom } from '~/store/navigation';
import UsePromptButton from '../UsePromptButton';

const mockSubmitPrompt = jest.fn();
const mockRecordUsageMutate = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSubmitMessage: () => ({ submitPrompt: mockSubmitPrompt }),
}));

jest.mock('~/data-provider', () => ({
  useRecordPromptUsage: () => ({ mutate: mockRecordUsageMutate }),
}));

/** Only `conversationId` matters here, the same way `ChatGroupItem.spec.tsx`
 *  mocks it: this test never changes the chat, it bumps the navigation
 *  generation instead. */
const mockConversation = { current: { conversationId: 'convo-1' as string | undefined } };
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation.current }),
}));

jest.mock('../../dialogs/VariableDialog', () => ({
  __esModule: true,
  default: ({ open, promptText }: { open: boolean; promptText?: string }) =>
    open ? <div data-testid="variable-dialog">{promptText}</div> : null,
}));

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Example Group',
    source: 'langfuse',
    ...overrides,
  } as TPromptGroup;
}

function renderButton(chatIndex?: number) {
  return render(
    <MemoryRouter>
      <UsePromptButton group={makeGroup()} promptText="Hello {{name}}" chatIndex={chatIndex} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConversation.current = { conversationId: 'convo-1' };
  getDefaultStore().set(navigationGenerationAtom, 0);
});

describe('UsePromptButton chat-scoped variable dialog', () => {
  it('closes the variable dialog when a navigation starts, for a button rendered inside a chat', async () => {
    const user = userEvent.setup();
    renderButton(0);

    await user.click(screen.getByRole('button', { name: 'com_ui_use_prompt' }));
    expect(await screen.findByTestId('variable-dialog')).toBeInTheDocument();

    act(() => {
      getDefaultStore().set(navigationGenerationAtom, 1);
    });

    await waitFor(() => expect(screen.queryByTestId('variable-dialog')).not.toBeInTheDocument());
  });

  it('leaves the variable dialog open on navigation when there is no associated chat', async () => {
    const user = userEvent.setup();
    renderButton(undefined);

    await user.click(screen.getByRole('button', { name: 'com_ui_use_prompt' }));
    expect(await screen.findByTestId('variable-dialog')).toBeInTheDocument();

    act(() => {
      getDefaultStore().set(navigationGenerationAtom, 1);
    });

    expect(screen.getByTestId('variable-dialog')).toBeInTheDocument();
  });
});
