import { useContext } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import parseJsonField, { parseJsonFieldOccurrences } from './Parts/parseJsonField';
import { collectLiveAskToolCallIds } from '~/utils/approval';
import { useGetMessagesByConvoId } from '~/data-provider';
import { ChatContext } from '~/Providers/ChatContext';
import { useToolPreparation } from './preparation';
import { useLocalize } from '~/hooks';

/**
 * Interim card for an `ask_user_question` call whose pause hasn't gone
 * interactive yet: the window between the model starting the call and the
 * interrupt's synthetic part arriving (which hands the UI to the popover /
 * interactive card). Without it a long question, many options, or several
 * parallel questions leave a dead gap after the last streamed token.
 *
 * The first question text streams in live from either the legacy top-level
 * field or the first item in the batched `questions` array.
 *
 * Mounted only for a live, unanswered call ({@link AskUserQuestionCall}
 * gates on `isSubmitting`), so the live-ask subscription below never runs
 * for the settled cards in history.
 */
export default function AskUserQuestionProgress({
  args,
  toolCallId,
}: {
  args: string | Record<string, unknown> | undefined;
  toolCallId?: string;
}) {
  const localize = useLocalize();
  const preparationText = useToolPreparation();
  const conversationId = useContext(ChatContext)?.conversation?.conversationId;
  const enabled = conversationId != null && conversationId !== 'new';
  const { data: livePauses } = useGetMessagesByConvoId(enabled ? conversationId : '', {
    enabled,
    select: collectLiveAskToolCallIds,
  });
  const legacyQuestion = parseJsonField(args, 'question');
  const batchQuestion = (() => {
    if (typeof args === 'string') {
      return parseJsonFieldOccurrences(args, 'question')[0] ?? '';
    }
    const questions = args?.questions;
    if (!Array.isArray(questions)) {
      return '';
    }
    const first = questions[0];
    if (first == null || typeof first !== 'object') {
      return '';
    }
    const firstQuestion = (first as { question?: unknown }).question;
    return typeof firstQuestion === 'string' ? firstQuestion : '';
  })();
  const question = legacyQuestion || batchQuestion;

  /**
   * THIS call's pause went interactive: the popover (or the interactive card)
   * now owns the question's UI. Checked against every live pause, not just the
   * newest, so a sibling pause arriving later can never resurrect this card
   * next to its own interactive one. An unattributed live ask (no
   * `tool_call_id` on older payloads) can't be matched to a call, so treat it
   * as owning every placeholder rather than duplicating the question on screen.
   */
  const interactive =
    livePauses != null &&
    (livePauses.hasUnattributed || (toolCallId != null && livePauses.ids.includes(toolCallId)));
  if (interactive) {
    return null;
  }

  return (
    <div className="border-border-light bg-surface-secondary my-2 flex w-full flex-col gap-1.5 rounded-lg border p-3">
      <div
        className="text-text-secondary flex items-center gap-2 text-xs font-medium"
        role="status"
      >
        <MessageCircleQuestion className="h-4 w-4 animate-pulse" aria-hidden="true" />
        <span className="shimmer">{preparationText ?? localize('com_ui_asking')}</span>
      </div>
      {question.length > 0 ? (
        <p className="text-text-primary text-sm font-medium [overflow-wrap:anywhere]">{question}</p>
      ) : (
        <div className="bg-surface-tertiary h-4 w-2/5 animate-pulse rounded" aria-hidden="true" />
      )}
    </div>
  );
}
