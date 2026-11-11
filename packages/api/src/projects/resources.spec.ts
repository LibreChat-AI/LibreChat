import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { IChatProject, IMongoFile, ProjectFileRecord } from '@librechat/data-schemas';
import {
  getChatProjectFileAvailability,
  listChatProjectFileViews,
  resolveChatProjectFiles,
  resolveChatProjectPolicyFiles,
  toCanonicalProjectResource,
  toRuntimeFile,
} from './resources';
import { getChatProjectContextKey, resolveChatProjectContext } from './context';
import { filterFilesByEndpointRuntimeConfig } from '../files/filter';

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let File: mongoose.Model<IMongoFile>;
let modelsToCleanup: string[] = [];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  Object.assign(mongoose.models, models);
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  for (const modelName of modelsToCleanup) {
    if (mongoose.models[modelName]) {
      delete mongoose.models[modelName];
    }
  }
});

afterEach(async () => {
  await File.deleteMany({});
  await mongoose.models.ChatProject.deleteMany({});
});

const file = (
  file_id: string,
  user: string,
  overrides: Partial<IMongoFile> = {},
): Partial<IMongoFile> => ({
  file_id,
  user: new mongoose.Types.ObjectId(user),
  filename: `${file_id}.txt`,
  filepath: `/tmp/${file_id}`,
  bytes: 12,
  object: 'file',
  type: 'text/plain',
  usage: 0,
  source: 'local',
  embedded: true,
  context: FileContext.message_attachment,
  text: 'must never be loaded',
  ...overrides,
});

const getProjectFiles = async ({
  fileIds,
  userId,
  tenantId,
  includeContent = false,
}: {
  fileIds: string[];
  userId: string;
  tenantId?: string | null;
  includeContent?: boolean;
}): Promise<ProjectFileRecord[]> => {
  return createMethods(mongoose).getProjectFiles({ fileIds, userId, tenantId, includeContent });
};

