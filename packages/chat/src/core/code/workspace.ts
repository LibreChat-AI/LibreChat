import {
  Tools,
  EModelEndpoint,
  AgentCapabilities,
  isEphemeralAgentId,
  isCodeWorkspaceSelections,
  CODE_ENVIRONMENT_MOVE_VERSION,
  CODE_WORKSPACE_RECOVERY_VERSION,
  resolveCodeEnvironmentSelection,
  CODE_ENVIRONMENT_DECISION_VERSION,
  isCodeWorkspaceCheckoutAvailable,
  CODE_WORKSPACE_INHERITANCE_VERSION,
  CODE_ENVIRONMENT_TRANSITION_VERSION,
} from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TAgentsMap,
  TConversation,
  TStartupConfig,
  CodeEnvironmentMode,
  TPublicCodeEnvironment,
  CodeWorkspaceSelection,
  CodeWorkspaceDescriptor,
  TCodeEnvironmentStatusResponse,
} from 'librechat-data-provider';
import type { ReachableAgents } from './routing';
import {
  findExecutionEnvironment,
  collectReachableAgents,
  getCodeEnvironmentChoiceIds,
  findCodeWorkspaceDiscoveryEnvironment,
  resolveReachableCodeWorkspaceInheritance,
} from './routing';

type CodeSessionsConfig = TConfig['statefulCodeSessions'];

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
  /** Coding agents whose execution requires this machine, including reachable subagents. */
  requiredBy?: Array<{ id: string; name?: string | null }>;
  /** Selectable agents whose binding must be retained when this target is explicitly moved. */
  selectionOwners?: string[];
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
 * - `detach`: the attached workspace is healthy, but its owner wants to continue ordinary chat.
 */
export interface CodeWorkspaceTransition {
  kind: 'move' | 'attach' | 'detach';
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
  /** Leaving attached execution is always explicit, whether its machine is healthy or unavailable. */
  detachable: boolean;
}

export interface CodeWorkspaceSubmission {
  codeEnvironmentMode?: CodeEnvironmentMode;
  codeWorkspaces?: CodeWorkspaceSelection[];
}

/** The fields of one environment status query the derivation reads. */
export interface CodeEnvironmentStatusSnapshot {
  data?: TCodeEnvironmentStatusResponse;
  isLoading: boolean;
  isError: boolean;
}

export interface CodeWorkspaceProtocol {
  supportsEnvironmentDecisions: boolean;
  supportsEnvironmentMoves: boolean;
  supportsEnvironmentTransitions: boolean;
  supportsWorkspaceRecovery: boolean;
  supportsWorkspaceInheritance: boolean;
}

export interface CodeWorkspaceLock {
  isNewChat: boolean;
  locked: boolean;
  undecided: boolean;
}

export interface CodeWorkspaceMetadata {
  complete: boolean;
  defaults: Map<string, Set<string>>;
  preferenceAgentIds: Map<string, Set<string>>;
  requiredBy: Map<string, Array<{ id: string; name?: string | null }>>;
  formerEnvironmentIds: Set<string>;
  environments: TPublicCodeEnvironment[];
}

export interface CodeWorkspaceRequirement {
  configurationPending: boolean;
  metadataComplete: boolean;
  required: boolean;
  selectionMetadataComplete: boolean;
}

export interface CodeWorkspaceEnvironments {
  environmentResults: CodeWorkspaceEnvironmentResult[];
  machineChoiceOwners?: Array<{ agentId: string; environmentIds: string[] }>;
  machineOptionGroups?: string[][];
  machineOptions?: TPublicCodeEnvironment[];
  fixedMachineIds: string[];
}

/** The conversation's agents and the deployment's code-session config. */
export interface CodeWorkspaceAgents {
  conversation: TConversation | null;
  addedConversation?: TConversation | null;
  primaryAgent?: Agent;
  addedAgent?: Agent;
  agentsMap?: TAgentsMap;
  statefulCodeSessions?: CodeSessionsConfig;
}

export interface CodeWorkspaceSelectionInputs {
  required: boolean;
  selectionMetadataComplete: boolean;
  attachedEnvironmentIds: ReadonlySet<string>;
  formerEnvironmentIds: ReadonlySet<string>;
  environmentResults: CodeWorkspaceEnvironmentResult[];
  supportsWorkspaceInheritance: boolean;
  statefulCodeSessions?: CodeSessionsConfig;
  primaryAgent?: Agent;
  addedAgent?: Agent;
  agentsMap?: TAgentsMap;
  reachableAgents: Agent[];
}

