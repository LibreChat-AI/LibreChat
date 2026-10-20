import axios from 'axios';
import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type {
  TPromptGroupSource,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
  AgentInstructionsPromptSelection,
  LangfuseAgentInstructionsPromptSelection,
  TPromptRevisionChoicesResponse,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/** Either source's revision selection, as read from or written to the agent's
 *  linked-prompt field. */
export type PromptRevisionSelection =
  | AgentInstructionsPromptSelection
  | LangfuseAgentInstructionsPromptSelection;

/** Narrows a link field to the restricted stub the server returns when the editor
 *  cannot VIEW the linked group. The stub carries no `groupId`, so callers must
 *  branch on this before reading group identity off the value. */
export const isRestrictedInstructionsPrompt = (
  value: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): value is RestrictedAgentInstructionsPrompt =>
  value != null && (value as RestrictedAgentInstructionsPrompt).restricted === true;

export type PromptVersionOption = {
  value: string;
  label: string;
  selection: PromptRevisionSelection;
};

/** Narrows a selection to the Langfuse shape by field presence: a `promptId` field
 *  means the native `exact` shape, which a Langfuse link's selection never carries. */
export function isLangfuseSelection(
  selection: PromptRevisionSelection | undefined,
): selection is LangfuseAgentInstructionsPromptSelection | undefined {
  return selection == null || !('promptId' in selection);
}

/** The Version dropdown's `selectedValue` for a given selection: `'production'`
 *  for the Production label, the native prompt id for a native `exact` selection,
 *  and `v<n>` for a pinned Langfuse `exact` selection. Used both to find the
 *  matching option and to label an unresolvable saved selection that no option
 *  lists. `source` disambiguates the two `exact` shapes, which share the same
 *  `type` literal. */
export function selectionValue(
  source: TPromptGroupSource | undefined,
  selection: PromptRevisionSelection | undefined,
): string {
  if (selection == null || selection.type !== 'exact') {
    return 'production';
  }
  if (source === 'native' && 'promptId' in selection) {
    return selection.promptId;
  }
  if (source === 'langfuse' && 'version' in selection) {
    return `v${selection.version}`;
  }
  return 'production';
}

/**
 * Builds the Version dropdown options from a group's listed revisions
 * (`GET /api/prompts/groups/:groupId/revisions`), newest first. "Production" is
 * always first: for a native group it is labelled with the production
 * revision's display number when one is marked `isProduction`, otherwise the
 * plain "Production" label; a Langfuse group always gets the plain label, since
 * its Production points at a live label rather than a listed revision. When the
 * agent's saved selection matches none of the built options (the pinned
 * revision was removed from the group), it is appended labelled "no longer
 * available" so the dropdown still shows and keeps the saved selection instead
 * of silently switching to Production.
 */
export function buildPromptVersionOptions(
  data: TPromptRevisionChoicesResponse,
  selection: PromptRevisionSelection | undefined,
  localize: (key: TranslationKeys, vars?: Record<string, unknown>) => string,
): PromptVersionOption[] {
  let productionLabel = localize('com_ui_production');
  const versionOptions: PromptVersionOption[] = [];

  for (const revision of data.revisions) {
    if (revision.source === 'native') {
      if (revision.isProduction) {
        productionLabel = localize('com_agents_instructions_prompt_production_version', {
          0: String(revision.version),
        });
      }
      versionOptions.push({
        value: revision.promptId,
        label: localize('com_ui_version_var', { 0: String(revision.version) }),
        selection: { type: 'exact', promptId: revision.promptId },
      });
    } else {
      versionOptions.push({
        value: `v${revision.version}`,
        label: localize('com_ui_version_var', { 0: String(revision.version) }),
        selection: { type: 'exact', version: revision.version },
      });
    }
  }

  const options: PromptVersionOption[] = [
    { value: 'production', label: productionLabel, selection: { type: 'production' } },
    ...versionOptions,
  ];

  if (selection != null && selection.type !== 'production') {
    const selectedValue = selectionValue(data.source, selection);
    if (!options.some((option) => option.value === selectedValue)) {
      options.push({
        value: selectedValue,
        label: localize('com_agents_instructions_prompt_version_missing'),
        selection,
      });
    }
  }

  return options;
}

/** Stable, machine-readable codes mapped to a localized copy key each. */
export const instructionsPromptErrorKeys: Record<InstructionsPromptErrorCode, TranslationKeys> = {
  [InstructionsPromptErrorCode.UNAVAILABLE]: 'com_agents_instructions_prompt_error_unavailable',
  [InstructionsPromptErrorCode.FORBIDDEN]: 'com_agents_instructions_prompt_error_forbidden',
  [InstructionsPromptErrorCode.VALIDATION_FAILED]:
    'com_agents_instructions_prompt_error_validation_failed',
};

/** Reads the stable error code an agent-write failure carried, when the server sent one. */
export function getInstructionsPromptErrorCode(
  error: unknown,
): InstructionsPromptErrorCode | undefined {
  if (!axios.isAxiosError(error)) {
    return undefined;
  }
  const code: unknown = error.response?.data?.code;
  return typeof code === 'string' && code in instructionsPromptErrorKeys
    ? (code as InstructionsPromptErrorCode)
    : undefined;
}

/** Returns the HTTP response status of an error, or `undefined` for a non-HTTP failure. */
export function getHttpStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

/**
 * Chooses the copy key for a failed `GET /api/prompts/groups/:groupId/revisions`
 * read, from the status and `code` the route sends (`packages/api/src/prompts/
 * handlers.ts`, `sendResolveRejection`): a permission failure gets its own
 * copy, a source that exists but cannot currently be read gets the shared
 * "not available" copy, and anything else (including a plain "not found" or an
 * unexpected failure) falls back to the generic load-error copy.
 */
export function getRevisionsLoadErrorKey(error: unknown): TranslationKeys {
  const status = getHttpStatus(error);
  if (status === 403) {
    return 'com_agents_instructions_prompt_forbidden';
  }
  const code = axios.isAxiosError(error)
    ? (error.response?.data as { code?: unknown } | undefined)?.code
    : undefined;
  const isSourceUnavailable =
    (status === 404 && code === 'not_available') ||
    (status === 409 && (code === 'not_configured' || code === 'source_changed')) ||
    (status === 422 && code === 'unsupported_type');
  if (isSourceUnavailable) {
    return 'com_agents_instructions_prompt_source_unavailable';
  }
  return 'com_agents_instructions_prompt_load_error';
}
