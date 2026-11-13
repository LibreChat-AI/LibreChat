import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createMethods } from './index';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
afterEach(async () => {
  await Promise.all(
    ['User', 'Agent', 'SharedLink'].map((name) => mongoose.models[name].deleteMany({})),
  );
});

it('returns only live admission owner fields with a plain identity', async () => {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.models.User.collection.insertOne({
    _id,
    role: 'USER',
    termsAccepted: false,
    email: 'private@example.test',
  });
  expect(await methods.findScheduleOwner(_id.toString())).toEqual({
    _id: _id.toString(),
    role: 'USER',
    termsAccepted: false,
  });
  expect(await methods.findScheduleOwner(new mongoose.Types.ObjectId().toString())).toBeNull();
});

it('returns an agent identity without leaking its definition and propagates query rejection', async () => {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.models.Agent.collection.insertOne({ _id, id: 'agent', instructions: 'private' });
  expect(await methods.findAgentIdentity('agent')).toEqual({ _id: _id.toString() });
  expect(await methods.findAgentIdentity('missing')).toBeNull();
  const failure = jest.spyOn(mongoose.models.Agent, 'findOne').mockImplementationOnce(() => {
    throw new Error('query failed');
  });
  await expect(methods.findAgentIdentity('agent')).rejects.toThrow('query failed');
  failure.mockRestore();
});

it('discovers every user link before awaited cleanup, retaining rows when cleanup rejects', async () => {
  const user = new mongoose.Types.ObjectId().toString();
  const rows = await mongoose.models.SharedLink.create([
    { user, conversationId: 'one', shareId: 'one', messages: [], expiredAt: new Date(0) },
    { user, conversationId: 'two', shareId: 'two', messages: [] },
  ]);
  const ids = rows.map((row) => row._id.toString()).sort();
  const cleanup = jest.fn(async (found: string[]) => {
    expect(found.sort()).toEqual(ids);
    expect(await mongoose.models.SharedLink.countDocuments({ user })).toBe(2);
    throw new Error('cleanup failed');
  });
  await expect(methods.deleteAllSharedLinks(user, cleanup)).rejects.toThrow('cleanup failed');
  expect(await mongoose.models.SharedLink.countDocuments({ user })).toBe(2);
  expect(await methods.findActiveSharedLink('one')).toBeNull();
  expect((await methods.findActiveSharedLink('two'))?._id).toBe(rows[1]._id.toString());
  expect((await methods.deleteAllSharedLinks(user)).deletedIds.sort()).toEqual(ids);
});
