import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useSetAtom } from 'jotai';
import { PermissionBits } from 'librechat-data-provider';
import type { TArtifactApp } from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import {
  useDeleteArtifactAppMutation,
  useListArtifactAppsQuery,
  useWithdrawArtifactVersionMutation,
} from '~/data-provider';
import ArtifactAppsList from './ArtifactAppsList';

const mockShowToast = jest.fn();
const mockUseAuthContext = jest.fn(() => ({
  user: { id: 'user-1', role: 'USER', tenantId: undefined as string | undefined },
}));

const getPinnedStorageKey = (userId: string, tenantId = '__default__') =>
  `librechat.pinnedArtifactApps:${tenantId}:${userId}`;
const getViewedStorageKey = (userId: string, tenantId = '__default__') =>
  `librechat.viewedArtifactApps:${tenantId}:${userId}`;

jest.mock('~/data-provider', () => ({
  useDeleteArtifactAppMutation: jest.fn(),
  useListArtifactAppsQuery: jest.fn(),
  useWithdrawArtifactVersionMutation: jest.fn(),
}));

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useSetAtom: jest.fn(),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => mockUseAuthContext(),
  useDebounce: (value: string) => value,
  useHasAccess: () => true,
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const translations: Record<string, string> = {
      com_ui_artifact_apps: 'Artifacts',
      com_ui_artifact_apps_description: 'Artifacts published from your conversations.',
      com_ui_artifact_apps_search_placeholder: 'Search artifacts',
      com_ui_artifact_apps_search_aria: 'Search artifacts',
      com_ui_artifact_apps_clear_search: 'Clear artifact search',
      com_ui_artifact_apps_no_results: 'No artifacts found',
      com_ui_artifact_apps_no_results_hint: 'Try a different name, description, category, or tag.',
      com_ui_artifact_apps_load_error: "Couldn't load artifacts.",
      com_ui_artifact_apps_refresh_error:
        "Couldn't update the artifact catalog. Your loaded artifacts are still available.",
      com_ui_artifact_catalog_filters: 'Artifact catalog filters',
      com_ui_artifact_scope_personal: 'Personal',
      com_ui_artifact_scope_shared: 'Shared',
      com_ui_artifact_scope_all: 'All',
      com_ui_artifact_shared_with_you: 'Shared with you',
      com_ui_artifact_link_copied: 'Artifact link copied',
      com_ui_artifact_delete: 'Delete artifact?',
      com_ui_artifact_delete_confirm: `Delete "${values?.[0] ?? ''}"? This action cannot be undone.`,
      com_ui_artifact_delete_error: "Couldn't delete the artifact. Try again.",
      com_ui_artifact_delete_success: 'Artifact deleted',
      com_ui_artifact_withdraw: 'Withdraw active version?',
      com_ui_artifact_withdraw_confirm: `Withdraw the active version of "${values?.[0] ?? ''}"?`,
      com_ui_artifact_withdraw_error: "Couldn't withdraw the active version. Try again.",
      com_ui_artifact_withdraw_success: 'Active version withdrawn',
      com_ui_artifact_apps_view_mode: 'Artifact view mode',
      com_ui_artifact_apps_list_view: 'List view',
      com_ui_artifact_apps_grid_view: 'Grid view',
      com_ui_artifact_app_preview: 'Artifact preview',
      com_ui_artifact_app_preview_unavailable: 'Preview unavailable',
      com_ui_artifact_activity_just_now: 'just now',
      com_ui_copy_failed: 'Failed to copy to clipboard',
      com_ui_copy_link: 'Copy link',
      com_ui_delete: 'Delete',
      com_ui_withdraw: 'Withdraw',
      com_ui_share: 'Share',
      com_ui_options: 'options',
      com_ui_pin: 'Pin',
      com_ui_pinned: 'Pinned',
      com_ui_unpin: 'Unpin',
      com_ui_unpinned: 'Unpinned',
      com_ui_retry: 'Retry',
    };
    if (key === 'com_ui_artifact_app_version_number') {
      return `v${values?.[0] ?? ''}`;
    }
    if (key === 'com_ui_artifact_activity_edited') {
      return `edited ${values?.[0] ?? ''}`;
    }
    if (key === 'com_ui_artifact_activity_viewed') {
      return `viewed ${values?.[0] ?? ''}`;
    }
    if (key === 'com_ui_artifact_activity_minutes_ago') {
      return `${values?.[0] ?? ''}m ago`;
    }
    if (key === 'com_ui_artifact_activity_hours_ago') {
      return `${values?.[0] ?? ''}h ago`;
    }
    return translations[key] ?? key;
  },
}));

