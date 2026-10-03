import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { PromptService } from '~/prompts';
import { isContentFilterError } from '~/middleware/contentFilter';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Matches the `logger` shape injected elsewhere in this module family
 *  (`createLinkedInstructionsResolver`). */
export interface InstructionsPromptAccessLogger {
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

/** The write-path identity a link permission check runs as. */
export interface InstructionsPromptAccessUser {
  readonly id: string;
  readonly role: string;
}

/** Matches `PermissionService.getResourcePermissionsMap`, injected rather than imported. */
export type GetResourcePermissionsMap = (input: {
  userId: string;
  role: string;
  resourceType: ResourceType;
  resourceIds: string[];
}) => Promise<Map<string, number>>;

/** Matches `assertModelBoundContent({ filters, agents: [{ instructions }] })`, injected so
 *  this module never depends on the wider agent-content shape it inspects. Throws the same
 *  content-policy errors as the save-time and runtime checks on inline instructions. */
export type AssertAgentInstructionsContent = (input: {
  instructions: string;
  filters?: FiltersConfig;
}) => void;

/** Opaque handle to the inbound request, forwarded to `canUsePrompts` only so its
 *  role lookup (`checkAccess` → `getRoleForAccess`) can reuse the caller's per-request
 *  role cache instead of re-reading the role document. This module never reads or
 *  branches on it — kept as `unknown` so it stays decoupled from Express. */
export type InstructionsPromptAccessRequest = unknown;

/** Whether `user`'s role grants the role-level PROMPTS/USE permission — the same gate
 *  `checkPromptAccess` applies to every `/prompts` route. Injected so this module stays
 *  decoupled from `checkAccess`/`IUser`/`getRoleByName`, the way every other dependency
 *  here is. A PROMPTGROUP VIEW grant on a specific group (`canViewGroup`) says nothing
 *  about this broader, role-level capability — a user can be granted VIEW on one group
 *  by its owner while their role still lacks PROMPTS USE entirely. */
export type CanUsePrompts = (
  user: InstructionsPromptAccessUser,
  req?: InstructionsPromptAccessRequest,
) => Promise<boolean>;

export type InstructionsPromptWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 403; readonly code: InstructionsPromptErrorCode };

/** Any object carrying an agent's presented (possibly restricted) instructions-prompt link. */
export type AgentInstructionsPromptCarrier = {
  instructionsPrompt?: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null;
};

/** An agent (or update/revert response) carrying its own link plus version snapshots that
 *  each carry their own, independently-authorized link. */
export type AgentWithVersionsCarrier = AgentInstructionsPromptCarrier & {
  versions?: readonly AgentInstructionsPromptCarrier[];
};

