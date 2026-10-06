import { z } from 'zod';
import { randomUUID } from 'crypto';
import type {
  ToolApprovalGrantStorage,
  ToolApprovalGrantScope,
  ToolApprovalGrantBinding,
} from 'librechat-data-provider';

interface StoredGrant {
  agentId: string;
  toolName: string;
  conversationId: string;
  binding?: string;
  revocation?: string;
  generation?: number;
  approvedRevocation?: string;
  oauthEpoch?: string | null;
}

/** Canonical MCP tool keys include their source; `*` is reserved for the agent-wide fence. */
const AGENT_FENCE_TOOL = '*';
const epochSchema = z.tuple([
  z.string(),
  z.string(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

function epochGenerations(revocation?: string): readonly [number, number] | undefined {
  if (revocation == null) return [0, 0];
  try {
    const epoch = epochSchema.safeParse(JSON.parse(revocation));
    return epoch.success ? [epoch.data[2], epoch.data[3]] : undefined;
  } catch {
    return undefined;
  }
}

export function createToolApprovalGrantMethods(
  mongoose: typeof import('mongoose'),
): ToolApprovalGrantStorage {
  async function readGrants(
    scope: ToolApprovalGrantScope,
    bindings: readonly ToolApprovalGrantBinding[],
  ) {
    if (bindings.length === 0) return [];
    const recordsQuery = mongoose.models.ToolApprovalGrant.find({
      user: scope.userId,
      tenantId: scope.tenantId ?? null,
      $or: [
        {
          binding: { $in: bindings.map((grant) => grant.binding) },
          conversationId: { $in: ['', scope.conversationId] },
        },
        ...bindings.map(({ agentId, toolName }) => ({
          agentId,
          toolName,
          conversationId: { $in: ['', scope.conversationId] },
        })),
        {
          agentId: { $in: [...new Set(bindings.map((grant) => grant.agentId))] },
          toolName: AGENT_FENCE_TOOL,
          conversationId: '',
        },
      ],
    })
      .select(
        'agentId toolName conversationId binding revocation generation approvedRevocation oauthEpoch -_id',
      )
      .lean<StoredGrant[]>();
    const servers = [
      ...new Set(
        bindings.flatMap((binding) =>
          binding.serverName && binding.authKind !== 'other' ? [binding.serverName] : [],
        ),
      ),
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
    const agentRevocations = new Map<string, StoredGrant>();
    const revocations = new Map<string, StoredGrant>();
    const granted = new Map<string, StoredGrant>();
    const stored = new Map<string, StoredGrant>();
    const recordKey = (agentId: string, toolName: string, conversationId: string) =>
      JSON.stringify([agentId, toolName, conversationId]);
    const key = (agentId: string, toolName: string) => JSON.stringify([agentId, toolName]);
    for (const record of records) {
      stored.set(recordKey(record.agentId, record.toolName, record.conversationId), record);
      if (record.conversationId === '') {
        if (record.toolName === AGENT_FENCE_TOOL) agentRevocations.set(record.agentId, record);
        else revocations.set(key(record.agentId, record.toolName), record);
      }
      if (record.binding) granted.set(record.binding, record);
    }
    return bindings.map((grant) => {
      const toolRevocation = revocations.get(key(grant.agentId, grant.toolName));
      const agentRevocation = agentRevocations.get(grant.agentId);
      const revocation =
        agentRevocation?.revocation == null && toolRevocation?.revocation == null
          ? undefined
          : JSON.stringify([
              agentRevocation?.revocation ?? '',
              toolRevocation?.revocation ?? '',
              agentRevocation?.generation ?? 0,
              toolRevocation?.generation ?? 0,
            ]);
      const record = granted.get(grant.binding);
      const oauthEpoch =
        grant.serverName && grant.authKind !== 'other' ? epochs.get(grant.serverName) : null;
      const previous = stored.get(
        recordKey(
          grant.agentId,
          grant.toolName,
          grant.scope === 'chat' ? scope.conversationId : '',
        ),
      );
      return {
        previousOAuthEpoch: previous?.oauthEpoch ?? null,
        status: {
          binding: grant.binding,
          revocation,
          oauthEpoch,
          consentBinding: previous?.binding ?? null,
          approved:
            oauthEpoch !== undefined &&
            record != null &&
            (record.oauthEpoch ?? null) === oauthEpoch &&
            (record.approvedRevocation ?? '') === (revocation ?? ''),
        },
      };
    });
  }
  const methods: ToolApprovalGrantStorage = {
    async getToolApprovalGrants(scope, bindings) {
      return (await readGrants(scope, bindings)).map(({ status }) => status);
    },
    async rememberToolApprovalGrants(scope, grants) {
      if (grants.some((grant) => grant.scope === 'once'))
        throw new TypeError('One-time approvals cannot be remembered.');
      const current = new Map(
        (await readGrants(scope, grants)).map((snapshot) => [snapshot.status.binding, snapshot]),
      );
      await Promise.all(
        grants.map(async (grant) => {
          const snapshot = current.get(grant.binding);
          if (
            !snapshot ||
            snapshot.status.revocation !== grant.revocation ||
            snapshot.status.oauthEpoch === undefined ||
            snapshot.status.oauthEpoch !== (grant.oauthEpoch ?? null) ||
            (snapshot.status.consentBinding !== (grant.consentBinding ?? null) &&
              snapshot.status.consentBinding !== grant.binding)
          )
            return;
          const generations = epochGenerations(grant.revocation);
          if (!generations) return;
          const [agentGeneration, toolGeneration] = generations;
          // Monotonic predicates protect renewal if reset lands after the batched fence read.
          const filter = {
            user: scope.userId,
            tenantId: scope.tenantId ?? null,
            agentId: grant.agentId,
            toolName: grant.toolName,
            conversationId: grant.scope === 'chat' ? scope.conversationId : '',
            // A replacement account's successful write wins even if this read preceded reauthorization.
            oauthEpoch: snapshot.previousOAuthEpoch,
            // Idempotent same-authority completions cannot overwrite a replacement binding.
            binding: { $in: [grant.consentBinding ?? null, grant.binding] },
            $and: [
              {
                $or: [
                  { approvedAgentGeneration: { $lte: agentGeneration } },
                  { approvedAgentGeneration: { $exists: false } },
                ],
              },
              {
                $or: [
                  { approvedToolGeneration: { $lte: toolGeneration } },
                  { approvedToolGeneration: { $exists: false } },
                ],
              },
              // Persistent grants share the targeted reset fence's document.
              {
                $or: [{ generation: { $lte: toolGeneration } }, { generation: { $exists: false } }],
              },
            ],
          };
          const update = {
            $set: {
              binding: grant.binding,
              approvedRevocation: grant.revocation ?? '',
              oauthEpoch: grant.oauthEpoch ?? null,
              approvedAgentGeneration: agentGeneration,
              approvedToolGeneration: toolGeneration,
            },
            $setOnInsert: {
              user: scope.userId,
              tenantId: scope.tenantId ?? null,
              agentId: grant.agentId,
              toolName: grant.toolName,
              conversationId: filter.conversationId,
            },
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
          $inc: { generation: 1 },
          $unset: { binding: 1, approvedRevocation: 1 },
          $setOnInsert: filter,
        },
        { upsert: true, runValidators: true },
      );
    },
  };
  return methods;
}
