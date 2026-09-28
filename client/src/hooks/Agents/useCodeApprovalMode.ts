import { useMemo } from 'react';
import {
  EModelEndpoint,
  Tools,
  isEphemeralAgentId,
  getAllowedCodeApprovalModes,
  CODE_APPROVAL_MODES,
} from 'librechat-data-provider';
import type { Agent, TAgentsMap, TConfig, TPublicCodeEnvironment } from 'librechat-data-provider';
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
        .map((agent) => findExecutionEnvironment(agent, environments)),
    [environments, reachable],
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

export function findExecutionEnvironment(
  agent: Agent,
  environments?: TPublicCodeEnvironment[],
): TPublicCodeEnvironment | undefined {
  return agent.code_environment_id
    ? environments?.find((candidate) => candidate.id === agent.code_environment_id)
    : environments?.find((candidate) => candidate.default === true);
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