export interface InstructionsPromptAccess {
  /** PROMPTGROUP `VIEW` bit test for `groupId` against the given identity. */
  canViewGroup(input: { userId: string; role: string; groupId: string }): Promise<boolean>;
  /**
   * Validates a create/update write of `instructionsPrompt` against the stored link.
   * `next === undefined` means the field is absent from the payload (no change
   * requested) — ok. Keeping, removing (`next === null`), or re-submitting the
   * unchanged link (`isSameLink`) is always ok: agent EDIT already authorizes all
   * three, and none of them reveals anything about `previous`'s group that EDIT
   * doesn't already know.
   *
   * A genuinely new or changed `next` requires the role-level PROMPTS `USE`
   * permission (`canUsePrompts`) and PROMPTGROUP `VIEW` on `next.groupId`
   * (`canViewGroup`), `FORBIDDEN` otherwise — a PROMPTGROUP `VIEW` grant on one group
   * says nothing about whether the role may link prompts at all, and `next` not
   * existing is indistinguishable from `next` existing but hidden, so group
   * existence is never revealed through it. The two checks are independent, so both
   * run concurrently instead of one gating the start of the other. Once both pass,
   * the selection must still resolve and pass content policy (`UNAVAILABLE`
   * otherwise).
   */
  validateLinkWrite(input: {
    user: InstructionsPromptAccessUser;
    previous: AgentInstructionsPrompt | null | undefined;
    next: AgentInstructionsPrompt | null | undefined;
    filters?: FiltersConfig;
    /** Forwarded unexamined to `canUsePrompts` so its role lookup can reuse the
     *  caller's per-request role cache. */
    req?: InstructionsPromptAccessRequest;
  }): Promise<InstructionsPromptWriteResult>;
  /** Replaces every link the editor cannot VIEW — on the agent itself and inside every
   *  `versions[i]` snapshot — with a restricted stub before an EDIT-scoped response.
   *  Batches every distinct linked group into a single permission lookup. A deleted
   *  group stubs the same as a hidden one: there is no group record left to check
   *  existence against, so this redacts on VIEW alone.
   *
   *  Fails closed: this runs after the write it is presenting has already been
   *  persisted, so an ACL-lookup failure here must never surface as a 500 (a client
   *  retry on that 500 would create another duplicate/etc. against the write that
   *  already succeeded). On such a failure this logs a safe message and returns
   *  every link — top-level and every version snapshot — as the restricted stub
   *  instead of throwing. */
  presentForEditor<T extends AgentWithVersionsCarrier>(input: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T>;
  /** Same redaction as `presentForEditor`, including the same fail-closed behavior,
   *  for a response that returns a version-history array directly
   *  (`GET /agents/:id/versions`) rather than a wrapping agent document.
   *
   *  `currentLink` is the agent document's own raw (unredacted) link, used only to
   *  set `matchesCurrent` on a redacted version's stub — see `redactIfHidden`. Omit
   *  it when the caller has no current link to compare against. */
  presentVersionsForEditor<T extends AgentInstructionsPromptCarrier>(input: {
    user: InstructionsPromptAccessUser;
    versions: readonly T[];
    currentLink?: AgentInstructionsPrompt | null;
  }): Promise<T[]>;
}

/** Structural equality for the small, plain-JSON link shape. `null` and `undefined` are equal. */
function isSameLink(
  a: AgentInstructionsPrompt | null | undefined,
  b: AgentInstructionsPrompt | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  if (left.source !== right.source || left.groupId !== right.groupId) {
    return false;
  }
  if (left.selection.type !== right.selection.type) {
    return false;
  }
  if (left.selection.type === 'exact' && right.selection.type === 'exact') {
    return left.selection.promptId === right.selection.promptId;
  }
  return true;
}

function isRestrictedStub(
  link: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt,
): link is RestrictedAgentInstructionsPrompt {
  return (link as RestrictedAgentInstructionsPrompt).restricted === true;
}

const RESTRICTED_STUB: RestrictedAgentInstructionsPrompt = { source: 'native', restricted: true };

/** Every distinct, non-restricted-stub `groupId` referenced by the given links. */
function collectLinkGroupIds(
  links: Iterable<AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined>,
): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    if (link != null && !isRestrictedStub(link)) {
      ids.add(link.groupId);
    }
  }
  return [...ids];
}

/**
 * Builds the permission checks that gate reading and writing an agent's linked
 * instructions prompt. Callers (the `/api` write and read handlers) own the HTTP
 * boundary; this module only decides ok/forbidden/unavailable.
 * `validateLinkWrite` throws on an unexpected permission or prompt-service failure
 * rather than swallowing it — that check runs before the write lands, so failing it
 * is safe. The caller, `checkInstructionsPromptWrite` (`./writes`), is the one that turns such a
 * throw into a sanitized `500` rather than letting a raw `error.message` reach the
 * client; this module's job stops at ok/forbidden/unavailable or throwing.
 * `presentForEditor` and `presentVersionsForEditor` run after the write has already
 * been persisted and fail closed instead: see their own docs below.
 */
