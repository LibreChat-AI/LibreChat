import { useRef, useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { ArrowUpRight, X } from 'lucide-react';
import { cn, Button, Composer, useLocalize, useFocusTrap } from '@librechat/client';
import type { ComposerStopProps, ComposerKeyVerdict } from '@librechat/client';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { ChatContract } from '../../react/chat/contract';
import type { SideChat } from '../../react/side/state';
import type { SubmittedTurn } from '../../core';
import { SIDE_CHAT_PANE, sideChatDraftFamily } from '../../react/side/state';
import { useChatSurface } from '../../react/subagents/surface';
import { resolveComposerKeyDown } from '../../core/shortcuts';
import { useSideChatHost } from '../../react/side/host';
import { useChatHost } from '../../react/chat/host';
import DrivenThread from '../pane/Driven';

type SideChatComposerProps = {
  contract: ChatContract;
  /** The reader's unsent words, which the panel holds so they outlive the composer. */
  value: string;
  onChange: (value: string) => void;
  conversationId: string;
  title: string;
  /** Whether the conversation is in and the pane holds it, so a turn can be built for it. */
  ready: boolean;
  /** Words written for this conversation before it opened; see {@link SideChat.text}. */
  handedText?: string;
  onHandedTextTaken: () => void;
  clearsFooter: boolean;
};

/**
 * The side chat's composer: main chat's field at panel scale. Sending is the contract's `ask`,
 * and with nothing typed while a generation runs the send control is main chat's Stop.
 */
function SideChatComposer({
  contract,
  value,
  onChange: setValue,
  conversationId,
  title,
  ready,
  handedText,
  onHandedTextTaken,
  clearsFooter,
}: SideChatComposerProps): ReactNode {
  const localize = useLocalize();
  const {
    enterToSend,
    composerBindings: { shortcutsEnabled, submitOverride, yieldedChords },
  } = useChatSurface();
  const { ask, isSubmitting, stopGenerating } = contract;

  /**
   * Words the reader wrote before this conversation opened are its next turn. They are sent
   * once, when the conversation can take them; if it cannot, they are left in the field.
   */
  const handed = useRef<string>();
  useEffect(() => {
    if (!ready || handedText == null || handedText === '' || handed.current === conversationId) {
      return;
    }
    handed.current = conversationId;
    if (ask({ text: handedText }) === false) {
      setValue(handedText);
    }
    onHandedTextTaken();
  }, [ask, conversationId, handedText, onHandedTextTaken, ready, setValue]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (text === '' || ask({ text }) === false) {
      return;
    }
    setValue('');
  }, [ask, setValue, value]);

  /** The main chat form's own Enter decision table, so a rebound submit shortcut holds here. */
  const resolveKeyVerdict = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>, isComposing: boolean): ComposerKeyVerdict => {
      const action = resolveComposerKeyDown(event, {
        isComposing,
        isSubmitting: false,
        allowSubmitWhileGenerating: false,
        hasDuringRunModifier: false,
        shortcutsEnabled,
        enterToSend,
        submitOverride,
        yieldedChords,
      });
      if (action === 'submit' || action === 'newline' || action === 'block') {
        return action;
      }
      return 'none';
    },
    [enterToSend, shortcutsEnabled, submitOverride, yieldedChords],
  );

  const stopProps: ComposerStopProps = isSubmitting
    ? { onStop: () => void stopGenerating(), stopLabel: localize('com_nav_stop_generating') }
    : {};

  return (
    <div className={cn('shrink-0 px-3 pt-2', clearsFooter ? 'pb-10' : 'pb-4')}>
      <Composer
        value={value}
        onChange={setValue}
        onSubmit={submit}
        canSubmit={ready && !isSubmitting && value.trim() !== ''}
        submitLabel={localize('com_nav_send_message')}
        {...stopProps}
        ariaLabel={localize('com_ui_message_input')}
        placeholder={localize('com_endpoint_message_new', { 0: title })}
        submitOnEnter={enterToSend}
        resolveKeyVerdict={resolveKeyVerdict}
      />
    </div>
  );
}

/**
 * A conversation of the reader's own, open beside the main one: main chat's message list and a
 * composer, driven through a core `Chat`. The main conversation stays where it is; the control
 * in the header moves this one into its place.
 */
