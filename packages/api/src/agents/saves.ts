import type { IAgent } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact } from '~/tracking/request';

/** The stored object links of an agent, without instructions or other content. */
export type AgentSnapshot = Pick<IAgent, 'id' | 'instructionsPrompt' | 'skills'>;
type TrackingRequest = Pick<
  ServerRequest,
  'productTracker' | 'productTracking' | 'productTrackingContext'
>;

/** Records the saved links after every write path: create, edit, duplicate and restore. */
export async function observeAgentSave<T extends AgentSnapshot | null>(
  req: TrackingRequest,
  save: () => Promise<T>,
): Promise<T> {
  const saved = await save();
  if (saved) {
    trackRequestProductFact(req, {
      name: 'librechat.agents.saved',
      feature: 'agents',
      agentId: saved.id,
      promptGroupId: saved.instructionsPrompt?.groupId ?? null,
      skillIds: [...new Set(saved.skills ?? [])],
    });
  }
  return saved;
}

/** Ends the agent's saved links, so a consumer of snapshots does not keep a deleted agent. */
export function trackAgentDeleted(req: TrackingRequest, agentId: string): void {
  trackRequestProductFact(req, { name: 'librechat.agents.deleted', feature: 'agents', agentId });
}
