import { useRef, useMemo, useEffect, useLayoutEffect } from 'react';
import { useForm } from 'react-hook-form';
import { ChatContext, ComposerRestoreProvider } from '@librechat/chat/react';
import type { SideChatSurfaceProps } from '@librechat/chat/react';
import type { AddedChatContract } from '~/hooks/Chat/contract';
import type { ChatFormValues } from '~/common';
import { useComposerPreferences } from '~/Providers/ComposerPreferencesContext';
import DragDropWrapper from '~/components/Chat/Input/Files/DragDropWrapper';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { AddedChatContext, ChatFormProvider } from '~/Providers';
import { getDraft, setDraft, settlePendingDraft } from '~/utils';
import { TargetContext } from '~/Providers/TargetContext';
import ChatForm from '~/components/Chat/Input/ChatForm';
import useTarget from '~/hooks/Chat/target';

/** A conversation beside the chat is compared with no other model. */
const alone: AddedChatContract = {
  conversation: null,
  setConversation: () => undefined,
  generateConversation: () => {
    throw new Error('A side chat holds one conversation');
  },
};

/**
 * Main chat's composer for a conversation open beside it: the same form, reading that
 * conversation's chat contract, under the providers `ChatView` puts around its own. Each is
 * this conversation's alone: its form state, its target, its place for words handed back, and
 * its drop target, so a file dropped on the panel is this conversation's and not main chat's.
 */
