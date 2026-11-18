import { memo, useEffect, useMemo, useRef } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { Button, TooltipAnchor } from '@librechat/client';
import { ChevronDown, ChevronUp, ShieldQuestion, TriangleAlert } from 'lucide-react';
import type { MemoExoticComponent, ReactElement, ReactNode, RefObject } from 'react';
import type { Agents } from 'librechat-data-provider';
import { approvalPanelOpenFamily, pendingApprovalActionFamily } from '../../react/approval';
import { buildApprovalPreview, buildApprovalPreviews } from '../../core/parts/approval';
import { useApprovalContext, useResumeSubmit } from './context';
import { useComposerOverlay } from '../../react/overlay';
import { isCancelKey } from '../../core/shortcuts';

/** Copy for the review panel. A method, so a host localize typed with its own
 *  key union still fits. The keys passed here come from this panel. */
export type ApprovalReviewCopy = {
  translate(key: string, values?: Record<string, string | number>): string;
}['translate'];

/** One paused call, drawn by the host's tool-approval card. */
export type ApprovalRequestRenderProps = {
  approval: NonNullable<Agents.ToolCall['approval']>;
  toolCallId: string;
  args: Agents.ToolApprovalRequest['arguments'];
};

function usePendingToolApproval(conversationId: string) {
  const pendingAction = useAtomValue(pendingApprovalActionFamily(conversationId));
  return pendingAction?.payload.type === 'tool_approval'
    ? (pendingAction as Agents.PendingAction & {
        payload: Agents.ToolApprovalInterruptPayload;
      })
    : null;
}

const KIND_LABELS: Record<ReturnType<typeof buildApprovalPreview>['kind'], string> = {
  command: 'com_ui_proposed_command',
  create: 'com_ui_proposed_contents',
  edit: 'com_ui_proposed_replacements',
  generic: 'com_ui_proposed_arguments',
};

