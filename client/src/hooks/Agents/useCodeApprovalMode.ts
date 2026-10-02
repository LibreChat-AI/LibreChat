import { useMemo } from 'react';
import {
  EModelEndpoint,
  Tools,
  isEphemeralAgentId,
  getAllowedCodeApprovalModes,
  CODE_APPROVAL_MODES,
  resolveCodeEnvironmentSelection,
} from 'librechat-data-provider';
import type {
  Agent,
  TAgentsMap,
  TConfig,
  TPublicCodeEnvironment,
  CodeWorkspaceSelection,
} from 'librechat-data-provider';
import type { CodeApprovalMode, TConversation } from 'librechat-data-provider';
import { useCodeApprovalModePreference } from './codeApprovalPreference';
import useAgentToolPermissions from './useAgentToolPermissions';
import useGetAgentsConfig from './useGetAgentsConfig';
import { useAgentsMapContext } from '~/Providers';

export default function useCodeApprovalMode(
  conversation: TConversation | null,
  addedConversation?: TConversation | null,
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
      collectReachableAgents([primaryAgent, addedAgent], agentsMap, [
        conversation?.agent_id,
        addedConversation?.agent_id,
      ]),
    [addedAgent, agentsMap, primaryAgent, conversation?.agent_id, addedConversation?.agent_id],
  );
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
  const attachedEnvironments = useMemo(
    () =>
      codeEnvironments.filter(
        (environment): environment is TPublicCodeEnvironment => environment?.type === 'attached',
      ),
    [codeEnvironments],
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
   * environment is discoverable; the server ignores it when no BYOM tool is
   * active. Never preserve `acceptEdits` until current policy authorizes it.
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
    selections,
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
): TPublicCodeEnvironment | undefined {
  return (
    findExecutionEnvironment(agent, environments, allowEnvironmentSelection, selections) ??
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
): { agents: Agent[]; complete: boolean } {
  const pending = roots.filter((agent): agent is Agent => agent != null);
  const visited = new Set<string>();
  const agents: Agent[] = [];
  let complete = expectedRootIds.every(
    (id) => isEphemeralAgentId(id) || roots.some((agent) => agent?.id === id),
  );
  while (pending.length > 0) {
    const agent = pending.pop();
    if (agent == null || visited.has(agent.id)) continue;
    visited.add(agent.id);
    agents.push(agent);
    const edgeIds = agent.edges?.flatMap((edge) => [
      ...(Array.isArray(edge.from) ? edge.from : [edge.from]),
      ...(Array.isArray(edge.to) ? edge.to : [edge.to]),
    ]);
    const subagents = agent.subagents?.enabled === true ? agent.subagents : undefined;
    const graphIds = subagents?.graphs?.flatMap((graph) => graph.agent_ids);
    const ids = [
      ...(agent.agent_ids ?? []),
      ...(subagents?.agent_ids ?? []),
      ...(edgeIds ?? []),
      ...(graphIds ?? []),
    ];
    for (const id of ids) {
      if (visited.has(id)) continue;
      const candidate = roots.find((root) => root?.id === id) ?? agentsMap?.[id];
      if (candidate != null) pending.push(candidate);
      else complete = false;
    }
  }
  return { agents, complete };
}
