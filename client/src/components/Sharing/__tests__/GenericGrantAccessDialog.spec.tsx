import React from 'react';
import { ResourceType } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import GenericGrantAccessDialog from '../GenericGrantAccessDialog';

const mockRefetchPermissions = jest.fn();
const mockUseResourcePermissionState = jest.fn();
const mockUseAuthContext = jest.fn(() => ({ user: { role: 'ADMIN' } }));
const mockUsePeoplePickerPermissions = jest.fn(() => ({
  hasPeoplePickerAccess: true,
  peoplePickerTypeFilter: '' as string | null,
}));
const mockUseCanSharePublic = jest.fn(() => true);

const config = {
  defaultViewerRoleId: 'viewer',
  defaultOwnerRoleId: 'owner',
  getShareMessage: () => 'Share Agent',
  getResourceUrl: () => 'http://localhost/agent/1',
  getCopyUrlMessage: () => 'Copied',
};

const baseState = (overrides: Record<string, unknown> = {}) => ({
  config,
  permissionsData: { principals: [], public: false },
  isLoadingPermissions: false,
  isFetchingPermissions: false,
  permissionsError: null,
  refetchPermissions: mockRefetchPermissions,
  updatePermissionsMutation: { isLoading: false, mutateAsync: jest.fn() },
  currentShares: [],
  currentIsPublic: false,
  currentPublicRole: 'viewer',
  isPublic: false,
  setIsPublic: jest.fn(),
  publicRole: 'viewer',
  setPublicRole: jest.fn(),
  ...overrides,
});

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useLocalize: () => (key: string) => key,
  useResourcePermissionState: () => mockUseResourcePermissionState(),
  usePeoplePickerPermissions: () => mockUsePeoplePickerPermissions(),
  useCanSharePublic: () => mockUseCanSharePublic(),
  useCopyToClipboard: () => jest.fn(),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('../PeoplePicker/UnifiedPeopleSearch', () => ({
  __esModule: true,
  default: () => <div data-testid="unified-people-search" />,
}));
jest.mock('../PeoplePickerAdminSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="admin-settings" />,
}));
jest.mock('../PublicSharingToggle', () => ({
  __esModule: true,
  default: () => <div data-testid="public-toggle" />,
}));
jest.mock('../PeoplePicker', () => ({
  __esModule: true,
  SelectedPrincipalsList: () => <div data-testid="principals-list" />,
}));

const renderDialog = () =>
  render(
    <GenericGrantAccessDialog
      resourceDbId="agent-db-1"
      resourceId="agent-1"
      resourceName="Test Agent"
      resourceType={ResourceType.AGENT}
    />,
  );

describe('GenericGrantAccessDialog - permissions load failure', () => {
  beforeEach(() => {
    mockUseResourcePermissionState.mockReset();
    mockRefetchPermissions.mockReset();
    mockUseAuthContext.mockReturnValue({ user: { role: 'ADMIN' } });
    mockUsePeoplePickerPermissions.mockReturnValue({
      hasPeoplePickerAccess: true,
      peoplePickerTypeFilter: '',
    });
    mockUseCanSharePublic.mockReturnValue(true);
  });

  it('renders a compact alert button (not the share trigger, not raw text) when permissions fail to load', () => {
    mockUseResourcePermissionState.mockReturnValue(
      baseState({ permissionsError: new Error('boom'), permissionsData: undefined }),
    );

    const { container } = renderDialog();

    expect(
      screen.getByRole('button', { name: 'com_ui_permissions_failed_load' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_ui_share_var' })).not.toBeInTheDocument();
    expect(container.querySelector('.spinner')).not.toBeInTheDocument();
  });

  it('retries the permissions fetch when the alert button is clicked', () => {
    mockUseResourcePermissionState.mockReturnValue(
      baseState({ permissionsError: new Error('boom'), permissionsData: undefined }),
    );

    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_permissions_failed_load' }));
    expect(mockRefetchPermissions).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner instead of the alert icon while refetching', () => {
    mockUseResourcePermissionState.mockReturnValue(
      baseState({
        permissionsError: new Error('boom'),
        permissionsData: undefined,
        isFetchingPermissions: true,
      }),
    );

    const { container } = renderDialog();

    expect(
      screen.getByRole('button', { name: 'com_ui_permissions_failed_load' }),
    ).toBeInTheDocument();
    expect(container.querySelector('.spinner')).toBeInTheDocument();
  });

  it('renders the normal share trigger and dialog body when permissions load successfully', () => {
    mockUseResourcePermissionState.mockReturnValue(baseState());

    renderDialog();

    expect(
      screen.queryByRole('button', { name: 'com_ui_permissions_failed_load' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_share_var' }));
    const dialog = screen.getByRole('dialog');

    expect(dialog).toHaveClass('max-w-5xl', 'overflow-hidden', 'p-0');
    expect(
      screen.getByRole('heading', { level: 3, name: 'com_ui_user_group_permissions' }),
    ).toBeInTheDocument();
    expect(screen.getByText('com_ui_share_access_description')).toHaveClass('sr-only');
    expect(screen.getByTestId('unified-people-search').closest('section')).toHaveClass('w-full');
    expect(screen.getByTestId('public-toggle').parentElement).toHaveClass('border-t');
    expect(screen.getByTestId('admin-settings')).toBeInTheDocument();
    expect(dialog.firstElementChild).not.toHaveClass('border-b');
    const saveButton = screen.getByRole('button', { name: 'com_ui_save' });
    const footer = saveButton.parentElement;
    expect(footer).toHaveClass('bg-transparent');
    expect(footer).not.toHaveClass('border-t');
    expect(saveButton).toHaveClass('sm:w-auto');
    expect(saveButton).not.toHaveClass('min-w-[140px]');
    expect(screen.queryByRole('button', { name: 'com_ui_cancel' })).not.toBeInTheDocument();
  });

  it('lets an admin manage agent principals without people picker or public sharing permissions', () => {
    mockUseResourcePermissionState.mockReturnValue(baseState());
    mockUsePeoplePickerPermissions.mockReturnValue({
      hasPeoplePickerAccess: false,
      peoplePickerTypeFilter: null,
    });
    mockUseCanSharePublic.mockReturnValue(false);

    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_share_var' }));

    expect(screen.getByTestId('unified-people-search')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'com_ui_user_group_permissions' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('public-toggle')).not.toBeInTheDocument();
  });

  it('discards the draft through the shared close path', () => {
    const setIsPublic = jest.fn();
    const setPublicRole = jest.fn();
    mockUseResourcePermissionState.mockReturnValue(baseState({ setIsPublic, setPublicRole }));

    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_share_var' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(setIsPublic).toHaveBeenCalledWith(false);
    expect(setPublicRole).toHaveBeenCalledWith('viewer');
  });
});
