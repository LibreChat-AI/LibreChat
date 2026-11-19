import { randomUUID } from 'node:crypto';
import {
  scheduledMCPToolPinSchema,
  agentKeyMCPIdentitySchema,
  agentKeyMCPEnrollmentSchema,
  scheduledMCPEnrollmentSchema,
  MAX_SCHEDULED_MCP_SERVER_TOOLS,
  grantLifetime,
} from 'librechat-data-provider';
import type {
  MCPGrantIdentity,
  MCPGrantEnrollment,
  AgentKeyMCPIdentity,
  ScheduledMCPIdentity,
} from 'librechat-data-provider';
import type { Model } from 'mongoose';

export interface MCPConsentSnapshot<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> {
  compatible?: boolean;
  agentId: string;
  enabled: boolean;
  configRevision: number;
  enrollment: MCPGrantEnrollment<Identity> | null;
  /** The owner edited this schedule without ever authorizing it. */
  required?: boolean;
}
export type ScheduleConsentSnapshot = MCPConsentSnapshot<ScheduledMCPIdentity>;

/** A grant embedded in the document of the subject it acts for: a schedule, or an API key. */
export interface MCPConsentStorage<Identity extends MCPGrantIdentity = ScheduledMCPIdentity> {
  readScheduleMCPConsent: (identity: Identity) => Promise<MCPConsentSnapshot<Identity> | null>;
  confirmScheduleMCPConsent: (input: {
    identity: Identity;
    expectedConfigRevision: number;
    expectedRevision: string | null;
    enrollment: MCPGrantEnrollment<Identity>;
    /**
     * The stored grant the new one was built from. The write is refused when a run has added
     * a pin or a mark to it since, so the caller reads again instead of dropping the addition.
     */
    basis?: MCPGrantEnrollment<Identity> | null;
  }) => Promise<boolean>;
  revokeScheduleMCPConsent: (identity: Identity, revision: string) => Promise<boolean>;
  admitScheduleMCPConsent: (input: {
    identity: Identity;
    expectedConfigRevision: number;
    revision: string;
    consentId: string;
    requireEnabled?: boolean;
    /**
     * The live definition digest of each tool about to be used. Admission is refused when one
     * of them is marked as changed or pinned to another digest at the moment of the write.
     */
    definitions?: Readonly<Record<string, string>>;
  }) => Promise<boolean>;
  /**
   * Records the definition an allowed tool had on first use. False when the tool already has
   * a pin or the grant is no longer the live one; the caller reads again to tell which.
   */
  pinScheduleMCPToolDefinition: (input: {
    identity: Identity;
    revision: string;
    consentId: string;
    tool: string;
    digest: string;
  }) => Promise<boolean>;
  /** Marks a pinned tool as changed. The mark stays until the owner confirms again. */
  flagScheduleMCPToolChange: (input: {
    identity: Identity;
    revision: string;
    consentId: string;
    tool: string;
  }) => Promise<boolean>;
}
export type ScheduleMCPConsentStorage = MCPConsentStorage<ScheduledMCPIdentity>;

type Filter = Record<string, unknown>;
type Row = Record<string, unknown>;

/** What differs between the documents a grant can live in. The writes are the same. */
interface GrantHolder<Identity extends MCPGrantIdentity> {
  model: () => Model<Row>;
  /** Where the grant sits inside the holder's document. */
  path: (identity: Identity) => string;
  /** Which document, and that it is still live. */
  scope: (identity: Identity) => Filter;
  /** What must also hold for the grant to be written or used. */
  fence: (
    identity: Identity,
    input: { expectedConfigRevision?: number; requireEnabled?: boolean },
  ) => Filter;
  select: string;
  parse: (value: unknown) => MCPGrantEnrollment<Identity> | undefined;
  sameIdentity: (stored: Identity, expected: Identity) => boolean;
  describe: (row: Row) => Pick<MCPConsentSnapshot, 'enabled' | 'configRevision' | 'required'> & {
    agentId?: string;
  };
  /** Whether the holder's schema validates the grant on write. */
  runValidators: boolean;
}

