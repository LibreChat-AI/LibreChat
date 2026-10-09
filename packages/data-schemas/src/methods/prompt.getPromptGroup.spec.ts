import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PipelineStage } from 'mongoose';
import { SYSTEM_TENANT_ID, tenantStorage } from '~/config/tenantContext';
import { createModels, logger } from '..';
import { createMethods } from './index';

logger.silent = true;

type PromptModel = mongoose.Model<unknown>;
type PromptGroupModel = mongoose.Model<unknown>;
type Methods = ReturnType<typeof createMethods>;
type MongoExplainStage = Record<string, unknown>;

let mongoServer: MongoMemoryServer;
let Prompt: PromptModel;
let PromptGroup: PromptGroupModel;
let methods: Methods;

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

async function withTenant<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, async () => fn());
}

async function seedGroupAndPrompt(opts: { tenantId?: string; promptTenantId?: string } = {}) {
  const author = new mongoose.Types.ObjectId();
  const prompt = await Prompt.create({
    groupId: new mongoose.Types.ObjectId(),
    author,
    prompt: 'Hello {{name}}',
    type: 'text',
    tenantId: opts.promptTenantId ?? opts.tenantId,
  });
  const group = await PromptGroup.create({
    name: 'Repro Group',
    productionId: prompt._id,
    author,
    authorName: 'Test Author',
    tenantId: opts.tenantId,
  });
  return { group, prompt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectRecords(value: unknown, predicate: (record: Record<string, unknown>) => boolean) {
  const matches: Array<Record<string, unknown>> = [];

  function visit(candidate: unknown) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }

    if (!isRecord(candidate)) return;
    if (predicate(candidate)) {
      matches.push(candidate);
    }

    for (const child of Object.values(candidate)) {
      visit(child);
    }
  }

  visit(value);
  return matches;
}

function hasIndexedIdPlan(explain: unknown): boolean {
  return (
    collectRecords(explain, (record) => {
      const stage = record.stage;
      if (stage === 'IDHACK' || stage === 'EXPRESS_IXSCAN') return true;
      if (stage !== 'IXSCAN') return false;

      const keyPattern = record.keyPattern;
      return isRecord(keyPattern) && keyPattern._id === 1;
    }).length > 0
  );
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Prompt = mongoose.models.Prompt;
  PromptGroup = mongoose.models.PromptGroup;
  methods = createMethods(mongoose, {
    removeAllPermissions: async () => {},
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Prompt.deleteMany({});
  await PromptGroup.deleteMany({});
});

describe('getPromptGroup', () => {
  it('returns the group with productionPrompt populated when no tenant context is set', async () => {
    const { group } = await seedGroupAndPrompt();
    const result = await methods.getPromptGroup({ _id: group._id });

    expect(result).not.toBeNull();
    expect(result?.productionPrompt).toBeTruthy();
    expect((result?.productionPrompt as { prompt: string }).prompt).toBe('Hello {{name}}');
  });

  it('returns the group with productionPrompt populated when tenant matches', async () => {
    const { group } = await seedGroupAndPrompt({ tenantId: TENANT_A });

    const result = await withTenant(TENANT_A, () => methods.getPromptGroup({ _id: group._id }));

    expect(result).not.toBeNull();
    expect(result?.productionPrompt).toBeTruthy();
    expect((result?.productionPrompt as { prompt: string }).prompt).toBe('Hello {{name}}');
  });

  it('clears productionPrompt when the joined prompt belongs to a different tenant', async () => {
    const { group } = await seedGroupAndPrompt({
      tenantId: TENANT_A,
      promptTenantId: TENANT_B,
    });

    const result = await withTenant(TENANT_A, () => methods.getPromptGroup({ _id: group._id }));

    expect(result).not.toBeNull();
    expect(result?.productionPrompt).toBeNull();
  });

  it('returns the group with productionPrompt populated under SYSTEM_TENANT_ID context', async () => {
    const { group } = await seedGroupAndPrompt({
      tenantId: TENANT_A,
      promptTenantId: TENANT_B,
    });

    const result = await withTenant(SYSTEM_TENANT_ID, () =>
      methods.getPromptGroup({ _id: group._id }),
    );

    expect(result).not.toBeNull();
    expect(result?.productionPrompt).toBeTruthy();
    expect((result?.productionPrompt as { prompt: string }).prompt).toBe('Hello {{name}}');
  });

  it('returns null when the group does not exist', async () => {
    const missingId = new mongoose.Types.ObjectId();
    const result = await methods.getPromptGroup({ _id: missingId });
    expect(result).toBeNull();
  });

  it('accepts string _id values (route-handler shape)', async () => {
    const { group } = await seedGroupAndPrompt();
    const result = await methods.getPromptGroup({
      _id: (group._id as mongoose.Types.ObjectId).toString(),
    });
    expect(result).not.toBeNull();
    expect((result?.productionPrompt as { prompt: string }).prompt).toBe('Hello {{name}}');
  });

  describe('regression: DocumentDB-incompatible aggregation form', () => {
    it('does not use $lookup with let/pipeline (multi-join form unsupported by DocumentDB)', async () => {
      const { group } = await seedGroupAndPrompt({ tenantId: TENANT_A });
      const aggregateSpy = jest.spyOn(PromptGroup, 'aggregate');

      try {
        await withTenant(TENANT_A, () => methods.getPromptGroup({ _id: group._id }));

        expect(aggregateSpy).toHaveBeenCalledTimes(1);
        const pipeline: PipelineStage[] = aggregateSpy.mock.calls[0][0];

        for (const stage of pipeline) {
          if (!('$lookup' in stage)) continue;
          const lookup = stage.$lookup;
          expect(lookup.let).toBeUndefined();
          expect(lookup.pipeline).toBeUndefined();
          expect(lookup.localField).toBeDefined();
          expect(lookup.foreignField).toBeDefined();
        }
      } finally {
        aggregateSpy.mockRestore();
      }
    });

    it('uses indexed _id execution paths for the group match and production prompt lookup', async () => {
      const { group } = await seedGroupAndPrompt({ tenantId: TENANT_A });
      const aggregateSpy = jest.spyOn(PromptGroup, 'aggregate');

      try {
        await withTenant(TENANT_A, () => methods.getPromptGroup({ _id: group._id }));

        const pipeline: PipelineStage[] = aggregateSpy.mock.calls[0][0];
        const [matchStage] = pipeline;
        expect(matchStage).toEqual({ $match: { _id: group._id } });

        const lookupStage = pipeline.find((stage) => '$lookup' in stage);
        expect(lookupStage).toMatchObject({
          $lookup: {
            from: 'prompts',
            localField: 'productionId',
            foreignField: '_id',
            as: 'productionPrompt',
          },
        });

        const explain = await PromptGroup.aggregate(pipeline).explain('executionStats');
        const stages = isRecord(explain) && Array.isArray(explain.stages) ? explain.stages : [];
        const lookupExplain = stages.find(
          (stage): stage is MongoExplainStage =>
            isRecord(stage) && isRecord(stage.$lookup) && stage.$lookup.from === 'prompts',
        );

        expect(hasIndexedIdPlan(explain)).toBe(true);
        expect(lookupExplain?.indexesUsed).toContain('_id_');
        expect(lookupExplain?.totalDocsExamined).toBeLessThanOrEqual(1);
      } finally {
        aggregateSpy.mockRestore();
      }
    });
  });
});
