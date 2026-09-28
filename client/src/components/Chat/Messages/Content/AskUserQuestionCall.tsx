import { useState, useEffect, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import type { Agents, PartMetadata } from 'librechat-data-provider';
import {
  getSubmittedAskAnswer,
  parseAskUserQuestionArgs,
  parseAskUserQuestionsArgs,
} from '~/utils/approval';
import AskUserQuestionProgress from './AskUserQuestionProgress';
import { useLocalize, useExpandCollapse } from '~/hooks';
import ProgressText from './ProgressText';
import EmptyText from './Parts/EmptyText';
import { TOOL_ROW_CLASSES } from './rows';
import Container from './Container';
import store from '~/store';

/**
 * Static rendering of a COMPLETED (or abandoned) `ask_user_question` tool call —
 * the durable record of the Q&A after the pause resolves. The generic tool card
 * is wrong here: it labels a no-output call "cancelled" and shows raw JSON args.
 * The interactive card ({@link AskUserQuestion}) renders only while the pause is
 * live; this component owns the part everywhere else (history, reload, exports).
 *
 * Settled, it is history — so it reads as one collapsed tool-call line (status
 * label plus the question itself) and opens on demand, under the same
 * `autoExpandTools` preference every other tool card follows. Answers are
 * frequently long, multi-paragraph text; left expanded they buried the reply
 * that followed them.
 */
export default function AskUserQuestionCall({
  args,
  output,
  toolCallId,
  isSubmitting = false,
  runStepStatus,
  failed = false,
  showCursor = false,
  onExpand,
}: {
  args: string | Record<string, unknown> | undefined;
  output: string;
  toolCallId?: string;
  isSubmitting?: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
  failed?: boolean;
  showCursor?: boolean;
  onExpand?: () => void;
}) {
  const localize = useLocalize();
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const [expanded, setExpanded] = useState(autoExpand);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(expanded);

  useEffect(() => {
    if (autoExpand) {
      setExpanded(true);
    }
  }, [autoExpand]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next) {
        onExpand?.();
      }
      return next;
    });
  }, [onExpand]);

  const question = parseAskUserQuestionArgs(args);
  const batch = parseAskUserQuestionsArgs(args);
  /**
   * The part's own output arrives from the server only at finalize, and the
   * streaming handler's message copy can overwrite the optimistic store stamp
   * mid-stream — fall back to the locally-recorded submitted answer so the
   * Q&A record never blinks out while the resumed segment streams.
   */
  const effectiveOutput = output.length > 0 ? output : (getSubmittedAskAnswer(toolCallId) ?? '');
  const batchAnswers = (() => {
    if (batch == null || effectiveOutput.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(effectiveOutput) as { answers?: unknown };
      return parsed.answers != null && typeof parsed.answers === 'object'
        ? (parsed.answers as Record<string, string>)
        : null;
    } catch {
      return null;
    }
  })();
  const terminalFailure = failed || runStepStatus === 'failed';
  const answered =
    !terminalFailure &&
    (batch != null
      ? batch.questions.every((item) => typeof batchAnswers?.[item.id] === 'string')
      : effectiveOutput.length > 0);

  /**
   * While the turn is live and unanswered, the INTERACTIVE card (rendered from
   * the pendingAction's synthetic part) owns the question UI — rendering the
   * durable record too would duplicate it with a misleading "no answer" line.
   * Until that pause actually starts (args still streaming, interrupt not yet
   * delivered) the progress card fills the gap. Once the user answers, the
   * submit handler stamps `output` onto this part, so the record takes over
   * immediately; an abandoned pause only shows its "no answer" state after
   * the turn is no longer submitting.
   */
  if (!answered && !terminalFailure && runStepStatus == null && isSubmitting) {
    return <AskUserQuestionProgress args={args} toolCallId={toolCallId} />;
  }

  /**
   * The run resumes the moment the pause resolves (an answer submits, or a
   * schema-rejected call auto-retries), but its first token takes a beat to
   * arrive — hold the streaming cursor under the settled card so the turn
   * never looks stalled between the answer and the resumed text.
   */
  const resumingCursor =
    isSubmitting && showCursor ? (
      <Container>
        <EmptyText />
      </Container>
    ) : null;

  const count = batch?.questions.length ?? 1;
  /**
   * Past tense unconditionally: a live, unanswered pause returns above, so
   * every state that reaches this header is settled — answered, abandoned
   * (the run stopped before an answer), or rejected. An abandoned pause was
   * still ASKED; it explains itself with "no answer" inside the panel, and a
   * present-tense summary would strand it as permanently in-flight now that
   * the panel starts closed. Matches `ToolCallGroup`, which settles its own
   * question header on `!isSubmitting`.
   */
  const statusLabel = (() => {
    if (terminalFailure) {
      return localize('com_ui_question_failed');
    }
    return count > 1
      ? localize('com_ui_asked_n_questions', { 0: String(count) })
      : localize('com_ui_asked');
  })();
  /** A batch is summarized by its count; a lone question is summarized by
   *  itself, so the collapsed line still says what was asked. */
  const summary = count > 1 ? undefined : (batch?.questions[0]?.question ?? question?.question);

  return (
    <>
      <div className={TOOL_ROW_CLASSES} data-testid="ask-user-question-call">
        <ProgressText
          phase={terminalFailure ? 'failed' : 'completed'}
          onClick={toggleExpanded}
          inProgressText={statusLabel}
          finishedText={statusLabel}
          subtitle={summary}
          icon={
            terminalFailure ? (
              <TriangleAlert className="size-4 shrink-0 text-text-warning" aria-hidden="true" />
            ) : (
              <MessageCircleQuestion
                className="size-4 shrink-0 text-text-secondary"
                aria-hidden="true"
              />
            )
          }
          isExpanded={expanded}
        />
      </div>
      {/* A rejected call is the one state the reader did not ask for and
          cannot see coming. The explanation lives in the panel, which starts
          closed and is `inert` while it is — so the announcement has to sit
          outside the disclosure to reach the accessibility tree at all. */}
      {terminalFailure && (
        <span className="sr-only" role="status">
          {`${statusLabel}. ${localize('com_ui_question_failed_description')}`}
        </span>
      )}
      <div style={expandStyle}>
        <div className="overflow-hidden" ref={expandRef}>
          <div className="my-2 flex w-full flex-col gap-4 rounded-lg border border-border-light bg-surface-secondary p-4">
            {batch != null ? (
              batch.questions.map((item, index) => (
                <div
                  key={item.id}
                  className={index > 0 ? 'border-t border-border-light pt-4' : undefined}
                >
                  {item.header != null && (
                    <p className="mb-1 text-xs font-medium text-text-secondary">{item.header}</p>
                  )}
                  <QuestionBody
                    question={item.question}
                    description={item.description}
                    answer={batchAnswers?.[item.id]}
                    options={item.options}
                    multiSelect={item.multiSelect}
                    failed={terminalFailure}
                  />
                </div>
              ))
            ) : (
              <QuestionBody
                question={question?.question ?? ''}
                description={question?.description}
                answer={answered ? effectiveOutput : undefined}
                options={question?.options}
                multiSelect={question?.multiSelect}
                failed={terminalFailure}
              />
            )}
            {terminalFailure && (
              <p className="text-sm leading-relaxed text-text-secondary">
                {localize('com_ui_question_failed_description')}
              </p>
            )}
          </div>
        </div>
      </div>
      {resumingCursor}
    </>
  );
}