function previewTitle(
  preview: ReturnType<typeof buildApprovalPreview>,
  localize: ApprovalReviewCopy,
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

export type PendingToolApprovalPanelProps = {
  conversationId: string;
  /** The composer toggle that reopens the panel; collapsing returns focus to it. */
  triggerRef?: RefObject<HTMLButtonElement>;
  localize: ApprovalReviewCopy;
  /** The host's approval card for one paused call. */
  renderRequest: (props: ApprovalRequestRenderProps) => ReactNode;
  /** Host-drawn collapse control. Omitted, the package draws a quiet icon button. */
  renderCollapse?: (props: { onClick: () => void; label: string }) => ReactElement;
};

export const PendingToolApprovalPanel: MemoExoticComponent<
  (props: PendingToolApprovalPanelProps) => ReactNode
> = memo(function PendingToolApprovalPanel({
  conversationId,
  triggerRef,
  localize,
  renderRequest,
  renderCollapse,
}: PendingToolApprovalPanelProps) {
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

  const regionRef = useRef<HTMLDivElement>(null);
  const collapseRef = useRef<() => void>(() => undefined);

  /** Collapsing unmounts the focused control, so focus goes back to the
   *  toggle rather than falling to the page. Decisions and drafts are kept. */
  collapseRef.current = () => {
    setOpen(false);
    triggerRef?.current?.focus();
  };

  useEffect(() => {
    const region = regionRef.current;
    if (!open || pendingAction == null || region == null) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const isComposing = event.isComposing || event.key === 'Process' || event.keyCode === 229;
      if (!isCancelKey(event) || isComposing) {
        return;
      }
      event.preventDefault();
      collapseRef.current();
    };
    region.addEventListener('keydown', onKeyDown);
    return () => region.removeEventListener('keydown', onKeyDown);
  }, [open, pendingAction]);

  if (!open || pendingAction == null) {
    return null;
  }

  const collapse = () => collapseRef.current();

  const decisions = getDecisions(pendingAction.actionId);
  const status = getStatus(pendingAction.actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';

  return (
    <div
      id="pending-tool-approval-panel"
      /* The absolute review layer spans the composer width, but only its card
       * is painted and interactive. Let the thread receive clicks through the
       * transparent remainder of the layer. */
      ref={regionRef}
      className="pointer-events-none absolute bottom-28 z-10 w-full"
      role="region"
      aria-labelledby="pending-tool-approval-title"
      aria-live="polite"
    >
      <div className="popover border-border-light bg-surface-primary-alt rounded-theme-popover pointer-events-auto flex max-h-[70vh] flex-col border shadow-lg">
        <div className="border-border-light flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <p id="pending-tool-approval-title" className="text-text-primary text-sm font-medium">
            {localize(reviews.length === 1 ? 'com_ui_review_action' : 'com_ui_review_actions', {
              0: reviews.length,
            })}
          </p>
          <TooltipAnchor
            description={localize('com_ui_collapse')}
            side="top"
            render={
              renderCollapse != null ? (
                renderCollapse({
                  onClick: collapse,
                  label: localize('com_ui_collapse'),
                })
              ) : (
                <Button
                  type="button"
                  variant="quiet"
                  size="icon"
                  aria-label={localize('com_ui_collapse')}
                  onClick={collapse}
                >
                  <ChevronDown className="size-4" aria-hidden="true" />
                </Button>
              )
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
                  className="text-text-primary text-sm font-medium [overflow-wrap:anywhere]"
                >
                  {reviews.length > 1
                    ? `${index + 1}. ${previewTitle(preview, localize)}`
                    : previewTitle(preview, localize)}
                </h3>
                <p className="text-text-secondary text-xs">{localize(KIND_LABELS[preview.kind])}</p>
              </div>
              <pre className="border-border-light bg-surface-tertiary text-text-primary max-h-52 overflow-auto rounded-lg border p-3 font-mono text-xs break-words whitespace-pre-wrap">
                {preview.body || localize('com_ui_no_arguments')}
              </pre>
              {preview.truncated && (
                <p className="text-text-secondary mt-1 text-xs">
                  {localize('com_ui_preview_truncated')}
                </p>
              )}
              {config != null ? (
                renderRequest({
                  approval: {
                    actionId: pendingAction.actionId,
                    allowed_decisions: config.allowed_decisions,
                    remember_scope: config.remember_scope,
                    remember_unavailable: config.remember_unavailable,
                    description: preview.description,
                    allow_always: config.allow_always === true,
                  },
                  toolCallId: request.tool_call_id,
                  args: request.arguments,
                })
              ) : (
                <p className="text-text-warning mt-2 flex items-center text-xs" role="alert">
                  <TriangleAlert className="me-1.5 size-4" aria-hidden="true" />
                  {localize('com_ui_approval_unavailable')}
                </p>
              )}
            </section>
          ))}
        </div>
        <div className="border-border-light flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2">
          <span className="text-text-secondary text-xs">
            {localize('com_ui_decisions_selected', {
              0: decisions.length,
              1: reviews.length,
            })}
          </span>
          <div className="flex items-center gap-2">
            {(status === 'expired' || status === 'error') && (
              <span className="text-text-warning flex items-center text-xs" role="alert">
                <TriangleAlert className="me-1.5 size-4" aria-hidden="true" />
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

export type PendingToolApprovalButtonProps = {
  conversationId: string;
  triggerRef?: RefObject<HTMLButtonElement>;
  localize: ApprovalReviewCopy;
  /** Host-drawn composer toggle. Omitted, the package draws a quiet button. */
  renderToggle?: (props: {
    ref?: RefObject<HTMLButtonElement>;
    expanded: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => ReactNode;
};

export const PendingToolApprovalButton: MemoExoticComponent<
  (props: PendingToolApprovalButtonProps) => ReactNode
> = memo(function PendingToolApprovalButton({
  conversationId,
  triggerRef,
  localize,
  renderToggle,
}: PendingToolApprovalButtonProps) {
  const pendingAction = usePendingToolApproval(conversationId);
  const [open, setOpen] = useAtom(approvalPanelOpenFamily(conversationId));

  if (pendingAction == null) {
    return null;
  }

  const count = pendingAction.payload.action_requests.length;
  const onClick = () => setOpen((current) => !current);
  const content = (
    <>
      <ShieldQuestion className="size-4" aria-hidden="true" />
      <span>
        {localize(count === 1 ? 'com_ui_review_action' : 'com_ui_review_actions', { 0: count })}
      </span>
      {open ? (
        <ChevronDown className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronUp className="size-3.5" aria-hidden="true" />
      )}
    </>
  );
  if (renderToggle != null) {
    return renderToggle({ ref: triggerRef, expanded: open, onClick, children: content });
  }
  return (
    <Button
      ref={triggerRef}
      type="button"
      variant="quiet"
      size="sm"
      aria-expanded={open}
      aria-controls="pending-tool-approval-panel"
      onClick={onClick}
      data-testid="pending-tool-approval-button"
    >
      {content}
    </Button>
  );
});
