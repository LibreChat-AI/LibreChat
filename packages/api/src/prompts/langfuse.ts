import type { LangfuseSourceGroup, LangfuseSourceResolution } from '../langfuse/promptSync';
import type { LangfuseTextPromptSelector } from '../langfuse/prompts';
import type { PromptSourceAdapter } from './types';
import {
  getLangfuseTextPrompt,
  listLangfusePrompts,
  LangfusePromptRequestError,
} from '../langfuse/prompts';
import { getLangfusePromptSyncTimeoutMs } from '../langfuse/policy';
import { getLangfusePromptUrl } from '../langfuse/links';

export interface CreateLangfusePromptAdapterDependencies {
  /** Checks the deployment gate, tenant match and prompt-sync switch; builds the
   *  connection the fetch uses, failing as `not_configured` if that build fails; and
   *  checks the group's recorded source identity against that connection, failing as
   *  `source_changed` on a mismatch. Its failure reasons pass straight through. */
  readonly resolveSource: (group: LangfuseSourceGroup) => Promise<LangfuseSourceResolution>;
  readonly getTextPrompt?: typeof getLangfuseTextPrompt;
  readonly listPrompts?: typeof listLangfusePrompts;
  readonly timeoutMs?: () => number;
}

/**
 * A read-only content source for a group whose `source` is `langfuse`: it fetches the
 * group's text prompt from Langfuse on every call, with no cache and no mutations.
 * `listRevisions` instead lists its versions, metadata only, with no cache either.
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
  listPrompts = listLangfusePrompts,
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
          sourceUrl: getLangfusePromptUrl(
            resolution.connection.baseUrl,
            group.sourceProjectId ?? '',
            group.sourcePromptName,
          ),
        },
      };
    },

    /**
     * Lists the group's Langfuse versions, newest first. One list request, filtered to
     * an exact name match so a chat prompt is still found and rejected rather than
     * looking absent (see `listLangfusePrompts`'s `filter` precedence). `page: 1,
     * limit: 1` is enough: the filter already narrows the list to at most one prompt.
     *
     * The response is accepted only when it unambiguously names this one prompt — one
     * item, that item's name matching `sourcePromptName`, and `meta.totalItems === 1` —
     * because a Langfuse deployment that ignores an unsupported `filter` would
     * otherwise echo back an unrelated or paginated list that this adapter must never
     * mistake for "not found" or silently truncate. Anything short of that, including a
     * text match with no versions, throws `invalid_response` rather than guessing.
     */
    async listRevisions({ group }) {
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

      const { items, meta } = await listPrompts(
        resolution.connection,
        { nameEquals: group.sourcePromptName, page: 1, limit: 1 },
        { timeoutMs: timeoutMs() },
      );

      if (meta.totalItems === 0 && items.length === 0) {
        return { ok: false, error: { type: 'source_not_found', source: 'langfuse' } };
      }

      if (items.length === 1 && items[0].name === group.sourcePromptName && meta.totalItems === 1) {
        const [item] = items;
        if (item.type === 'text' && item.versions.length > 0) {
          return {
            ok: true,
            value: {
              source: 'langfuse',
              groupId: group._id,
              revisions: [...item.versions]
                .sort((a, b) => b - a)
                .map((version) => ({ source: 'langfuse' as const, version })),
            },
          };
        }
        if (item.type === 'chat') {
          return { ok: false, error: { type: 'unsupported_content', reason: 'chat_prompt' } };
        }
      }

      throw new LangfusePromptRequestError(
        'invalid_response',
        'Langfuse returned an unexpected prompt list response while listing revisions',
      );
    },
  };
}
