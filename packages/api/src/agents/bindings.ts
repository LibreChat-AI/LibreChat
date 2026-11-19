import type { AgentBindingObserver, AgentBindingState } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact } from '~/tracking/request';

/** Records the saved attachments once, without inferring which links changed. */
export async function observeAgentSave<T extends AgentBindingState | null>(
  req: Pick<ServerRequest, 'productTracker' | 'productTracking' | 'productTrackingContext'>,
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

function promptKey(agent: AgentBindingState | undefined): string | undefined {
  const prompt = agent?.instructionsPrompt;
  if (!prompt) return undefined;
  let revision: string | number | undefined;
  if (prompt.source === 'native' && prompt.selection.type === 'exact') {
    revision = prompt.selection.promptId;
  } else if (prompt.source === 'langfuse' && prompt.selection.type === 'exact') {
    revision = prompt.selection.version;
  }
  return JSON.stringify([prompt.source, prompt.groupId, prompt.selection.type, revision]);
}

/** Compare saved bindings after the database confirms the write. */
export function createAgentBindingObserver(
  req: Pick<ServerRequest, 'productTracker' | 'productTracking' | 'productTrackingContext'>,
): AgentBindingObserver {
  return (previous, next) => {
    const agentId = next.id;
    if (promptKey(previous) !== promptKey(next)) {
      if (previous?.instructionsPrompt) {
        trackRequestProductFact(req, {
          name: 'librechat.prompts.unlinked_from_agent',
          feature: 'prompts',
          agentId,
          groupId: previous.instructionsPrompt.groupId,
        });
      }
      if (next.instructionsPrompt) {
        trackRequestProductFact(req, {
          name: 'librechat.prompts.linked_to_agent',
          feature: 'prompts',
          agentId,
          groupId: next.instructionsPrompt.groupId,
        });
      }
    }
    const before = new Set(previous?.skills ?? []);
    const after = new Set(next.skills ?? []);
    for (const skillId of before) {
      if (after.has(skillId)) continue;
      trackRequestProductFact(req, {
        name: 'librechat.skills.unlinked_from_agent',
        feature: 'skills',
        agentId,
        skillId,
      });
    }
    for (const skillId of after) {
      if (before.has(skillId)) continue;
      trackRequestProductFact(req, {
        name: 'librechat.skills.linked_to_agent',
        feature: 'skills',
        agentId,
        skillId,
      });
    }
  };
}