export default function SideChatPanel({
  chat,
  onClose,
  onHandedTextTaken,
}: {
  chat: SideChat;
  onClose: () => void;
  /** The words handed over with the conversation were sent, or put in the field. */
  onHandedTextTaken: () => void;
}): ReactNode {
  const localize = useLocalize();
  const host = useSideChatHost();
  const isSheet = host.useSheetLayout();
  const clearsFooter = host.useClearsFooter();
  const openConversation = host.useOpenConversation();
  const { handOffComposerText } = useChatSurface();
  const conversationId = chat.conversation.conversationId ?? '';
  const [draft, setDraft] = useAtom(sideChatDraftFamily(conversationId));
  /**
   * A turn stopped before the server kept it is gone from the list. Its words go back in the
   * field, as main chat keeps them as a draft, unless the reader has written something since.
   */
  const takeBack = useCallback(
    (turn: SubmittedTurn) => {
      const { submission } = turn;
      if (submission.isRegenerate === true) {
        return;
      }
      setDraft((current) => (current === '' ? (submission.userMessage.text ?? '') : current));
    },
    [setDraft],
  );
  const followed = host.useChat(chat.conversation, { onWithdrawn: takeBack });
  const panelRef = useRef<HTMLDivElement>(null);

  /** The pane's conversation is what a turn is built from, so the pane is told which it holds. */
  const pane = useChatHost().usePaneConversation(SIDE_CHAT_PANE);
  const { setConversation } = pane;
  const opened = chat.conversation;
  useEffect(() => {
    setConversation(opened);
    return () => setConversation(null);
  }, [opened, setConversation]);
  const held = pane.conversation?.conversationId === conversationId;

  useFocusTrap(panelRef, isSheet);
  useEffect(() => {
    if (!isSheet) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (event.key !== 'Escape' || event.defaultPrevented || panel == null) {
        return;
      }
      if (event.target instanceof Node && panel.contains(event.target)) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSheet, onClose]);

  const title = pane.conversation?.title ?? opened.title ?? localize('com_ui_new_chat');
  const openAsMain = useCallback(() => {
    /** Words not sent yet go with the conversation, to the composer it opens under. */
    if (draft.trim() !== '') {
      handOffComposerText(conversationId, draft);
    }
    openConversation(pane.conversation ?? opened);
    onClose();
  }, [
    conversationId,
    draft,
    handOffComposerText,
    onClose,
    openConversation,
    opened,
    pane.conversation,
  ]);

  let body: ReactNode;
  if (followed.isLoadError) {
    body = (
      <div
        role="alert"
        className="text-text-secondary flex flex-1 flex-col items-center justify-center gap-3 px-4 pt-14 text-center text-sm"
      >
        {localize('com_ui_side_chat_load_error')}
        <Button type="button" size="sm" variant="outline" onClick={followed.retry}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  } else if (followed.isLoading && followed.messages.length === 0) {
    body = (
      <div
        role="status"
        aria-live="polite"
        className="text-text-secondary flex flex-1 items-center justify-center pt-14 text-sm"
      >
        {localize('com_ui_loading')}
      </div>
    );
  } else {
    body = (
      <DrivenThread id={conversationId} index={SIDE_CHAT_PANE} followed={followed}>
        {(contract) => (
          <SideChatComposer
            contract={contract}
            value={draft}
            onChange={setDraft}
            conversationId={conversationId}
            title={title}
            ready={held && !followed.isLoading}
            handedText={chat.text}
            onHandedTextTaken={onHandedTextTaken}
            clearsFooter={clearsFooter}
          />
        )}
      </DrivenThread>
    );
  }

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role={isSheet ? 'dialog' : 'region'}
      aria-modal={isSheet || undefined}
      aria-label={localize('com_ui_side_chat_panel')}
      data-side-chat={conversationId}
      className="bg-surface-primary-alt text-text-primary relative flex h-full w-full flex-col overflow-hidden"
    >
      {/* The subagent panel's header, which is main chat's: a bar that floats over the thread
          and fades into it, so the conversation scrolls under it. */}
      <header className="from-surface-primary-alt via-surface-primary-alt/70 text-text-primary absolute top-0 z-10 flex h-[3.25rem] w-full items-center gap-2 bg-gradient-to-b to-transparent p-2 font-semibold">
        <h2 className="min-w-0 flex-1 truncate ps-2 text-sm font-semibold" title={title}>
          {title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={openAsMain}
          aria-label={localize('com_ui_side_chat_open_main')}
          title={localize('com_ui_side_chat_open_main')}
          className="h-8 w-8 shrink-0"
        >
          <ArrowUpRight className="size-[1.0625rem]" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={localize('com_ui_close')}
          className="h-8 w-8 shrink-0"
        >
          <X className="size-[1.0625rem]" aria-hidden="true" />
        </Button>
      </header>
      {/* The gutter a list beside a chat needs; see `FollowedChildThread`. */}
      <div className="flex min-h-0 flex-1 flex-col sm:px-2">{body}</div>
    </aside>
  );
}
