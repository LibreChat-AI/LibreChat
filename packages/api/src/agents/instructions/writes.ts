import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type {
  InstructionsPromptAccess,
  InstructionsPromptAccessUser,
  InstructionsPromptAccessLogger,
  InstructionsPromptAccessRequest,
} from './access';
import type { InstructionsPromptLinkErrorResponse } from './errors';
import { getInstructionsPromptLinkError, buildInstructionsPromptError } from './errors';
import { isContentFilterError } from '~/middleware/contentFilter';
import { isValidInstructionsPromptLink } from './linked';
import { getSafeErrorMetadata } from '~/utils/errors';

export type InstructionsPromptWriteOperation = 'create' | 'update';

/**
 * Returned whenever the role, ACL, or prompt-store lookup backing a write check throws
 * unexpectedly (never for a recognized content-policy rejection, which `validateLinkWrite`
 * already turns into its own `ok: false` result). One fixed, pre-built response — no
 * detail about the failure is disclosed, and the caller logs the real cause separately
 * via `getSafeErrorMetadata`.
 */
const VALIDATION_FAILED_ERROR = buildInstructionsPromptError(
  500,
  InstructionsPromptErrorCode.VALIDATION_FAILED,
);

/**
 * Validates one create or update write of `instructionsPrompt`, owning every branch
 * the write handler would otherwise carry: whether the field changed at all
 * (`next === undefined` short-circuits before any permission or prompt lookup) and
 * the permission/resolvability checks in `access.validateLinkWrite`. Returns `null`
 * when the write may proceed; the caller only needs to map a non-null result to its
 * HTTP response.
 *
 * Covers `'create'` and `'update'` only. A duplicate or revert carries its source
 * link (the duplicated agent's, or a version snapshot's) as-is and never calls this
 * function; Agent EDIT is the only authority either needs.
 *
 * Every branch runs inside one try/catch: an unexpected throw from the role, ACL, or
 * prompt-store lookups behind `validateLinkWrite` is logged here with
 * `getSafeErrorMetadata` and mapped to `VALIDATION_FAILED_ERROR` instead of reaching
 * the caller, where it would otherwise surface as a raw `error.message` on the
 * handler's catch-all. A recognized content-policy error is rethrown unchanged —
 * `validateLinkWrite` already maps that case to its own `ok: false` result, so one
 * reaching here would be an unrecognized caller bug, not a failure this function
 * should mask.
 */
export async function checkInstructionsPromptWrite({
  access,
  operation: _operation,
  user,
  previous,
  next,
  filters,
  logger,
  req,
}: {
  access: Pick<InstructionsPromptAccess, 'validateLinkWrite'>;
  operation: InstructionsPromptWriteOperation;
  user: InstructionsPromptAccessUser;
  previous: AgentInstructionsPrompt | null | undefined;
  next: AgentInstructionsPrompt | null | undefined;
  filters?: FiltersConfig;
  logger: InstructionsPromptAccessLogger;
  /** Forwarded unexamined to `access.validateLinkWrite` so its role lookup can reuse
   *  the caller's per-request role cache. */
  req?: InstructionsPromptAccessRequest;
}): Promise<InstructionsPromptLinkErrorResponse | null> {
  if (next === undefined) {
    return null;
  }
  try {
    return await getInstructionsPromptLinkError({
      access,
      user,
      previous: previous ?? null,
      next,
      filters,
      req,
    });
  } catch (error) {
    if (isContentFilterError(error)) {
      throw error;
    }
    logger.error(
      '[checkInstructionsPromptWrite] Failed to validate a linked instructions-prompt write',
      getSafeErrorMetadata(error),
    );
    return VALIDATION_FAILED_ERROR;
  }
}

/**
 * Applies the create/update convention that a `null` `instructionsPrompt` in
 * the update payload means "remove the link" — expressed as `$unset` because
 * `removeNullishValues` drops a bare `null` before it would reach the database
 * driver. Leaves `updateData` untouched when the field isn't `null` (absent,
 * or a link to set). Any existing `$unset` entries on `updateData` are kept.
 * Takes and returns a plain record — the `/api` update payload it operates on
 * is assembled dynamically and has no single static shape.
 */
export function applyInstructionsPromptUnset(
  updateData: Record<string, unknown>,
): Record<string, unknown> {
  if (updateData.instructionsPrompt !== null) {
    return updateData;
  }
  const { instructionsPrompt: _removed, $unset, ...rest } = updateData;
  return {
    ...rest,
    $unset: { ...(($unset as Record<string, unknown> | undefined) ?? {}), instructionsPrompt: 1 },
  };
}

/**
 * The link that will govern the agent's instructions after this write: `next`
 * when the payload carries the field at all (including an explicit `null`
 * removal), otherwise whatever is already stored (`previous`). A create has
 * no stored link, so callers pass `undefined` for `previous` there.
 */
