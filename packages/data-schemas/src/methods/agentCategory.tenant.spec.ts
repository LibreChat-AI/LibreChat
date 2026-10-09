import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IAgentCategory } from '..';
import { createAgentCategoryMethods } from './agentCategory';
import { createModels } from '../models';
import { tenantStorage } from '../config/tenantContext';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TENANT_A = 'tenant-aaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'tenant-bbbbbbbbbbbbbbbbbbbb';

let mongoServer: MongoMemoryServer;
let AgentCategory: mongoose.Model<IAgentCategory>;
let methods: ReturnType<typeof createAgentCategoryMethods>;

function runAs<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}

async function seedCategory(tenantId: string, value: string): Promise<void> {
  await runAs(tenantId, async () => {
    await new AgentCategory({ value, label: value, isActive: true }).save();
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  AgentCategory = mongoose.models.AgentCategory as mongoose.Model<IAgentCategory>;
  methods = createAgentCategoryMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AgentCategory.deleteMany({});
});

describe('getValidCategoryValues is scoped to the active tenant', () => {
  it('returns only the current tenant category values', async () => {
    await seedCategory(TENANT_A, 'alpha');
    await seedCategory(TENANT_B, 'beta');

    const aValues = await runAs(TENANT_A, () => methods.getValidCategoryValues());
    expect(aValues).toEqual(['alpha']);

    const bValues = await runAs(TENANT_B, () => methods.getValidCategoryValues());
    expect(bValues).toEqual(['beta']);
  });
});
