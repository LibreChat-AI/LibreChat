import { logger } from '@librechat/data-schemas';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { SkillsScope, isEphemeralAgentId, resolveAgentSkillsScope } from 'librechat-data-provider';
import { formatSkillCatalog, SkillToolDefinition, ReadFileToolDefinition } from '@librechat/agents';
import type {
  Agent,
  CodeWorkspaceOperation,
  CodeWorkspaceDescriptor,
} from 'librechat-data-provider';
import type { LCToolRegistry, LCTool, InjectedMessage } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { Types } from 'mongoose';
import { getSkillToolDefinition, isSkillToolAvailable, registerCodeExecutionTools } from './tools';
import { createSkillContentDigest } from './compatibility';
import { logAxiosError } from '~/utils';

/**
 * Load a single skill by name, constrained to an ACL-accessible ID set.
 * Returns the full document (including `body`) so manual invocation can
 * prime SKILL.md without a second DB round-trip.
 *
 * `preferUserInvocable` (manual paths): on a same-name collision,
 * prefer the newest doc with `userInvocable !== false`.
 * `preferModelInvocable` (model paths — `skill` / `read_file`): on a
 * same-name collision, prefer the newest doc with
 * `disableModelInvocation !== true`. Both fall back to the newest match
 * so the explicit-rejection error paths still fire when only the
 * non-preferred variant exists.
 */
export type TGetSkillByName = (
  name: string,
  accessibleIds: Types.ObjectId[],
  options?: { preferUserInvocable?: boolean; preferModelInvocable?: boolean },
) => Promise<{
  _id: Types.ObjectId;
  name: string;
  body: string;
  /** Monotonic Skill document version used by checkpoint context compatibility. */
  version?: number;
  author: Types.ObjectId;
  /** Structured SKILL.md metadata retained for model-bound policy checks. */
  frontmatter?: Record<string, unknown>;
  /**
   * Skill-declared tool allowlist, forwarded verbatim from the skill doc.
   * Surfaced so the resolver can carry it onto `ResolvedManualSkill` for
   * future runtime enforcement without a second round-trip.
   */
  allowedTools?: string[];
  /**
   * Set when the skill was authored with `disable-model-invocation: true`.
   * The skill tool handler short-circuits on this so a model that names
   * such a skill (e.g. via hallucination or stale catalog) gets a clear
   * rejection instead of silently executing.
   */
  disableModelInvocation?: boolean;
  /**
   * Set when the skill was authored with `user-invocable: false`. The
   * manual-invocation resolver skips with a warn log so an API-direct
   * caller can't bypass the popover-side filter.
   */
  userInvocable?: boolean;
  /** True for deployment-directory skills that are loaded in memory. */
  deployment?: boolean;
} | null>;

/** List skill summaries for catalog injection (paginated, omits body/frontmatter). */
export type TListSkillsByAccess = (params: {
  accessibleIds: Types.ObjectId[];
  limit: number;
  cursor?: string | null;
}) => Promise<{
  skills: Array<{
    _id: Types.ObjectId;
    name: string;
    description: string;
    author: Types.ObjectId;
    /**
     * When `true`, the skill is excluded from the catalog injected into
     * the agent's additional_instructions and the model cannot invoke it
     * via the `skill` tool. Manual `$` invocation is unaffected.
     */
    disableModelInvocation?: boolean;
    /**
     * When `false`, the skill is hidden from the `$` popover and rejected
     * by the manual-invocation resolver. Defaults to `true`.
     */
    userInvocable?: boolean;
    /** True for deployment-directory skills that are loaded in memory. */
    deployment?: boolean;
  }>;
  has_more?: boolean;
  after?: string | null;
}>;

const SKILL_CATALOG_LIMIT = 100;
const MIN_SKILL_CATALOG_LIMIT = 1;
/** Max pages scanned per run when filtering out inactive skills. */
const MAX_CATALOG_PAGES = 10;
/** Page size used when paginating to fill the active-skill quota. */
const CATALOG_PAGE_SIZE = 100;
/**
 * Per-entry description cap requested of `formatSkillCatalog`, mirroring the
 * SDK default. It is a ceiling, not a guarantee: `@librechat/agents` applies
 * it first, then truncates further — proportionally against its own context
 * budget, and finally to names-only — so a description well under this cap
 * can still be cut. Delivered length is measured from the emitted catalog
 * rather than assumed from this value.
 */
const SKILL_CATALOG_MAX_ENTRY_CHARS = 250;
/** Hard ceiling on skill names a model spec can request by config. */
const MAX_MODEL_SPEC_SKILLS = SKILL_CATALOG_LIMIT;
/**
 * Hard ceiling on skill names resolved per request via `$` popover or
 * `always-apply`. The popover realistically surfaces only a few per turn;
 * the cap is a defense-in-depth against a crafted payload fanning out into
 * many concurrent `getSkillByName` DB lookups.
 */
export const MAX_MANUAL_SKILLS = 10;

/**
 * Hard ceiling on `always-apply` skills primed per turn. Larger than
 * `MAX_MANUAL_SKILLS` because these are admin / author curated (not
 * per-request user input), so the defensive-payload concern is weaker —
 * but still bounded so a pathological team config can't push dozens of
 * skill bodies into every turn.
 */
export const MAX_ALWAYS_APPLY_SKILLS = 20;

/**
 * Combined hard ceiling applied in `injectSkillPrimes`. When the total
 * (manual + always-apply) exceeds this, always-apply gets truncated
 * first — manual invocation is explicit user intent and should never
 * be silently dropped.
 */
export const MAX_PRIMED_SKILLS_PER_TURN = 30;

/**
 * Hard ceiling on individual skill name length. Real skill names are
 * short slugs (e.g. `pptx`, `brand-guidelines`); anything beyond this is
 * a crafted payload. Filtered out before the DB round-trip so pathological
 * strings can't reach `getSkillByName` / Mongo's query planner.
 */
export const MAX_SKILL_NAME_LENGTH = 200;

/**
 * Canonical namespace prefix for skill files. Single source of truth for
 * three layers that must agree:
 * - the `read_file`/`create_file`/`edit_file` authoring namespace shown to
 *   the model (`skills/{skillName}/...`),
 * - the `handleReadFileCall` routing + bash-fallback paths in `handlers.ts`,
 * - the physical mount layout under `/mnt/data` (see `skillFiles.ts`, which
 *   primes bundled files at `skills/{skillName}/...` so bash and the
 *   model-facing namespace resolve to the same path on disk).
 *
 * Keep the trailing slash — call sites concatenate `${SKILL_FILE_PREFIX}${skillName}/...`.
 */
export const SKILL_FILE_PREFIX = 'skills/';

/** Whether a model-facing file path is routed to persistent LibreChat skill storage. */
export function isSkillFilePath(filePath: string): boolean {
  return filePath.startsWith(SKILL_FILE_PREFIX);
}

/**
 * Marker tagged onto every skill-primed message (as `additional_kwargs.source`
 * on a LangChain `HumanMessage`, or as `source` on the `InjectedMessage` that
 * `handleSkillToolCall` emits). Downstream filtering/telemetry keys off this,
 * so both construction paths must agree — keep the literal exported from one
 * place rather than repeated inline.
 */
export const SKILL_MESSAGE_SOURCE = 'skill';

/**
 * Discriminator tag on a skill prime message that records *why* the skill
 * was primed into the turn. Stored on `additional_kwargs.trigger` of the
 * `HumanMessage` produced by `injectSkillPrimes`; surfaced on UI
 * (pill variants) and accessible to downstream filtering / telemetry.
 */
export const SKILL_TRIGGER_MANUAL = 'manual';
/**
 * Reserved for the model-invoked path (runtime catalog → tool-call
 * resolution). Declared here so the `SkillTrigger` union and the pill
 * UI already speak in terms of three sources rather than growing a
 * fourth value later.
 */
export const SKILL_TRIGGER_MODEL = 'model';
export const SKILL_TRIGGER_ALWAYS_APPLY = 'always-apply';

export type SkillTrigger =
  | typeof SKILL_TRIGGER_MANUAL
  | typeof SKILL_TRIGGER_MODEL
  | typeof SKILL_TRIGGER_ALWAYS_APPLY;

/**
 * Predicate that identifies a LangChain message as one we spliced in via
 * `injectManualSkillPrimes` (or the equivalent model-invoked path). Callers
 * like `runMemory` use this to strip synthetic skill content from windows
 * that should only contain real user chat — without this filter, SKILL.md
 * bodies pollute memory extraction and crowd out genuine turns.
 */
export function isSkillPrimeMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const kwargs = (msg as { additional_kwargs?: { source?: unknown } }).additional_kwargs;
  return !!kwargs && kwargs.source === SKILL_MESSAGE_SOURCE;
}

