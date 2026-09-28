import { useEffect, useMemo } from 'react';
import { Button, TextareaAutosize } from '@librechat/client';
import { Check, X, Pencil, MessageSquare, TriangleAlert } from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { boundApprovalLabel } from '~/components/Chat/approval/preview';
import { useApprovalContext, useResumeSubmit } from './ApprovalContext';
import { useLocalize } from '~/hooks';
import { cn, logger } from '~/utils';

/**
 * The resume route rejects an `edit` whose `editedArguments` isn't a plain object
 * (`findIncompleteDecisions`), so mirror that here — `JSON.parse` alone also accepts
 * `null`/arrays/primitives, which would enable Submit for a value that can only 400.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type DecisionType = Agents.ToolApprovalDecisionType;

const DECISION_ICON: Record<DecisionType, React.ComponentType<{ className?: string }>> = {
  approve: Check,
  reject: X,
  edit: Pencil,
  respond: MessageSquare,
};

const DECISION_LABEL: Record<DecisionType, TranslationKeys> = {
  approve: 'com_ui_approve',
  reject: 'com_ui_reject',
  edit: 'com_ui_edit',
  respond: 'com_ui_respond',
};

/**
 * Chrome shared by the three decision fields. `TextareaAutosize` renders a bare
 * `textarea`, which preflight leaves at `color: inherit`, so a field that names
 * no colour token draws the typed text in whatever colour it inherits — on the
 * dark theme that was near-black over the `surface-primary` fill, about 1.1:1.
 * The value and the placeholder each name their token, and the boundary is
 * `border-xheavy` so the field reads as a control at WCAG 1.4.11's 3:1
 * (`border-light` measures ~1.4:1 against this fill).
 */
const fieldClasses =
  'w-full resize-none rounded-md border border-border-xheavy bg-surface-primary p-2 text-text-primary placeholder:text-text-secondary';

/** Pretty-print tool args as JSON for the `edit` textarea seed. */
function seedArgs(args: string | Record<string, unknown> | undefined): string {
  if (args == null) {
    return '{}';
  }
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    logger.error('ToolApproval - failed to stringify args', e);
    return '{}';
  }
}

/**
 * Renders approve / reject / edit / respond controls for a paused tool call,
 * scoped to the decisions the server allows. Records its decision in the
 * batch {@link useApprovalContext}; the lead card additionally renders the
 * single submit button covering every paused call in the action.
 */
