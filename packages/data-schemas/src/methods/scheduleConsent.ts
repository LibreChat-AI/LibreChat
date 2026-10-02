import { randomUUID } from 'node:crypto';
import { scheduledMCPEnrollmentSchema } from 'librechat-data-provider';
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
  }) => Promise<boolean>;
  revokeScheduleMCPConsent: (identity: ScheduledMCPIdentity, revision: string) => Promise<boolean>;
  admitScheduleMCPConsent: (input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    revision: string;
    consentId: string;
  }) => Promise<boolean>;
}

export function createScheduleMCPConsentStorage(
  mongoose: typeof import('mongoose'),
): ScheduleMCPConsentStorage {
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
      const result = await model().updateOne(
        {
          ...scope(input.identity),
          ...configFilter(input.expectedConfigRevision),
          ...revisionFilter(input.expectedRevision),
          agent_id: input.identity.agentId,
          // Expiry is checked against database time at the atomic confirmation boundary.
          $expr: {
            $gt: [
              { $literal: Math.min(...enrollment.consents.map((c) => c.absoluteExpiresAtMs)) },
              { $toLong: '$$NOW' },
            ],
          },
        },
        { $set: { mcpConsent: enrollment } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },
    async revokeScheduleMCPConsent(identity, revision) {
      const revokedRevision = randomUUID();
      const result = await model().updateOne({ ...scope(identity), ...revisionFilter(revision) }, [
        {
          $set: {
            'mcpConsent.revision': { $literal: revokedRevision },
            'mcpConsent.consents': {
              $map: {
                input: {
                  $cond: [{ $isArray: '$mcpConsent.consents' }, '$mcpConsent.consents', []],
                },
                as: 'consent',
                in: {
                  $mergeObjects: [
                    '$$consent',
                    {
                      revision: { $literal: revokedRevision },
                      revokedAtMs: { $ifNull: ['$$consent.revokedAtMs', { $toLong: '$$NOW' }] },
                    },
                  ],
                },
              },
            },
          },
        },
      ]);
      return result.matchedCount === 1;
    },
    async admitScheduleMCPConsent(input) {
      const result = await model().updateOne(
        {
          ...scope(input.identity),
          ...configFilter(input.expectedConfigRevision),
          ...revisionFilter(input.revision),
          agent_id: input.identity.agentId,
          enabled: true,
          'mcpConsent.consents': {
            $elemMatch: { id: input.consentId, revision: input.revision, revokedAtMs: null },
          },
          $expr: {
            $allElementsTrue: [
              {
                $map: {
                  input: {
                    $cond: [{ $isArray: '$mcpConsent.consents' }, '$mcpConsent.consents', []],
                  },
                  as: 'consent',
                  in: {
                    $and: [
                      { $eq: ['$$consent.revokedAtMs', null] },
                      { $gt: ['$$consent.absoluteExpiresAtMs', { $toLong: '$$NOW' }] },
                    ],
                  },
                },
              },
            ],
          },
        },
        { $set: { 'mcpConsent.revision': input.revision } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
  };
}
