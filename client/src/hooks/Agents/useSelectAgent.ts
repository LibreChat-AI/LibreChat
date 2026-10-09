import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Constants,
  QueryKeys,
  dataService,
  EModelEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TConversation, TPreset, Agent } from 'librechat-data-provider';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import useDefaultConvo from '~/hooks/Conversations/useDefaultConvo';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { logger, specDisplayFieldReset } from '~/utils';
import useNewConvo from '~/hooks/useNewConvo';

export default function useSelectAgent() {
  const queryClient = useQueryClient();
  const agentsMap = useAgentsMapContext();
  const getDefaultConversation = useDefaultConvo();
  const { newConversation } = useNewConvo();
  const getConversation = useGetConversation(0);

  const updateConversation = useCallback(
    async (
      agent: Partial<Agent>,
      template: Partial<TPreset | TConversation>,
      /** The passes that follow the first one only carry freshly fetched agent details into the
       * composer the first pass opened, so a paste started meanwhile keeps its draft. */
      keepComposerState = false,
    ) => {
      const conversation = await getConversation();
      logger.log('conversation', 'Updating conversation with agent', agent);
      if (isAssistantsEndpoint(conversation?.endpoint)) {
        newConversation({
          template: { ...(template as Partial<TConversation>) },
          preset: template as Partial<TPreset>,
          keepComposerState,
        });
        return;
      }
      const switchesAgent = conversation?.agent_id !== agent.id;
      const resolvedConvo = getDefaultConversation({
        conversation: {
          ...(conversation ?? {}),
          agent_id: agent.id,
          codeEnvironmentMode: switchesAgent ? undefined : conversation?.codeEnvironmentMode,
          codeWorkspaces: switchesAgent ? undefined : conversation?.codeWorkspaces,
          ...specDisplayFieldReset,
        },
        preset: template,
      });
      const currentConvo = {
        ...resolvedConvo,
        codeEnvironmentMode: switchesAgent ? undefined : conversation?.codeEnvironmentMode,
        codeWorkspaces: switchesAgent ? undefined : conversation?.codeWorkspaces,
      };
      newConversation({
        template: currentConvo,
        preset: template as Partial<TPreset>,
        keepComposerState,
      });
    },
    [getConversation, getDefaultConversation, newConversation],
  );

  const onSelect = useCallback(
    async (value: string) => {
      const agent = agentsMap?.[value];
      if (!agent) {
        return;
      }

      const template: Partial<TPreset | TConversation> = {
        endpoint: EModelEndpoint.agents,
        agent_id: agent.id,
        conversationId: Constants.NEW_CONVO as string,
        codeEnvironmentMode: undefined,
        codeWorkspaces: undefined,
        ...specDisplayFieldReset,
      };

      await updateConversation({ id: agent.id }, template);

      try {
        const fullAgent = await queryClient.fetchQuery([QueryKeys.agent, agent.id], () =>
          dataService.getAgentById({
            agent_id: agent.id,
          }),
        );
        if (fullAgent) {
          await updateConversation(fullAgent, { ...template, agent_id: fullAgent.id }, true);
        }
      } catch (error) {
        if ((error as { silent: boolean } | undefined)?.silent) {
          console.warn('Current fetch was cancelled');
          return;
        }
        console.error('Error fetching full agent data:', error);
        await updateConversation({}, { ...template, agent_id: undefined }, true);
      }
    },
    [agentsMap, updateConversation, queryClient],
  );

  return { onSelect };
}