describe('ChatProject resource hydration', () => {
  it.each([
    { searchDestination: true, routingMimeType: 'image/heic' },
    { routingMimeType: 'image/heic' },
    { searchDestination: false },
    undefined,
  ])('keeps only routing metadata in canonical and runtime files: %p', async (metadata) => {
    const owner = new mongoose.Types.ObjectId().toString();
    await File.create(
      file('converted-project-file', owner, {
        type: 'image/jpeg',
        metadata: { ...metadata, destinationChosen: true, embeddedEntities: ['private-agent'] },
      }),
    );
    const params = {
      project: { file_ids: ['converted-project-file'] },
      userId: owner,
      getProjectFiles,
    };
    const [record] = await getProjectFiles({ fileIds: params.project.file_ids, userId: owner });
    const resource = toCanonicalProjectResource(record);
    if (resource.availability !== 'ready') {
      throw new Error('Expected a ready converted Project file');
    }
    const [runtime] = await resolveChatProjectFiles(params);
    const [policy] = await resolveChatProjectPolicyFiles(params);
    const runtimeSource = {
      ...record,
      metadata: {
        ...metadata,
        routingMimeType: metadata?.routingMimeType,
        destinationChosen: true,
        embeddedEntities: ['private-agent'],
      },
    };
    const direct = toRuntimeFile(runtimeSource);
    for (const result of [resource.file, runtime, policy, direct]) {
      expect(result.type).toBe('image/jpeg');
      expect(result.metadata).toEqual(metadata);
      if (metadata === undefined) {
        expect(result).not.toHaveProperty('metadata');
      }
    }
    expect(runtime).not.toHaveProperty('text');
    expect(policy.text).toBe('must never be loaded');
    for (const allowed of ['image/heic', 'image/jpeg']) {
      expect(
        filterFilesByEndpointRuntimeConfig(
          {
            config: {},
            fileStrategy: FileSources.local,
            imageOutputType: 'png',
            fileConfig: { endpoints: { openAI: { supportedMimeTypes: [allowed] } } },
          },
          { files: [runtime], endpoint: 'openAI' },
        ),
      ).toHaveLength((metadata?.routingMimeType ?? 'image/jpeg') === allowed ? 1 : 0);
    }
    const withoutRouting = toCanonicalProjectResource({
      ...record,
      metadata: {
        ...(metadata?.searchDestination !== undefined
          ? { searchDestination: metadata.searchDestination }
          : {}),
      },
    });
    if (metadata?.routingMimeType !== undefined) {
      expect(resource.version).not.toBe(withoutRouting.version);
    } else {
      expect(resource.version).toBe(withoutRouting.version);
    }
  });

  it.each([true, false, undefined])(
    'preserves vector presence without guessing (%s)',
    (embedded) => {
      const runtime = toRuntimeFile({
        file_id: 'retained-project-file',
        filename: 'notes.pdf',
        filepath: '/files/notes.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        usage: 0,
        user: 'owner',
        embedded,
        source: 's3',
        metadata: { searchDestination: true },
      });
      expect(runtime.embedded).toBe(embedded === true);
      expect(runtime.source).toBe('s3');
      expect(runtime.metadata?.searchDestination).toBe(true);
    },
  );

  it('rejects an unrecognized storage source instead of routing it to another store', () => {
    expect(() =>
      toRuntimeFile({
        file_id: 'retained-project-file',
        filename: 'notes.pdf',
        filepath: '/files/notes.pdf',
        object: 'file',
        type: 'application/pdf',
        bytes: 1024,
        usage: 0,
        user: 'owner',
        source: 'unrecognized-store',
      }),
    ).toThrow('Invalid project file storage source');
  });

  it('preserves Project compatibility when signed file URLs are refreshed', async () => {
    const owner = new mongoose.Types.ObjectId().toString();
    const methods = { ...createMethods(mongoose), getProjectFiles };
    const fileId = 'signed-reference';
    const originalUrl = 'https://bucket.s3.amazonaws.com/reference.txt?X-Amz-Signature=original';
    const refreshedUrl = 'https://bucket.s3.amazonaws.com/reference.txt?X-Amz-Signature=refreshed';
    await File.create(file(fileId, owner, { source: 's3', filepath: originalUrl }));
    await File.updateOne(
      { file_id: fileId },
      { $set: { updatedAt: new Date('2020-01-01') } },
      { timestamps: false },
    );
    const project = await methods.createChatProject(owner, { name: 'Signed reference' });
    const projectId = project._id!.toString();
    await methods.addChatProjectFile(owner, projectId, fileId);
    const input = { userId: owner, requestedProjectId: projectId };
    const before = await resolveChatProjectContext(input, methods);

    await methods.batchUpdateFiles([{ file_id: fileId, filepath: refreshedUrl }]);
    const after = await resolveChatProjectContext(input, methods);

    expect(after?.resources).toEqual([
      expect.objectContaining({
        availability: 'ready',
        file: expect.objectContaining({ filepath: refreshedUrl }),
      }),
    ]);
    expect(getChatProjectContextKey(after)).toBe(getChatProjectContextKey(before));
  });

  it('preserves Project compatibility when a referenced image is reused', async () => {
    const owner = new mongoose.Types.ObjectId().toString();
    const methods = { ...createMethods(mongoose), getProjectFiles };
    const fileId = 'reused-image';
    await File.create(
      file(fileId, owner, { type: 'image/png', filename: 'reference.png', source: 'local' }),
    );
    await File.updateOne(
      { file_id: fileId },
      { $set: { updatedAt: new Date('2020-01-01') } },
      { timestamps: false },
    );
    const project = await methods.createChatProject(owner, { name: 'Reused image' });
    const projectId = project._id!.toString();
    await methods.addChatProjectFile(owner, projectId, fileId);
    const input = { userId: owner, requestedProjectId: projectId };
    const before = await resolveChatProjectContext(input, methods);

    /* `prepareImageURL` promotes the upload with nothing but the id on every reuse. */
    await methods.updateFile({ file_id: fileId });
    const after = await resolveChatProjectContext(input, methods);

    expect(after?.resources).toEqual([expect.objectContaining({ availability: 'ready' })]);
    expect(getChatProjectContextKey(after)).toBe(getChatProjectContextKey(before));
  });

  it('keeps cleared search destinations visible and honestly repairable', async () => {
    const owner = new mongoose.Types.ObjectId().toString();
    const methods = createMethods(mongoose);
    const stored = await File.create(
      file('repair', owner, {
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: new Date('2026-10-20'),
        source: 's3',
        storageKey: 'owner/repair',
        storageRegion: 'region',
        metadata: { destinationChosen: true },
      }),
    );
    const options = { fileIds: ['repair'], userId: owner };
    const [before] = await methods.getProjectFiles(options);
    const originalVersion = toCanonicalProjectResource(before).version;
    expect(
      await methods.clearFileEmbeddings({
        file_id: 'repair',
        ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
        userId: owner,
        updatedAt: stored.updatedAt,
      }),
    ).toBe(true);
    const [after] = await methods.getProjectFiles(options);
    const resource = toCanonicalProjectResource(after);
    expect(resource.availability).toBe('ready');
    expect(resource.version).not.toBe(originalVersion);
    const runtime = await resolveChatProjectFiles({
      project: { file_ids: ['repair'] },
      userId: owner,
      getProjectFiles: methods.getProjectFiles,
    });
    expect(runtime).toEqual([
      expect.objectContaining({
        embedded: false,
        metadata: { searchDestination: true },
        source: 's3',
        storageKey: 'owner/repair',
        storageRegion: 'region',
      }),
    ]);
    expect(
      await listChatProjectFileViews({
        project: { file_ids: ['repair'] },
        userId: owner,
        getProjectFiles: methods.getProjectFiles,
      }),
    ).toEqual([expect.objectContaining({ file_id: 'repair', availability: 'ready' })]);
    const withoutIntent = toCanonicalProjectResource({ ...after, metadata: undefined });
    expect(withoutIntent.availability).toBe('unavailable');
    expect(withoutIntent.version).not.toBe(resource.version);
  });

  it('only marks canonical unscoped message attachments ready', () => {
    expect(
      getChatProjectFileAvailability(
        file('ready', new mongoose.Types.ObjectId().toString()) as IMongoFile,
      ),
    ).toBe('ready');
    expect(
      getChatProjectFileAvailability(
        file('agent', new mongoose.Types.ObjectId().toString(), {
          context: FileContext.agents,
        }) as IMongoFile,
      ),
    ).toBe('unavailable');
    expect(
      getChatProjectFileAvailability(
        file('not-indexed', new mongoose.Types.ObjectId().toString(), {
          embedded: false,
        }) as IMongoFile,
      ),
    ).toBe('unavailable');
    expect(
      getChatProjectFileAvailability(
        file('expired', new mongoose.Types.ObjectId().toString(), {
          expiredAt: new Date(Date.now() - 1),
        }) as IMongoFile,
      ),
    ).toBe('unavailable');
  });

  it('hydrates ready runtime files and safe unavailable views from canonical Mongo records', async () => {
    const owner = new mongoose.Types.ObjectId().toString();
    const tenantId = 'tenant-a';
    await File.create(file('ready', owner, { tenantId }));
    await File.create(file('expired', owner, { tenantId, expiredAt: new Date(Date.now() - 1) }));
    await File.create(file('agent-scoped', owner, { tenantId, context: FileContext.agents }));
    await File.create(file('foreign', new mongoose.Types.ObjectId().toString(), { tenantId }));

    const project = {
      file_ids: ['ready', 'expired', 'agent-scoped', 'foreign', 'missing'],
      tenantId,
    } as Pick<IChatProject, 'file_ids' | 'tenantId'>;

    const runtimeFiles = await resolveChatProjectFiles({
      project,
      userId: owner,
      tenantId,
      getProjectFiles,
    });
    expect(runtimeFiles.map((runtimeFile) => runtimeFile.file_id)).toEqual(['ready']);
    expect(runtimeFiles[0]).not.toHaveProperty('text');

    const views = await listChatProjectFileViews({
      project,
      userId: owner,
      tenantId,
      getProjectFiles,
    });
    expect(views).toEqual([
      {
        file_id: 'ready',
        filename: 'ready.txt',
        type: 'text/plain',
        bytes: 12,
        availability: 'ready',
      },
      {
        file_id: 'expired',
        filename: 'expired.txt',
        type: 'text/plain',
        bytes: 12,
        availability: 'unavailable',
      },
      {
        file_id: 'agent-scoped',
        availability: 'unavailable',
      },
      { file_id: 'foreign', availability: 'unavailable' },
      { file_id: 'missing', availability: 'unavailable' },
    ]);
  });
});
