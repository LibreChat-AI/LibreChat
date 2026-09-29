import { memo, useEffect, useMemo } from 'react';
import { atomFamily } from 'jotai/utils';
import { atom, useAtom, useAtomValue } from 'jotai';
import { Button, TooltipAnchor } from '@librechat/client';
import { ChevronDown, ChevronUp, ShieldQuestion, TriangleAlert } from 'lucide-react';
import type { Agents } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import {
  useApprovalContext,
  useResumeSubmit,
} from '~/components/Chat/Messages/Content/ApprovalContext';
import { buildApprovalPreview, buildApprovalPreviews } from '~/components/Chat/approval/preview';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import ToolApproval from '~/components/Chat/Messages/Content/ToolApproval';
import { useComposerOverlay } from '~/components/Chat/Input/overlay';
import { useLocalize } from '~/hooks';

const approvalPanelOpenFamily = atomFamily((_conversationId: string) => atom(false));

function usePendingToolApproval(conversationId: string) {
  const pendingAction = useAtomValue(pendingApprovalActionFamily(conversationId));
  return pendingAction?.payload.type === 'tool_approval'
    ? (pendingAction as Agents.PendingAction & {
        payload: Agents.ToolApprovalInterruptPayload;
      })
    : null;
}

const KIND_LABELS: Record<ReturnType<typeof buildApprovalPreview>['kind'], TranslationKeys> = {
  command: 'com_ui_proposed_command',
  create: 'com_ui_proposed_contents',
  edit: 'com_ui_proposed_replacements',
  generic: 'com_ui_proposed_arguments',
};

function previewTitle(
  preview: ReturnType<typeof buildApprovalPreview>,
  localize: ReturnType<typeof useLocalize>,
): string {
  if (preview.kind === 'command') return localize('com_ui_review_run_command');
  if (preview.kind === 'create') {
    return preview.target
      ? localize('com_ui_review_create_file', { 0: preview.target })
      : localize('com_ui_review_create_file_generic');
  }
  if (preview.kind === 'edit') {
    return preview.target
      ? localize('com_ui_review_edit_file', { 0: preview.target })
      : localize('com_ui_review_edit_file_generic');
  }
  return preview.toolName;
}

export const PendingToolApprovalPanel = memo(function PendingToolApprovalPanel({
  conversationId,
}: {
  conversationId: string;
}) {
  const localize = useLocalize();
  const pendingAction = usePendingToolApproval(conversationId);
  const [open, setOpen] = useAtom(approvalPanelOpenFamily(conversationId));
  const { getDecisions, getStatus, isReady } = useApprovalContext();
  const { submitToolApproval } = useResumeSubmit();
  const actionId = pendingAction?.actionId;

  useEffect(() => {
    if (actionId != null) {
      setOpen(true);
    }
  }, [actionId, setOpen]);

  useComposerOverlay(conversationId, open && pendingAction != null);

  const reviews = useMemo(() => {
    if (pendingAction == null) return [];
    const configById = new Map(
      pendingAction.payload.review_configs.map((config) => [config.tool_call_id, config]),
    );
    const previews = buildApprovalPreviews(pendingAction.payload.action_requests);
    return pendingAction.payload.action_requests.map((request, index) => ({
      request,
      config: configById.get(request.tool_call_id),
      preview: previews[index],
    }));
  }, [pendingAction]);

  if (!open || pendingAction == null) {
    return null;
  }

  const decisions = getDecisions(pendingAction.actionId);
  const status = getStatus(pendingAction.actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';

  return (
    <div
      id="pending-tool-approval-panel"
      className="absolute bottom-28 z-10 w-full"
      role="region"
      aria-labelledby="pending-tool-approval-title"
      aria-live="polite"
    >
      <div className="popover border-token-border-light flex max-h-[70vh] flex-col rounded-2xl border bg-surface-primary-alt shadow-lg">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-light px-3 py-2">
          <p id="pending-tool-approval-title" className="text-sm font-medium text-text-primary">
            {localize(reviews.length === 1 ? 'com_ui_review_action' : 'com_ui_review_actions', {
              0: reviews.length,
            })}
          </p>
          <TooltipAnchor
            description={localize('com_ui_collapse')}
            side="top"
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={localize('com_ui_collapse')}
                className="size-auto rounded-md p-1 text-text-secondary"
                onClick={() => setOpen(false)}
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {reviews.map(({ request, config, preview }, index) => (
            <section
              key={request.tool_call_id}
              aria-labelledby={`approval-${request.tool_call_id}`}
            >
              <div className="mb-2">
                <h3
                  id={`approval-${request.tool_call_id}`}
                  className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]"
                >
                  {reviews.length > 1
                    ? `${index + 1}. ${previewTitle(preview, localize)}`
                    : previewTitle(preview, localize)}
                </h3>
                <p className="text-xs text-text-secondary">{localize(KIND_LABELS[preview.kind])}</p>
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-light bg-surface-tertiary p-3 font-mono text-xs text-text-primary">
                {preview.body || localize('com_ui_no_arguments')}
              </pre>
              {preview.truncated && (
                <p className="mt-1 text-xs text-text-secondary">
                  {localize('com_ui_preview_truncated')}
                </p>
              )}
              {config != null ? (
                <ToolApproval
                  approval={{
                    actionId: pendingAction.actionId,
                    allowed_decisions: config.allowed_decisions,
                    description: preview.description,
                  }}
                  toolCallId={request.tool_call_id}
                  args={request.arguments}
                  showSubmit={false}
                />
              ) : (
                <p className="mt-2 flex items-center text-xs text-text-warning" role="alert">
                  <TriangleAlert className="mr-1.5 size-4" aria-hidden="true" />
                  {localize('com_ui_approval_unavailable')}
                </p>
              )}
            </section>
          ))}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-light px-3 py-2">
          <span className="text-xs text-text-secondary">
            {localize('com_ui_decisions_selected', {
              0: decisions.length,
              1: reviews.length,
            })}
          </span>
          <div className="flex items-center gap-2">
            {(status === 'expired' || status === 'error') && (
              <span className="flex items-center text-xs text-text-warning" role="alert">
                <TriangleAlert className="mr-1.5 size-4" aria-hidden="true" />
                {localize(
                  status === 'expired' ? 'com_ui_approval_expired' : 'com_ui_approval_error',
                )}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="submit"
              disabled={!isReady(pendingAction.actionId) || locked}
              onClick={() => submitToolApproval(pendingAction.actionId)}
            >
              {status === 'submitting'
                ? localize('com_ui_submitting')
                : localize('com_ui_continue')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

export const PendingToolApprovalButton = memo(function PendingToolApprovalButton({
  conversationId,
}: {
  conversationId: string;
}) {
  const localize = useLocalize();
  const pendingAction = usePendingToolApproval(conversationId);
  const [open, setOpen] = useAtom(approvalPanelOpenFamily(conversationId));

  if (pendingAction == null) {
    return null;
  }

  const count = pendingAction.payload.action_requests.length;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls="pending-tool-approval-panel"
      onClick={() => setOpen((current) => !current)}
      className="h-8 gap-1.5 rounded-full px-2 text-text-secondary"
      data-testid="pending-tool-approval-button"
    >
      <ShieldQuestion className="size-4" aria-hidden="true" />
      <span>
        {localize(count === 1 ? 'com_ui_review_action' : 'com_ui_review_actions', { 0: count })}
      </span>
      {open ? (
        <ChevronDown className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronUp className="size-3.5" aria-hidden="true" />
      )}
    </Button>
  );
});