export function effectiveInstructionsPromptLink(
  next: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
  previous: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined {
  return next !== undefined ? next : previous;
}

/**
 * Resolves what a save-time content scan should see for `instructions`, given the
 * link that governed the agent before this write (`previous`) and the one that will
 * govern it after (`effective`).
 *
 * Excludes `instructions` when `effective` is a real link (`isValidInstructionsPromptLink`
 * — the same shape test `initializeAgent` uses): that text is dead once a link governs
 * the agent, so it must not block a write that is otherwise switching to safe, linked
 * content.
 *
 * Otherwise the agent's inline `instructions` are live text, and the payload's own
 * `instructions` is scanned as-is when present. `fallbackInstructions` only fills in
 * for a payload that sends none, and only when `previous` was a real link: that is
 * the one case where text that was never scanned while the link stayed valid
 * (`existingAgent.instructions` for an update, the reverted snapshot's own
 * `instructions` for a revert) is about to go live and must be scanned before it does.
 * An ordinary unlinked agent — `previous` was never a real link — keeps the base
 * behavior of scanning only what the payload actually submits; `fallbackInstructions`
 * is ignored for it even when supplied, so a safe partial edit that omits
 * `instructions` is never rejected over stored text nothing in this write touches.
 * Every other field of `data` is returned unchanged.
 */
export function excludeInstructionsWhenLinked<T extends { instructions?: unknown }>(
  data: T,
  {
    previous,
    effective,
    fallbackInstructions,
  }: {
    previous: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined;
    effective: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined;
    fallbackInstructions?: unknown;
  },
): T {
  if (isValidInstructionsPromptLink(effective)) {
    return { ...data, instructions: undefined };
  }
  const linkRemoved = isValidInstructionsPromptLink(previous);
  if (linkRemoved && data.instructions === undefined && fallbackInstructions !== undefined) {
    return { ...data, instructions: fallbackInstructions };
  }
  return data;
}

type InstructionsPromptLinkValue =
  | AgentInstructionsPrompt
  | RestrictedAgentInstructionsPrompt
  | null
  | undefined;

export type InstructionsContentScanOperation = 'create' | 'update' | 'duplicate' | 'revert';

/**
 * Resolves what a save-time content scan should see for `instructions` on one
 * agent write, dispatching `excludeInstructionsWhenLinked` with the `previous`/
 * `effective`/`fallbackInstructions` a given `operation` carries:
 *
 * - `'create'` and `'duplicate'`: there is no stored link to remove, so `previous`
 *   is always `undefined` and `effective` is `data.instructionsPrompt` as submitted
 *   (copied verbatim from the source agent on a duplicate). No fallback applies.
 * - `'update'`: `previous` is `existing.instructionsPrompt`; `effective` is
 *   `nextLink` when the payload carries the field at all (including an explicit
 *   `null` removal), otherwise `previous`. `fallbackInstructions` is
 *   `existing.instructions` — the text never scanned while the link stayed valid —
 *   so it goes live once a previously valid link is removed and the payload sends
 *   no `instructions` of its own.
 * - `'revert'`: the snapshot's own `instructionsPrompt` restores as-is, so
 *   `effective` is `data.instructionsPrompt ?? null` with no permission or
 *   resolvability check. `previous` is `existing.instructionsPrompt ?? null`, and
 *   `fallbackInstructions` is `existing.instructions` — a reverted snapshot never
 *   unsets `instructions` for a missing field, so the agent's current stored text
 *   stays active and must be scanned when a valid link is being removed.
 *
 * Every case excludes `instructions` entirely once `effective` is a real link
 * (`isValidInstructionsPromptLink`): that text is dead once a link governs the
 * agent, so it must not block a write that is otherwise switching to safe, linked
 * content. See `excludeInstructionsWhenLinked` for the shared exclusion/fallback
 * rule this applies.
 */
export function instructionsContentForScan<
  T extends { instructions?: unknown; instructionsPrompt?: unknown },
>(
  operation: InstructionsContentScanOperation,
  {
    data,
    existing,
    nextLink,
  }: {
    data: T;
    existing?: { instructions?: unknown; instructionsPrompt?: unknown } | null;
    nextLink?: unknown;
  },
): T {
  switch (operation) {
    case 'create':
    case 'duplicate':
      return excludeInstructionsWhenLinked(data, {
        previous: undefined,
        effective: data.instructionsPrompt as InstructionsPromptLinkValue,
      });
    case 'update': {
      const previous = existing?.instructionsPrompt as InstructionsPromptLinkValue;
      return excludeInstructionsWhenLinked(data, {
        previous,
        effective: effectiveInstructionsPromptLink(
          nextLink as InstructionsPromptLinkValue,
          previous,
        ),
        fallbackInstructions: existing?.instructions,
      });
    }
    case 'revert':
      return excludeInstructionsWhenLinked(data, {
        previous: (existing?.instructionsPrompt ?? null) as InstructionsPromptLinkValue,
        effective: (data.instructionsPrompt ?? null) as InstructionsPromptLinkValue,
        fallbackInstructions: existing?.instructions,
      });
  }
}
