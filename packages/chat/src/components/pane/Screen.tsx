import { useMemo } from 'react';
import { useLocalize } from '@librechat/client';
import { buildTree } from 'librechat-data-provider';
import type { TChatProject, TFile, TMessage } from 'librechat-data-provider';
import type { ReactElement, ReactNode, RefObject } from 'react';
import type { ChatPaneProps } from './ChatPane';
import type { ChatPaneChrome } from './chrome';
import { useChatContext } from '../../react/chat/context';
import { getChatPaneChrome } from './chrome';
import { getChatPaneView } from './view';
import ChatPane from './ChatPane';

/** What the composer slot needs from the pane's decisions. */
export type ChatScreenComposerProps = {
  isLanding: boolean;
  /** A footer sits below the composer, so its clearance accounts for the bar. */
  footerBelow: boolean;
  /** The project a new chat starts in, on a project's welcome screen. */
  project?: TChatProject;
  /** The composer's placeholder on a project's welcome screen. */
  placeholder?: string;
};

export type ChatScreenProps = Pick<
  ChatPaneProps,
  'index' | 'landing' | 'renderColumn' | 'starters'
> & {
  /** The routed conversation. */
  conversationId?: string;
  /** The session's messages, flat; `null` before it has any. */
  messages: TMessage[] | null;
  /** The conversation's files by id, which hydrate the files of the tree's messages. */
  fileMap?: Record<string, TFile>;
  /** The session is loading the routed conversation. */
  isLoading: boolean;
  /** The project the route opens a new chat in. */
  project?: TChatProject;
  /** The deployment shows the full footer on the welcome screen. */
  landingFooter: boolean;
  /** The deployment configured footer content. */
  configuredFooter: boolean;
  /** The pane's header, given the pane's decisions (a subagent thread's parent, read-only). */
  renderHeader?: (chrome: ChatPaneChrome) => ReactNode;
  /** The badge of the routed conversation's project. */
  renderBadge?: (projectId: string) => ReactNode;
  /** The message list, given the session's messages and the tree built from them. */
  renderMessages: (props: {
    messagesTree: TMessage[] | null;
    messages: TMessage[] | null;
  }) => ReactNode;
  /** The composer, unless the thread is read-only. */
  renderComposer?: (props: ChatScreenComposerProps) => ReactNode;
  /** The footer: the full one below the column, or the configured one inside the composer band. */
  renderFooter?: (placement: 'full' | 'band') => ReactNode;
  /** Rendered beside the composer band, given the band and whether the welcome screen shows. */
  renderMascot?: (bandRef: RefObject<HTMLDivElement>, isLanding: boolean) => ReactNode;
};

/**
 * A chat screen: builds the message tree from the session, decides the pane's layout, heading,
 * footers, project and read-only state, and lays them out in `ChatPane`. The app supplies the
 * surfaces as slots; the slots that depend on a decision receive it instead of recomputing it.
 */
export default function ChatScreen({
  index = 0,
  conversationId,
  messages,
  fileMap,
  isLoading,
  project,
  landingFooter,
  configuredFooter,
  landing,
  renderColumn,
  starters,
  renderHeader,
  renderBadge,
  renderMessages,
  renderComposer,
  renderFooter,
  renderMascot,
}: ChatScreenProps): ReactElement {
  const localize = useLocalize();
  const { conversation } = useChatContext();

  const messagesTree = useMemo(() => {
    const tree = buildTree({ messages, fileMap });
    return tree?.length === 0 ? null : (tree ?? null);
  }, [messages, fileMap]);

  const view = getChatPaneView({
    conversationId,
    isLoading,
    hasMessages: messagesTree != null && messagesTree.length > 0,
  });
  const chrome = getChatPaneChrome({
    view,
    conversation,
    conversationId,
    project,
    landingFooter,
    configuredFooter,
  });
  const { landingProject } = chrome;

  return (
    <ChatPane
      index={index}
      view={view}
      heading={chrome.title ?? localize('com_ui_new_chat')}
      header={renderHeader?.(chrome)}
      badge={chrome.projectId != null ? renderBadge?.(chrome.projectId) : null}
      messages={renderMessages({ messagesTree, messages })}
      landing={landing}
      renderColumn={renderColumn}
      starters={starters}
      readOnlyNote={chrome.readOnly ? localize('com_ui_subagent_thread_read_only') : undefined}
      composer={renderComposer?.({
        isLanding: view.isLanding,
        footerBelow: chrome.footerBelow,
        project: landingProject,
        placeholder:
          landingProject != null
            ? localize('com_ui_new_chat_in_project', { name: landingProject.name })
            : undefined,
      })}
      bandFooter={chrome.bandFooter ? renderFooter?.('band') : null}
      footer={chrome.fullFooter ? renderFooter?.('full') : null}
      renderMascot={renderMascot ? (bandRef) => renderMascot(bandRef, view.isLanding) : undefined}
    />
  );
}
