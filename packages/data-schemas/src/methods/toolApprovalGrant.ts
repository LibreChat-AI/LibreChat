import { randomUUID } from 'crypto';
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';

interface StoredGrant {
  agentId: string;
  toolName: string;
  conversationId: string;
  binding?: string;
  revocation?: string;
  approvedRevocation?: string;
}

export function createToolApprovalGrantMethods(
  mongoose: typeof import('mongoose'),
): ToolApprovalGrantStorage {
  return {
    async getToolApprovalGrants(scope, bindings) {
      if (bindings.length === 0) return [];
      const records = await mongoose.models.ToolApprovalGrant.find({
        user: scope.userId,
        tenantId: scope.tenantId ?? null,
        $or: [
          {
            binding: { $in: bindings.map((grant) => grant.binding) },
            conversationId: { $in: ['', scope.conversationId] },
          },
          ...bindings.map(({ agentId, toolName }) => ({ agentId, toolName, conversationId: '' })),
        ],
      })
        .select('agentId toolName conversationId binding revocation approvedRevocation -_id')
        .lean<StoredGrant[]>();
      const revocations = new Map<string, string | undefined>();
      const granted = new Map<string, StoredGrant>();
      const key = (agentId: string, toolName: string) => JSON.stringify([agentId, toolName]);
      for (const record of records) {
        if (record.conversationId === '')
          revocations.set(key(record.agentId, record.toolName), record.revocation);
        if (record.binding) granted.set(record.binding, record);
      }
      return bindings.map((grant) => {
        const revocation = revocations.get(key(grant.agentId, grant.toolName));
        const record = granted.get(grant.binding);
        return {
          binding: grant.binding,
          revocation,
          approved: record != null && (record.approvedRevocation ?? '') === (revocation ?? ''),
        };
      });
    },
    async rememberToolApprovalGrants(scope, grants) {
      await Promise.all(
        grants.map(async (grant) => {
          const filter = {
            user: scope.userId,
            tenantId: scope.tenantId ?? null,
            agentId: grant.agentId,
            toolName: grant.toolName,
            conversationId: grant.scope === 'chat' ? scope.conversationId : '',
          };
          const update = {
            $set: { binding: grant.binding, approvedRevocation: grant.revocation ?? '' },
            $setOnInsert: filter,
          };
          try {
            await mongoose.models.ToolApprovalGrant.updateOne(filter, update, {
              upsert: true,
              runValidators: true,
            });
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 11000)
              throw error;
            await mongoose.models.ToolApprovalGrant.updateOne(filter, update, {
              runValidators: true,
            });
          }
        }),
      );
    },
    async resetToolApprovalGrants(userId, agentId, toolName) {
      const existing = await mongoose.models.ToolApprovalGrant.exists({
        user: userId,
        agentId,
        toolName,
      });
      if (!existing) return;
      const filter = { user: userId, agentId, toolName, conversationId: '' };
      await mongoose.models.ToolApprovalGrant.updateOne(
        filter,
        {
          $set: { revocation: randomUUID() },
          $unset: { binding: 1, approvedRevocation: 1 },
          $setOnInsert: filter,
        },
        { upsert: true, runValidators: true },
      );
    },
  };
}
