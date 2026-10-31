import { useRef } from 'react';
import { useAtomValue } from 'jotai';
import { cn, Spinner } from '@librechat/client';
import type { ReactElement, ReactNode, RefObject } from 'react';
import type { ChatPaneColumn, ChatPaneView } from './view';
import { composerLiftFamily } from '../../react/lift';

export type ChatPaneProps = {
  /** The pane's index among the open panes; scopes pane-local state such as the composer lift. */
  index?: number;
  /** The layout and the column to show; `getChatPaneView` derives both from the session. */
  view: ChatPaneView;
  /** The page's visually hidden heading: the conversation title or the new-chat label. */
  heading: string;
  /** The pane's header bar. */
  header?: ReactNode;
  /** A strip pinned above the message column, such as the conversation's project. The column
   *  leaves room for it below the header. */
  badge?: ReactNode;
  /** The message list, shown when the column is `messages`. */
  messages?: ReactNode;
  /** The welcome screen, shown when the column is `landing`. */
  landing?: ReactNode;
  /** Wraps whichever column is showing, so a provider it needs stays mounted across views. */
  renderColumn?: (column: ReactNode) => ReactNode;
  /** Shown above the composer on the welcome screen, such as conversation starters. */
  starters?: ReactNode;
  /** The composer. */
  composer?: ReactNode;
  /** Replaces the composer with a note, for a conversation the reader cannot continue. */
  readOnlyNote?: string;
  /** Inside the composer band, under the composer. */
  bandFooter?: ReactNode;
  /** Below the whole column. */
  footer?: ReactNode;
  /** Rendered beside the composer band, given the band to position against. */
  renderMascot?: (bandRef: RefObject<HTMLDivElement>) => ReactNode;
};

function LoadingSpinner(): ReactElement {
  return (
    <div className="relative flex-1 overflow-hidden overflow-y-auto">
      <div className="text-text-primary relative flex h-full items-center justify-center">
        <Spinner />
      </div>
    </div>
  );
}

const columns: Record<ChatPaneColumn, (props: ChatPaneProps) => ReactNode> = {
  loading: () => <LoadingSpinner />,
  landing: ({ landing }) => landing,
  messages: ({ messages }) => messages,
};

/**
 * A chat pane's layout: the hidden page heading, the header, and a column holding the
 * messages (or the welcome screen) above the composer band. Every surface arrives as a slot,
 * so the app decides what fills it and the pane owns only how they sit together.
 */
export default function ChatPane(props: ChatPaneProps): ReactElement {
  const {
    index = 0,
    view,
    heading,
    header,
    badge,
    renderColumn,
    starters,
    composer,
    readOnlyNote,
    bandFooter,
    footer,
    renderMascot,
  } = props;
  const { isLanding } = view;
  /** Room an open composer popover needs below the composer; see the atom. */
  const composerLift = useAtomValue(composerLiftFamily(index));
  const bandRef = useRef<HTMLDivElement>(null);
  const column = columns[view.column](props);

  return (
    <>
      <h1 className="sr-only">{heading}</h1>
      {/* Marks the header's controls as this pane's, so a pane-scoped shortcut pressed from
          them acts here, not on the first pane. */}
      <div data-chat-pane-portal={index} className="contents">
        {header}
      </div>
      {!isLanding && badge}
      <div
        data-chat-pane={index}
        style={
          isLanding && composerLift > 0
            ? { transform: `translateY(-${composerLift}px)` }
            : undefined
        }
        className={cn(
          'flex flex-col',
          isLanding && 'relative',
          isLanding
            ? /* The gutter is reserved once per state, wherever the centring happens. A
                 conversation centres the composer inside the band below, against a message
                 column that holds the scrollbar band back; the landing page centres this whole
                 column instead, greeting and composer together, so it holds the same band back
                 here. Without it the composer lands 4px right of where a conversation puts it
                 and slides sideways on the way in. */
              'scrollbar-gutter-spacer flex-1 items-center justify-end sm:justify-center'
            : 'h-full overflow-y-auto',
          !isLanding && badge != null && 'pt-9',
        )}
      >
        {renderColumn ? renderColumn(column) : column}
        {/* Named + opaque so a view transition (the ask_user_question popover and chat-card
            morph) paints the whole composer band over the travelling card instead of letting
            it show through below the composer. The background matches the page, so normal
            rendering is unchanged. The named surface is a stacking context; keep it above
            positioned tool glyphs so they cannot paint through the approval preview. */}
        <div
          ref={bandRef}
          className={cn(
            'bg-surface-canvas relative z-10 w-full [view-transition-name:chat-form]',
            !isLanding && 'scrollbar-gutter-spacer',
            isLanding && 'max-w-3xl transition-all duration-200 xl:max-w-4xl',
          )}
        >
          {isLanding && starters}
          {readOnlyNote != null ? (
            <div
              className="text-text-secondary mx-auto w-full max-w-3xl px-4 py-3 text-center text-sm xl:max-w-4xl"
              role="note"
            >
              {readOnlyNote}
            </div>
          ) : (
            composer
          )}
          {bandFooter}
        </div>
        {renderMascot?.(bandRef)}
      </div>
      {footer}
    </>
  );
}
