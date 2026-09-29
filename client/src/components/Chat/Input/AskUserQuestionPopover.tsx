import { memo, useEffect, useRef } from 'react';
import { useWatch } from 'react-hook-form';
import { Button, TooltipAnchor } from '@librechat/client';
import { ChevronDown, CornerDownLeft, TriangleAlert } from 'lucide-react';
import AskUserQuestions from '~/components/Chat/Messages/Content/AskUserQuestions';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import AskOptions from '~/components/Chat/ask/options';
import { useChatFormContext } from '~/Providers';
import { useComposerOverlay } from './overlay';
import { useLocalize } from '~/hooks';

/**
 * Composer popover for a live `ask_user_question` pause. Single-select rows
 * submit on click; a digit `1..N` activates its row like a click whether
 * focus is in the composer or on the popover (arrows/Enter highlight+confirm
 * from the empty composer); multi-select rows toggle checks and an explicit
 * Submit confirms —
 * folding in any free-form text typed in the composer, exactly like Enter
 * would. The footer hint is a button that focuses the composer — the
 * free-form answer box. The chevron moves the question to the chat card and
 * releases the composer (the card's chevron moves it back). Pure rendering
 * off {@link useAskAnswerMode}; disappears the moment an answer submits from
 * any surface, and locks while one is in flight. Registers as an open composer
 * panel for as long as it shows, so the thread's scroll-to-bottom control
 * stands down instead of landing on its footer.
 */
