import { useEffect, useMemo } from 'react';
import { Button, ControlCombobox, Switch } from '@librechat/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Constants,
  DynamicQueryKeys,
  EModelEndpoint,
  QueryKeys,
  dataService,
} from 'librechat-data-provider';
import type {
  AgentRoutingAction,
  AgentRoutingDecisionView,
  TConversation,
} from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { OptionWithIcon } from '~/common';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { useLocalize } from '~/hooks';

export default function AgentRoutingNotice({
  conversation,
  setConversation,
}: {
  conversation: TConversation | null | undefined;
  setConversation: SetterOrUpdater<TConversation | null>;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const agents = useAgentsMapContext();
  const { data: endpoints } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();
  const conversationId = conversation?.conversationId ?? '';
  const revision = conversation?.agentRoutingRevision ?? 0;
  const automaticAvailable =
    endpoints?.[EModelEndpoint.agents]?.conversationHandoffsEnabled === true;
  const enabled =
    conversation?.endpoint === EModelEndpoint.agents &&
    conversationId !== '' &&
    conversationId !== Constants.NEW_CONVO &&
    conversationId !== Constants.PENDING_CONVO &&
    startupConfig != null &&
    startupConfig.modelSpecs?.enforce !== true &&
    (revision > 0 || automaticAvailable);
  const {
    data: decision,
    isError,
    refetch,
  } = useQuery<AgentRoutingDecisionView>(
    DynamicQueryKeys.agentRouting(conversationId, revision),
    () => dataService.getConversationAgentRouting(conversationId),
    { enabled, refetchOnMount: true },
  );
  const alternatives = useMemo<OptionWithIcon[]>(
    () =>
      Object.values(agents ?? {}).flatMap((agent) =>
        agent?.id && agent.id !== decision?.agentId
          ? [{ label: agent.name || agent.id, value: agent.id }]
          : [],
      ),
    [agents, decision?.agentId],
  );
  const applyDecision = (next: AgentRoutingDecisionView) => {
    setConversation((current) => {
      if (
        current?.conversationId !== conversationId ||
        (current.agentRoutingRevision ?? 0) > next.revision
      ) {
        return current;
      }
      return {
        ...current,
        agent_id: next.agentId ?? current.agent_id,
        agentRoutingRevision: next.revision,
        automaticHandoffsEnabled: next.automaticHandoffsEnabled,
      };
    });
    queryClient.setQueryData<TConversation>([QueryKeys.conversation, conversationId], (current) => {
      if (current == null || (current.agentRoutingRevision ?? 0) > next.revision) return current;
      return {
        ...current,
        agent_id: next.agentId ?? current.agent_id,
        agentRoutingRevision: next.revision,
        automaticHandoffsEnabled: next.automaticHandoffsEnabled,
      };
    });
    queryClient.setQueryData(DynamicQueryKeys.agentRouting(conversationId, next.revision), next);
  };
  useEffect(() => {
    if (decision != null && decision.revision > revision) {
      applyDecision(decision);
    }
    // Only an authoritative server response at a higher revision may reconcile this conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision, revision, conversationId, setConversation, queryClient]);
  const update = useMutation<AgentRoutingDecisionView, Error, AgentRoutingAction>(
    (action) => dataService.updateConversationAgentRouting(conversationId, action),
    {
      onSuccess: applyDecision,
      onError: () => {
        void queryClient.invalidateQueries([QueryKeys.conversation, conversationId]);
        void queryClient.invalidateQueries(DynamicQueryKeys.agentRouting(conversationId, revision));
      },
    },
  );
  if (!enabled) return null;
  if (isError && decision == null) {
    return (
      <section aria-label={localize('com_ui_agent_handoff_future_turns')}>
        <p role="alert">{localize('com_ui_agent_handoff_update_failed')}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </section>
    );
  }
  if (decision == null || decision.revision < revision) return null;
  const previous = decision.previousAgentId ? agents?.[decision.previousAgentId] : undefined;
  const selected = decision.agentId ? agents?.[decision.agentId] : undefined;
  const canSwitchBack =
    decision.transitionId != null &&
    decision.previousAgentId != null &&
    decision.previousAgentId !== decision.agentId;
  return (
    <section
      aria-label={localize('com_ui_agent_handoff_future_turns')}
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-text-secondary xl:max-w-4xl"
    >
      {canSwitchBack ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span role="status">
            {localize('com_ui_agent_handoff_future_agent', {
              0: selected?.name ?? localize('com_ui_agent'),
            })}
          </span>
          {previous != null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={update.isLoading}
              onClick={() =>
                update.mutate({
                  action: 'switch_back',
                  transitionId: decision.transitionId!,
                  expectedRevision: decision.revision,
                })
              }
            >
              {localize('com_ui_agent_handoff_switch_back', { 0: previous.name })}
            </Button>
          )}
        </div>
      ) : (
        <span />
      )}
      {alternatives.length > 0 && (
        <ControlCombobox
          isCollapsed={false}
          ariaLabel={localize('com_ui_agent_handoff_choose_agent')}
          selectedValue=""
          setValue={(agentId) =>
            update.mutate({ action: 'select', agentId, expectedRevision: decision.revision })
          }
          items={alternatives}
          selectPlaceholder={localize('com_ui_agent_handoff_choose_agent')}
          searchPlaceholder={localize('com_ui_agent_var', { 0: localize('com_ui_search') })}
          unsearchedLimit={25}
          disabled={update.isLoading}
          className="h-9 border-border-light"
          containerClassName="px-0"
        />
      )}
      {agents != null && decision.agentId != null && selected == null && (
        <p role="alert" className="w-full text-text-secondary">
          {localize('com_ui_agent_handoff_target_unavailable')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor="automatic-handoffs">{localize('com_ui_agent_handoff_automatic')}</label>
        <Switch
          id="automatic-handoffs"
          aria-label={localize('com_ui_agent_handoff_automatic')}
          checked={decision.automaticHandoffsEnabled}
          disabled={update.isLoading || (!automaticAvailable && !decision.automaticHandoffsEnabled)}
          onCheckedChange={(next) =>
            update.mutate({
              action: 'automatic',
              enabled: next,
              expectedRevision: decision.revision,
            })
          }
        />
      </div>
      {(update.isError || isError) && (
        <p role="alert" className="w-full text-text-destructive">
          {localize('com_ui_agent_handoff_update_failed')}
        </p>
      )}
    </section>
  );
}
