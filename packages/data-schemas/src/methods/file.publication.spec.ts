import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources, isUUID } from 'librechat-data-provider';
import type { RunFileProvenance } from 'librechat-data-provider';
import type { RunArtifactContent, RunArtifactScope } from '~/types/file';
import { createFileMethods } from './file';
import fileSchema from '~/schema/file';

describe('Run artifact persistence', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createFileMethods>;
  const userId = new mongoose.Types.ObjectId().toString();
  const scope: RunArtifactScope = {
    userId,
    tenantId: 'tenant-a',
    conversationId: 'conversation-a',
    runId: 'run-a',
    executionId: 'child-a',
    agentId: 'agent-a',
    sourceFileId: 'sandbox-file-a',
  };

  const provenance = (identity: RunArtifactScope = scope): RunFileProvenance => ({
    runId: identity.runId,
    executionId: identity.executionId,
    agentId: identity.agentId,
    sourceFileId: identity.sourceFileId,
    parentExecutionId: 'parent-a',
    parentAgentId: 'parent-agent',
    recipientAgentIds: ['sibling-agent'],
    publishedAt: '2026-09-11T16:00:00.000Z',
    inputFileIds: ['input-pdf'],
  });

  const content = (filepath = '/uploads/attempt-a/report.csv'): RunArtifactContent => ({
    filename: 'report.csv',
    filepath,
    storageKey: filepath,
    bytes: 12,
    type: 'text/csv',
    source: FileSources.local,
    messageId: 'parent-response',
    text: 'a,b\n1,2',
    textFormat: 'text',
    metadata: {
      codeEnvRef: {
        kind: 'user',
        id: userId,
        file_id: scope.sourceFileId,
        storage_session_id: 'child-session',
      },
    },
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    mongoose.model('File', fileSchema);
    await mongoose.models.File.init();
    methods = createFileMethods(mongoose);
  });

  beforeEach(async () => {
    await mongoose.models.File.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel('File');
    await mongo.stop();
  });

  it('claims a stable UUID without exposing an incomplete file record', async () => {
    const [first, second] = await Promise.all([
      methods.claimRunArtifactFile(scope),
      methods.claimRunArtifactFile(scope),
    ]);
    expect(isUUID.parse(first.file_id)).toBe(first.file_id);
    expect(second).toEqual(first);
    expect(first.file).toBeUndefined();
    expect(await methods.listRunArtifacts(scope)).toEqual([]);
    expect(await mongoose.models.File.countDocuments()).toBe(0);
  });

  it('commits full provenance and storage together and returns plain owner identities', async () => {
    const claimed = await methods.claimRunArtifactFile(scope);
    const file = await methods.publishRunArtifactFile({
      scope,
      file: content(),
      provenance: provenance(),
    });
    expect(file).toMatchObject({
      file_id: claimed.file_id,
      user: userId,
      tenantId: scope.tenantId,
      conversationId: scope.conversationId,
      context: FileContext.run_artifact,
      filename: 'report.csv',
      filepath: content().filepath,
      metadata: { runFile: provenance(), destinationChosen: false },
    });
    expect(typeof file._id).toBe('string');
    expect(file.expiresAt).toBeUndefined();
    expect(file.metadata.codeEnvRef).toBeUndefined();
    expect(file.metadata.codeEnvRefs).toBeUndefined();
    expect(file.metadata.embeddedEntities).toBeUndefined();
    expect(await methods.claimRunArtifactFile(scope)).toEqual({ file_id: file.file_id, file });
    expect(await methods.listRunArtifacts(scope)).toEqual([file]);
    expect(await methods.getRunFileCandidates([file.file_id], scope.tenantId)).toEqual([file]);
    expect((await methods.getRunFileCandidates([file.file_id], scope.tenantId))[0].text).toBe(
      'a,b\n1,2',
    );
  });

  it('preserves the first committed bytes and grants across concurrent publication retries', async () => {
    const published = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        methods.publishRunArtifactFile({
          scope,
          file: content(`/uploads/attempt-${index}/report.csv`),
          provenance: {
            ...provenance(),
            recipientAgentIds: [`recipient-${index}`],
          },
        }),
      ),
    );
    expect(new Set(published.map((file) => file.file_id)).size).toBe(1);
    expect(new Set(published.map((file) => file.filepath)).size).toBe(1);
    expect(
      new Set(published.map((file) => file.metadata.runFile.recipientAgentIds?.[0])).size,
    ).toBe(1);
    expect(await mongoose.models.File.countDocuments()).toBe(1);
    const retry = await methods.publishRunArtifactFile({
      scope,
      file: content('/uploads/later-attempt/other.csv'),
      provenance: {
        ...provenance(),
        recipientAgentIds: ['new-recipient'],
        parentAgentId: 'different-parent',
      },
    });
    expect(retry).toEqual(published[0]);
  });

  it('loads setup candidates only from the authenticated tenant while preserving shared ownership', async () => {
    const otherOwner = new mongoose.Types.ObjectId().toString();
    const candidates = [
      { file_id: 'owned', tenantId: 'tenant-a', user: userId },
      { file_id: 'shared', tenantId: 'tenant-a', user: otherOwner },
      { file_id: 'foreign-tenant', tenantId: 'tenant-b', user: userId },
      { file_id: 'legacy-missing', user: userId },
      { file_id: 'legacy-null', tenantId: null, user: userId },
    ];
    await mongoose.models.File.create(
      candidates.map((candidate) => ({
        ...content(),
        context: FileContext.agents,
        ...candidate,
      })),
    );
    const ids = candidates.map((candidate) => candidate.file_id);
    expect(
      (await methods.getRunFileCandidates(ids, 'tenant-a')).map((file) => file.file_id).sort(),
    ).toEqual(['owned', 'shared']);
    expect((await methods.getRunFileCandidates(ids)).map((file) => file.file_id).sort()).toEqual([
      'legacy-missing',
      'legacy-null',
    ]);
    expect(
      (await methods.getRunFileCandidates(ids, null)).map((file) => file.file_id).sort(),
    ).toEqual(['legacy-missing', 'legacy-null']);
  });

  it('keeps same-named child outputs separate from each other and ordinary code files', async () => {
    await methods.claimCodeFile({
      filename: 'report.csv',
      conversationId: scope.conversationId,
      file_id: 'ordinary-code-file',
      user: userId,
      tenantId: scope.tenantId,
    });
    const childScopes = [scope, { ...scope, executionId: 'child-b' }];
    const files = await Promise.all(
      childScopes.map((identity) =>
        methods.publishRunArtifactFile({
          scope: identity,
          file: content(),
          provenance: provenance(identity),
        }),
      ),
    );
    expect(files[0].file_id).not.toBe(files[1].file_id);
    expect(files.map((file) => file.filename)).toEqual(['report.csv', 'report.csv']);
    expect(await mongoose.models.File.countDocuments()).toBe(3);
    expect(await methods.listRunArtifacts(scope)).toHaveLength(2);
  });

  it.each([
    { userId: new mongoose.Types.ObjectId().toString() },
    { tenantId: 'tenant-b' },
    { tenantId: undefined },
    { conversationId: 'conversation-b' },
    { runId: 'run-b' },
  ])('cannot load a publication through a different owner scope: %o', async (difference) => {
    await methods.publishRunArtifactFile({ scope, file: content(), provenance: provenance() });
    const foreign = { ...scope, ...difference };
    expect(await methods.findRunArtifactFile(foreign)).toBeNull();
    expect(await methods.listRunArtifacts(foreign)).toEqual([]);
    expect((await methods.claimRunArtifactFile(foreign)).file_id).not.toBe(
      (await methods.claimRunArtifactFile(scope)).file_id,
    );
  });

  it('isolates graph members with the same execution and source file id', async () => {
    const peer = { ...scope, agentId: 'other-graph-member' };
    const [first, second] = await Promise.all(
      [scope, peer].map((identity) =>
        methods.publishRunArtifactFile({
          scope: identity,
          file: content(`/uploads/${identity.agentId}/report.csv`),
          provenance: provenance(identity),
        }),
      ),
    );
    expect(first.file_id).not.toBe(second.file_id);
    expect(await methods.findRunArtifactFile(scope)).toEqual(first);
    expect(await methods.findRunArtifactFile(peer)).toEqual(second);
    expect(await methods.listRunArtifacts(scope)).toHaveLength(2);
  });

  it('does not load another producing agent or accept mismatched provenance', async () => {
    await methods.publishRunArtifactFile({ scope, file: content(), provenance: provenance() });
    expect(await methods.findRunArtifactFile({ ...scope, agentId: 'other-agent' })).toBeNull();
    await expect(
      methods.publishRunArtifactFile({
        scope,
        file: content(),
        provenance: { ...provenance(), runId: 'other-run' },
      }),
    ).rejects.toThrow('provenance');
  });

  it('rejects transient download fallbacks and retains storage cleanup deadlines', async () => {
    await expect(
      methods.publishRunArtifactFile({
        scope,
        file: { ...content(), source: FileSources.execute_code },
        provenance: provenance(),
      }),
    ).rejects.toThrow('durable stored file');
    expect(await methods.listRunArtifacts(scope)).toEqual([]);
    const expiredAt = new Date('2026-12-01T00:00:00.000Z');
    const file = await methods.publishRunArtifactFile({
      scope,
      file: { ...content(), expiredAt },
      provenance: provenance(),
    });
    expect(file.expiredAt).toEqual(expiredAt);
    expect(
      (await methods.getExpiredFiles(10, { now: new Date('2026-12-02T00:00:00.000Z') })).map(
        (expired) => expired.file_id,
      ),
    ).toEqual([file.file_id]);
  });
});
