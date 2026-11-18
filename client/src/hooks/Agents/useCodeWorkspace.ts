import { useCallback, useMemo } from 'react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  collectReachableAgents,
  resolveCodeWorkspaceLock,
  inferCodeEnvironmentMode,
  resolveCodeWorkspaceStatus,
  resolveCodeWorkspaceMetadata,
  resolveCodeWorkspaceProtocol,
  resolveCodeWorkspaceSelections,
  resolveCodeWorkspaceSubmission,
  resolveCodeWorkspaceRequirement,
  resolveCodeWorkspaceEnvironments,
} from '@librechat/chat';
import type {
  CodeWorkspaceState,
  CodeWorkspaceSubmission,
  CodeWorkspaceTransition,
  CodeWorkspaceEnvironmentResult,
} from '@librechat/chat';
import type {
  TConfig,
  TConversation,
  CodeEnvironmentMode,
  CodeWorkspaceSelection,
  TPublicCodeEnvironment,
} from 'librechat-data-provider';
import type { CodeWorkspaceInputs } from '@librechat/chat';
import type { CodeEnvironmentReconciliation } from '~/store/codeEnvironmentReconciliation';
import {
  useGetStartupConfig,
  useCodeEnvironmentStatusQueries,
  useConversationCodeEnvironmentRecovery,
  useIsReplacingConversationCodeEnvironment,
} from '~/data-provider';
import { useWorkspacePreferences } from './workspacePreferences';
import useAgentToolPermissions from './useAgentToolPermissions';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import useGetAgentsConfig from './useGetAgentsConfig';
import { useAgentsMapContext } from '~/Providers';

export type {
  CodeWorkspaceState,
  CodeWorkspaceTransition,
  CodeWorkspaceEnvironmentResult,
} from '@librechat/chat';

export interface CodeWorkspaceResult {
  recovery?: CodeEnvironmentReconciliation;
  required: boolean;
  supportsEnvironmentDecisions: boolean;
  locked: boolean;
  mode?: CodeEnvironmentMode;
  state: CodeWorkspaceState;
  canSubmit: boolean;
  /** Whether the composer shows the workspace control. A chat running without an attached
   *  environment keeps it, so the state it is in stays visible and reversible. */
  visible: boolean;
  environments: CodeWorkspaceEnvironmentResult[];
  /** Alternative machines are discovered on demand; an idle machine never blocks this chat. */
  machineOptions?: TPublicCodeEnvironment[];
  /** Each group belongs to one reachable coding agent, not the whole graph. */
  machineOptionGroups?: string[][];
  machineChoiceOwners?: Array<{ agentId: string; environmentIds: string[] }>;
  /** Fixed graph targets must survive an alternative pick for a different agent. */
  fixedMachineIds?: string[];
  transition?: CodeWorkspaceTransition;
  selections?: CodeWorkspaceSelection[];
  resolveSelections: (
    selections?: CodeWorkspaceSelection[],
  ) => CodeWorkspaceSelection[] | undefined;
  resolveSubmission: (
    selections?: CodeWorkspaceSelection[],
    mode?: CodeEnvironmentMode,
  ) => CodeWorkspaceSubmission | undefined;
  rememberSelection: (selection: CodeWorkspaceSelection) => void;
  /** The raw values this hook read on its last render, for a derivation at send time. */
  readInputs: () => CodeWorkspaceInputs;
}