/**
 * One question and its answer. Every text slot here is authored — by the model
 * or by the user — so line breaks are content, not whitespace: `pre-wrap`
 * keeps a numbered or paragraphed answer legible instead of collapsing it into
 * one wall of text. The answer sits under its own label behind a rule rather
 * than running on from it, so the eye can find where the reply starts.
 */
function QuestionBody({
  question,
  description,
  answer,
  options,
  multiSelect,
  failed,
}: {
  question: string;
  description?: string;
  answer?: string;
  options?: Agents.AskUserQuestionRequest['options'];
  multiSelect?: boolean;
  failed: boolean;
}) {
  const localize = useLocalize();
  return (
    <div className="min-w-0">
      {question.length > 0 && (
        <p className="whitespace-pre-wrap text-sm font-medium leading-relaxed text-text-primary [overflow-wrap:anywhere]">
          {question}
        </p>
      )}
      {description != null && description.length > 0 && (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
          {description}
        </p>
      )}
      {typeof answer === 'string' && (
        <div className="mt-2.5 border-l-2 border-border-medium pl-3">
          <p className="text-xs font-medium text-text-secondary">
            {localize('com_ui_you_answered')}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-text-primary [overflow-wrap:anywhere]">
            {formatAnswerLabel({ question, options, multiSelect }, answer)}
          </p>
        </div>
      )}
      {typeof answer !== 'string' && !failed && (
        <p className="mt-2.5 text-sm italic text-text-secondary">
          {localize('com_ui_question_unanswered')}
        </p>
      )}
    </div>
  );
}

/**
 * Prefer the picked option's label over its wire value when they differ.
 * Multi-select answers are option values joined by ", " — map the segments
 * back to labels only when EVERY segment matches an option: values may
 * legally contain ", " themselves, and a partial mapping could mis-split
 * such a value into fragments that relabel as options the user never
 * picked. When any segment misses, show the raw answer untouched.
 */
function formatAnswerLabel(question: Agents.AskUserQuestionRequest, answer: string): string {
  const exactLabel = question.options?.find((option) => option.value === answer)?.label;
  if (exactLabel != null || question.multiSelect !== true || question.options == null) {
    return exactLabel ?? answer;
  }
  const labels = answer
    .split(', ')
    .map((segment) => question.options?.find((option) => option.value === segment)?.label);
  return labels.every((label) => label != null) ? labels.join(', ') : answer;
}
