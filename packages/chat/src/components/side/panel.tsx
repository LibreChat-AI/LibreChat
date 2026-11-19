import { useRef, useEffect, useCallback } from 'react';
import { useAtom, useStore } from 'jotai';
import { ArrowUpRight, X } from 'lucide-react';
import { cn, Button, Composer, useLocalize, useFocusTrap } from '@librechat/client';
import type { ComposerStopProps, ComposerKeyVerdict } from '@librechat/client';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { FollowedGeneration, FollowedRunEnd } from '../../react/follow';
import type { ChatContract } from '../../react/chat/contract';
import type { DetachedRun, SubmittedTurn } from '../../core';
import type { SideChat } from '../../react/side/state';
import {
  runEndByIndex,
  settleDetachedRun,
  parkDetachedRunEnd,
  detachedRunByConvoId,
  drainAfterAbortByIndex,
  stopRequestedByConvoId,
  clearSupersededRunMarkers,
} from '../../react/steer/queue';
import {
  activeGenerationCreatedAtByConvoId,
  activeGenerationProtocolVersionByConvoId,
} from '../../react/steer/atoms';
import { SIDE_CHAT_PANE, sideChatDraftFamily } from '../../react/side/state';
import { clearMatchingDrainAfterAbort } from '../../core/steer/drain';
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
  title: string;
  /** Whether the conversation is in and the pane holds it, so a turn can be built for it. */
  ready: boolean;
  /** Words written for this conversation before it opened; see {@link SideChat.text}. */
  handoff?: SideChat;
  /** Managed intent identity, or the legacy standalone conversation-level one-shot key. */
  handoffKey: SideChat | string;
  onHandedTextTaken: () => void;
  onDraftTaken: (text: string) => void;
  clearsFooter: boolean;
  /**
   * Whether the field takes focus once the conversation is in. A side chat is opened to be
   * written in, from a control somewhere else on the page. Not as a sheet, whose focus trap
   * decides where focus starts.
   */
  focusWhenReady: boolean;
};

/**
 * The side chat's composer: main chat's field at panel scale. Sending is the contract's `ask`,
 * and with nothing typed while a generation runs the send control is main chat's Stop.
 */
