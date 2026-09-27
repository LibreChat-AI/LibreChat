import { useCallback, useMemo } from 'react';
import {
  EModelEndpoint,
  Tools,
  isEphemeralAgentId,
  isCodeWorkspaceSelections,
} from 'librechat-data-provider';
import {
  AgentCapabilities,
  CODE_ENVIRONMENT_DECISION_VERSION,
  CODE_ENVIRONMENT_MOVE_VERSION,
  CODE_ENVIRONMENT_TRANSITION_VERSION,
  CODE_WORKSPACE_RECOVERY_VERSION,
  PermissionTypes,
  Permissions,
} from 'librechat-data-provider';
import type {
  CodeEnvironmentMode,
  CodeWorkspaceDescriptor,
  CodeWorkspaceSelection,
  TConfig,
  TCodeEnvironmentStatusResponse,
  TConversation,
  TPublicCodeEnvironment,
} from 'librechat-data-provider';
import type { CodeEnvironmentReconciliation } from '~/store/codeEnvironmentReconciliation';
import {
  useCodeEnvironmentStatusQueries,
  useGetStartupConfig,
  useIsReplacingConversationCodeEnvironment,
  useConversationCodeEnvironmentRecovery,
} from '~/data-provider';
import { collectReachableAgents, findExecutionEnvironment } from './useCodeApprovalMode';
import { useWorkspacePreferences } from './workspacePreferences';
import useAgentToolPermissions from './useAgentToolPermissions';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import useGetAgentsConfig from './useGetAgentsConfig';
import { useAgentsMapContext } from '~/Providers';

export type CodeWorkspaceState =
  | 'not_required'
  | 'without_attached'
  | 'loading'
  | 'choose'
  | 'relocatable'
  | 'ready'
  | 'missing'
  | 'unavailable'
  | 'unsupported';

export interface CodeWorkspaceEnvironmentResult {
  environment: TPublicCodeEnvironment;
  state: Exclude<CodeWorkspaceState, 'not_required' | 'relocatable'>;
  workspaces: CodeWorkspaceDescriptor[];
  selected?: CodeWorkspaceSelection;
}

/**
 * A change of a saved chat's sealed decision that its owner may make from the composer. The
 * decision stays sealed against implicit changes; only this explicit transition replaces it, and
 * it never touches the chat's messages or copies a file between machines.
 *
 * - `move`: the attached decision no longer covers every environment the chat's agents use, most
 *   often because an agent was pointed at a different machine or its saved workspace disappeared.
 * - `attach`: the chat has been running without an attached environment and can now take one, so
 *   switching a saved chat to a coding agent is a transition rather than a dead end.
 */
export interface CodeWorkspaceTransition {
  kind: 'move' | 'attach';
  conversationId: string;
  /** The persisted selections this replaces, exactly as the conversation stores them; empty for a
   *  chat that has been running without an attached environment. */
  from: CodeWorkspaceSelection[];
  /** Environments the decision covered that the agents no longer use. */
  previous: Array<
    Pick<TPublicCodeEnvironment, 'id'> & Partial<Pick<TPublicCodeEnvironment, 'name'>>
  >;
  /** Registered sealed selections the agents still use; a move carries them over unchanged. */
  retained: CodeWorkspaceSelection[];
  /** Environments needing a new selection, including those whose workspace disappeared. */
  targets: CodeWorkspaceEnvironmentResult[];
  /** Whether the chat may leave attached execution and continue without a workspace. Offered when
   *  the machine it sealed is no longer usable, so an unreachable worker never silently becomes a
   *  changed execution mode and never strands the composer either. */
  detachable: boolean;
}

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
  transition?: CodeWorkspaceTransition;
  selections?: CodeWorkspaceSelection[];
  resolveSelections: (
    selections?: CodeWorkspaceSelection[],
  ) => CodeWorkspaceSelection[] | undefined;
  resolveSubmission: (
    selections?: CodeWorkspaceSelection[],
    mode?: CodeEnvironmentMode,
  ) =>
    | { codeEnvironmentMode?: CodeEnvironmentMode; codeWorkspaces?: CodeWorkspaceSelection[] }
    | undefined;
  rememberSelection: (selection: CodeWorkspaceSelection) => void;
}

