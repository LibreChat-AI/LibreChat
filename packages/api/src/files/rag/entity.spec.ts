import mongoose from 'mongoose';
import { FileContext } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { TGetFileSearchAgents, EntityFile } from './entity';
import { createEntityResolver } from './entity';

interface PlanStage {
  stage: string;
  inputStage?: PlanStage;
}

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let getAgents: jest.Mock<ReturnType<TGetFileSearchAgents>, Parameters<TGetFileSearchAgents>>;
const userId = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(['Agent', 'File'].map((name) => mongoose.models[name].deleteMany({})));
  getAgents = jest.fn((filter, select) => methods.getAgents(filter, select));
});

async function createAgent(id: string, fileIds: string[]): Promise<void> {
  await mongoose.models.Agent.create({
    id,
    name: id,
    provider: 'openAI',
    model: 'gpt-4o',
    author: userId,
    tool_resources: { file_search: { file_ids: fileIds } },
  });
}

async function createFile(
  file_id: string,
  context: FileContext,
  embeddedEntities?: string[],
): Promise<EntityFile> {
  await mongoose.models.File.create({
    user: userId,
    file_id,
    bytes: 10,
    filename: `${file_id}.pdf`,
    filepath: `/uploads/${file_id}.pdf`,
    object: 'file',
    type: 'application/pdf',
    embedded: true,
    context,
    ...(embeddedEntities ? { metadata: { embeddedEntities } } : {}),
  });
  const file = await mongoose.models.File.findOne({ file_id }).lean<EntityFile>();
  if (!file) {
    throw new Error(`File ${file_id} was not stored`);
  }
  return file;
}

describe('createEntityResolver', () => {
  it('lists the agent recorded on a file no agent lists', async () => {
    const file = await createFile('f1', FileContext.agents, ['agent_a']);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual(['agent_a']);
  });

  it('never lists the user namespace recorded beside an agent', async () => {
    const file = await createFile('f1', FileContext.agents, [userId, 'agent_a']);
    expect(userId < 'agent_a').toBe(true);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual(['agent_a']);
  });

  it('recovers the original agent of a legacy upload later provisioned for the user', async () => {
    const file = await createFile('f1', FileContext.agents, [userId]);
    await createAgent('agent_a', ['f1']);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual(['agent_a']);
  });

  it('keeps a listed original agent behind a newer recorded copy', async () => {
    const file = await createFile('f1', FileContext.agents, ['agent_b']);
    await createAgent('agent_a', ['f1']);
    await createAgent('agent_b', ['f1']);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual(['agent_b', 'agent_a']);
  });

  it('lists every agent that lists a legacy file, lowest id first', async () => {
    const file = await createFile('f1', FileContext.agents);
    await createAgent('agent_b', ['f1']);
    await createAgent('agent_a', ['f1']);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual(['agent_a', 'agent_b']);
  });

  it('lists nothing for a legacy file no agent lists', async () => {
    const file = await createFile('f1', FileContext.agents);
    await createAgent('agent_a', ['other']);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual([]);
  });

  it('lists nothing for a file outside the agents context, without a lookup', async () => {
    const file = await createFile('f1', FileContext.message_attachment);
    await createAgent('agent_a', ['f1']);
    const resolve = createEntityResolver({ getAgents });
    expect(await resolve(file)).toEqual([]);
    expect(getAgents).not.toHaveBeenCalled();
  });

  it('looks up every agent file of a turn in one query', async () => {
    const first = await createFile('f1', FileContext.agents);
    const second = await createFile('f2', FileContext.agents, ['agent_c']);
    await createAgent('agent_a', ['f1']);
    await createAgent('agent_b', ['f2']);
    const resolve = createEntityResolver({ getAgents });
    expect(await Promise.all([resolve(first), resolve(second)])).toEqual([
      ['agent_a'],
      ['agent_c', 'agent_b'],
    ]);
    expect(getAgents).toHaveBeenCalledTimes(1);
  });

  it('serves the File Search lookup from an index', async () => {
    await createAgent('agent_a', ['f1']);
    await mongoose.models.Agent.syncIndexes();
    const explained = await mongoose.models.Agent.collection
      .find(
        { 'tool_resources.file_search.file_ids': { $in: ['f1'] } },
        { projection: { id: 1, 'tool_resources.file_search.file_ids': 1 } },
      )
      .explain('queryPlanner');
    const stages: string[] = [];
    let stage: PlanStage | undefined = explained.queryPlanner.winningPlan;
    while (stage) {
      stages.push(stage.stage);
      stage = stage.inputStage;
    }
    expect(stages).toContain('IXSCAN');
  });

  it('keeps the recorded agents and reports one failed lookup once', async () => {
    const first = await createFile('f1', FileContext.agents, ['agent_a']);
    const second = await createFile('f2', FileContext.agents, ['agent_b']);
    const failure = new Error('lookup failed');
    getAgents.mockRejectedValueOnce(failure);
    const onLookupError = jest.fn();
    const resolve = createEntityResolver({ getAgents, onLookupError });
    expect(await Promise.all([resolve(first), resolve(second)])).toEqual([
      ['agent_a'],
      ['agent_b'],
    ]);
    expect(onLookupError).toHaveBeenCalledTimes(1);
    expect(onLookupError).toHaveBeenCalledWith(failure);
  });
});
