import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import { useDrop } from 'react-dnd';
import { useRecoilValue } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderPlus,
  Folders,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  Button,
  Skeleton,
  Spinner,
  TooltipAnchor,
  DropdownPopup,
  NewChatIcon,
  buttonVariants,
} from '@librechat/client';
import type { TChatProject, TConversation } from 'librechat-data-provider';
import type { MouseEvent } from 'react';
import type { ConversationDragItem } from './dnd';
import type { MenuItemProps } from '~/common';
import {
  CONVERSATION_DRAG_TYPE,
  markExternalHover,
  useAssignDroppedConversation,
  useEffectiveProjectId,
} from './dnd';
import {
  useProjectsInfiniteQuery,
  useActiveJobs,
  useConversationsInfiniteQuery,
} from '~/data-provider';
import ProjectCreateDialog from '~/components/Projects/ProjectCreateDialog';
import ProjectDeleteDialog from '~/components/Projects/ProjectDeleteDialog';
import ProjectEditDialog from '~/components/Projects/ProjectEditDialog';
import { useLocalize, useLocalStorage, useNewConvo } from '~/hooks';
import { clearMessagesCache, cn } from '~/utils';
import { Collapse } from '~/components/ui';
import Convo from './Convo';
import store from '~/store';

const INLINE_CHAT_LIMIT = 8;

/** `cn` is what resolves the base utilities this variant overrides. */
const iconButtonClassName = cn(
  buttonVariants({ variant: 'section-action', size: 'icon-xs' }),
  'shrink-0',
);

/** The same control on a project row rather than beside the heading. The row
 *  itself already fills on hover, so the variant's hover surface would leave
 *  the button reading as a second, weaker hover on top of it. These take the
 *  active fill instead — the same one the row's own selected state uses — both
 *  under the pointer and while the menu they own is open. */
const rowActionClassName = cn(
  iconButtonClassName,
  'hover:bg-surface-active hover:text-text-primary',
);
const rowActionOpenClassName = 'bg-surface-active text-text-primary';

const noop = () => {};

type ProjectChatsInlineProps = {
  projectId: string;
  expanded: boolean;
  toggleNav: () => void;
  onShowAll: () => void;
};

/** Mirrors a Convo row (h-9, endpoint dot, title) so the swap from skeletons to
 *  rows doesn't shift height, and an opening project reads as loading its chats
 *  rather than as an empty strip with a lone spinner. */
const ProjectChatSkeleton = () => (
  <div className="flex h-9 w-full items-center gap-2 px-1.5" aria-hidden="true">
    <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
    <Skeleton className="h-3.5 w-24" />
  </div>
);

