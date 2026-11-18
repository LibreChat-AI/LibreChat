import { randomUUID } from 'node:crypto';
import {
  scheduledMCPToolPinSchema,
  scheduledMCPEnrollmentSchema,
  MAX_SCHEDULED_MCP_SERVER_TOOLS,
} from 'librechat-data-provider';
import type { ScheduledMCPIdentity, ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { IScheduleDocument } from '~/types/schedule';

export interface ScheduleConsentSnapshot {
  compatible?: boolean;
  agentId: string;
  enabled: boolean;
  configRevision: number;
  enrollment: ScheduledMCPEnrollment | null;
}

export interface ScheduleMCPConsentStorage {
  readScheduleMCPConsent: (
    identity: ScheduledMCPIdentity,
  ) => Promise<ScheduleConsentSnapshot | null>;
  confirmScheduleMCPConsent: (input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    expectedRevision: string | null;
    enrollment: ScheduledMCPEnrollment;
    /**
     * The stored grant the new one was built from. The write is refused when a run has added
     * a pin or a mark to it since, so the caller reads again instead of dropping the addition.
     */
    basis?: ScheduledMCPEnrollment | null;
  }) => Promise<boolean>;
  revokeScheduleMCPConsent: (identity: ScheduledMCPIdentity, revision: string) => Promise<boolean>;
  admitScheduleMCPConsent: (input: {
    identity: ScheduledMCPIdentity;
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
    identity: ScheduledMCPIdentity;
    revision: string;
    consentId: string;
    tool: string;
    digest: string;
  }) => Promise<boolean>;
  /** Marks a pinned tool as changed. The mark stays until the owner confirms again. */
  flagScheduleMCPToolChange: (input: {
    identity: ScheduledMCPIdentity;
    revision: string;
    consentId: string;
    tool: string;
  }) => Promise<boolean>;
}

/** A revocation that keeps losing to pin writes gives up; pins per grant are bounded. */
const REVOKE_ATTEMPTS = 4;

/**
 * Matches while no pin or mark has been added to `basis`. Both lists only ever grow within a
 * grant revision, so an element at the old length is the whole difference.
 */
function untouchedSince(basis: ScheduledMCPEnrollment | null | undefined) {
  if (!basis?.consents.length) return {};
  return {
    $and: basis.consents.map((consent) => ({
      'mcpConsent.consents': {
        $elemMatch: {
          id: consent.id,
          [`definitions.${consent.definitions?.length ?? 0}`]: { $exists: false },
          [`changedTools.${consent.changedTools?.length ?? 0}`]: { $exists: false },
        },
      },
    })),
  };
}

/** Matches a consent in which none of the tools is marked or pinned to a different digest. */
function unchangedDefinitions(definitions: Readonly<Record<string, string>> | undefined) {
  const live = Object.entries(definitions ?? {});
  if (live.length === 0) return {};
  return {
    changedTools: { $nin: live.map(([tool]) => tool) },
    $nor: live.map(([tool, digest]) => ({
      definitions: { $elemMatch: { tool, digest: { $ne: digest } } },
    })),
  };
}