/**
 * Scopes user-accessible skill IDs to only those configured on the agent.
 *
 * Semantics (pinned by unit tests):
 * - `undefined` / `null` → not configured, returns the full accessible catalog.
 * - `[]` (empty array) → no allowlist, returns the full accessible catalog.
 *   Removing all selected skills in the builder restores the default full-catalog
 *   behavior while `skills_enabled` remains true.
 * - non-empty array of skill `_id` hex strings → intersection of accessible IDs
 *   and agent-configured IDs.
 *
 * @internal Building block for {@link resolveAgentScopedSkillIds}; runtime
 * call sites should prefer the resolver so the activation predicate
 * (`skillsCapabilityEnabled`, ephemeral toggle, persisted `skills_enabled`)
 * is enforced uniformly.
 */
export function scopeSkillIds(
  accessibleSkillIds: Types.ObjectId[],
  agentSkills: string[] | null | undefined,
): Types.ObjectId[] {
  if (agentSkills == null) {
    return accessibleSkillIds;
  }
  if (agentSkills.length === 0) {
    return accessibleSkillIds;
  }
  const agentSet = new Set(agentSkills);
  return accessibleSkillIds.filter((oid) => agentSet.has(oid.toString()));
}

function normalizeSkillCatalogLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return SKILL_CATALOG_LIMIT;
  }
  return Math.min(SKILL_CATALOG_LIMIT, Math.max(MIN_SKILL_CATALOG_LIMIT, Math.floor(limit)));
}

export interface ResolveModelSpecSkillIdsParams {
  /** Skill names configured on a model spec. */
  names: string[];
  /** Full VIEW-accessible skill IDs for this user before model-spec scoping. */
  accessibleSkillIds: Types.ObjectId[];
  /** DB lookup: name → skill doc constrained to the user's accessible IDs. */
  getSkillByName?: TGetSkillByName;
}

/**
 * Resolves model-spec skill names against the current user's accessible skill
 * set. Config is advisory: unrecognized, inaccessible, malformed, or errored
 * names are skipped with a warning so a stale model-spec entry never blocks
 * the actual chat request.
 */
export async function resolveModelSpecSkillIds({
  names,
  accessibleSkillIds,
  getSkillByName,
}: ResolveModelSpecSkillIdsParams): Promise<Types.ObjectId[]> {
  if (!names.length || accessibleSkillIds.length === 0 || !getSkillByName) {
    return [];
  }

  const seenNames = new Set<string>();
  const uniqueNames: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string') {
      continue;
    }
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_SKILL_NAME_LENGTH || seenNames.has(trimmed)) {
      continue;
    }
    seenNames.add(trimmed);
    uniqueNames.push(trimmed);
  }

  let boundedNames = uniqueNames;
  if (uniqueNames.length > MAX_MODEL_SPEC_SKILLS) {
    logger.warn(
      `[resolveModelSpecSkillIds] Truncating model spec skill list from ${uniqueNames.length} to ${MAX_MODEL_SPEC_SKILLS}.`,
    );
    boundedNames = uniqueNames.slice(0, MAX_MODEL_SPEC_SKILLS);
  }

  const resolved: Array<Types.ObjectId | null> = [];
  for (const name of boundedNames) {
    try {
      const skill = await getSkillByName(name, accessibleSkillIds, {
        preferModelInvocable: true,
      });
      if (!skill) {
        logger.warn('[resolveModelSpecSkillIds] Requested skill not found or not accessible');
        resolved.push(null);
        continue;
      }
      resolved.push(skill._id);
    } catch {
      logger.warn('[resolveModelSpecSkillIds] Failed to resolve a requested skill');
      resolved.push(null);
    }
  }

  const seenIds = new Set<string>();
  return resolved.filter((id): id is Types.ObjectId => {
    if (!id) {
      return false;
    }
    const key = id.toString();
    if (seenIds.has(key)) {
      return false;
    }
    seenIds.add(key);
    return true;
  });
}

export interface ResolveAgentScopedSkillIdsParams {
  /** Agent being initialized. Reads its persisted skill capability and catalog scope. */
  agent: Pick<Agent, 'id' | 'skills' | 'skills_enabled' | 'skills_scope'>;
  /** Full set of skill IDs the user can VIEW (pre-scoped by ACL). */
  accessibleSkillIds: Types.ObjectId[];
  /** Admin capability: `AgentCapabilities.skills` on the agents endpoint. */
  skillsCapabilityEnabled: boolean;
  /** Per-conversation skills badge toggle (`req.body.ephemeralAgent.skills`). */
  ephemeralSkillsToggle: boolean;
}

/**
 * Strict opt-in resolver for per-agent skill scope. Activation requires an
 * explicit signal from the user or the agent author:
 *  - Ephemeral agent  → model-spec `skills` wins when configured:
 *    `true` = full accessible catalog, string list = scoped allowlist,
 *    empty list / `false` = no skills. Otherwise the skills badge toggle
 *    controls the full accessible catalog.
 *  - Persisted agent  → the builder's `skills_enabled` master switch and
 *    optional explicit `skills_scope`. Legacy agents without a scope retain
 *    enabled + empty = full catalog behavior.
 *
 * When not activated, returns `[]` so `injectSkillCatalog`,
 * `resolveManualSkills`, and `resolveAlwaysApplySkills` all no-op.
 *
 * Without this gate, an `agent.skills` of `undefined` on a persisted agent
 * would fall through to the "full catalog" branch of `scopeSkillIds`,
 * exposing the skill tool on runs where the author never opted in.
 */
export function resolveAgentScopedSkillIds(
  params: ResolveAgentScopedSkillIdsParams,
): Types.ObjectId[] {
  const { agent, accessibleSkillIds, skillsCapabilityEnabled, ephemeralSkillsToggle } = params;
  if (!skillsCapabilityEnabled || accessibleSkillIds.length === 0) {
    return [];
  }
  if (isEphemeralAgentId(agent.id)) {
    if (agent.skills_enabled === false) {
      return [];
    }
    if (agent.skills_enabled === true) {
      if (Array.isArray(agent.skills) && agent.skills.length === 0) {
        return [];
      }
      return Array.isArray(agent.skills)
        ? scopeSkillIds(accessibleSkillIds, agent.skills)
        : scopeSkillIds(accessibleSkillIds, undefined);
    }
    return ephemeralSkillsToggle ? scopeSkillIds(accessibleSkillIds, undefined) : [];
  }
  if (agent.skills_enabled !== true) {
    return [];
  }
  const scope = resolveAgentSkillsScope(agent.skills, agent.skills_enabled, agent.skills_scope);
  if (scope === SkillsScope.none) {
    return [];
  }
  if (scope === SkillsScope.all) {
    return scopeSkillIds(accessibleSkillIds, undefined);
  }
  if (!Array.isArray(agent.skills) || agent.skills.length === 0) {
    return [];
  }
  return scopeSkillIds(accessibleSkillIds, agent.skills);
}

export interface ResolveSkillActiveParams {
  /** Skill being evaluated. Only `_id` and `author` matter for resolution. */
  skill: { _id: Types.ObjectId | string; author: Types.ObjectId | string; deployment?: boolean };
  /** Per-user overrides: `{ [skillId]: boolean }`. Missing entries use the default. */
  skillStates?: Record<string, boolean>;
  /** Current user ID. When absent, the function fails closed for all non-overridden skills. */
  userId?: string;
  /** Admin-configured default for shared skills. `true` = shared skills auto-activate. */
  defaultActiveOnShare?: boolean;
}

/**
 * Resolves whether a skill should be injected into the agent catalog for the
 * current user. Precedence (pinned by unit tests):
 *
 * 1. Explicit override in `skillStates` wins above all.
 * 2. Absent `userId` → fail closed. The caller lost user context, so we do
 *    not fall back to ownership-based defaults that could leak shared skills.
 * 3. Owned skills (author === userId) default to **active**.
 * 4. Shared skills default to `defaultActiveOnShare` (admin-configured, default `false`).
 */
export function resolveSkillActive(params: ResolveSkillActiveParams): boolean {
  const { skill, skillStates, userId, defaultActiveOnShare = false } = params;
  const override = skillStates?.[skill._id.toString()];
  if (override !== undefined) {
    return override;
  }
  if (skill.deployment === true) {
    return true;
  }
  if (!userId) {
    return false;
  }
  return skill.author.toString() === userId ? true : defaultActiveOnShare;
}

