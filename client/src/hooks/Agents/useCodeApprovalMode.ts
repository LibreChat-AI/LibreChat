import { useMemo } from 'react';
import {
  EModelEndpoint,
  Tools,
  resolveSubagents,
  isEphemeralAgentId,
  getAllowedCodeApprovalModes,
  CODE_APPROVAL_MODES,
  resolveCodeEnvironmentSelection,
  resolveCodeWorkspaceInheritance,
} from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TAgentsMap,
  TConversation,
  CodeApprovalMode,
  CodeEnvironmentMode,
  TPublicCodeEnvironment,
  CodeWorkspaceSelection,
  CodeWorkspaceRoutingAgent,
} from 'librechat-data-provider';
import { useCodeApprovalModePreference } from './codeApprovalPreference';
import useAgentToolPermissions from './useAgentToolPermissions';
import useGetAgentsConfig from './useGetAgentsConfig';
import { useAgentsMapContext } from '~/Providers';

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
      collectReachableAgents(
        [primaryAgent, addedAgent],
        agentsMap,
        [conversation?.agent_id, addedConversation?.agent_id],
        agentsConfig?.capabilities,
      ),
    [
      addedAgent,
      agentsMap,
      primaryAgent,
      conversation?.agent_id,
      addedConversation?.agent_id,
      agentsConfig?.capabilities,
    ],
  );
  /** Approval modes intersect every machine an agent could run on, including a subagent's own
   *  default it may no longer use once it follows its parent: offering fewer modes is safe. */
  const codeEnvironments = useMemo(
    () =>
      reachable.agents
        .filter(
          (agent) =>
            agent.stateful_code_sessions === true && agent.tools?.includes(Tools.execute_code),
        )
        .map((agent) =>
          findExecutionEnvironment(
            agent,
            environments,
            statefulCodeSessions?.allowEnvironmentSelection,
            conversation?.codeWorkspaces,
          ),
        ),
    [
      environments,
      reachable,
      statefulCodeSessions?.allowEnvironmentSelection,
      conversation?.codeWorkspaces,
    ],
  );
  /** A turn sent without attached workspaces opts every agent out of its attached machine on the
   *  server, so no attached mode applies to it, whatever the agents' defaults are. */
  const withoutAttached =
    (codeEnvironmentMode ?? conversation?.codeEnvironmentMode) === 'without_attached';
  const attachedEnvironments = useMemo(
    () =>
      withoutAttached
        ? []
        : codeEnvironments.filter(
            (environment): environment is TPublicCodeEnvironment =>
              environment?.type === 'attached',
          ),
    [codeEnvironments, withoutAttached],
  );
  const supported =
    (conversation?.endpointType ?? conversation?.endpoint) === EModelEndpoint.agents &&
    statefulCodeSessions?.approvalsEnabled === true;
  const endpointModes = statefulCodeSessions?.approvalModes;
  const available =
    supported && endpointModes?.includes('ask') === true && attachedEnvironments.length > 0;
  const modes = useMemo(() => {
    if (!available) return [];
    const allowed = new Set<CodeApprovalMode>(endpointModes?.includes('ask') ? ['ask'] : []);
    let fullAccessAllowed =
      endpointModes?.includes('fullAccess') === true &&
      reachable.complete &&
      codeEnvironments.every((environment) => environment != null);
    for (const environment of attachedEnvironments) {
      const environmentModes = getAllowedCodeApprovalModes({
        environment: 'attached',
        allowedModes: CODE_APPROVAL_MODES,
        configSchema: environment.configSchema,
        settings: environment.settings,
      });
      if (endpointModes?.includes('acceptEdits') && environmentModes.includes('acceptEdits')) {
        allowed.add('acceptEdits');
      }
      fullAccessAllowed &&= environmentModes.includes('fullAccess');
    }
    if (fullAccessAllowed) allowed.add('fullAccess');
    return CODE_APPROVAL_MODES.filter((mode) => allowed.has(mode));
  }, [attachedEnvironments, available, codeEnvironments, endpointModes, reachable.complete]);
  /** A conversation that carries no mode of its own opens on the reader's last
   *  pick in this browser, so choosing `acceptEdits` or `fullAccess` survives a
   *  new chat and a reload instead of being re-picked every time. The remembered
   *  value is a preference, not a grant: it passes the same policy gate below as
   *  a stored one, so a mode current policy no longer allows falls back to `ask`. */
  const requested = conversation?.codeApprovalMode ?? preference.get() ?? 'ask';
  /**
   * Fail closed while agent/environment metadata is incomplete. An affirmative
   * server capability means `ask` is safe to submit even before an attached
   * environment is discoverable; a turn with no attached target accepts it and
   * keeps the conversation's stored mode. Never preserve `acceptEdits` until
   * current policy authorizes it.
   */
  let selected: CodeApprovalMode | undefined;
  if (supported) {
    selected = available && modes.includes(requested) ? requested : 'ask';
  }

  return { available, modes, selected };
}