function AskUserQuestionPopoverContent({
  conversationId,
  textAreaRef,
}: {
  conversationId: string;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const ask = useAskAnswerMode(conversationId);
  useComposerOverlay(conversationId, ask.popoverVisible);

  if (!ask.popoverVisible || !ask.liveAsk) {
    return null;
  }

  if (ask.liveAsk.questions != null && ask.liveAsk.questions.length > 0) {
    return <AskUserQuestionsPopoverPanel ask={ask} />;
  }

  return <AskUserQuestionPopoverPanel ask={ask} textAreaRef={textAreaRef} />;
}

function AskUserQuestionsPopoverPanel({ ask }: { ask: ReturnType<typeof useAskAnswerMode> }) {
  const localize = useLocalize();
  const { liveAsk, collapse } = ask;
  const questions = liveAsk?.questions;
  if (liveAsk == null || questions == null || questions.length === 0) {
    return null;
  }

  return (
    <div className="absolute bottom-28 z-10 w-full">
      <div className="popover border-token-border-light flex max-h-[70vh] flex-col rounded-2xl border bg-surface-primary-alt shadow-lg">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 py-2">
          <p className="text-sm font-medium text-text-primary">
            {localize(
              questions.length === 1 ? 'com_ui_asking_questions_one' : 'com_ui_asking_questions',
              { 0: questions.length },
            )}
          </p>
          <TooltipAnchor
            description={localize('com_ui_ask_move_to_chat')}
            side="top"
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={localize('com_ui_ask_move_to_chat')}
                className="size-auto rounded-md p-1 text-text-secondary"
                onClick={collapse}
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <AskUserQuestions actionId={liveAsk.actionId} questions={questions} />
      </div>
    </div>
  );
}

/**
 * Split from the gate above so the per-keystroke `useWatch` subscription only
 * exists while the popover is actually visible — the invisible popover was
 * re-rendering (to null) on every composer keystroke.
 */
function AskUserQuestionPopoverPanel({
  ask,
  textAreaRef,
}: {
  ask: ReturnType<typeof useAskAnswerMode>;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  const localize = useLocalize();
  const { control } = useChatFormContext();
  /** Reactive composer text so multi-select Submit can include (and enable
   *  on) the free-form answer the footer hint invites. */
  const composerText = (useWatch({ control, name: 'text' }) ?? '') as string;
  const {
    liveAsk,
    options,
    selected,
    checked,
    multiSelect,
    locked,
    errored,
    toggleChecked,
    canSubmit,
    submit,
    submitOption,
    skip,
    collapse,
    handlePopoverKeyDown,
  } = ask;

  /** Keyboard selection only paints a highlight (no focus move), so the
   *  scrollable option list has to follow `selected` itself or arrow/digit
   *  navigation can land on a row that is scrolled out of view. Manual
   *  scrollTop math rather than scrollIntoView: it cannot disturb the page. */
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (typeof selected !== 'number') {
      return;
    }
    const list = listRef.current;
    const row = optionRefs.current[selected];
    if (list == null || row == null) {
      return;
    }
    const rowBottom = row.offsetTop + row.offsetHeight;
    if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop;
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight;
    }
  }, [selected]);

  if (!liveAsk) {
    return null;
  }

  const composerHasText = composerText.trim().length > 0;

  return (
    <div className="absolute bottom-28 z-10 w-full space-y-2">
      {/* Digit shortcuts (1..N) work when focus is inside the popover too, not
          only from the composer — keydown bubbles here from the focused row/
          control. Height is viewport-bounded with the option list as the only
          scroll region: the panel is absolutely positioned, so anything that
          overflows it is unreachable by page scroll. */}
      <div
        className="popover border-token-border-light flex max-h-[60vh] flex-col rounded-2xl border bg-surface-primary-alt p-2 shadow-lg [view-transition-name:ask-question]"
        onKeyDown={handlePopoverKeyDown}
      >
        <div className="flex shrink-0 items-start justify-between gap-2 p-2">
          <div className="max-h-[24vh] min-w-0 overflow-y-auto">
            <p className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
              {liveAsk.question.question}
            </p>
            {liveAsk.question.description != null && liveAsk.question.description.length > 0 && (
              <p className="mt-1 text-sm text-text-secondary [overflow-wrap:anywhere]">
                {liveAsk.question.description}
              </p>
            )}
          </div>
          {/* Single exit: moves the question to the chat card and hands the
              composer back for normal messages. */}
          <TooltipAnchor
            description={localize('com_ui_ask_move_to_chat')}
            side="top"
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={localize('com_ui_ask_move_to_chat')}
                className="size-auto rounded-md p-1 text-text-secondary"
                onClick={collapse}
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <AskOptions
          options={options}
          multiSelect={multiSelect}
          checked={checked}
          selected={selected}
          locked={locked}
          onActivate={(index) => (multiSelect ? toggleChecked(index) : submitOption(index))}
          optionRefs={optionRefs}
          listRef={listRef}
          className="relative min-h-0 flex-1 overflow-y-auto"
        />
        {/** A failed submission keeps the question answerable (controls stay
         *   enabled), but the chat card that would show the error is hidden
         *   while the popover is up — so surface it here for retry guidance. */}
        {errored && (
          <div className="flex shrink-0 items-center gap-1.5 px-2 pt-1 text-xs text-text-warning">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            {localize('com_ui_ask_answer_error')}
          </div>
        )}
        <div className="flex shrink-0 items-center justify-between gap-2 p-2">
          {/* Shared primitive with the fill suppressed, the same way Summary's
              quiet text buttons compose it: this reads as a hint, not a
              control with a surface, but the focus ring and disabled handling
              should still come from the recipe. */}
          <Button
            variant="ghost"
            className="h-auto cursor-text rounded-md p-0 text-xs font-normal text-text-secondary hover:bg-transparent hover:text-text-primary"
            onClick={() => textAreaRef?.current?.focus()}
          >
            {options.length === 0
              ? localize('com_ui_ask_type_below_only')
              : localize('com_ui_ask_type_below')}
          </Button>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={locked} onClick={() => skip()}>
              {localize('com_ui_skip')}
            </Button>
            {multiSelect && options.length > 0 && (
              <Button
                size="sm"
                variant="submit"
                disabled={locked || (!canSubmit && !composerHasText)}
                onClick={() => submit(composerText)}
              >
                {localize('com_ui_submit')}
                <CornerDownLeft className="ml-1.5 h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const AskUserQuestionPopover = memo(function AskUserQuestionPopover({
  conversationId,
  textAreaRef,
}: {
  conversationId?: string | null;
  textAreaRef?: React.RefObject<HTMLTextAreaElement>;
}) {
  if (conversationId == null || conversationId === 'new') {
    return null;
  }
  return (
    <AskUserQuestionPopoverContent conversationId={conversationId} textAreaRef={textAreaRef} />
  );
});

export default AskUserQuestionPopover;
