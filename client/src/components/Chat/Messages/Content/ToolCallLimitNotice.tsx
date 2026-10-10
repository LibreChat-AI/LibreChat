import { useContext, useId, useState } from 'react';
import { Button, TooltipAnchor } from '@librechat/client';
import { FastForward, Gauge, MessageSquareText, X } from 'lucide-react';
import type { TMessage } from 'librechat-data-provider';
import { ChatContext } from '~/Providers/ChatContext';
import { useLocalize } from '~/hooks';

/**
 * Shown when a turn ended because the agent exhausted its per-turn step budget
 * (`recursionLimit`) rather than because anything failed. The server marks that
 * row `unfinished` with `Constants.TOOL_CALL_LIMIT_FINISH_REASON`.
 *
 * Deliberately not an `ErrorBox`: nothing broke, the work above is real, and the
 * only thing the user needs is a way forward. Both actions post an ordinary user
 * turn, which is what makes them work everywhere:
 *
 * - the previous turn is already persisted with its tool calls, so the model sees
 *   everything it did before deciding what to do next, and
 * - a new turn gets a fresh step budget without needing a resumable checkpoint,
 *   which only exists on HITL-capable deployments.
 *
 * The instruction text is localized because it becomes a visible message in the
 * user's own conversation, in their own language.
 */
export default function ToolCallLimitNotice({ message }: { message: TMessage }) {
  const localize = useLocalize();
  const titleId = useId();
  const [dismissed, setDismissed] = useState(false);
  const [noticeMessageId, setNoticeMessageId] = useState(message.messageId);
  /**
   * MultiMessage reuses this row when switching siblings, so dismiss state
   * would otherwise hide the notice on a different message. Reset during
   * render when the displayed id changes; no effect needed.
   */
  if (noticeMessageId !== message.messageId) {
    setNoticeMessageId(message.messageId);
    setDismissed(false);
  }
  /**
   * Nullable on purpose: this renders inside shared links, search results and
   * exports, which mount message content with no live chat behind it. There the
   * explanation still helps, so the card degrades to text instead of throwing.
   */
  const chat = useContext(ChatContext);

  if (dismissed && noticeMessageId === message.messageId) {
    return null;
  }

  /**
   * `ask` appends to the tail of the active branch, so offering it on anything
   * but the tail would send the follow-up somewhere the user is not looking.
   * Same gate `useGenerationsByLatest` applies to the Continue hover button.
   */
  const canAct =
    chat?.ask != null && chat.isSubmitting !== true && chat.latestMessageId === message.messageId;
  /**
   * Empty overrides are authoritative: a recovery prompt is not the user's next
   * compose, so `ask` must not attach or drain files, skills, or quotes already
   * staged in the composer. The agent and MCP server selection remains in scope.
   */
  const recover = (text: string) =>
    chat?.ask(
      { text },
      {
        overrideFiles: [],
        overrideManualSkills: [],
        overrideQuotes: [],
        overrideReasoning: null,
      },
    );

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="border-border-light bg-surface-secondary relative my-2 flex w-full flex-col rounded-xl border p-3"
    >
      <TooltipAnchor
        description={localize('com_ui_tool_call_limit_dismiss')}
        side="left"
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={localize('com_ui_tool_call_limit_dismiss')}
            className="text-text-secondary absolute top-1.5 right-1.5 focus-visible:ring-offset-0 focus-visible:ring-inset"
            onClick={() => setDismissed(true)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        }
      />
      <p
        id={titleId}
        className="text-text-primary flex min-w-0 items-center gap-2 pr-8 text-sm font-medium"
      >
        <Gauge className="text-text-secondary h-4 w-4 shrink-0" aria-hidden="true" />
        {localize('com_ui_tool_call_limit_title')}
      </p>
      <p className="text-text-secondary mt-1 mb-3 text-sm">
        {localize('com_ui_tool_call_limit_body')}
      </p>
      {canAct && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="submit"
            onClick={() => recover(localize('com_ui_tool_call_limit_continue_prompt'))}
          >
            <FastForward className="icon-md shrink-0" aria-hidden="true" />
            {localize('com_ui_tool_call_limit_continue')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => recover(localize('com_ui_tool_call_limit_answer_prompt'))}
          >
            <MessageSquareText className="icon-md shrink-0" aria-hidden="true" />
            {localize('com_ui_tool_call_limit_answer')}
          </Button>
        </div>
      )}
    </div>
  );
}