export default function ToolApproval({
  approval,
  toolCallId,
  args,
  showSubmit = true,
}: {
  approval: NonNullable<Agents.ToolCall['approval']>;
  toolCallId: string;
  args: string | Record<string, unknown> | undefined;
  /** The composer owns one batch submit; timeline cards keep the historical lead button. */
  showSubmit?: boolean;
}) {
  const localize = useLocalize();
  const { actionId, allowed_decisions: allowedDecisions, description } = approval;
  const {
    registerToolCall,
    unregisterToolCall,
    setDecision,
    getDecision,
    getDecisionDraft,
    setDecisionDraft,
    isReady,
    getStatus,
    getLeadToolCallId,
    getRegisteredCount,
  } = useApprovalContext();
  const { submitToolApproval } = useResumeSubmit();

  const retainedDecision = getDecision(actionId, toolCallId);
  const initialDecision =
    retainedDecision != null && allowedDecisions.includes(retainedDecision.decision)
      ? retainedDecision
      : undefined;
  const initialEditText =
    initialDecision?.decision === 'edit'
      ? (JSON.stringify(initialDecision.editedArguments, null, 2) ?? '{}')
      : seedArgs(args);
  const decisionDraft = getDecisionDraft(actionId, toolCallId) ?? {
    active: initialDecision?.decision ?? null,
    editText: initialEditText,
    responseText:
      initialDecision?.decision === 'respond' ? (initialDecision.responseText ?? '') : '',
    reason: initialDecision?.decision === 'reject' ? (initialDecision.reason ?? '') : '',
  };
  const { active, editText, responseText, reason } = decisionDraft;
  const updateDecisionDraft = (updates: Partial<typeof decisionDraft>) =>
    setDecisionDraft(actionId, toolCallId, { ...decisionDraft, ...updates });

  useEffect(() => {
    registerToolCall(actionId, toolCallId);
    // Drop the registration when this card unmounts (e.g. the tool resolved and the
    // card was replaced) so a stale entry can't keep the batch's `isReady` false.
    return () => unregisterToolCall(actionId, toolCallId);
  }, [registerToolCall, unregisterToolCall, actionId, toolCallId]);

  const status = getStatus(actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';
  const safeDescription =
    description == null ? undefined : boundApprovalLabel(description, 1024).label;

  /** Recompute and store this card's decision whenever inputs change. A null
   *  resolution (e.g. invalid edit JSON) clears it so submit stays disabled. */
  useEffect(() => {
    if (locked) {
      return;
    }
    if (active == null) {
      setDecision(actionId, toolCallId, null);
      return;
    }
    if (active === 'approve') {
      setDecision(actionId, toolCallId, { tool_call_id: toolCallId, decision: 'approve' });
      return;
    }
    if (active === 'reject') {
      setDecision(actionId, toolCallId, {
        tool_call_id: toolCallId,
        decision: 'reject',
        reason: reason.trim() || undefined,
      });
      return;
    }
    if (active === 'respond') {
      const trimmed = responseText.trim();
      setDecision(
        actionId,
        toolCallId,
        trimmed.length > 0
          ? { tool_call_id: toolCallId, decision: 'respond', responseText: trimmed }
          : null,
      );
      return;
    }
    if (active === 'edit') {
      try {
        const parsed = JSON.parse(editText) as unknown;
        setDecision(
          actionId,
          toolCallId,
          isPlainObject(parsed)
            ? { tool_call_id: toolCallId, decision: 'edit', editedArguments: parsed }
            : null,
        );
      } catch {
        setDecision(actionId, toolCallId, null);
      }
    }
  }, [active, editText, responseText, reason, locked, setDecision, actionId, toolCallId]);

  const editIsValid = useMemo(() => {
    if (active !== 'edit') {
      return true;
    }
    try {
      return isPlainObject(JSON.parse(editText));
    } catch {
      return false;
    }
  }, [active, editText]);

  const isLead = getLeadToolCallId(actionId) === toolCallId;
  const count = getRegisteredCount(actionId);
  const ready = isReady(actionId);

  const submitLabel = useMemo(() => {
    if (status === 'submitting') {
      return localize('com_ui_submitting');
    }
    if (count > 1) {
      return localize('com_ui_submit_decisions', { 0: count });
    }
    return localize('com_ui_submit');
  }, [status, count, localize]);

  if (status === 'submitted') {
    return null;
  }

  return (
    <div
      className="my-2 flex w-full flex-col gap-2 rounded-lg border border-border-light bg-surface-secondary p-3"
      data-testid="tool-approval"
      data-tool-call-id={toolCallId}
    >
      {safeDescription != null && safeDescription.length > 0 && (
        <p className="text-sm text-text-secondary">{safeDescription}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {allowedDecisions.map((decision) => {
          const Icon = DECISION_ICON[decision];
          return (
            <Button
              key={decision}
              size="sm"
              variant={active === decision ? 'default' : 'outline'}
              disabled={locked}
              aria-pressed={active === decision}
              onClick={() => updateDecisionDraft({ active: active === decision ? null : decision })}
              className="inline-flex items-center gap-1.5"
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {localize(DECISION_LABEL[decision])}
            </Button>
          );
        })}
      </div>

      {active === 'edit' && (
        <div className="flex flex-col gap-1">
          <TextareaAutosize
            value={editText}
            disabled={locked}
            onChange={(e) => updateDecisionDraft({ editText: e.target.value })}
            minRows={3}
            maxRows={16}
            className={cn(fieldClasses, 'font-mono text-xs', !editIsValid && 'border-red-500')}
            aria-label={localize('com_ui_edit')}
          />
          {!editIsValid && (
            <span className="text-xs text-text-warning">{localize('com_ui_invalid_json')}</span>
          )}
        </div>
      )}

      {active === 'respond' && (
        <TextareaAutosize
          value={responseText}
          disabled={locked}
          onChange={(e) => updateDecisionDraft({ responseText: e.target.value })}
          minRows={2}
          maxRows={12}
          placeholder={localize('com_ui_tool_response_placeholder')}
          className={cn(fieldClasses, 'text-sm')}
          aria-label={localize('com_ui_respond')}
        />
      )}

      {active === 'reject' && (
        <TextareaAutosize
          value={reason}
          disabled={locked}
          onChange={(e) => updateDecisionDraft({ reason: e.target.value })}
          minRows={1}
          maxRows={6}
          placeholder={localize('com_ui_reject_reason_placeholder')}
          className={cn(fieldClasses, 'text-sm')}
          aria-label={localize('com_ui_reject')}
        />
      )}

      {showSubmit && isLead && (
        <div className="mt-1 flex items-center gap-3">
          <Button
            size="sm"
            variant="submit"
            disabled={!ready || locked}
            onClick={() => submitToolApproval(actionId)}
          >
            {submitLabel}
          </Button>
          {status === 'expired' && (
            <span className="flex items-center text-xs text-text-warning">
              <TriangleAlert className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {localize('com_ui_approval_expired')}
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center text-xs text-text-warning">
              <TriangleAlert className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {localize('com_ui_approval_error')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
