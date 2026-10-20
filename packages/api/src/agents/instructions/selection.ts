import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import type { PromptSelection } from '~/prompts/types';

/**
 * Maps an agent's linked-prompt selection to the prompt-service's `PromptSelection` —
 * the shape `promptService.resolvePrompt` accepts. A native link's selection already
 * matches the prompt-service shape (`production` | `exact` + `promptId`) and passes
 * through unchanged. A Langfuse link's pinned `exact` selection carries a `version`
 * number rather than a `promptId`, so it maps to the prompt-service's `version`
 * selection; its `production` selection, like native's, passes through unchanged.
 */
export function toPromptSelection(link: AgentInstructionsPrompt): PromptSelection {
  if (link.source === 'native') {
    return link.selection;
  }
  return link.selection.type === 'production'
    ? link.selection
    : { type: 'version', version: link.selection.version };
}