const ProjectChatsInline = memo(function ProjectChatsInline({
  projectId,
  expanded,
  toggleNav,
  onShowAll,
}: ProjectChatsInlineProps) {
  const localize = useLocalize();
  const { data: activeJobsData } = useActiveJobs();
  const activeJobIds = useMemo(
    () => new Set(activeJobsData?.activeJobIds ?? []),
    [activeJobsData?.activeJobIds],
  );
  /** Collapse keeps its children mounted, so without this every project row in
   *  the sidebar would fetch its chats on load whether or not it is open. */
  const { data, isLoading } = useConversationsInfiniteQuery(
    { projectId, sortBy: 'updatedAt', sortDirection: 'desc' },
    { staleTime: 30000, cacheTime: 300000, enabled: expanded },
  );

  const conversations = useMemo<TConversation[]>(
    () =>
      (data?.pages.flatMap((page) => page.conversations) ?? []).filter(Boolean) as TConversation[],
    [data?.pages],
  );
  const hasMore =
    conversations.length > INLINE_CHAT_LIMIT ||
    (data?.pages[data.pages.length - 1]?.nextCursor ?? null) != null;
  const visible = conversations.slice(0, INLINE_CHAT_LIMIT);

  if (isLoading && conversations.length === 0) {
    return (
      <div data-testid={`project-chats-loading-${projectId}`} aria-busy="true">
        <span className="sr-only">{localize('com_ui_loading')}</span>
        {Array.from({ length: 3 }, (_, index) => (
          <ProjectChatSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="py-1.5 pl-2 text-xs text-text-secondary">
        {localize('com_ui_no_project_chats')}
      </div>
    );
  }

  return (
    <div data-testid={`project-chats-${projectId}`}>
      {visible.map((convo) => (
        <Convo
          key={convo.conversationId}
          conversation={convo}
          retainView={noop}
          toggleNav={toggleNav}
          isGenerating={activeJobIds.has(convo.conversationId ?? '')}
          draggable
        />
      ))}
      {hasMore && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onShowAll}
          className="ml-1 mt-0.5 h-auto rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          {localize('com_ui_show_all')}
        </Button>
      )}
    </div>
  );
});

ProjectChatsInline.displayName = 'ProjectChatsInline';

type ProjectItemProps = {
  project: TChatProject;
  toggleNav: () => void;
  defaultExpanded: boolean;
  isActive: boolean;
};

const ProjectItem = memo(
  function ProjectItem({ project, toggleNav, defaultExpanded, isActive }: ProjectItemProps) {
    const localize = useLocalize();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const queryClient = useQueryClient();
    const { newConversation } = useNewConvo();
    const conversationId = useRecoilValue(store.conversationIdByIndex(0));
    const menuId = useId();
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isRenameOpen, setIsRenameOpen] = useState(false);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const projectChatPath = `/c/${Constants.NEW_CONVO}?projectId=${encodeURIComponent(project._id)}`;

    /* The whole item, header plus its expanded chats, is the drop target for
     * filing a dragged conversation into this project; the project's own chats
     * read as already-filed and are rejected. The highlight lands on the header
     * row so the affordance reads as the project, not the row under it. */
    const assignDropped = useAssignDroppedConversation();
    const effectiveProjectId = useEffectiveProjectId();
    const projectRowRef = useRef<HTMLLIElement>(null);
    const [{ isDropOver, canDrop }, dropRef] = useDrop<
      ConversationDragItem,
      unknown,
      { isDropOver: boolean; canDrop: boolean }
    >({
      accept: CONVERSATION_DRAG_TYPE,
      canDrop: (item) => effectiveProjectId(item) !== project._id,
      /* Reported even when the drop is refused: a pinned row dragged onto the
       * project it already belongs to still left the pinned list, and the rows
       * it crossed must not be saved in their shifted order. */
      hover: () => markExternalHover(),
      /* The drop result is what the pinned list reads to tell a reorder from a
       * filing action, so this hands back nothing rather than the assignment's
       * promise. */
      drop: (item) => {
        void assignDropped(item, project._id);
      },
      collect: (monitor) => ({ isDropOver: monitor.isOver(), canDrop: monitor.canDrop() }),
    });
    dropRef(projectRowRef);

    const openProject = useCallback(() => {
      navigate(`/projects/${project._id}`);
      toggleNav();
    }, [navigate, project._id, toggleNav]);

    const startChat = useCallback(
      (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
          return;
        }
        event.preventDefault();
        clearMessagesCache(queryClient, conversationId);
        queryClient.invalidateQueries([QueryKeys.messages]);
        /** `navigate()` defers search-param updates; ChatRoute then sees a
         *  project-scoped draft against an unscoped `/c/new` and wipes it.
         *  Commit `?projectId` in the same turn, the same way the landing chip does. */
        if (location.pathname === `/c/${Constants.NEW_CONVO}`) {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.set('projectId', project._id);
          setSearchParams(nextParams, { replace: true, flushSync: true });
        } else {
          navigate(projectChatPath);
        }
        newConversation({ template: { chatProjectId: project._id } });
        toggleNav();
      },
      [
        conversationId,
        location.pathname,
        navigate,
        newConversation,
        project._id,
        projectChatPath,
        queryClient,
        searchParams,
        setSearchParams,
        toggleNav,
      ],
    );

    const menuItems = useMemo<MenuItemProps[]>(
      () => [
        {
          id: `${menuId}-open`,
          label: localize('com_ui_open_project'),
          icon: <Folder className="size-4 text-text-secondary" aria-hidden="true" />,
          onClick: openProject,
        },
        {
          id: `${menuId}-rename`,
          label: localize('com_ui_edit_project'),
          icon: <Pencil className="size-4 text-text-secondary" aria-hidden="true" />,
          onClick: () => setIsRenameOpen(true),
        },
        {
          id: `${menuId}-delete`,
          label: localize('com_ui_delete'),
          icon: <Trash2 className="size-4 text-text-secondary" aria-hidden="true" />,
          onClick: () => setIsDeleteOpen(true),
        },
      ],
      [localize, menuId, openProject],
    );

    return (
      <li className="list-none" ref={projectRowRef}>
        <div
          className={cn(
            'group/project-row relative flex h-9 items-center rounded-lg text-sm text-text-primary hover:bg-surface-hover',
            isActive && 'bg-surface-active-alt hover:bg-surface-active-alt',
            !isActive && isMenuOpen && 'bg-surface-hover',
            isDropOver && canDrop && 'bg-surface-active-alt ring-1 ring-inset ring-border-medium',
          )}
        >
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-label={project.name}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-16 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform duration-200',
                expanded && 'rotate-90',
              )}
              aria-hidden="true"
            />
            <Folder className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate">{project.name}</span>
          </button>
          <div
            className={cn(
              /* The 4px between the two controls, and from the row's trailing
                 edge, that a pinned chat keeps between its unpin badge and its
                 overflow menu. */
              'absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1',
              isMenuOpen
                ? 'opacity-100'
                : [
                    '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity',
                    'group-hover/project-row:opacity-100',
                    'has-[:focus-visible]:opacity-100',
                  ],
            )}
          >
            <TooltipAnchor
              description={localize('com_ui_new_chat_in_project', { name: project.name })}
              render={
                <a
                  href={projectChatPath}
                  aria-label={localize('com_ui_new_chat_in_project', { name: project.name })}
                  className={rowActionClassName}
                  onClick={startChat}
                >
                  <NewChatIcon className="h-4 w-4" />
                </a>
              }
            />
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
                  className={cn(rowActionClassName, isMenuOpen && rowActionOpenClassName)}
                >
                  <Ellipsis className="h-4 w-4" aria-hidden="true" />
                </Ariakit.MenuButton>
              }
              items={menuItems}
            />
          </div>
        </div>
        <Collapse open={expanded} className="pl-2">
          <ProjectChatsInline
            projectId={project._id}
            expanded={expanded}
            toggleNav={toggleNav}
            onShowAll={openProject}
          />
        </Collapse>
        <ProjectEditDialog open={isRenameOpen} onOpenChange={setIsRenameOpen} project={project} />
        <ProjectDeleteDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} project={project} />
      </li>
    );
  },
  (prevProps, nextProps) =>
    prevProps.project._id === nextProps.project._id &&
    prevProps.project.name === nextProps.project.name &&
    prevProps.project.description === nextProps.project.description &&
    prevProps.project.conversationCount === nextProps.project.conversationCount &&
    prevProps.project.updatedAt === nextProps.project.updatedAt &&
    prevProps.defaultExpanded === nextProps.defaultExpanded &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.toggleNav === nextProps.toggleNav,
);

