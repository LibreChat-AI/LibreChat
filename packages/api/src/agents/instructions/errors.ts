import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type { AgentInstructionsPrompt, FiltersConfig } from 'librechat-data-provider';
import type {
  InstructionsPromptAccess,
  InstructionsPromptAccessUser,
  InstructionsPromptAccessRequest,
} from './access';

/** User-safe copy for each stable `instructionsPrompt` write-rejection code. */
const INSTRUCTIONS_PROMPT_ERROR_MESSAGES: Record<InstructionsPromptErrorCode, string> = {
  [InstructionsPromptErrorCode.UNAVAILABLE]: 'The selected prompt is not available.',
  [InstructionsPromptErrorCode.FORBIDDEN]: 'You do not have access to the selected prompt.',
  [InstructionsPromptErrorCode.VALIDATION_FAILED]: 'Unable to validate the linked prompt',
};

export interface InstructionsPromptLinkErrorResponse {
  readonly status: 400 | 403 | 500;
  readonly body: { readonly error: string; readonly code: InstructionsPromptErrorCode };
}

/**
 * Builds the HTTP-shaped `{ status, body }` response for a stable `instructionsPrompt`
 * error code, pairing it with its one approved, user-safe message. Shared by every
 * caller that maps a stable code to a response, so the same code always carries the
 * same copy: the per-operation rejection below, and `checkInstructionsPromptWrite`'s
 * own unexpected-failure (VALIDATION_FAILED) case.
 */
export function buildInstructionsPromptError(
  status: InstructionsPromptLinkErrorResponse['status'],
  code: InstructionsPromptErrorCode,
): InstructionsPromptLinkErrorResponse {
  return { status, body: { error: INSTRUCTIONS_PROMPT_ERROR_MESSAGES[code], code } };
}

/**
 * Validates a create/update write of `instructionsPrompt` against the agent's stored
 * link, before any write lands, and maps a rejection to the HTTP boundary's
 * `{ status, body }` shape. Returns `null` when the write may proceed. The caller
 * (`/api`) owns only the HTTP call; every ok/forbidden/unavailable decision lives in
 * `access.validateLinkWrite`.
 */
export async function getInstructionsPromptLinkError({
  access,
  user,
  previous,
  next,
  filters,
  req,
}: {
  access: Pick<InstructionsPromptAccess, 'validateLinkWrite'>;
  user: InstructionsPromptAccessUser;
  previous: AgentInstructionsPrompt | null | undefined;
  next: AgentInstructionsPrompt | null | undefined;
  filters?: FiltersConfig;
  /** Forwarded unexamined to `validateLinkWrite` so its role lookup can reuse the
   *  caller's per-request role cache. */
  req?: InstructionsPromptAccessRequest;
}): Promise<InstructionsPromptLinkErrorResponse | null> {
  const result = await access.validateLinkWrite({
    user,
    previous,
    next,
    filters,
    req,
  });
  if (result.ok) {
    return null;
  }
  return buildInstructionsPromptError(result.status, result.code);
}