export interface InjectSkillCatalogParams {
  agent: Agent;
  toolDefinitions: LCTool[] | undefined;
  toolRegistry: LCToolRegistry | undefined;
  accessibleSkillIds: Types.ObjectId[];
  contextWindowTokens: number;
  listSkillsByAccess: TListSkillsByAccess | undefined;
  /** When true, registers bash_tool alongside skill + read_file. */
  codeEnvAvailable?: boolean;
  /** When true, bash_tool registers with the hedged stateful-session description. */
  statefulSessions?: boolean;
  /** When true, read_file exposes the attached worker's workspace namespace. */
  workspaceTools?: boolean;
  /** Live operation ceiling for the selected attached workspace. */
  workspaceOperations?: ReadonlySet<CodeWorkspaceOperation>;
  /** Deployment ceiling advertised on attached Bash tool definitions. */
  workspaceCommandTimeoutMaxMs?: number;
  workspaceEnvironment?: CodeWorkspaceDescriptor['environment'];
  /** Current user ID — used to determine skill ownership for active-state resolution. */
  userId?: string;
  /** Per-user skill overrides: `{ [skillId]: boolean }`. Missing entries use the default. */
  skillStates?: Record<string, boolean>;
  /** Admin-configured default for shared skills. `true` = shared skills auto-activate. */
  defaultActiveOnShare?: boolean;
  /** Admin-configured cap on the model-visible catalog. Defaults to 100. */
  maxCatalogSkills?: number;
  /**
   * When true, the model may author skills this run, so the `skill` tool
   * registers even with an empty catalog and its guidance accepts a name the
   * model creates mid-run. See `isSkillToolAvailable`.
   */
  skillAuthoringAvailable?: boolean;
  /** Read-only catalog snapshot preloaded for current-policy inspection. */
  resolvedCatalog?: ResolvedSkillCatalog;
}

export type SkillCatalogSummary = Awaited<
  ReturnType<NonNullable<TListSkillsByAccess>>
>['skills'][number];

export interface ResolvedSkillCatalog {
  activeSkills: SkillCatalogSummary[];
  catalogLimit: number;
  visibleCount: number;
  reachedEnd: boolean;
}

export interface ResolveSkillCatalogParams {
  accessibleSkillIds: Types.ObjectId[];
  listSkillsByAccess: TListSkillsByAccess | undefined;
  userId?: string;
  skillStates?: Record<string, boolean>;
  defaultActiveOnShare?: boolean;
  maxCatalogSkills?: number;
}

export interface InjectSkillCatalogResult {
  toolDefinitions: LCTool[] | undefined;
  skillCount: number;
  /**
   * Tool names the skills capability manages this run: the `skill` tool (when
   * anything is model-invocable) and `read_file` (always, for primed skill
   * references). `bash_tool` is excluded even when this call registers it —
   * it belongs to the `execute_code` capability, which reports it itself.
   * `initializeAgent` records these under the `skills` marker so spec
   * selections naming `skills` govern exactly these definitions.
   */
  toolNames: string[];
  /**
   * IDs of skills the runtime is authorized to resolve via `getSkillByName`.
   * Includes `disable-model-invocation: true` skills even though they're
   * absent from the catalog text — the skill-tool handler needs to be able
   * to fetch the doc to fire the explicit "cannot be invoked by the model"
   * rejection (instead of a generic "not found"). Per-user deactivated
   * skills are still excluded — explicit user opt-out shouldn't be
   * resolvable.
   */
  activeSkillIds: Types.ObjectId[];
  /**
   * Names of skills the runtime can resolve, mirroring `activeSkillIds`.
   * Surfaced so host-side handlers (e.g. `read_file`) can decide whether a
   * `{firstSegment}/...` path is a real skill reference vs. a code-env path
   * (`/mnt/data/...`) that should be routed to the bash fallback — without
   * issuing an extra `getSkillByName` round-trip just to discover the name
   * doesn't resolve.
   */
  activeSkillNames: Set<string>;
}

/**
 * Loads the exact active catalog snapshot without mutating an agent or tool
 * registry. Callers may inspect this user-authored content before performing
 * provider/resource side effects, then pass the snapshot to
 * `injectSkillCatalog` to avoid a second query and TOCTOU drift.
 */
export async function resolveSkillCatalog(
  params: ResolveSkillCatalogParams,
): Promise<ResolvedSkillCatalog> {
  const {
    accessibleSkillIds,
    listSkillsByAccess,
    userId,
    skillStates,
    defaultActiveOnShare = false,
    maxCatalogSkills,
  } = params;
  const catalogLimit = normalizeSkillCatalogLimit(maxCatalogSkills);

  if (!listSkillsByAccess || accessibleSkillIds.length === 0) {
    return {
      activeSkills: [],
      catalogLimit,
      visibleCount: 0,
      reachedEnd: true,
    };
  }

  const isActive = (skill: SkillCatalogSummary): boolean =>
    resolveSkillActive({ skill, skillStates, userId, defaultActiveOnShare });

  const activeSkills: SkillCatalogSummary[] = [];
  /**
   * Catalog cap counts only model-visible (non-`disable-model-invocation`)
   * skills. Counting against the merged active set would let a tenant
   * with many disabled skills near the top of the cursor exhaust the
   * 100-slot quota before any invocable skills got scanned — the catalog
   * could end up empty even though invocable skills exist further down
   * the paginated results. Tracking the visible count separately also
   * keeps `MAX_CATALOG_PAGES` honest as a true scan-budget ceiling.
   */
  let visibleCount = 0;
  let cursor: string | null = null;
  let pages = 0;
  let reachedEnd = false;

  while (visibleCount < catalogLimit && pages < MAX_CATALOG_PAGES) {
    const page = await listSkillsByAccess({
      accessibleIds: accessibleSkillIds,
      limit: CATALOG_PAGE_SIZE,
      cursor,
    });

    for (const skill of page.skills) {
      if (visibleCount >= catalogLimit) {
        break;
      }
      /**
       * Active set keeps `disable-model-invocation` skills so the runtime
       * can still resolve them by name and the skill-tool handler can fire
       * its explicit "cannot be invoked by the model" rejection (instead
       * of a misleading "not found"). Catalog text formatting filters
       * them back out below — they cost zero context tokens. Per-user
       * deactivation (`isActive` false) is still a hard exclusion: the
       * user explicitly opted out, so we honor it everywhere.
       */
      if (isActive(skill)) {
        activeSkills.push(skill);
        if (skill.disableModelInvocation !== true) {
          visibleCount += 1;
        }
      }
    }

    if (!page.has_more || !page.after) {
      reachedEnd = true;
      break;
    }
    cursor = page.after;
    pages += 1;
  }

  return {
    activeSkills,
    catalogLimit,
    visibleCount,
    reachedEnd,
  };
}

/** Filler used to build the measurement probe; never reaches the model. */
const CATALOG_PROBE_CHAR = 'x';

/**
 * How much of each skill's description reaches the model, aligned to `skills`.
 *
 * Measured on a probe rather than on the real catalog. Every decision in
 * `formatSkillCatalog`'s truncation ladder reads description `.length` and
 * never description content, so formatting same-length filler reproduces the
 * real cuts exactly — while guaranteeing the output can be parsed, since
 * filler carries no newline and no entry marker and skill names are validated
 * to `^[a-z0-9][a-z0-9-]*$`.
 *
 * The real catalog cannot be measured: a description may contain newlines, so
 * an entry is not one line; duplicate names share a rendering; and truncation
 * can splice one entry's tail onto the next, so even a whole-entry match can
 * be satisfied by text the model never received as that entry.
 */
function measureCatalogDescriptions(
  skills: Array<{ name: string; description: string }>,
  options: Parameters<typeof formatSkillCatalog>[1],
): number[] {
  const probe = formatSkillCatalog(
    skills.map((s) => ({
      name: s.name,
      description: CATALOG_PROBE_CHAR.repeat(s.description.length),
    })),
    options,
  );
  const delivered = new Array<number>(skills.length).fill(0);
  let index = 0;
  for (const line of probe.split('\n')) {
    if (index >= skills.length) {
      break;
    }
    const prefix = `- ${skills[index].name}`;
    if (line === prefix) {
      index++;
      continue;
    }
    if (line.startsWith(`${prefix}: `)) {
      delivered[index] = line.length - prefix.length - 2;
      index++;
    }
  }
  return delivered;
}

/**
 * Queries accessible skills, formats a budget-aware catalog, appends it to the
 * agent's additional_instructions, and registers the SkillTool definition.
 * Returns updated toolDefinitions and the skill count.
 *
 * No tool instance is created — SkillTool is event-driven only. The tool
 * definition in toolDefinitions is sufficient for the LLM to see and call it;
 * the host handler intercepts the call via ON_TOOL_EXECUTE.
 *
 * The caller is responsible for gating on the skills capability before calling.
 */