export default function useCodeWorkspace(
  conversation: TConversation | null,
  addedConversation?: TConversation | null,
): CodeWorkspaceResult {
  const { data: startupConfig } = useGetStartupConfig();
  const protocol = resolveCodeWorkspaceProtocol(startupConfig);
  const { supportsEnvironmentDecisions, supportsWorkspaceInheritance } = protocol;
  const recovery = useConversationCodeEnvironmentRecovery(conversation?.conversationId);
  const replacingDecision = useIsReplacingConversationCodeEnvironment(conversation?.conversationId);
  const preferences = useWorkspacePreferences(conversation?.agent_id);
  const { agentsConfig, endpointsConfig } = useGetAgentsConfig();
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const agentsMap = useAgentsMapContext();
  const { agent: primaryAgent } = useAgentToolPermissions(conversation?.agent_id);
  const { agent: addedAgent } = useAgentToolPermissions(addedConversation?.agent_id);
  const statefulCodeSessions = agentsConfig?.statefulCodeSessions as
    | TConfig['statefulCodeSessions']
    | undefined;
  const reachable = useMemo(
    () =>
      collectReachableAgents([primaryAgent, addedAgent], agentsMap, [
        conversation?.agent_id,
        addedConversation?.agent_id,
      ]),
    [addedAgent, agentsMap, primaryAgent, conversation?.agent_id, addedConversation?.agent_id],
  );
  const storedSelections = conversation?.codeWorkspaces;
  const { isNewChat, locked, undecided } = resolveCodeWorkspaceLock(
    conversation,
    supportsEnvironmentDecisions,
  );
  const workspaceMetadata = useMemo(
    () =>
      resolveCodeWorkspaceMetadata({
        agentId: conversation?.agent_id,
        addedAgentId: addedConversation?.agent_id,
        primaryAgent,
        addedAgent,
        agentsMap,
        selections: conversation?.codeWorkspaces,
        environments: statefulCodeSessions?.environments,
        allowEnvironmentSelection: statefulCodeSessions?.allowEnvironmentSelection,
        reachableAgents: reachable.agents,
        supportsWorkspaceInheritance,
        undecided,
      }),
    [
      addedAgent,
      addedConversation?.agent_id,
      agentsMap,
      conversation?.agent_id,
      conversation?.codeWorkspaces,
      primaryAgent,
      reachable.agents,
      statefulCodeSessions?.environments,
      statefulCodeSessions?.allowEnvironmentSelection,
      supportsWorkspaceInheritance,
      undecided,
    ],
  );
  const requirement = resolveCodeWorkspaceRequirement({
    conversation,
    addedConversation,
    canRunCode,
    capabilities: agentsConfig?.capabilities,
    configurationLoaded: endpointsConfig !== undefined || agentsConfig != null,
    reachableComplete: reachable.complete,
    metadata: workspaceMetadata,
  });
  const { required, selectionMetadataComplete } = requirement;
  const attachedEnvironments = workspaceMetadata.environments;
  const statuses = useCodeEnvironmentStatusQueries(
    attachedEnvironments.map(({ id }) => id),
    required && selectionMetadataComplete,
    // Poll progress is not workspace state; keep unchanged refreshes off the send path.
    { notifyOnChangeProps: ['data', 'isLoading', 'isError'] },
  );
  const attachedEnvironmentIds = useMemo(
    () => new Set(attachedEnvironments.map(({ id }) => id)),
    [attachedEnvironments],
  );
  const { formerEnvironmentIds } = workspaceMetadata;
  const {
    environmentResults,
    machineChoiceOwners,
    machineOptionGroups,
    machineOptions,
    fixedMachineIds,
  } = resolveCodeWorkspaceEnvironments({
    conversation,
    metadata: workspaceMetadata,
    statuses,
    attachedEnvironmentIds,
    undecided,
    locked,
    required,
    supportsEnvironmentDecisions,
    statefulCodeSessions,
    reachableAgents: reachable.agents,
    getPreferredWorkspace: preferences.get,
  });

  const resolveSelections = useCallback(
    (selections?: CodeWorkspaceSelection[]): CodeWorkspaceSelection[] | undefined =>
      resolveCodeWorkspaceSelections(
        {
          required,
          selectionMetadataComplete,
          attachedEnvironmentIds,
          formerEnvironmentIds,
          environmentResults,
          supportsWorkspaceInheritance,
          statefulCodeSessions,
          primaryAgent,
          addedAgent,
          agentsMap,
          reachableAgents: reachable.agents,
        },
        selections,
      ),
    [
      addedAgent,
      agentsMap,
      attachedEnvironmentIds,
      environmentResults,
      formerEnvironmentIds,
      primaryAgent,
      required,
      selectionMetadataComplete,
      reachable.agents,
      statefulCodeSessions,
      supportsWorkspaceInheritance,
    ],
  );

  const selections = resolveSelections(storedSelections);
  const inferredMode = inferCodeEnvironmentMode({
    conversation,
    isNewChat,
    required,
    selections,
    supportsEnvironmentDecisions,
  });
  const resolveSubmission = useCallback(
    (
      candidateSelections?: CodeWorkspaceSelection[],
      candidateMode?: CodeEnvironmentMode,
    ): CodeWorkspaceSubmission | undefined =>
      resolveCodeWorkspaceSubmission(
        {
          recoveryPending: recovery != null,
          required,
          replacingDecision,
          inferredMode,
          supportsEnvironmentDecisions,
          resolveSelections,
        },
        candidateSelections,
        candidateMode,
      ),
    [
      inferredMode,
      recovery,
      replacingDecision,
      required,
      resolveSelections,
      supportsEnvironmentDecisions,
    ],
  );
  const canSubmit = resolveSubmission(storedSelections, conversation?.codeEnvironmentMode) != null;
  const { state, transition, visible } = resolveCodeWorkspaceStatus({
    conversation,
    protocol,
    locked,
    requirement,
    environmentResults,
    attachedEnvironmentIds,
    selections,
    inferredMode,
    canSubmit,
    recoveryPending: recovery != null,
    statefulCodeSessions,
  });
  const rememberSelection = useCallback(
    (selection: CodeWorkspaceSelection) => {
      preferences.remember(selection.environmentId, selection.workspaceId, [
        ...(workspaceMetadata.preferenceAgentIds.get(selection.environmentId) ?? []),
      ]);
    },
    [preferences, workspaceMetadata.preferenceAgentIds],
  );
  return {
    recovery,
    required,
    supportsEnvironmentDecisions,
    locked,
    mode: inferredMode,
    state,
    canSubmit,
    visible,
    environments: environmentResults,
    machineOptions,
    machineOptionGroups,
    machineChoiceOwners,
    fixedMachineIds,
    transition,
    selections,
    resolveSelections,
    resolveSubmission,
    rememberSelection,
    readInputs: () => ({
      conversation,
      addedConversation,
      primaryAgent,
      addedAgent,
      agentsMap,
      statefulCodeSessions,
      startupConfig,
      canRunCode,
      capabilities: agentsConfig?.capabilities,
      configurationLoaded: endpointsConfig !== undefined || agentsConfig != null,
      recoveryPending: recovery != null,
      replacingDecision,
      statuses: Object.fromEntries(
        attachedEnvironments.map(({ id }, index) => [id, statuses[index]]),
      ),
      getPreferredWorkspace: preferences.get,
    }),
  };
}
