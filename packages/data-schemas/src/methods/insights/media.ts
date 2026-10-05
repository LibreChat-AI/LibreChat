import type { TMediaInsights, TMediaInsightsTotals } from 'librechat-data-provider';
import type { PipelineStage } from 'mongoose';
import { createTransactionModel } from '~/models/transaction';

type MediaInsightsOptions = {
  tenantId?: string;
  from: Date;
  to: Date;
  page: number;
  pageSize: number;
};

const emptyTotals = (): TMediaInsightsTotals => ({
  submitted: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  uncertain: 0,
  active: 0,
  providerCostUSD: 0,
  tokenCostUSD: 0,
  creditsCharged: 0,
  balanceCostJobs: 0,
  unbilledJobs: 0,
  operatorCostUSD: 0,
  estimatedCostUSD: 0,
  unclassifiedCostUSD: 0,
  unknownCostJobs: 0,
});

/** Reads the shared financial receipt, never provider estimates or message token counters. */
export async function getMediaInsights(
  mongoose: typeof import('mongoose'),
  options: MediaInsightsOptions,
): Promise<TMediaInsights> {
  const page = Math.max(1, Math.floor(options.page));
  const pageSize = options.pageSize;
  const balanceCost = { $eq: ['$accountingMode', 'balance'] };
  const countPhase = (phase: string) => ({ $sum: { $cond: [{ $eq: ['$phase', phase] }, 1, 0] } });
  const cost = (source: string) => ({
    $sum: {
      $cond: [
        {
          $and: [
            { $eq: ['$receiptCost.costSource', source] },
            { $ne: ['$operatorSettlement', true] },
          ],
        },
        { $ifNull: ['$receiptCost.costUSD', 0] },
        0,
      ],
    },
  });
  const totals = {
    submitted: { $sum: 1 },
    completed: countPhase('succeeded'),
    failed: countPhase('failed'),
    cancelled: countPhase('cancelled'),
    uncertain: countPhase('requires_attention'),
    active: {
      $sum: {
        $cond: [
          { $in: ['$phase', ['queued', 'submitting', 'running', 'ingesting', 'reconciling']] },
          1,
          0,
        ],
      },
    },
    providerCostUSD: cost('provider'),
    tokenCostUSD: cost('tokens'),
    creditsCharged: {
      $sum: {
        $cond: [balanceCost, { $multiply: [{ $ifNull: ['$receiptCost.tokenValue', 0] }, -1] }, 0],
      },
    },
    balanceCostJobs: { $sum: { $cond: [balanceCost, 1, 0] } },
    unbilledJobs: { $sum: { $cond: [{ $eq: ['$accountingMode', 'none'] }, 1, 0] } },
    estimatedCostUSD: cost('estimate'),
    operatorCostUSD: {
      $sum: { $cond: ['$operatorSettlement', { $ifNull: ['$receiptCost.costUSD', 0] }, 0] },
    },
    unclassifiedCostUSD: {
      $sum: {
        $cond: [
          {
            $or: [
              '$operatorSettlement',
              { $in: ['$receiptCost.costSource', ['provider', 'tokens', 'estimate']] },
            ],
          },
          0,
          { $ifNull: ['$receiptCost.costUSD', 0] },
        ],
      },
    },
    unknownCostJobs: {
      $sum: {
        $cond: [
          {
            $and: [
              { $ne: ['$provider.certainty', 'unsubmitted'] },
              { $ne: ['$accountingMode', 'none'] },
              { $eq: [{ $ifNull: ['$receiptCost.costUSD', null] }, null] },
            ],
          },
          1,
          0,
        ],
      },
    },
  };
  const match: PipelineStage.Match = {
    $match: {
      tenantId: options.tenantId ?? null,
      executionOwner: 'media',
      'receipt.phase': 'accepted',
      createdAt: { $gte: options.from, $lte: options.to },
    },
  };
  const pipeline: PipelineStage[] = [
    match,
    {
      $lookup: {
        // eslint-disable-next-line no-restricted-syntax -- The joined receipts are filtered by owner and tenant below.
        from: createTransactionModel(mongoose).collection.name,
        localField: 'jobId',
        foreignField: 'mediaJobId',
        as: 'costs',
      },
    },
    {
      $addFields: {
        receiptCost: {
          $arrayElemAt: [
            {
              $filter: {
                input: '$costs',
                as: 'cost',
                cond: {
                  $and: [
                    {
                      $in: [
                        '$$cost.context',
                        ['media', 'image_generation', 'image_edit', 'video_generation'],
                      ],
                    },
                    { $eq: [{ $toString: '$$cost.user' }, '$ownerId'] },
                    {
                      $eq: [
                        { $ifNull: ['$$cost.tenantId', null] },
                        { $ifNull: ['$tenantId', null] },
                      ],
                    },
                  ],
                },
              },
            },
            0,
          ],
        },
        operatorSettlement: {
          $in: ['settle', { $ifNull: ['$recoveryDecisions.request.action', []] }],
        },
      },
    },
    {
      $addFields: {
        accountingMode: {
          $ifNull: ['$execution.accountingMode', '$receiptCost.mediaAccountingMode'],
        },
        'receiptCost.costUSD': { $ifNull: ['$receiptCost.costUSD', '$receiptCost.mediaCostUSD'] },
        'receiptCost.costSource': {
          $ifNull: ['$receiptCost.costSource', '$receiptCost.mediaCostSource'],
        },
      },
    },
  ];
  const [summary, offerings, offeringCount] = await Promise.all([
    mongoose.models.MediaJob.aggregate<TMediaInsightsTotals>([
      ...pipeline,
      { $group: { _id: null, ...totals } },
      { $project: { _id: 0 } },
    ]),
    mongoose.models.MediaJob.aggregate<TMediaInsights['offerings'][number]>([
      ...pipeline,
      {
        $group: {
          _id: {
            provider: '$execution.api',
            model: '$execution.modelId',
            operation: '$operation',
          },
          ...totals,
        },
      },
      { $sort: { submitted: -1, '_id.provider': 1, '_id.model': 1, '_id.operation': 1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      {
        $project: {
          _id: 0,
          provider: '$_id.provider',
          model: '$_id.model',
          operation: '$_id.operation',
          ...Object.fromEntries(Object.keys(totals).map((key) => [key, 1])),
        },
      },
    ]),
    mongoose.models.MediaJob.aggregate<{ total: number }>([
      match,
      { $group: { _id: ['$execution.api', '$execution.modelId', '$operation'] } },
      { $count: 'total' },
    ]),
  ]);
  return {
    summary: summary[0] ?? emptyTotals(),
    offerings,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil((offeringCount[0]?.total ?? 0) / pageSize)),
  };
}