ProjectItem.displayName = 'ProjectItem';

interface ProjectsSectionProps {
  toggleNav: () => void;
  isAuthenticated: boolean;
}

const ProjectsSection = ({ toggleNav, isAuthenticated }: ProjectsSectionProps) => {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const [storedExpanded, setStoredExpanded] = useLocalStorage('projectsSectionExpanded', true);
  const [hasToggledSection, setHasToggledSection] = useLocalStorage(
    'projectsSectionToggled',
    false,
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const conversationProjectId = conversation?.chatProjectId ?? null;
  /** A project workspace route wins so a leftover conversation scope cannot
   *  highlight a second row at the same time. */
  const routeProjectId = /^\/projects\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;
  const highlightedProjectId = routeProjectId ?? conversationProjectId;

  const { data, isLoading } = useProjectsInfiniteQuery(
    { sortBy: 'lastConversationAt', sortDirection: 'desc', limit: 25 },
    { enabled: isAuthenticated, staleTime: 30000, cacheTime: 300000 },
  );

  const projects = useMemo(() => data?.pages.flatMap((page) => page.projects) ?? [], [data?.pages]);
  const hasMore = (data?.pages[data.pages.length - 1]?.nextCursor ?? null) != null;

  /**
   * Collapse the section by default for users with no projects who have never
   * toggled it, to keep the sidebar compact. An explicit toggle, or a collapse
   * set before this default existed (stored === false), is always respected.
   */
  const respectStoredExpanded = hasToggledSection || storedExpanded === false;
  const isExpanded = respectStoredExpanded ? storedExpanded : isLoading || projects.length > 0;

  const openProjects = useCallback(() => {
    navigate('/projects');
    toggleNav();
  }, [navigate, toggleNav]);

  const renderProjectsBody = () => {
    if (isLoading && projects.length === 0) {
      return (
        <div className="flex justify-start py-2 pl-2">
          <Spinner className="h-4 w-4 text-text-secondary" />
        </div>
      );
    }

    if (projects.length === 0) {
      return (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setIsCreateOpen(true)}
          className="flex h-9 w-full justify-start gap-2 rounded-lg px-2 text-sm font-normal text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <FolderPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{localize('com_ui_new_project')}</span>
        </Button>
      );
    }

    return (
      <ul className="m-0 list-none p-0">
        {projects.map((project) => (
          <ProjectItem
            key={project._id}
            project={project}
            toggleNav={toggleNav}
            defaultExpanded={project._id === highlightedProjectId}
            isActive={project._id === highlightedProjectId}
          />
        ))}
        {hasMore && (
          <li className="list-none">
            <Button
              type="button"
              variant="ghost"
              onClick={openProjects}
              className="flex h-8 w-full justify-start rounded-lg px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              {localize('com_ui_all_projects')}
            </Button>
          </li>
        )}
      </ul>
    );
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="flex flex-col px-3 text-sm">
      <div className="flex h-8 w-full items-center pr-2">
        <button
          type="button"
          onClick={() => {
            setStoredExpanded(!isExpanded);
            setHasToggledSection(true);
          }}
          className={cn(buttonVariants({ variant: 'section-header' }), 'group min-w-0 flex-1')}
          aria-expanded={isExpanded}
        >
          <span className="select-none truncate">{localize('com_ui_projects')}</span>
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 transition-transform duration-200',
              isExpanded ? '' : '-rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
        <TooltipAnchor
          description={localize('com_ui_all_projects')}
          render={
            <button
              type="button"
              aria-label={localize('com_ui_all_projects')}
              className={iconButtonClassName}
              onClick={openProjects}
            >
              <Folders className="h-4 w-4" aria-hidden="true" />
            </button>
          }
        />
      </div>

      <Collapse open={isExpanded}>
        {/* No scroll pane of its own: the sidebar scrolls as one surface. */}
        <div className="pt-0.5">{renderProjectsBody()}</div>
      </Collapse>

      <ProjectCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onCreated={(project) => {
          navigate(`/projects/${project._id}`);
          toggleNav();
        }}
      />
    </div>
  );
};

ProjectsSection.displayName = 'ProjectsSection';

export default memo(ProjectsSection);
