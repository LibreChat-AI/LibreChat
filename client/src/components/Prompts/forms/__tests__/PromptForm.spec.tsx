import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import { PermissionBits } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import PromptForm from '../PromptForm';

const mockGroup: TPromptGroup = {
  _id: 'group-1',
  name: 'Example Group',
  author: 'user-owner',
  authorName: 'Owner',
  source: 'langfuse',
  sourcePromptName: 'my-langfuse-prompt',
  category: 'general',
  oneliner: 'A one-liner',
  command: 'example-cmd',
} as TPromptGroup;

// Prefixed with `mock` because `jest.mock()` factories may only close over
// out-of-scope variables whose names start with `mock` (enforced by
// babel-plugin-jest-hoist).
const mockAllBits =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

// Mutable so individual tests can exercise the ACL query's loading state.
let mockPermissionsLoading = false;
let mockPermissionBits = mockAllBits;

jest.mock('react-router-dom', () => ({
  useParams: () => ({ promptId: 'group-1' }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => undefined,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { alwaysMakeProd: 'alwaysMakeProd-atom', promptsEditorMode: 'promptsEditorMode-atom' },
}));

jest.mock('~/hooks/Nav/useDrawerViewport', () => ({
  __esModule: true,
  default: () => false,
}));

jest.mock('~/Providers', () => ({
  usePromptGroupsContext: () => ({ hasAccess: true, groupsQuery: { data: undefined } }),
}));

jest.mock('~/data-provider', () => ({
  useGetPrompts: () => ({ data: [], isLoading: false }),
  useGetPromptGroup: () => ({ data: mockGroup, isLoading: false }),
  useAddPromptToGroup: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdatePromptGroup: () => ({ mutate: jest.fn(), isLoading: false, isError: false }),
  useMakePromptProduction: () => ({ mutate: jest.fn(), isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useFocusTrap: () => undefined,
  useHasAccess: () => true,
  // Not mocked wholesale: the real hook runs so `isExternal` is derived from
  // `group.source`, exercising the same logic the app ships.
  usePromptGroupPermissions: jest.requireActual('~/hooks/Prompts/usePromptGroupPermissions')
    .default,
}));

// The real `usePromptGroupPermissions` reads ACL bits through this hook; by
// default it is stubbed with full access so permission outcomes are driven
// only by `group.source`. Tests that need to exercise the loading state
// adjust `mockPermissionsLoading` / `mockPermissionBits` beforehand.
jest.mock('~/hooks/useResourcePermissions', () => ({
  __esModule: true,
  default: () => ({
    hasPermission: (required: number) => (mockPermissionBits & required) === required,
    isLoading: mockPermissionsLoading,
    permissionBits: mockPermissionBits,
  }),
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="open-sidebar" />,
}));

jest.mock('../../editor/PromptEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="prompt-editor" />,
}));

jest.mock('../../display/PromptVariables', () => ({
  __esModule: true,
  default: () => <div data-testid="prompt-variables" />,
}));

jest.mock('../../display/PromptVersions', () => ({
  __esModule: true,
  default: () => <div data-testid="prompt-versions" />,
}));

jest.mock('../../display/PromptDetails', () => ({
  __esModule: true,
  default: () => <div data-testid="prompt-details" />,
}));

jest.mock('../../lists/NoPromptGroup', () => ({
  __esModule: true,
  default: () => <div data-testid="no-prompt-group" />,
}));

jest.mock('../../utils/SkeletonForm', () => ({
  __esModule: true,
  default: () => <div data-testid="skeleton-form" />,
}));

jest.mock('../../dialogs/DeletePrompt', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="delete-prompt" />,
}));

jest.mock('../../dialogs/SharePrompt', () => ({
  __esModule: true,
  default: () => <button type="button" data-testid="share-prompt" />,
}));

jest.mock('../../fields/PromptName', () => ({
  __esModule: true,
  default: ({ name, disabled }: { name?: string; disabled?: boolean }) => (
    <span data-testid="prompt-name" data-disabled={String(Boolean(disabled))}>
      {name}
    </span>
  ),
}));

jest.mock('../../fields/CategorySelector', () => ({
  __esModule: true,
  default: ({ disabled }: { disabled?: boolean }) => (
    <span data-testid="category-selector" data-disabled={String(Boolean(disabled))} />
  ),
}));

jest.mock('../../fields/Description', () => ({
  __esModule: true,
  default: ({ disabled }: { disabled?: boolean }) => (
    <span data-testid="description" data-disabled={String(Boolean(disabled))} />
  ),
}));

jest.mock('../../fields/Command', () => ({
  __esModule: true,
  default: ({ disabled }: { disabled?: boolean }) => (
    <span data-testid="command" data-disabled={String(Boolean(disabled))} />
  ),
}));

describe('PromptForm external (Langfuse) read-only view', () => {
  beforeEach(() => {
    mockGroup.source = 'langfuse';
    mockPermissionsLoading = false;
    mockPermissionBits = mockAllBits;
  });

  it('shows the Langfuse notice, keeps Share, and renders fields read-only without an editor or delete', async () => {
    render(<PromptForm promptId="group-1" />);

    const notice = await screen.findByRole('note');
    expect(notice).toHaveTextContent('com_ui_prompt_langfuse_read_only');
    expect(notice).toHaveTextContent('my-langfuse-prompt');

    expect(screen.getByTestId('share-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-prompt')).not.toBeInTheDocument();

    expect(screen.queryByTestId('prompt-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prompt-versions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /com_ui_deploy|com_ui_production/ })).toBeNull();

    expect(screen.getByTestId('prompt-name')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('category-selector')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('description')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('command')).toHaveAttribute('data-disabled', 'true');
  });

  it('renders the normal editable form (no notice) for a native group', async () => {
    mockGroup.source = 'native';
    render(<PromptForm promptId="group-1" />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(await screen.findByTestId('prompt-name')).toHaveAttribute('data-disabled', 'false');
  });

  it('does not disable the name or category controls for a native group while the ACL query is still loading', async () => {
    mockGroup.source = 'native';
    mockPermissionsLoading = true;
    mockPermissionBits = 0;

    render(<PromptForm promptId="group-1" />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(await screen.findByTestId('prompt-name')).toHaveAttribute('data-disabled', 'false');
    expect(screen.getByTestId('category-selector')).toHaveAttribute('data-disabled', 'false');
  });
});