export interface CodeWorkspaceSubmissionInputs {
  recoveryPending: boolean;
  required: boolean;
  replacingDecision: boolean;
  inferredMode?: CodeEnvironmentMode;
  supportsEnvironmentDecisions: boolean;
  resolveSelections: (
    selections?: CodeWorkspaceSelection[],
  ) => CodeWorkspaceSelection[] | undefined;
}

export interface CodeWorkspaceStatus {
  state: CodeWorkspaceState;
  transition?: CodeWorkspaceTransition;
  visible: boolean;
}

/** A plain snapshot of everything `useCodeWorkspace` reads from React, queries and the store. */
export interface CodeWorkspaceInputs extends CodeWorkspaceAgents {
  startupConfig?: Partial<TStartupConfig>;
  canRunCode: boolean;
  /** `agentsConfig.capabilities`. */
  capabilities?: readonly string[];
  /** Whether the endpoints or agents config has loaded. */
  configurationLoaded: boolean;
  recoveryPending: boolean;
  replacingDecision: boolean;
  /** Status query results keyed by environment id. */
  statuses: Record<string, CodeEnvironmentStatusSnapshot | undefined>;
  getPreferredWorkspace: (environmentId: string, agentId: string) => string | undefined;
}

export interface CodeWorkspaceDerivation {
  required: boolean;
  supportsEnvironmentDecisions: boolean;
  locked: boolean;
  mode?: CodeEnvironmentMode;
  state: CodeWorkspaceState;
  canSubmit: boolean;
  visible: boolean;
  environments: CodeWorkspaceEnvironmentResult[];
  machineOptions?: TPublicCodeEnvironment[];
  machineOptionGroups?: string[][];
  machineChoiceOwners?: Array<{ agentId: string; environmentIds: string[] }>;
  fixedMachineIds: string[];
  transition?: CodeWorkspaceTransition;
  selections?: CodeWorkspaceSelection[];
  /** Root agents whose remembered workspace a selection on each environment updates. */
  preferenceAgentIds: Map<string, Set<string>>;
  resolveSelections: (
    selections?: CodeWorkspaceSelection[],
  ) => CodeWorkspaceSelection[] | undefined;
  resolveSubmission: (
    selections?: CodeWorkspaceSelection[],
    mode?: CodeEnvironmentMode,
  ) => CodeWorkspaceSubmission | undefined;
}