export async function injectSkillCatalog(
  params: InjectSkillCatalogParams,
): Promise<InjectSkillCatalogResult> {
  const {
    agent,
    toolDefinitions: inputDefs,
    toolRegistry,
    accessibleSkillIds,
    contextWindowTokens,
    listSkillsByAccess,
    codeEnvAvailable,
    statefulSessions,
    workspaceTools,
    workspaceOperations,
    workspaceCommandTimeoutMaxMs,
    workspaceEnvironment,
    userId,
    skillStates,
    defaultActiveOnShare = false,
    maxCatalogSkills,
    resolvedCatalog,
    skillAuthoringAvailable = false,
  } = params;
  const { activeSkills, catalogLimit, visibleCount, reachedEnd } =
    resolvedCatalog ??
    (await resolveSkillCatalog({
      accessibleSkillIds,
      listSkillsByAccess,
      userId,
      skillStates,
      defaultActiveOnShare,
      maxCatalogSkills,
    }));

  /**
   * Nothing to catalog and nothing the model could author: skip registration
   * entirely rather than spend description tokens on tools with no targets.
   * Authoring runs fall through — the `skill` tool still registers below so a
   * skill created mid-run is invocable, and `read_file` stays available for
   * its bundled files.
   */
  if (activeSkills.length === 0 && !skillAuthoringAvailable) {
    return {
      toolDefinitions: inputDefs,
      skillCount: 0,
      toolNames: [],
      activeSkillIds: [],
      activeSkillNames: new Set<string>(),
    };
  }

  if (!reachedEnd && visibleCount < catalogLimit) {
    logger.warn(
      `[injectSkillCatalog] Scanned ${MAX_CATALOG_PAGES} pages without filling the ${catalogLimit}-skill catalog. Some active skills may be excluded.`,
    );
  }

  /**
   * Catalog text and tool registration are gated on the *visible* subset.
   * If every active skill is `disable-model-invocation: true`, the model
   * can't reach any of them anyway — registering the skill tool would
   * burn context tokens for nothing.
   */
  const catalogVisibleSkills = activeSkills.filter((s) => s.disableModelInvocation !== true);

  /**
   * Resolve same-name collisions in the runtime ACL set: when an invocable
   * skill and a `disable-model-invocation: true` skill share a name,
   * `getSkillByName` would pick whichever is newer (it sorts by
   * `updatedAt` desc) — and if the disabled one is newer, EVERY model
   * call to that name would fail with "cannot be invoked by the model"
   * even though the cataloged invocable skill exists. Drop the disabled
   * doc(s) from `activeSkillIds` whenever an invocable doc with the same
   * name is also in scope. When ONLY a disabled doc exists for a name,
   * keep it so the explicit-rejection error path still fires.
   *
   * Note: we never drop two invocable docs that share a name — the
   * existing duplicate-name warn log below covers that ambiguity, and
   * `getSkillByName` picks the newest (deterministic).
   */
  const invocableNames = new Set<string>();
  for (const s of catalogVisibleSkills) {
    invocableNames.add(s.name);
  }
  const executableSkills = activeSkills.filter(
    (s) => s.disableModelInvocation !== true || !invocableNames.has(s.name),
  );

  // Warn on duplicate names within the catalog-visible set — those are the
  // ones the model can actually invoke ambiguously.
  const nameCount = new Map<string, number>();
  for (const s of catalogVisibleSkills) {
    nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
  }
  for (const [dupName, count] of nameCount) {
    if (count > 1) {
      logger.warn(
        `[injectSkillCatalog] ${count} accessible skills share name "${dupName}" — model may invoke the wrong one`,
      );
    }
  }

  /**
   * Catalog text is gated on the visible subset — `disable-model-invocation`
   * skills cost zero context tokens. When no visible skills exist, the
   * model gets no catalog, and the `skill` tool is omitted from the
   * registry unless this run can author one (registering it otherwise
   * would burn description tokens for a tool the model has no targets
   * for). `read_file` and `bash_tool` are still
   * registered though: manually-primed disabled skills can have their
   * SKILL.md body in context referring to `references/*` and `scripts/*`,
   * and those reads would otherwise be impossible.
   */
  if (catalogVisibleSkills.length > 0) {
    const catalogOptions = {
      contextWindowTokens: contextWindowTokens || 200_000,
      maxEntryChars: SKILL_CATALOG_MAX_ENTRY_CHARS,
    };
    const catalog = formatSkillCatalog(
      catalogVisibleSkills.map((s) => ({ name: s.name, description: s.description })),
      catalogOptions,
    );
    if (catalog) {
      const delivered = measureCatalogDescriptions(catalogVisibleSkills, catalogOptions);
      for (let i = 0; i < catalogVisibleSkills.length; i++) {
        const s = catalogVisibleSkills[i];
        const reached = delivered[i];
        if (reached >= s.description.length) {
          continue;
        }
        logger.warn(
          reached === 0
            ? `[injectSkillCatalog] skill "${s.name}" description was dropped from the model catalog (was ${s.description.length} chars) — the catalog exceeded its context budget`
            : `[injectSkillCatalog] skill "${s.name}" description reached the model truncated to ${reached} of ${s.description.length} chars`,
        );
      }
      agent.additional_instructions = agent.additional_instructions
        ? `${agent.additional_instructions}\n\n${catalog}`
        : catalog;
    }
  }

  const skillToolDef = getSkillToolDefinition(skillAuthoringAvailable);
  const skillToolAvailable = isSkillToolAvailable({
    modelInvocableSkillsAvailable: catalogVisibleSkills.length > 0,
    skillAuthoringAvailable,
  });

  /**
   * `skill` tool is conditional on having anything for the model to invoke —
   * a catalog-visible skill, or an authoring run where the model can create
   * one and invoke it in the same conversation.
   * `read_file` + `bash_tool` go through `registerCodeExecutionTools` so
   * a prior registration from `initializeAgent` (for the `execute_code`
   * capability) upgrades to the skill-aware `read_file` definition without
   * producing a duplicate copy. `read_file` is always included —
   * manually-primed `disable-model-invocation: true` skills still need it
   * to load their `references/*` from storage. `bash_tool` follows
   * `codeEnvAvailable` as before.
   */
  let workingDefs: LCTool[] = [...(inputDefs ?? [])];
  if (skillToolAvailable) {
    /**
     * Replace rather than skip, so the registry the host handler resolves and
     * the array the model reads never disagree about which variant is live.
     * Skipping would leave an earlier catalog-only definition telling an
     * authoring run's model that a skill it just created is an invalid name —
     * the exact failure this registration exists to prevent — while the
     * registry claimed otherwise. Mirrors how `registerCodeExecutionTools`
     * upgrades a code-only `read_file` in place instead of suppressing it.
     */
    const existingIndex = workingDefs.findIndex((def) => def.name === skillToolDef.name);
    if (existingIndex >= 0) {
      workingDefs[existingIndex] = skillToolDef;
    } else {
      workingDefs.push(skillToolDef);
    }
    toolRegistry?.set(skillToolDef.name, skillToolDef);
  }

  /**
   * Forward `enableToolOutputReferences` to keep the skills caller
   * symmetric with `initializeAgent`'s call. Today `initializeAgent`
   * registers `bash_tool` first and this call only keeps the existing
   * bash definition — but if call order ever flips (skills-first), a
   * missing flag here would silently produce a `bash_tool`
   * description without the `{{tool<idx>turn<turn>}}` guide, and the
   * `initializeAgent` pass would become the no-op. Mirror the gate
   * `initializeAgent` uses (`effectiveCodeEnvAvailable`, which here
   * is `codeEnvAvailable === true`) so both paths produce identical
   * tool definitions regardless of which fires first.
   */
  const codeExecResult = registerCodeExecutionTools({
    toolRegistry,
    toolDefinitions: workingDefs,
    includeBash: codeEnvAvailable === true,
    enableToolOutputReferences: codeEnvAvailable === true,
    statefulSessions: statefulSessions === true,
    workspaceTools: workspaceTools === true,
    workspaceOperations,
    workspaceCommandTimeoutMaxMs,
    workspaceEnvironment,
  });
  workingDefs = codeExecResult.toolDefinitions;

  const toolNames = skillToolAvailable
    ? [skillToolDef.name, ReadFileToolDefinition.name]
    : [ReadFileToolDefinition.name];

  return {
    toolDefinitions: workingDefs,
    skillCount: catalogVisibleSkills.length,
    toolNames,
    activeSkillIds: executableSkills.map((s) => s._id),
    activeSkillNames: new Set<string>(executableSkills.map((s) => s.name)),
  };
}

/**
 * Builds the meta user message that carries a skill's SKILL.md body into a
 * turn's context. Shape mirrors what `handleSkillToolCall` emits when the
 * model invokes the skill tool directly, so downstream message handling
 * treats all three paths identically.
 *
 * Used by:
 *  - Phase 3 manual invocation (`$skill-name` popover) — called at turn start.
 *  - Phase 5 `always-apply` frontmatter — called at turn start.
 *  - `handleSkillToolCall` for model-invoked skills — called from the tool
 *    execution handler.
 */
