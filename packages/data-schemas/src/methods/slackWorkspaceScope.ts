import type { ClientSession } from 'mongoose';
import { createSlackWorkspaceModel } from '~/models/slackWorkspace';

/** Join an admission/configuration write to the installation's disconnect fence. */
export async function touchSlackWorkspace(
  mongoose: typeof import('mongoose'),
  scope: { workspaceId: string; tenantId?: string; teamId?: string; appId?: string },
  session: ClientSession,
): Promise<boolean> {
  const current = await createSlackWorkspaceModel(mongoose).updateOne(
    {
      workspaceId: scope.workspaceId,
      tenantId: !scope.tenantId || scope.tenantId === '_' ? null : scope.tenantId,
      status: 'active',
      ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
      ...(scope.appId === undefined ? {} : { appId: scope.appId }),
    },
    { $inc: { authorityWrites: 1 } },
    { session },
  );
  return current.matchedCount === 1;
}