function SideChatComposer({
  contract,
  value,
  onChange: setValue,
  title,
  ready,
  handoff,
  handoffKey,
  onHandedTextTaken,
  onDraftTaken,
  clearsFooter,
  focusWhenReady,
}: SideChatComposerProps): ReactNode {
  const localize = useLocalize();
  const {
    enterToSend,
    composerBindings: { shortcutsEnabled, submitOverride, yieldedChords },
  } = useChatSurface();
  const { ask, isSubmitting, stopGenerating } = contract;

  const field = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!ready || !focusWhenReady || focused.current) {
      return;
    }
    focused.current = true;
    field.current?.focus({ preventScroll: true });
  }, [focusWhenReady, ready]);

  /**
   * Words the reader wrote before this conversation opened are its next turn. They are sent
   * once, when the conversation can take them; if it cannot, they are left in the field.
   */
  const handed = useRef<SideChat | string>();
  const handedText = handoff?.text;
  useEffect(() => {
    if (!ready || !handoff || !handedText || handed.current === handoffKey) {
      return;
    }
    handed.current = handoffKey;
    if (value !== '' && value !== handedText) {
      onHandedTextTaken();
      return;
    }
    if (ask({ text: handedText }) === false) {
      if (value === '') setValue(handedText);
    } else onDraftTaken(handedText);
    onHandedTextTaken();
  }, [
    ask,
    handoff,
    handoffKey,
    handedText,
    onDraftTaken,
    onHandedTextTaken,
    ready,
    setValue,
    value,
  ]);

  const change = useCallback(
    (text: string) => {
      if (handoff && handed.current !== handoffKey) {
        handed.current = handoffKey;
        onHandedTextTaken();
      }
      setValue(text);
    },
    [handoff, handoffKey, onHandedTextTaken, setValue],
  );

  const submit = useCallback(() => {
    const text = value.trim();
    if (text === '' || ask({ text }) === false) {
      return;
    }
    onDraftTaken(value);
    if (handoff) {
      handed.current = handoffKey;
      onHandedTextTaken();
    }
  }, [ask, handoff, handoffKey, onDraftTaken, onHandedTextTaken, value]);

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
        ref={field}
        value={value}
        onChange={change}
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
  onDraftTaken,
}: {
  chat: SideChat;
  onClose: () => void;
  /** The words handed over with the conversation were sent, or put in the field. */
  onHandedTextTaken: (expected: SideChat) => void;
  /** Retire captured words only after the existing send or main-composer transfer accepts them. */
  onDraftTaken?: (expected: SideChat, text: string) => void;
}): ReactNode {
  const localize = useLocalize();
  const host = useSideChatHost();
  const isSheet = host.useSheetLayout();
  const clearsFooter = host.useClearsFooter();
  const openConversation = host.useOpenConversation();
  const { handOffComposerText } = useChatSurface();
  const conversationId = chat.conversation.conversationId ?? '';
  const [draft, setDraft] = useAtom(sideChatDraftFamily(conversationId));
  const takeText = useCallback(() => onHandedTextTaken(chat), [chat, onHandedTextTaken]);
  const takeDraft = useCallback(
    (text: string) => {
      if (onDraftTaken) onDraftTaken(chat, text);
      else setDraft((current) => (current === text ? '' : current));
    },
    [chat, onDraftTaken, setDraft],
  );
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
  /**
   * The run under this conversation, published where main chat's stream session publishes its
   * own: the generation in flight, which a stop or a steer addresses, and each run's end, which
   * lets the next queued message go. So the composer's controls for a run in flight work here.
   */
  const store = useStore();
  const noteGeneration = useCallback(
    (generation: FollowedGeneration | null) => {
      if (generation != null) {
        /** A different run owns the conversation's end now: an earlier one left behind, or stopped, is superseded. */
        clearSupersededRunMarkers(
          store,
          conversationId,
          (createdAt) => createdAt === generation.createdAt,
        );
      }
      store.set(activeGenerationCreatedAtByConvoId(conversationId), generation?.createdAt ?? null);
      store.set(
        activeGenerationProtocolVersionByConvoId(conversationId),
        generation?.protocolVersion ?? 1,
      );
    },
    [conversationId, store],
  );
  const noteRunEnd = useCallback(
    ({ reconcileReason, ...end }: FollowedRunEnd) => {
      /**
       * Interrupt and send lets the queue go even on a stopped run. A run whose stop could not
       * be saved has not been proven stopped, so that leave is taken back before the end is
       * published; the queued words stay for the reader to send.
       */
      if (reconcileReason === 'abort_persistence_failed' && end.generationCreatedAt != null) {
        const { generationCreatedAt } = end;
        store.set(drainAfterAbortByIndex(SIDE_CHAT_PANE), (armed) =>
          clearMatchingDrainAfterAbort(armed, conversationId, generationCreatedAt),
        );
      }
      /** Its end reaches the queue here, so a marker left for the same run is not read again. */
      settleDetachedRun(store, { conversationId, generationCreatedAt: end.generationCreatedAt });
      store.set(runEndByIndex(SIDE_CHAT_PANE), { ...end, conversationId, endedAt: Date.now() });
    },
    [conversationId, store],
  );
  /**
   * A reply still being written when the panel goes away has no one left to hear it end, and
   * what the reader queued behind it would wait for good. So the run is remembered, as main
   * chat remembers one it navigates away from, and when the conversation is next opened with
   * nothing running its end is read from the stored rows: a reply that completed lets the
   * queue go, and one the reader stopped leaves it for them to send.
   */
  const noteStop = useCallback(
    (generation: FollowedGeneration) =>
      store.set(stopRequestedByConvoId(conversationId), {
        generationCreatedAt: generation.createdAt,
      }),
    [conversationId, store],
  );
  const noteDetached = useCallback(
    (run: DetachedRun) => store.set(detachedRunByConvoId(conversationId), run),
    [conversationId, store],
  );
  const noteIdle = useCallback(
    (messages: TMessage[]) => {
      const detached = store.get(detachedRunByConvoId(conversationId));
      if (detached != null) {
        parkDetachedRunEnd(store, conversationId, detached, messages);
      }
    },
    [conversationId, store],
  );
  const followed = host.useChat(chat.conversation, {
    onWithdrawn: takeBack,
    onGeneration: noteGeneration,
    onRunEnd: noteRunEnd,
    onStopped: noteStop,
    onDetached: noteDetached,
    onIdle: noteIdle,
  });
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
      takeDraft(draft);
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
    takeDraft,
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
        {(contract, thread) =>
          host.Surface == null ? (
            <>
              {thread}
              <SideChatComposer
                contract={contract}
                value={draft}
                onChange={setDraft}
                title={title}
                ready={held && !followed.isLoading}
                handoff={chat.text ? chat : undefined}
                handoffKey={onDraftTaken ? chat : conversationId}
                onHandedTextTaken={takeText}
                onDraftTaken={takeDraft}
                clearsFooter={clearsFooter}
                focusWhenReady={!isSheet}
              />
            </>
          ) : (
            <host.Surface
              contract={contract}
              ready={held && !followed.isLoading}
              handedText={chat.text}
              handoffKey={onDraftTaken ? chat : conversationId}
              onHandedTextTaken={takeText}
              onDraftTaken={takeDraft}
              draft={draft}
              onDraftChange={setDraft}
              clearsFooter={clearsFooter}
              focusWhenReady={!isSheet}
            >
              {thread}
            </host.Surface>
          )
        }
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
      /* Its own pane to the keyboard: a shortcut pressed here acts on this conversation. */
      data-chat-pane={SIDE_CHAT_PANE}
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
      {/* The gutter a list beside a chat needs; see `FollowedChildThread`. A size container, as
          main chat's column is: a composer caps its width against the panel, not the window. */}
      <div className="@container flex min-h-0 flex-1 flex-col sm:px-2">{body}</div>
    </aside>
  );
}
