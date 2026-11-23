import { useMemo } from 'react';
import {
  collectReachableAgents,
  selectCodeApprovalMode,
  isWithoutAttachedApproval,
  resolveCodeApprovalModeOptions,
  resolveCodeApprovalAvailability,
  resolveCodeApprovalEnvironments,
} from '@librechat/chat';
import type {
  TConfig,
  TConversation,
  CodeApprovalMode,
  CodeEnvironmentMode,
} from 'librechat-data-provider';
import type { CodeApprovalModeInputs } from '@librechat/chat';
import { useCodeApprovalModePreference } from './codeApprovalPreference';
import useAgentToolPermissions from './useAgentToolPermissions';
import useGetAgentsConfig from './useGetAgentsConfig';
import { useAgentsMapContext } from '~/Providers';

export {
  collectReachableAgents,
  findExecutionEnvironment,
  getCodeEnvironmentChoiceIds,
  findCodeWorkspaceDiscoveryEnvironment,
  resolveReachableCodeWorkspaceInheritance,
} from '@librechat/chat';

/**
 * `codeEnvironmentMode` is the mode the composer resolved for the next turn (`useCodeWorkspace`'s
 * `mode`), which also covers a saved chat with no recorded decision and a draft still choosing.
 */
export default function useCodeApprovalMode(
  conversation: TConversation | null,
  addedConversation?: TConversation | null,
  codeEnvironmentMode?: CodeEnvironmentMode,
): {
  available: boolean;
  modes: CodeApprovalMode[];
  selected?: CodeApprovalMode;
  /** The raw values this hook read, for a derivation at send time. */
  readInputs: () => Omit<CodeApprovalModeInputs, 'codeEnvironmentMode'>;
} {
  const { agentsConfig } = useGetAgentsConfig();
  const agentsMap = useAgentsMapContext();
  const preference = useCodeApprovalModePreference();
  const { agent: primaryAgent } = useAgentToolPermissions(conversation?.agent_id);
  const { agent: addedAgent } = useAgentToolPermissions(addedConversation?.agent_id);
  const statefulCodeSessions = agentsConfig?.statefulCodeSessions as
    | TConfig['statefulCodeSessions']
    | undefined;
  const environments = statefulCodeSessions?.environments;
  const reachable = useMemo(
    () =>
      collectReachableAgents([primaryAgent, addedAgent], agentsMap, [
        conversation?.agent_id,
        addedConversation?.agent_id,
      ]),
    [addedAgent, agentsMap, primaryAgent, conversation?.agent_id, addedConversation?.agent_id],
  );
  const withoutAttached = isWithoutAttachedApproval(conversation, codeEnvironmentMode);
  const approvalEnvironments = useMemo(
    () =>
      resolveCodeApprovalEnvironments({
        agents: reachable.agents,
        environments,
        allowEnvironmentSelection: statefulCodeSessions?.allowEnvironmentSelection,
        selections: conversation?.codeWorkspaces,
        withoutAttached,
      }),
    [
      environments,
      reachable,
      statefulCodeSessions?.allowEnvironmentSelection,
      conversation?.codeWorkspaces,
      withoutAttached,
    ],
  );
  const { supported, available } = resolveCodeApprovalAvailability({
    conversation,
    statefulCodeSessions,
    attachedEnvironments: approvalEnvironments.attachedEnvironments,
  });
  const endpointModes = statefulCodeSessions?.approvalModes;
  const modes = useMemo(
    () =>
      resolveCodeApprovalModeOptions({
        ...approvalEnvironments,
        available,
        complete: reachable.complete,
        endpointModes,
      }),
    [approvalEnvironments, available, endpointModes, reachable.complete],
  );
  /** A conversation that carries no mode of its own opens on the reader's last
   *  pick in this browser, so choosing `acceptEdits` or `fullAccess` survives a
   *  new chat and a reload instead of being re-picked every time. The remembered
   *  value is a preference, not a grant: it passes the same policy gate below as
   *  a stored one, so a mode current policy no longer allows falls back to `ask`. */
  const requested = conversation?.codeApprovalMode ?? preference.get() ?? 'ask';
  const selected = selectCodeApprovalMode({ supported, available, modes, requested });

  return {
    available,
    modes,
    selected,
    readInputs: () => ({
      conversation,
      statefulCodeSessions,
      reachable,
      preferred: preference.get(),
    }),
  };
}
