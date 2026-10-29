import type { ChannelRunSnapshot, ResponseAccounting } from 'librechat-data-provider';
import type { ChannelRunRecord } from '~/models/channelRun';

export type ChannelSummaryScope = Pick<
  ChannelRunRecord,
  'tenantId' | 'channelId' | 'agentId' | 'laneId' | 'principal' | 'sequence' | 'admission'
>;

export interface ChannelSummaryRow {
  sequence: number;
  snapshot?: Pick<ChannelRunSnapshot, 'status' | 'elapsedMs' | 'usage'> & {
    accounting?: Pick<
      ResponseAccounting,
      'status' | 'currency' | 'coverage' | 'amount' | 'basis' | 'reason'
    > & { calls?: Array<Pick<ResponseAccounting['calls'][number], 'reason'>> };
  };
}

export interface ChannelSummaryStorage {
  /** Newest prior attempts, with a fixed presentation safety bound; not a billing ledger. */
  priorMetrics(scope: ChannelSummaryScope): AsyncIterable<ChannelSummaryRow>;
}

/** Bounds footer work independently of thread length. Older rows become explicit coverage gaps. */
export const CHANNEL_SUMMARY_MAX_PRIOR_ROWS = 1000;

export function createChannelSummaryStorage(
  mongoose: typeof import('mongoose'),
): ChannelSummaryStorage {
  return {
    async *priorMetrics(scope) {
      if (!Number.isSafeInteger(scope.sequence) || scope.sequence < 1)
        throw new Error('Invalid channel summary sequence');
      const cursor = mongoose
        .model<ChannelRunRecord>('ChannelRun')
        .find({
          tenantId: scope.tenantId,
          laneId: scope.laneId,
          sequence: { $gte: 1, $lt: scope.sequence },
          channelId: scope.channelId,
          agentId: scope.agentId,
          'principal.userId': scope.principal.userId,
          'principal.channelRevision': scope.principal.channelRevision,
          'principal.linkId': scope.principal.linkId ?? null,
          'principal.linkRevision': scope.principal.linkRevision ?? null,
          'admission.actor.teamId': scope.admission.actor.teamId,
          'admission.actor.appId': scope.admission.actor.appId,
          'admission.actor.externalUserId': scope.admission.actor.externalUserId,
          'admission.externalChannelId': scope.admission.externalChannelId,
          'admission.externalThreadKey': scope.admission.externalThreadKey,
        })
        .select({
          _id: 0,
          sequence: 1,
          'snapshot.status': 1,
          'snapshot.elapsedMs': 1,
          'snapshot.usage': 1,
          'snapshot.accounting.status': 1,
          'snapshot.accounting.currency': 1,
          'snapshot.accounting.coverage': 1,
          'snapshot.accounting.amount': 1,
          'snapshot.accounting.basis': 1,
          'snapshot.accounting.reason': 1,
          'snapshot.accounting.calls.reason': 1,
        })
        .sort({ sequence: -1 })
        .limit(CHANNEL_SUMMARY_MAX_PRIOR_ROWS)
        .lean<ChannelSummaryRow[]>()
        .cursor();
      try {
        for await (const row of cursor) yield row;
      } finally {
        await cursor.close();
      }
    },
  };
}
