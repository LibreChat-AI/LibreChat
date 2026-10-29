import type { ResponseOwner } from '~/models/response';
import { createChannelRunModel, createChannelLaneModel } from '~/models/channelRun';

/** The caller closes the response owner admission anchor before entering this cascade. */
export async function eraseChannelOwner(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
): Promise<void> {
  const tenantId = owner.tenantId || '_';
  const runs = createChannelRunModel(mongoose);
  const lanes = createChannelLaneModel(mongoose);
  const filter = { tenantId, 'principal.userId': owner.userId };
  // New lanes have an indexed owner. Older rows are recovered from the still-retained runs.
  await lanes.deleteMany({ tenantId, userId: owner.userId });
  const cursor = runs.find(filter).select('laneId').lean().cursor();
  const batch = new Set<string>();
  try {
    for await (const run of cursor) {
      batch.add(run.laneId);
      if (batch.size === 250) {
        await lanes.deleteMany({ tenantId, laneId: { $in: [...batch] } });
        batch.clear();
      }
    }
    if (batch.size) await lanes.deleteMany({ tenantId, laneId: { $in: [...batch] } });
  } finally {
    await cursor.close();
  }
  await runs.deleteMany(filter);
}
