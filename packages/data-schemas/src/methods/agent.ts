import crypto from 'node:crypto';
import {
  Constants,
  EToolResources,
  PermissionBits,
  PrincipalType,
  ResourceType,
  SkillsScope,
  actionDelimiter,
  isActionTool,
} from 'librechat-data-provider';
import type { FilterQuery, Model, PipelineStage, ProjectionType, Types } from 'mongoose';
import type { AgentSortOption, AgentToolResources } from 'librechat-data-provider';
import type { IAgent, IAclEntry, IUser, ActionQuery } from '~/types';
import { withCodeEnvironmentReference } from './codeEnvironment';
import { OWNER_ACL_PERMISSION_BIT_SUPERSETS } from './aclEntry';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { filterExistingSkillIds } from './skill';
import logger from '~/config/winston';

const { mcp_delimiter } = Constants;

/**
 * Fallback used for the `author` sort when an agent has neither a joined
 * user display name nor a denormalized `authorName`. U+10FFFF is the highest
 * valid Unicode code point, so this sentinel sorts after every real display
 * name — including ones starting with an emoji, whose leading UTF-8 byte is
 * otherwise higher than any ASCII sentinel like `'zzz_unknown'`.
 */
const AUTHOR_SORT_SENTINEL = String.fromCodePoint(0x10ffff);

/**
 * The aggregation-expression shapes the predicate helpers below build: a field path
 * (`'$$e.grantedAt'`), a literal, or a nested operator. Narrow on purpose — the
 * fragments these helpers hand to `$filter`/`$switch`/`$cond` are only correct in
 * these forms, and a wider `Record<string, unknown>` would let a misspelled operator
 * or a wrong-arity operand list through to the production pipeline.
 */
type AggregationOperand = string | number | null | AggregationExpression;

type AggregationExpression =
  | { $and: AggregationExpression[] }
  | { $or: AggregationExpression[] }
  | { $eq: [AggregationOperand, AggregationOperand] }
  | { $ne: [AggregationOperand, AggregationOperand] }
  | { $lt: [AggregationOperand, AggregationOperand] }
  | { $cond: [AggregationExpression, AggregationOperand, AggregationOperand] }
  | { $indexOfCP: [AggregationOperand, AggregationOperand] }
  | { $in: [AggregationOperand, number[]] }
  | { $type: AggregationOperand }
  | { $trim: { input: AggregationOperand } }
  | { $ifNull: [AggregationOperand, AggregationOperand] }
  | { $arrayElemAt: [AggregationOperand, AggregationOperand] };

/**
 * Picks the earlier of two ACL entry sub-documents by (`grantedAt`, `createdAt`, `_id`) —
 * the same tie-break `getFirstOwnerIdsByResource` applies via its `$sort`+`$group` pipeline
 * (`api/server/services/Agents/ownerContact.js`). Written as a manual `$lt`/`$eq` cascade,
 * not `$sortArray`+`$first`, because DocumentDB (this project's CI gate,
 * `documentdb.spec.ts`) rejects `$sortArray` outright.
 *
 * Every timestamp is read through `$ifNull` because an imported or legacy entry can omit
 * `grantedAt` or `createdAt` entirely. `$sort` reads a missing field as null, while a
 * missing field path in a comparison expression is `undefined`, which BSON orders below
 * null — so without this the cascade would rank an entry that omits the field ahead of one
 * that stores null, and an author page would name a different owner than every other list
 * order for the same stored ACL data.
 */
const aclOrderKey = (path: string): AggregationExpression => ({ $ifNull: [path, null] });

