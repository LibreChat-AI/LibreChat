import { useMemo } from 'react';
import { Constants, stripAgentIdSuffix } from 'librechat-data-provider';
import type { AgentDisplay } from 'librechat-data-provider';
import { useModelSpecHandoffsQuery } from '~/data-provider/Agents/queries';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';

export type TranscriptAgentsMap = Record<string, AgentDisplay | undefined>;

/** Only preset identities load the safe preset catalog; saved-agent reads keep their existing path. */
export function useTranscriptAgentsMap(agentId: string): TranscriptAgentsMap | undefined {
  const saved = useAgentsMapContext();
  const id = stripAgentIdSuffix(agentId);
  const isPreset = id.startsWith(Constants.MODEL_SPEC_AGENT_PREFIX);
  const query = useModelSpecHandoffsQuery(isPreset);
  const targets = isPreset ? query.data : undefined;
  return useMemo(() => {
    if (!targets?.length) return saved;
    const map: TranscriptAgentsMap = { ...saved };
    for (const target of targets) map[target.id] = target;
    return map;
  }, [saved, targets]);
}

export default function useTranscriptAgent(agentId: string): AgentDisplay | undefined {
  const agents = useTranscriptAgentsMap(agentId);
  return agents?.[stripAgentIdSuffix(agentId)];
}
