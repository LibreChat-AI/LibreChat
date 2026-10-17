import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { PermissionBits } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import ChatGroupItem from '../ChatGroupItem';

const mockMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useRecordPromptUsage: () => ({ mutate: jest.fn() }),
  useDeletePromptGroup: () => ({ mutate: mockMutate, isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useAuthContext: () => ({ user: { id: 'user-owner' } }),
  useSubmitMessage: () => ({ submitPrompt: jest.fn() }),
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));

/** Keeps the real DropdownPopup/Ariakit menu behavior; only the tooltip
 *  popup (framer-motion driven) is stubbed to a plain pass-through. */
jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
  };
});

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Example Group',
    author: 'user-owner',
    authorName: 'Owner',
    source: 'native',
    ...overrides,
  } as TPromptGroup;
}

function renderGroup(group: TPromptGroup, permissionBits: number) {
  return render(
    <MemoryRouter>
      <ChatGroupItem group={group} isChatRoute={false} permissionBits={permissionBits} />
    </MemoryRouter>,
  );
}

const FULL_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

describe('ChatGroupItem menu', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  it('shows Edit and Delete for a native group owned by the caller', async () => {
    const user = userEvent.setup();
    renderGroup(makeGroup(), FULL_BITS);
    await user.click(screen.getByRole('button', { name: 'com_nav_convo_menu_options' }));

    expect(await screen.findByRole('menuitem', { name: /com_ui_edit/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /com_ui_delete/ })).toBeInTheDocument();
  });

  it('hides Edit and Delete for a Langfuse-managed group even with full ACL bits', async () => {
    const user = userEvent.setup();
    renderGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }), FULL_BITS);
    await user.click(screen.getByRole('button', { name: 'com_nav_convo_menu_options' }));

    // Preview always stays available.
    expect(await screen.findByRole('menuitem', { name: /com_ui_preview/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /com_ui_edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /com_ui_delete/ })).not.toBeInTheDocument();
  });

  it('shows a Langfuse badge for an externally managed group', () => {
    renderGroup(makeGroup({ source: 'langfuse', sourcePromptName: 'my-prompt' }), FULL_BITS);
    expect(screen.getByRole('img', { name: 'com_ui_prompt_source_langfuse' })).toBeInTheDocument();
  });

  it('does not show a Langfuse badge for a native group', () => {
    renderGroup(makeGroup(), FULL_BITS);
    expect(
      screen.queryByRole('img', { name: 'com_ui_prompt_source_langfuse' }),
    ).not.toBeInTheDocument();
  });
});
