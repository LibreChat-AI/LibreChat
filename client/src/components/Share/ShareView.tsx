import { memo, useState, useCallback, useContext } from 'react';
import Cookies from 'js-cookie';
import { useStore } from 'jotai';
import { buildTree } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useParams, useNavigate } from 'react-router-dom';
import { useGetSharedMessages } from 'librechat-data-provider/react-query';
import { CalendarDays, ExternalLink, RefreshCw, Settings, MessageSquarePlus } from 'lucide-react';
import {
  Spinner,
  Button,
  OGDialog,
  Separator,
  ThemeContext,
  OGDialogTitle,
  useMediaQuery,
  OGDialogHeader,
  OGDialogContent,
  OGDialogTrigger,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import {
  CodeHighlightThrottleContext,
  normalizeCodeHighlightThrottleMs,
} from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import SharedSubagentActivityDialog from '~/components/Chat/Subagents/SharedSubagentActivityDialog';
import { cn, DEFAULT_APP_TITLE, getResponseStatus, selectActiveBranchTail } from '~/utils';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { useLocalize, useDocumentTitle, useAuthContext } from '~/hooks';
import { ThemeSelector, LangSelector } from '~/components/Appearance';
import { ShareMessagesProvider } from './ShareMessagesProvider';
import { useForkSharedConvoMutation } from '~/data-provider';
import { useGetSharedStartupConfig } from '~/data-provider';
import { ShareArtifactsContainer } from './ShareArtifacts';
import AppChatSurface from '../Chat/Surface';
import { ShareContext } from '~/Providers';
import MessagesView from './MessagesView';
import Footer from '../Chat/Footer';
import store from '~/store';

/** Root sibling-index key used by the shared MessagesView/MultiMessage tree. */
const SHARED_CONVO_KEY = 'shared-conversation';

function SharedView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const { isAuthReady } = useAuthContext();
  const { theme, setTheme } = useContext(ThemeContext);
  const { shareId } = useParams();
  const jotaiStore = useStore();
  const { data: config } = useGetSharedStartupConfig(shareId, { enabled: isAuthReady });
  const { data, isLoading, isFetching, refetch } = useGetSharedMessages(shareId ?? '', {
    enabled: isAuthReady,
  });
  const dataTree = data && buildTree({ messages: data.messages });
  const messagesTree = dataTree?.length === 0 ? null : (dataTree ?? null);

  const [langcode, setLangcode] = useRecoilState(store.lang);

  const forkShare = useForkSharedConvoMutation({
    onSuccess: (forkData) => {
      navigate(`/c/${forkData.conversation.conversationId}`);
    },
    onError: (error) => {
      const status = getResponseStatus(error);
      /** A 401 means the viewer isn't authenticated; the request interceptor
       *  routes them through login (with a redirect back to this share), so a
       *  generic error toast would be misleading noise before the redirect. */
      if (status === 401) {
        return;
      }
      /** A 409 means the owner republished the link between the load and the
       *  request, so the payload this fork was aimed at no longer exists. Pull
       *  the current version in so a retry continues what is on screen. */
      if (status === 409) {
        void refetch();
        showToast({ message: localize('com_ui_shared_link_updated'), status: 'warning' });
        return;
      }
      showToast({
        message:
          status === 429
            ? localize('com_ui_fork_error_rate_limit')
            : localize('com_ui_continue_chat_error'),
        status: 'error',
      });
    },
  });

  /** Resolve the index, within the shared payload, of the message at the tip of
   *  the branch the viewer currently has active (default or manually navigated),
   *  so the fork continues that exact branch instead of the newest sibling.
   *  Mirrors the share tree's sibling selection, which is keyed by parent id with
   *  the root on SHARED_CONVO_KEY. An index is sent (not id or createdAt) because
   *  shared ids are re-anonymized per request and createdAt can collide, while
   *  the payload order is stable across requests. */
  const getActiveTargetIndex = useCallback(() => {
    const messages = data?.messages;
    if (messages == null || messages.length === 0) {
      return undefined;
    }
    const getSiblingIndex = (parentMessageId: string | null | undefined) =>
      jotaiStore.get(siblingIdxFamily(siblingKey(parentMessageId ?? SHARED_CONVO_KEY)));
    const tail = selectActiveBranchTail(messages, SHARED_CONVO_KEY, getSiblingIndex);
    if (tail == null) {
      return undefined;
    }
    const index = messages.findIndex((message) => message.messageId === tail.messageId);
    return index >= 0 ? index : undefined;
  }, [data?.messages, jotaiStore]);

  const { mutate: forkSharedConvo } = forkShare;
  const handleContinue = useCallback(() => {
    if (shareId == null || shareId === '') {
      return;
    }
    forkSharedConvo({
      shareId,
      targetMessageIndex: getActiveTargetIndex(),
      shareRevision: data?.updatedAt,
    });
  }, [shareId, forkSharedConvo, getActiveTargetIndex, data?.updatedAt]);

  // configure document title
  const chatTitleInTab = useRecoilValue(store.chatTitleInTab);
  let docTitle = '';
  if (!chatTitleInTab) {
    docTitle = config?.appTitle || DEFAULT_APP_TITLE;
  } else if (config?.appTitle != null && data?.title != null) {
    docTitle = `${data.title} | ${config.appTitle}`;
  } else {
    docTitle = data?.title ?? config?.appTitle ?? document.title;
  }

  useDocumentTitle(docTitle);

  const locale =
    langcode ||
    (typeof navigator !== 'undefined'
      ? navigator.language || navigator.languages?.[0] || 'en-US'
      : 'en-US');

  const formattedDate =
    data?.createdAt != null
      ? new Date(data.createdAt).toLocaleDateString(locale, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : null;

  const handleThemeChange = useCallback(
    (value: string) => {
      setTheme(value);
    },
    [setTheme],
  );

  const handleLangChange = useCallback(
    (value: string) => {
      let userLang = value;
      if (value === 'auto') {
        userLang =
          (typeof navigator !== 'undefined'
            ? navigator.language || navigator.languages?.[0]
            : null) ?? 'en-US';
      }

      setLangcode(userLang);
      Cookies.set('lang', userLang, { expires: 365 });
    },
    [setLangcode],
  );

  let content: JSX.Element;
  if (!isAuthReady || isLoading) {
    content = (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="" />
      </div>
    );
  } else if (data && messagesTree && messagesTree.length !== 0) {
    content = (
      <>
        <ShareHeader
          title={data.title}
          formattedDate={formattedDate}
          theme={theme}
          langcode={langcode}
          onThemeChange={handleThemeChange}
          onLangChange={handleLangChange}
          settingsLabel={localize('com_nav_settings')}
          continueLabel={localize('com_ui_continue_chat')}
          langfuseSessionLabel={localize('com_ui_langfuse_view_session')}
          langfuseSessionUrl={data.langfuseSessionUrl}
          onContinue={handleContinue}
          isContinuing={forkShare.isLoading}
        />
        <ShareMessagesProvider messages={data.messages}>
          <MessagesView messagesTree={messagesTree} conversationId={SHARED_CONVO_KEY} />
        </ShareMessagesProvider>
      </>
    );
  } else {
    content = (
      <SharedLinkUnavailable
        message={localize('com_ui_shared_link_not_found')}
        retryLabel={localize('com_ui_retry')}
        isRetrying={isFetching}
        onRetry={() => void refetch()}
      />
    );
  }

  const footer = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-surface-secondary from-40% to-transparent">
      <Footer
        startupConfig={config ?? null}
        className="pointer-events-auto relative mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-2 px-3 pb-4 pt-6 text-center text-xs text-text-secondary"
      />
    </div>
  );

  const mainContent = (
    <div className="transition-width relative flex h-full w-full flex-1 flex-col items-stretch overflow-hidden bg-surface-secondary pt-0">
      <div className="relative flex h-full min-h-0 flex-col text-text-primary" role="presentation">
        {content}
        {footer}
      </div>
    </div>
  );

  const artifactsContainer =
    data && data.messages ? (
      <ShareArtifactsContainer
        messages={data.messages}
        conversationId={data.conversationId}
        mainContent={mainContent}
      />
    ) : (
      mainContent
    );

  return (
    <CodeHighlightThrottleContext.Provider
      value={normalizeCodeHighlightThrottleMs(config?.interface?.codeHighlightThrottleMs)}
    >
      <ShareContext.Provider
        value={{ isSharedConvo: true, shareId, hasConfiguredSender: data?.hasConfiguredSender }}
      >
        <AppChatSurface>
          <div className="relative flex h-screen w-full overflow-hidden dark:bg-surface-secondary">
            <main className="relative flex w-full grow overflow-hidden dark:bg-surface-secondary">
              {artifactsContainer}
            </main>
          </div>
          <SharedSubagentActivityDialog shareId={shareId} />
        </AppChatSurface>
      </ShareContext.Provider>
    </CodeHighlightThrottleContext.Provider>
  );
}

