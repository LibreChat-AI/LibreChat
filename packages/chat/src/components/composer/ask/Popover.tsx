import { useCallback, useEffect, useRef } from 'react';
import { Button, TooltipAnchor, useLocalize } from '@librechat/client';
import { ChevronDown, CornerDownLeft, TriangleAlert } from 'lucide-react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type { Agents } from 'librechat-data-provider';
import type { findLiveAskUserQuestion } from '../../../core/ask';
import { useComposerOverlay } from '../../../react/overlay';
import { isCancelKey } from '../../../core/shortcuts';
import AskOptions from '../../parts/AskOptions';

/** A live `ask_user_question` pause, as the composer finds it in the thread. */
export type LiveAsk = NonNullable<ReturnType<typeof findLiveAskUserQuestion>>;

/** What the composer popover reads from the host's answer mode for a live question. */
export interface AskAnswerView {
  liveAsk: LiveAsk | null;
  /** The popover shows: a live question that has not been moved to the chat. */
  popoverVisible: boolean;
  options: Agents.AskUserQuestionOption[];
  /** The keyboard highlight, by option index. */
  selected: number | null;
  /** Checked option indexes of a multi-select question. */
  checked: number[];
  multiSelect: boolean;
  /** An answer is in flight. */
  locked: boolean;
  /** The last answer failed; the question stays answerable. */
  errored: boolean;
  canSubmit: boolean;
  toggleChecked: (index: number) => void;
  /** Submits the checked options, folding in any free-form text. */
  submit: (freeText?: string) => boolean;
  /** Submits one option of a single-select question. */
  submitOption: (index: number) => boolean;
  skip: () => boolean;
  /** Moves the question to the chat card and hands the composer back. */
  collapse: () => void;
  /** Arrow, digit and Enter keys from inside the popover. */
  handlePopoverKeyDown: (e: KeyboardEvent) => boolean;
}

export interface AskPopoverProps {
  conversationId: string;
  ask: AskAnswerView;
  /** Reads the draft, the free-form answer box that multi-select Submit folds in. Called only
   *  while a question shows, so a hidden popover does not re-render on every keystroke. */
  useComposerText: () => string;
  textAreaRef?: RefObject<HTMLTextAreaElement>;
  /** Renders a batch of questions; the host owns that card. */
  renderQuestions: (props: {
    liveAsk: LiveAsk;
    questions: Agents.AskUserQuestionBatchItem[];
    onEscape: () => void;
    headerAction: ReactNode;
  }) => ReactNode;
}

/** Moves the question to the chat card and hands the composer back. */
function MoveToChatButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const localize = useLocalize();
  return (
    <TooltipAnchor
      description={localize('com_ui_ask_move_to_chat')}
      side="top"
      render={
        <Button
          variant="row-action"
          size="icon-xs"
          aria-label={localize('com_ui_ask_move_to_chat')}
          onClick={onClick}
        >
          <ChevronDown
            className="size-4 [view-transition-name:ask-question-chevron]"
            aria-hidden="true"
          />
        </Button>
      }
    />
  );
}

/** One question: the prompt, its options, Skip, and Submit for multi-select. Digits 1..N work
 *  from inside the popover as from the draft; the option list follows the keyboard highlight. */
function QuestionPanel({
  ask,
  useComposerText,
  textAreaRef,
  onEscape,
}: {
  ask: AskAnswerView;
  useComposerText: () => string;
  textAreaRef?: RefObject<HTMLTextAreaElement>;
  onEscape: () => void;
}): React.JSX.Element | null {
  const localize = useLocalize();
  const composerText = useComposerText();
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

  /** Keyboard selection only paints a highlight, so the list scrolls itself to keep the row in
   *  view. Manual scrollTop math rather than scrollIntoView: it cannot disturb the page. */
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
    <div className="absolute bottom-full z-10 mb-2 w-full">
      <div
        className="popover border-border-light bg-surface-secondary rounded-theme-popover flex max-h-[60vh] flex-col border p-2 shadow-lg [view-transition-name:ask-question]"
        onKeyDown={(e) => {
          if (isCancelKey(e.nativeEvent) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEscape();
            return;
          }
          handlePopoverKeyDown(e);
        }}
      >
        <div className="text-text-secondary flex shrink-0 items-start justify-between gap-2 p-1 ps-2">
          <div className="max-h-[24vh] min-w-0 overflow-y-auto pt-1">
            <p className="text-text-primary text-sm font-medium wrap-anywhere">
              {liveAsk.question.question}
            </p>
            {liveAsk.question.description != null && liveAsk.question.description.length > 0 && (
              <p className="text-text-secondary mt-1 text-sm wrap-anywhere">
                {liveAsk.question.description}
              </p>
            )}
          </div>
          <MoveToChatButton onClick={collapse} />
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
        {/* The chat card that would show a failed answer is hidden while the popover is up. */}
        {errored && (
          <div
            role="alert"
            className="text-text-warning flex shrink-0 items-center gap-1.5 px-2 pt-1 text-xs"
          >
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            {localize('com_ui_ask_answer_error')}
          </div>
        )}
        <div className="flex shrink-0 items-center justify-between gap-2 p-2">
          <Button variant="hint" onClick={() => textAreaRef?.current?.focus()}>
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
                <CornerDownLeft className="ms-1.5 h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The composer popover for a live `ask_user_question` pause. Single-select rows submit on click,
 * multi-select rows toggle and an explicit Submit confirms with any free-form text from the
 * draft. Escape, or the chevron, moves the question to the chat card and returns focus to the
 * draft. Registers as an open composer panel while it shows, so the thread's scroll-to-bottom
 * control stands down instead of landing on its footer.
 */
export default function AskPopover({
  conversationId,
  ask,
  useComposerText,
  textAreaRef,
  renderQuestions,
}: AskPopoverProps): ReactNode {
  const { collapse, popoverVisible, liveAsk } = ask;
  useComposerOverlay(conversationId, popoverVisible);

  /** Focus returns to the draft once the popover is gone: a batch keeps the draft disabled
   *  until then. */
  const refocusComposer = useRef(false);
  const escapeToChat = useCallback(() => {
    refocusComposer.current = true;
    collapse();
  }, [collapse]);
  useEffect(() => {
    if (popoverVisible || !refocusComposer.current) {
      return;
    }
    refocusComposer.current = false;
    textAreaRef?.current?.focus();
  }, [popoverVisible, textAreaRef]);

  if (!popoverVisible || !liveAsk) {
    return null;
  }

  if (liveAsk.questions != null && liveAsk.questions.length > 0) {
    return (
      <div className="absolute bottom-full z-10 mb-2 w-full">
        {/* The prompt and answers scroll within their own caps; this outer cap keeps the card on
            screen when both are at their limit on a short viewport. */}
        <div className="popover border-border-light bg-surface-secondary rounded-theme-popover flex max-h-[70vh] flex-col overflow-y-auto border shadow-lg [view-transition-name:ask-question]">
          {renderQuestions({
            liveAsk,
            questions: liveAsk.questions,
            onEscape: escapeToChat,
            headerAction: <MoveToChatButton onClick={collapse} />,
          })}
        </div>
      </div>
    );
  }

  return (
    <QuestionPanel
      ask={ask}
      useComposerText={useComposerText}
      textAreaRef={textAreaRef}
      onEscape={escapeToChat}
    />
  );
}