export default function SideChatSurface({
  contract,
  ready,
  handedText,
  handoffKey,
  onHandedTextTaken,
  onDraftTaken,
  draft,
  onDraftChange,
  clearsFooter,
  focusWhenReady,
  children,
}: SideChatSurfaceProps) {
  /** Empty is what the form goes back to once a message is sent; the draft is put in below. */
  const methods = useForm<ChatFormValues>({ defaultValues: { text: '' } });
  const { enterToSend, autoSendText, speechSettingsInitialized } = useComposerPreferences();
  const { ask, conversation, setConversation } = contract;
  const target = useTarget(conversation, setConversation);
  const readiness = useMemo(
    () => ({
      ready: target.ready,
      pending: target.pending,
      failed: target.failed,
      retry: target.retry,
    }),
    [target.ready, target.pending, target.failed, target.retry],
  );
  const sendable = ready && target.ready;
  const conversationId = conversation?.conversationId ?? '';

  /**
   * Words handed over with the conversation are already in the field, as the panel's draft.
   * They are sent once, when the conversation can take them, and the draft that held them is
   * let go of. Words the reader has changed by then are theirs to send, and words the
   * conversation refuses stay in the field.
   */
  const handed = useRef<object | string>();
  useEffect(() => {
    if (!sendable || handedText == null || handedText === '' || handed.current === handoffKey) {
      return;
    }
    handed.current = handoffKey;
    const written = methods.getValues('text') ?? '';
    if (written !== '' && written !== handedText) {
      onHandedTextTaken();
      return;
    }
    if (ask({ text: handedText }) === false) {
      if (written === '') {
        methods.setValue('text', handedText, { shouldValidate: true });
      }
    } else {
      onDraftTaken(handedText);
    }
    onHandedTextTaken();
  }, [ask, handedText, handoffKey, methods, onDraftTaken, onHandedTextTaken, sendable]);

  /**
   * The panel keeps the words not sent yet; this form is where they are written. It takes what
   * the panel holds when it is not what the field already holds: the words a composer drawn
   * again starts with, before it is painted, and the words of a turn the server never kept,
   * put back by the panel. And it reports every change of its own.
   */
  const reported = useRef('');
  const { saveDrafts } = useChatSettings();
  useLayoutEffect(() => {
    if (draft === reported.current) {
      return;
    }
    reported.current = draft;
    const written = methods.getValues('text') ?? '';
    if (written === draft) {
      return;
    }
    /**
     * With drafts saved, the form restores what was saved for the conversation, which is
     * nothing for words it did not write itself: the ones handed over with the conversation,
     * or put back from a turn the server never kept. So those are saved where its own are,
     * before it restores; and words the panel has let go of are not left saved to come back.
     * Words already saved for the conversation are the reader's own, and are left alone.
     */
    if (saveDrafts && conversationId !== '') {
      const saved = getDraft(conversationId) ?? '';
      if (draft !== '' && saved === '') {
        setDraft({ id: conversationId, value: draft });
      } else if (draft === '' && saved !== '' && saved === written) {
        setDraft({ id: conversationId, value: '' });
      }
    }
    methods.setValue('text', draft, { shouldValidate: true });
  }, [conversationId, draft, methods, saveDrafts]);
  useEffect(() => {
    const watching = methods.watch((values) => {
      const text = values.text ?? '';
      if (text === reported.current) {
        return;
      }
      reported.current = text;
      /** Words the reader changes before they were sent for them are no longer sent for them. */
      if (handedText != null && handedText !== '' && handed.current !== handoffKey) {
        handed.current = handoffKey;
        onHandedTextTaken();
      }
      onDraftChange(text);
    });
    return () => watching.unsubscribe();
  }, [handedText, handoffKey, methods, onDraftChange, onHandedTextTaken]);

  /**
   * What is written here while a reply runs is saved under this pane's own key until the run
   * ends. A side chat can close before then, and whatever opens in the pane next is another
   * conversation. So a composer that saw a run moves what it left there to its conversation on
   * the way out. Deferred until the form's own cleanup has written its last keystrokes.
   */
  const { index, isSubmitting } = contract;
  const ran = useRef(false);
  useEffect(() => {
    if (isSubmitting) {
      ran.current = true;
    }
  }, [isSubmitting]);
  useEffect(() => {
    if (conversationId === '') {
      return;
    }
    return () => {
      if (ran.current) {
        setTimeout(() => settlePendingDraft(index, conversationId), 0);
      }
    };
  }, [conversationId, index]);

  /**
   * The app's `newConversation` for this pane changes the conversation in place and never
   * leaves it, so the composer may offer the choices that do that.
   */
  const chat = useMemo(() => ({ ...contract, retargets: true }), [contract]);

  const form = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!ready || !focusWhenReady || focused.current) {
      return;
    }
    const field = form.current?.querySelector('textarea');
    if (field == null) {
      return;
    }
    focused.current = true;
    field.focus({ preventScroll: true });
  }, [focusWhenReady, ready, conversation?.endpoint]);

  /**
   * Drawn again only for what it is made of. The words in the field change with every key and
   * are this component's to carry between the panel and the form, not something the providers,
   * the drop target or the list under them are drawn from.
   */
  return useMemo(
    () => (
      <ChatContext.Provider value={chat}>
        <TargetContext.Provider value={readiness}>
          <ChatFormProvider {...methods}>
            <ComposerRestoreProvider>
              <AddedChatContext.Provider value={alone}>
                <DragDropWrapper className="min-h-0 flex-1 flex-col">
                  {children}
                  <div ref={form} className="shrink-0">
                    <ChatForm
                      index={index}
                      routePending={!ready}
                      isLandingPage={false}
                      enterToSend={enterToSend}
                      autoSendText={autoSendText}
                      speechSettingsInitialized={speechSettingsInitialized}
                      footerBelow={clearsFooter}
                      centerFormOnLanding={false}
                    />
                  </div>
                </DragDropWrapper>
              </AddedChatContext.Provider>
            </ComposerRestoreProvider>
          </ChatFormProvider>
        </TargetContext.Provider>
      </ChatContext.Provider>
    ),
    [
      chat,
      index,
      ready,
      methods,
      children,
      readiness,
      enterToSend,
      autoSendText,
      clearsFooter,
      speechSettingsInitialized,
    ],
  );
}
