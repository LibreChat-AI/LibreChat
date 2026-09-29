import React, { useRef } from 'react';
import { Link } from 'lucide-react';
import { Pin, PinOff } from 'lucide';
import { useQueryClient } from '@tanstack/react-query';
import {
  OGDialog,
  OGDialogContent,
  Button,
  MorphIcon,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import {
  QueryKeys,
  Constants,
  EModelEndpoint,
  PermissionBits,
  LocalStorageKeys,
  AgentListResponse,
} from 'librechat-data-provider';
import type t from 'librechat-data-provider';
import { renderAgentAvatar, clearMessagesCache, specDisplayFieldReset } from '~/utils';
import { useLocalize, useDefaultConvo, useFavorites } from '~/hooks';
import Description from '~/components/ui/Description';
import { useChatContext } from '~/Providers';

interface SupportContact {
  name?: string;
  email?: string;
}

interface AgentWithSupport extends t.Agent {
  support_contact?: SupportContact;
}
interface AgentDetailProps {
  agent: AgentWithSupport; // The agent data to display
  isOpen: boolean; // Whether the detail dialog is open
  onClose: () => void; // Callback when dialog is closed
}

/**
 * Dialog for displaying agent details
 */
const AgentDetail: React.FC<AgentDetailProps> = ({ agent, isOpen, onClose }) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const dialogRef = useRef<HTMLDivElement>(null);
  const getDefaultConversation = useDefaultConvo();
  const { conversation, newConversation } = useChatContext();
  const { isFavoriteAgent, toggleFavoriteAgent } = useFavorites();
  const isFavorite = isFavoriteAgent(agent?.id);

  const handleFavoriteClick = () => {
    if (agent) {
      toggleFavoriteAgent(agent.id);
    }
  };

  /**
   * Navigate to chat with the selected agent
   */
  const handleStartChat = () => {
    if (agent) {
      const keys = [QueryKeys.agents, { requiredPermission: PermissionBits.EDIT }];
      const listResp = queryClient.getQueryData<AgentListResponse>(keys);
      if (listResp != null) {
        if (!listResp.data.some((a) => a.id === agent.id)) {
          const currentAgents = [agent, ...JSON.parse(JSON.stringify(listResp.data))];
          queryClient.setQueryData<AgentListResponse>(keys, { ...listResp, data: currentAgents });
        }
      }

      localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}0`, agent.id);

      clearMessagesCache(queryClient, conversation?.conversationId);
      queryClient.invalidateQueries([QueryKeys.messages]);

      /** Template with agent configuration */
      const template = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: EModelEndpoint.agents,
        agent_id: agent.id,
        title: localize('com_agents_chat_with', { name: agent.name || localize('com_ui_agent') }),
        ...specDisplayFieldReset,
      };

      const currentConvo = getDefaultConversation({
        conversation: { ...(conversation ?? {}), ...template },
        preset: template,
      });

      newConversation({
        template: currentConvo,
        preset: template,
      });
    }
  };

  /**
   * Copy the agent's shareable link to clipboard
   */
  const handleCopyLink = () => {
    const baseUrl = new URL(window.location.origin);
    const chatUrl = `${baseUrl.origin}/c/new?agent_id=${agent.id}`;
    navigator.clipboard
      .writeText(chatUrl)
      .then(() => {
        showToast({
          message: localize('com_agents_link_copied'),
        });
      })
      .catch(() => {
        showToast({
          message: localize('com_agents_link_copy_failed'),
        });
      });
  };

  /**
   * Format contact information with mailto links when appropriate
   */
  const formatContact = () => {
    if (!agent?.support_contact) return null;

    const { name, email } = agent.support_contact;

    if (name && email) {
      return (
        <a href={`mailto:${email}`} className="text-text-primary hover:underline">
          {name}
        </a>
      );
    }

    if (email) {
      return (
        <a href={`mailto:${email}`} className="text-text-primary hover:underline">
          {email}
        </a>
      );
    }

    if (name) {
      return <span>{name}</span>;
    }

    return null;
  };

  return (
    <OGDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <OGDialogContent ref={dialogRef} className="max-h-[90vh] w-11/12 max-w-lg overflow-y-auto">
        {/* Agent avatar */}
        <div className="mt-6 flex justify-center">{renderAgentAvatar(agent, { size: 'xl' })}</div>

        {/* Agent name */}
        <div className="mt-3 text-center">
          <h2 className="text-2xl font-bold text-text-primary">
            {agent?.name || localize('com_agents_loading')}
          </h2>
        </div>

        {/* Contact info */}
        {agent?.support_contact && formatContact() && (
          <div className="mt-1 text-center text-sm text-text-secondary">
            {localize('com_agents_contact')}: {formatContact()}
          </div>
        )}

        {/* Agent description */}
        <Description
          description={agent?.description}
          className="mt-4 whitespace-pre-wrap px-6 text-center text-base text-text-primary [&_a]:underline [&_a]:underline-offset-2 [&_img]:inline-block [&_img]:max-w-full"
        />

        {/* Action button */}
        <div className="mb-4 mt-6 flex justify-center gap-2">
          <TooltipAnchor
            description={isFavorite ? localize('com_ui_unpin') : localize('com_ui_pin')}
            render={
              <Button
                variant="outline"
                size="icon"
                onClick={handleFavoriteClick}
                aria-label={isFavorite ? localize('com_ui_unpin') : localize('com_ui_pin')}
              >
                <MorphIcon icon={isFavorite ? PinOff : Pin} className="h-4 w-4" />
              </Button>
            }
          />
          <TooltipAnchor
            description={localize('com_agents_copy_link')}
            render={
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopyLink}
                aria-label={localize('com_agents_copy_link')}
              >
                <Link className="h-4 w-4" aria-hidden="true" />
              </Button>
            }
          />
          <Button
            variant="submit"
            className="w-full max-w-xs"
            onClick={handleStartChat}
            disabled={!agent}
          >
            {localize('com_agents_start_chat')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
};

export default AgentDetail;
