import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { useQueryClient } from '@tanstack/react-query';
import { useDefaultLayout } from 'react-resizable-panels';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  Folder,
  Info,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  Button,
  DropdownPopup,
  EmptyState,
  ResizableHandleAlt,
  ResizablePanel,
  ResizablePanelGroup,
  Spinner,
  TooltipAnchor,
} from '@librechat/client';
import type { ConversationListResponse } from 'librechat-data-provider';
import {
  useConversationsInfiniteQuery,
  useGetStartupConfig,
  useProjectQuery,
} from '~/data-provider';
import ProjectInstructionsDialog from './ProjectInstructionsDialog';
import { useElementSize, useLocalize, useNewConvo } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import ProjectDeleteDialog from './ProjectDeleteDialog';
import ProjectResources from './ProjectResources';
import ProjectChatList from './ProjectChatList';
import { clearMessagesCache } from '~/utils';
import ProjectEditor from './ProjectEditor';
import store from '~/store';

type ChatSortField = 'updatedAt' | 'createdAt';

const WORKSPACE_PANEL_IDS = ['project-details', 'project-chats'];
const DETAILS_PANEL_IDS_WITH_FILES = ['project-instructions', 'project-files'];
const DETAILS_PANEL_IDS = ['project-instructions'];

/** Both separators grab from a band this wide, and the junction that moves all three
 *  panels is where the two bands cross: at the library's 10px default the crossing is
 *  only ~4.5px of aim, so the bands are widened to keep it comfortable. Both stay
 *  inside the 12px gutters flanking each separator, so no panel content is covered. */
const RESIZE_TARGET_SIZE = { coarse: 32, fine: 22 };

/** A section is its header plus an empty-state card (badge, two wrapped lines); shrinking
 *  a panel past that would scroll chrome that has nothing to scroll, so the drag stops
 *  here instead. Panels holding content still scroll, which is the point of scrolling.
 *  The cap preserves that floor when the group is tall while the measured group height
 *  keeps both panels' floors feasible in short viewports. */
const DETAILS_PANEL_MAX_MIN_SIZE = 240;
const DETAILS_PANEL_HANDLE_ALLOWANCE = 1;

