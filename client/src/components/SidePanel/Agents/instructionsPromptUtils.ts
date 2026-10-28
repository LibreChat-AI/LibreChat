import axios from 'axios';
import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type {
  TPrompt,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
  AgentInstructionsPromptSelection,
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
  selection: AgentInstructionsPromptSelection;
};

/**
 * Builds the Version dropdown options for a prompt group's revisions.
 * "Production" is always first, labelled with the current production revision's
 * display number when it can be matched by `_id` against `productionId`. The
 * revisions that follow are labelled "Version N", newest to oldest, matching the
 * display ordinal used in `client/src/components/Prompts/display/PromptVersions.tsx`.
 */
export function buildPromptVersionOptions(
  prompts: TPrompt[],
  productionId: string | null | undefined,
  localize: (key: TranslationKeys, vars?: Record<string, unknown>) => string,
): PromptVersionOption[] {
  const total = prompts.length;
  const productionIndex =
    productionId != null ? prompts.findIndex((prompt) => prompt._id === productionId) : -1;
  const productionLabel =
    productionIndex >= 0
      ? localize('com_agents_instructions_prompt_production_version', {
          0: String(total - productionIndex),
        })
      : localize('com_ui_production');

  const versionOptions: PromptVersionOption[] = prompts.map((prompt, index) => ({
    value: prompt._id ?? '',
    label: localize('com_ui_version_var', { 0: String(total - index) }),
    selection: { type: 'exact', promptId: prompt._id ?? '' },
  }));

  return [
    { value: 'production', label: productionLabel, selection: { type: 'production' } },
    ...versionOptions,
  ];
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
