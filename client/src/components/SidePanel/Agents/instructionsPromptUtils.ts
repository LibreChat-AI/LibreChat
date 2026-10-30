import axios from 'axios';
import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type {
  PromptSelection,
  TPromptGroupSource,
  AgentInstructionsPrompt,
  LangfusePromptSelection,
  RestrictedAgentInstructionsPrompt,
  TPromptRevisionChoicesResponse,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

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
  selection: PromptSelection;
};

/** Narrows a selection to the Langfuse shape by the absence of `promptId`, the native-only field. */
export function isLangfuseSelection(
  selection: PromptSelection | undefined,
): selection is LangfusePromptSelection | undefined {
  return selection == null || !('promptId' in selection);
}

export function selectionValue(
  source: TPromptGroupSource | undefined,
  selection: PromptSelection | undefined,
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

/** Appends the saved selection as "no longer available" if it matches no listed revision. */
export function buildPromptVersionOptions(
  data: TPromptRevisionChoicesResponse,
  selection: PromptSelection | undefined,
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
      const label =
        'version' in selection
          ? localize('com_agents_instructions_prompt_langfuse_version_missing', {
              0: String(selection.version),
            })
          : localize('com_agents_instructions_prompt_version_missing');
      options.push({ value: selectedValue, label, selection });
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

export function getRevisionsLoadErrorKey(error: unknown): TranslationKeys {
  const status = getHttpStatus(error);
  if (status === 403) {
    return 'com_agents_instructions_prompt_forbidden';
  }
  const code = axios.isAxiosError<{ code?: unknown }>(error)
    ? error.response?.data?.code
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