export default function ProjectWorkspace() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sortBy, setSortBy] = useState<ChatSortField>('updatedAt');
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [initialEditField, setInitialEditField] = useState<'name' | 'description'>('name');
  const isEditOpen = editingProjectId === projectId || searchParams.get('edit') === '1';
  const [isInstructionsOpen, setIsInstructionsOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const projectMenuId = useId();
  const sortMenuId = useId();
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const descriptionButtonRef = useRef<HTMLButtonElement>(null);
  const deleteMenuRef = useRef<HTMLButtonElement>(null);
  const instructionsButtonRef = useRef<HTMLButtonElement>(null);
  const { data: project, isLoading: isProjectLoading } = useProjectQuery(projectId);
  const { data: startupConfig } = useGetStartupConfig();
  const isRagEnabled = startupConfig?.ragEnabled === true;
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const { newConversation } = useNewConvo();
  const activeProjectId = project?._id;
  const isSmallScreen = useDrawerViewport();

  /** Panel sizes are a workspace-wide preference, so they persist per browser
   *  rather than per project; the files panel keys its own layout so hiding it
   *  (no RAG service) does not overwrite the split used when it is present. */
  const workspaceLayout = useDefaultLayout({
    id: 'project-workspace-layout',
    panelIds: WORKSPACE_PANEL_IDS,
    storage: localStorage,
  });
  const detailsLayout = useDefaultLayout({
    id: 'project-details-layout',
    panelIds: isRagEnabled ? DETAILS_PANEL_IDS_WITH_FILES : DETAILS_PANEL_IDS,
    storage: localStorage,
  });
  const { ref: detailsGroupRef, height: detailsGroupHeight } = useElementSize<HTMLDivElement>();
  const detailsPanelMinSize = `${Math.min(
    DETAILS_PANEL_MAX_MIN_SIZE,
    Math.max(0, Math.floor((detailsGroupHeight - DETAILS_PANEL_HANDLE_ALLOWANCE) / 2)),
  )}px`;

  const startEditing = (field: 'name' | 'description') => {
    setInitialEditField(field);
    setEditingProjectId(projectId);
  };

  const finishEditing = () => {
    setEditingProjectId(null);
    if (searchParams.has('edit')) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('edit');
      setSearchParams(nextParams, { replace: true });
    }
    requestAnimationFrame(() => {
      const target = initialEditField === 'description' ? descriptionButtonRef : titleButtonRef;
      target.current?.focus();
    });
  };

  const sortOptions = useMemo(
    () => [
      { value: 'updatedAt' as const, label: localize('com_ui_sort_updated') },
      { value: 'createdAt' as const, label: localize('com_ui_sort_created') },
    ],
    [localize],
  );
  const selectedSortLabel =
    sortOptions.find((option) => option.value === sortBy)?.label ?? localize('com_ui_sort_updated');

  const {
    data,
    fetchNextPage,
    isFetchingNextPage,
    isLoading: isConversationsLoading,
  } = useConversationsInfiniteQuery(
    {
      projectId: activeProjectId,
      sortBy,
      sortDirection: 'desc',
    },
    {
      enabled: Boolean(activeProjectId),
      staleTime: 30000,
      cacheTime: 300000,
    },
  );

  const conversations = useMemo(
    () => data?.pages.flatMap((page) => page.conversations) ?? [],
    [data?.pages],
  );

  const hasNextPage = useMemo(() => {
    const pages = data?.pages;
    if (!pages?.length) {
      return false;
    }
    const lastPage: ConversationListResponse = pages[pages.length - 1];
    return lastPage.nextCursor !== null;
  }, [data?.pages]);

  const startProjectChat = useCallback(() => {
    if (!activeProjectId) {
      return;
    }
    clearMessagesCache(queryClient, conversation?.conversationId);
    queryClient.invalidateQueries([QueryKeys.messages]);
    navigate(`/c/${Constants.NEW_CONVO}?projectId=${encodeURIComponent(activeProjectId)}`);
    newConversation({ template: { chatProjectId: activeProjectId } });
  }, [activeProjectId, conversation?.conversationId, navigate, newConversation, queryClient]);

  if (isProjectLoading) {
    return (
      <div className="bg-surface-primary-alt text-text-primary flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="bg-surface-primary-alt flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-text-secondary text-sm">{localize('com_ui_project_not_found')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => navigate('/projects')}>
          {localize('com_ui_all_projects')}
        </Button>
      </div>
    );
  }

  const detailsHeader = isEditOpen ? (
    <ProjectEditor
      key={project._id}
      project={project}
      inputRef={nameInputRef}
      initialField={initialEditField}
      onDone={finishEditing}
    />
  ) : (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-4">
        <span className="bg-surface-secondary text-text-secondary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Folder className="size-5" aria-hidden="true" />
        </span>
        <h1 className="min-w-0 flex-1">
          <Button
            ref={titleButtonRef}
            type="button"
            variant="inline-edit"
            onClick={() => startEditing('name')}
            className="min-h-10 w-full min-w-0"
          >
            <span className="line-clamp-2 min-w-0 text-xl font-semibold tracking-tight wrap-anywhere md:line-clamp-1">
              {project.name}
            </span>
            <span className="sr-only">, {localize('com_ui_project_edit_name')}</span>
          </Button>
        </h1>
      </div>
      <Button
        ref={descriptionButtonRef}
        type="button"
        variant="inline-edit"
        onClick={() => startEditing('description')}
        className="mt-1 min-h-10 w-full min-w-0"
      >
        <span className="text-text-secondary line-clamp-3 min-w-0 text-sm leading-relaxed font-normal wrap-anywhere">
          {project.description || localize('com_ui_add_description')}
        </span>
        <span className="sr-only">, {localize('com_ui_project_edit_description')}</span>
      </Button>
    </div>
  );

  const instructionsSection = (
    <section
      className="border-border-light bg-surface-secondary flex h-full min-h-0 min-w-0 flex-col rounded-2xl border p-4"
      aria-labelledby="project-instructions-heading"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <h2 id="project-instructions-heading" className="text-text-primary text-sm font-semibold">
            {localize('com_ui_project_instructions')}
          </h2>
          <TooltipAnchor
            description={localize('com_ui_project_instructions_future_turns')}
            render={
              <Button
                type="button"
                variant="section-action"
                size="icon-xs"
                className="relative shrink-0 after:absolute after:-inset-1.5"
                aria-label={localize('com_ui_project_instructions_info')}
              >
                <Info className="size-3.5" aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <Button
          ref={instructionsButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={localize('com_ui_project_edit_instructions')}
          onClick={() => setIsInstructionsOpen(true)}
        >
          <Pencil className="size-4" aria-hidden="true" />
          {localize('com_ui_edit')}
        </Button>
      </div>
      <div
        role="region"
        aria-label={localize('com_ui_project_instructions_preview')}
        tabIndex={project.instructions?.trim() ? 0 : undefined}
        className="focus-visible:ring-text-primary min-h-0 flex-1 overflow-y-auto rounded-md focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset"
      >
        {project.instructions?.trim() ? (
          <p className="text-text-secondary text-base leading-relaxed wrap-anywhere whitespace-pre-wrap">
            {project.instructions}
          </p>
        ) : (
          <EmptyState
            icon={NotebookPen}
            description={localize('com_ui_project_no_instructions')}
            className="h-full"
          />
        )}
      </div>
    </section>
  );

  const chatsSection = (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-labelledby="project-chats-heading"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2
          id="project-chats-heading"
          className="text-text-primary flex items-baseline gap-2 text-sm font-semibold"
        >
          {localize('com_ui_chats')}
          <span className="text-text-secondary tabular-nums">{project.conversationCount}</span>
        </h2>
        <DropdownPopup
          portal={true}
          focusLoop={true}
          unmountOnHide={true}
          menuId={sortMenuId}
          isOpen={isSortMenuOpen}
          setIsOpen={setIsSortMenuOpen}
          trigger={
            <Ariakit.MenuButton
              aria-label={localize('com_ui_sort_chats_by')}
              className="aria-expanded:bg-surface-hover"
              render={<Button type="button" variant="ghost" size="sm" />}
            >
              <ArrowUpDown className="size-4" aria-hidden="true" />
              {selectedSortLabel}
            </Ariakit.MenuButton>
          }
          items={sortOptions.map((option) => ({
            label: option.label,
            ariaChecked: sortBy === option.value,
            icon:
              sortBy === option.value ? (
                <Check className="text-text-secondary size-4" aria-hidden="true" />
              ) : (
                <span className="size-4" aria-hidden="true" />
              ),
            onClick: () => setSortBy(option.value),
          }))}
        />
      </div>
      <ProjectChatList
        conversations={conversations}
        isLoading={isConversationsLoading}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={hasNextPage}
        sortBy={sortBy}
        emptyLabel={localize('com_ui_no_project_chats')}
        loadMore={() => fetchNextPage()}
      />
    </section>
  );

  const filesSection = isRagEnabled ? (
    <ProjectResources key={project._id} project={project} />
  ) : null;

  return (
    <main className="bg-surface-primary-alt text-text-primary flex h-full min-h-0 min-w-0 flex-col">
      <header className="border-border-light bg-surface-primary-alt sticky top-0 z-10 border-b">
        <div className="flex h-14 w-full items-center gap-2 px-4 md:px-6">
          {isSmallScreen ? <OpenSidebar className="size-9 shrink-0" /> : null}
          <Button
            type="button"
            variant="section-action"
            size="sm"
            onClick={() => navigate('/projects')}
            className="-ml-1.5"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {localize('com_ui_all_projects')}
          </Button>
          <Button
            type="button"
            size="sm"
            shape="round"
            className="ml-auto shrink-0"
            variant="default"
            onClick={startProjectChat}
            aria-label={localize('com_ui_new_chat_in_project', { name: project.name })}
          >
            <Plus className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{localize('com_ui_new_chat')}</span>
          </Button>
          <DropdownPopup
            portal={true}
            focusLoop={true}
            unmountOnHide={true}
            menuId={projectMenuId}
            isOpen={isProjectMenuOpen}
            setIsOpen={setIsProjectMenuOpen}
            trigger={
              <Ariakit.MenuButton
                aria-label={localize('com_ui_project_options')}
                className="aria-expanded:bg-surface-hover shrink-0"
                render={<Button type="button" variant="outline" size="icon" />}
              >
                <MoreHorizontal className="size-5" aria-hidden="true" />
              </Ariakit.MenuButton>
            }
            items={[
              {
                label: localize('com_ui_delete_project_action'),
                icon: <Trash2 className="text-text-secondary size-4" aria-hidden="true" />,
                onClick: () => setIsDeleteOpen(true),
                hideOnClick: false,
                ref: deleteMenuRef,
                render: (props) => <button {...props} />,
              },
            ]}
          />
        </div>
      </header>

      <ProjectDeleteDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        project={project}
        triggerRef={deleteMenuRef}
      />
      <ProjectInstructionsDialog
        open={isInstructionsOpen}
        onOpenChange={setIsInstructionsOpen}
        project={project}
        triggerRef={instructionsButtonRef}
      />

      {isSmallScreen ? (
        /** Panels need a bounded height to resize against, which a stacked phone
         *  layout cannot give them; scroll the column instead. */
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
          {detailsHeader}
          <div className="h-72 shrink-0">{instructionsSection}</div>
          {filesSection != null && <div className="h-72 shrink-0">{filesSection}</div>}
          <div className="flex min-h-[26.25rem] flex-col">{chatsSection}</div>
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          id="project-workspace"
          defaultLayout={workspaceLayout.defaultLayout}
          onLayoutChanged={workspaceLayout.onLayoutChanged}
          resizeTargetMinimumSize={RESIZE_TARGET_SIZE}
          className="min-h-0 flex-1"
        >
          <ResizablePanel
            id="project-details"
            defaultSize="45"
            minSize="25"
            maxSize="70"
            className="min-w-0"
          >
            <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 py-6 pl-4 md:pl-6">
              <div className="pr-3">{detailsHeader}</div>
              {/** The gutter before the workspace separator lives on each section rather than
               *  this column, so the details group reaches the panel edge and its horizontal
               *  separator overlaps the vertical one. Dragging that overlap resizes both
               *  groups at once, which is what moves all three panels together. */}
              <div ref={detailsGroupRef} className="min-h-0 flex-1">
                <ResizablePanelGroup
                  orientation="vertical"
                  id="project-details-panels"
                  defaultLayout={detailsLayout.defaultLayout}
                  onLayoutChanged={detailsLayout.onLayoutChanged}
                  resizeTargetMinimumSize={RESIZE_TARGET_SIZE}
                  className="h-full"
                >
                  <ResizablePanel
                    id="project-instructions"
                    defaultSize="55"
                    minSize={detailsPanelMinSize}
                    className="min-h-0"
                  >
                    <div className="h-full pr-3 pb-3">{instructionsSection}</div>
                  </ResizablePanel>
                  {filesSection != null && (
                    <>
                      <ResizableHandleAlt withHandle />
                      <ResizablePanel
                        id="project-files"
                        defaultSize="45"
                        minSize={detailsPanelMinSize}
                        className="min-h-0"
                      >
                        <div className="h-full pt-3 pr-3">{filesSection}</div>
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandleAlt withHandle />
          <ResizablePanel id="project-chats" defaultSize="55" minSize="30" className="min-w-0">
            <div className="flex h-full min-h-0 min-w-0 flex-col py-6 pr-4 pl-3 md:pr-6">
              {chatsSection}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </main>
  );
}
