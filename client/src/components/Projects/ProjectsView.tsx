import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ellipsis, Folder, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { Button, Spinner, Skeleton, DropdownPopup, buttonVariants } from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import type { ProjectSort } from './ProjectsSortMenu';
import type { MenuItemProps } from '~/common';
import { useProjectsInfiniteQuery } from '~/data-provider';
import ProjectCreateDialog from './ProjectCreateDialog';
import ProjectDeleteDialog from './ProjectDeleteDialog';
import ProjectEditDialog from './ProjectEditDialog';
import ProjectsSortMenu from './ProjectsSortMenu';
import ProjectsNavBar from './ProjectsNavBar';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

function formatActivity(project: TChatProject) {
  const value = project.lastConversationAt ?? project.updatedAt ?? project.createdAt;
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ProjectCard({
  project,
  onOpen,
}: {
  project: TChatProject;
  onOpen: (projectId: string) => void;
}) {
  const localize = useLocalize();
  const menuId = useId();
  const editMenuRef = useRef<HTMLButtonElement>(null);
  const deleteMenuRef = useRef<HTMLButtonElement>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  /** The dialog items keep the menu open so it does not steal focus from the
   *  dialog mounting beside it; closing the dialog closes the menu too. */
  const closeMenuWith = (setOpen: (open: boolean) => void, open: boolean) => {
    setOpen(open);
    if (!open) {
      setIsMenuOpen(false);
    }
  };
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const activity = formatActivity(project);
  const menuItems = useMemo<MenuItemProps[]>(
    () => [
      {
        id: `${menuId}-edit`,
        label: localize('com_ui_edit_project'),
        icon: <Pencil className="text-text-secondary size-4" aria-hidden="true" />,
        onClick: () => setIsEditOpen(true),
        hideOnClick: false,
        ref: editMenuRef,
        render: (props) => <button {...props} />,
      },
      {
        id: `${menuId}-delete`,
        label: localize('com_ui_delete'),
        icon: <Trash2 className="text-text-secondary size-4" aria-hidden="true" />,
        onClick: () => setIsDeleteOpen(true),
        hideOnClick: false,
        ref: deleteMenuRef,
        render: (props) => <button {...props} />,
      },
    ],
    [localize, menuId],
  );

  return (
    <article
      className={cn(
        'group/project border-border-light bg-surface-secondary relative flex min-h-[9.5rem] max-w-full min-w-0 flex-col rounded-2xl border',
        'hover:bg-surface-hover transition-colors duration-150 ease-out',
        isMenuOpen && 'bg-surface-hover',
      )}
    >
      <Button
        type="button"
        variant="card"
        size="tile"
        className="min-h-[9.5rem] w-full max-w-full min-w-0 flex-1 flex-col items-stretch"
        onClick={() => onOpen(project._id)}
      >
        <span className="bg-surface-tertiary text-text-secondary group-hover/project:text-text-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors">
          <Folder className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="text-text-primary mt-3 line-clamp-2 max-w-full min-w-0 text-base font-semibold tracking-tight wrap-anywhere md:line-clamp-1">
          {project.name}
        </span>
        {project.description ? (
          <span className="text-text-secondary mt-1 line-clamp-2 max-w-full min-w-0 text-sm leading-relaxed text-pretty wrap-anywhere">
            {project.description}
          </span>
        ) : null}
        <span className="text-text-secondary mt-auto flex max-w-full min-w-0 items-center gap-2 pt-4 text-xs tabular-nums">
          <span>
            {project.conversationCount === 1
              ? localize('com_ui_project_chat_count_single')
              : localize('com_ui_project_chat_count', {
                  count: project.conversationCount,
                })}
          </span>
          {activity ? (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={project.lastConversationAt ?? project.updatedAt ?? project.createdAt}>
                {activity}
              </time>
            </>
          ) : null}
        </span>
      </Button>
      <div className="absolute top-2 right-2">
        <DropdownPopup
          portal={true}
          focusLoop={true}
          unmountOnHide={true}
          menuId={menuId}
          isOpen={isMenuOpen}
          setIsOpen={setIsMenuOpen}
          className="z-[125] min-w-44"
          iconClassName="mr-2 text-text-secondary"
          trigger={
            <Ariakit.MenuButton
              aria-label={localize('com_ui_more_options')}
              className={cn(
                buttonVariants({ variant: 'row-action', size: 'icon-sm' }),
                'text-text-secondary rounded-lg',
                isMenuOpen && 'bg-surface-hover-alt text-text-primary',
              )}
            >
              <Ellipsis className="h-4 w-4" aria-hidden="true" />
            </Ariakit.MenuButton>
          }
          items={menuItems}
        />
      </div>
      <ProjectEditDialog
        open={isEditOpen}
        onOpenChange={(open) => closeMenuWith(setIsEditOpen, open)}
        project={project}
        triggerRef={editMenuRef}
      />
      <ProjectDeleteDialog
        open={isDeleteOpen}
        onOpenChange={(open) => closeMenuWith(setIsDeleteOpen, open)}
        project={project}
        triggerRef={deleteMenuRef}
      />
    </article>
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="bg-surface-secondary flex min-h-[9.5rem] flex-col rounded-2xl p-4"
        >
          <Skeleton className="h-11 w-11 rounded-xl" />
          <Skeleton className="mt-3 h-5 w-2/3" />
          <Skeleton className="mt-2 h-4 w-full" />
          <Skeleton className="mt-auto h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export default function ProjectsView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<ProjectSort>('lastConversationAt');
  const [isCreating, setIsCreating] = useState(searchParams.get('new') === '1');
  const deferredSearch = useDeferredValue(search);
  const scrollRef = useRef<HTMLElement | null>(null);
  const [pageSentinel, setPageSentinel] = useState<HTMLDivElement | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isLoading } =
    useProjectsInfiniteQuery({
      search: deferredSearch || undefined,
      sortBy,
      sortDirection: sortBy === 'name' ? 'asc' : 'desc',
    });

  const projects = useMemo(() => data?.pages.flatMap((page) => page.projects) ?? [], [data?.pages]);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setIsCreating(true);
    }
  }, [searchParams]);

  const handleCreateDialogChange = (open: boolean) => {
    setIsCreating(open);
    if (!open && searchParams.get('new') === '1') {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('new');
      setSearchParams(nextParams, { replace: true });
    }
  };

  const loadMore = useCallback(() => {
    if (hasNextPage === true && !isFetching) {
      /** `cancelRefetch: false` so a scroll burst coalesces into one request
       *  instead of each intersection restarting the page in flight. */
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [fetchNextPage, hasNextPage, isFetching]);

  /** The list scrolls inside `<main>`, so the viewport root would clip the
   *  sentinel and only report it once it is already on screen; observing the
   *  scroll container lets `rootMargin` prefetch a page ahead of the edge. */
  useEffect(() => {
    const root = scrollRef.current;
    if (pageSentinel == null || root == null) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          loadMore();
        }
      },
      { root, rootMargin: '600px 0px' },
    );
    observer.observe(pageSentinel);
    return () => observer.disconnect();
  }, [loadMore, pageSentinel]);

  return (
    <main
      ref={scrollRef}
      className="bg-surface-primary-alt text-text-primary flex h-full min-h-0 flex-col overflow-auto"
    >
      <ProjectsNavBar
        onCreate={() => setIsCreating(true)}
        search={search}
        onSearchChange={setSearch}
      />

      <div className="flex w-full flex-1 flex-col px-4 pt-3 pb-10 md:px-6 md:pt-4">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <h2 className="text-text-primary text-sm font-medium">
            {localize('com_ui_your_projects')}
          </h2>
          {!isLoading && projects.length > 0 ? (
            <ProjectsSortMenu sortBy={sortBy} onSortChange={setSortBy} />
          ) : null}
        </div>

        <ProjectCreateDialog
          open={isCreating}
          onOpenChange={handleCreateDialogChange}
          onCreated={(project) => navigate(`/projects/${project._id}`)}
        />

        <div className="mt-4 flex flex-1 flex-col">
          {isLoading && <ProjectGridSkeleton />}
          {!isLoading && projects.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
              {projects.map((project) => (
                <ProjectCard
                  key={project._id}
                  project={project}
                  onOpen={(projectId) => navigate(`/projects/${projectId}`)}
                />
              ))}
            </div>
          )}
          {!isLoading && projects.length === 0 && (
            <div className="bg-surface-secondary flex flex-1 flex-col items-center justify-center rounded-2xl px-6 py-16 text-center">
              <span className="bg-surface-tertiary text-text-secondary flex h-14 w-14 items-center justify-center rounded-2xl">
                <FolderPlus className="h-7 w-7" aria-hidden="true" />
              </span>
              <h3 className="text-text-primary mt-4 text-base font-semibold text-balance">
                {search ? localize('com_ui_no_matching_projects') : localize('com_ui_no_projects')}
              </h3>
              {!search ? (
                <>
                  <p className="text-text-secondary mt-1 max-w-sm text-sm text-pretty">
                    {localize('com_ui_add_first_project')}
                  </p>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="mt-5"
                    onClick={() => setIsCreating(true)}
                  >
                    <FolderPlus className="h-4 w-4" aria-hidden="true" />
                    {localize('com_ui_new_project')}
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </div>

        {hasNextPage && (
          <div
            ref={setPageSentinel}
            className="text-text-primary flex h-16 shrink-0 items-center justify-center"
            role="status"
            aria-live="polite"
            aria-label={localize('com_ui_loading')}
          >
            {isFetchingNextPage ? <Spinner className="size-5" /> : null}
          </div>
        )}
      </div>
    </main>
  );
}