function earlierAclEntry(a: string, b: string): AggregationExpression {
  return {
    $or: [
      { $lt: [aclOrderKey(`${a}.grantedAt`), aclOrderKey(`${b}.grantedAt`)] },
      {
        $and: [
          { $eq: [aclOrderKey(`${a}.grantedAt`), aclOrderKey(`${b}.grantedAt`)] },
          {
            $or: [
              { $lt: [aclOrderKey(`${a}.createdAt`), aclOrderKey(`${b}.createdAt`)] },
              {
                $and: [
                  { $eq: [aclOrderKey(`${a}.createdAt`), aclOrderKey(`${b}.createdAt`)] },
                  { $lt: [`${a}._id`, `${b}._id`] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * `true` when `varRef` (already `$trim`-ed by the caller, so it is either `null` or a
 * non-empty-checked string) is usable as a display name: non-empty, and not email-shaped.
 * Mirrors `normalizeDisplayName` (`packages/api/src/agents/contact.ts`), which the card's
 * owner-fallback also runs through — an owner's account email is never shown as their
 * display name, only an opted-in `support_contact.email` is.
 *
 * The `$cond` guard keeps `$indexOfCP` from ever running on a `null` input (DocumentDB/Mongo
 * both throw on that): when `varRef` is `null` the guard short-circuits to `-1` ("no `@`
 * found"), which is moot anyway since the `$ne: [varRef, null]` branch already fails the
 * `$and` in that case.
 */
function isValidDisplayName(varRef: string): AggregationExpression {
  return {
    $and: [
      { $ne: [varRef, null] },
      { $ne: [varRef, ''] },
      {
        $eq: [{ $cond: [{ $eq: [varRef, null] }, -1, { $indexOfCP: [varRef, '@'] }] }, -1],
      },
    ],
  };
}

/** Converts any stored value to a string-safe trimmed aggregation operand. Mixed legacy
 * fields can contain BSON values that `$trim` rejects, so check the type first. */
function trimStringOrEmpty(value: AggregationOperand): AggregationExpression {
  return {
    $trim: {
      input: {
        $cond: [{ $eq: [{ $type: value }, 'string'] }, value, ''],
      },
    },
  };
}

export type AgentListSortOption = AgentSortOption | 'recent';

/**
 * How each marketplace sort mode orders the agent list, and how a cursor taken from
 * that ordering has to be read back.
 *
 * `createdAt` is stored, while popularity counts and author display names are computed for
 * their respective paths. Each mode applies its cursor predicate before selecting the next
 * page.
 *
 * The cursor version is part of the ordering identity. Bump the version whenever an ordering's
 * comparison semantics change, or an older reader will resume a walk under semantics that no
 * longer exist. Cursors without a version are version 1 for rolling-deployment compatibility.
 *
 * `'recent'` is not a marketplace mode: it is the order this endpoint has always served when
 * nothing asks for one — most recently edited first — and the agent selector, the mention menu
 * and the schedule pickers still rely on it. The marketplace's own default, `'newest'`, orders
 * by creation instead, so it has to be requested explicitly.
 *
 * The `_id` tie-break is ascending for every mode except 'oldest'. The latter reverses both
 * keys so MongoDB can scan the existing `{ createdAt: -1, _id: 1 }` index backwards without
 * requiring a second ascending index.
 */
const AGENT_SORT_CONFIG: Record<
  AgentListSortOption,
  {
    field: 'createdAt' | 'updatedAt' | 'favoriteCount' | 'authorSortKey';
    direction: 1 | -1;
    tieBreakDirection: 1 | -1;
    valueType: 'date' | 'number' | 'string';
    version: number;
  }
> = {
  recent: {
    field: 'updatedAt',
    direction: -1,
    tieBreakDirection: 1,
    valueType: 'date',
    version: 1,
  },
  newest: {
    field: 'createdAt',
    direction: -1,
    tieBreakDirection: 1,
    valueType: 'date',
    version: 1,
  },
  oldest: {
    field: 'createdAt',
    direction: 1,
    tieBreakDirection: -1,
    valueType: 'date',
    version: 1,
  },
  popular: {
    field: 'favoriteCount',
    direction: -1,
    tieBreakDirection: 1,
    valueType: 'number',
    version: 1,
  },
  // Version 2 records the normalized (`$toLower`) comparison key.
  author: {
    field: 'authorSortKey',
    direction: 1,
    tieBreakDirection: 1,
    valueType: 'string',
    version: 2,
  },
};

/**
 * Sort keys the list query needs internally — to order rows and to build the cursor —
 * but which are not part of the endpoint's response contract. `createdAt` in particular
 * has never been returned by this endpoint, and leaking any of them would make the
 * response shape depend on `?sort=`.
 */
const INTERNAL_SORT_FIELDS = [
  'createdAt',
  'favoriteCount',
  'authorDisplayName',
  'authorSortKey',
] as const;

/**
 * Favourite counts are keyed per tenant because agent ids collide across tenants,
 * and a missing `tenantId` is the same tenant as an explicitly null one — the separator
 * is a code point no tenant id or agent id can contain.
 */
const FAVORITE_COUNT_KEY_SEPARATOR = '\u0000';
function favoriteCountKey(tenantId: string | null | undefined, agentId: string): string {
  return `${tenantId ?? ''}${FAVORITE_COUNT_KEY_SEPARATOR}${agentId}`;
}

/**
 * Marks a list row whose owner contact the list query already resolved, so `attachOwnerContacts`
 * skips the ACL aggregation and the user lookup for it and strips this field from the response.
 */
export const AGENT_OWNER_CONTACT_RESOLVED_FIELD = '_ownerContactResolved';

/**
 * A stringified ObjectId is always exactly 24 hex characters. Checked explicitly rather
 * than with `ObjectId.isValid`, which also accepts any 12-character string.
 */
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

interface AgentSortCursor {
  /** The last row's value for the mode's sort field; `''` means "that value was absent". */
  primary: string;
  /** The last row's `_id`, used as the tie-break. */
  secondary: string;
}

export type AgentSortCursorFailure = 'ordering-mismatch' | 'unreadable';

export class AgentSortCursorError extends Error {
  readonly code = 'AGENT_SORT_CURSOR_INVALID';

  constructor(readonly failure: AgentSortCursorFailure) {
    super(`Agent sort cursor ${failure}`);
    this.name = 'AgentSortCursorError';
  }
}

type AgentSortCursorDecodeResult =
  | { kind: 'usable'; cursor: AgentSortCursor }
  | { kind: 'ordering-mismatch' }
  | { kind: 'unreadable' };

function isAgentListSortOption(value: unknown): value is AgentListSortOption {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_SORT_CONFIG, value)
  );
}

function castCursorPrimary(
  valueType: 'date' | 'number' | 'string',
  raw: string,
): Date | number | string {
  if (valueType === 'date') {
    return new Date(raw);
  }
  if (valueType === 'number') {
    return Number(raw);
  }
  return raw;
}

/**
 * Cursor invariant: a cursor names the ordering it was produced under, and is honored only
 * by a reader that implements that ordering. A cursor that cannot be honored is an error,
 * never a silent restart.
 *
 * The `sort`/`version` pair is the ordering identity. Bump the version whenever an ordering's
 * comparison semantics change, or an older reader will resume a walk under semantics that no
 * longer exist. Cursors without a version are version 1 for rolling-deployment compatibility.
 *
 * Orderings past version 1 nest their boundary under `boundary`, where a pre-versioning reader
 * cannot find it — see {@link encodeAgentSortCursor}. A flat boundary claiming such a version
 * did not come from this encoder and is unreadable rather than trusted.
 *
 * Legacy cursors carry only `updatedAt` and `_id`; they name `recent`, whose ordering preserves
 * the old updated-time walk. A cursor naming another ordering is a mismatch, while malformed
 * data is unreadable; both are fail-closed.
 */
function decodeAgentSortCursor(
  after: string,
  sort: AgentListSortOption,
): AgentSortCursorDecodeResult {
  try {
    const decoded: Record<string, unknown> = JSON.parse(
      Buffer.from(after, 'base64').toString('utf8'),
    );
    if (decoded == null || Array.isArray(decoded) || typeof decoded !== 'object') {
      return { kind: 'unreadable' };
    }

    const hasPrimary = typeof decoded.primary !== 'undefined';
    const hasLegacyPair = typeof decoded.updatedAt === 'string' && typeof decoded._id === 'string';
    /** Set once a versioned cursor's nested boundary has been lifted into place, so the
     *  legacy substitution below does not overwrite it with an absent `updatedAt`. */
    let hasNestedBoundary = false;
    let cursorSort: AgentListSortOption | null = null;

    if (typeof decoded.sort === 'undefined') {
      if (!hasPrimary && hasLegacyPair) {
        cursorSort = 'recent';
      } else if (
        hasPrimary &&
        hasLegacyPair &&
        decoded.primary === decoded.updatedAt &&
        decoded.secondary === decoded._id
      ) {
        // Cursors from the immediately preceding current release were recent cursors
        // without the explicit identity; retain their safe legacy interpretation.
        cursorSort = 'recent';
      } else {
        return { kind: 'unreadable' };
      }
    } else if (!isAgentListSortOption(decoded.sort)) {
      return { kind: 'unreadable' };
    } else {
      cursorSort = decoded.sort;
      const cursorVersion = typeof decoded.version === 'undefined' ? 1 : decoded.version;
      if (cursorVersion !== AGENT_SORT_CONFIG[cursorSort].version) {
        return { kind: 'ordering-mismatch' };
      }
      if (cursorVersion > 1) {
        const boundary = decoded.boundary;
        if (boundary == null || typeof boundary !== 'object' || Array.isArray(boundary)) {
          return { kind: 'unreadable' };
        }
        const { primary, secondary } = boundary as Record<string, unknown>;
        decoded.primary = primary;
        decoded.secondary = secondary;
        hasNestedBoundary = true;
      }
    }
    if (!hasPrimary && !hasNestedBoundary && hasLegacyPair && cursorSort !== 'recent') {
      return { kind: 'ordering-mismatch' };
    }
    if (cursorSort !== sort) {
      return { kind: 'ordering-mismatch' };
    }

    if (!hasPrimary && !hasNestedBoundary) {
      decoded.primary = decoded.updatedAt;
      decoded.secondary = decoded._id;
    }
    if (typeof decoded.secondary !== 'string' || !OBJECT_ID_HEX.test(decoded.secondary)) {
      return { kind: 'unreadable' };
    }

    const { valueType } = AGENT_SORT_CONFIG[sort];
    /* Coercion is not validation: `String(undefined)` is `'undefined'`, which compares as a
       perfectly ordinary author key and would resume the walk partway through the alphabet
       instead of failing closed. The date mode is caught by its cast; the numeric mode also
       requires a non-negative integer because favorite counts are discrete. The string mode
       has no cast to fail, so its boundary has to arrive as a string. */
    if (valueType === 'string' && typeof decoded.primary !== 'string') {
      return { kind: 'unreadable' };
    }
    const primary = String(decoded.primary);
    if (valueType === 'date') {
      if (primary !== '' && Number.isNaN(new Date(primary).getTime())) {
        return { kind: 'unreadable' };
      }
    } else if (valueType === 'number') {
      const numericPrimary = Number(primary);
      if (primary === '' || !Number.isInteger(numericPrimary) || numericPrimary < 0) {
        return { kind: 'unreadable' };
      }
    }
    return { kind: 'usable', cursor: { primary, secondary: decoded.secondary } };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Builds the filter that selects everything ordered after a decoded cursor.
 *
 * Field-name-agnostic: the same Date/Number/String comparison works whether the sort
 * field is stored (`createdAt`) or computed by an aggregation (`favoriteCount`/`authorSortKey`).
 *
 * Agents inserted outside Mongoose can lack `createdAt`, and legacy rows can
 * contain an explicit null. Mongo sorts both as the same null tier. Cursor predicates
 * therefore use a null equality branch so neither form disappears between pages.
 */
function buildAgentSortCursorCondition(
  sort: AgentListSortOption,
  decoded: AgentSortCursor,
  /**
   * `decoded.secondary` already cast to an ObjectId. Passed in rather than constructed
   * here because this module receives its mongoose instance through `createAgentMethods`,
   * and the aggregation branch gets no automatic query casting.
   */
  secondaryId: Types.ObjectId,
): Record<string, unknown> {
  const { field, direction, tieBreakDirection, valueType } = AGENT_SORT_CONFIG[sort];
  const tieBreakOperator = tieBreakDirection === 1 ? '$gt' : '$lt';
  const tieBreak = { _id: { [tieBreakOperator]: secondaryId } };

  // Missing and explicit null dates occupy the same MongoDB sort tier.
  if (valueType === 'date' && decoded.primary === '') {
    const stillNull = { [field]: null, ...tieBreak };
    if (direction === 1) {
      return { $or: [stillNull, { [field]: { $exists: true, $ne: null } }] };
    }
    return stillNull;
  }

  const op = direction === -1 ? '$lt' : '$gt';
  const primaryValue = castCursorPrimary(valueType, decoded.primary);
  const branches: Record<string, unknown>[] = [
    { [field]: { [op]: primaryValue } },
    { [field]: primaryValue, ...tieBreak },
  ];

  if (valueType === 'date' && direction === -1) {
    branches.push({ [field]: null });
  }

  return { $or: branches };
}

/**
 * Cursor invariant: a cursor names the ordering it was produced under, and is honored only
 * by a reader that implements that ordering. A cursor that cannot be honored is an error,
 * never a silent restart.
 *
 * The `sort`/`version` pair is the ordering identity. Bump the version whenever an ordering's
 * comparison semantics change, or an older reader will resume a walk under semantics that no
 * longer exist. `recent` additionally carries the legacy pair so old instances can keep
 * reading its updated-time walk.
 *
 * A version is only half the protection, because it protects the reader that knows to look
 * at it. Instances deployed before versioning existed ignore unknown fields and read
 * `primary`/`secondary` straight out of the payload, so a bumped ordering whose boundary sits
 * where they expect it would still be resumed under the comparison it replaced. So any
 * ordering past version 1 carries its boundary nested instead: a reader that does not know
 * about versions finds no boundary it recognizes and fails closed, and one that does knows
 * where to look. Version 1 keeps the flat shape, which is what makes every cursor already in
 * flight readable across a deployment.
 */
function encodeAgentSortCursor(
  sort: AgentListSortOption,
  lastAgent: Record<string, unknown>,
): string {
  const { field, valueType, version } = AGENT_SORT_CONFIG[sort];
  const rawValue = lastAgent[field];
  const asIsoDate = (value: unknown): string | null => {
    if (value == null) {
      return null;
    }
    let asDate: Date;
    if (value instanceof Date) {
      asDate = value;
    } else if (typeof value === 'string' || typeof value === 'number') {
      asDate = new Date(value);
    } else {
      asDate = new Date(Number.NaN);
    }
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  };

  let primary: string;
  if (valueType === 'date') {
    primary = asIsoDate(rawValue) ?? '';
  } else if (valueType === 'number') {
    primary = String(rawValue ?? 0);
  } else {
    /* The row already carries the key `$sort` compared — `$toLower` of the display name —
       so it is serialized as it stands. Lowercasing it again here would normalize what the
       database did not: `$toLower` is only defined over ASCII and leaves `Émile` uppercase,
       while JavaScript lowercases the whole of Unicode. The boundary would then land on
       `émile` (U+00E9) and the next page's `$match` would skip every key between it and
       `Émile` (U+00C9). */
    primary = String(rawValue ?? AUTHOR_SORT_SENTINEL);
  }

  const secondary = String(lastAgent._id);
  if (version > 1) {
    return Buffer.from(
      JSON.stringify({ sort, version, boundary: { primary, secondary } }),
    ).toString('base64');
  }

  const legacyUpdatedAt = sort === 'recent' ? asIsoDate(lastAgent.updatedAt) : null;
  return Buffer.from(
    JSON.stringify({
      sort,
      version,
      primary,
      secondary,
      ...(legacyUpdatedAt == null ? {} : { updatedAt: legacyUpdatedAt, _id: secondary }),
    }),
  ).toString('base64');
}

/**
 * Whether emptying an allowlist has to fall back to disabling skills.
 *
 * An explicit `all` or `selected` scope already defines what an empty
 * allowlist means, so neither is inferred from the array: `all` is the full
 * catalog on purpose, and `selected` with nothing selected resolves to no
 * skills on its own. Every other shape is: a missing scope, which is the
 * legacy form whose meaning came from the array, and an explicit `none`
 * carrying a true master flag, which the API accepts and which `skillDeps`
 * reads as standing permission to expose the skill-authoring tools.
 */
function requiresSkillsDisable(scope: unknown): boolean {
  return scope !== SkillsScope.all && scope !== SkillsScope.selected;
}

/**
 * Mirrors `TOOL_RESOURCE_KEYS` in `@librechat/api` — the subset of
 * `EToolResources` that actually carries `file_ids` on an agent document.
 * `code_interpreter` is excluded (it belongs to the Assistants API, not
 * `AgentToolResources`) to avoid emitting dead MongoDB clauses.
 */
const TOOL_RESOURCE_KEYS: ReadonlyArray<keyof AgentToolResources> = [
  EToolResources.execute_code,
  EToolResources.file_search,
  EToolResources.image_edit,
  EToolResources.context,
  EToolResources.ocr,
];

/** Graphs read per cleanup pass; bounds application memory the way the server-side update did. */
export const EDGE_CLEANUP_BATCH = 200;
/** Consecutive passes that may clean nothing before the loop gives up. */
const EDGE_CLEANUP_STALLED_PASSES = 5;
/** Sweeps from the top before the loop gives up on references that keep being added. */
export const EDGE_CLEANUP_MAX_SWEEPS = 5;

type AgentEdge = NonNullable<IAgent['edges']>[number];
type EdgeEndpoint = AgentEdge['from'];

/** An endpoint with `removed` taken out: a list loses those ids; a single id that is one becomes null. */
function pruneEndpoint(
  endpoint: EdgeEndpoint | null | undefined,
  removed: Set<string>,
): EdgeEndpoint | null {
  if (Array.isArray(endpoint)) {
    return endpoint.filter((id) => !removed.has(id));
  }
  return typeof endpoint === 'string' && removed.has(endpoint) ? null : (endpoint ?? null);
}

function hasEndpoint(endpoint: EdgeEndpoint | null): endpoint is EdgeEndpoint {
  return Array.isArray(endpoint) ? endpoint.length > 0 : endpoint != null;
}

/** The edges that survive removing `removed`, with those ids pruned from their endpoints. */
export function pruneEdges(edges: IAgent['edges'], removed: Set<string>): AgentEdge[] {
  return (edges ?? []).flatMap((edge) => {
    const from = pruneEndpoint(edge.from, removed);
    const to = pruneEndpoint(edge.to, removed);
    return hasEndpoint(from) && hasEndpoint(to) ? [{ ...edge, from, to }] : [];
  });
}

interface GraphEdges {
  _id: Types.ObjectId;
  edges?: IAgent['edges'];
}

/**
 * Removes deleted agent references from active graphs in the requested tenant.
 * Graphs are read a page at a time behind an `_id` cursor, and each page's
 * pruned edges are written back behind a compare-and-set on the edges that were
 * read, so a concurrent edit is never overwritten. A graph whose edges changed
 * underneath fails its compare-and-set and is left behind the cursor, so once
 * the cursor is exhausted one more sweep from the top picks up every miss (and
 * any reference added meanwhile); the cleanup ends when a sweep from the top
 * finds nothing, and gives up after a bounded number of sweeps if references
 * keep being added. This is the plain-operator form of what was an
 * aggregation-pipeline update, which Amazon DocumentDB rejects.
 */
async function removeAgentIdsFromEdges(
  Agent: Model<IAgent>,
  agentIds: string[],
  tenantId?: string,
): Promise<void> {
  if (agentIds.length === 0) {
    return;
  }
  const filter: FilterQuery<IAgent> = {
    ...(tenantId !== undefined ? { tenantId } : {}),
    $or: [{ 'edges.from': { $in: agentIds } }, { 'edges.to': { $in: agentIds } }],
  };
  const removed = new Set(agentIds);
  let stalledPasses = 0;
  let sweeps = 0;
  let after: Types.ObjectId | undefined;
  for (;;) {
    const graphs = await Agent.find(after == null ? filter : { ...filter, _id: { $gt: after } })
      .sort({ _id: 1 })
      .limit(EDGE_CLEANUP_BATCH)
      .select('_id edges')
      .lean<GraphEdges[]>();
    if (graphs.length === 0) {
      if (after == null) {
        return;
      }
      sweeps += 1;
      if (sweeps >= EDGE_CLEANUP_MAX_SWEEPS) {
        throw new Error(
          `[removeAgentIdsFromEdges] references kept being added during cleanup (${EDGE_CLEANUP_MAX_SWEEPS} sweeps)`,
        );
      }
      after = undefined;
      continue;
    }
    const result = await tenantSafeBulkWrite(
      Agent,
      graphs.map((graph) => ({
        updateOne: {
          filter: { _id: graph._id, edges: graph.edges },
          update: { $set: { edges: pruneEdges(graph.edges, removed) } },
        },
      })),
      { ordered: false },
    );
    stalledPasses = result.matchedCount === 0 ? stalledPasses + 1 : 0;
    if (stalledPasses >= EDGE_CLEANUP_STALLED_PASSES) {
      throw new Error(
        `[removeAgentIdsFromEdges] graph edges kept changing during cleanup (${EDGE_CLEANUP_STALLED_PASSES} passes without progress)`,
      );
    }
    after = graphs[graphs.length - 1]._id;
  }
}

export interface AgentDeps {
  /** Removes all ACL permissions for a resource. Injected from PermissionService. */
  removeAllPermissions: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
  /** Gets actions. Created by createActionMethods. */
  getActions: (query: ActionQuery, includeSensitive?: boolean) => Promise<unknown[]>;
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
  /** Resolves ACL principals. Kept inside data-schemas so callers pass plain identity. */
  getUserPrincipals: (params: {
    userId: string | Types.ObjectId;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<Array<{ principalType: string; principalId?: string | Types.ObjectId }>>;
  /** Resolves ACL-visible resources. Kept inside data-schemas so callers use logical IDs. */
  findAccessibleResources: (
    principals: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
  ) => Promise<Types.ObjectId[]>;
  /** Recognizes skill IDs supplied by an external, non-database registry. */
  isExternalSkillId?: (id: string) => boolean;
}

/** Plain projection used to discover runnable agent graphs without exposing Mongoose. */
export interface AgentGraphNode {
  id: string;
  provider: string;
  model: string;
  tools?: string[];
  mcpServerNames?: string[];
  agent_ids?: string[];
  edges?: IAgent['edges'];
  subagents?: IAgent['subagents'];
}

export interface AgentGraphAccess {
  userId: string;
  role?: string | null;
  idOnTheSource?: string | null;
}

declare const agentGraphAccessContext: unique symbol;
/** Opaque resolved ACL context. Only data-schemas creates or consumes its contents. */
export type AgentGraphAccessContext = { readonly [agentGraphAccessContext]: true };

/**
 * Extracts unique MCP server names from tools array.
 * Tools format: "toolName_mcp_serverName" or "sys__server__sys_mcp_serverName"
 */
function extractMCPServerNames(tools: string[] | undefined | null): string[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const serverNames = new Set<string>();
  for (const tool of tools) {
    if (!tool || !tool.includes(mcp_delimiter) || isActionTool(tool)) {
      continue;
    }
    const parts = tool.split(mcp_delimiter);
    /** This index only grants DB-backed servers (`ServerConfigsDB.getAccessibleServers`),
     * and DB server names are slugs that cannot contain the delimiter
     * (`generateServerNameFromTitle` strips underscores), so the last segment is always
     * the real server for those. A config server whose own name contains the delimiter
     * yields a trailing segment that is not its name; resolving that needs the configured
     * server list, which is unavailable here - see #14449. */
    if (parts.length >= 2) {
      serverNames.add(parts[parts.length - 1]);
    }
  }
  return Array.from(serverNames);
}

/**
 * Rebuilds an agent's MCP server index across a tools update without re-deriving
 * names from the keys.
 *
 * A name already on the agent was resolved against the registry when it was
 * stored, so it is authoritative; it carries forward while some retained tool
 * still resolves to it. Only keys that match none of them fall back to the
 * ambiguous trailing-segment derivation, which cannot tell a config server's
 * suffix from a real DB server name.
 */
function rebuildMCPServerNames(tools: string[] | undefined | null, priorNames: string[]): string[] {
  if (priorNames.length === 0) {
    return extractMCPServerNames(tools);
  }

  const retained = new Set<string>();
  const unmatched: string[] = [];
  for (const tool of tools ?? []) {
    if (!tool || !tool.includes(mcp_delimiter) || isActionTool(tool)) {
      continue;
    }
    const match = priorNames
      .filter((name) => tool.endsWith(`${mcp_delimiter}${name}`))
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      retained.add(match);
    } else {
      unmatched.push(tool);
    }
  }

  for (const name of extractMCPServerNames(unmatched)) {
    retained.add(name);
  }
  return Array.from(retained);
}

const hasOperatorKeys = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.keys(value as object).length > 0;

/** Resolves a dotted operator path, such as `tool_resources.file_search.file_ids`. */
function resolveDocumentPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current =
      current instanceof Map ? current.get(segment) : (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Removes a dotted operator path from an in-memory version projection. */
function deleteDocumentPath(source: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf == null) return;
  let current: Record<string, unknown> = source;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== 'object' || next === null || next instanceof Map) return;
    current = next as Record<string, unknown>;
  }
  delete current[leaf];
}

/** The values an `$addToSet` specification would add, flattening the `$each` form. */
function addToSetCandidates(spec: unknown): unknown[] {
  if (
    typeof spec === 'object' &&
    spec !== null &&
    Array.isArray((spec as { $each?: unknown }).$each)
  ) {
    return (spec as { $each: unknown[] }).$each;
  }
  return [spec];
}

/**
 * Whether an update's atomic operators can still change the stored document. `$push`
 * always appends and `$pull` matches on arbitrary query criteria, so both count as
 * mutating. `$addToSet` is a no-op once every value it adds is already stored, which is
 * exactly what an idempotent retry looks like, so it is resolved against the document.
 * Whatever cannot be compared cheaply counts as mutating: over-reporting only records a
 * redundant version, while under-reporting would apply a change no version records.
 */
function operatorsMutateDocument(
  currentObject: Record<string, unknown>,
  $push: unknown,
  $pull: unknown,
  $addToSet: unknown,
  $unset: unknown,
): boolean {
  if (hasOperatorKeys($push) || hasOperatorKeys($pull)) {
    return true;
  }

  if (hasOperatorKeys($unset)) {
    for (const path of Object.keys($unset as Record<string, unknown>)) {
      if (resolveDocumentPath(currentObject, path) !== undefined) return true;
    }
  }

  if (!hasOperatorKeys($addToSet)) {
    return false;
  }

  for (const [path, spec] of Object.entries($addToSet as Record<string, unknown>)) {
    const existing = resolveDocumentPath(currentObject, path);
    const stored = Array.isArray(existing) ? existing : [];
    for (const candidate of addToSetCandidates(spec)) {
      if (typeof candidate === 'object' && candidate !== null) {
        return true;
      }
      if (!stored.includes(candidate)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a version already exists in the versions array, excluding timestamp and author fields.
 */
function isDuplicateVersion(
  updateData: Record<string, unknown>,
  currentData: Record<string, unknown>,
  versions: Record<string, unknown>[],
  actionsHash: string | null = null,
): Record<string, unknown> | null {
  if (!versions || versions.length === 0) {
    return null;
  }

  const excludeFields = [
    '_id',
    'id',
    'createdAt',
    'updatedAt',
    'author',
    'updatedBy',
    'created_at',
    'updated_at',
    '__v',
    'versions',
    'actionsHash',
  ];

  const {
    $push: _$push,
    $pull: _$pull,
    $addToSet: _$addToSet,
    $unset,
    ...directUpdates
  } = updateData;

  if (Object.keys(directUpdates).length === 0 && !hasOperatorKeys($unset) && !actionsHash) {
    return null;
  }

  const wouldBeVersion = { ...currentData, ...directUpdates } as Record<string, unknown>;
  if (hasOperatorKeys($unset)) {
    for (const path of Object.keys($unset as Record<string, unknown>)) {
      deleteDocumentPath(wouldBeVersion, path);
    }
  }
  const lastVersion = versions[versions.length - 1] as Record<string, unknown>;

  if (actionsHash && lastVersion.actionsHash !== actionsHash) {
    return null;
  }

  const allFields = new Set([...Object.keys(wouldBeVersion), ...Object.keys(lastVersion)]);
  const importantFields = Array.from(allFields).filter((field) => !excludeFields.includes(field));

  let isMatch = true;
  for (const field of importantFields) {
    const wouldBeValue = wouldBeVersion[field];
    const lastVersionValue = lastVersion[field];

    if (!wouldBeValue && !lastVersionValue) {
      continue;
    }

    // Handle arrays
    if (Array.isArray(wouldBeValue) || Array.isArray(lastVersionValue)) {
      let wouldBeArr: unknown[];
      if (Array.isArray(wouldBeValue)) {
        wouldBeArr = wouldBeValue;
      } else if (wouldBeValue == null) {
        wouldBeArr = [];
      } else {
        wouldBeArr = [wouldBeValue];
      }

      let lastVersionArr: unknown[];
      if (Array.isArray(lastVersionValue)) {
        lastVersionArr = lastVersionValue;
      } else if (lastVersionValue == null) {
        lastVersionArr = [];
      } else {
        lastVersionArr = [lastVersionValue];
      }

      if (wouldBeArr.length !== lastVersionArr.length) {
        isMatch = false;
        break;
      }

      if (wouldBeArr.length > 0 && typeof wouldBeArr[0] === 'object' && wouldBeArr[0] !== null) {
        const sortedWouldBe = [...wouldBeArr].map((item) => JSON.stringify(item)).sort();
        const sortedVersion = [...lastVersionArr].map((item) => JSON.stringify(item)).sort();

        if (!sortedWouldBe.every((item, i) => item === sortedVersion[i])) {
          isMatch = false;
          break;
        }
      } else {
        const sortedWouldBe = [...wouldBeArr].sort() as string[];
        const sortedVersion = [...lastVersionArr].sort() as string[];

        if (!sortedWouldBe.every((item, i) => item === sortedVersion[i])) {
          isMatch = false;
          break;
        }
      }
    }
    // Handle objects
    else if (typeof wouldBeValue === 'object' && wouldBeValue !== null) {
      const lastVersionObj =
        typeof lastVersionValue === 'object' && lastVersionValue !== null ? lastVersionValue : {};

      const wouldBeKeys = Object.keys(wouldBeValue as Record<string, unknown>);
      const lastVersionKeys = Object.keys(lastVersionObj as Record<string, unknown>);

      if (wouldBeKeys.length === 0 && lastVersionKeys.length === 0) {
        continue;
      }

      if (JSON.stringify(wouldBeValue) !== JSON.stringify(lastVersionObj)) {
        isMatch = false;
        break;
      }
    }
    // Handle primitive values
    else {
      if (wouldBeValue !== lastVersionValue) {
        if (
          typeof wouldBeValue === 'boolean' &&
          wouldBeValue === false &&
          lastVersionValue === undefined
        ) {
          continue;
        }
        if (
          typeof wouldBeValue === 'string' &&
          wouldBeValue === '' &&
          lastVersionValue === undefined
        ) {
          continue;
        }
        isMatch = false;
        break;
      }
    }
  }

  return isMatch ? lastVersion : null;
}

/**
 * Generates a hash of action metadata for version comparison.
 */
async function generateActionMetadataHash(
  actionIds: string[] | null | undefined,
  actions: Array<{ action_id: string; metadata: Record<string, unknown> | null }>,
): Promise<string> {
  if (!actionIds || actionIds.length === 0) {
    return '';
  }

  const actionMap = new Map<string, Record<string, unknown> | null>();
  actions.forEach((action) => {
    actionMap.set(action.action_id, action.metadata);
  });

  const sortedActionIds = [...actionIds].sort();

  const metadataString = sortedActionIds
    .map((actionFullId) => {
      const parts = actionFullId.split(actionDelimiter);
      const actionId = parts[1];

      const metadata = actionMap.get(actionId);
      if (!metadata) {
        return `${actionId}:null`;
      }

      const sortedKeys = Object.keys(metadata).sort();
      const metadataStr = sortedKeys
        .map((key) => `${key}:${JSON.stringify(metadata[key])}`)
        .join(',');
      return `${actionId}:{${metadataStr}}`;
    })
    .join(';');

  const encoder = new TextEncoder();
  const data = encoder.encode(metadataString);
  const hashBuffer = await crypto.webcrypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

export interface GetAgent {
  (searchParameter: FilterQuery<IAgent>): Promise<Omit<IAgent, 'versions'> | null>;
  (
    searchParameter: FilterQuery<IAgent>,
    projection: ProjectionType<IAgent>,
  ): Promise<IAgent | null>;
}

export function createAgentMethods(
  mongoose: typeof import('mongoose'),
  deps: AgentDeps,
): {
  getAgent: GetAgent;
  getAgentVersions: (searchParameter: FilterQuery<IAgent>) => Promise<IAgent['versions'] | null>;
  getAgentWithVersionCount: (
    searchParameter: FilterQuery<IAgent>,
  ) => Promise<(IAgent & { version: number }) | null>;
  getAgents: (
    searchParameter: FilterQuery<IAgent>,
    select?: string | Record<string, number>,
  ) => Promise<IAgent[]>;
  resolveAgentGraphAccess: (access: AgentGraphAccess) => Promise<AgentGraphAccessContext>;
  getAgentGraphNodes: (
    ids: string[],
    access?: AgentGraphAccessContext,
  ) => Promise<AgentGraphNode[]>;
  createAgent: (agentData: Record<string, unknown>) => Promise<IAgent>;
  getAgentIdsByMCPServerName: (serverName: string) => Promise<Types.ObjectId[]>;
  getAgentsWithMCPServerNames: () => Promise<Array<Pick<IAgent, '_id' | 'mcpServerNames'>>>;
  updateAgent: (
    searchParameter: FilterQuery<IAgent>,
    updateData: Record<string, unknown>,
    options?: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    },
  ) => Promise<IAgent | null>;
  updateAgentAvatar: (params: {
    id: string;
    avatar: { filepath: string; source: string };
    /** The avatar the caller read. When given, the write only lands while the stored avatar
     *  still matches it. */
    previousAvatar?: { filepath: string; source: string } | null;
  }) => Promise<boolean>;
  deleteAgent: (searchParameter: FilterQuery<IAgent>) => Promise<IAgent | null>;
  deleteUserAgents: (userId: string) => Promise<void>;
  revertAgentVersion: (
    searchParameter: FilterQuery<IAgent>,
    versionIndex: number,
  ) => Promise<IAgent>;
  countPromotedAgents: () => Promise<number>;
  addAgentResourceFile: ({
    agent_id,
    tool_resource,
    file_id,
    updatingUserId,
  }: {
    agent_id: string;
    tool_resource: string;
    file_id: string;
    updatingUserId?: string;
  }) => Promise<IAgent>;
  getListAgentsByAccess: ({
    accessibleIds,
    otherParams,
    tenantId,
    limit,
    after,
    includeSkillConfig,
    includeExecutionConfig,
    sort,
  }: {
    accessibleIds?: Array<Types.ObjectId | string> | null;
    otherParams?: Record<string, unknown>;
    /** Authenticated tenant for unrestricted listings; null/omitted restricts to legacy agents. */
    tenantId?: string | null;
    limit?: number | null;
    after?: string | null;
    includeSkillConfig?: boolean;
    includeExecutionConfig?: boolean;
    sort?: AgentListSortOption;
  }) => Promise<{
    object: string;
    data: Array<Record<string, unknown>>;
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }>;
  getAgentManagementListByAccess: ({
    accessibleIds,
    tenantId,
    limit,
    after,
  }: {
    /** `null` means the caller already passed the unrestricted management-capability check. */
    accessibleIds: Types.ObjectId[] | null;
    tenantId: string;
    limit: number;
    after?: string | null;
  }) => Promise<{
    data: Array<IAgent & { version: number; createdAt: Date; updatedAt: Date }>;
    has_more: boolean;
    after: string | null;
  }>;
  removeAgentResourceFiles: ({
    agent_id,
    files,
  }: {
    agent_id: string;
    files: Array<{ tool_resource: string; file_id: string }>;
  }) => Promise<IAgent>;
  generateActionMetadataHash: typeof generateActionMetadataHash;
  removeAgentFromUserFavorites: (resourceId: string, userIds: string[]) => Promise<void>;
  removeAgentResourceFilesFromAllAgents: ({
    file_ids,
  }: {
    file_ids: string[];
  }) => Promise<{ matchedCount: number; modifiedCount: number }>;
  getSharedResourceFileIds: ({
    file_ids,
    excludeAgentObjectId,
    excludeToolResource,
  }: {
    file_ids: string[];
    excludeAgentObjectId?: string;
    excludeToolResource?: string;
  }) => Promise<string[]>;
} {
  const { removeAllPermissions, getActions, getSoleOwnedResourceIds, isExternalSkillId } = deps;

  async function restoreAgentAfterReferenceLoss(
    Agent: Model<IAgent>,
    agentAfterWrite: IAgent | null,
    originalAgent: IAgent,
    lostEnvironmentId: string,
  ): Promise<void> {
    if (agentAfterWrite == null) return;
    const { updatedAt } = agentAfterWrite as IAgent & { updatedAt: Date };
    const restored = await Agent.replaceOne(
      {
        _id: agentAfterWrite._id,
        code_environment_id: lostEnvironmentId,
        updatedAt,
      },
      originalAgent,
      { timestamps: false },
    );
    if (restored.matchedCount === 0) {
      /** A concurrent writer may have changed the document after the guarded
       * write. Never erase that writer, but still remove the lost reference if
       * it remains active. */
      await Agent.updateOne(
        { _id: agentAfterWrite._id, code_environment_id: lostEnvironmentId },
        { $unset: { code_environment_id: 1 } },
      );
    }
  }

  /**
   * Create an agent with the provided data.
   */
  async function createAgent(agentData: Record<string, unknown>): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    if (Array.isArray(agentData.skills) && agentData.skills.length > 0) {
      const prunedSkills = await filterExistingSkillIds(
        mongoose,
        agentData.skills as string[],
        isExternalSkillId,
      );
      agentData.skills = prunedSkills;
      /** Fail closed when pruning empties a non-empty allowlist: empty +
       *  enabled means the full catalog, and hygiene must never widen scope.
       *  See `requiresSkillsDisable` for which scopes opt out. */
      if (prunedSkills.length === 0 && requiresSkillsDisable(agentData.skills_scope)) {
        agentData.skills_enabled = false;
      }
    }
    const { author: _author, ...versionData } = agentData;
    const timestamp = new Date();
    const initialAgentData = {
      ...agentData,
      versions: [
        {
          ...versionData,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      category: (agentData.category as string) || 'general',
      /** Callers that authorized the tools pass resolved names; deriving from the key
       * alone cannot tell a config server's suffix from a real DB server name. */
      mcpServerNames:
        (agentData.mcpServerNames as string[] | undefined) ??
        extractMCPServerNames(agentData.tools as string[] | undefined),
    };

    return await withCodeEnvironmentReference(
      mongoose,
      typeof agentData.code_environment_id === 'string' ? agentData.code_environment_id : undefined,
      async () => (await Agent.create(initialAgentData)).toObject() as IAgent,
      undefined,
      async (createdAgent) => {
        await Agent.deleteOne({ _id: createdAgent._id });
      },
    );
  }

  /**
   * Get an agent document based on the provided search parameter.
   * Without an explicit projection, the unbounded `versions` history is excluded;
   * pass `{}` (or a projection including `versions`) to read the full history.
   */
  const getAgent: GetAgent = async (
    searchParameter: FilterQuery<IAgent>,
    projection: ProjectionType<IAgent> = { versions: 0 },
  ): Promise<IAgent | null> => {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.findOne(searchParameter, projection).lean<IAgent>();
  };

  /**
   * Get an agent's version history only, without the rest of the document.
   * Returns an empty array when the agent exists but has no versions, or `null`
   * when no agent matches the search parameter.
   */
  async function getAgentVersions(
    searchParameter: FilterQuery<IAgent>,
  ): Promise<IAgent['versions'] | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const result = await Agent.findOne(searchParameter, { versions: 1, _id: 0 }).lean<
      Pick<IAgent, 'versions'>
    >();
    if (!result) {
      return null;
    }
    return result.versions ?? [];
  }

  /**
   * Get an agent document with a `version` count, excluding the heavy `versions` array.
   * Used when loading the editor so large version histories aren't transferred eagerly.
   */
  async function getAgentWithVersionCount(
    searchParameter: FilterQuery<IAgent>,
  ): Promise<(IAgent & { version: number }) | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const [agent] = await Agent.aggregate<IAgent & { version: number }>([
      { $match: searchParameter },
      { $addFields: { version: { $size: { $ifNull: ['$versions', []] } } } },
      { $project: { versions: 0 } },
    ]);
    return agent ?? null;
  }

  /**
   * Get multiple agent documents based on the provided search parameters.
   */
  async function getAgents(
    searchParameter: FilterQuery<IAgent>,
    select?: string | Record<string, number>,
  ): Promise<IAgent[]> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.find(searchParameter, select).lean<IAgent[]>();
  }

  /**
   * Loads a bounded graph frontier by logical agent ID and optionally applies VIEW ACLs.
   * Storage IDs are used only inside this method and never cross the package boundary.
   */
  async function resolveAgentGraphAccess(
    access: AgentGraphAccess,
  ): Promise<AgentGraphAccessContext> {
    return (await deps.getUserPrincipals(access)) as unknown as AgentGraphAccessContext;
  }

  async function getAgentGraphNodes(
    ids: string[],
    access?: AgentGraphAccessContext,
  ): Promise<AgentGraphNode[]> {
    if (ids.length === 0) {
      return [];
    }
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agents = await Agent.find(
      { id: { $in: ids } },
      {
        _id: 1,
        id: 1,
        provider: 1,
        model: 1,
        tools: 1,
        mcpServerNames: 1,
        agent_ids: 1,
        edges: 1,
        subagents: 1,
      },
    ).lean<
      Array<
        Pick<
          IAgent,
          | '_id'
          | 'id'
          | 'provider'
          | 'model'
          | 'tools'
          | 'mcpServerNames'
          | 'agent_ids'
          | 'edges'
          | 'subagents'
        >
      >
    >();
    let visible = agents;
    if (access != null) {
      const principals = access as unknown as Array<{
        principalType: string;
        principalId?: string | Types.ObjectId;
      }>;
      const resourceIds = await deps.findAccessibleResources(
        principals,
        ResourceType.AGENT,
        PermissionBits.VIEW,
        agents.map((agent) => agent._id),
      );
      const allowed = new Set(resourceIds.map(String));
      visible = agents.filter((agent) => allowed.has(String(agent._id)));
    }
    return visible.map(
      ({ id, provider, model, tools, mcpServerNames, agent_ids, edges, subagents }) => ({
        id,
        provider,
        model,
        tools,
        mcpServerNames,
        agent_ids,
        edges,
        subagents,
      }),
    );
  }

  /** Returns the ids of every agent referencing `serverName`, the candidate set
   *  for agent-mediated MCP access checks. Index-covered by `mcpServerNames`. */
  async function getAgentIdsByMCPServerName(serverName: string): Promise<Types.ObjectId[]> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agents = await Agent.find({ mcpServerNames: serverName }, { _id: 1 }).lean<
      Array<Pick<IAgent, '_id'>>
    >();
    return agents.map((agent) => agent._id);
  }

  /** Returns every agent with a non-empty `mcpServerNames`, so access
   *  calculations can start from the (typically small) set of agents that
   *  actually reference MCP servers instead of every accessible agent. */
  async function getAgentsWithMCPServerNames(): Promise<
    Array<Pick<IAgent, '_id' | 'mcpServerNames'>>
  > {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.find({ mcpServerNames: { $type: 'string' } }, { mcpServerNames: 1 }).lean<
      Array<Pick<IAgent, '_id' | 'mcpServerNames'>>
    >();
  }

  /**
   * Update an agent with new data without overwriting existing properties,
   * or create a new agent if it doesn't exist.
   * When an agent is updated, a copy of the current state will be saved to the versions array.
   */
  async function updateAgent(
    searchParameter: FilterQuery<IAgent>,
    updateData: Record<string, unknown>,
    options: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    } = {},
  ): Promise<IAgent | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const { updatingUserId = null, forceVersion = false, skipVersioning = false } = options;
    const mongoOptions = { new: true, upsert: false };
    /** Set when the update would snapshot a version identical to the newest one. The write
     *  still lands; only the `versions` entry is dropped. */
    let suppressedVersionEntry = false;

    const currentAgent = await Agent.findOne(searchParameter);
    const currentRevision = (currentAgent as (IAgent & { updatedAt: Date }) | null)?.updatedAt;
    if (currentAgent) {
      const currentObject = currentAgent.toObject() as unknown as Record<string, unknown>;
      const { __v, _id, id: __id, versions, author: _author, ...versionData } = currentObject;
      const { $push, $pull, $addToSet, $unset, ...directUpdates } = updateData;

      /** Self-heal: drop allowlist ids whose skill no longer exists in the
       *  database or the external registry.
       *  A dangling id keeps the allowlist non-empty while scoping the
       *  runtime catalog to an empty intersection, silently disabling
       *  skills for the agent. When pruning empties a non-empty allowlist,
       *  fail closed and disable skills: empty + enabled means the full
       *  catalog, and hygiene must never widen scope. (An explicit user
       *  `skills: []` submission skips this branch and keeps the
       *  full-catalog semantics.)
       *
       *  An `all` or `selected` scope opts out, from the payload or the
       *  stored document, because it already defines what an empty allowlist
       *  means. See `requiresSkillsDisable`. */
      if (Array.isArray(directUpdates.skills) && directUpdates.skills.length > 0) {
        const prunedSkills = await filterExistingSkillIds(
          mongoose,
          directUpdates.skills as string[],
          isExternalSkillId,
        );
        directUpdates.skills = prunedSkills;
        updateData.skills = prunedSkills;
        const effectiveScope =
          (directUpdates as Record<string, unknown>).skills_scope ?? currentObject.skills_scope;
        if (prunedSkills.length === 0 && requiresSkillsDisable(effectiveScope)) {
          directUpdates.skills_enabled = false;
          updateData.skills_enabled = false;
        }
      }

      // Sync mcpServerNames when tools are updated
      if ((directUpdates as Record<string, unknown>).tools !== undefined) {
        /** Callers that authorized the tools pass resolved names; deriving from the key
         * alone cannot tell a config server's suffix from a real DB server name. */
        const supplied = (directUpdates as Record<string, unknown>).mcpServerNames as
          | string[]
          | undefined;
        const mcpServerNames =
          supplied ??
          rebuildMCPServerNames(
            (directUpdates as Record<string, unknown>).tools as string[],
            (currentAgent.mcpServerNames as string[] | undefined) ?? [],
          );
        (directUpdates as Record<string, unknown>).mcpServerNames = mcpServerNames;
        updateData.mcpServerNames = mcpServerNames;
      }

      let actionsHash: string | null = null;

      // Generate actions hash if agent has actions
      if (currentAgent.actions && currentAgent.actions.length > 0) {
        const actionIds = currentAgent.actions
          .map((action: string) => {
            const parts = action.split(actionDelimiter);
            return parts[1];
          })
          .filter(Boolean);

        if (actionIds.length > 0) {
          try {
            const actions = await getActions({ actionId: actionIds }, true);

            actionsHash = await generateActionMetadataHash(
              currentAgent.actions,
              actions as Array<{ action_id: string; metadata: Record<string, unknown> | null }>,
            );
          } catch (error) {
            logger.error('Error fetching actions for hash generation:', error);
          }
        }
      }

      const shouldCreateVersion =
        !skipVersioning &&
        (forceVersion ||
          Object.keys(directUpdates).length > 0 ||
          $push ||
          $pull ||
          $addToSet ||
          $unset);

      if (shouldCreateVersion) {
        const duplicateVersion = isDuplicateVersion(
          updateData,
          versionData,
          versions as Record<string, unknown>[],
          actionsHash,
        );
        /** A duplicate snapshot adds no history, but the write itself must still land: the
         *  document is regularly not equal to its newest version, because `$push`/`$pull`/
         *  `$addToSet` snapshot the pre-update state and `skipVersioning` snapshots nothing.
         *  `isDuplicateVersion` compares direct updates only, so it cannot speak for an
         *  update that also carries an operator that lands a change; suppressing there
         *  would apply a change no version records. An operator that changes nothing, the
         *  shape of an idempotent retry, leaves the snapshot a genuine duplicate. */
        const mutatesOutsideSnapshot = operatorsMutateDocument(
          currentObject,
          $push,
          $pull,
          $addToSet,
          $unset,
        );
        if (duplicateVersion && !forceVersion && !mutatesOutsideSnapshot) {
          suppressedVersionEntry = true;
          /** Every operator that reaches here was judged unable to change the document,
           *  and for `$addToSet` that reading came from a document fetched before the
           *  write, so it cannot bind a concurrent one: a `$pull` landing in between would
           *  leave this update re-adding the value with no version entry to record it.
           *  Drop what was judged a no-op rather than race it, so the suppressed write
           *  carries no operator at all and is true by construction instead of true only
           *  while nothing else writes first. */
          delete updateData.$addToSet;
          delete updateData.$push;
          delete updateData.$pull;
          delete updateData.$unset;
        }
      }

      const versionEntry: Record<string, unknown> = {
        ...versionData,
        ...directUpdates,
        updatedAt: new Date(),
      };
      if (hasOperatorKeys($unset)) {
        for (const path of Object.keys($unset as Record<string, unknown>)) {
          deleteDocumentPath(versionEntry, path);
        }
      }

      if (actionsHash) {
        versionEntry.actionsHash = actionsHash;
      }

      if (updatingUserId) {
        versionEntry.updatedBy = new mongoose.Types.ObjectId(updatingUserId);
      }

      if (shouldCreateVersion && !suppressedVersionEntry) {
        updateData.$push = {
          ...(($push as Record<string, unknown>) || {}),
          versions: versionEntry,
        };
      }
    }

    const directEnvironmentId = updateData.code_environment_id;
    const setEnvironmentId =
      typeof updateData.$set === 'object' && updateData.$set != null
        ? (updateData.$set as { code_environment_id?: unknown }).code_environment_id
        : undefined;
    let nextEnvironmentId: string | undefined;
    if (typeof directEnvironmentId === 'string') {
      nextEnvironmentId = directEnvironmentId;
    } else if (typeof setEnvironmentId === 'string') {
      nextEnvironmentId = setEnvironmentId;
    }
    const updatedAgent = await withCodeEnvironmentReference(
      mongoose,
      nextEnvironmentId,
      async () =>
        (await Agent.findOneAndUpdate(
          currentAgent == null || nextEnvironmentId == null
            ? searchParameter
            : { ...searchParameter, _id: currentAgent._id, updatedAt: currentRevision },
          updateData,
          mongoOptions,
        ).lean()) as IAgent | null,
      undefined,
      async (agentAfterUpdate) => {
        if (agentAfterUpdate == null || nextEnvironmentId == null) return;
        if (currentAgent == null) return;
        await restoreAgentAfterReferenceLoss(
          Agent,
          agentAfterUpdate,
          currentAgent.toObject() as IAgent,
          nextEnvironmentId,
        );
      },
    );

    /** `version` is a response-only field holding the count of `versions`. It is reported
     *  here so a suppressed entry keeps the shape callers saw before the write was fixed.
     *  It answers "was a version recorded", never "did the update apply". The two stopped
     *  being the same question once a suppressed update started landing. */
    if (updatedAgent && suppressedVersionEntry) {
      (updatedAgent as IAgent & { version?: number }).version = updatedAgent.versions?.length ?? 0;
    }

    return updatedAgent;
  }

  /** Updates only the stored avatar metadata; maintenance must not advance list cursors. */
  async function updateAgentAvatar({
    id,
    avatar,
    previousAvatar,
  }: {
    id: string;
    avatar: { filepath: string; source: string };
    previousAvatar?: { filepath: string; source: string } | null;
  }): Promise<boolean> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const searchParameter: FilterQuery<IAgent> = { id };
    if (previousAvatar === null) {
      searchParameter.avatar = null;
    } else if (previousAvatar !== undefined) {
      searchParameter['avatar.filepath'] = previousAvatar.filepath;
      searchParameter['avatar.source'] = previousAvatar.source;
    }
    const result = await Agent.updateOne(
      searchParameter,
      { $set: { avatar } },
      { timestamps: false },
    );
    return result.matchedCount > 0;
  }

  /**
   * Modifies an agent with the resource file id.
   */
  async function addAgentResourceFile({
    agent_id,
    tool_resource,
    file_id,
    updatingUserId,
  }: {
    agent_id: string;
    tool_resource: string;
    file_id: string;
    updatingUserId?: string;
  }): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const searchParameter = { id: agent_id };
    const agent = await getAgent(searchParameter);
    if (!agent) {
      throw new Error('Agent not found for adding resource file');
    }
    const fileIdsPath = `tool_resources.${tool_resource}.file_ids`;
    await Agent.updateOne(
      {
        id: agent_id,
        [`${fileIdsPath}`]: { $exists: false },
      },
      {
        $set: {
          [`${fileIdsPath}`]: [],
        },
      },
    );

    const updateDataObj: Record<string, unknown> = {
      $addToSet: {
        tools: tool_resource,
        [fileIdsPath]: file_id,
      },
    };

    const updatedAgent = await updateAgent(searchParameter, updateDataObj, {
      updatingUserId,
    });
    if (updatedAgent) {
      return updatedAgent;
    } else {
      throw new Error('Agent not found for adding resource file');
    }
  }

  /**
   * Removes multiple resource files from an agent using atomic operations.
   */
  async function removeAgentResourceFiles({
    agent_id,
    files,
  }: {
    agent_id: string;
    files: Array<{ tool_resource: string; file_id: string }>;
  }): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const searchParameter = { id: agent_id };

    const filesByResource = files.reduce(
      (acc: Record<string, string[]>, { tool_resource, file_id }) => {
        if (!acc[tool_resource]) {
          acc[tool_resource] = [];
        }
        acc[tool_resource].push(file_id);
        return acc;
      },
      {},
    );

    const pullAllOps: Record<string, string[]> = {};
    for (const [resource, fileIds] of Object.entries(filesByResource)) {
      const fileIdsPath = `tool_resources.${resource}.file_ids`;
      pullAllOps[fileIdsPath] = fileIds;
    }

    const updatePullData = { $pullAll: pullAllOps };
    const agentAfterPull = (await Agent.findOneAndUpdate(searchParameter, updatePullData, {
      new: true,
    }).lean()) as IAgent | null;

    if (!agentAfterPull) {
      const agentExists = await getAgent(searchParameter);
      if (!agentExists) {
        throw new Error('Agent not found for removing resource files');
      }
      throw new Error('Failed to update agent during file removal (pull step)');
    }

    return agentAfterPull;
  }

  /**
   * Removes the given file_ids from every agent's `tool_resources.*.file_ids`
   * so file deletion cannot leave orphaned stubs behind (see issue #12776).
   */
  async function removeAgentResourceFilesFromAllAgents({
    file_ids,
  }: {
    file_ids: string[];
  }): Promise<{ matchedCount: number; modifiedCount: number }> {
    if (!file_ids || file_ids.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const Agent = mongoose.models.Agent as Model<IAgent>;

    const orQuery = TOOL_RESOURCE_KEYS.map((key) => ({
      [`tool_resources.${key}.file_ids`]: { $in: file_ids },
    }));

    const pullAllOps = TOOL_RESOURCE_KEYS.reduce<Record<string, string[]>>((acc, key) => {
      acc[`tool_resources.${key}.file_ids`] = file_ids;
      return acc;
    }, {});

    const result = await Agent.updateMany({ $or: orQuery }, { $pullAll: pullAllOps });
    return {
      matchedCount: result.matchedCount ?? 0,
      modifiedCount: result.modifiedCount ?? 0,
    };
  }

  /**
   * Reports which of the given file_ids keep a reference once the caller's own is removed, so a
   * caller can tell a last reference from a shared one.
   *
   * The unit of a reference is the `(agent, tool_resource)` pair rather than the agent:
   * `addAgentResourceFile` stores `file_ids` per resource, so one agent can hold the same file under
   * both `file_search` and `context`, and removing it from one leaves the other needing the bytes.
   * `excludeToolResource` narrows the exclusion to the pair being removed; omitting it excludes the
   * whole agent.
   *
   * The agent is excluded by `_id`, because `id` is unique only together with `tenantId`: matching on
   * `id` alone would skip another tenant's agent of the same name and call its file unreferenced.
   *
   * Duplicating an agent copies `file_ids` rather than the files behind them, so one file record
   * can back two agents; destroying its bytes on behalf of one agent would empty the other. This
   * is deliberately not scoped by tenant: a reference is a reference, whoever holds it.
   */
  async function getSharedResourceFileIds({
    file_ids,
    excludeAgentObjectId,
    excludeToolResource,
  }: {
    file_ids: string[];
    excludeAgentObjectId?: string;
    excludeToolResource?: string;
  }): Promise<string[]> {
    if (!file_ids || file_ids.length === 0) {
      return [];
    }

    const Agent = mongoose.models.Agent as Model<IAgent>;
    const requested = new Set(file_ids);
    const searchParameter: FilterQuery<IAgent> = {
      $or: TOOL_RESOURCE_KEYS.map((key) => ({
        [`tool_resources.${key}.file_ids`]: { $in: file_ids },
      })),
    };

    const agents = await Agent.find(searchParameter, { _id: 1, tool_resources: 1 }).lean();
    const shared = new Set<string>();
    for (const agent of agents) {
      const isExcludedAgent =
        excludeAgentObjectId != null && String(agent._id) === excludeAgentObjectId;
      for (const key of TOOL_RESOURCE_KEYS) {
        if (isExcludedAgent && (excludeToolResource == null || key === excludeToolResource)) {
          continue;
        }
        const fileIds = agent.tool_resources?.[key]?.file_ids;
        if (fileIds == null) {
          continue;
        }
        for (const fileId of fileIds) {
          if (requested.has(fileId)) {
            shared.add(fileId);
          }
        }
      }
    }

    return [...shared];
  }

  /**
   * Deletes an agent based on the provided search parameter.
   */
  async function deleteAgent(searchParameter: FilterQuery<IAgent>): Promise<IAgent | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const User = mongoose.models.User as Model<unknown>;
    const agent = await Agent.findOneAndDelete(searchParameter);
    if (agent) {
      const deletedAgent = agent as unknown as { id: string; tenantId?: string };
      await Promise.all([
        removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
        }),
        removeAllPermissions({
          resourceType: ResourceType.REMOTE_AGENT,
          resourceId: agent._id,
        }),
      ]);
      try {
        await removeAgentIdsFromEdges(Agent, [deletedAgent.id], deletedAgent.tenantId);
      } catch (error) {
        logger.error('[deleteAgent] Error removing agent from handoff edges', error);
      }
      try {
        await User.updateMany(
          {
            ...(deletedAgent.tenantId !== undefined ? { tenantId: deletedAgent.tenantId } : {}),
            'favorites.agentId': deletedAgent.id,
          },
          { $pull: { favorites: { agentId: deletedAgent.id } } },
        );
      } catch (error) {
        logger.error('[deleteAgent] Error removing agent from user favorites', error);
      }
    }
    return agent ? (agent.toObject() as IAgent) : null;
  }

  /**
   * Deletes agents solely owned by the user and cleans up their ACLs.
   * Agents with other owners are left intact; the caller is responsible for
   * removing the user's own ACL principal entries separately.
   *
   * Also handles legacy (pre-ACL) agents that only have the author field set,
   * ensuring they are not orphaned if no permission migration has been run.
   */
  async function deleteUserAgents(userId: string): Promise<void> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const User = mongoose.models.User as Model<unknown>;

    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const soleOwnedObjectIds = await getSoleOwnedResourceIds(userObjectId, [
        ResourceType.AGENT,
        ResourceType.REMOTE_AGENT,
      ]);

      const authoredAgents = await Agent.find({ author: userObjectId }).select('id _id').lean();

      const migratedEntries =
        authoredAgents.length > 0
          ? await AclEntry.find({
              resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
              resourceId: { $in: authoredAgents.map((a) => a._id) },
            })
              .select('resourceId')
              .lean()
          : [];
      const migratedIds = new Set(migratedEntries.map((e) => e.resourceId.toString()));
      const legacyAgents = authoredAgents.filter((a) => !migratedIds.has(a._id.toString()));

      const soleOwnedAgents =
        soleOwnedObjectIds.length > 0
          ? await Agent.find({ _id: { $in: soleOwnedObjectIds } })
              .select('id _id')
              .lean()
          : [];

      const allAgents = [...soleOwnedAgents, ...legacyAgents];

      if (allAgents.length === 0) {
        return;
      }

      const agentIds = allAgents.map((agent) => agent.id);
      const agentObjectIds = allAgents.map((agent) => agent._id);

      await AclEntry.deleteMany({
        resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
        resourceId: { $in: agentObjectIds },
      });

      try {
        await removeAgentIdsFromEdges(Agent, agentIds);
      } catch (error) {
        logger.error('[deleteUserAgents] Error removing agents from handoff edges', error);
      }

      try {
        await User.updateMany(
          { 'favorites.agentId': { $in: agentIds } },
          { $pull: { favorites: { agentId: { $in: agentIds } } } },
        );
      } catch (error) {
        logger.error('[deleteUserAgents] Error removing agents from user favorites', error);
      }

      await Agent.deleteMany({ _id: { $in: agentObjectIds } });
    } catch (error) {
      logger.error('[deleteUserAgents] General error:', error);
    }
  }

  /**
   * Get agents by accessible IDs with cursor pagination. Pass `accessibleIds: null`
   * only after a management-capability check, with the authenticated tenantId
   * (or null for legacy agents); `[]` and omitted IDs match nothing.
   * Defaults to the most-recently-edited order and a 100-page limit (max 1000);
   * pass `limit: null` to opt out entirely. Other sort modes preserve the projection.
   */
  async function getListAgentsByAccess({
    accessibleIds = [],
    otherParams = {},
    tenantId,
    limit = 100,
    after = null,
    includeSkillConfig = false,
    includeExecutionConfig = false,
    sort: sortInput = 'recent',
  }: {
    accessibleIds?: Array<Types.ObjectId | string> | null;
    otherParams?: Record<string, unknown>;
    tenantId?: string | null;
    limit?: number | null;
    after?: string | null;
    includeSkillConfig?: boolean;
    includeExecutionConfig?: boolean;
    sort?: AgentListSortOption;
  }): Promise<{
    object: string;
    data: Array<Record<string, unknown>>;
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const isPaginated = limit !== null && limit !== undefined;
    const normalizedLimit = isPaginated
      ? Math.min(Math.max(1, parseInt(String(limit)) || 20), 1000)
      : null;
    // The HTTP layer allowlists `sort`, but this method is also called directly by
    // internal callers, and everything below indexes `AGENT_SORT_CONFIG` by it.
    const sort: AgentListSortOption = AGENT_SORT_CONFIG[sortInput] != null ? sortInput : 'recent';

    const baseQuery: Record<string, unknown> = {
      ...otherParams,
      ...(accessibleIds === null
        ? { tenantId: tenantId ?? null }
        : { _id: { $in: accessibleIds } }),
    };

    // `.find()` casts query values against the schema automatically; the aggregate
    // branch below builds a raw `$match` stage, which does not. Cast unconditionally
    // (both branches) so this stays true even if the `.find()` branch changes later.
    if (typeof baseQuery.author === 'string') {
      baseQuery.author = new mongoose.Types.ObjectId(baseQuery.author);
    }

    const projection: Record<string, 1> = {
      id: 1,
      _id: 1,
      name: 1,
      avatar: 1,
      author: 1,
      description: 1,
      conversation_starters: 1,
      updatedAt: 1,
      createdAt: 1,
      category: 1,
      support_contact: 1,
      is_promoted: 1,
    };

    if (includeSkillConfig) {
      projection.skills = 1;
      projection.skills_enabled = 1;
      projection.skill_authoring_enabled = 1;
      projection.skills_scope = 1;
    }
    if (includeExecutionConfig) {
      projection.tools = 1;
      projection.stateful_code_sessions = 1;
      projection.code_environment_id = 1;
      projection.code_workspace_id = 1;
      projection.repositoryInstructions = 1;
      projection.agent_ids = 1;
      projection['edges.from'] = 1;
      projection['edges.to'] = 1;
      projection['subagents.enabled'] = 1;
      projection['subagents.agent_ids'] = 1;
      projection['subagents.graphs.agent_ids'] = 1;
    }

    const finalizeAgent = (agent: Record<string, unknown>): Record<string, unknown> => {
      if (includeExecutionConfig) {
        agent.tools =
          Array.isArray(agent.tools) && agent.tools.includes(EToolResources.execute_code)
            ? [EToolResources.execute_code]
            : [];
      }
      if (agent.author) {
        agent.author = (agent.author as Types.ObjectId).toString();
      }
      return agent;
    };

    /** Removes internal sort fields after the mode-specific cursor is built. */
    const buildEnvelope = (
      data: Array<Record<string, unknown>>,
      hasMore: boolean,
      nextCursor: string | null,
    ) => {
      for (const agent of data) {
        for (const field of INTERNAL_SORT_FIELDS) {
          delete agent[field];
        }
      }

      return {
        object: 'list',
        data,
        first_id: data.length > 0 ? (data[0].id as string) : null,
        last_id: data.length > 0 ? (data[data.length - 1].id as string) : null,
        has_more: hasMore,
        after: nextCursor,
      };
    };

    /** A cursor that cannot be honored is an error, never a page-one restart. */
    const readCursor = (): AgentSortCursor | null => {
      if (!after) {
        return null;
      }
      const decoded = decodeAgentSortCursor(after, sort);
      if (decoded.kind === 'usable') {
        return decoded.cursor;
      }
      throw new AgentSortCursorError(decoded.kind);
    };

    if (sort === 'popular') {
      const User = mongoose.models.User as Model<IUser>;
      /* Favourites live on user documents, so popularity has to be counted there. The
         group is keyed by tenant as well as agent id because ids collide across
         tenants, and the tenant plugin scopes the aggregation, so the result is
         bounded by the favourited agents in the caller's tenant rather than by the
         size of the marketplace. */
      const countRows = (await User.aggregate([
        { $match: { 'favorites.agentId': { $exists: true } } },
        {
          $project: {
            tenantId: 1,
            favoriteAgentIds: {
              $setUnion: [{ $ifNull: ['$favorites.agentId', []] }, []],
            },
          },
        },
        { $unwind: '$favoriteAgentIds' },
        {
          $group: {
            _id: {
              tenantId: '$tenantId',
              agentId: '$favoriteAgentIds',
            },
            favoriteCount: { $sum: 1 },
          },
        },
      ])) as Array<{
        _id: { tenantId?: string | null; agentId: string };
        favoriteCount: number;
      }>;

      const favoriteCounts = new Map<string, number>();
      const favoritedAgentIds = new Set<string>();
      for (const row of countRows) {
        const agentId = row?._id?.agentId;
        if (typeof agentId !== 'string' || !(row.favoriteCount > 0)) {
          continue;
        }
        favoriteCounts.set(favoriteCountKey(row._id.tenantId, agentId), row.favoriteCount);
        favoritedAgentIds.add(agentId);
      }

      /* Only favourited agents need ordering by count, and there are at most as many
         of them as there are favourites. Every other accessible agent has count 0 and
         is therefore ordered by `_id` alone, which the index serves as a range scan —
         so a page costs the favourited set plus one page, never the whole corpus. */
      const favoritedRows =
        favoritedAgentIds.size > 0
          ? ((await Agent.find(
              { $and: [baseQuery, { id: { $in: [...favoritedAgentIds] } }] },
              { _id: 1, id: 1, tenantId: 1 },
            ).lean()) as Array<{ _id: Types.ObjectId; id: string; tenantId?: string | null }>)
          : [];
      const decodedCursor = readCursor();
      const cursorCount = decodedCursor ? Number(decodedCursor.primary) : null;
      const cursorIdHex = decodedCursor ? decodedCursor.secondary.toLowerCase() : null;
      const favorited = favoritedRows
        .map((row) => ({
          _id: row._id,
          idHex: row._id.toString(),
          favoriteCount: favoriteCounts.get(favoriteCountKey(row.tenantId, row.id)) ?? 0,
        }))
        // The `$in` matches by agent id, so a row whose own tenant never favourited it
        // belongs to the count-0 tail instead.
        .filter((row) => row.favoriteCount > 0)
        .sort((a, b) => {
          if (a.favoriteCount !== b.favoriteCount) {
            return b.favoriteCount - a.favoriteCount;
          }
          if (a.idHex === b.idHex) {
            return 0;
          }
          return a.idHex < b.idHex ? -1 : 1;
        });

      /* Counts are recomputed for each request. The order and cursor are stable within a
         count bucket while counts stay unchanged; client-side dedup can absorb rows that
         drift backward. An unseen row that gains favorites can cross upward between
         requests and be missed (berry-13/LibreChat#31). Pinning a ranking needs a
         materialized favorite counter and a revision to pin it against
         (berry-13/LibreChat#11); favorites carry no per-favorite timestamp. */
      let startIndex = favorited.length;
      if (cursorCount === null) {
        startIndex = 0;
      } else if (cursorCount > 0 && cursorIdHex) {
        const found = favorited.findIndex((row) =>
          row.favoriteCount !== cursorCount
            ? row.favoriteCount < cursorCount
            : row.idHex > cursorIdHex,
        );
        startIndex = found < 0 ? favorited.length : found;
      }

      const pageFavorited =
        normalizedLimit == null
          ? favorited.slice(startIndex)
          : favorited.slice(startIndex, startIndex + normalizedLimit);
      const favoritedHasMore =
        normalizedLimit != null && favorited.length > startIndex + normalizedLimit;

      const favoritedDocs =
        pageFavorited.length > 0
          ? ((await Agent.find(
              { $and: [baseQuery, { _id: { $in: pageFavorited.map((row) => row._id) } }] },
              projection,
            ).lean()) as Array<Record<string, unknown>>)
          : [];
      const favoritedById = new Map(favoritedDocs.map((agent) => [String(agent._id), agent]));
      const data = pageFavorited
        .map((row) => favoritedById.get(row.idHex))
        .filter((agent): agent is Record<string, unknown> => agent != null)
        .map(finalizeAgent);

      /* The count-0 tail is ordered by `_id` alone, so the database applies both the
         cursor predicate and the limit to it. */
      let tailHasMore = false;
      let tailCursorRow: Record<string, unknown> | null = null;
      if (!favoritedHasMore) {
        const remaining = normalizedLimit == null ? null : normalizedLimit - pageFavorited.length;
        const conditions: Record<string, unknown>[] = [baseQuery];
        if (favorited.length > 0) {
          conditions.push({ _id: { $nin: favorited.map((row) => row._id) } });
        }
        if (cursorCount === 0 && decodedCursor) {
          conditions.push({
            _id: { $gt: new mongoose.Types.ObjectId(decodedCursor.secondary) },
          });
        }
        let tailQuery = Agent.find({ $and: conditions }, projection).sort({ _id: 1 });
        if (remaining != null) {
          // One extra row answers `has_more` without a second query.
          tailQuery = tailQuery.limit(remaining + 1);
        }
        const tailRows = (await tailQuery.lean()) as Array<Record<string, unknown>>;
        tailHasMore = remaining != null && tailRows.length > remaining;
        const tailPage = remaining != null ? tailRows.slice(0, remaining) : tailRows;
        for (const agent of tailPage) {
          data.push(finalizeAgent(agent));
        }
        tailCursorRow = tailPage[tailPage.length - 1] ?? null;
      }

      const hasMore = favoritedHasMore || tailHasMore;
      const favoritedCursorRow = pageFavorited[pageFavorited.length - 1];
      let nextCursor: string | null = null;
      /* The whole row rather than its id alone: `encodeAgentSortCursor` carries the
         row's updatedAt only for the legacy-compatible recent mode. */
      if (hasMore && tailCursorRow) {
        nextCursor = encodeAgentSortCursor(sort, { ...tailCursorRow, favoriteCount: 0 });
      } else if (hasMore && favoritedCursorRow) {
        nextCursor = encodeAgentSortCursor(sort, {
          ...favoritedById.get(favoritedCursorRow.idHex),
          _id: favoritedCursorRow._id,
          favoriteCount: favoritedCursorRow.favoriteCount,
        });
      }
      return buildEnvelope(data, hasMore, nextCursor);
    }

    if (sort === 'author') {
      const pipeline: PipelineStage[] = [{ $match: baseQuery }];
      /* Resolve the same owner contact used by the agent card before sorting. The join
         matches on `resourceId` alone because a compound `localField` is not a thing, so
         the resource type is asserted in the filter below: `AGENT` and `REMOTE_AGENT`
         entries share an agent's `_id`, and `attachOwnerContacts` counts only the
         `AGENT` ones as ownership. */
      pipeline.push({
        $lookup: {
          from: 'aclentries',
          localField: '_id',
          foreignField: 'resourceId',
          /* Aggregation lookups bypass the ACL model's tenant middleware. The joined
           * array is narrowed in the following stage because DocumentDB 5.0 does not
           * support the `$lookup` `let`/`pipeline` form. */
          as: '_ownerAclEntries',
        },
      });
      pipeline.push({
        $addFields: {
          _ownerAclEntries: {
            $filter: {
              input: '$_ownerAclEntries',
              as: 'e',
              cond: {
                $eq: [{ $ifNull: ['$$e.tenantId', null] }, { $ifNull: ['$tenantId', null] }],
              },
            },
          },
        },
      });
      pipeline.push({
        $addFields: {
          _ownerId: {
            $let: {
              vars: {
                ownerEntry: {
                  $reduce: {
                    input: {
                      $filter: {
                        input: '$_ownerAclEntries',
                        as: 'e',
                        cond: {
                          $and: [
                            { $eq: ['$$e.resourceType', ResourceType.AGENT] },
                            { $eq: ['$$e.principalType', PrincipalType.USER] },
                            {
                              $in: ['$$e.permBits', [...OWNER_ACL_PERMISSION_BIT_SUPERSETS]],
                            },
                          ],
                        },
                      },
                    },
                    initialValue: null,
                    in: {
                      $cond: [
                        { $eq: ['$$value', null] },
                        '$$this',
                        {
                          $cond: [earlierAclEntry('$$this', '$$value'), '$$this', '$$value'],
                        },
                      ],
                    },
                  },
                },
              },
              in: { $ifNull: ['$$ownerEntry.principalId', '$author'] },
            },
          },
        },
      });
      pipeline.push({
        $lookup: {
          from: 'users',
          localField: '_ownerId',
          foreignField: '_id',
          /* User lookups bypass the User model's tenant middleware too. Filter the
           * joined array afterwards to keep imported principals in their own tenant. */
          as: '_ownerUser',
        },
      });
      pipeline.push({
        $addFields: {
          _ownerUser: {
            $filter: {
              input: '$_ownerUser',
              as: 'u',
              cond: {
                $eq: [{ $ifNull: ['$$u.tenantId', null] }, { $ifNull: ['$tenantId', null] }],
              },
            },
          },
        },
      });
      pipeline.push({
        $addFields: {
          /* Trimmed once so the sort key and the owner contact below read exactly the
           * same values. Every operand is checked for BSON string type first because
           * imported legacy values can make `$trim` fail the whole aggregation. */
          _supportName: trimStringOrEmpty('$support_contact.name'),
          _supportEmail: trimStringOrEmpty('$support_contact.email'),
          _ownerName: trimStringOrEmpty({ $arrayElemAt: ['$_ownerUser.name', 0] }),
          _ownerUsername: trimStringOrEmpty({ $arrayElemAt: ['$_ownerUser.username', 0] }),
          // Dead on Agent documents in practice (only Prompts/Skills write it) —
          // kept as the final real-value tier for exact parity with
          // `resolveAgentOwnerContact`, which checks it too.
          _authorName: trimStringOrEmpty('$authorName'),
          _hasOwnerUser: { $gt: [{ $size: { $ifNull: ['$_ownerUser', []] } }, 0] },
        },
      });
      pipeline.push({
        $addFields: {
          authorDisplayName: {
            $switch: {
              branches: [
                { case: { $ne: ['$_supportName', ''] }, then: '$_supportName' },
                { case: { $ne: ['$_supportEmail', ''] }, then: '$_supportEmail' },
                { case: isValidDisplayName('$_ownerName'), then: '$_ownerName' },
                { case: isValidDisplayName('$_ownerUsername'), then: '$_ownerUsername' },
                { case: isValidDisplayName('$_authorName'), then: '$_authorName' },
              ],
              default: AUTHOR_SORT_SENTINEL,
            },
          },
          /* This pipeline joined the owner in order to sort by it, and that is the same
             owner `attachOwnerContacts` would resolve again — an ACL aggregation plus a
             user query per page. Resolved here instead, on exactly the tiers
             `resolveAgentOwnerContact` applies: a support contact means no owner
             contact at all, and without a joined owner user there is none either, even
             when the agent carries a denormalized `authorName`. `$$REMOVE` is rejected
             by DocumentDB, so "no contact" is an explicit null the caller drops. */
          owner_contact: {
            $cond: [
              { $or: [{ $ne: ['$_supportName', ''] }, { $ne: ['$_supportEmail', ''] }] },
              null,
              {
                $let: {
                  vars: {
                    ownerDisplayName: {
                      $switch: {
                        branches: [
                          { case: isValidDisplayName('$_ownerName'), then: '$_ownerName' },
                          {
                            case: isValidDisplayName('$_ownerUsername'),
                            then: '$_ownerUsername',
                          },
                          { case: isValidDisplayName('$_authorName'), then: '$_authorName' },
                        ],
                        default: null,
                      },
                    },
                  },
                  in: {
                    $cond: [
                      { $and: ['$_hasOwnerUser', { $ne: ['$$ownerDisplayName', null] }] },
                      { name: '$$ownerDisplayName' },
                      null,
                    ],
                  },
                },
              },
            ],
          },
        },
      });
      pipeline.push({
        $addFields: {
          authorSortKey: { $toLower: '$authorDisplayName' },
        },
      });

      // Applied after the `$addFields` above, since it compares against the computed
      // sort key rather than a stored field.
      const decodedCursor = readCursor();
      if (decodedCursor) {
        pipeline.push({
          $match: buildAgentSortCursorCondition(
            sort,
            decodedCursor,
            new mongoose.Types.ObjectId(decodedCursor.secondary),
          ),
        } as PipelineStage);
      }

      pipeline.push({
        $project: {
          ...projection,
          authorDisplayName: 1,
          authorSortKey: 1,
          owner_contact: 1,
        },
      });

      pipeline.push({
        $sort: {
          authorSortKey: AGENT_SORT_CONFIG[sort].direction,
          _id: AGENT_SORT_CONFIG[sort].tieBreakDirection,
        },
      });

      if (isPaginated && normalizedLimit) {
        pipeline.push({ $limit: normalizedLimit + 1 });
      }

      const agents = (await Agent.aggregate(pipeline)) as Array<Record<string, unknown>>;

      const hasMore = isPaginated && normalizedLimit ? agents.length > normalizedLimit : false;
      const trimmed = isPaginated && normalizedLimit ? agents.slice(0, normalizedLimit) : agents;
      const data = trimmed.map((agent) => {
        if (agent.owner_contact == null) {
          delete agent.owner_contact;
        }
        agent[AGENT_OWNER_CONTACT_RESOLVED_FIELD] = true;
        return finalizeAgent(agent);
      });

      let nextCursor: string | null = null;
      if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
        nextCursor = encodeAgentSortCursor(sort, agents[normalizedLimit - 1]);
      }

      return buildEnvelope(data, hasMore, nextCursor);
    }

    /* The remaining modes sort by a stored date: `createdAt` for the marketplace's newest
       and oldest, whose descending compound index supports both directions by reversing
       the scan, and `updatedAt` for the order this endpoint serves when nothing asks. */
    const { field: dateField, direction: dir, tieBreakDirection } = AGENT_SORT_CONFIG[sort];

    let finalQuery: Record<string, unknown> = baseQuery;
    const decodedCursor = readCursor();
    if (decodedCursor) {
      const cursorCondition = buildAgentSortCursorCondition(
        sort,
        decodedCursor,
        new mongoose.Types.ObjectId(decodedCursor.secondary),
      );
      finalQuery =
        Object.keys(baseQuery).length > 0
          ? { $and: [{ ...baseQuery }, cursorCondition] }
          : { ...cursorCondition };
    }

    let query = Agent.find(finalQuery, projection).sort({
      [dateField]: dir,
      _id: tieBreakDirection,
    });

    if (isPaginated && normalizedLimit) {
      query = query.limit(normalizedLimit + 1);
    }

    const agents = (await query.lean()) as Array<Record<string, unknown>>;

    const hasMore = isPaginated && normalizedLimit ? agents.length > normalizedLimit : false;
    const data = (isPaginated && normalizedLimit ? agents.slice(0, normalizedLimit) : agents).map(
      finalizeAgent,
    );

    let nextCursor: string | null = null;
    if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
      nextCursor = encodeAgentSortCursor(sort, agents[normalizedLimit - 1]);
    }

    return buildEnvelope(data, hasMore, nextCursor);
  }

  /**
   * Returns the full Agent configuration required by the management response projector.
   * Unlike the browser list path, this query performs no avatar refresh or persistence write.
   */
  async function getAgentManagementListByAccess({
    accessibleIds,
    tenantId,
    limit,
    after = null,
  }: {
    /** `null` means the caller already passed the unrestricted management-capability check. */
    accessibleIds: Types.ObjectId[] | null;
    tenantId: string;
    limit: number;
    after?: string | null;
  }): Promise<{
    data: Array<IAgent & { version: number; createdAt: Date; updatedAt: Date }>;
    has_more: boolean;
    after: string | null;
  }> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const match: FilterQuery<IAgent> = {
      tenantId,
      ...(accessibleIds != null ? { _id: { $in: accessibleIds } } : {}),
    };

    if (after) {
      const cursor = JSON.parse(Buffer.from(after, 'base64').toString('utf8')) as {
        updatedAt: string;
        _id: string;
      };
      match.$or = [
        { updatedAt: { $lt: new Date(cursor.updatedAt) } },
        {
          updatedAt: new Date(cursor.updatedAt),
          _id: { $gt: new mongoose.Types.ObjectId(cursor._id) },
        },
      ];
    }

    const agents = await Agent.aggregate<
      IAgent & { version: number; createdAt: Date; updatedAt: Date }
    >([
      { $match: match },
      { $sort: { updatedAt: -1, _id: 1 } },
      { $limit: limit + 1 },
      { $addFields: { version: { $size: { $ifNull: ['$versions', []] } } } },
      { $project: { versions: 0 } },
    ]);

    const hasMore = agents.length > limit;
    const data = hasMore ? agents.slice(0, limit) : agents;
    const lastAgent = data[data.length - 1];
    const nextCursor =
      hasMore && lastAgent
        ? Buffer.from(
            JSON.stringify({
              updatedAt: lastAgent.updatedAt.toISOString(),
              _id: lastAgent._id.toString(),
            }),
          ).toString('base64')
        : null;

    return { data, has_more: hasMore, after: nextCursor };
  }

  /**
   * Reverts an agent to a specific version in its version history.
   */
  async function revertAgentVersion(
    searchParameter: FilterQuery<IAgent>,
    versionIndex: number,
  ): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agent = await Agent.findOne(searchParameter);
    if (!agent) {
      throw new Error('Agent not found');
    }

    if (!agent.versions || !agent.versions[versionIndex]) {
      throw new Error(`Version ${versionIndex} not found`);
    }

    const revertToVersion = { ...(agent.versions[versionIndex] as Record<string, unknown>) };
    const originalRevision = (agent as unknown as IAgent & { updatedAt: Date }).updatedAt;
    delete revertToVersion._id;
    delete revertToVersion.id;
    delete revertToVersion.versions;
    delete revertToVersion.author;
    delete revertToVersion.updatedBy;

    /** Version snapshots can predate skill deletions; restoring one verbatim
     *  would resurrect dangling allowlist ids that scope the catalog to
     *  nothing. Same self-heal (and fail-closed-on-empty rule) as
     *  `createAgent`/`updateAgent`. */
    if (Array.isArray(revertToVersion.skills) && revertToVersion.skills.length > 0) {
      const prunedSkills = await filterExistingSkillIds(
        mongoose,
        revertToVersion.skills as string[],
        isExternalSkillId,
      );
      revertToVersion.skills = prunedSkills;
      /** The snapshot carries its own scope, and an All-scoped version keeps
       *  its allowlist, so failing closed here would restore the version as
       *  Off. See `requiresSkillsDisable`. */
      if (prunedSkills.length === 0 && requiresSkillsDisable(revertToVersion.skills_scope)) {
        revertToVersion.skills_enabled = false;
      }
    }

    const unsetOnRestore: Record<string, 1> = {};
    for (const field of [
      'code_environment_id',
      'code_workspace_id',
      'repositoryInstructions',
      'git_identity',
      'skills_scope',
      'skill_authoring_enabled',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(revertToVersion, field)) {
        unsetOnRestore[field] = 1;
      }
    }
    const revertUpdate =
      Object.keys(unsetOnRestore).length > 0
        ? { $set: revertToVersion, $unset: unsetOnRestore }
        : { $set: revertToVersion };
    const revertedAgent = await withCodeEnvironmentReference(
      mongoose,
      typeof revertToVersion.code_environment_id === 'string'
        ? revertToVersion.code_environment_id
        : undefined,
      async () =>
        await Agent.findOneAndUpdate(
          { ...searchParameter, _id: agent._id, updatedAt: originalRevision },
          revertUpdate,
          { new: true },
        ).lean<IAgent>(),
      undefined,
      async (agentAfterRevert) => {
        if (agentAfterRevert == null || typeof revertToVersion.code_environment_id !== 'string') {
          return;
        }
        await restoreAgentAfterReferenceLoss(
          Agent,
          agentAfterRevert,
          agent.toObject() as IAgent,
          revertToVersion.code_environment_id,
        );
      },
    );
    if (!revertedAgent) {
      throw new Error('Agent not found');
    }
    return revertedAgent;
  }

  /**
   * Counts the number of promoted agents.
   */
  async function countPromotedAgents(): Promise<number> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.countDocuments({ is_promoted: true });
  }

  /** Removes an agent from the favorites of specified users. */
  async function removeAgentFromUserFavorites(
    resourceId: string,
    userIds: string[],
  ): Promise<void> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const User = mongoose.models.User as Model<unknown>;

    const agent = await Agent.findOne({ _id: resourceId }, { id: 1, tenantId: 1 }).lean();
    if (!agent) {
      return;
    }

    await User.updateMany(
      {
        _id: { $in: userIds },
        ...(agent.tenantId !== undefined ? { tenantId: agent.tenantId } : {}),
        'favorites.agentId': agent.id,
      },
      { $pull: { favorites: { agentId: agent.id } } },
    );
  }

  return {
    getAgent,
    getAgentVersions,
    getAgentWithVersionCount,
    getAgents,
    resolveAgentGraphAccess,
    getAgentGraphNodes,
    createAgent,
    getAgentIdsByMCPServerName,
    getAgentsWithMCPServerNames,
    updateAgent,
    updateAgentAvatar,
    deleteAgent,
    deleteUserAgents,
    revertAgentVersion,
    countPromotedAgents,
    addAgentResourceFile,
    getListAgentsByAccess,
    getAgentManagementListByAccess,
    removeAgentResourceFiles,
    generateActionMetadataHash,
    removeAgentFromUserFavorites,
    removeAgentResourceFilesFromAllAgents,
    getSharedResourceFileIds,
  };
}

export type AgentMethods = ReturnType<typeof createAgentMethods>;