export function buildSkillPrimeMessage(skill: { name: string; body: string }): InjectedMessage {
  return {
    role: 'user',
    content: skill.body,
    isMeta: true,
    source: SKILL_MESSAGE_SOURCE,
    skillName: skill.name,
  };
}

/** Builds the exact live Skill overlay placed at the tail of an event actor checkpoint fork. */
export function buildAgentEventActorSkillMessages(
  skills: ReadonlyMap<string, string>,
): HumanMessage[] {
  return [...skills.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, body]) =>
        new HumanMessage({
          id: `event-actor-skill:${createSkillContentDigest(`${name}\0${body}`)}`,
          content: body,
          additional_kwargs: {
            isMeta: true,
            source: SKILL_MESSAGE_SOURCE,
            trigger: SKILL_TRIGGER_MODEL,
            skillName: name,
          },
        }),
    );
}

export interface ResolveManualSkillsParams {
  /** Skill names the user invoked (via `$` popover or `always-apply`). */
  names: string[];
  /** DB lookup: name → skill doc, constrained to ACL-accessible IDs.
   *
   * Resolver always passes `options.preferUserInvocable: true` so a
   * same-name newer `userInvocable: false` (model-only) duplicate can't
   * shadow the older user-invocable doc the popover surfaced. Disable-
   * model-invocation status is irrelevant for the manual path.
   */
  getSkillByName: (
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: { preferUserInvocable?: boolean; preferModelInvocable?: boolean },
  ) => Promise<{
    _id: Types.ObjectId;
    name: string;
    body: string;
    version?: number;
    author: Types.ObjectId | string;
    deployment?: boolean;
    /** Structured SKILL.md metadata retained for model-bound policy checks. */
    frontmatter?: Record<string, unknown>;
    /**
     * Skill-declared tool allowlist, forwarded verbatim from the skill doc.
     * Surfaced on `ResolvedManualSkill` so future runtime enforcement can
     * union it into the agent's effective tool set for the turn without
     * re-fetching the document. Populated by the DB method when available.
     */
    allowedTools?: string[];
    /**
     * When `false`, the skill author opted out of manual invocation. The
     * resolver skips with a warn log rather than priming SKILL.md.
     * Defaults to `true` when omitted.
     */
    userInvocable?: boolean;
  } | null>;
  /** ACL-accessible skill IDs for this user (already scoped by `scopeSkillIds`). */
  accessibleSkillIds: Types.ObjectId[];
  /** Current user ID — required for ownership-based active-state defaults. */
  userId?: string;
  /** Per-user skill active/inactive overrides. */
  skillStates?: Record<string, boolean>;
  /** Admin-configured default for shared skills. */
  defaultActiveOnShare?: boolean;
}

/**
 * Canonical shape of a skill resolved into prime-ready form. Both
 * manual-invocation (`$` popover) and `always-apply` resolvers emit this
 * shape so downstream pipeline stages (`injectSkillPrimes`,
 * `unionPrimeAllowedTools`, `buildSkillPrimedIdsByName`) can treat either
 * source uniformly. The per-prime distinction lives on
 * `additional_kwargs.trigger` of the spliced `HumanMessage` (see
 * `SkillTrigger`), not on this resolver output.
 */
export interface ResolvedSkillPrime {
  /**
   * `_id` of the exact doc that was primed. Plumbed to the runtime so the
   * `read_file` handler can constrain its name lookup to this id and avoid
   * resolving to a different same-name doc on collisions (which would
   * cause the model's reads to hit files from a different skill than the
   * body it sees).
   */
  _id: Types.ObjectId;
  name: string;
  body: string;
  /** Monotonic Skill revision used by checkpoint compatibility. */
  version?: number;
  /** Structured SKILL.md metadata retained for model-bound policy checks. */
  frontmatter?: Record<string, unknown>;
  /**
   * Skill-declared tool allowlist passed through from the skill doc. Present
   * only when the skill author declared `allowed-tools` in frontmatter.
   * Currently populated but not consumed — future runtime enforcement will
   * union these into the agent's effective tool set for the turn.
   */
  allowedTools?: string[];
}

/**
 * Back-compat alias for manual-invocation primes (`$` popover). Semantic
 * aliases over `ResolvedSkillPrime` keep the per-source naming at call
 * sites (so `manualPrimes: ResolvedManualSkill[]` stays readable) without
 * maintaining parallel interfaces.
 */
export type ResolvedManualSkill = ResolvedSkillPrime;

/**
 * Back-compat alias for always-apply primes (auto-applied every turn).
 * See `ResolvedSkillPrime` for the canonical definition.
 */
export type ResolvedAlwaysApplySkill = ResolvedSkillPrime;

/**
 * Resolves user-provided skill names to `{ name, body }` pairs ready for
 * priming. Filters out:
 *  - names not backed by an accessible skill (ACL miss or typo),
 *  - skills the user has toggled inactive (respects ownership-aware defaults).
 *
 * The active-state filter is intentional even for explicit `$` selections:
 *  1. Phase 2 closes the loop on the UI side by hiding inactive skills from
 *     the popover, so a deactivated skill shouldn't be reachable through the
 *     normal flow in the first place.
 *  2. For API-direct callers bypassing the popover, honoring the user's
 *     own activation toggle is the safer default — an opt-out toggle that
 *     stops working the moment someone crafts a raw payload isn't much of
 *     a toggle.
 *
 * Silently skips unresolvable names with a warn log — a missing `$skill` must
 * never block the user's actual message from going through.
 *
 * Preserves input order and drops duplicate names (first wins) so a user who
 * types `$foo $foo` doesn't end up with the body primed twice.
 */