export function createInstructionsPromptAccess(deps: {
  getResourcePermissionsMap: GetResourcePermissionsMap;
  promptService: Pick<PromptService, 'resolvePrompt'>;
  assertAgentInstructionsContent: AssertAgentInstructionsContent;
  canUsePrompts: CanUsePrompts;
  logger: InstructionsPromptAccessLogger;
}): InstructionsPromptAccess {
  const {
    getResourcePermissionsMap,
    promptService,
    assertAgentInstructionsContent,
    canUsePrompts,
    logger,
  } = deps;

  async function canViewGroup({
    userId,
    role,
    groupId,
  }: {
    userId: string;
    role: string;
    groupId: string;
  }): Promise<boolean> {
    const permissionsMap = await getResourcePermissionsMap({
      userId,
      role,
      resourceType: ResourceType.PROMPTGROUP,
      resourceIds: [groupId],
    });
    const bits = permissionsMap.get(groupId) ?? 0;
    return (bits & PermissionBits.VIEW) === PermissionBits.VIEW;
  }

  /**
   * One batched permission lookup for every distinct `groupId` among the given links.
   * Returns the subset the editor cannot VIEW — the groups that must be redacted
   * before an EDIT-scoped response. A deleted group has no ACL entries left, so it
   * comes back not-visible and is redacted the same as a hidden one.
   */
  async function buildRedactionSet(
    user: InstructionsPromptAccessUser,
    groupIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (groupIds.length === 0) {
      return new Set();
    }
    const permissionsMap = await getResourcePermissionsMap({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.PROMPTGROUP,
      resourceIds: [...groupIds],
    });
    const notVisible = groupIds.filter((groupId) => {
      const bits = permissionsMap.get(groupId) ?? 0;
      return (bits & PermissionBits.VIEW) !== PermissionBits.VIEW;
    });
    return new Set(notVisible);
  }

  /** `currentLink` is the agent's current raw link, used only to set `matchesCurrent`
   *  on the stub (never on the current agent's own stub — that caller never passes
   *  it). Left `undefined` when the caller has no current link to compare against,
   *  in which case the stub carries no `matchesCurrent` at all. */
  function redactIfHidden<T extends AgentInstructionsPromptCarrier>(
    carrier: T,
    redactGroupIds: ReadonlySet<string>,
    currentLink?: AgentInstructionsPrompt | null,
  ): T {
    const link = carrier.instructionsPrompt;
    if (link == null || isRestrictedStub(link) || !redactGroupIds.has(link.groupId)) {
      return carrier;
    }
    const stub: RestrictedAgentInstructionsPrompt =
      currentLink === undefined
        ? RESTRICTED_STUB
        : { ...RESTRICTED_STUB, matchesCurrent: isSameLink(link, currentLink) };
    return { ...carrier, instructionsPrompt: stub };
  }

  /** Unconditional stub, used only on the fail-closed path below: every link is
   *  hidden because whether it may be shown could not be determined. */
  function stubLink<T extends AgentInstructionsPromptCarrier>(carrier: T): T {
    return carrier.instructionsPrompt == null
      ? carrier
      : { ...carrier, instructionsPrompt: RESTRICTED_STUB };
  }

  /** Content-free failure log shared by every fail-closed path below. */
  function logAuthorizationFailure(error: unknown): void {
    logger.error(
      '[createInstructionsPromptAccess] Failed to authorize a linked instructions prompt for an EDIT-scoped response; presenting every link as restricted',
      getSafeErrorMetadata(error),
    );
  }

  /** Logs and reports back with no group identity — every top-level and
   *  versioned link on `agent` becomes the restricted stub. */
  function failClosed<T extends AgentWithVersionsCarrier>(error: unknown, agent: T): T {
    logAuthorizationFailure(error);
    const versions = agent.versions;
    return {
      ...stubLink(agent),
      ...(versions == null ? {} : { versions: versions.map((version) => stubLink(version)) }),
    };
  }

  async function validateLinkWrite({
    user,
    previous,
    next,
    filters,
    req,
  }: {
    user: InstructionsPromptAccessUser;
    previous: AgentInstructionsPrompt | null | undefined;
    next: AgentInstructionsPrompt | null | undefined;
    filters?: FiltersConfig;
    req?: InstructionsPromptAccessRequest;
  }): Promise<InstructionsPromptWriteResult> {
    if (next === undefined) {
      // Field absent from the payload: an unrelated edit keeps an inaccessible link.
      return { ok: true };
    }
    if (isSameLink(previous, next)) {
      // Re-selecting (or re-submitting the removal of) the unchanged value is always ok,
      // even when the editor cannot VIEW the group.
      return { ok: true };
    }
    if (next == null) {
      // Removing a link, regardless of whether the editor could VIEW the previous
      // group, is always allowed — agent EDIT is the only authority this needs.
      return { ok: true };
    }
    // A genuinely new or changed link (never a removal, and never a re-selection of the
    // unchanged value — both returned above): the role must grant PROMPTS USE, and the
    // next group must be VIEWable. The two checks are independent and run concurrently;
    // a role failure takes precedence over a VIEW failure.
    const [usable, nextVisible] = await Promise.all([
      canUsePrompts(user, req),
      canViewGroup({ userId: user.id, role: user.role, groupId: next.groupId }),
    ]);
    if (!usable) {
      return { ok: false, status: 403, code: InstructionsPromptErrorCode.FORBIDDEN };
    }
    if (!nextVisible) {
      // FORBIDDEN regardless of whether the group exists, so group existence is never
      // revealed through a new link.
      return { ok: false, status: 403, code: InstructionsPromptErrorCode.FORBIDDEN };
    }
    const resolved = await promptService.resolvePrompt({
      groupId: next.groupId,
      selection: next.selection,
      filters,
    });
    if (!resolved.ok) {
      return { ok: false, status: 400, code: InstructionsPromptErrorCode.UNAVAILABLE };
    }
    try {
      assertAgentInstructionsContent({ instructions: resolved.value.prompt, filters });
    } catch (error) {
      if (isContentFilterError(error)) {
        return { ok: false, status: 400, code: InstructionsPromptErrorCode.UNAVAILABLE };
      }
      throw error;
    }
    return { ok: true };
  }

  async function presentForEditor<T extends AgentWithVersionsCarrier>({
    user,
    agent,
  }: {
    user: InstructionsPromptAccessUser;
    agent: T;
  }): Promise<T> {
    const versions = agent.versions;
    const groupIds = collectLinkGroupIds([
      agent.instructionsPrompt,
      ...(versions ?? []).map((version) => version.instructionsPrompt),
    ]);
    if (groupIds.length === 0) {
      return agent;
    }
    let redact: ReadonlySet<string>;
    try {
      redact = await buildRedactionSet(user, groupIds);
    } catch (error) {
      return failClosed(error, agent);
    }
    const topLevelLink = agent.instructionsPrompt;
    const topLevelRedacted =
      topLevelLink != null && !isRestrictedStub(topLevelLink) && redact.has(topLevelLink.groupId);
    const versionsUnchanged =
      versions == null ||
      versions.every((version) => {
        const link = version.instructionsPrompt;
        return link == null || isRestrictedStub(link) || !redact.has(link.groupId);
      });
    if (!topLevelRedacted && versionsUnchanged) {
      return agent;
    }
    // The agent's own raw link, used to flag a redacted version snapshot as
    // `matchesCurrent` — never a restricted stub here since this function is the
    // one that applies that redaction.
    const currentRawLink =
      topLevelLink != null && !isRestrictedStub(topLevelLink) ? topLevelLink : null;
    return {
      ...agent,
      ...(topLevelRedacted ? { instructionsPrompt: RESTRICTED_STUB } : {}),
      ...(versions == null
        ? {}
        : { versions: versions.map((version) => redactIfHidden(version, redact, currentRawLink)) }),
    };
  }

  async function presentVersionsForEditor<T extends AgentInstructionsPromptCarrier>({
    user,
    versions,
    currentLink,
  }: {
    user: InstructionsPromptAccessUser;
    versions: readonly T[];
    currentLink?: AgentInstructionsPrompt | null;
  }): Promise<T[]> {
    const groupIds = collectLinkGroupIds(versions.map((version) => version.instructionsPrompt));
    if (groupIds.length === 0) {
      return versions as T[];
    }
    let redact: ReadonlySet<string>;
    try {
      redact = await buildRedactionSet(user, groupIds);
    } catch (error) {
      logAuthorizationFailure(error);
      return versions.map((version) => stubLink(version));
    }
    return versions.map((version) => redactIfHidden(version, redact, currentLink));
  }

  return {
    canViewGroup,
    validateLinkWrite,
    presentForEditor,
    presentVersionsForEditor,
  };
}
