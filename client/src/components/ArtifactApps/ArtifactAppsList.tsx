import { useEffect, useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import * as Ariakit from '@ariakit/react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Shapes,
  Lock,
  Users,
  Pin,
  Link,
  Share2,
  Ellipsis,
  PinOff,
  LayoutGrid,
  List,
  Trash2,
  FolderMinus,
} from 'lucide-react';
import {
  Button,
  DropdownPopup,
  OGDialog,
  OGDialogTemplate,
  Spinner,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import {
  SystemRoles,
  PermissionBits,
  hasPermissions,
  type TArtifactApp,
  type ArtifactAppListScope,
} from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import {
  useDeleteArtifactAppMutation,
  useListArtifactAppsQuery,
  useWithdrawArtifactVersionMutation,
} from '~/data-provider';
import ArtifactAppShareDialog, { useCanShareArtifactApp } from './Share';
import ArtifactAppsAdminSettings from './ArtifactAppsAdminSettings';
import { useAuthContext, useDebounce, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { artifactNavigationRequestAtom } from './navigation';
import ArtifactAppsSearchBar from './ArtifactAppsSearchBar';
import Thumbnail from './Thumbnail';
import { cn } from '~/utils';

const PINNED_ARTIFACT_APPS_KEY = 'librechat.pinnedArtifactApps';
const VIEWED_ARTIFACT_APPS_KEY = 'librechat.viewedArtifactApps';
const ARTIFACT_APPS_VIEW_MODE_KEY = 'librechat.artifactAppsViewMode';
const RECENT_ACTIVITY_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const SCOPES: ArtifactAppListScope[] = ['personal', 'shared', 'all'];
const SCOPE_LABELS = {
  personal: 'com_ui_artifact_scope_personal',
  shared: 'com_ui_artifact_scope_shared',
  all: 'com_ui_artifact_scope_all',
} as const;
type ArtifactAppsViewMode = 'list' | 'grid';
type ScopedArtifactActivity<T> = {
  scope: string | null;
  value: T;
};

const EMPTY_PINNED_ARTIFACT_IDS = new Set<string>();
const EMPTY_VIEWED_ARTIFACT_TIMES = new Map<string, string>();

function getArtifactActivityStorageScope(userId?: string, tenantId?: string) {
  if (!userId) {
    return null;
  }

  return `${encodeURIComponent(tenantId ?? '__default__')}:${encodeURIComponent(userId)}`;
}

function getScopedArtifactActivityKey(baseKey: string, scope: string | null) {
  return scope ? `${baseKey}:${scope}` : null;
}

function readArtifactAppsViewMode(): ArtifactAppsViewMode {
  if (typeof window === 'undefined') {
    return 'list';
  }

  try {
    const stored = window.localStorage.getItem(ARTIFACT_APPS_VIEW_MODE_KEY);
    return stored === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

function writeArtifactAppsViewMode(viewMode: ArtifactAppsViewMode) {
  try {
    window.localStorage.setItem(ARTIFACT_APPS_VIEW_MODE_KEY, viewMode);
  } catch {
    // View mode is a local preference; unavailable storage should not block the catalog.
  }
}

function readPinnedArtifactApps(scope: string | null) {
  const storageKey = getScopedArtifactActivityKey(PINNED_ARTIFACT_APPS_KEY, scope);
  if (typeof window === 'undefined' || !storageKey) {
    return new Set<string>();
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function writePinnedArtifactApps(scope: string | null, pinnedIds: Set<string>) {
  const storageKey = getScopedArtifactActivityKey(PINNED_ARTIFACT_APPS_KEY, scope);
  if (!storageKey) {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...pinnedIds]));
  } catch {
    // Pinning is a local convenience; unavailable storage should not block the catalog.
  }
}

function readViewedArtifactApps(scope: string | null) {
  const storageKey = getScopedArtifactActivityKey(VIEWED_ARTIFACT_APPS_KEY, scope);
  if (typeof window === 'undefined' || !storageKey) {
    return new Map<string, string>();
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map<string, string>();
    }
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    );
  } catch {
    return new Map<string, string>();
  }
}

function writeViewedArtifactApps(scope: string | null, viewedAtById: Map<string, string>) {
  const storageKey = getScopedArtifactActivityKey(VIEWED_ARTIFACT_APPS_KEY, scope);
  if (!storageKey) {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(viewedAtById)));
  } catch {
    // Viewed timestamps are a local convenience; unavailable storage should not block opening.
  }
}