export async function resolveManualSkills(
  params: ResolveManualSkillsParams,
): Promise<ResolvedManualSkill[]> {
  const { names, getSkillByName, accessibleSkillIds, userId, skillStates, defaultActiveOnShare } =
    params;

  if (!names.length || accessibleSkillIds.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const uniqueNames = names.filter((n) => {
    if (!n || seen.has(n)) {
      return false;
    }
    seen.add(n);
    return true;
  });

  /**
   * Truncate after dedup so a user repeating the same name doesn't consume
   * cap slots. Kept inside the function (not at the controller) so every
   * caller — including future internal ones — inherits the protection.
   */
  let boundedNames = uniqueNames;
  if (uniqueNames.length > MAX_MANUAL_SKILLS) {
    logger.warn(
      `[resolveManualSkills] Truncating manual skill list from ${uniqueNames.length} to ${MAX_MANUAL_SKILLS}`,
    );
    boundedNames = uniqueNames.slice(0, MAX_MANUAL_SKILLS);
  }

  const resolved = await Promise.all(
    boundedNames.map(async (name) => {
      try {
        /* `preferUserInvocable` lets the lookup return the older
           user-invocable variant when a newer same-name duplicate has
           `userInvocable: false` (model-only). Without this, the
           popover-visible skill the user picked would silently no-op
           because `getSkillByName`'s `updatedAt desc` tiebreak returns
           the model-only newer doc and the resolver skips it on the
           userInvocable check below. We deliberately do NOT also pass
           `preferModelInvocable` — manually invoking a `disable-model-
           invocation: true` skill is the supported path (iter 4) and
           the model-only filter would interfere with that. */
        const skill = await getSkillByName(name, accessibleSkillIds, {
          preferUserInvocable: true,
        });
        if (!skill) {
          logger.warn('[resolveManualSkills] Requested skill not found or not accessible');
          return null;
        }
        /**
         * `user-invocable: false` skills are model-only by author intent;
         * the popover already hides them on the UI side, but an API-direct
         * caller could still name one in `manualSkills`. Defense-in-depth:
         * skip with a warn log so the contract holds at the runtime
         * boundary too. Silent skip (not error) matches the established
         * "not found / inactive / empty body" pattern — a single misfiring
         * skill must never block the user's actual message from going out.
         *
         * Checked before the body check because `userInvocable` is an
         * authoritative author decision, while empty body could be a
         * transient state — surfacing the more specific cause helps
         * operators triage faster.
         */
        if (skill.userInvocable === false) {
          logger.warn('[resolveManualSkills] Requested skill is not user-invocable — skipping');
          return null;
        }
        if (!skill.body) {
          logger.warn('[resolveManualSkills] Requested skill has empty body — skipping');
          return null;
        }
        const active = resolveSkillActive({
          skill: { _id: skill._id, author: skill.author, deployment: skill.deployment },
          skillStates,
          userId,
          defaultActiveOnShare,
        });
        if (!active) {
          logger.warn('[resolveManualSkills] Requested skill is inactive for this user — skipping');
          return null;
        }
        const resolved: ResolvedManualSkill = {
          _id: skill._id,
          name: skill.name,
          body: skill.body,
          version: skill.version,
          frontmatter: skill.frontmatter,
        };
        if (skill.allowedTools !== undefined) {
          resolved.allowedTools = skill.allowedTools;
        }
        return resolved;
      } catch {
        logger.warn('[resolveManualSkills] Failed to resolve a requested skill');
        return null;
      }
    }),
  );

  return resolved.filter((r): r is ResolvedManualSkill => r !== null);
}

export interface ResolveAlwaysApplySkillsParams {
  /**
   * Paginated DB lookup for accessible skills with `alwaysApply: true`,
   * eagerly loaded with `body` and optional `allowedTools`. Scoped to
   * `accessibleIds` (post-`scopeSkillIds`). The resolver pages until the
   * active-state budget is filled so inactive early rows cannot starve
   * the prime catalog.
   */
  listAlwaysApplySkills: (params: {
    accessibleIds: Types.ObjectId[];
    limit: number;
    cursor?: string | null;
  }) => Promise<{
    skills: Array<{
      _id: Types.ObjectId;
      name: string;
      body: string;
      author: Types.ObjectId | string;
      frontmatter?: Record<string, unknown>;
      allowedTools?: string[];
      version?: number;
      deployment?: boolean;
    }>;
    has_more?: boolean;
    after?: string | null;
  }>;
  /** ACL-accessible skill IDs for this user (already scoped by `scopeSkillIds`). */
  accessibleSkillIds: Types.ObjectId[];
  /** Current user ID — required for ownership-based active-state defaults. */
  userId?: string;
  /** Per-user skill active/inactive overrides. */
  skillStates?: Record<string, boolean>;
  /** Admin-configured default for shared skills. */
  defaultActiveOnShare?: boolean;
  /** Override cap on the number of always-apply primes to resolve. Defaults to `MAX_ALWAYS_APPLY_SKILLS`. */
  maxAlwaysApplySkills?: number;
}

/**
 * Page size used by `resolveAlwaysApplySkills` when paginating the DB
 * listing. Sized comfortably above `MAX_ALWAYS_APPLY_SKILLS` so a single
 * page is enough in the overwhelmingly common case, but the resolver
 * still pages when the catalog is dominated by rows that are inactive
 * for this user.
 */
const ALWAYS_APPLY_PAGE_SIZE = 50;

/**
 * Max pages scanned when filling the active always-apply budget. Bounds
 * worst-case DB load for pathological configs (tens of thousands of
 * shared-inactive always-apply skills) without silently truncating the
 * active budget when the first page happens to land on inactive rows.
 */
const MAX_ALWAYS_APPLY_PAGES = 10;

/**
 * Resolves accessible skills with `alwaysApply: true` into prime-ready
 * form. Mirrors `resolveManualSkills`' contract on purpose so the two feed
 * the same `injectSkillPrimes` + `unionPrimeAllowedTools` pipeline.
 *
 * Paginates the DB listing until the active budget is filled (or we hit
 * `MAX_ALWAYS_APPLY_PAGES`). Applying the budget pre-filter would silently
 * starve the prime catalog whenever early-sorted rows happen to be
 * inactive for this user (e.g. shared skills with
 * `defaultActiveOnShare: false`, or explicit `skillStates` overrides).
 *
 * Name-level dedup across pages — the schema's uniqueness index is
 * `(name, author, tenantId)`, so two authors in the same tenant can
 * ship skills with the same `name` shared with a third user. First
 * occurrence wins (DB sort is `updatedAt` desc, so freshest definition).
 */
export async function resolveAlwaysApplySkills(
  params: ResolveAlwaysApplySkillsParams,
): Promise<ResolvedAlwaysApplySkill[]> {
  const {
    listAlwaysApplySkills,
    accessibleSkillIds,
    userId,
    skillStates,
    defaultActiveOnShare,
    maxAlwaysApplySkills = MAX_ALWAYS_APPLY_SKILLS,
  } = params;

  if (accessibleSkillIds.length === 0 || maxAlwaysApplySkills <= 0) {
    return [];
  }

  const resolved: ResolvedAlwaysApplySkill[] = [];
  const seenNames = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let reachedEnd = false;
  let inactiveSkipped = 0;
  let duplicateNameSkipped = 0;

  while (resolved.length < maxAlwaysApplySkills && pages < MAX_ALWAYS_APPLY_PAGES) {
    let page: Awaited<ReturnType<typeof listAlwaysApplySkills>>;
    try {
      page = await listAlwaysApplySkills({
        accessibleIds: accessibleSkillIds,
        limit: ALWAYS_APPLY_PAGE_SIZE,
        cursor,
      });
    } catch (err) {
      logAxiosError({
        message: '[resolveAlwaysApplySkills] listAlwaysApplySkills failed',
        error: err,
      });
      return resolved;
    }

    for (const skill of page.skills) {
      if (resolved.length >= maxAlwaysApplySkills) {
        break;
      }
      if (!skill.body) {
        logger.warn('[resolveAlwaysApplySkills] Skill has empty body — skipping');
        continue;
      }
      const active = resolveSkillActive({
        skill: { _id: skill._id, author: skill.author, deployment: skill.deployment },
        skillStates,
        userId,
        defaultActiveOnShare,
      });
      if (!active) {
        /**
         * Intentionally no per-skill log: `defaultActiveOnShare: false`
         * makes inactive-for-user rows an *expected* outcome on every
         * turn, and with pagination (up to MAX_ALWAYS_APPLY_PAGES × page
         * size rows) logging each one floods the telemetry and buries
         * real issues. Aggregated count surfaces once below when non-zero.
         */
        inactiveSkipped += 1;
        continue;
      }
      if (seenNames.has(skill.name)) {
        duplicateNameSkipped += 1;
        continue;
      }
      seenNames.add(skill.name);
      const prime: ResolvedAlwaysApplySkill = {
        _id: skill._id,
        name: skill.name,
        body: skill.body,
        version: skill.version,
        frontmatter: skill.frontmatter,
      };
      if (skill.allowedTools !== undefined) {
        prime.allowedTools = skill.allowedTools;
      }
      resolved.push(prime);
    }

    if (!page.has_more || !page.after) {
      reachedEnd = true;
      break;
    }
    cursor = page.after;
    pages += 1;
  }

  if (inactiveSkipped > 0) {
    logger.debug(
      `[resolveAlwaysApplySkills] Skipped ${inactiveSkipped} always-apply skill(s) inactive for this user.`,
    );
  }
  if (duplicateNameSkipped > 0) {
    logger.warn(
      `[resolveAlwaysApplySkills] Skipped ${duplicateNameSkipped} duplicate-named always-apply skill(s); kept the most-recently-updated copy of each name.`,
    );
  }
  if (!reachedEnd && resolved.length < maxAlwaysApplySkills) {
    logger.warn(
      `[resolveAlwaysApplySkills] Scanned ${MAX_ALWAYS_APPLY_PAGES} page(s) without filling the ${maxAlwaysApplySkills}-prime budget. Some active always-apply skills may be excluded.`,
    );
  }

  return resolved;
}

export interface InjectManualSkillPrimesParams {
  /** Formatted LangChain messages produced by `formatAgentMessages`. Mutated in place. */
  initialMessages: BaseMessage[];
  /** Per-index token count map returned by `formatAgentMessages`. */
  indexTokenCountMap: Record<number, number> | undefined;
  /**
   * Resolved skill primes to splice in. Only `name` and `body` are used
   * to construct the meta `HumanMessage`; widening the type to `Pick<...>`
   * lets tests pass minimal `{ name, body }` literals without inventing
   * `_id`s. The resolver always returns full primes in production.
   */
  manualSkillPrimes: Pick<ResolvedManualSkill, 'name' | 'body'>[];
}

export interface InjectManualSkillPrimesResult {
  /** Same array reference as input (mutated). */
  initialMessages: BaseMessage[];
  /** New token map with indices shifted; same reference as input when no-op. */
  indexTokenCountMap: Record<number, number> | undefined;
  /** Number of prime messages actually inserted (for logging by the caller). */
  inserted: number;
  /** Position where primes were inserted, or -1 when no-op. */
  insertIdx: number;
}

/**
 * Splices skill prime messages into a formatted message array just before
 * the latest user message, and shifts the `indexTokenCountMap` so downstream
 * `hydrateMissingIndexTokenCounts` fills counts for the new positions
 * without corrupting accounting for pre-existing ones.
 *
 * Insertion semantics:
 *  - `insertIdx = initialMessages.length - 1`. Empty input → no-op.
 *  - Single-message input → `insertIdx = 0`, primes appear before the lone message.
 *  - Map shift: entries with `idx >= insertIdx` move forward by `numPrimes`.
 *    Using `>=` (not `>`) is load-bearing: the message that was at `insertIdx`
 *    is pushed to `insertIdx + numPrimes` by the splice, so its count must
 *    follow it.
 *
 * Callers are responsible for scoping (e.g. single-agent runs only — see
 * `AgentClient.chatCompletion`). This helper is agent-agnostic.
 *
 * @deprecated Use {@link injectSkillPrimes} instead. That function accepts
 * both manual and always-apply primes, applies cross-list dedup, and
 * enforces the combined `MAX_PRIMED_SKILLS_PER_TURN` ceiling. Retained here
 * for backward compatibility with external consumers of
 * `@librechat/api` that import the manual-only splicer directly.
 */
export function injectManualSkillPrimes(
  params: InjectManualSkillPrimesParams,
): InjectManualSkillPrimesResult {
  const { initialMessages, manualSkillPrimes } = params;
  let { indexTokenCountMap } = params;

  if (manualSkillPrimes.length === 0 || initialMessages.length === 0) {
    return { initialMessages, indexTokenCountMap, inserted: 0, insertIdx: -1 };
  }

  const insertIdx = initialMessages.length - 1;
  const numPrimes = manualSkillPrimes.length;

  if (indexTokenCountMap) {
    const shifted: Record<number, number> = {};
    for (const [idxStr, count] of Object.entries(indexTokenCountMap)) {
      const idx = Number(idxStr);
      shifted[idx >= insertIdx ? idx + numPrimes : idx] = count;
    }
    indexTokenCountMap = shifted;
  }

  const primeMessages = manualSkillPrimes.map(
    (p) =>
      new HumanMessage({
        content: p.body,
        additional_kwargs: {
          isMeta: true,
          source: SKILL_MESSAGE_SOURCE,
          trigger: SKILL_TRIGGER_MANUAL,
          skillName: p.name,
        },
      }),
  );
  initialMessages.splice(insertIdx, 0, ...primeMessages);

  return { initialMessages, indexTokenCountMap, inserted: numPrimes, insertIdx };
}

/**
 * Collects the set of skill names primed fresh this turn — the union of manual
 * ($-popover) and always-apply (frontmatter) primes. Passed to
 * `formatAgentMessages` as `skipSkillBodyNames` so a skill that is BOTH primed
 * this turn AND present in history (as a `skill` tool_call) has its SKILL.md
 * body injected exactly once — by the fresh prime via `injectSkillPrimes` — and
 * is NOT also reconstructed from history. Names absent from this set still
 * reconstruct from history, preserving sticky manual re-priming across turns.
 */
export function collectFreshSkillPrimeNames({
  manualSkillPrimes,
  alwaysApplySkillPrimes,
}: {
  manualSkillPrimes?: Pick<ResolvedManualSkill, 'name'>[];
  alwaysApplySkillPrimes?: Pick<ResolvedAlwaysApplySkill, 'name'>[];
}): Set<string> {
  const names = new Set<string>();
  for (const prime of manualSkillPrimes ?? []) {
    names.add(prime.name);
  }
  for (const prime of alwaysApplySkillPrimes ?? []) {
    names.add(prime.name);
  }
  return names;
}

export interface InjectSkillPrimesParams {
  /** Formatted LangChain messages produced by `formatAgentMessages`. Mutated in place. */
  initialMessages: BaseMessage[];
  /** Per-index token count map returned by `formatAgentMessages`. */
  indexTokenCountMap: Record<number, number> | undefined;
  /** Resolved manual-invocation primes ($-popover). */
  manualSkillPrimes?: Pick<ResolvedManualSkill, 'name' | 'body'>[];
  /** Resolved `always-apply` primes (frontmatter-driven, auto-applied every turn). */
  alwaysApplySkillPrimes?: Pick<ResolvedAlwaysApplySkill, 'name' | 'body'>[];
  /**
   * Combined ceiling on primes per turn. Defaults to
   * `MAX_PRIMED_SKILLS_PER_TURN`. When the sum of `manualSkillPrimes` +
   * `alwaysApplySkillPrimes` exceeds the cap, always-apply primes are
   * truncated first — manual invocation is explicit user intent and must
   * never be silently dropped.
   */
  maxPrimesPerTurn?: number;
}

export interface InjectSkillPrimesResult {
  initialMessages: BaseMessage[];
  indexTokenCountMap: Record<number, number> | undefined;
  inserted: number;
  insertIdx: number;
  alwaysApplyDropped: number;
  /**
   * Count of always-apply primes dropped because the same skill name already
   * appears in the manual list — dedup prevents the same SKILL.md body from
   * being spliced in twice in one turn.
   */
  alwaysApplyDedupedFromManual: number;
}

export interface SelectSkillPrimesForTurnResult<ManualPrime, AlwaysApplyPrime> {
  manualSkillPrimes: ManualPrime[];
  alwaysApplySkillPrimes: AlwaysApplyPrime[];
  alwaysApplyDropped: number;
  alwaysApplyDedupedFromManual: number;
}

/**
 * Resolves the one authoritative set of skill primes for a turn. Keeping this
 * selection separate from message injection lets every earlier consumer
 * (content inspection, allowed-tool union, persisted pills) operate on exactly
 * the same deduped and capped lists that the model will eventually receive.
 */
export function selectSkillPrimesForTurn<
  ManualPrime extends Pick<ResolvedManualSkill, 'name'>,
  AlwaysApplyPrime extends Pick<ResolvedAlwaysApplySkill, 'name'>,
>(params: {
  manualSkillPrimes: readonly ManualPrime[];
  alwaysApplySkillPrimes: readonly AlwaysApplyPrime[];
  maxPrimesPerTurn?: number;
}): SelectSkillPrimesForTurnResult<ManualPrime, AlwaysApplyPrime> {
  const {
    manualSkillPrimes,
    alwaysApplySkillPrimes,
    maxPrimesPerTurn = MAX_PRIMED_SKILLS_PER_TURN,
  } = params;
  let alwaysApply = [...alwaysApplySkillPrimes];
  let alwaysApplyDedupedFromManual = 0;

  if (alwaysApply.length > 0 && manualSkillPrimes.length > 0) {
    const manualNames = new Set(manualSkillPrimes.map((prime) => prime.name));
    const deduped = alwaysApply.filter((prime) => !manualNames.has(prime.name));
    alwaysApplyDedupedFromManual = alwaysApply.length - deduped.length;
    alwaysApply = deduped;
  }

  let alwaysApplyDropped = 0;
  const total = manualSkillPrimes.length + alwaysApply.length;
  if (total > maxPrimesPerTurn) {
    const budgetForAlwaysApply = Math.max(0, maxPrimesPerTurn - manualSkillPrimes.length);
    alwaysApplyDropped = alwaysApply.length - budgetForAlwaysApply;
    alwaysApply = alwaysApply.slice(0, budgetForAlwaysApply);
  }

  return {
    manualSkillPrimes: [...manualSkillPrimes],
    alwaysApplySkillPrimes: alwaysApply,
    alwaysApplyDropped,
    alwaysApplyDedupedFromManual,
  };
}

/**
 * Splices manual + always-apply skill prime messages into a formatted
 * message array just before the latest user message. Ordering: always-apply
 * primes first (further from the user message, ambient context), then
 * manual primes (closer to the user message, explicit user intent). More
 * recent context gets more attention in most LLMs, so we want explicit `$`
 * picks landing closest to the latest user turn and ambient priming
 * sitting further back. Shifts `indexTokenCountMap` for the combined
 * splice.
 *
 * Cross-list dedup: if a user `$`-invokes a skill that is also marked
 * `always-apply`, the always-apply copy is dropped so the SKILL.md body
 * is primed only once. Manual wins (drops the always-apply side) because
 * manual primes sit closer to the user message and carry explicit intent.
 *
 * Enforces a combined ceiling (`maxPrimesPerTurn`, default
 * `MAX_PRIMED_SKILLS_PER_TURN`) by truncating always-apply first so
 * manual is never silently dropped. Dedup runs before the cap so the
 * cap reflects the real prime count, not the pre-dedup total.
 */
export function injectSkillPrimes(params: InjectSkillPrimesParams): InjectSkillPrimesResult {
  const {
    initialMessages,
    manualSkillPrimes = [],
    alwaysApplySkillPrimes = [],
    maxPrimesPerTurn = MAX_PRIMED_SKILLS_PER_TURN,
  } = params;
  let { indexTokenCountMap } = params;

  const selected = selectSkillPrimesForTurn({
    manualSkillPrimes,
    alwaysApplySkillPrimes,
    maxPrimesPerTurn,
  });
  const {
    alwaysApplySkillPrimes: alwaysApply,
    alwaysApplyDropped,
    alwaysApplyDedupedFromManual,
  } = selected;
  if (alwaysApplyDedupedFromManual > 0) {
    logger.info(
      `[injectSkillPrimes] Dropped ${alwaysApplyDedupedFromManual} always-apply prime(s) already present in the manual list; same-named skills are primed only once per turn.`,
    );
  }
  if (alwaysApplyDropped > 0) {
    const total = manualSkillPrimes.length + alwaysApplySkillPrimes.length;
    logger.warn(
      `[injectSkillPrimes] Combined primes ${total} exceeds cap ${maxPrimesPerTurn}; dropping ${alwaysApplyDropped} always-apply prime(s) to preserve manual invocations.`,
    );
  }

  const numPrimes = manualSkillPrimes.length + alwaysApply.length;
  if (numPrimes === 0 || initialMessages.length === 0) {
    return {
      initialMessages,
      indexTokenCountMap,
      inserted: 0,
      insertIdx: -1,
      alwaysApplyDropped,
      alwaysApplyDedupedFromManual,
    };
  }

  const insertIdx = initialMessages.length - 1;

  if (indexTokenCountMap) {
    const shifted: Record<number, number> = {};
    for (const [idxStr, count] of Object.entries(indexTokenCountMap)) {
      const idx = Number(idxStr);
      shifted[idx >= insertIdx ? idx + numPrimes : idx] = count;
    }
    indexTokenCountMap = shifted;
  }

  const buildPrime = (p: { name: string; body: string }, trigger: SkillTrigger): HumanMessage =>
    new HumanMessage({
      content: p.body,
      additional_kwargs: {
        isMeta: true,
        source: SKILL_MESSAGE_SOURCE,
        trigger,
        skillName: p.name,
      },
    });

  const primeMessages: HumanMessage[] = [
    ...alwaysApply.map((p) => buildPrime(p, SKILL_TRIGGER_ALWAYS_APPLY)),
    ...manualSkillPrimes.map((p) => buildPrime(p, SKILL_TRIGGER_MANUAL)),
  ];
  initialMessages.splice(insertIdx, 0, ...primeMessages);

  return {
    initialMessages,
    indexTokenCountMap,
    inserted: numPrimes,
    insertIdx,
    alwaysApplyDropped,
    alwaysApplyDedupedFromManual,
  };
}

export interface SkillPrimeContentPart {
  type: 'tool_call';
  tool_call: {
    id: string;
    name: string;
    args: string;
    output: string;
    progress: number;
    type: 'tool_call';
  };
}

export interface BuildSkillPrimeContentPartsParams {
  /** Run / response message ID. Used as a stable seed for synthetic tool_call IDs. */
  runId: string;
  /**
   * Optional index offset. When the primes are prepended to an existing
   * contentParts array, callers can leave this 0 (IDs still stay unique
   * within the message). Exposed for explicitness only.
   */
  startOffset?: number;
}

/**
 * Build completed tool_call content parts for each manually-invoked skill.
 *
 * Matches the shape the aggregator produces for a model-invoked skill call
 * on `ON_RUN_STEP_COMPLETED` — `{ type: 'tool_call', tool_call: { id, name,
 * args, output, progress: 1, type: 'tool_call' } }` — so the existing
 * `SkillCall` renderer on the frontend shows identical "Skill X loaded"
 * cards without any new client work.
 *
 * Callers (e.g. `AgentClient.chatCompletion`) prepend these to
 * `this.contentParts` after `runAgents` returns so the cards persist on
 * the response message and appear ahead of the model's content — matching
 * the semantic that priming ran before the LLM turn.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Intentional: sticky re-priming across turns.
 * ──────────────────────────────────────────────────────────────────────
 * Shape parity with model-invoked tool_calls means `extractInvokedSkills
 * FromPayload` (packages/api/src/agents/run.ts) treats these as ordinary
 * skill invocations when scanning history, so `primeInvokedSkills` re-
 * prepares the files + body on every subsequent turn for the rest of
 * the conversation. This is deliberate: the skill-card UX on the assistant
 * message is the user's persistent visual cue that the skill is active,
 * and re-priming keeps the LLM's view consistent with what the user sees
 * (and matches how model-invoked skills behave — there is no separate
 * "one-shot vs. conversation-scoped" mode). To opt out of a sticky skill,
 * users need to start a new conversation or edit the originating user
 * message to remove the pills and resubmit — regenerate alone preserves
 * the picks (`useChatFunctions.regenerate` forwards them via
 * `overrideManualSkills`). A future "one-shot manual prime" mode would
 * need a distinct marker on the synthetic tool_call so the history
 * scanner could skip it.
 */
export function buildSkillPrimeContentParts(
  /**
   * Only `name` is read here; widening the param type to `Pick<...>` lets
   * callers (and tests) pass either the full `ResolvedManualSkill` or a
   * minimal `{ name, body }` literal without needing to invent a
   * placeholder `_id`. The resolver always returns full primes.
   */
  primes: Pick<ResolvedManualSkill, 'name' | 'body'>[],
  { runId, startOffset = 0 }: BuildSkillPrimeContentPartsParams,
): SkillPrimeContentPart[] {
  return primes.map((prime, i) => {
    const args = JSON.stringify({ skillName: prime.name });
    return {
      type: 'tool_call',
      tool_call: {
        id: `call_manual_skill_${runId}_${startOffset + i}`,
        name: SkillToolDefinition.name,
        args,
        output: `Skill "${prime.name}" loaded. Follow the instructions below.`,
        progress: 1,
        type: 'tool_call',
      },
    };
  });
}

export interface SkillPrimeWithTools {
  /** Skill name — used for log attribution only. */
  name: string;
  /** Author-declared `allowed-tools` from frontmatter, if any. */
  allowedTools?: string[];
}

export interface UnionPrimeAllowedToolsParams {
  /**
   * Resolved skill primes (manual + always-apply once Phase 5 lands) that
   * may carry an `allowedTools` allowlist. Order is irrelevant — the union
   * is set-based — but stable iteration helps debug logs read consistently.
   */
  primes: SkillPrimeWithTools[];
  /** Tool names already configured on the agent. Skipped when computing extras. */
  agentToolNames: string[];
}

export interface UnionPrimeAllowedToolsResult {
  /**
   * Tool names contributed by skill primes that aren't already on the
   * agent. Caller is responsible for actually loading these and merging
   * the resulting tool definitions into the agent's effective set; the
   * helper itself stays pure so it can be unit-tested in isolation and
   * reused for the always-apply path.
   */
  extraToolNames: string[];
  /**
   * Per-skill breakdown of which tool names that skill contributed to the
   * final union. Useful for the debug log when the runtime drops names
   * that the registry doesn't recognize — operators can see which skill
   * asked for the missing tool.
   */
  perSkillExtras: Map<string, string[]>;
}

/**
 * Computes the union of `allowed-tools` declared by a turn's resolved skill
 * primes, minus tools already configured on the agent. The agent-provided
 * tools are the authoritative baseline; allowed-tools only ever ADDS to
 * the surface, never replaces or removes.
 *
 * Tolerant of unknown tool names: validation against the runtime registry
 * happens at the caller (in `initialize.ts`) so we can support skills
 * authored against tools LibreChat hasn't implemented yet — the registry
 * intersection silently drops them with a debug log, but the import path
 * never rejects them.
 *
 * Pure function; returns set-style data so callers can dedupe across
 * concurrent always-apply + manual paths without re-implementing the
 * fold themselves.
 */
export function unionPrimeAllowedTools(
  params: UnionPrimeAllowedToolsParams,
): UnionPrimeAllowedToolsResult {
  const { primes, agentToolNames } = params;
  const onAgent = new Set(agentToolNames);
  const extras = new Set<string>();
  const perSkill = new Map<string, string[]>();

  for (const prime of primes) {
    const requested = prime.allowedTools;
    if (!requested || requested.length === 0) {
      continue;
    }
    const contributed: string[] = [];
    for (const name of requested) {
      if (typeof name !== 'string' || name.length === 0) {
        continue;
      }
      if (onAgent.has(name) || extras.has(name)) {
        continue;
      }
      extras.add(name);
      contributed.push(name);
    }
    if (contributed.length > 0) {
      perSkill.set(prime.name, contributed);
    }
  }

  return {
    extraToolNames: Array.from(extras),
    perSkillExtras: perSkill,
  };
}

/**
 * Safely pulls `manualSkills` from an untyped request body.
 *
 * Accepts only string[] in practice: filters out non-string elements,
 * empty strings, and pathologically long names so a crafted payload
 * (numbers, objects, nulls, giga-strings) can't reach `getSkillByName`
 * and waste DB round-trips, matching the TypeScript contract
 * (`manualSkills?: string[]` on TPayload). Returns `undefined` for
 * missing / non-array inputs OR for arrays that contain no valid strings —
 * callers treat undefined as "no manual invocation this turn."
 */
export function extractManualSkills(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const raw = (body as { manualSkills?: unknown }).manualSkills;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const filtered = raw.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_SKILL_NAME_LENGTH,
  );
  return filtered.length > 0 ? filtered : undefined;
}
