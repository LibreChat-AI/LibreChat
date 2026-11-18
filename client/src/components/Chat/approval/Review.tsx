import { memo, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@librechat/client';
import { ApprovalResumeHostProvider } from '@librechat/chat/react';
import {
  PendingToolApprovalButton as PackageButton,
  PendingToolApprovalPanel as PackagePanel,
} from '@librechat/chat/components';
import type { ApprovalRequestRenderProps } from '@librechat/chat/components';
import type { ReactNode, RefObject } from 'react';
import { useChatApprovalHost } from '~/components/Chat/Messages/Content/ApprovalContext';
import ToolApproval from '~/components/Chat/Messages/Content/ToolApproval';
import { useLocalize } from '~/hooks';

/**
 * The app's review panel: package chrome, with this app's approval card in each row. The
 * panel's Continue button resumes through the host, which only this app can build from
 * the active conversation.
 */
export const PendingToolApprovalPanel = memo(function PendingToolApprovalPanel({
  conversationId,
  triggerRef,
}: {
  conversationId: string;
  /** The composer toggle that reopens the panel; collapsing returns focus to it. */
  triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const localize = useLocalize();
  const host = useChatApprovalHost();
  const renderRequest = useCallback(
    (props: ApprovalRequestRenderProps) => <ToolApproval {...props} surface="composer" />,
    [],
  );
  const renderCollapse = useCallback(
    ({ onClick, label }: { onClick: () => void; label: string }) => (
      <Button
        type="button"
        variant="quiet"
        size="icon"
        aria-label={label}
        className="size-auto rounded-md p-1"
        onClick={onClick}
      >
        <ChevronDown className="size-4" aria-hidden="true" />
      </Button>
    ),
    [],
  );
  return (
    <ApprovalResumeHostProvider host={host}>
      <PackagePanel
        conversationId={conversationId}
        triggerRef={triggerRef}
        localize={localize}
        renderRequest={renderRequest}
        renderCollapse={renderCollapse}
      />
    </ApprovalResumeHostProvider>
  );
});

/** The composer toggle that opens the review panel. */
export const PendingToolApprovalButton = memo(function PendingToolApprovalButton({
  conversationId,
  triggerRef,
}: {
  conversationId: string;
  triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const localize = useLocalize();
  const renderToggle = useCallback(
    ({
      ref,
      expanded,
      onClick,
      children,
    }: {
      ref?: RefObject<HTMLButtonElement>;
      expanded: boolean;
      onClick: () => void;
      children: ReactNode;
    }) => (
      <Button
        ref={ref}
        type="button"
        variant="quiet"
        size="sm"
        aria-expanded={expanded}
        aria-controls="pending-tool-approval-panel"
        onClick={onClick}
        className="h-8 gap-1.5 rounded-full px-2"
        data-testid="pending-tool-approval-button"
      >
        {children}
      </Button>
    ),
    [],
  );
  return (
    <PackageButton
      conversationId={conversationId}
      triggerRef={triggerRef}
      localize={localize}
      renderToggle={renderToggle}
    />
  );
});
