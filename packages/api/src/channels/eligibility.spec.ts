import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Permissions, PermissionTypes, PermissionBits } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelIdentityStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { IUser, AgentChannelRecord } from '@librechat/data-schemas';
import type { ChannelIdentityResult } from 'librechat-data-provider';
import { createChannelAuthority, channelExternalIdentity } from './authority';

let mongo: MongoMemoryReplSet;
let db: ReturnType<typeof createMethods>;
let authority: ReturnType<typeof createChannelAuthority>;
let channel: AgentChannelRecord;
let creator: IUser;
let participant: IUser;
let enabled: boolean;
let permissions: number;
let previousPolicy: string | undefined;
const tenantId = 'eligibility-test';
const actor = { teamId: 'T1', appId: 'A1', externalUserId: 'U1' };
const scope = <T>(run: () => Promise<T>) => tenantStorage.run({ tenantId }, run);
function value<T>(result: ChannelIdentityResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  previousPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
  await runAsSystem(() =>
    Promise.all(
      [
        'User',
        'Role',
        'AgentChannel',
        'ChannelIdentity',
        'ChannelRun',
        'ChannelLane',
        'ChannelScope',
        'ResponseScope',
        'AgentTriggerUserPurge',
      ].map((name) => mongoose.models[name].deleteMany({})),
    ),
  );
  enabled = true;
  permissions = PermissionBits.VIEW;
  await scope(async () => {
    [creator, participant] = await mongoose.models.User.create([
      { email: 'creator@example.test', role: 'USER', provider: 'local', tenantId },
      { email: 'participant@example.test', role: 'USER', provider: 'local', tenantId },
    ]);
    await mongoose.models.Role.create({
      name: 'USER',
      permissions: {
        [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
        [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
      },
    });
    channel = await db.createAgentChannel({
      channelId: 'channel',
      tenantId,
      agentId: 'agent',
      createdBy: String(creator._id),
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: 'channel-revision',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    });
  });
  authority = createChannelAuthority({
    channels: db,
    identityStorage: createChannelIdentityStorage(mongoose),
    findUser: (id) => db.findUser({ _id: id }),
    getRole: (name) => db.getRoleByName(name),
    getConfig: async (user) => {
      expect(String(user._id)).toBe(String(participant._id));
      return { enabled };
    },
    isPrincipalActive: db.isAgentTriggerPrincipalActive,
    getAgentPermissions: async () => permissions,
    publicBaseUrl: 'https://example.test',
  });
});
afterEach(() => {
  if (previousPolicy == null) delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  else process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = previousPolicy;
});
async function linked() {
  const identity = channelExternalIdentity(channel, actor.externalUserId);
  const principal = { userId: String(participant._id), tenantId, accountLabel: 'Participant' };
  const ticket = value(await authority.identity.issue(identity));
  const secret = new URL(ticket.url).hash.slice(1);
  const preview = value(await authority.identity.preview(principal, secret));
  const accepted = value(await authority.identity.accept(principal, secret, preview.revision));
  value(await authority.identity.confirm(identity, accepted.linkId, accepted.revision));
  return { identity, principal };
}

it.each(['agents', 'remote', 'agent_access', 'disabled', 'two_factor', 'deleted'])(
  'rechecks %s eligibility for linking and current principal resolution',
  async (change) =>
    scope(async () => {
      const { identity } = await linked();
      const principal = await authority.resolvePrincipal(channel, actor);
      if (!principal) throw new Error('Missing eligible participant');
      expect(principal.userId).toBe(String(participant._id));
      expect(value(await authority.identity.resolve(identity)).userId).toBe(principal.userId);
      if (change === 'agents' || change === 'remote')
        await mongoose.models.Role.updateOne(
          { name: 'USER' },
          {
            $set: {
              [`permissions.${change === 'agents' ? PermissionTypes.AGENTS : PermissionTypes.REMOTE_AGENTS}.${Permissions.USE}`]: false,
            },
          },
        );
      if (change === 'agent_access') permissions = 0;
      if (change === 'disabled') enabled = false;
      if (change === 'two_factor') process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
      if (change === 'deleted') await mongoose.models.User.deleteOne({ _id: participant._id });
      expect(await authority.resolvePrincipal(channel, actor)).toBeNull();
      expect(await authority.identity.resolve(identity)).toMatchObject({ ok: false });
    }),
);

it('uses the canonical channel revision and never accepts a foreign tenant or actor', async () =>
  scope(async () => {
    await linked();
    expect(
      await authority.resolvePrincipal(channel, { ...actor, externalUserId: 'U2' }),
    ).toBeNull();
    await expect(
      authority.resolvePrincipal({ ...channel, tenantId: 'foreign' }, actor),
    ).rejects.toThrow(TypeError);
    await db.updateAgentChannel(
      channel.channelId,
      channel.createdBy,
      { revision: 'rotated' },
      'active',
      channel.revision,
    );
    expect(await authority.resolvePrincipal(channel, actor)).toBeNull();
  }));