function getArtifactAppUrl(artifactAppId: string) {
  const path = `/apps/${artifactAppId}`;
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
}

function formatArtifactActivityDate(
  value: string | undefined,
  verb: 'edited' | 'viewed',
  localize: ReturnType<typeof useLocalize>,
  locale?: string,
) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return null;
  }

  const now = Date.now();
  const age = now - time;
  const verbKey =
    verb === 'edited' ? 'com_ui_artifact_activity_edited' : 'com_ui_artifact_activity_viewed';
  let activity: string;
  if (age > RECENT_ACTIVITY_THRESHOLD_MS) {
    activity = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  } else if (age < 60_000) {
    activity = localize('com_ui_artifact_activity_just_now');
  } else if (age < 60 * 60_000) {
    activity = localize('com_ui_artifact_activity_minutes_ago', {
      0: String(Math.floor(age / 60_000)),
    });
  } else {
    activity = localize('com_ui_artifact_activity_hours_ago', {
      0: String(Math.floor(age / (60 * 60_000))),
    });
  }

  return localize(verbKey, { 0: activity });
}

function ArtifactAppsViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: ArtifactAppsViewMode;
  onChange: (viewMode: ArtifactAppsViewMode) => void;
}) {
  const localize = useLocalize();
  const items: Array<{ mode: ArtifactAppsViewMode; label: string; icon: typeof List }> = [
    { mode: 'list', label: localize('com_ui_artifact_apps_list_view'), icon: List },
    { mode: 'grid', label: localize('com_ui_artifact_apps_grid_view'), icon: LayoutGrid },
  ];

  return (
    <div
      className="flex shrink-0 rounded-xl bg-surface-secondary p-1"
      aria-label={localize('com_ui_artifact_apps_view_mode')}
    >
      {items.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          type="button"
          aria-label={label}
          aria-pressed={viewMode === mode}
          title={label}
          onClick={() => onChange(mode)}
          className={cn(
            'focus-visible:ring-ring inline-flex size-9 items-center justify-center rounded-lg text-text-secondary transition-colors focus:outline-none focus-visible:ring-2',
            viewMode === mode
              ? 'bg-surface-primary text-text-primary shadow-sm'
              : 'hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function ArtifactAppMenu({
  app,
  isPinned,
  onTogglePin,
  onDeleted,
}: {
  app: TArtifactApp;
  isPinned: boolean;
  onTogglePin: (artifactAppId: string) => void;
  onDeleted: (artifactAppId: string) => void;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const canShare = useCanShareArtifactApp(app);
  const canDelete =
    app.createdBy === user?.id ||
    user?.role === SystemRoles.ADMIN ||
    hasPermissions(app.permissionBits ?? 0, PermissionBits.DELETE);
  const canManageVersion =
    app.createdBy === user?.id ||
    user?.role === SystemRoles.ADMIN ||
    hasPermissions(app.permissionBits ?? 0, PermissionBits.EDIT);
  const canWithdraw = canManageVersion && Boolean(app.activeVersionId);
  const deleteArtifact = useDeleteArtifactAppMutation();
  const withdrawVersion = useWithdrawArtifactVersionMutation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(getArtifactAppUrl(app.artifactAppId));
      showToast({ status: 'success', message: localize('com_ui_artifact_link_copied') });
    } catch {
      showToast({ status: 'error', message: localize('com_ui_copy_failed') });
    }
  };

  const items: MenuItemProps[] = [
    {
      id: `artifact-pin-${app.artifactAppId}`,
      label: localize(isPinned ? 'com_ui_unpin' : 'com_ui_pin'),
      icon: isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
      ariaChecked: isPinned,
      onClick: () => onTogglePin(app.artifactAppId),
    },
    {
      id: `artifact-copy-link-${app.artifactAppId}`,
      label: localize('com_ui_copy_link'),
      icon: <Link className="size-4" />,
      onClick: () => void copyLink(),
    },
  ];

  if (canShare) {
    items.push({
      id: `artifact-share-${app.artifactAppId}`,
      label: localize('com_ui_share'),
      icon: <Share2 className="size-4" />,
      onClick: () => setShareOpen(true),
    });
  }

  if (canWithdraw) {
    items.push({
      id: `artifact-withdraw-${app.artifactAppId}`,
      label: localize('com_ui_withdraw'),
      icon: <FolderMinus className="size-4" />,
      onClick: () => setWithdrawOpen(true),
    });
  }

  if (canDelete) {
    items.push({ id: `artifact-delete-separator-${app.artifactAppId}`, separate: true });
    items.push({
      id: `artifact-delete-${app.artifactAppId}`,
      label: localize('com_ui_delete'),
      icon: <Trash2 className="size-4" />,
      className:
        'text-text-destructive hover:bg-destructive/10 hover:text-text-destructive focus:bg-destructive/10 focus:text-text-destructive',
      onClick: () => setDeleteOpen(true),
    });
  }

  const confirmDelete = () => {
    if (deleteArtifact.isLoading) {
      return;
    }
    deleteArtifact.mutate(app.artifactAppId, {
      onSuccess: () => {
        onDeleted(app.artifactAppId);
        setDeleteOpen(false);
        showToast({ status: 'success', message: localize('com_ui_artifact_delete_success') });
      },
      onError: () => {
        showToast({ status: 'error', message: localize('com_ui_artifact_delete_error') });
      },
    });
  };

  const confirmWithdraw = () => {
    if (withdrawVersion.isLoading || !app.activeVersionId) {
      return;
    }
    withdrawVersion.mutate(
      { artifactAppId: app.artifactAppId, versionId: app.activeVersionId },
      {
        onSuccess: () => {
          setWithdrawOpen(false);
          showToast({ status: 'success', message: localize('com_ui_artifact_withdraw_success') });
        },
        onError: () => {
          showToast({ status: 'error', message: localize('com_ui_artifact_withdraw_error') });
        },
      },
    );
  };

  return (
    <>
      {shareOpen && (
        <ArtifactAppShareDialog
          app={app}
          defaultOpen
          onOpenChange={(open) => {
            if (!open) {
              setShareOpen(false);
            }
          }}
        />
      )}
      <OGDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_artifact_delete')}
          className="max-w-[450px]"
          main={
            <p className="text-left text-sm text-text-primary">
              {localize('com_ui_artifact_delete_confirm', { 0: app.title })}
            </p>
          }
          selection={
            <Button
              variant="destructive"
              disabled={deleteArtifact.isLoading}
              onClick={confirmDelete}
            >
              {deleteArtifact.isLoading ? (
                <Spinner className="size-4" />
              ) : (
                localize('com_ui_delete')
              )}
            </Button>
          }
        />
      </OGDialog>
      <OGDialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_artifact_withdraw')}
          className="max-w-[450px]"
          main={
            <p className="text-left text-sm text-text-primary">
              {localize('com_ui_artifact_withdraw_confirm', { 0: app.title })}
            </p>
          }
          selection={
            <Button disabled={withdrawVersion.isLoading} onClick={confirmWithdraw}>
              {withdrawVersion.isLoading ? (
                <Spinner className="size-4" />
              ) : (
                localize('com_ui_withdraw')
              )}
            </Button>
          }
        />
      </OGDialog>
      <DropdownPopup
        portal={true}
        menuId={`artifact-menu-${app.artifactAppId}`}
        focusLoop={true}
        className="z-[125]"
        unmountOnHide={true}
        isOpen={menuOpen}
        setIsOpen={setMenuOpen}
        trigger={
          <Ariakit.MenuButton
            aria-label={`${localize('com_ui_options')}: ${app.title}`}
            className={cn(
              'focus-visible:ring-ring inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors focus:outline-none focus-visible:ring-2 group-hover/artifact:bg-surface-primary group-hover/artifact:text-text-primary',
              menuOpen && 'bg-surface-primary text-text-primary',
            )}
          >
            <Ellipsis className="size-5" aria-hidden="true" />
          </Ariakit.MenuButton>
        }
        items={items}
      />
    </>
  );
}

export default function ArtifactAppsList() {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const setArtifactNavigationRequest = useSetAtom(artifactNavigationRequestAtom);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [searchQuery, setSearchQuery] = useState('');
  const [scope, setScope] = useState<ArtifactAppListScope>('personal');
  const activityStorageScope = getArtifactActivityStorageScope(user?.id, user?.tenantId);
  const [pinnedArtifactState, setPinnedArtifactState] = useState<
    ScopedArtifactActivity<Set<string>>
  >(() => ({
    scope: activityStorageScope,
    value: readPinnedArtifactApps(activityStorageScope),
  }));
  const [viewedArtifactState, setViewedArtifactState] = useState<
    ScopedArtifactActivity<Map<string, string>>
  >(() => ({
    scope: activityStorageScope,
    value: readViewedArtifactApps(activityStorageScope),
  }));
  const [viewMode, setViewMode] = useState<ArtifactAppsViewMode>(readArtifactAppsViewMode);
  const debouncedSearchQuery = useDebounce(searchQuery.trim(), 300);
  const {
    data,
    isError,
    isLoading,
    isFetching,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useListArtifactAppsQuery(scope, debouncedSearchQuery);
  const pinnedArtifactIds =
    pinnedArtifactState.scope === activityStorageScope
      ? pinnedArtifactState.value
      : EMPTY_PINNED_ARTIFACT_IDS;
  const viewedArtifactTimes =
    viewedArtifactState.scope === activityStorageScope
      ? viewedArtifactState.value
      : EMPTY_VIEWED_ARTIFACT_TIMES;
  const loadedApps = useMemo(() => data?.pages.flatMap((page) => page.apps) ?? [], [data]);
  const apps = useMemo(() => {
    return [...loadedApps].sort((first, second) => {
      const firstPinned = pinnedArtifactIds.has(first.artifactAppId);
      const secondPinned = pinnedArtifactIds.has(second.artifactAppId);
      return Number(secondPinned) - Number(firstPinned);
    });
  }, [loadedApps, pinnedArtifactIds]);

  useEffect(() => {
    setPinnedArtifactState({
      scope: activityStorageScope,
      value: readPinnedArtifactApps(activityStorageScope),
    });
    setViewedArtifactState({
      scope: activityStorageScope,
      value: readViewedArtifactApps(activityStorageScope),
    });
  }, [activityStorageScope]);

  const togglePinnedArtifact = (artifactAppId: string) => {
    const next = new Set(pinnedArtifactIds);
    const pinned = next.has(artifactAppId);
    if (pinned) {
      next.delete(artifactAppId);
    } else {
      next.add(artifactAppId);
    }
    writePinnedArtifactApps(activityStorageScope, next);
    setPinnedArtifactState({ scope: activityStorageScope, value: next });
    showToast({
      status: pinned ? 'info' : 'success',
      message: localize(pinned ? 'com_ui_unpinned' : 'com_ui_pinned'),
    });
  };

  const removeDeletedArtifactActivity = (artifactAppId: string) => {
    const nextPinnedIds = new Set(pinnedArtifactIds);
    nextPinnedIds.delete(artifactAppId);
    writePinnedArtifactApps(activityStorageScope, nextPinnedIds);
    setPinnedArtifactState({ scope: activityStorageScope, value: nextPinnedIds });

    const nextViewedTimes = new Map(viewedArtifactTimes);
    nextViewedTimes.delete(artifactAppId);
    writeViewedArtifactApps(activityStorageScope, nextViewedTimes);
    setViewedArtifactState({ scope: activityStorageScope, value: nextViewedTimes });
  };

  const changeViewMode = (nextViewMode: ArtifactAppsViewMode) => {
    writeArtifactAppsViewMode(nextViewMode);
    setViewMode(nextViewMode);
  };

  const openArtifact = (app: (typeof apps)[number]) => {
    const nextViewedTimes = new Map(viewedArtifactTimes);
    nextViewedTimes.set(app.artifactAppId, new Date().toISOString());
    writeViewedArtifactApps(activityStorageScope, nextViewedTimes);
    setViewedArtifactState({ scope: activityStorageScope, value: nextViewedTimes });

    const source = app.sourceMetadata;
    if (app.createdBy === user?.id && source?.conversationId) {
      const artifactKey = source.sourceKey ?? source.originalArtifactId ?? source.messageId;
      const params = new URLSearchParams();
      if (artifactKey) {
        params.set('artifact', artifactKey);
      }
      if (source.sourceKey && source.originalArtifactId) {
        params.set('artifactId', source.originalArtifactId);
      }
      if (source.sourceKey && source.messageId) {
        params.set('artifactMessageId', source.messageId);
      }
      const query = params.size > 0 ? `?${params.toString()}` : '';
      setArtifactNavigationRequest(
        artifactKey
          ? {
              conversationId: source.conversationId,
              sourceKey: artifactKey,
              originalArtifactId: source.originalArtifactId,
              messageId: source.messageId,
            }
          : null,
      );
      navigate(`/c/${source.conversationId}${query}`);
      return;
    }
    navigate(`/apps/${app.artifactAppId}`);
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex flex-1 items-center justify-center p-8 text-text-secondary">
          {localize('com_ui_artifact_app_loading')}
        </div>
      );
    }

    if (isError && data == null) {
      return (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
          role="alert"
        >
          <p className="text-text-secondary">{localize('com_ui_artifact_apps_load_error')}</p>
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      );
    }

    if (apps.length === 0 && !hasNextPage && !isError) {
      const titleKey = searchQuery
        ? 'com_ui_artifact_apps_no_results'
        : 'com_ui_artifact_apps_empty';
      const hintKey = searchQuery
        ? 'com_ui_artifact_apps_no_results_hint'
        : 'com_ui_artifact_apps_empty_hint';

      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <Shapes size={40} className="text-text-secondary opacity-40" aria-hidden="true" />
          <p className="text-text-secondary">{localize(titleKey)}</p>
          <p className="max-w-sm text-sm text-text-secondary">{localize(hintKey)}</p>
        </div>
      );
    }

    return (
      <>
        <ul
          className={cn(
            viewMode === 'grid' && 'grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3',
          )}
        >
          {apps.map((app) => {
            const isPinned = pinnedArtifactIds.has(app.artifactAppId);
            const visibilityLabel = localize(
              app.createdBy === user?.id
                ? 'com_ui_artifact_scope_personal'
                : 'com_ui_artifact_shared_with_you',
            );
            const activityText = [
              localize('com_ui_artifact_app_version_number', {
                0: String(app.latestVersionNumber),
              }),
              formatArtifactActivityDate(app.updatedAt, 'edited', localize, i18n.language),
              formatArtifactActivityDate(
                viewedArtifactTimes.get(app.artifactAppId),
                'viewed',
                localize,
                i18n.language,
              ),
            ]
              .filter(Boolean)
              .join(' · ');

            if (viewMode === 'grid') {
              return (
                <li key={app.artifactAppId}>
                  <div
                    className={cn(
                      'group/artifact relative flex h-full min-h-[19rem] flex-col overflow-hidden rounded-xl border border-border-light bg-surface-secondary text-left transition-colors hover:bg-surface-hover',
                      isPinned && 'border-border-medium',
                    )}
                  >
                    <button
                      className="focus-visible:ring-ring flex h-full flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-2"
                      onClick={() => openArtifact(app)}
                    >
                      <div className="w-full border-b border-border-light">
                        <Thumbnail app={app} />
                      </div>
                      <div className="flex flex-1 flex-col p-4 pr-12">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-text-primary">
                            {app.title}
                          </span>
                          {isPinned && (
                            <Pin size={14} className="text-text-secondary" aria-hidden="true" />
                          )}
                        </div>
                        {app.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                            {app.description}
                          </p>
                        )}
                        <div className="mt-3">
                          <div className="mb-2 flex items-center gap-2">
                            {app.createdBy === user?.id ? (
                              <Lock size={14} className="text-text-secondary" aria-hidden="true" />
                            ) : (
                              <Users size={14} className="text-text-secondary" aria-hidden="true" />
                            )}
                            <span className="rounded-full border border-border-light bg-surface-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
                              {visibilityLabel}
                            </span>
                          </div>
                          <p className="truncate text-xs text-text-secondary">{activityText}</p>
                        </div>
                      </div>
                    </button>
                    <div className="absolute right-3 top-3">
                      <ArtifactAppMenu
                        app={app}
                        isPinned={isPinned}
                        onTogglePin={togglePinnedArtifact}
                        onDeleted={removeDeletedArtifactActivity}
                      />
                    </div>
                  </div>
                </li>
              );
            }

            return (
              <li key={app.artifactAppId}>
                <div
                  className={cn(
                    'group/artifact mb-3 flex w-full items-start gap-3 rounded-xl border border-border-light bg-surface-secondary p-4 text-left transition-colors hover:bg-surface-hover',
                    isPinned && 'border-border-medium',
                  )}
                >
                  <button
                    className="focus-visible:ring-ring flex min-w-0 flex-1 items-start gap-4 text-left focus-visible:outline-none focus-visible:ring-2"
                    onClick={() => openArtifact(app)}
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-surface-primary text-xl">
                      {app.icon ?? <Shapes size={20} className="text-text-secondary" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-text-primary">{app.title}</span>
                        {isPinned && (
                          <Pin size={14} className="text-text-secondary" aria-hidden="true" />
                        )}
                        {app.createdBy === user?.id ? (
                          <Lock size={14} className="text-text-secondary" aria-hidden="true" />
                        ) : (
                          <Users size={14} className="text-text-secondary" aria-hidden="true" />
                        )}
                        <span className="rounded-full border border-border-light bg-surface-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
                          {visibilityLabel}
                        </span>
                      </div>
                      {app.description && (
                        <p className="mt-0.5 truncate text-sm text-text-secondary">
                          {app.description}
                        </p>
                      )}
                      <p className="mt-1 truncate text-xs text-text-secondary">{activityText}</p>
                    </div>
                  </button>
                  <ArtifactAppMenu
                    app={app}
                    isPinned={isPinned}
                    onTogglePin={togglePinnedArtifact}
                    onDeleted={removeDeletedArtifactActivity}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {isError && (
          <div
            className="mt-3 flex flex-wrap items-center justify-center gap-3 rounded-xl border border-border-light bg-surface-secondary px-4 py-3 text-center"
            role="alert"
          >
            <p className="text-sm text-text-secondary">
              {localize('com_ui_artifact_apps_refresh_error')}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {localize('com_ui_retry')}
            </Button>
          </div>
        )}
        {hasNextPage && !isError && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              disabled={isFetchingNextPage}
              onClick={() => fetchNextPage()}
              className="rounded-lg border border-border-light bg-surface-secondary px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetchingNextPage
                ? localize('com_ui_artifact_app_loading')
                : localize('com_ui_load_more')}
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <main className="relative flex h-full w-full grow flex-col overflow-hidden bg-presentation">
      <div className="scrollbar-gutter-stable relative flex h-full flex-col overflow-y-auto overflow-x-hidden">
        {!isSmallScreen && (
          <div className="container mx-auto max-w-4xl">
            <div className="mb-8 mt-12 text-center">
              <h1 className="mb-3 text-3xl font-bold tracking-tight text-text-primary md:text-5xl">
                {localize('com_ui_artifact_apps')}
              </h1>
              <p className="mx-auto mb-6 max-w-2xl text-lg text-text-secondary">
                {localize('com_ui_artifact_apps_description')}
              </p>
            </div>
          </div>
        )}

        <div className="sticky top-0 z-10 mt-4 bg-presentation pb-4 md:mt-0">
          <div className="container mx-auto max-w-4xl px-4">
            <div className="mx-auto mb-3 flex max-w-2xl items-center justify-between gap-2 md:hidden">
              <OpenSidebar />
              <ArtifactAppsAdminSettings compact />
            </div>
            <div className="mx-auto flex max-w-2xl items-center gap-2 pb-6">
              <ArtifactAppsSearchBar value={searchQuery} onChange={setSearchQuery} />
              <ArtifactAppsViewToggle viewMode={viewMode} onChange={changeViewMode} />
              {!isSmallScreen && <ArtifactAppsAdminSettings />}
            </div>
            <div className="w-full pb-2">
              <div
                className={cn(
                  'px-4',
                  isSmallScreen
                    ? 'scrollbar-hide flex gap-2 overflow-x-auto scroll-smooth'
                    : 'flex flex-wrap justify-center gap-1.5',
                )}
                role="tablist"
                aria-label={localize('com_ui_artifact_catalog_filters')}
                aria-orientation="horizontal"
                style={
                  isSmallScreen
                    ? {
                        scrollbarWidth: 'none',
                        msOverflowStyle: 'none',
                        WebkitOverflowScrolling: 'touch',
                      }
                    : undefined
                }
              >
                {SCOPES.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    role="tab"
                    aria-selected={scope === candidate}
                    onClick={() => setScope(candidate)}
                    className={cn(
                      'focus-visible:ring-ring relative cursor-pointer select-none whitespace-nowrap px-3 py-2 text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2',
                      isSmallScreen ? 'min-w-fit flex-shrink-0' : '',
                      scope === candidate
                        ? 'rounded-t-lg bg-surface-hover text-text-primary'
                        : 'rounded-lg bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary active:scale-95',
                    )}
                  >
                    {localize(SCOPE_LABELS[candidate])}
                    {scope === candidate && (
                      <div
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-text-primary"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="container mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 pb-8">
          {renderContent()}
        </div>
      </div>
    </main>
  );
}