export function SharedLinkUnavailable({
  message,
  retryLabel,
  isRetrying,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <p>{message}</p>
      <Button type="button" variant="outline" onClick={onRetry} disabled={isRetrying}>
        {isRetrying ? (
          <Spinner className="size-4" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        {retryLabel}
      </Button>
    </div>
  );
}

function ShareTitle({ title }: { title?: string }) {
  if (title == null || title === '') {
    return null;
  }

  return (
    <TooltipAnchor
      description={title}
      side="bottom"
      tabIndex={0}
      className="block min-w-0 max-w-full cursor-default"
      render={
        <h1
          data-testid="share-title"
          className="cursor-default truncate text-2xl font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary md:text-4xl"
        >
          {title}
        </h1>
      }
    />
  );
}

interface ShareHeaderProps {
  title?: string;
  formattedDate: string | null;
  theme: string;
  langcode: string;
  settingsLabel: string;
  continueLabel: string;
  langfuseSessionLabel: string;
  langfuseSessionUrl?: string;
  isContinuing: boolean;
  onContinue: () => void;
  onThemeChange: (value: string) => void;
  onLangChange: (value: string) => void;
}

export function ShareHeader({
  title,
  formattedDate,
  theme,
  langcode,
  settingsLabel,
  continueLabel,
  langfuseSessionLabel,
  langfuseSessionUrl,
  isContinuing,
  onContinue,
  onThemeChange,
  onLangChange,
}: ShareHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsContent, setSettingsContent] = useState<HTMLDivElement | null>(null);
  const isMobile = useMediaQuery('(max-width: 767px)');

  const handleDialogOutside = useCallback((event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-dialog-ignore="true"], .popover-ui')) {
      event.preventDefault();
    }
  }, []);

  return (
    <section className="mx-auto w-full px-2 pb-3 pt-4 md:px-5 md:pb-4 md:pt-6">
      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-3 rounded-2xl border border-border-light bg-surface-secondary px-4 py-4 shadow-xl md:gap-4 md:rounded-3xl md:px-6 md:py-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1 space-y-1.5 md:space-y-2">
            <ShareTitle title={title} />
            {formattedDate && (
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <CalendarDays className="size-4" aria-hidden="true" />
                <span>{formattedDate}</span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 md:flex-nowrap md:self-start">
            {langfuseSessionUrl && (
              <Button
                asChild
                variant="outline"
                className="gap-2 rounded-full border-border-medium px-4 py-2 text-sm text-text-primary"
              >
                <a href={langfuseSessionUrl} target="_blank" rel="noopener noreferrer">
                  <span>{langfuseSessionLabel}</span>
                  <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                </a>
              </Button>
            )}
            <Button
              type="button"
              variant="submit"
              onClick={onContinue}
              disabled={isContinuing}
              className="gap-2 rounded-full px-4 py-2 text-sm"
            >
              {isContinuing ? (
                <Spinner className="size-4" />
              ) : (
                <MessageSquarePlus className="size-4" aria-hidden="true" />
              )}
              {continueLabel}
            </Button>
            <OGDialog open={settingsOpen} onOpenChange={setSettingsOpen}>
              <OGDialogTrigger asChild>
                <Button
                  size={isMobile ? 'icon' : 'default'}
                  type="button"
                  variant="outline"
                  aria-label={settingsLabel}
                  className={cn(
                    'rounded-full border-border-medium text-sm text-text-primary transition-colors',
                    isMobile
                      ? 'absolute bottom-4 right-4 justify-center p-0 shadow-lg'
                      : 'gap-2 self-start px-4 py-2',
                  )}
                >
                  <Settings className="size-4" aria-hidden="true" />
                  <span className="hidden md:inline">{settingsLabel}</span>
                </Button>
              </OGDialogTrigger>
              <OGDialogContent
                ref={setSettingsContent}
                className="w-11/12 max-w-lg overflow-y-visible"
                showCloseButton={true}
                onPointerDownOutside={handleDialogOutside}
                onInteractOutside={handleDialogOutside}
              >
                <OGDialogHeader className="text-left">
                  <OGDialogTitle>{settingsLabel}</OGDialogTitle>
                </OGDialogHeader>
                <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pt-2 text-sm">
                  <ThemeSelector
                    theme={theme}
                    onChange={onThemeChange}
                    portalElement={settingsContent}
                    popoverClassName="z-[150]"
                  />
                  <Separator orientation="horizontal" className="bg-border-medium/60" />
                  <LangSelector
                    langcode={langcode}
                    onChange={onLangChange}
                    portalElement={settingsContent}
                    popoverClassName="z-[150]"
                  />
                </div>
              </OGDialogContent>
            </OGDialog>
          </div>
        </div>
      </div>
    </section>
  );
}

export default memo(SharedView);