export function aggregateState(
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

export function resolveEnvironmentSelection({
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
    return { ...stored, environmentId: environment.id };
  }
  if (!hasStoredSelections && workspaces.length === 1) {
    return { environmentId: environment.id, workspaceId: workspaces[0].id };
  }
  return undefined;
}

export function resolveCodeWorkspaceProtocol(
  startupConfig?: Partial<TStartupConfig>,
): CodeWorkspaceProtocol {
  const supportsEnvironmentDecisions =
    startupConfig?.codeEnvironmentDecisionVersion === CODE_ENVIRONMENT_DECISION_VERSION;
  const supportsEnvironmentMoves =
    startupConfig?.codeEnvironmentMoveVersion === CODE_ENVIRONMENT_MOVE_VERSION;
  return {
    supportsEnvironmentDecisions,
    supportsEnvironmentMoves,
    /** Attaching an environment and leaving attached execution are advertised beside the move
     *  rather than as a higher move version, so a deployment mid-rollout keeps serving the move to
     *  a client that predates them, and a client that has them never offers a replica an attach it
     *  refuses as `locked` or an empty target set it calls `invalid`. */
    supportsEnvironmentTransitions:
      supportsEnvironmentDecisions &&
      startupConfig?.codeEnvironmentTransitionVersion === CODE_ENVIRONMENT_TRANSITION_VERSION,
    supportsWorkspaceRecovery:
      supportsEnvironmentMoves &&
      startupConfig?.codeWorkspaceRecoveryVersion === CODE_WORKSPACE_RECOVERY_VERSION,
    /** An API that predates inheritance still routes each subagent to its own machine, so only an
     *  advertising one lets the composer drop that machine's workspace. */
    supportsWorkspaceInheritance:
      startupConfig?.codeWorkspaceInheritanceVersion === CODE_WORKSPACE_INHERITANCE_VERSION,
  };
}

export function resolveCodeWorkspaceLock(
  conversation: TConversation | null,
  supportsEnvironmentDecisions: boolean,
): CodeWorkspaceLock {
  const storedSelections = conversation?.codeWorkspaces;
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
  return { isNewChat, locked, undecided };
}

export function resolveCodeWorkspaceMetadata({
  agentId,
  addedAgentId,
  primaryAgent,
  addedAgent,
  agentsMap,
  selections,
  environments,
  allowEnvironmentSelection,
  reachableAgents,
  supportsWorkspaceInheritance,
  undecided,
}: {
  /** The root agent ids of the conversation and its added conversation. */
  agentId?: string | null;
  addedAgentId?: string | null;
  primaryAgent?: Agent;
  addedAgent?: Agent;
  agentsMap?: TAgentsMap;
  /** The conversation's stored workspace selections. */
  selections?: CodeWorkspaceSelection[];
  environments?: TPublicCodeEnvironment[];
  allowEnvironmentSelection?: boolean;
  reachableAgents: Agent[];
  supportsWorkspaceInheritance: boolean;
  undecided: boolean;
}): CodeWorkspaceMetadata {
  const unique = new Map<string, TPublicCodeEnvironment>();
  const defaults = new Map<string, Set<string>>();
  const preferenceAgentIds = new Map<string, Set<string>>();
  const requiredBy = new Map<string, Array<{ id: string; name?: string | null }>>();
  const inheritance = supportsWorkspaceInheritance
    ? resolveReachableCodeWorkspaceInheritance(
        [primaryAgent, addedAgent],
        agentsMap,
        environments,
        allowEnvironmentSelection,
        selections,
        undecided,
      )
    : new Map<string, string>();
  /** A decision may still select the machine an inheriting subagent ran on before it followed
   *  its parent. No agent runs there now, so that selection is echoed as sealed but neither
   *  required, nor checked for readiness, nor read as a foreign choice that needs a move. */
  const formerEnvironmentIds = new Set<string>();
  const retainInheritedFromSelection = (agent: Agent) => {
    if (!inheritance.has(agent.id)) return;
    const own = resolveCodeEnvironmentSelection({
      agentId: agent.id,
      environmentId:
        agent.code_environment_id ?? environments?.find(({ default: isDefault }) => isDefault)?.id,
      environmentIds: agent.code_environment_ids,
      allowSelection:
        getCodeEnvironmentChoiceIds(agent, environments, allowEnvironmentSelection) != null,
      selections: selections,
    });
    const ownId = own.valid ? own.environmentId : undefined;
    if (ownId && selections?.some(({ environmentId }) => environmentId === ownId)) {
      formerEnvironmentIds.add(ownId);
    }
  };
  let complete = true;
  for (const agent of reachableAgents) {
    if (agent.stateful_code_sessions !== true || !agent.tools?.includes(Tools.execute_code)) {
      continue;
    }
    const environment = findCodeWorkspaceDiscoveryEnvironment(
      agent,
      environments,
      allowEnvironmentSelection,
      selections,
      inheritance.get(agent.id),
    );
    /** Discovery must remain available while a graph draft is partial or its sealed
     * route needs recovery. Only final submission resolves the entire graph strictly. */
    if (environment == null && agent.code_environment_id) {
      complete = false;
    }
    retainInheritedFromSelection(agent);
    if (environment?.type !== 'attached') continue;
    unique.set(environment.id, environment);
    const owners = requiredBy.get(environment.id) ?? [];
    owners.push({ id: agent.id, name: agent.name });
    requiredBy.set(environment.id, owners);
    if (agent.code_environment_id === environment.id && agent.code_workspace_id) {
      const choices = defaults.get(environment.id) ?? new Set<string>();
      choices.add(agent.code_workspace_id);
      defaults.set(environment.id, choices);
    }
  }

  const roots: Array<[Agent | undefined, string | null | undefined]> = [
    [primaryAgent, agentId],
    [addedAgent, addedAgentId],
  ];
  for (const [rootAgent, rootAgentId] of roots) {
    if (!rootAgent || !rootAgentId) continue;
    const rootReachable = collectReachableAgents([rootAgent], agentsMap, [rootAgentId]);
    for (const agent of rootReachable.agents) {
      if (agent.stateful_code_sessions !== true || !agent.tools?.includes(Tools.execute_code)) {
        continue;
      }
      const environment = findCodeWorkspaceDiscoveryEnvironment(
        agent,
        environments,
        allowEnvironmentSelection,
        selections,
        inheritance.get(agent.id),
      );
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
    requiredBy,
    formerEnvironmentIds: new Set([...formerEnvironmentIds].filter((id) => !unique.has(id))),
    environments: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function resolveCodeWorkspaceRequirement({
  conversation,
  addedConversation,
  canRunCode,
  capabilities,
  configurationLoaded,
  reachableComplete,
  metadata,
}: {
  conversation: TConversation | null;
  addedConversation?: TConversation | null;
  canRunCode: boolean;
  capabilities?: readonly string[];
  configurationLoaded: boolean;
  reachableComplete: boolean;
  metadata: CodeWorkspaceMetadata;
}): CodeWorkspaceRequirement {
  const codeEnabled =
    canRunCode &&
    capabilities?.includes(AgentCapabilities.execute_code) === true &&
    capabilities.includes(AgentCapabilities.stateful_code_sessions);
  const isAgentsConversation =
    (conversation?.endpointType ?? conversation?.endpoint) === EModelEndpoint.agents;
  const expectedRoot = conversation?.agent_id != null || addedConversation?.agent_id != null;
  const expectedSavedAgent = [conversation?.agent_id, addedConversation?.agent_id].some(
    (agentId) => agentId != null && !isEphemeralAgentId(agentId),
  );
  const configurationPending =
    canRunCode && isAgentsConversation && expectedSavedAgent && !configurationLoaded;
  const metadataComplete =
    !isAgentsConversation || !expectedRoot || (reachableComplete && metadata.complete);
  const required =
    configurationPending ||
    (codeEnabled &&
      isAgentsConversation &&
      (!metadataComplete || metadata.environments.length > 0));
  return {
    configurationPending,
    metadataComplete,
    required,
    selectionMetadataComplete: !configurationPending && metadataComplete,
  };
}

/** `statuses` is aligned by index with `metadata.environments`, as the status queries are. */
export function resolveCodeWorkspaceEnvironments({
  conversation,
  metadata,
  statuses,
  attachedEnvironmentIds,
  undecided,
  locked,
  required,
  supportsEnvironmentDecisions,
  statefulCodeSessions,
  reachableAgents,
  getPreferredWorkspace,
}: {
  conversation: TConversation | null;
  metadata: CodeWorkspaceMetadata;
  statuses: ReadonlyArray<CodeEnvironmentStatusSnapshot | undefined>;
  attachedEnvironmentIds: ReadonlySet<string>;
  undecided: boolean;
  locked: boolean;
  required: boolean;
  supportsEnvironmentDecisions: boolean;
  statefulCodeSessions?: CodeSessionsConfig;
  reachableAgents: Agent[];
  getPreferredWorkspace: (environmentId: string, agentId: string) => string | undefined;
}): CodeWorkspaceEnvironments {
  const storedSelections = conversation?.codeWorkspaces;
  const { formerEnvironmentIds } = metadata;
  const hasForeignStoredSelection = storedSelections?.some(
    ({ environmentId }) =>
      !attachedEnvironmentIds.has(environmentId) && !formerEnvironmentIds.has(environmentId),
  );
  const machineChoiceOwners =
    required &&
    supportsEnvironmentDecisions &&
    statefulCodeSessions?.allowEnvironmentSelection === true
      ? reachableAgents.flatMap((agent) => {
          if (agent.stateful_code_sessions !== true || !agent.tools?.includes(Tools.execute_code)) {
            return [];
          }
          const ids = getCodeEnvironmentChoiceIds(agent, statefulCodeSessions.environments, true);
          return ids == null ? [] : [{ agentId: agent.id, environmentIds: ids }];
        })
      : undefined;
  const machineOptionGroups = undecided
    ? machineChoiceOwners?.map(({ environmentIds }) => environmentIds)
    : undefined;
  const machineOptions = machineOptionGroups?.length
    ? statefulCodeSessions?.environments?.filter(
        ({ id, type }) =>
          type === 'attached' && machineOptionGroups.some((ids) => ids.includes(id)),
      )
    : undefined;
  const fixedMachineIds = reachableAgents.flatMap((agent) => {
    if (agent.stateful_code_sessions !== true || !agent.tools?.includes(Tools.execute_code))
      return [];
    if (
      getCodeEnvironmentChoiceIds(
        agent,
        statefulCodeSessions?.environments,
        statefulCodeSessions?.allowEnvironmentSelection,
      ) != null
    )
      return [];
    const environment = findExecutionEnvironment(agent, statefulCodeSessions?.environments);
    return environment?.type === 'attached' ? [environment.id] : [];
  });
  const environmentResults = metadata.environments.map(
    (environment, index): CodeWorkspaceEnvironmentResult => {
      const status = statuses[index];
      const workspaces =
        status?.data?.status === 'ready' && Array.isArray(status.data.workspaces)
          ? status.data.workspaces
          : [];
      let stored = storedSelections?.find(({ environmentId }) => environmentId === environment.id);
      let conflictingDefaults = false;
      if (stored == null && undecided && !hasForeignStoredSelection) {
        const defaults = metadata.defaults.get(environment.id) ?? new Set<string>();
        let preferred: string | undefined;
        if (defaults.size === 1) preferred = [...defaults][0];
        else if (defaults.size === 0) {
          preferred = [...(metadata.preferenceAgentIds.get(environment.id) ?? [])]
            .map((agentId) => getPreferredWorkspace(environment.id, agentId))
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
      else if (selected != null) {
        state = isCodeWorkspaceCheckoutAvailable(
          selected,
          workspaces.find(({ id }) => id === selected.workspaceId),
          environment.configSchema?.workspaces?.allowCheckoutSelection === true,
        )
          ? 'ready'
          : 'unsupported';
      } else if (stored != null) state = 'missing';
      else if (workspaces.length === 0) state = 'unavailable';
      return {
        environment,
        state,
        workspaces,
        selected,
        requiredBy: metadata.requiredBy.get(environment.id),
        selectionOwners: metadata.requiredBy
          .get(environment.id)
          ?.filter(({ id }) => machineChoiceOwners?.some(({ agentId }) => agentId === id))
          .map(({ id }) => id),
      };
    },
  );
  return {
    environmentResults,
    machineChoiceOwners,
    machineOptionGroups,
    machineOptions,
    fixedMachineIds,
  };
}

export function resolveCodeWorkspaceSelections(
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
    reachableAgents,
  }: CodeWorkspaceSelectionInputs,
  selections?: CodeWorkspaceSelection[],
): CodeWorkspaceSelection[] | undefined {
  if (!required || !selectionMetadataComplete || !isCodeWorkspaceSelections(selections ?? [])) {
    return undefined;
  }
  /** Never silently discard a machine the user picked. A sealed choice needs a transition;
   * a draft choice not used by the graph must be corrected before it can execute elsewhere. */
  if (
    selections?.some(
      ({ environmentId }) =>
        !attachedEnvironmentIds.has(environmentId) && !formerEnvironmentIds.has(environmentId),
    )
  ) {
    return undefined;
  }
  const resolved: CodeWorkspaceSelection[] =
    selections?.filter(({ environmentId }) => formerEnvironmentIds.has(environmentId)) ?? [];
  for (const result of environmentResults) {
    const requested = selections?.find(
      ({ environmentId }) => environmentId === result.environment.id,
    );
    if (
      requested != null &&
      result.state !== 'loading' &&
      result.state !== 'unavailable' &&
      result.state !== 'unsupported' &&
      result.workspaces.some(
        (descriptor) =>
          descriptor.id === requested.workspaceId &&
          isCodeWorkspaceCheckoutAvailable(
            requested,
            descriptor,
            result.environment.configSchema?.workspaces?.allowCheckoutSelection === true,
          ),
      )
    ) {
      resolved.push({
        environmentId: result.environment.id,
        workspaceId: requested.workspaceId,
        ...(requested.checkout == null ? {} : { checkout: requested.checkout }),
        ...(requested.agentIds == null ? {} : { agentIds: requested.agentIds }),
      });
      continue;
    }
    if (requested == null && result.selected != null && result.state === 'ready') {
      resolved.push(result.selected);
      continue;
    }
    return undefined;
  }
  const inheritance =
    supportsWorkspaceInheritance && statefulCodeSessions?.allowEnvironmentSelection === true
      ? resolveReachableCodeWorkspaceInheritance(
          [primaryAgent, addedAgent],
          agentsMap,
          statefulCodeSessions.environments,
          true,
          resolved,
        )
      : undefined;
  if (
    statefulCodeSessions?.allowEnvironmentSelection === true &&
    reachableAgents.some(
      (agent) =>
        agent.stateful_code_sessions === true &&
        agent.tools?.includes(Tools.execute_code) &&
        getCodeEnvironmentChoiceIds(agent, statefulCodeSessions.environments, true) != null &&
        !resolveCodeEnvironmentSelection({
          agentId: agent.id,
          environmentId:
            agent.code_environment_id ??
            statefulCodeSessions.environments?.find(({ default: isDefault }) => isDefault)?.id,
          environmentIds: agent.code_environment_ids,
          allowSelection: true,
          selections: resolved,
          inheritedEnvironmentId: inheritance?.get(agent.id),
        }).valid,
    )
  )
    return undefined;
  return resolved.sort((a, b) => a.environmentId.localeCompare(b.environmentId));
}

export function inferCodeEnvironmentMode({
  conversation,
  isNewChat,
  required,
  selections,
  supportsEnvironmentDecisions,
}: {
  conversation: TConversation | null;
  isNewChat: boolean;
  required: boolean;
  selections?: CodeWorkspaceSelection[];
  supportsEnvironmentDecisions: boolean;
}): CodeEnvironmentMode | undefined {
  const inferredMode = conversation?.codeEnvironmentMode;
  if (inferredMode != null) return inferredMode;
  if (conversation?.codeWorkspaces != null) return 'attached';
  // Suggestions are not consent. Existing non-coding chats start without workspace access;
  // only an explicit selection in the composer may attach their first coding turn.
  if (!isNewChat && supportsEnvironmentDecisions) return 'without_attached';
  if (selections != null) return 'attached';
  if (required && supportsEnvironmentDecisions) return 'without_attached';
  return undefined;
}

export function resolveCodeWorkspaceSubmission(
  {
    recoveryPending,
    required,
    replacingDecision,
    inferredMode,
    supportsEnvironmentDecisions,
    resolveSelections,
  }: CodeWorkspaceSubmissionInputs,
  candidateSelections?: CodeWorkspaceSelection[],
  candidateMode?: CodeEnvironmentMode,
): CodeWorkspaceSubmission | undefined {
  if (recoveryPending) return undefined;
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
    return supportsEnvironmentDecisions ? { codeEnvironmentMode: 'without_attached' } : undefined;
  }
  if (requestedMode == null && supportsEnvironmentDecisions) {
    return { codeEnvironmentMode: 'without_attached' };
  }
  const codeWorkspaces = resolveSelections(candidateSelections);
  return codeWorkspaces == null ? undefined : { codeEnvironmentMode: 'attached', codeWorkspaces };
}

export function resolveCodeWorkspaceStatus({
  conversation,
  protocol,
  locked,
  requirement,
  environmentResults,
  attachedEnvironmentIds,
  selections,
  inferredMode,
  canSubmit,
  recoveryPending,
  statefulCodeSessions,
}: {
  conversation: TConversation | null;
  protocol: CodeWorkspaceProtocol;
  locked: boolean;
  requirement: CodeWorkspaceRequirement;
  environmentResults: CodeWorkspaceEnvironmentResult[];
  attachedEnvironmentIds: ReadonlySet<string>;
  selections?: CodeWorkspaceSelection[];
  inferredMode?: CodeEnvironmentMode;
  canSubmit: boolean;
  recoveryPending: boolean;
  statefulCodeSessions?: CodeSessionsConfig;
}): CodeWorkspaceStatus {
  const { required, configurationPending, metadataComplete, selectionMetadataComplete } =
    requirement;
  const { supportsEnvironmentMoves, supportsEnvironmentTransitions, supportsWorkspaceRecovery } =
    protocol;
  const storedSelections = conversation?.codeWorkspaces;
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
      (state === 'choose' || !canSubmit || environmentResults.length === 0)
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
    } else if (
      supportsEnvironmentTransitions &&
      inferredMode === 'attached' &&
      (storedSelections?.length ?? 0) > 0 &&
      state === 'ready'
    ) {
      transition = { ...base, kind: 'detach', detachable: true };
    }
  }
  /** Keep explicit transitions visible without offering mutable picks for a sealed decision. */
  const visible =
    recoveryPending ||
    transition != null ||
    (required &&
      (!locked || !canSubmit || transition != null || inferredMode === 'without_attached'));
  return { state, transition, visible };
}

/**
 * The whole workspace derivation from a plain snapshot of `useCodeWorkspace`'s inputs, in the
 * order the hook computes it, so a send's code decision can be resolved outside React.
 */
export function resolveCodeWorkspace(inputs: CodeWorkspaceInputs): CodeWorkspaceDerivation {
  const { conversation, addedConversation, primaryAgent, addedAgent, agentsMap } = inputs;
  const { statefulCodeSessions, recoveryPending } = inputs;
  const protocol = resolveCodeWorkspaceProtocol(inputs.startupConfig);
  const { supportsEnvironmentDecisions, supportsWorkspaceInheritance } = protocol;
  const reachable: ReachableAgents = collectReachableAgents([primaryAgent, addedAgent], agentsMap, [
    conversation?.agent_id,
    addedConversation?.agent_id,
  ]);
  const { isNewChat, locked, undecided } = resolveCodeWorkspaceLock(
    conversation,
    supportsEnvironmentDecisions,
  );
  const metadata = resolveCodeWorkspaceMetadata({
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
  });
  const requirement = resolveCodeWorkspaceRequirement({
    ...inputs,
    reachableComplete: reachable.complete,
    metadata,
  });
  const { required, selectionMetadataComplete } = requirement;
  const attachedEnvironmentIds = new Set(metadata.environments.map(({ id }) => id));
  const environments = resolveCodeWorkspaceEnvironments({
    ...inputs,
    metadata,
    statuses: metadata.environments.map(({ id }) => inputs.statuses[id]),
    attachedEnvironmentIds,
    undecided,
    locked,
    required,
    supportsEnvironmentDecisions,
    reachableAgents: reachable.agents,
  });
  const resolveSelections = (selections?: CodeWorkspaceSelection[]) =>
    resolveCodeWorkspaceSelections(
      {
        ...inputs,
        required,
        selectionMetadataComplete,
        attachedEnvironmentIds,
        formerEnvironmentIds: metadata.formerEnvironmentIds,
        environmentResults: environments.environmentResults,
        supportsWorkspaceInheritance,
        reachableAgents: reachable.agents,
      },
      selections,
    );
  const selections = resolveSelections(conversation?.codeWorkspaces);
  const inferredMode = inferCodeEnvironmentMode({
    conversation,
    isNewChat,
    required,
    selections,
    supportsEnvironmentDecisions,
  });
  const resolveSubmission = (
    candidateSelections?: CodeWorkspaceSelection[],
    candidateMode?: CodeEnvironmentMode,
  ) =>
    resolveCodeWorkspaceSubmission(
      {
        recoveryPending,
        required,
        replacingDecision: inputs.replacingDecision,
        inferredMode,
        supportsEnvironmentDecisions,
        resolveSelections,
      },
      candidateSelections,
      candidateMode,
    );
  const canSubmit =
    resolveSubmission(conversation?.codeWorkspaces, conversation?.codeEnvironmentMode) != null;
  const status = resolveCodeWorkspaceStatus({
    conversation,
    protocol,
    locked,
    requirement,
    environmentResults: environments.environmentResults,
    attachedEnvironmentIds,
    selections,
    inferredMode,
    canSubmit,
    recoveryPending,
    statefulCodeSessions,
  });
  return {
    required,
    supportsEnvironmentDecisions,
    locked,
    mode: inferredMode,
    state: status.state,
    canSubmit,
    visible: status.visible,
    environments: environments.environmentResults,
    machineOptions: environments.machineOptions,
    machineOptionGroups: environments.machineOptionGroups,
    machineChoiceOwners: environments.machineChoiceOwners,
    fixedMachineIds: environments.fixedMachineIds,
    transition: status.transition,
    selections,
    preferenceAgentIds: metadata.preferenceAgentIds,
    resolveSelections,
    resolveSubmission,
  };
}
