import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IAction } from '~/types';
import { createActionMethods } from './action';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let methods: ReturnType<typeof createActionMethods>;
let Action: mongoose.Model<IAction>;

const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();

const seed = (overrides: Partial<IAction>) =>
  Action.create({
    user: userA,
    action_id: 'act-1',
    type: 'action_prototype',
    metadata: { domain: 'example.com', auth: { type: 'none', token_exchange_method: null } },
    ...overrides,
  } as Partial<IAction>);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Object.assign(mongoose.models, createModels(mongoose));
  Action = mongoose.models.Action;
  methods = createActionMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Action.deleteMany({});
});

describe('action criteria', () => {
  it('finds by a single action id', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });
    await seed({ action_id: 'act-2', agent_id: 'agent-1' });

    const found = await methods.getActions({ actionId: 'act-1' }, true);

    expect(found.map((a) => a.action_id)).toEqual(['act-1']);
  });

  it('finds by any of several ids', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });
    await seed({ action_id: 'act-2', agent_id: 'agent-1' });
    await seed({ action_id: 'act-3', agent_id: 'agent-1' });

    const found = await methods.getActions({ actionId: ['act-1', 'act-3'] }, true);

    expect(found.map((a) => a.action_id).sort()).toEqual(['act-1', 'act-3']);
  });

  it('combines criteria with AND', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });
    await seed({ action_id: 'act-1', agent_id: 'agent-2' });

    const found = await methods.getActions({ actionId: 'act-1', agentId: 'agent-2' }, true);

    expect(found).toHaveLength(1);
    expect(found[0].agent_id).toBe('agent-2');
  });

  it('scopes deletes to the owning user', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1', user: userA });
    await seed({ action_id: 'act-2', agent_id: 'agent-1', user: userB });

    const deleted = await methods.deleteActions({ agentId: 'agent-1', user: String(userB) });

    expect(deleted).toBe(1);
    const remaining = await methods.getActions({}, true);
    expect(remaining.map((a) => a.action_id)).toEqual(['act-1']);
  });

  it('rejects an unrecognized criterion instead of matching every action', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });

    await expect(
      methods.getActions({ action_id: 'act-1' } as unknown as { actionId?: string }, true),
    ).rejects.toThrow("Unknown query criterion: 'action_id'");
  });

  it('does not delete every action when given an unrecognized criterion', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });
    await seed({ action_id: 'act-2', agent_id: 'agent-2' });

    await expect(
      methods.deleteActions({ agent_id: 'agent-1' } as unknown as { agentId?: string }),
    ).rejects.toThrow("Unknown query criterion: 'agent_id'");
    await expect(Action.countDocuments({})).resolves.toBe(2);
  });

  it('does not delete every action when a misspelled criterion carries undefined', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });
    await seed({ action_id: 'act-2', agent_id: 'agent-2' });

    const absent: string | undefined = undefined;
    await expect(
      methods.deleteActions({ agent_id: absent } as unknown as { agentId?: string }),
    ).rejects.toThrow("Unknown query criterion: 'agent_id'");
    await expect(Action.countDocuments({})).resolves.toBe(2);
  });

  it('still omits a recognized criterion the caller left undefined', async () => {
    await seed({ action_id: 'act-1', agent_id: 'agent-1' });
    await seed({ action_id: 'act-2', agent_id: 'agent-2' });

    const found = await methods.getActions({ actionId: 'act-1', agentId: undefined }, true);

    expect(found.map((a) => a.action_id)).toEqual(['act-1']);
  });
});