function aggregateState(
  required: boolean,
  complete: boolean,
  environments: CodeWorkspaceEnvironmentResult[],
  selections: CodeWorkspaceSelection[] | undefined,
): CodeWorkspaceState {
  if (!required) return 'not_required';
  if (!complete || environments.some(({ state }) => state === 'unavailable')) return 'unavailable';
  if (environments.some(({ state }) => state === 'unsupported')) return 'unsupported';
  if (environments.some(({ state }) => state === 'missing')) return 'missing';
  if (environments.some(({ state }) => state === 'loading')) return 'loading';
  if (selections == null) return 'choose';
  return 'ready';
}

function resolveEnvironmentSelection({
  environment,
  status,
  workspaces,
  stored,
  hasStoredSelections,
}: {
  environment: TPublicCodeEnvironment;
  status?: TCodeEnvironmentStatusResponse;
  workspaces: CodeWorkspaceDescriptor[];
  stored?: CodeWorkspaceSelection;
  hasStoredSelections: boolean;
}): CodeWorkspaceSelection | undefined {
  if (status?.status !== 'ready' || status.environmentId !== environment.id) return undefined;
  if (stored != null && workspaces.some(({ id }) => id === stored.workspaceId)) {
    return { environmentId: environment.id, workspaceId: stored.workspaceId };
  }
  if (!hasStoredSelections && workspaces.length === 1) {
    return { environmentId: environment.id, workspaceId: workspaces[0].id };
  }
  return undefined;
}