jest.mock('@librechat/client', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');

  return {
    ...jest.requireActual('@librechat/client'),
    DropdownPopup: ({ trigger, items }: { trigger: React.ReactNode; items: MenuItemProps[] }) => {
      const label = ReactModule.isValidElement<{ 'aria-label'?: string }>(trigger)
        ? trigger.props['aria-label']
        : undefined;

      return (
        <div>
          <button type="button" aria-label={label}>
            {label}
          </button>
          {items
            .filter((item) => item.show !== false)
            .map((item) =>
              item.separate ? (
                <hr key={item.id} />
              ) : (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.ariaChecked}
                  className={item.className}
                  onClick={(event) => item.onClick?.(event)}
                >
                  {item.label}
                </button>
              ),
            )}
        </div>
      );
    },
    useMediaQuery: () => false,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/components/Chat/Menus/OpenSidebar', () => () => null);
jest.mock('./ArtifactAppsAdminSettings', () => () => <button data-testid="mock-admin-settings" />);
jest.mock('./Thumbnail', () => ({ app }: { app: TArtifactApp }) => (
  <div data-testid="artifact-thumbnail">{app.preview?.imageUrl}</div>
));

jest.mock('~/components/Sharing', () => ({
  GenericGrantAccessDialog: ({
    resourceId,
    children,
  }: {
    resourceId?: string;
    children?: React.ReactNode;
  }) => <div data-testid={`artifact-share-dialog-${resourceId ?? 'unknown'}`}>{children}</div>,
}));

const mockUseListArtifactAppsQuery = jest.mocked(useListArtifactAppsQuery);
const mockUseDeleteArtifactAppMutation = jest.mocked(useDeleteArtifactAppMutation);
const mockUseWithdrawArtifactVersionMutation = jest.mocked(useWithdrawArtifactVersionMutation);
const mockSetArtifactNavigationRequest = jest.fn();
const mockDeleteArtifact = jest.fn();
const mockWithdrawVersion = jest.fn();

type ArtifactAppsListQueryResult = ReturnType<typeof useListArtifactAppsQuery>;
type ArtifactAppsListSuccessResult = Extract<ArtifactAppsListQueryResult, { status: 'success' }>;

function makeListQueryResult(
  overrides: Partial<ArtifactAppsListSuccessResult> = {},
): ArtifactAppsListSuccessResult {
  return {
    data: { pages: [{ apps, has_more: false, after: null }], pageParams: [undefined] },
    dataUpdatedAt: 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    fetchNextPage: jest.fn(),
    fetchPreviousPage: jest.fn(),
    fetchStatus: 'idle',
    hasNextPage: false,
    hasPreviousPage: false,
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchingPreviousPage: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPlaceholderData: false,
    isPreviousData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    refetch: jest.fn(),
    remove: jest.fn(),
    status: 'success',
    ...overrides,
  };
}

const apps = [
  {
    id: 'db-quarterly-report',
    artifactAppId: 'quarterly-report',
    createdBy: 'user-1',
    title: 'Quarterly Report',
    description: 'Revenue summary',
    category: 'Finance',
    tags: ['forecast'],
    preview: {
      type: 'image',
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Preview of Quarterly Report',
    },
    latestVersionNumber: 2,
    activeVersionId: 'quarterly-version-2',
    status: 'published',
    visibility: 'private',
    createdAt: '2026-08-20T09:00:00Z',
    updatedAt: '2026-08-20T10:00:00Z',
    sourceMetadata: {
      conversationId: 'conversation-1',
      messageId: 'message-2',
      originalArtifactId: 'artifact-revision-2',
      sourceKey: 'identifier:quarterly-report',
    },
  },
  {
    id: 'db-team-planner',
    artifactAppId: 'team-planner',
    createdBy: 'user-2',
    title: 'Team Planner',
    description: 'Coordinate delivery work',
    category: 'Planning',
    tags: ['schedule'],
    latestVersionNumber: 1,
    status: 'draft',
    visibility: 'tenant',
    createdAt: '2026-08-19T08:00:00Z',
    updatedAt: '2026-08-19T09:00:00Z',
  },
] as TArtifactApp[];

describe('ArtifactAppsList', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    jest.mocked(useSetAtom).mockReturnValue(mockSetArtifactNavigationRequest);
    window.history.replaceState({}, '', '/apps');
    window.localStorage.clear();
    mockShowToast.mockClear();
    mockUseAuthContext.mockReturnValue({
      user: { id: 'user-1', role: 'USER', tenantId: undefined },
    });
    mockUseListArtifactAppsQuery.mockReturnValue(makeListQueryResult());
    mockUseDeleteArtifactAppMutation.mockReturnValue({
      mutate: mockDeleteArtifact,
      isLoading: false,
    } as unknown as ReturnType<typeof useDeleteArtifactAppMutation>);
    mockDeleteArtifact.mockReset();
    mockUseWithdrawArtifactVersionMutation.mockReturnValue({
      mutate: mockWithdrawVersion,
      isLoading: false,
    } as unknown as ReturnType<typeof useWithdrawArtifactVersionMutation>);
    mockWithdrawVersion.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders a Marketplace-style heading, search field, and admin settings action', () => {
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search artifacts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Personal' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByTestId('mock-admin-settings')).not.toHaveLength(0);
  });

  it('uses stored preview thumbnails in grid view', () => {
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));

    expect(screen.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(window.localStorage.getItem('librechat.artifactAppsViewMode')).toBe('grid');
    expect(screen.getAllByTestId('artifact-thumbnail')[0]).toHaveTextContent(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
    expect(screen.queryByRole('img', { name: 'Preview of Quarterly Report' })).toBeNull();
    expect(screen.getAllByRole('list')[0]).toHaveClass(
      'grid-cols-1',
      'md:grid-cols-2',
      'lg:grid-cols-3',
    );
    expect(screen.getAllByText('Personal')[1].parentElement?.parentElement).toHaveClass('mt-3');

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.queryByTestId('artifact-thumbnail')).toBeNull();
  });

  it('sends metadata search to the paginated server query', () => {
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    const search = screen.getByRole('textbox', { name: 'Search artifacts' });
    fireEvent.change(search, { target: { value: 'forecast' } });

    expect(mockUseListArtifactAppsQuery).toHaveBeenLastCalledWith('personal', 'forecast');
  });

  it('requests the selected catalog scope', () => {
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Shared' }));
    expect(mockUseListArtifactAppsQuery).toHaveBeenLastCalledWith('shared', '');
  });

  it('loads the next cursor page on request', () => {
    const fetchNextPage = jest.fn();
    mockUseListArtifactAppsQuery.mockReturnValue({
      ...makeListQueryResult(),
      fetchNextPage,
      hasNextPage: true,
    });
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('shows a retry action when the initial catalog request fails', () => {
    const refetch = jest.fn();
    mockUseListArtifactAppsQuery.mockReturnValue({
      ...makeListQueryResult(),
      data: undefined,
      error: new Error('catalog unavailable'),
      isError: true,
      isLoading: false,
      isLoadingError: true,
      isSuccess: false,
      refetch,
      status: 'error',
    } as ReturnType<typeof useListArtifactAppsQuery>);

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load artifacts.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('preserves loaded catalog content and retry when a later request fails', () => {
    const refetch = jest.fn();
    mockUseListArtifactAppsQuery.mockReturnValue({
      ...makeListQueryResult(),
      error: new Error('next page unavailable'),
      isError: true,
      isLoadingError: false,
      isRefetchError: true,
      isSuccess: false,
      refetch,
      status: 'error',
    } as ReturnType<typeof useListArtifactAppsQuery>);

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByText('Quarterly Report')).toBeInTheDocument();
    expect(screen.getByText('Team Planner')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't update the artifact catalog. Your loaded artifacts are still available.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('offers retry instead of an empty state when an empty cached catalog refresh fails', () => {
    const refetch = jest.fn();
    const data = { pages: [{ apps: [], has_more: false, after: null }], pageParams: [undefined] };
    mockUseListArtifactAppsQuery.mockReturnValue({
      ...makeListQueryResult(),
      data,
      error: new Error('refresh unavailable'),
      isError: true,
      isLoadingError: false,
      isRefetchError: true,
      isSuccess: false,
      refetch,
      status: 'error',
    } as ReturnType<typeof useListArtifactAppsQuery>);

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't update the artifact catalog. Your loaded artifacts are still available.",
    );
    expect(screen.queryByText('No artifacts yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows per-artifact actions for pinning and copying links', () => {
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByRole('button', { name: 'options: Quarterly Report' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy link' })[0]);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      new URL('/apps/quarterly-report', window.location.origin).toString(),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Pin' })[1]);

    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(1);
    expect(screen.queryByTestId('artifact-share-dialog-quarterly-report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-share-dialog-team-planner')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(screen.getByTestId('artifact-share-dialog-quarterly-report')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-share-dialog-team-planner')).not.toBeInTheDocument();

    expect(window.localStorage.getItem(getPinnedStorageKey('user-1'))).toBe('["team-planner"]');

    const openButtons = screen.getAllByRole('button', {
      name: /Quarterly Report|Team Planner/,
    });
    expect(openButtons[0]).toHaveTextContent('Team Planner');
    expect(screen.getByRole('button', { name: 'Unpin' })).toHaveAttribute('aria-pressed', 'true');
    expect(mockShowToast).toHaveBeenLastCalledWith({ status: 'success', message: 'Pinned' });

    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));

    expect(mockShowToast).toHaveBeenLastCalledWith({ status: 'info', message: 'Unpinned' });
  });

  it('deletes an owned artifact after confirmation', () => {
    mockDeleteArtifact.mockImplementation((_artifactAppId, options) =>
      options?.onSuccess?.({
        success: true,
      }),
    );
    window.localStorage.setItem(getPinnedStorageKey('user-1'), '["quarterly-report"]');
    window.localStorage.setItem(
      getViewedStorageKey('user-1'),
      JSON.stringify({ 'quarterly-report': '2026-08-20T11:45:00Z' }),
    );

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('text-text-destructive');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete artifact?')).toBeInTheDocument();
    expect(
      screen.getByText('Delete "Quarterly Report"? This action cannot be undone.'),
    ).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete'));

    expect(mockDeleteArtifact).toHaveBeenCalledWith(
      'quarterly-report',
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(window.localStorage.getItem(getPinnedStorageKey('user-1'))).toBe('[]');
    expect(window.localStorage.getItem(getViewedStorageKey('user-1'))).toBe('{}');
    expect(mockShowToast).toHaveBeenLastCalledWith({
      status: 'success',
      message: 'Artifact deleted',
    });
  });

  it('shows delete only when the viewer owns the artifact or has DELETE permission', () => {
    mockUseListArtifactAppsQuery.mockReturnValue(
      makeListQueryResult({
        data: {
          pages: [
            {
              apps: [
                apps[1],
                { ...apps[1], artifactAppId: 'deletable', permissionBits: PermissionBits.DELETE },
              ],
              has_more: false,
              after: null,
            },
          ],
          pageParams: [undefined],
        },
      }),
    );

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('withdraws the active version of an owned artifact after confirmation', () => {
    mockWithdrawVersion.mockImplementation((_variables, options) => options?.onSuccess?.());

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(
      screen.getByText('Withdraw the active version of "Quarterly Report"?'),
    ).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('dialog')).getByText('Withdraw'));

    expect(mockWithdrawVersion).toHaveBeenCalledWith(
      { artifactAppId: 'quarterly-report', versionId: 'quarterly-version-2' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
    expect(mockShowToast).toHaveBeenLastCalledWith({
      status: 'success',
      message: 'Active version withdrawn',
    });
  });

  it('shows withdraw only when the viewer can manage the version and one is active', () => {
    mockUseListArtifactAppsQuery.mockReturnValue(
      makeListQueryResult({
        data: {
          pages: [
            {
              apps: [
                apps[1],
                {
                  ...apps[1],
                  artifactAppId: 'withdrawable',
                  activeVersionId: 'withdrawable-version-1',
                  permissionBits: PermissionBits.EDIT,
                },
              ],
              has_more: false,
              after: null,
            },
          ],
          pageParams: [undefined],
        },
      }),
    );

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.queryAllByRole('button', { name: 'Withdraw' })).toHaveLength(1);
  });

  it('shows recent activity as ago text and older activity as a date', () => {
    window.localStorage.setItem(
      getViewedStorageKey('user-1'),
      JSON.stringify({ 'team-planner': '2026-08-20T11:45:00Z' }),
    );

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    expect(screen.getByText(/v2 · edited 2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/v1 · edited Aug 19 · viewed 15m ago/)).toBeInTheDocument();
  });

  it('rehydrates pinned and viewed activity when the authenticated identity changes', () => {
    mockUseAuthContext.mockReturnValue({
      user: { id: 'user-1', role: 'USER', tenantId: 'tenant-1' },
    });
    window.localStorage.setItem(getPinnedStorageKey('user-1', 'tenant-1'), '["team-planner"]');
    window.localStorage.setItem(
      getViewedStorageKey('user-1', 'tenant-1'),
      JSON.stringify({ 'team-planner': '2026-08-20T11:45:00Z' }),
    );
    window.localStorage.setItem(getPinnedStorageKey('user-2', 'tenant-1'), '["quarterly-report"]');
    window.localStorage.setItem(
      getViewedStorageKey('user-2', 'tenant-1'),
      JSON.stringify({ 'quarterly-report': '2026-08-20T11:30:00Z' }),
    );

    const renderCatalog = () => (
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>
    );
    const { rerender } = render(renderCatalog());

    expect(
      screen.getAllByRole('button', { name: /Quarterly Report|Team Planner/ })[0],
    ).toHaveTextContent('Team Planner');
    expect(screen.getByText(/v1 · edited Aug 19 · viewed 15m ago/)).toBeInTheDocument();

    mockUseAuthContext.mockReturnValue({
      user: { id: 'user-2', role: 'USER', tenantId: 'tenant-1' },
    });
    rerender(renderCatalog());

    expect(
      screen.getAllByRole('button', { name: /Quarterly Report|Team Planner/ })[0],
    ).toHaveTextContent('Quarterly Report');
    expect(screen.queryByText(/viewed 15m ago/)).not.toBeInTheDocument();
    expect(screen.getByText(/v2 · edited 2h ago · viewed 30m ago/)).toBeInTheDocument();
  });

  it('keeps cursor pagination available while filtering loaded artifacts', () => {
    const fetchNextPage = jest.fn();
    mockUseListArtifactAppsQuery.mockReturnValue({
      ...makeListQueryResult(),
      fetchNextPage,
      hasNextPage: true,
    });
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search artifacts' }), {
      target: { value: 'artifact on a later page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));

    expect(screen.queryByText('No artifacts found')).not.toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('opens an owned artifact at its latest stored revision', () => {
    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    const reportButton = screen.getByText('Quarterly Report').closest('button');
    expect(reportButton).not.toBeNull();

    fireEvent.click(reportButton as HTMLButtonElement);

    const viewed = JSON.parse(
      window.localStorage.getItem(getViewedStorageKey('user-1')) ?? '{}',
    ) as Record<string, string>;
    expect(viewed['quarterly-report']).toBe('2026-08-20T12:00:00.000Z');
    expect(window.location.pathname).toBe('/c/conversation-1');
    expect(new URLSearchParams(window.location.search).get('artifact')).toBe(
      'identifier:quarterly-report',
    );
    expect(new URLSearchParams(window.location.search).get('artifactId')).toBe(
      'artifact-revision-2',
    );
    expect(mockSetArtifactNavigationRequest).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceKey: 'identifier:quarterly-report',
      originalArtifactId: 'artifact-revision-2',
      messageId: 'message-2',
    });
  });

  it('opens an artifact in the standalone viewer after its source conversation is detached', () => {
    const { conversationId: _deletedConversationId, ...detachedSourceMetadata } =
      apps[0].sourceMetadata ?? {};
    const detachedApp = { ...apps[0], sourceMetadata: detachedSourceMetadata };
    mockUseListArtifactAppsQuery.mockReturnValue(
      makeListQueryResult({
        data: {
          pages: [{ apps: [detachedApp], has_more: false, after: null }],
          pageParams: [undefined],
        },
      }),
    );

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByText('Quarterly Report').closest('button') as HTMLButtonElement);

    expect(window.location.pathname).toBe('/apps/quarterly-report');
    expect(mockSetArtifactNavigationRequest).not.toHaveBeenCalled();
  });

  it('exposes share for a catalog artifact whose list entry already includes SHARE', () => {
    mockUseListArtifactAppsQuery.mockReturnValue(
      makeListQueryResult({
        data: {
          pages: [
            {
              apps: [{ ...apps[1], permissionBits: PermissionBits.SHARE }],
              has_more: false,
              after: null,
            },
          ],
          pageParams: [undefined],
        },
      }),
    );

    render(
      <BrowserRouter>
        <ArtifactAppsList />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(screen.getByTestId('artifact-share-dialog-team-planner')).toBeInTheDocument();
  });
});