/** A revocation that keeps losing to pin writes gives up; pins per grant are bounded. */
const REVOKE_ATTEMPTS = 4;

/**
 * Matches while no pin or mark has been added to `basis`. Both lists only ever grow within a
 * grant revision, so an element at the old length is the whole difference.
 */
function untouchedSince(
  path: string,
  basis: MCPGrantEnrollment<MCPGrantIdentity> | null | undefined,
): Filter {
  if (!basis?.consents.length) return {};
  return {
    $and: basis.consents.map((consent) => ({
      [`${path}.consents`]: {
        $elemMatch: {
          id: consent.id,
          [`definitions.${consent.definitions?.length ?? 0}`]: { $exists: false },
          [`changedTools.${consent.changedTools?.length ?? 0}`]: { $exists: false },
        },
      },
    })),
  };
}

/**
 * Matches a schedule whose stored grant is still `basis`, with no pin or mark added to it
 * since. A grant decided against `basis` may replace it only then: a revocation or another
 * confirmation moves the revision, and a run's pin or mark grows a list. `null` is a
 * schedule with no grant.
 */
export function unchangedScheduleGrant(basis: MCPGrantEnrollment<MCPGrantIdentity> | null): Filter {
  if (basis == null) return { mcpConsent: { $exists: false } };
  return {
    'mcpConsent.version': 1,
    'mcpConsent.revision': basis.revision,
    ...untouchedSince('mcpConsent', basis),
  };
}

/** Matches a consent in which none of the tools is marked or pinned to a different digest. */
function unchangedDefinitions(definitions: Readonly<Record<string, string>> | undefined): Filter {
  const live = Object.entries(definitions ?? {});
  if (live.length === 0) return {};
  return {
    changedTools: { $nin: live.map(([tool]) => tool) },
    $nor: live.map(([tool, digest]) => ({
      definitions: { $elemMatch: { tool, digest: { $ne: digest } } },
    })),
  };
}