export default function useCodeWorkspace(
  conversation: TConversation | null,
  addedConversation?: TConversation | null,
): CodeWorkspaceResult {
  const { data: startupConfig } = useGetStartupConfig();
  const supportsEnvironmentDecisions =
    startupConfig?.codeEnvironmentDecisionVersion === CODE_ENVIRONMENT_DECISION_VERSION;
  const supportsEnvironmentMoves =
    startupConfig?.codeEnvironmentMoveVersion === CODE_ENVIRONMENT_MOVE_VERSION;
  /** Attaching an environment and leaving attached execution are advertised beside the move rather
   *  than as a higher move version, so a deployment mid-rollout keeps serving the move to a client
   *  that predates them, and a client that has them never offers a replica an attach it refuses as
   *  `locked` or an empty target set it calls `invalid`. */
  const supportsEnvironmentTransitions =
    supportsEnvironmentDecisions &&
    startupConfig?.codeEnvironmentTransitionVersion === CODE_ENVIRONMENT_TRANSITION_VERSION;
  const recovery = useConversationCodeEnvironmentRecovery(conversation?.conversationId);
  const replacingDecision = useIsReplacingConversationCodeEnvironment(conversation?.conversationId);
  const supportsWorkspaceRecovery =
    supportsEnvironmentMoves &&
    startupConfig?.codeWorkspaceRecoveryVersion === CODE_WORKSPACE_RECOVERY_VERSION;
  const preferences = useWorkspacePreferences(conversation?.agent_id);
  const { agentsConfig, endpointsConfig } = useGetAgentsConfig();
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const codeEnabled =
    canRunCode &&
    agentsConfig?.capabilities?.includes(AgentCapabilities.execute_code) === true &&
    agentsConfig.capabilities.includes(AgentCapabilities.stateful_code_sessions);
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
  const workspaceMetadata = useMemo(() => {
    const unique = new Map<string, TPublicCodeEnvironment>();
    const defaults = new Map<string, Set<string>>();
    const preferenceAgentIds = new Map<string, Set<string>>();
    let complete = true;
    for (const agent of reachable.agents) {
      if (agent.stateful_code_sessions !== true || !agent.tools?.includes(Tools.execute_code)) {
        continue;
      }
      const environment = findExecutionEnvironment(agent, statefulCodeSessions?.environments);
      if (agent.code_environment_id && environment == null) complete = false;
      if (environment?.type !== 'attached') continue;
      unique.set(environment.id, environment);
      if (agent.code_environment_id === environment.id && agent.code_workspace_id) {
        const choices = defaults.get(environment.id) ?? new Set<string>();
        choices.add(agent.code_workspace_id);
        defaults.set(environment.id, choices);
      }
    }

    for (const [rootAgent, rootAgentId] of [
      [primaryAgent, conversation?.agent_id],
      [addedAgent, addedConversation?.agent_id],
    ] as const) {
      if (!rootAgent || !rootAgentId) continue;
      const rootReachable = collectReachableAgents([rootAgent], agentsMap, [rootAgentId]);
      for (const agent of rootReachable.agents) {
        if (agent.stateful_code_sessions !== true || !agent.tools?.includes(Tools.execute_code)) {
          continue;
        }
        const environment = findExecutionEnvironment(agent, statefulCodeSessions?.environments);
        if (environment?.type !== 'attached') continue;
        const owners = preferenceAgentIds.get(environment.id) ?? new Set<string>();
        owners.add(rootAgentId);
        preferenceAgentIds.set(environment.id, owners);
      }
    }
    return {
      complete,
      defaults,
      preferenceAgentIds,
      environments: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }, [
    addedAgent,
    addedConversation?.agent_id,
    agentsMap,
    conversation?.agent_id,
    primaryAgent,
    reachable.agents,
    statefulCodeSessions?.environments,
  ]);
  const isAgentsConversation =
    (conversation?.endpointType ?? conversation?.endpoint) === EModelEndpoint.agents;
  const expectedRoot = conversation?.agent_id != null || addedConversation?.agent_id != null;
  const expectedSavedAgent = [conversation?.agent_id, addedConversation?.agent_id].some(
    (agentId) => agentId != null && !isEphemeralAgentId(agentId),
  );
  const configurationLoaded = endpointsConfig !== undefined || agentsConfig != null;
  const configurationPending =
    canRunCode && isAgentsConversation && expectedSavedAgent && !configurationLoaded;
  const attachedEnvironments = workspaceMetadata.environments;
  const metadataComplete =
    !isAgentsConversation || !expectedRoot || (reachable.complete && workspaceMetadata.complete);
  const required =
    configurationPending ||
    (codeEnabled && isAgentsConversation && (!metadataComplete || attachedEnvironments.length > 0));
  const selectionMetadataComplete = !configurationPending && metadataComplete;
  const statuses = useCodeEnvironmentStatusQueries(
    attachedEnvironments.map(({ id }) => id),
    required && selectionMetadataComplete,
  );
  const storedSelections = conversation?.codeWorkspaces;
  const attachedEnvironmentIds = useMemo(
    () => new Set(attachedEnvironments.map(({ id }) => id)),
    [attachedEnvironments],
  );
  const hasForeignStoredSelection = storedSelections?.some(
    ({ environmentId }) => !attachedEnvironmentIds.has(environmentId),
  );
  const isNewChat =
    conversation != null &&
    (conversation.conversationId == null || conversation.conversationId === 'new');
  /** Only a recorded decision is sealed. A saved chat whose turns never involved a code-capable
   *  agent stores none, so switching one to a coding agent still gets to choose; treating it as
   *  sealed leaves the composer showing a decision its owner never made, with no workspace to
   *  select and no way to submit.
   *
   *  Until the deployment advertises the decision protocol, a replica that still reads a
   *  field-less row as a sealed `without_attached` may serve the next turn and reject an attached
   *  choice as `locked`, so the legacy lock stays for the whole rollout window. Nothing is lost by
   *  waiting: the composer only reports that unmade decision once the same flag is on. */
  const holdsDecision =
    conversation?.codeEnvironmentMode != null || (storedSelections?.length ?? 0) > 0;
  const locked =
    conversation != null && !isNewChat && (holdsDecision || !supportsEnvironmentDecisions);
  /** A new chat and a saved chat that never decided are both still choosing, so agent defaults, a
   *  remembered selection, and a sole workspace apply to each. */
  const undecided = conversation != null && !locked;
  const environmentResults = attachedEnvironments.map((environment, index) => {
    const status = statuses[index];
    const workspaces =
      status?.data?.status === 'ready' && Array.isArray(status.data.workspaces)
        ? status.data.workspaces
        : [];
    let stored = storedSelections?.find(({ environmentId }) => environmentId === environment.id);
    let conflictingDefaults = false;
    if (stored == null && undecided && !hasForeignStoredSelection) {
      const defaults = workspaceMetadata.defaults.get(environment.id) ?? new Set<string>();
      let preferred: string | undefined;
      if (defaults.size === 1) preferred = [...defaults][0];
      else if (defaults.size === 0) {
        preferred = [...(workspaceMetadata.preferenceAgentIds.get(environment.id) ?? [])]
          .map((agentId) => preferences.get(environment.id, agentId))
          .find((workspaceId) => workspaces.some(({ id }) => id === workspaceId));
      }
      if (preferred && (defaults.size > 0 || workspaces.some(({ id }) => id === preferred))) {
        stored = { environmentId: environment.id, workspaceId: preferred };
      }
      conflictingDefaults = defaults.size > 1;
    }
    const selected = resolveEnvironmentSelection({
      environment,
      status: status?.data,
      workspaces,
      stored,
      /** A saved chat already holds the server's decision, so a sole workspace is not a draft
       *  choice there: auto-selecting it would submit a selection its persisted decision rejects.
       *  Attached selections are sealed whether or not selection-less decisions are advertised. */
      hasStoredSelections:
        (locked && (supportsEnvironmentDecisions || (storedSelections?.length ?? 0) > 0)) ||
        stored != null ||
        conflictingDefaults ||
        hasForeignStoredSelection === true,
    });
    let state: CodeWorkspaceEnvironmentResult['state'] = 'choose';
    if (status == null || status.isLoading) state = 'loading';
    else if (
      status.isError ||
      status.data?.status !== 'ready' ||
      status.data.environmentId !== environment.id
    ) {
      state = 'unavailable';
    } else if (status.data.workspaces == null) state = 'unsupported';
    else if (selected != null) state = 'ready';
    else if (stored != null) state = 'missing';
    else if (workspaces.length === 0) state = 'unavailable';
    return { environment, state, workspaces, selected };
  });

  const resolveSelections = useCallback(
    (selections?: CodeWorkspaceSelection[]): CodeWorkspaceSelection[] | undefined => {
      if (!required || !selectionMetadataComplete || !isCodeWorkspaceSelections(selections ?? [])) {
        return undefined;
      }
      /** A saved chat's decision is sealed as a whole: trimming a selection its agents no longer use
       *  would submit a set the persisted decision rejects. */
      if (
        locked &&
        selections?.some(({ environmentId }) => !attachedEnvironmentIds.has(environmentId))
      ) {
        return undefined;
      }
      const resolved: CodeWorkspaceSelection[] = [];
      for (const result of environmentResults) {
        const requested = selections?.find(
          ({ environmentId }) => environmentId === result.environment.id,
        );
        if (
          requested != null &&
          result.state !== 'loading' &&
          result.state !== 'unavailable' &&
          result.state !== 'unsupported' &&
          result.workspaces.some(({ id }) => id === requested.workspaceId)
        ) {
          resolved.push({
            environmentId: result.environment.id,
            workspaceId: requested.workspaceId,
          });
          continue;
        }
        if (requested == null && result.selected != null && result.state === 'ready') {
          resolved.push(result.selected);
          continue;
        }
        return undefined;
      }
      return resolved.sort((a, b) => a.environmentId.localeCompare(b.environmentId));
    },
    [attachedEnvironmentIds, environmentResults, locked, required, selectionMetadataComplete],
  );

  const selections = resolveSelections(storedSelections);
  let inferredMode: CodeEnvironmentMode | undefined = conversation?.codeEnvironmentMode;
  if (inferredMode == null && storedSelections != null) {
    inferredMode = 'attached';
  } else if (inferredMode == null && !isNewChat && supportsEnvironmentDecisions) {
    // Suggestions are not consent. Existing non-coding chats start without workspace access;
    // only an explicit selection in the composer may attach their first coding turn.
    inferredMode = 'without_attached';
  } else if (inferredMode == null && selections != null) {
    inferredMode = 'attached';
  } else if (inferredMode == null && required && supportsEnvironmentDecisions) {
    inferredMode = 'without_attached';
  }
  let state: CodeWorkspaceState;
  const hasLockedWithoutAttachedDecision =
    inferredMode === 'without_attached' &&
    (conversation?.codeEnvironmentMode === 'without_attached' || locked);
  if (hasLockedWithoutAttachedDecision) {
    state = 'without_attached';
  } else if (configurationPending) {
    state = 'loading';
  } else {
    state = aggregateState(required, metadataComplete, environmentResults, selections);
  }
  const resolveSubmission = useCallback(
    (
      candidateSelections?: CodeWorkspaceSelection[],
      candidateMode?: CodeEnvironmentMode,
    ):
      | { codeEnvironmentMode?: CodeEnvironmentMode; codeWorkspaces?: CodeWorkspaceSelection[] }
      | undefined => {
      if (recovery != null) return undefined;
      if (!required) return {};
      /**
       * A replacement in flight has no decided answer yet. The server checks for active work
       * before it polls the target workspace, so a turn submitted during that poll starts under
       * the decision being replaced, runs without the workspace its owner just chose, and the
       * replacement still lands afterwards because the stored decision it swaps is unchanged.
       * Nothing reports that to the reader, so the send waits instead.
       */
      if (replacingDecision) return undefined;
      const requestedMode =
        candidateMode ??
        inferredMode ??
        (isCodeWorkspaceSelections(candidateSelections) && candidateSelections.length > 0
          ? 'attached'
          : undefined);
      if (requestedMode === 'without_attached') {
        return supportsEnvironmentDecisions
          ? { codeEnvironmentMode: 'without_attached' }
          : undefined;
      }
      if (requestedMode == null && supportsEnvironmentDecisions) {
        return { codeEnvironmentMode: 'without_attached' };
      }
      const codeWorkspaces = resolveSelections(candidateSelections);
      return codeWorkspaces == null
        ? undefined
        : { codeEnvironmentMode: 'attached', codeWorkspaces };
    },
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
  let transition: CodeWorkspaceTransition | undefined;
  if (
    supportsEnvironmentMoves &&
    locked &&
    selectionMetadataComplete &&
    state !== 'loading' &&
    conversation?.conversationId != null
  ) {
    const configuredEnvironments = statefulCodeSessions?.environments;
    const base = {
      conversationId: conversation.conversationId,
      from: storedSelections ?? [],
      previous: (storedSelections ?? [])
        .filter(({ environmentId }) => !attachedEnvironmentIds.has(environmentId))
        .map(({ environmentId }) => ({
          id: environmentId,
          name: configuredEnvironments?.find(({ id }) => id === environmentId)?.name,
        })),
      retained: environmentResults.flatMap((result) =>
        result.state === 'ready' && result.selected != null ? [result.selected] : [],
      ),
      targets: environmentResults.filter(
        (result) =>
          result.state === 'choose' || (supportsWorkspaceRecovery && result.state === 'missing'),
      ),
    };
    /**
     * A transition replaces the decision whole, so one that named only some of the environments
     * the agents use would seal a decision the next turn refuses: `resolveSelections` resolves
     * every environment or none. An environment that is unreachable, missing its workspace or on
     * an outdated worker is neither carried over nor selectable, so no set of picks covers it, and
     * offering the transition anyway would trade one dead end for a sealed one that needs a second
     * transition to escape. Leaving attached execution stays available, since that is the escape.
     */
    const coversEveryEnvironment =
      base.retained.length + base.targets.length === environmentResults.length;
    if (
      supportsEnvironmentTransitions &&
      state === 'without_attached' &&
      conversation.codeEnvironmentMode === 'without_attached' &&
      base.targets.length > 0 &&
      coversEveryEnvironment
    ) {
      /** Only a decision this chat actually recorded is sealed, so a chat that merely lacks the
       *  fields still chooses in the composer and needs no transition. */
      transition = { ...base, kind: 'attach', detachable: false };
    } else if (
      inferredMode === 'attached' &&
      (storedSelections?.length ?? 0) > 0 &&
      // Dropping the last attached agent makes ordinary chat sendable, but does not remove
      // its persisted seal. Keep the explicit detach action available for that conversation.
      (state === 'choose' || !canSubmit || attachedEnvironments.length === 0)
    ) {
      const move: CodeWorkspaceTransition = {
        ...base,
        kind: 'move',
        detachable: supportsEnvironmentTransitions,
        ...(coversEveryEnvironment ? {} : { retained: [], targets: [] }),
      };
      /** An uncoverable environment leaves nothing to move onto, so the transition is worth
       *  offering only where leaving attached execution is also served. */
      if (move.targets.length > 0 || move.retained.length > 0 || move.detachable) {
        transition = move;
        if (
          state === 'choose' ||
          (supportsWorkspaceRecovery && state === 'missing' && coversEveryEnvironment)
        )
          state = 'relocatable';
      }
    }
  }
  /** A sealed chat hides the control once its decision needs nothing from its owner, except while
   *  it runs without a workspace: that state is worth naming, and attaching one starts here. */
  const visible =
    recovery != null ||
    transition != null ||
    (required &&
      (!locked || !canSubmit || transition != null || inferredMode === 'without_attached'));
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
    transition,
    selections,
    resolveSelections,
    resolveSubmission,
    rememberSelection,
  };
}
