import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { HatGlasses, History, Images, Plus, SlidersHorizontal } from 'lucide-react';
import {
  Button,
  EmptyState,
  Skeleton,
  Spinner,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
  TooltipAnchor,
} from '@librechat/client';
import type { ReactNode } from 'react';
import type { MediaReceipt } from '~/data-provider';
import { mergeMediaTiles, useMediaCatalog, useMediaThread, useMediaThreads } from '~/data-provider';
import { MediaForm, MediaFormComposer, MediaFormSettings } from './Form';
import { MediaHostProvider, mediaFeatures, useMediaHost } from './host';
import { mediaDraftFamily, mediaLibraryFamily } from './state';
import { MediaBalanceExplanation } from './Balance';
import useDebounce from '~/hooks/Input/useDebounce';
import { mediaThreadContext } from './context';
import { seedMediaEditDraft } from './seeding';
import { useMediaCommands } from './commands';
import { MediaDeleteDialog } from './Delete';
import { mediaErrorLabels } from './labels';
import { setDocumentTitle } from '~/utils';
import { MediaThreadView } from './Thread';
import { MediaGallery } from './Gallery';
import { useLocalize } from '~/hooks';

export default function MediaWorkspace({
  threadId,
  navigation,
  settingsToggle,
}: {
  threadId?: string;
  navigation?: ReactNode;
  settingsToggle?: ReactNode;
}) {
  const host = useMediaHost();
  const features = mediaFeatures(host);
  const localize = useLocalize();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const galleryScroll = useRef<HTMLDivElement>(null);
  const galleryPosition = useRef(0);
  const followLatest = useRef(true);
  const focusRequested = useRef<{ threadId: string | undefined }>();
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteThreadId, setDeleteThreadId] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [library, setLibrary] = useAtom(mediaLibraryFamily(host.scope));
  const [newDraft, setNewDraft] = useAtom(mediaDraftFamily(`${host.scope}:new`));
  const gallery = library.view === 'gallery' && library.threadId === threadId;
  const setView = (view: 'thread' | 'gallery') =>
    setLibrary((previous) => ({ ...previous, view, threadId }));
  const catalog = useMediaCatalog(host);
  const search = useDebounce(library.search.trim(), 250);
  const threads = useMediaThreads(host, library.filter, search, { enabled: gallery });
  const detail = useMediaThread(host, threadId);
  const visible = threads.data?.pages.flatMap((page) => page.items) ?? [];
  const commands = useMediaCommands([
    ...visible.map((thread) => thread.threadId),
    ...(detail.data ? [detail.data.thread.threadId] : []),
  ]);
  const { refreshBalance } = host;
  useEffect(() => {
    if (commands.error === 'quota_exceeded') refreshBalance?.();
  }, [commands.error, refreshBalance]);
  const { clearError } = commands;
  useEffect(() => clearError(), [threadId, clearError]);
  const recoverable = commands.pending.flatMap((command, index) => {
    const receipt = commands.receipts[index]?.data;
    if (!receipt) return [];
    let title = localize('com_media_retry_attempt');
    if (command.kind === 'submission') title = command.request.prompt;
    else if (command.kind === 'import')
      title = command.request.title ?? localize('com_media_imported');
    return [{ receipt, title }];
  });
  const tiles = mergeMediaTiles(visible, recoverable);
  const preparing = recoverable.some(
    ({ receipt }) => receipt.threadId === threadId && receipt.phase !== 'rejected',
  );
  const pendingTitle = (receipt?: MediaReceipt) =>
    localize(receipt?.phase === 'preparing' ? 'com_media_preparing' : 'com_media_restoring');
  const focusPrompt = useCallback(() => {
    if (!focusRequested.current || focusRequested.current.threadId !== threadId) return;
    const prompt = composerRef.current;
    if (!prompt || prompt.closest('[hidden]')) return;
    prompt.focus();
    if (document.activeElement === prompt) focusRequested.current = undefined;
  }, [threadId]);
  const focusComposer = (destination = { threadId }) => {
    setView('thread');
    focusRequested.current = destination;
    requestAnimationFrame(focusPrompt);
  };
  const create = () => {
    host.openThread('');
    focusComposer({ threadId: undefined });
  };
  const { latestTurn, image, video } = useMemo(
    () => mediaThreadContext(detail.data?.turns.items ?? []),
    [detail.data?.turns.items],
  );
  const imageContext = detail.data?.latestImageContext ?? image;
  const latestVideoContext = detail.data?.latestVideoContext;
  const videoContext = latestVideoContext === undefined ? video : (latestVideoContext ?? undefined);
  const hasDetail = !!detail.data;
  const hasCatalog = !!catalog.data;
  const studioTitle = localize('com_media_studio');
  const threadTitle = detail.data?.thread.title;
  useEffect(() => {
    const previous = document.title;
    setDocumentTitle(threadTitle ? `${threadTitle} | ${studioTitle}` : studioTitle);
    return () => {
      document.title = previous;
    };
  }, [threadTitle, studioTitle]);
  useEffect(() => {
    if (!focusRequested.current || gallery) return;
    const frame = requestAnimationFrame(focusPrompt);
    return () => cancelAnimationFrame(frame);
  }, [threadId, hasDetail, hasCatalog, gallery, focusPrompt]);
  useLayoutEffect(() => {
    followLatest.current = true;
  }, [threadId]);
  useLayoutEffect(() => {
    const viewport = scroll.current;
    const body = transcript.current;
    if (!viewport || !body || gallery) return;
    const settle = () => {
      if (followLatest.current) viewport.scrollTop = viewport.scrollHeight;
    };
    settle();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(settle);
    observer.observe(body);
    return () => observer.disconnect();
  }, [threadId, hasDetail, hasCatalog, gallery]);
  useEffect(() => {
    if (gallery && galleryScroll.current) galleryScroll.current.scrollTop = galleryPosition.current;
  }, [gallery, hasCatalog, hasDetail]);

  const recovery = commands.pending.length > 0 && (
    <section className="space-y-2" aria-label={localize('com_media_recovery')}>
      {commands.pending.map((command, index) => {
        const response = commands.receipts[index];
        const predecessor =
          command.kind === 'submission' && command.after
            ? commands.pending.findIndex((item) => item.request.clientRequestId === command.after)
            : -1;
        const waiting =
          predecessor >= 0 && commands.receipts[predecessor]?.data?.phase !== 'accepted';
        const unresolved =
          !waiting && !response.data && !commands.sending.has(command.request.clientRequestId);
        let status = pendingTitle(response.data);
        if (waiting) status = localize('com_media_comparison_waiting');
        else if (response.data?.phase === 'rejected')
          status = localize(mediaErrorLabels[response.data.error.code]);
        return (
          <div
            key={command.request.clientRequestId}
            className="border-border-light bg-surface-secondary flex flex-wrap items-center gap-3 rounded-xl border p-4"
          >
            {response.data?.phase !== 'rejected' && <Spinner className="size-4" />}
            <p role="status" className="text-sm">
              {status}
            </p>
            {response.data && response.data.phase !== 'rejected' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setView('thread');
                  host.openThread(response.data!.threadId);
                }}
              >
                {localize('com_media_open_thread')}
              </Button>
            )}
            {unresolved && (
              <>
                <p className="text-text-secondary text-sm">{localize('com_media_uncertain')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!host.canCreate}
                  onClick={() => void commands.send(command)}
                >
                  {localize('com_media_recover_request')}
                </Button>
              </>
            )}
            {(unresolved || response.data?.phase === 'rejected') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => commands.dismiss(command.request.clientRequestId)}
              >
                {localize('com_ui_dismiss')}
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
  const loading = (
    <div role="status" className="space-y-4">
      <span className="sr-only">{localize('com_media_loading')}</span>
      <Skeleton className="h-10" />
      <Skeleton className="h-24" />
    </div>
  );
  const catalogStatus = catalog.isError ? (
    <div role="alert">
      <EmptyState
        icon={Images}
        description={localize('com_media_load_failed')}
        action={
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            {localize('com_ui_retry')}
          </Button>
        }
      />
    </div>
  ) : (
    loading
  );
  const conversation = threadId && detail.data && (
    <MediaHostProvider
      value={{
        ...host,
        canUseInChat:
          (detail.data.thread.temporary ?? !!detail.data.thread.expiresAt)
            ? false
            : host.canUseInChat,
        createFromAsset: (asset) => {
          setNewDraft((previous) => seedMediaEditDraft(previous, [asset]));
          create();
        },
      }}
    >
      <MediaThreadView
        key={threadId}
        detail={detail.data}
        catalog={catalog.data}
        send={commands.send}
        onCompose={focusComposer}
        onDeleted={create}
        onLoadOlder={() => {
          followLatest.current = false;
        }}
      />
    </MediaHostProvider>
  );
  const renderWorkspace = (status?: ReactNode) => (
    <div
      data-testid="media-workspace"
      className="bg-presentation text-text-primary flex h-full min-h-0 w-full flex-col"
    >
      <header className="border-border-light flex min-h-14 shrink-0 items-center justify-between gap-2 border-b px-3 py-2 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {navigation}
          <Images
            className="text-text-secondary hidden size-5 shrink-0 sm:block"
            aria-hidden="true"
          />
          <h1 className="truncate text-base font-semibold">{localize('com_media_studio')}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {features.temporary && !threadId && !gallery && (
            <TooltipAnchor
              description={localize('com_media_temporary_creation')}
              render={
                <Button
                  size="icon"
                  variant="header-action"
                  className="size-9"
                  aria-pressed={!!newDraft.temporary}
                  aria-label={localize('com_media_temporary_creation')}
                  onClick={() =>
                    setNewDraft((previous) => ({
                      ...previous,
                      temporary: !previous.temporary,
                      revision: previous.revision + 1,
                    }))
                  }
                >
                  <HatGlasses className="icon-md" aria-hidden="true" />
                </Button>
              }
            />
          )}
          {!gallery && (
            <TooltipAnchor
              description={localize('com_media_open_gallery')}
              render={
                <Button
                  size="icon"
                  variant="header-action"
                  className="size-9"
                  aria-label={localize('com_media_open_gallery')}
                  onClick={() => setView('gallery')}
                >
                  <History className="icon-md" aria-hidden="true" />
                </Button>
              }
            />
          )}
          <TooltipAnchor
            description={localize('com_media_new_thread')}
            render={
              <Button
                size="icon"
                variant="header-action"
                className="size-9"
                aria-label={localize('com_media_new_thread')}
                onClick={create}
              >
                <Plus className="icon-md" aria-hidden="true" />
              </Button>
            }
          />
          {settingsToggle ? (
            settingsToggle
          ) : (
            <TooltipAnchor
              description={localize('com_media_settings')}
              render={
                <Button
                  size="icon"
                  variant="header-action"
                  className="size-9"
                  ref={settingsTrigger}
                  aria-label={localize('com_media_settings')}
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen(true)}
                >
                  <SlidersHorizontal className="icon-md" aria-hidden="true" />
                </Button>
              }
            />
          )}
        </div>
      </header>
      <div
        hidden={gallery}
        className={
          gallery
            ? 'hidden'
            : `flex min-h-0 flex-1 flex-col ${threadId ? '' : 'justify-end sm:justify-center'}`
        }
      >
        <div
          ref={scroll}
          data-testid="media-transcript"
          className={
            'min-h-0 scrollbar-gutter-stable overflow-y-auto overscroll-contain ' +
            (threadId ? 'flex-1' : '')
          }
          onScroll={() => {
            const viewport = scroll.current;
            if (viewport && !gallery)
              followLatest.current =
                viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
          }}
        >
          <div
            ref={transcript}
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 xl:max-w-4xl"
          >
            {recovery}
            {!threadId && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center">
                <Images
                  className="text-text-secondary size-10"
                  strokeWidth={1.25}
                  aria-hidden="true"
                />
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {localize('com_media_welcome')}
                </h2>
                <p className="text-text-secondary max-w-md text-sm leading-6">
                  {localize('com_media_welcome_description')}
                </p>
              </div>
            )}
            {threadId && detail.isLoading && loading}
            {threadId && detail.isError && (
              <div role={preparing ? 'status' : 'alert'}>
                <EmptyState
                  icon={Images}
                  description={localize(
                    preparing ? 'com_media_preparing' : 'com_media_thread_unavailable',
                  )}
                  action={
                    <Button variant="outline" onClick={() => void detail.refetch()}>
                      {localize('com_ui_retry')}
                    </Button>
                  }
                />
              </div>
            )}
            {conversation}
          </div>
        </div>
        <div className="bg-presentation shrink-0 px-4 pt-2 pb-4 sm:px-6">
          <div className="mx-auto w-full max-w-3xl space-y-3 xl:max-w-4xl">
            {status ?? <MediaFormComposer />}
            {commands.error && (
              <div role="alert" className="space-y-2 text-sm">
                <p>{localize(mediaErrorLabels[commands.error])}</p>
                {commands.error === 'quota_exceeded' && <MediaBalanceExplanation />}
                {commands.error === 'stale_catalog' && (
                  <Button variant="outline" onClick={() => void catalog.refetch()}>
                    {localize('com_media_refresh_models')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {gallery && (
        <div
          ref={galleryScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6"
          onScroll={() => {
            galleryPosition.current = galleryScroll.current?.scrollTop ?? 0;
          }}
        >
          <div className="mx-auto max-w-screen-2xl space-y-5">
            {recovery}
            <MediaGallery
              tiles={tiles}
              catalog={catalog.data}
              query={threads}
              filter={library.filter}
              search={library.search}
              columns={library.columns}
              onDelete={(id) => {
                setDeleteThreadId(id);
                setDeleteOpen(true);
              }}
              onFilter={(filter) => setLibrary((previous) => ({ ...previous, filter }))}
              onSearch={(search) => setLibrary((previous) => ({ ...previous, search }))}
              onColumns={(columns) => setLibrary((previous) => ({ ...previous, columns }))}
              onOpen={(id) => {
                host.openThread(id);
                focusComposer({ threadId: id });
              }}
              onCreate={create}
            />
          </div>
        </div>
      )}
      <MediaDeleteDialog
        host={host}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        request={{ mode: 'selected', threadIds: deleteThreadId ? [deleteThreadId] : [] }}
      />
      {!settingsToggle && (
        <OGDialog open={settingsOpen} onOpenChange={setSettingsOpen} triggerRef={settingsTrigger}>
          <OGDialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto">
            <OGDialogTitle>{localize('com_media_settings')}</OGDialogTitle>
            <OGDialogDescription>{localize('com_media_settings_description')}</OGDialogDescription>
            {status ?? <MediaFormSettings />}
          </OGDialogContent>
        </OGDialog>
      )}
    </div>
  );
  if (!catalog.data || (threadId && !detail.data)) {
    const status =
      catalog.data && detail.isError && !preparing ? (
        <p className="text-text-secondary text-sm">{localize('com_media_thread_unavailable')}</p>
      ) : (
        catalogStatus
      );
    return renderWorkspace(status);
  }
  return (
    <MediaForm
      key={threadId ?? 'new'}
      catalog={catalog.data}
      composerRef={composerRef}
      threadId={threadId}
      initialSelection={latestTurn?.selection}
      imageContext={imageContext}
      videoContext={videoContext}
      videoContextUnavailable={latestVideoContext === null && !!video}
      send={commands.send}
      busy={commands.sending.size > 0}
      portal={!!settingsToggle}
    >
      {renderWorkspace()}
    </MediaForm>
  );
}