function createEmbeddedGrantStorage<Identity extends MCPGrantIdentity>(
  holder: GrantHolder<Identity>,
  now: () => number,
): MCPConsentStorage<Identity> {
  const revisionFilter = (path: string, revision: string | null): Filter =>
    revision == null
      ? { [path]: { $exists: false } }
      : { [`${path}.version`]: 1, [`${path}.revision`]: revision };
  const stored = (row: Row, path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (value, key) =>
          value != null && typeof value === 'object' ? (value as Row)[key] : undefined,
        row,
      );

  return {
    async readScheduleMCPConsent(identity) {
      const row = await holder
        .model()
        .findOne(holder.scope(identity))
        .select(holder.select)
        .read('primary')
        .lean<Row>();
      if (!row) return null;
      const grant = stored(row, holder.path(identity));
      const enrollment = holder.parse(grant);
      const { agentId, required, ...described } = holder.describe(row);
      return {
        ...described,
        agentId: agentId ?? identity.agentId,
        enrollment: enrollment ?? null,
        compatible: grant === undefined || enrollment !== undefined,
        ...(required === true && { required: true }),
      };
    },
    async confirmScheduleMCPConsent(input) {
      const enrollment = holder.parse(input.enrollment);
      if (
        !enrollment ||
        enrollment.scheduleRevision !== input.expectedConfigRevision ||
        enrollment.consents.some(
          (consent) =>
            !holder.sameIdentity(consent.identity, input.identity) ||
            consent.identity.invocationMode !== 'delegated' ||
            consent.revision !== enrollment.revision ||
            consent.revokedAtMs != null,
        ) ||
        enrollment.revokedAtMs != null
      )
        throw new Error('Invalid scheduled MCP enrollment binding');
      if (
        enrollment.consents.some((consent) => consent.absoluteExpiresAtMs <= now()) ||
        grantLifetime(enrollment).expiresAtMs <= now()
      )
        return false;
      const path = holder.path(input.identity);
      const result = await holder.model().updateOne(
        {
          ...holder.scope(input.identity),
          ...holder.fence(input.identity, {
            expectedConfigRevision: input.expectedConfigRevision,
          }),
          ...revisionFilter(path, input.expectedRevision),
          ...untouchedSince(path, input.basis),
        },
        { $set: { [path]: enrollment } },
        { runValidators: holder.runValidators },
      );
      return result.matchedCount === 1;
    },
    async revokeScheduleMCPConsent(identity, revision) {
      const path = holder.path(identity);
      const filter = { ...holder.scope(identity), ...revisionFilter(path, revision) };
      // The grant is rewritten whole. A pin or mark a run adds between the read and the write
      // would be dropped, and the next grant would carry one pin fewer, so read again instead.
      for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
        const snapshot = await holder
          .model()
          .findOne(filter)
          .select(holder.select)
          .read('primary')
          .lean<Row>();
        const current = snapshot ? holder.parse(stored(snapshot, path)) : undefined;
        if (!current) return false;
        const revokedRevision = randomUUID();
        const revokedAtMs = now();
        const enrollment = {
          ...current,
          revision: revokedRevision,
          // On the grant itself too: one that allows no MCP server has no consent to carry it.
          revokedAtMs: current.revokedAtMs ?? revokedAtMs,
          consents: current.consents.map((consent) => ({
            ...consent,
            revision: revokedRevision,
            revokedAtMs: consent.revokedAtMs ?? revokedAtMs,
          })),
        };
        const result = await holder
          .model()
          .updateOne(
            { ...filter, ...untouchedSince(path, current) },
            { $set: { [path]: enrollment } },
            { runValidators: holder.runValidators },
          );
        if (result.matchedCount === 1) return true;
      }
      return false;
    },
    async admitScheduleMCPConsent(input) {
      const path = holder.path(input.identity);
      const result = await holder.model().updateOne(
        {
          ...holder.scope(input.identity),
          ...holder.fence(input.identity, {
            expectedConfigRevision: input.expectedConfigRevision,
            requireEnabled: input.requireEnabled !== false,
          }),
          ...revisionFilter(path, input.revision),
          [`${path}.consents`]: {
            $elemMatch: {
              id: input.consentId,
              revision: input.revision,
              revokedAtMs: null,
              ...unchangedDefinitions(input.definitions),
            },
          },
          [`${path}.consents.0`]: { $exists: true },
          $nor: [
            {
              [`${path}.consents`]: {
                $elemMatch: {
                  $or: [{ revokedAtMs: { $ne: null } }, { absoluteExpiresAtMs: { $lte: now() } }],
                },
              },
            },
          ],
        },
        { $set: { [`${path}.revision`]: input.revision } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
    async pinScheduleMCPToolDefinition(input) {
      const pin = scheduledMCPToolPinSchema.parse({ tool: input.tool, digest: input.digest });
      const path = holder.path(input.identity);
      const result = await holder.model().updateOne(
        {
          ...holder.scope(input.identity),
          ...holder.fence(input.identity, {}),
          ...revisionFilter(path, input.revision),
          [`${path}.consents`]: {
            $elemMatch: {
              id: input.consentId,
              revision: input.revision,
              revokedAtMs: null,
              // No entry for this tool yet, and room for one more.
              'definitions.tool': { $ne: pin.tool },
              [`definitions.${MAX_SCHEDULED_MCP_SERVER_TOOLS - 1}`]: { $exists: false },
            },
          },
        },
        { $push: { [`${path}.consents.$.definitions`]: pin } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
    async flagScheduleMCPToolChange(input) {
      const path = holder.path(input.identity);
      const result = await holder.model().updateOne(
        {
          ...holder.scope(input.identity),
          ...revisionFilter(path, input.revision),
          [`${path}.consents`]: {
            $elemMatch: { id: input.consentId, 'definitions.tool': input.tool },
          },
        },
        { $addToSet: { [`${path}.consents.$.changedTools`]: input.tool } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
  };
}

export function createScheduleMCPConsentStorage(
  mongoose: typeof import('mongoose'),
  options: { now?: () => number } = {},
): ScheduleMCPConsentStorage {
  return createEmbeddedGrantStorage<ScheduledMCPIdentity>(
    {
      model: () => mongoose.models.Schedule as unknown as Model<Row>,
      path: () => 'mcpConsent',
      scope: (identity) => ({
        id: identity.scheduleId,
        user: identity.ownerId,
        tenantId: identity.tenantId,
        deleting: { $ne: true },
        erased: { $ne: true },
        deletionSuspension: { $exists: false },
      }),
      fence: (identity, { expectedConfigRevision, requireEnabled }) => ({
        ...(expectedConfigRevision === 0 && {
          $or: [{ configRevision: 0 }, { configRevision: { $exists: false } }],
        }),
        ...(expectedConfigRevision != null &&
          expectedConfigRevision !== 0 && { configRevision: expectedConfigRevision }),
        agent_id: identity.agentId,
        ...(requireEnabled === true && { enabled: true }),
      }),
      select: 'agent_id enabled configRevision mcpConsent mcpConsentRequired',
      parse: (value) => {
        const parsed = scheduledMCPEnrollmentSchema.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      },
      sameIdentity: (stored, expected) =>
        stored.scheduleId === expected.scheduleId &&
        stored.ownerId === expected.ownerId &&
        stored.tenantId === expected.tenantId &&
        stored.agentId === expected.agentId,
      describe: (row) => ({
        agentId: row.agent_id as string,
        enabled: row.enabled as boolean,
        configRevision: (row.configRevision as number | undefined) ?? 0,
        required: row.mcpConsentRequired === true,
      }),
      runValidators: true,
    },
    options.now ?? Date.now,
  );
}

/**
 * Grants of an API key, one per agent the key may run, on the key's own document. A grant
 * dies with its key: deleting or expiring the key removes it, and a bound key holds none.
 */
export function createAgentKeyMCPConsentStorage(
  mongoose: typeof import('mongoose'),
  options: { now?: () => number } = {},
): MCPConsentStorage<AgentKeyMCPIdentity> {
  const now = options.now ?? Date.now;
  return createEmbeddedGrantStorage<AgentKeyMCPIdentity>(
    {
      model: () => mongoose.models.AgentApiKey as unknown as Model<Row>,
      // The agent id becomes part of a field path, so it is checked against the id shape first.
      path: (identity) => `mcpGrants.${agentKeyMCPGrantPathSegment(identity.agentId)}`,
      scope: (identity) => ({
        _id: agentKeyMCPIdentitySchema.parse(identity).keyId,
        userId: identity.ownerId,
        tenantId: identity.tenantId,
        binding: { $exists: false },
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $gt: new Date(now()) } },
        ],
      }),
      fence: () => ({}),
      select: 'mcpGrants',
      parse: (value) => {
        const parsed = agentKeyMCPEnrollmentSchema.safeParse(value);
        return parsed.success ? parsed.data : undefined;
      },
      sameIdentity: (stored, expected) =>
        stored.keyId === expected.keyId &&
        stored.ownerId === expected.ownerId &&
        stored.tenantId === expected.tenantId &&
        stored.agentId === expected.agentId,
      describe: () => ({ enabled: true, configRevision: 0 }),
      runValidators: false,
    },
    now,
  );
}

/** Agent ids are generated from this alphabet. Anything else cannot name a grant. */
function agentKeyMCPGrantPathSegment(agentId: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(agentId)) throw new Error('Invalid agent id for an MCP grant');
  return agentId;
}
