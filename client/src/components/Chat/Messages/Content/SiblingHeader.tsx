import { useMemo } from 'react';
import { GitBranchPlus } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import { EModelEndpoint, parseEphemeralAgentId, stripAgentIdSuffix } from 'librechat-data-provider';
import type { TMessage, Agent } from 'librechat-data-provider';
import MessageTimestamp from '~/components/Chat/Messages/ui/MessageTimestamp';
import { useBranchMessageMutation } from '~/data-provider/Messages';
import MessageIcon from '~/components/Share/MessageIcon';
import { useAgentsMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type SiblingHeaderProps = {
  /** The agentId from the content part (could be real agent ID or endpoint__model format) */
  agentId?: string;
  /** The messageId of the parent message */
  messageId?: string;
  /** ISO timestamp of the parent message */
  createdAt?: string | null;
  /** The conversationId */
  conversationId?: string | null;
  /** Whether a submission is in progress */
  isSubmitting?: boolean;
};

/**
 * Header component for sibling content parts in parallel agent responses.
 * Displays the agent/model icon and name for each parallel response.
 */
export default function SiblingHeader({
  agentId,
  messageId,
  createdAt,
  conversationId,
  isSubmitting,
}: SiblingHeaderProps) {
  const agentsMap = useAgentsMapContext();
  const localize = useLocalize();
  const { showToast } = useToastContext();

  const branchMessage = useBranchMessageMutation(conversationId ?? null, {
    onSuccess: () => {
      showToast({
        message: localize('com_ui_branch_created'),
        status: 'success',
      });
    },
    onError: () => {
      showToast({
        message: localize('com_ui_branch_error'),
        status: 'error',
      });
    },
  });

  const handleBranch = () => {
    if (!messageId || !agentId || isSubmitting || branchMessage.isLoading) {
      return;
    }
    branchMessage.mutate({ messageId, agentId });
  };

  const { displayName, displayEndpoint, displayModel, agent } = useMemo(() => {
    // First, try to look up as a real agent
    if (agentId) {
      // Strip ____N suffix if present (used to distinguish parallel agents with same ID)
      const baseAgentId = stripAgentIdSuffix(agentId);

      const foundAgent = agentsMap?.[baseAgentId] as Agent | undefined;
      if (foundAgent) {
        return {
          displayName: foundAgent.name,
          displayEndpoint: EModelEndpoint.agents,
          displayModel: foundAgent.model,
          agent: foundAgent,
        };
      }

      // Try to parse as ephemeral agent ID (endpoint__model___sender format)
      const parsed = parseEphemeralAgentId(agentId);
      if (parsed) {
        return {
          displayName: parsed.sender || parsed.model || 'AI',
          displayEndpoint: parsed.endpoint,
          displayModel: parsed.model,
          agent: undefined,
        };
      }

      // agentId exists but couldn't be parsed as ephemeral - use it as-is for display
      return {
        displayName: baseAgentId,
        displayEndpoint: EModelEndpoint.agents,
        displayModel: undefined,
        agent: undefined,
      };
    }

    // Use message model/endpoint as last resort
    return {
      displayName: 'Agent',
      displayEndpoint: EModelEndpoint.agents,
      displayModel: undefined,
      agent: undefined,
    };
  }, [agentId, agentsMap]);

  return (
    <div className="border-border-light mb-2 flex items-center justify-between gap-2 border-b pb-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
          <MessageIcon
            message={
              {
                endpoint: displayEndpoint,
                model: displayModel,
                isCreatedByUser: false,
              } as TMessage
            }
            agent={agent || undefined}
          />
        </div>
        <span className="text-text-primary truncate text-sm font-medium">{displayName}</span>
        <MessageTimestamp value={createdAt} />
      </div>
      <button
        type="button"
        onClick={handleBranch}
        disabled={!messageId || !agentId || isSubmitting || branchMessage.isLoading}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
          'text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors',
          'focus:ring-border-medium focus:ring-2 focus:ring-offset-1 focus:outline-hidden',
          'disabled:cursor-not-allowed disabled:opacity-50',
          (!messageId || !agentId || isSubmitting) && 'invisible',
        )}
        aria-label={localize('com_ui_branch_message')}
        title={localize('com_ui_branch_message')}
      >
        <GitBranchPlus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
