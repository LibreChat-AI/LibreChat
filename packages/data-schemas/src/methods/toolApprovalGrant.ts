import { randomUUID } from 'crypto';
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';

interface StoredGrant {
  agentId: string;
  toolName: string;
  conversationId: string;
  binding?: string;
  revocation?: string;
  approvedRevocation?: string;
  oauthEpoch?: string | null;
}

/** Canonical MCP tool keys include their source; `*` is reserved for the agent-wide fence. */
const AGENT_FENCE_TOOL = '*';

export function createToolApprovalGrantMethods(
  mongoose: typeof import('mongoose'),
): ToolApprovalGrantStorage {
  return {
    async getToolApprovalGrants(scope, bindings) {
      if (bindings.length === 0) return [];
      const recordsQuery = mongoose.models.ToolApprovalGrant.find({
        user: scope.userId,
        tenantId: scope.tenantId ?? null,
        $or: [
          {
            binding: { $in: bindings.map((grant) => grant.binding) },
            conversationId: { $in: ['', scope.conversationId] },
          },
          ...bindings.map(({ agentId, toolName }) => ({ agentId, toolName, conversationId: '' })),
          {
            agentId: { $in: [...new Set(bindings.map((grant) => grant.agentId))] },
            toolName: AGENT_FENCE_TOOL,
            conversationId: '',
          },
        ],
      })
        .select(
          'agentId toolName conversationId binding revocation approvedRevocation oauthEpoch -_id',
        )
        .lean<StoredGrant[]>();
      const servers = [
        ...new Set(bindings.flatMap((binding) => (binding.serverName ? [binding.serverName] : []))),
      ];
      const identities = servers.flatMap((server) => [
        { server, type: 'mcp_oauth', identifier: `mcp:${server}` },
        { server, type: 'mcp_oauth_refresh', identifier: `mcp:${server}:refresh` },
        { server, type: 'mcp_oauth_client', identifier: `mcp:${server}:client` },
      ]);
      const [records, tokens] = await Promise.all([
        recordsQuery,
        identities.length === 0
          ? Promise.resolve([])
          : mongoose.models.Token.find({
              userId: scope.userId,
              tenantId: scope.tenantId ?? null,
              $or: identities.map(({ type, identifier }) => ({ type, identifier })),
            })
              .select('type identifier metadata.credential_set_id -_id')
              .lean<
                Array<{
                  type: string;
                  identifier: string;
                  metadata?: { credential_set_id?: string };
                }>
              >({ flattenMaps: true }),
      ]);
      const identityKey = (type: string, identifier: string) => JSON.stringify([type, identifier]);
      const owners = new Map(
        identities.map(({ server, type, identifier }) => [identityKey(type, identifier), server]),
      );
      const generations = new Map<string, Set<string | undefined>>();
      for (const token of tokens) {
        const server = owners.get(identityKey(token.type, token.identifier));
        if (!server) continue;
        const values = generations.get(server) ?? new Set<string | undefined>();
        values.add(token.metadata?.credential_set_id);
        generations.set(server, values);
      }
      const epochs = new Map<string, string | null | undefined>();
      for (const server of servers) {
        const values = generations.get(server);
        if (!values) {
          epochs.set(server, null);
          continue;
        }
        const value = values.values().next().value;
        epochs.set(
          server,
          values.size === 1 && typeof value === 'string' && value.length > 0 ? value : undefined,
        );
      }
      const agentRevocations = new Map<string, string | undefined>();
      const revocations = new Map<string, string | undefined>();
      const granted = new Map<string, StoredGrant>();
      const key = (agentId: string, toolName: string) => JSON.stringify([agentId, toolName]);
      for (const record of records) {
        if (record.conversationId === '') {
          if (record.toolName === AGENT_FENCE_TOOL)
            agentRevocations.set(record.agentId, record.revocation);
          else revocations.set(key(record.agentId, record.toolName), record.revocation);
        }
        if (record.binding) granted.set(record.binding, record);
      }
      return bindings.map((grant) => {
        const toolRevocation = revocations.get(key(grant.agentId, grant.toolName));
        const agentRevocation = agentRevocations.get(grant.agentId);
        const revocation =
          agentRevocation == null
            ? toolRevocation
            : JSON.stringify([agentRevocation, toolRevocation ?? '']);
        const record = granted.get(grant.binding);
        const oauthEpoch = grant.serverName ? epochs.get(grant.serverName) : null;
        return {
          binding: grant.binding,
          revocation,
          oauthEpoch,
          approved:
            oauthEpoch !== undefined &&
            record != null &&
            (record.oauthEpoch ?? null) === oauthEpoch &&
            (record.approvedRevocation ?? '') === (revocation ?? ''),
        };
      });
    },
    async rememberToolApprovalGrants(scope, grants) {
      await Promise.all(
        grants.map(async (grant) => {
          if (grant.scope === 'once')
            throw new TypeError('One-time approvals cannot be remembered.');
          const filter = {
            user: scope.userId,
            tenantId: scope.tenantId ?? null,
            agentId: grant.agentId,
            toolName: grant.toolName,
            conversationId: grant.scope === 'chat' ? scope.conversationId : '',
          };
          const update = {
            $set: {
              binding: grant.binding,
              approvedRevocation: grant.revocation ?? '',
              oauthEpoch: grant.oauthEpoch ?? null,
            },
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
      const filter = {
        user: userId,
        agentId,
        toolName: toolName ?? AGENT_FENCE_TOOL,
        conversationId: '',
      };
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