export function createScheduleMCPConsentStorage(
  mongoose: typeof import('mongoose'),
  options: { now?: () => number } = {},
): ScheduleMCPConsentStorage {
  const now = options.now ?? Date.now;
  const model = (): Model<IScheduleDocument> =>
    mongoose.models.Schedule as Model<IScheduleDocument>;
  const scope = (identity: ScheduledMCPIdentity) => ({
    id: identity.scheduleId,
    user: identity.ownerId,
    tenantId: identity.tenantId,
    deleting: { $ne: true },
    erased: { $ne: true },
    deletionSuspension: { $exists: false },
  });
  const revisionFilter = (revision: string | null) =>
    revision == null
      ? { mcpConsent: { $exists: false } }
      : { 'mcpConsent.version': 1, 'mcpConsent.revision': revision };
  const configFilter = (revision: number) =>
    revision === 0
      ? { $or: [{ configRevision: 0 }, { configRevision: { $exists: false } }] }
      : { configRevision: revision };

  return {
    async readScheduleMCPConsent(identity) {
      const row = await model()
        .findOne(scope(identity))
        .select('agent_id enabled configRevision mcpConsent')
        .read('primary')
        .lean();
      if (!row) return null;
      const parsed = scheduledMCPEnrollmentSchema.safeParse(row.mcpConsent);
      return {
        agentId: row.agent_id,
        enabled: row.enabled,
        configRevision: row.configRevision ?? 0,
        enrollment: parsed.success ? parsed.data : null,
        compatible: row.mcpConsent === undefined || parsed.success,
      };
    },
    async confirmScheduleMCPConsent(input) {
      const enrollment = scheduledMCPEnrollmentSchema.parse(input.enrollment);
      if (
        enrollment.scheduleRevision !== input.expectedConfigRevision ||
        enrollment.consents.some(
          (consent) =>
            consent.identity.scheduleId !== input.identity.scheduleId ||
            consent.identity.ownerId !== input.identity.ownerId ||
            consent.identity.tenantId !== input.identity.tenantId ||
            consent.identity.agentId !== input.identity.agentId ||
            consent.identity.invocationMode !== 'delegated' ||
            consent.revision !== enrollment.revision ||
            consent.revokedAtMs != null,
        )
      )
        throw new Error('Invalid scheduled MCP enrollment binding');
      if (enrollment.consents.some((consent) => consent.absoluteExpiresAtMs <= now())) return false;
      const result = await model().updateOne(
        {
          ...scope(input.identity),
          ...configFilter(input.expectedConfigRevision),
          ...revisionFilter(input.expectedRevision),
          ...untouchedSince(input.basis),
          agent_id: input.identity.agentId,
        },
        { $set: { mcpConsent: enrollment } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },
    async revokeScheduleMCPConsent(identity, revision) {
      // The grant is rewritten whole. A pin or mark a run adds between the read and the write
      // would be dropped, and the next grant would carry one pin fewer, so read again instead.
      for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt++) {
        const snapshot = await model()
          .findOne({ ...scope(identity), ...revisionFilter(revision) })
          .select('mcpConsent')
          .read('primary')
          .lean();
        const parsed = scheduledMCPEnrollmentSchema.safeParse(snapshot?.mcpConsent);
        if (!parsed.success) return false;
        const revokedRevision = randomUUID();
        const revokedAtMs = now();
        const enrollment = {
          ...parsed.data,
          revision: revokedRevision,
          consents: parsed.data.consents.map((consent) => ({
            ...consent,
            revision: revokedRevision,
            revokedAtMs: consent.revokedAtMs ?? revokedAtMs,
          })),
        };
        const result = await model().updateOne(
          { ...scope(identity), ...revisionFilter(revision), ...untouchedSince(parsed.data) },
          { $set: { mcpConsent: enrollment } },
          { runValidators: true },
        );
        if (result.matchedCount === 1) return true;
      }
      return false;
    },
    async admitScheduleMCPConsent(input) {
      const result = await model().updateOne(
        {
          ...scope(input.identity),
          ...configFilter(input.expectedConfigRevision),
          ...revisionFilter(input.revision),
          agent_id: input.identity.agentId,
          ...(input.requireEnabled !== false && { enabled: true }),
          'mcpConsent.consents': {
            $elemMatch: {
              id: input.consentId,
              revision: input.revision,
              revokedAtMs: null,
              ...unchangedDefinitions(input.definitions),
            },
          },
          'mcpConsent.consents.0': { $exists: true },
          $nor: [
            {
              'mcpConsent.consents': {
                $elemMatch: {
                  $or: [{ revokedAtMs: { $ne: null } }, { absoluteExpiresAtMs: { $lte: now() } }],
                },
              },
            },
          ],
        },
        { $set: { 'mcpConsent.revision': input.revision } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
    async pinScheduleMCPToolDefinition(input) {
      const pin = scheduledMCPToolPinSchema.parse({ tool: input.tool, digest: input.digest });
      const result = await model().updateOne(
        {
          ...scope(input.identity),
          ...revisionFilter(input.revision),
          agent_id: input.identity.agentId,
          'mcpConsent.consents': {
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
        { $push: { 'mcpConsent.consents.$.definitions': pin } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
    async flagScheduleMCPToolChange(input) {
      const result = await model().updateOne(
        {
          ...scope(input.identity),
          ...revisionFilter(input.revision),
          'mcpConsent.consents': {
            $elemMatch: { id: input.consentId, 'definitions.tool': input.tool },
          },
        },
        { $addToSet: { 'mcpConsent.consents.$.changedTools': input.tool } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
  };
}