/** The same per-agent eligibility gate is used for routing and draft discovery. Missing
 * explicit defaults may recover to an allowed machine; managed defaults never opt in. */
export function getCodeEnvironmentChoiceIds(
  agent: Agent,
  environments?: TPublicCodeEnvironment[],
  allowEnvironmentSelection?: boolean,
): string[] | undefined {
  const defaultEnvironment = agent.code_environment_id
    ? environments?.find((candidate) => candidate.id === agent.code_environment_id)
    : environments?.find((candidate) => candidate.default === true);
  if (
    allowEnvironmentSelection !== true ||
    !agent.code_environment_ids?.length ||
    !(
      defaultEnvironment?.type === 'attached' ||
      (defaultEnvironment == null && Boolean(agent.code_environment_id))
    )
  ) {
    return undefined;
  }
  return [
    ...new Set([
      agent.code_environment_id ?? defaultEnvironment?.id,
      ...agent.code_environment_ids,
    ]),
  ].filter((id): id is string => id != null);
}

export function findExecutionEnvironment(
  agent: Agent,
  environments?: TPublicCodeEnvironment[],
  allowEnvironmentSelection?: boolean,
  selections?: CodeWorkspaceSelection[],
  inheritedEnvironmentId?: string,
): TPublicCodeEnvironment | undefined {
  const defaultEnvironment = agent.code_environment_id
    ? environments?.find((candidate) => candidate.id === agent.code_environment_id)
    : environments?.find((candidate) => candidate.default === true);
  const allowSelection =
    getCodeEnvironmentChoiceIds(agent, environments, allowEnvironmentSelection) != null;
  const selection = resolveCodeEnvironmentSelection({
    agentId: agent.id,
    environmentId: agent.code_environment_id ?? defaultEnvironment?.id,
    environmentIds: agent.code_environment_ids,
    allowSelection,
    /** A draft's machine for its parent is selected on submission, before the reader picks it. */
    selections:
      inheritedEnvironmentId != null &&
      !selections?.some(({ environmentId }) => environmentId === inheritedEnvironmentId)
        ? [...(selections ?? []), { environmentId: inheritedEnvironmentId, workspaceId: 'draft' }]
        : selections,
    inheritedEnvironmentId,
  });
  if (!selection.valid) return undefined;
  const resolved = selection.environmentId
    ? environments?.find((candidate) => candidate.id === selection.environmentId)
    : defaultEnvironment;
  return allowSelection && resolved?.type !== 'attached' ? undefined : resolved;
}

/** Discovery can expose an authorized recovery target after a default disappears. This never
 * admits execution: a saved chat must explicitly replace its sealed decision before using it. */
export function findCodeWorkspaceDiscoveryEnvironment(
  agent: Agent,
  environments?: TPublicCodeEnvironment[],
  allowEnvironmentSelection?: boolean,
  selections?: CodeWorkspaceSelection[],
  inheritedEnvironmentId?: string,
): TPublicCodeEnvironment | undefined {
  return (
    findExecutionEnvironment(
      agent,
      environments,
      allowEnvironmentSelection,
      selections,
      inheritedEnvironmentId,
    ) ??
    findExecutionEnvironment(agent, environments) ??
    environments?.find(
      ({ id, type }) =>
        type === 'attached' &&
        getCodeEnvironmentChoiceIds(agent, environments, allowEnvironmentSelection)?.includes(id),
    )
  );
}

export function collectReachableAgents(
  roots: Array<Agent | undefined>,
  agentsMap: TAgentsMap | undefined,
  expectedRootIds: Array<string | undefined | null>,
  capabilities?: readonly string[],
): { agents: Agent[]; complete: boolean } {
  const { agents, complete } = collectAgentTraversal(
    roots,
    agentsMap,
    expectedRootIds,
    capabilities,
  );
  return { agents, complete };
}

