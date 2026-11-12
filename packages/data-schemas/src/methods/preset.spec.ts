import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createPresetMethods } from './preset';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let methods: ReturnType<typeof createPresetMethods>;

const user = new mongoose.Types.ObjectId().toString();
const otherUser = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createPresetMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Preset.deleteMany({});
});

async function defaultsFor(owner: string): Promise<string[]> {
  const docs = await mongoose.models.Preset.find({ user: owner, defaultPreset: true }).lean();
  return docs.map((doc) => doc.presetId as string).sort();
}

describe('savePreset default handling', () => {
  it('demotes every other default of the same user, leaving other users untouched', async () => {
    await mongoose.models.Preset.create([
      { user, presetId: 'a', title: 'a', endpoint: 'openAI', defaultPreset: true, order: 0 },
      { user, presetId: 'b', title: 'b', endpoint: 'openAI', defaultPreset: true, order: 0 },
      {
        user: otherUser,
        presetId: 'x',
        title: 'x',
        endpoint: 'openAI',
        defaultPreset: true,
        order: 0,
      },
    ]);

    await methods.savePreset(user, {
      presetId: 'c',
      title: 'c',
      endpoint: 'openAI',
      defaultPreset: true,
    });

    expect(await defaultsFor(user)).toEqual(['c']);
    expect(await defaultsFor(otherUser)).toEqual(['x']);
  });

  it('keeps the default flag when re-saving the current default', async () => {
    await methods.savePreset(user, {
      presetId: 'a',
      title: 'a',
      endpoint: 'openAI',
      defaultPreset: true,
    });
    await methods.savePreset(user, {
      presetId: 'a',
      title: 'renamed',
      endpoint: 'openAI',
      defaultPreset: true,
    });

    expect(await defaultsFor(user)).toEqual(['a']);
  });
});
