import { useMemo } from 'react';
import { useAtom } from 'jotai';
import { History, Plus } from 'lucide-react';
import { useNavigate, useMatch } from 'react-router-dom';
import { Alert, Button, Skeleton } from '@librechat/client';
import type { MediaCatalog, MediaThreadDetail } from 'librechat-data-provider';
import type { MediaHost } from './host';
import { useMediaCatalog, useMediaThread } from '~/data-provider';
import { useMediaDraftForm } from './useMediaDraftForm';
import { useMediaShellHost } from '~/hooks/Media/host';
import { getMediaSelection } from './selection';
import { mediaThreadContext } from './context';
import { mediaLibraryFamily } from './state';
import { MediaHostProvider } from './host';
import { MediaSettings } from './Settings';
import { useLocalize } from '~/hooks';

function Settings({
  catalog,
  threadId,
  detail,
}: {
  catalog: MediaCatalog;
  threadId?: string;
  detail?: MediaThreadDetail;
}) {
  const { latestTurn, image, video } = mediaThreadContext(detail?.turns.items ?? []);
  const latestVideoContext = detail?.latestVideoContext;
  const form = useMediaDraftForm({
    catalog,
    threadId,
    initialSelection: latestTurn?.selection,
    imageContext: detail?.latestImageContext ?? image,
    videoContext: latestVideoContext === undefined ? video : (latestVideoContext ?? undefined),
    videoContextUnavailable: latestVideoContext === null && !!video,
    portal: true,
    normalizeDraft: false,
  });
  return <MediaSettings form={form} selection={getMediaSelection(form)} />;
}

export default function MediaSettingsPanel() {
  const threadId = useMatch('/studio/threads/:threadId')?.params.threadId;
  const navigate = useNavigate();
  const actions = useMemo(
    () => ({
      openThread: (id: string) =>
        navigate(id ? `/studio/threads/${encodeURIComponent(id)}` : '/studio'),
    }),
    [navigate],
  );
  const { host } = useMediaShellHost(actions);
  if (!host) return null;
  return (
    <MediaHostProvider value={host}>
      <MediaSettingsContent host={host} threadId={threadId} />
    </MediaHostProvider>
  );
}
export function MediaSettingsContent({ host, threadId }: { host: MediaHost; threadId?: string }) {
  const localize = useLocalize();
  const [library, setLibrary] = useAtom(mediaLibraryFamily(host.scope));
  const gallery = library.view === 'gallery' && library.threadId === threadId;
  const switchView = () => {
    if (gallery) {
      host.openThread('');
      setLibrary((previous) => ({ ...previous, view: 'thread', threadId: undefined }));
      return;
    }
    setLibrary((previous) => ({ ...previous, view: 'gallery', threadId }));
  };
  const catalog = useMediaCatalog(host);
  const detail = useMediaThread(host, threadId);
  let content = (
    <div role="status">
      <span className="sr-only">{localize('com_media_loading')}</span>
      <Skeleton className="h-32" />
    </div>
  );
  if (catalog.isError)
    content = (
      <Alert variant="error">
        {localize('com_media_load_failed')}
        <Button variant="outline" onClick={() => void catalog.refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </Alert>
    );
  else if (catalog.data && (!threadId || detail.data))
    content = <Settings catalog={catalog.data} threadId={threadId} detail={detail.data} />;
  else if (detail.isError)
    content = <Alert variant="error">{localize('com_media_thread_unavailable')}</Alert>;
  return (
    <div className="space-y-4 px-3 pt-3 pb-6">
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{localize('com_media_settings')}</h2>
        <Button variant="subtle" size="sm" className="w-full" onClick={switchView}>
          {gallery ? (
            <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <History className="size-4" strokeWidth={1.75} aria-hidden="true" />
          )}
          {localize(gallery ? 'com_media_new_thread' : 'com_media_open_gallery')}
        </Button>
      </div>
      {content}
    </div>
  );
}
