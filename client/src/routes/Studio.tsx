import { useMemo, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { useRecoilValue } from 'recoil';
import { SlidersHorizontal } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Skeleton,
  Alert,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
  TooltipAnchor,
} from '@librechat/client';
import type { MediaAsset } from 'librechat-data-provider';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { mediaChatHandoff } from '~/components/Media/handoff';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { MediaHostProvider } from '~/components/Media/host';
import useSidebarState from '~/hooks/Nav/useSidebarState';
import MediaWorkspace from '~/components/Media/Workspace';
import { useMediaShellHost } from '~/hooks/Media/host';
import { cacheMediaAssets } from '~/data-provider';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function Studio() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const localize = useLocalize();
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const [asset, setAsset] = useState<MediaAsset>();
  const chatTrigger = useRef<HTMLButtonElement | null>(null);
  const setHandoff = useSetAtom(mediaChatHandoff);
  const { expanded } = useSidebarState();
  const { toggleSidebar } = useSidebarToggle();
  const actions = useMemo(
    () => ({
      openThread: (id: string) =>
        navigate(id ? `/studio/threads/${encodeURIComponent(id)}` : '/studio'),
      useInChat: async (value: MediaAsset) => {
        if (document.activeElement instanceof HTMLButtonElement)
          chatTrigger.current = document.activeElement;
        setAsset(value);
      },
    }),
    [navigate],
  );
  const { host, media, userId, loading, failed, reload } = useMediaShellHost(actions);
  const handoff = (conversationId: string) => {
    if (!asset || !userId || !host?.isCurrentSession()) return;
    cacheMediaAssets(client, userId, [asset]);
    setHandoff({ scope: host.scope, conversationId, asset });
    setAsset(undefined);
    navigate(`/c/${encodeURIComponent(conversationId)}`);
  };
  if (loading)
    return (
      <main aria-busy="true" className="text-text-primary space-y-5 p-6">
        <h1 className="text-2xl font-semibold">{localize('com_media_studio')}</h1>
        <p role="status" className="sr-only">
          {localize('com_media_loading')}
        </p>
        <Skeleton className="h-64" />
      </main>
    );
  if (failed)
    return (
      <main className="p-6">
        <Alert variant="error">
          <p>{localize('com_media_load_failed')}</p>
          <Button variant="outline" onClick={() => void reload()}>
            {localize('com_ui_retry')}
          </Button>
        </Alert>
      </main>
    );
  if (!host || !media?.studio)
    return (
      <main className="text-text-primary p-6">
        <p role="status">{localize('com_media_unavailable')}</p>
      </main>
    );
  return (
    <main className="bg-presentation flex h-full min-h-0 w-full flex-col">
      <MediaHostProvider value={host}>
        <MediaWorkspace
          threadId={threadId}
          settingsToggle={
            <TooltipAnchor
              description={localize('com_media_settings')}
              render={
                <Button
                  size="icon"
                  variant="header-action"
                  className="size-9"
                  aria-label={localize('com_media_settings')}
                  aria-expanded={expanded}
                  onClick={toggleSidebar}
                >
                  <SlidersHorizontal className="icon-md" aria-hidden="true" />
                </Button>
              }
            />
          }
          navigation={
            <span className="md:hidden">
              <OpenSidebar testId="studio-open-sidebar-button" />
            </span>
          }
        />
      </MediaHostProvider>
      <OGDialog
        open={!!asset}
        triggerRef={chatTrigger}
        onOpenChange={(open) => {
          if (!open) setAsset(undefined);
        }}
      >
        <OGDialogContent className="w-11/12 max-w-md">
          <OGDialogTitle>{localize('com_media_use_chat')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_media_chat_destination')}</OGDialogDescription>
          <div className="flex flex-wrap gap-2">
            {conversation?.conversationId && conversation.conversationId !== 'new' && (
              <Button variant="outline" onClick={() => handoff(conversation.conversationId!)}>
                {localize('com_media_current_chat')}
              </Button>
            )}
            <Button onClick={() => handoff('new')}>{localize('com_media_new_chat')}</Button>
          </div>
        </OGDialogContent>
      </OGDialog>
    </main>
  );
}
