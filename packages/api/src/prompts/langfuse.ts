import type { LangfuseSourceGroup, LangfuseSourceResolution } from '../langfuse/promptSync';
import type { LangfuseTextPromptSelector } from '../langfuse/prompts';
import type { PromptSourceAdapter } from './types';
import { getLangfusePromptSyncTimeoutMs } from '../langfuse/policy';
import { getLangfuseTextPrompt } from '../langfuse/prompts';

export interface CreateLangfusePromptAdapterDependencies {
  /** Checks the deployment gate, tenant match and prompt-sync switch; builds the
   *  connection the fetch uses, failing as `not_configured` if that build fails; and
   *  checks the group's recorded source identity against that connection, failing as
   *  `source_changed` on a mismatch. Its failure reasons pass straight through. */
  readonly resolveSource: (group: LangfuseSourceGroup) => Promise<LangfuseSourceResolution>;
  readonly getTextPrompt?: typeof getLangfuseTextPrompt;
  readonly timeoutMs?: () => number;
}

/**
 * A read-only content source for a group whose `source` is `langfuse`: it fetches the
 * group's text prompt from Langfuse on every call, with no cache and no mutations.
 *
 * Langfuse resolves a composed prompt's `@@@langfusePrompt:…@@@` references
 * server-side (`resolve` defaults to `true`), so no code is needed here for that: an
 * exact parent `version` fixes the parent text and any children pinned by version,
 * while children pinned by label resolve fresh on each request.
 *
 * A thrown `LangfusePromptRequestError`, or an error thrown by `resolveSource`,
 * propagates to the caller rather than being caught here.
 */
export function createLangfusePromptAdapter({
  resolveSource,
  getTextPrompt = getLangfuseTextPrompt,
  timeoutMs = getLangfusePromptSyncTimeoutMs,
}: CreateLangfusePromptAdapterDependencies): PromptSourceAdapter {
  return {
    async resolvePrompt({ group, selection }) {
      if (selection.type !== 'production' && selection.type !== 'version') {
        return { ok: false, error: { type: 'unsupported_selection', source: 'langfuse' } };
      }
      if (!group.sourcePromptName) {
        return {
          ok: false,
          error: { type: 'source_unavailable', source: 'langfuse', reason: 'not_configured' },
        };
      }

      const resolution = await resolveSource(group);
      if (!resolution.ok) {
        return {
          ok: false,
          error: { type: 'source_unavailable', source: 'langfuse', reason: resolution.reason },
        };
      }

      const selector: LangfuseTextPromptSelector =
        selection.type === 'version' ? { version: selection.version } : { label: 'production' };
      const result = await getTextPrompt(resolution.connection, group.sourcePromptName, selector, {
        timeoutMs: timeoutMs(),
      });
      if (!result.ok) {
        return result.error.code === 'not_found'
          ? { ok: false, error: { type: 'source_not_found', source: 'langfuse' } }
          : { ok: false, error: { type: 'unsupported_content', reason: 'chat_prompt' } };
      }

      return {
        ok: true,
        value: {
          source: 'langfuse',
          groupId: group._id,
          prompt: result.value.prompt,
          type: 'text',
          version: result.value.version,
          labels: result.value.labels,
        },
      };
    },
  };
}
