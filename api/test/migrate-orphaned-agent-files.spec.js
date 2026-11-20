/**
 * Integration test for the orphan-cleanup migration script used to heal
 * agents corrupted before the delete-time and save-time fixes for issue
 * #12776 shipped. Exercises the full module end-to-end:
 *   - dry-run reports orphans without writing
 *   - apply mode removes them
 *   - re-running on a cleaned database is a no-op (idempotent)
 *   - the DETAIL_SAMPLE_LIMIT truncation kicks in on wide corruption
 */

// Replace the migration's `./connect` helper — it opens its own connection
// via the mongo URI env var, but the test already owns the mongoose instance.
jest.mock('../../config/connect', () => jest.fn(async () => undefined));

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  };
});

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { agentSchema, fileSchema } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');

const { migrateOrphanedAgentFiles } = require('../../config/migrate-orphaned-agent-files');

describe('migrate-orphaned-agent-files (issue #12776)', () => {
  let mongoServer;
  let Agent;
  let File;
  const userId = () => new mongoose.Types.ObjectId();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
    File = mongoose.models.File || mongoose.model('File', fileSchema);
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    await File.deleteMany({});
  });

  const seedFile = (file_id) =>
    File.create({
      file_id,
      user: userId(),
      filename: `${file_id}.txt`,
      filepath: `/tmp/${file_id}`,
      object: 'file',
      type: 'text/plain',
      bytes: 1,
      source: FileSources.text,
    });

  const seedAgent = (tool_resources) =>
    Agent.create({
      id: `agent_${Math.random().toString(36).slice(2, 10)}`,
      name: `Test Agent ${Math.random().toString(36).slice(2, 6)}`,
      provider: 'test',
      model: 'test-model',
      author: userId(),
      tool_resources,
    });

  test('dry-run reports orphans without mutating any agent', async () => {
    const keeperId = 'keeper';
    await seedFile(keeperId);
    const agent = await seedAgent({
      file_search: { file_ids: [keeperId, 'orphan_1', 'orphan_2'] },
    });

    const result = await migrateOrphanedAgentFiles({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.scannedAgents).toBe(1);
    expect(result.agentsWithOrphans).toBe(1);
    expect(result.totalOrphansRemoved).toBe(2);
    // Dry-run reports what would change without writing — no updates counted.
    expect(result.agentsUpdated).toBe(0);

    const after = await Agent.findOne({ id: agent.id }).lean();
    expect(after.tool_resources.file_search.file_ids).toEqual([keeperId, 'orphan_1', 'orphan_2']);
  });

  test('apply mode removes orphans across every tool_resource category', async () => {
    const keeperA = 'k_a';
    const keeperB = 'k_b';
    await seedFile(keeperA);
    await seedFile(keeperB);

    const agent = await seedAgent({
      file_search: { file_ids: [keeperA, 'o1'] },
      execute_code: { file_ids: ['o2', keeperB] },
      context: { file_ids: ['o3'] },
    });

    const result = await migrateOrphanedAgentFiles({ dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.agentsWithOrphans).toBe(1);
    expect(result.agentsUpdated).toBe(1);
    expect(result.totalOrphansRemoved).toBe(3);

    const after = await Agent.findOne({ id: agent.id }).lean();
    expect(after.tool_resources.file_search.file_ids).toEqual([keeperA]);
    expect(after.tool_resources.execute_code.file_ids).toEqual([keeperB]);
    expect(after.tool_resources.context.file_ids).toEqual([]);
  });

  test('is idempotent — re-running on a clean database is a no-op', async () => {
    await seedFile('keeper');
    await seedAgent({ file_search: { file_ids: ['keeper', 'orphan'] } });

    await migrateOrphanedAgentFiles({ dryRun: false });
    const second = await migrateOrphanedAgentFiles({ dryRun: false });

    expect(second.agentsWithOrphans).toBe(0);
    expect(second.agentsUpdated).toBe(0);
    expect(second.totalOrphansRemoved).toBe(0);
  });

  test('leaves agents without orphans completely alone', async () => {
    await seedFile('only');
    const agent = await seedAgent({ file_search: { file_ids: ['only'] } });

    const result = await migrateOrphanedAgentFiles({ dryRun: false });

    expect(result.scannedAgents).toBe(1);
    expect(result.agentsWithOrphans).toBe(0);
    const after = await Agent.findOne({ id: agent.id }).lean();
    expect(after.tool_resources.file_search.file_ids).toEqual(['only']);
  });

  test('sample array is bounded on wide corruption (DETAIL_SAMPLE_LIMIT)', async () => {
    // Seed more than the cap (50) so the truncation branch is exercised.
    const agents = [];
    for (let i = 0; i < 55; i++) {
      agents.push(
        await seedAgent({
          file_search: { file_ids: [`orphan_${i}`] },
        }),
      );
    }

    const result = await migrateOrphanedAgentFiles({ dryRun: true });

    expect(result.agentsWithOrphans).toBe(55);
    expect(result.details.length).toBeLessThanOrEqual(50);
    expect(result.details.length).toBeGreaterThan(0);
  });

  test('runs the body inside a system tenant context (strict-mode safe)', async () => {
    // Pins the runAsSystem wrap: without it the migration throws under
    // TENANT_ISOLATION_STRICT=true on the very first Agent.countDocuments(),
    // blocking the intended remediation path for corrupted agents.
    const { SYSTEM_TENANT_ID, tenantStorage } = require('@librechat/data-schemas');
    await seedFile('keeper');
    await seedAgent({ file_search: { file_ids: ['keeper', 'orphan'] } });

    const contextsObserved = [];
    const originalCountDocuments = Agent.countDocuments.bind(Agent);
    Agent.countDocuments = jest.fn((...args) => {
      contextsObserved.push(tenantStorage.getStore()?.tenantId);
      return originalCountDocuments(...args);
    });

    try {
      await migrateOrphanedAgentFiles({ dryRun: false });
      expect(contextsObserved).toContain(SYSTEM_TENANT_ID);
    } finally {
      Agent.countDocuments = originalCountDocuments;
    }
  });
});