/** Graph members execute without nested orchestration. A separate ordinary path upgrades them. */
function collectAgentTraversal(
  roots: Array<Agent | undefined>,
  agentsMap: TAgentsMap | undefined,
  expectedRootIds: Array<string | undefined | null>,
  capabilities?: readonly string[],
): { agents: Agent[]; complete: boolean; spawns: Map<string, string[]>; rootIds: Set<string> } {
  const rootMap = new Map(
    roots.filter((agent): agent is Agent => agent != null).map((agent) => [agent.id, agent]),
  );
  const pending: Array<{ agent: Agent; expand: boolean }> = [];
  const requested = new Map<string, boolean>();
  const expanded = new Set<string>();
  const spawns = new Map<string, string[]>();
  const seen = new Set<string>();
  const rootIds = new Set(rootMap.keys());
  const agents: Agent[] = [];
  let complete = expectedRootIds.every(
    (id) => isEphemeralAgentId(id) || (id != null && rootMap.has(id)),
  );
  const add = (id: string, expand: boolean) => {
    if (requested.has(id) && (!expand || requested.get(id))) return;
    requested.set(id, expand);
    const agent = rootMap.get(id) ?? agentsMap?.[id];
    if (agent != null) pending.push({ agent, expand });
    else complete = false;
  };
  const rootAgents = [...rootMap.values()];
  for (let index = 0; index < rootAgents.length; index++) {
    const root = rootAgents[index];
    for (const id of getLinkedAgentIds(root)) {
      if (!id || rootIds.has(id)) continue;
      rootIds.add(id);
      const linked = rootMap.get(id) ?? agentsMap?.[id];
      if (linked) rootAgents.push(linked);
      else complete = false;
    }
  }
  for (const id of roots[0]?.agent_ids ?? []) {
    if (id) rootIds.add(id);
  }
  for (const id of rootIds) add(id, true);
  for (let index = 0; index < pending.length; index++) {
    const { agent, expand } = pending[index];
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      agents.push(agent);
    }
    if (!expand || expanded.has(agent.id)) continue;
    expanded.add(agent.id);
    const subagents = resolveSubagents(agent.subagents, capabilities);
    const ids = new Set<string>();
    for (const id of subagents?.agent_ids ?? []) {
      if (!id || id === agent.id) continue;
      ids.add(id);
      add(id, true);
    }
    for (const graph of subagents?.graphs ?? []) {
      for (const id of graph.agent_ids) {
        if (!id || id === agent.id) continue;
        ids.add(id);
        add(id, false);
      }
    }
    spawns.set(agent.id, [...ids]);
  }
  return { agents, complete, spawns, rootIds };
}

function getLinkedAgentIds(agent: Agent): string[] {
  const edgeIds = agent.edges?.flatMap((edge) => [
    ...(Array.isArray(edge.from) ? edge.from : [edge.from]),
    ...(Array.isArray(edge.to) ? edge.to : [edge.to]),
  ]);
  return edgeIds ?? [];
}

function toCodeWorkspaceRoutingAgent(
  agent: Agent,
  environments: TPublicCodeEnvironment[] | undefined,
  allowEnvironmentSelection: boolean | undefined,
  subagentIds?: readonly string[],
): CodeWorkspaceRoutingAgent {
  return {
    id: agent.id,
    routesCode:
      agent.stateful_code_sessions === true && agent.tools?.includes(Tools.execute_code) === true,
    environmentId:
      agent.code_environment_id ?? environments?.find(({ default: isDefault }) => isDefault)?.id,
    environmentIds: agent.code_environment_ids,
    allowSelection:
      getCodeEnvironmentChoiceIds(agent, environments, allowEnvironmentSelection) != null,
    subagentIds,
  };
}

/**
 * Mirrors the server's subagent machine inheritance for the composer. Conversation agents and
 * the agents they hand off to are roots; explicit subagents follow their parent's machine when
 * `resolveCodeWorkspaceInheritance` allows it, so the composer neither asks for a workspace a
 * subagent will not use nor rejects a graph the server will route.
 */
export function resolveReachableCodeWorkspaceInheritance(
  roots: Array<Agent | undefined>,
  agentsMap: TAgentsMap | undefined,
  environments: TPublicCodeEnvironment[] | undefined,
  allowEnvironmentSelection: boolean | undefined,
  selections: CodeWorkspaceSelection[] | undefined,
  /** The chat has not decided yet, so the submission will also select each root's machine. */
  draft = false,
  capabilities?: readonly string[],
): Map<string, string> {
  if (!draft && !selections?.length) return new Map();
  const traversal = collectAgentTraversal(roots, agentsMap, [], capabilities);
  const lookup = new Map(traversal.agents.map((agent) => [agent.id, agent]));
  const agents = new Map(
    traversal.agents.map((agent) => [
      agent.id,
      toCodeWorkspaceRoutingAgent(
        agent,
        environments,
        allowEnvironmentSelection,
        traversal.spawns.get(agent.id),
      ),
    ]),
  );
  const rootIds = [...traversal.rootIds].filter((id) => agents.has(id));
  /** A sendable draft selects a workspace on every machine a root runs on, so a subagent can follow
   *  its parent there before the reader picks one; requiring its own default would ask for a
   *  workspace the submitted decision never uses. */
  const prospective = draft
    ? rootIds.reduce<CodeWorkspaceSelection[]>((planned, id) => {
        const root = lookup.get(id);
        const environment =
          root != null && agents.get(id)?.routesCode === true
            ? findExecutionEnvironment(root, environments, allowEnvironmentSelection, selections)
            : undefined;
        return environment?.type === 'attached' &&
          !planned.some(({ environmentId }) => environmentId === environment.id)
          ? [...planned, { environmentId: environment.id, workspaceId: 'draft' }]
          : planned;
      }, selections ?? [])
    : selections;
  return resolveCodeWorkspaceInheritance({
    selections: prospective,
    rootIds,
    agents,
    isAttachedEnvironment: (id) =>
      environments?.some(
        (environment) => environment.id === id && environment.type === 'attached',
      ) === true,
  });
}
