import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType, ResourceType } from 'librechat-data-provider';
import type {
  IAclEntry,
  IArtifactApp,
  IArtifactVersion,
  IArtifactSourceTombstone,
  CreateArtifactAppInput,
} from '~/types';
import {
  ArtifactAppDeletedError,
  ArtifactAppRestoreNotFoundError,
  ArtifactSyncConflictError,
  createArtifactAppMethods,
  computeSourceHash,
  type ArtifactAppMethods,
} from './artifactApp';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let ArtifactApp: mongoose.Model<IArtifactApp>;
let ArtifactVersion: mongoose.Model<IArtifactVersion>;
let ArtifactSourceTombstone: mongoose.Model<IArtifactSourceTombstone>;
let AclEntry: mongoose.Model<IAclEntry>;
let modelsToCleanup: string[] = [];
let methods: ArtifactAppMethods;

function baseInput(overrides: Partial<CreateArtifactAppInput> = {}): CreateArtifactAppInput {
  return {
    createdBy: 'user-1',
    title: 'My Chart',
    visibility: 'private',
    version: {
      artifactType: 'react',
      sourceSnapshot: 'export default () => <div>hi</div>;',
      createdBy: 'user-1',
    },
    ...overrides,
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const models = createModels(mongoose);
  modelsToCleanup = Object.keys(models);
  ArtifactApp = mongoose.models.ArtifactApp as mongoose.Model<IArtifactApp>;
  ArtifactVersion = mongoose.models.ArtifactVersion as mongoose.Model<IArtifactVersion>;
  ArtifactSourceTombstone = mongoose.models
    .ArtifactSourceTombstone as mongoose.Model<IArtifactSourceTombstone>;
  AclEntry = mongoose.models.AclEntry as mongoose.Model<IAclEntry>;
  methods = createArtifactAppMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    ArtifactApp.syncIndexes(),
    ArtifactVersion.syncIndexes(),
    ArtifactSourceTombstone.syncIndexes(),
  ]);
}, 30000);

afterAll(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
  for (const modelName of modelsToCleanup) {
    if (mongoose.models[modelName]) {
      delete (mongoose.models as Record<string, unknown>)[modelName];
    }
  }
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await ArtifactApp.deleteMany({});
  await ArtifactVersion.deleteMany({});
  await ArtifactSourceTombstone.deleteMany({});
  await AclEntry.deleteMany({});
});

describe('createArtifactAppWithVersion', () => {
  test('atomically creates app and version 1 with activeVersionId set', async () => {
    const { app, version } = await methods.createArtifactAppWithVersion(baseInput());

    expect(app.artifactAppId).toMatch(/^app_/);
    expect(app.status).toBe('draft');
    expect(app.latestVersionNumber).toBe(1);
    expect(version.versionNumber).toBe(1);
    expect(version.artifactVersionId).toMatch(/^ver_/);
    expect(app.activeVersionId).toBe(version.artifactVersionId);

    const persistedVersions = await ArtifactVersion.find({ artifactAppId: app.artifactAppId });
    expect(persistedVersions).toHaveLength(1);
  });

  test('computes a deterministic SHA-256 integrity hash over the snapshot', async () => {
    const input = baseInput();
    const { version } = await methods.createArtifactAppWithVersion(input);
    const expected = computeSourceHash(
      input.version.artifactType,
      input.version.sourceSnapshot,
      input.version.runtimeConfig ?? {},
    );
    expect(version.integrity.sourceHash).toBe(expected);
    expect(version.integrity.schemaVersion).toBe(1);
  });

  test('stores the active thumbnail preview with the app and version', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Preview of My Chart',
    };
    const { app, version } = await methods.createArtifactAppWithVersion(
      baseInput({ version: { ...baseInput().version, preview } }),
    );

    expect(app.preview).toEqual(preview);
    expect(version.preview).toEqual(preview);
  });

  test('rejects remote preview URLs at the app and version persistence boundaries', async () => {
    const unsafePreview = {
      type: 'image' as const,
      imageUrl: 'https://attacker.example/pixel.png',
      alt: 'Unsafe preview',
    };

    await expect(
      methods.createArtifactAppWithVersion(
        baseInput({ version: { ...baseInput().version, preview: unsafePreview } }),
      ),
    ).rejects.toThrow('Artifact preview must be a base64 PNG, JPEG, or WebP image');
    expect(await ArtifactApp.countDocuments()).toBe(0);
    expect(await ArtifactVersion.countDocuments()).toBe(0);

    const created = await methods.createArtifactAppWithVersion(baseInput());
    const version = await ArtifactVersion.findOne({
      artifactVersionId: created.version.artifactVersionId,
    }).orFail();
    version.preview = unsafePreview;
    await expect(version.save()).rejects.toThrow(
      'Artifact preview must be a base64 PNG, JPEG, or WebP image',
    );
    expect(
      await ArtifactVersion.findOne({ artifactVersionId: created.version.artifactVersionId })
        .lean()
        .orFail(),
    ).not.toHaveProperty('preview');
  });

  test('snapshot is independent — later app edits do not mutate the version source', async () => {
    const { app, version } = await methods.createArtifactAppWithVersion(baseInput());
    const originalSource = version.sourceSnapshot;

    await methods.updateArtifactApp(
      { artifactAppId: app.artifactAppId },
      { title: 'Renamed', description: 'new' },
    );

    const reread = await methods.getArtifactVersion({
      artifactAppId: app.artifactAppId,
      versionNumber: 1,
    });
    expect(reread?.sourceSnapshot).toBe(originalSource);
  });
});

describe('artifact version model immutability', () => {
  const protectedEdits = [
    { path: 'sourceSnapshot', value: '<div>changed</div>' },
    { path: 'artifactType', value: 'html' },
    { path: 'runtimeConfig', value: { entryPoint: 'other' } },
    { path: 'runtimeConfig.entryPoint', value: 'other' },
    { path: 'integrity', value: { sourceHash: 'changed', schemaVersion: 2 } },
    { path: 'integrity.sourceHash', value: 'changed' },
    { path: 'versionNumber', value: 20 },
    { path: 'artifactAppId', value: 'other-app' },
    { path: 'artifactVersionId', value: 'other-version' },
  ];

  describe.each(['released', 'withdrawn'] as const)('%s snapshots', (state) => {
    test.each(protectedEdits)(
      'blocks query and document writes to $path',
      async ({ path, value }) => {
        const { app, version } = await methods.createArtifactAppWithVersion(baseInput());
        const query = { artifactAppId: app.artifactAppId };
        await methods.releaseArtifactVersion(query, 'user-1');
        if (state === 'withdrawn') {
          await methods.withdrawArtifactVersion(query);
        }
        const filter = { artifactVersionId: version.artifactVersionId };
        const original = await ArtifactVersion.findOne(filter).lean();
        const result = await ArtifactVersion.updateOne(filter, { $set: { [path]: value } });
        expect(result.matchedCount).toBe(0);
        const document = await ArtifactVersion.findOne(filter).orFail();
        document.set(path, value);
        await expect(document.save()).rejects.toThrow();
        expect(await ArtifactVersion.findOne(filter).lean()).toEqual(original);
      },
    );
  });

  test('keeps drafts editable and permits release, activation and withdrawal after a draft save', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const query = { artifactAppId: app.artifactAppId };
    const document = await ArtifactVersion.findOne(query).orFail();
    document.sourceSnapshot = 'draft edit';
    await document.save();
    document.publication = { state: 'released', releasedAt: new Date(), releasedBy: 'user-1' };
    await document.save();
    expect(await methods.activateArtifactVersion(query)).not.toBeNull();
    document.publication.state = 'withdrawn';
    await document.save();
    expect(await ArtifactVersion.findOne(query).lean()).toMatchObject({
      sourceSnapshot: 'draft edit',
      publication: { state: 'withdrawn' },
    });
  });

  test('blocks a stale draft document save after another writer releases it', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const query = { artifactAppId: app.artifactAppId };
    const draft = await ArtifactVersion.findOne(query).orFail();
    await methods.releaseArtifactVersion(query, 'user-1');
    draft.sourceSnapshot = 'stale draft';
    await expect(draft.save()).rejects.toThrow();
    expect(await ArtifactVersion.findOne(query).lean()).toMatchObject({
      sourceSnapshot: baseInput().version.sourceSnapshot,
      publication: { state: 'released' },
    });
  });

  test('does not unlock released content by resetting or removing publication state', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const query = { artifactAppId: app.artifactAppId };
    await methods.releaseArtifactVersion(query, 'user-1');
    expect(
      await ArtifactVersion.findOneAndUpdate(
        query,
        {
          $set: { publication: { state: 'draft' } },
        },
        { new: true },
      ),
    ).toBeNull();
    expect(
      (await ArtifactVersion.updateOne(query, { $unset: { publication: 1 } })).matchedCount,
    ).toBe(0);
    const document = await ArtifactVersion.findOne(query).orFail();
    document.publication = { state: 'draft' };
    await expect(document.save()).rejects.toThrow();
  });

  test('guards updateMany and rename paths without blocking editable drafts', async () => {
    const released = await methods.createArtifactAppWithVersion(baseInput());
    const draft = await methods.createArtifactAppWithVersion(baseInput());
    await methods.releaseArtifactVersion({ artifactAppId: released.app.artifactAppId }, 'user-1');
    expect(
      (await ArtifactVersion.updateMany({}, { $set: { sourceSnapshot: 'new draft' } }))
        .matchedCount,
    ).toBe(1);
    expect(
      (
        await ArtifactVersion.updateOne(
          { artifactAppId: released.app.artifactAppId },
          {
            $rename: { sourceSnapshot: 'changelog' },
          },
        )
      ).matchedCount,
    ).toBe(0);
    expect(
      (
        await ArtifactVersion.updateOne(
          { artifactAppId: released.app.artifactAppId },
          {
            $rename: { changelog: 'sourceSnapshot' },
          },
        )
      ).matchedCount,
    ).toBe(0);
    expect(
      await ArtifactVersion.findOne({ artifactAppId: draft.app.artifactAppId }).lean(),
    ).toMatchObject({ sourceSnapshot: 'new draft' });
  });

  test('rejects replacement, pipeline and bulk mutation bypasses', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const query = { artifactAppId: app.artifactAppId };
    await methods.releaseArtifactVersion(query, 'user-1');
    const original = await ArtifactVersion.findOne(query).lean();
    const replacement = { ...original, sourceSnapshot: 'changed' };
    await expect(ArtifactVersion.replaceOne(query, replacement)).rejects.toThrow(
      'cannot be replaced',
    );
    await expect(ArtifactVersion.findOneAndReplace(query, replacement)).rejects.toThrow(
      'cannot be replaced',
    );
    await expect(
      ArtifactVersion.updateOne(query, [{ $set: { sourceSnapshot: 'changed' } }]),
    ).rejects.toThrow('pipeline');
    await expect(
      ArtifactVersion.bulkWrite([
        { updateOne: { filter: query, update: { $set: { sourceSnapshot: 'changed' } } } },
      ]),
    ).rejects.toThrow('guarded');
    expect(await ArtifactVersion.findOne(query).lean()).toEqual(original);
  });
});

describe('syncArtifactAppWithVersion', () => {
  const sourceMetadata = {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    originalArtifactId: 'render-id-1',
    sourceKey: 'artifact:v1:identifier:revenue-chart',
  };

  test('imports released legacy history without changing the original snapshot or identity', async () => {
    const legacy = await methods.createArtifactAppWithVersion(
      baseInput({
        sourceMetadata: { ...sourceMetadata, sourceKey: 'identifier:revenue-chart:text/html' },
      }),
    );
    await methods.releaseArtifactVersion({ artifactAppId: legacy.app.artifactAppId }, 'user-1');
    const original = await ArtifactVersion.findOne({
      artifactAppId: legacy.app.artifactAppId,
    }).lean();
    const survivor = await methods.createArtifactAppWithVersion(baseInput({ sourceMetadata }));

    await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));
    await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));

    expect(
      await ArtifactVersion.findOne({ artifactAppId: legacy.app.artifactAppId }).lean(),
    ).toEqual(original);
    const history = await ArtifactVersion.find({ artifactAppId: survivor.app.artifactAppId })
      .sort({ versionNumber: 1 })
      .lean();
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      versionNumber: 2,
      sourceSnapshot: original?.sourceSnapshot,
      integrity: original?.integrity,
      publication: original?.publication,
    });
    expect(history[1].artifactVersionId).not.toBe(original?.artifactVersionId);
  });

  test('is idempotent when the source snapshot has not changed', async () => {
    const originalPreview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Original preview',
    };
    const replacementPreview = {
      type: 'image' as const,
      imageUrl: 'data:image/webp;base64,UklGRgQAAABXRUJQ',
      alt: 'Replacement preview',
    };
    const input = baseInput({
      sourceMetadata,
      version: { ...baseInput().version, preview: originalPreview },
    });
    const first = await methods.syncArtifactAppWithVersion(input);
    const second = await methods.syncArtifactAppWithVersion({
      ...input,
      sourceMetadata: {
        ...sourceMetadata,
        messageId: 'message-2',
        originalArtifactId: 'render-id-2',
      },
      version: { ...input.version, preview: replacementPreview },
    });
    const persistedApp = await ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId })
      .lean()
      .orFail();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.versionCreated).toBe(false);
    expect(second.app.artifactAppId).toBe(first.app.artifactAppId);
    expect(second.app.preview).toEqual(originalPreview);
    expect(second.version.preview).toEqual(originalPreview);
    expect(persistedApp.preview).toEqual(originalPreview);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      1,
    );
  });

  test('backfills a missing preview without creating a new version', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Captured preview',
    };
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    const second = await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, preview },
    });
    const [persistedApp, persistedVersion] = await Promise.all([
      ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId }).lean().orFail(),
      ArtifactVersion.findOne({ artifactAppId: first.app.artifactAppId }).lean().orFail(),
    ]);

    expect(second.versionCreated).toBe(false);
    expect(second.app.preview).toEqual(preview);
    expect(second.version.preview).toEqual(preview);
    expect(persistedApp.preview).toEqual(preview);
    expect(persistedVersion.preview).toEqual(preview);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      1,
    );
  });

  test('does not backfill a missing preview onto a released version', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    };
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    await methods.releaseArtifactVersion(
      {
        artifactAppId: first.app.artifactAppId,
        artifactVersionId: first.version.artifactVersionId,
      },
      'user-1',
    );

    const second = await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, preview },
    });
    const persistedVersion = await ArtifactVersion.findOne({
      artifactVersionId: first.version.artifactVersionId,
    })
      .lean()
      .orFail();

    expect(second.app.preview).toBeUndefined();
    expect(second.version.preview).toBeUndefined();
    expect(persistedVersion.preview).toBeUndefined();
    expect(persistedVersion.publication.state).toBe('released');
  });

  test('adopts typed identifier source keys created by the previous implementation', async () => {
    const legacy = await methods.createArtifactAppWithVersion(
      baseInput({
        sourceMetadata: {
          ...sourceMetadata,
          sourceKey: 'identifier:revenue-chart:application/vnd.react',
        },
      }),
    );

    const synced = await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));
    const persisted = await ArtifactApp.findOne({ artifactAppId: legacy.app.artifactAppId }).lean();

    expect(synced.app.artifactAppId).toBe(legacy.app.artifactAppId);
    expect(synced.created).toBe(false);
    expect(await ArtifactApp.countDocuments({})).toBe(1);
    expect(persisted?.sourceMetadata?.sourceKey).toBe('artifact:v1:identifier:revenue-chart');
  });

  test('consolidates every legacy MIME identity around one deterministic survivor', async () => {
    const legacyKeys = [
      'identifier:revenue-chart',
      'identifier:revenue-chart:text/html',
      'identifier:revenue-chart:application/vnd.react',
    ];
    const legacyApps = [];
    for (const [index, sourceKey] of legacyKeys.entries()) {
      const created = await methods.createArtifactAppWithVersion(
        baseInput({
          title: `Legacy ${index}`,
          sourceMetadata: { ...sourceMetadata, sourceKey },
        }),
      );
      legacyApps.push(created.app);
    }
    const sharedUserId = new mongoose.Types.ObjectId();
    await AclEntry.create([
      {
        principalType: PrincipalType.USER,
        principalId: sharedUserId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: legacyApps[0].id,
        permBits: 1,
      },
      {
        principalType: PrincipalType.USER,
        principalId: sharedUserId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: legacyApps[1].id,
        permBits: 2,
      },
    ]);
    await ArtifactApp.updateOne(
      { artifactAppId: legacyApps[0].artifactAppId },
      { $set: { status: 'archived', 'marketplace.listed': false } },
    );

    const synced = await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));
    const active = await ArtifactApp.find({ status: { $ne: 'archived' } }).lean();
    const archived = await ArtifactApp.find({ status: 'archived' }).lean();

    expect(synced.app.artifactAppId).toBe(legacyApps[2].artifactAppId);
    expect(active).toHaveLength(1);
    expect(active[0]?.sourceMetadata?.sourceKey).toBe(sourceMetadata.sourceKey);
    expect(archived).toHaveLength(2);
    expect(await ArtifactVersion.countDocuments({})).toBe(3);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: synced.app.artifactAppId })).toBe(
      3,
    );
    expect(
      await ArtifactVersion.countDocuments({
        artifactAppId: { $in: legacyApps.slice(0, 2).map(({ artifactAppId }) => artifactAppId) },
      }),
    ).toBe(0);
    expect(synced.app.latestVersionNumber).toBe(3);
    expect(
      await AclEntry.findOne({
        resourceId: synced.app.id,
        principalId: sharedUserId,
      }).lean(),
    ).toMatchObject({ permBits: 3 });
    expect(
      await AclEntry.countDocuments({
        resourceId: { $in: legacyApps.slice(0, 2).map(({ id }) => id) },
      }),
    ).toBe(0);
  });

  test('maps an older client key onto an existing versioned identity', async () => {
    const first = await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));
    const legacy = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: {
          ...sourceMetadata,
          sourceKey: 'identifier:revenue-chart:application/vnd.react',
        },
      }),
    );
    const consolidated = await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));

    expect(legacy.app.artifactAppId).toBe(first.app.artifactAppId);
    expect(consolidated.app.artifactAppId).toBe(first.app.artifactAppId);
    expect(await ArtifactApp.countDocuments({ status: { $ne: 'archived' } })).toBe(1);
    expect(await ArtifactApp.countDocuments({})).toBe(1);
    expect(legacy.app.sourceMetadata?.sourceKey).toBe(sourceMetadata.sourceKey);
    expect(
      await methods.getArtifactAppBySource({
        createdBy: 'user-1',
        conversationId: sourceMetadata.conversationId,
        sourceKey: 'identifier:revenue-chart:application/vnd.react',
      }),
    ).toMatchObject({ artifactAppId: first.app.artifactAppId });
  });

  test('keeps versioned identifiers with MIME-looking suffixes distinct', async () => {
    const report = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: { ...sourceMetadata, sourceKey: 'artifact:v1:identifier:report' },
      }),
    );
    const htmlReport = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: {
          ...sourceMetadata,
          sourceKey: 'artifact:v1:identifier:report:text/html',
        },
      }),
    );

    expect(htmlReport.app.artifactAppId).not.toBe(report.app.artifactAppId);
    expect(await ArtifactApp.countDocuments({ status: { $ne: 'archived' } })).toBe(2);
  });

  test('creates and activates the next version when content changes', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    const second = await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'export default () => <div>v2</div>;' },
    });

    expect(second.versionCreated).toBe(true);
    expect(second.version.versionNumber).toBe(2);
    expect(second.app.latestVersionNumber).toBe(2);
    expect(second.app.activeVersionId).toBe(second.version.artifactVersionId);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      2,
    );
  });

  test('rejects a sync whose baseline is already behind another tab’s completed edit', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    const staleBaseline = first.app.latestVersionNumber;

    const second = await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'export default () => <div>v2</div>;' },
    });
    expect(second.version.versionNumber).toBe(2);

    await expect(
      methods.syncArtifactAppWithVersion(
        {
          ...input,
          version: { ...input.version, sourceSnapshot: 'export default () => <div>stale</div>;' },
        },
        { basedOnVersionNumber: staleBaseline },
      ),
    ).rejects.toThrow(ArtifactSyncConflictError);

    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      2,
    );
    const app = await ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId }).lean();
    expect(app?.latestVersionNumber).toBe(2);
    expect(app?.activeVersionId).toBe(second.version.artifactVersionId);
  });

  test('accepts a sync whose baseline matches the current latest version', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);

    const second = await methods.syncArtifactAppWithVersion(
      {
        ...input,
        version: { ...input.version, sourceSnapshot: 'export default () => <div>v2</div>;' },
      },
      { basedOnVersionNumber: first.app.latestVersionNumber },
    );

    expect(second.versionCreated).toBe(true);
    expect(second.version.versionNumber).toBe(2);
  });

  test('migrates an existing truncated source identity to its hashed key without duplicating it', async () => {
    const sharedPrefix = `artifact:v1:identifier:${'x'.repeat(
      491 - 'artifact:v1:identifier:'.length,
    )}`;
    const legacySourceKey = `${sharedPrefix}old-tail!`;
    const sourceKey = `${sharedPrefix}:deadbeef`;
    const initial = await methods.createArtifactAppWithVersion(
      baseInput({
        sourceMetadata: {
          ...sourceMetadata,
          sourceKey: legacySourceKey,
        },
      }),
    );

    const synced = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: {
          ...sourceMetadata,
          sourceKey,
        },
        version: {
          ...baseInput().version,
          sourceSnapshot: 'export default () => <div>updated</div>;',
        },
      }),
      { basedOnVersionNumber: 1, legacySourceKey },
    );

    expect(synced.app.artifactAppId).toBe(initial.app.artifactAppId);
    expect(await ArtifactApp.countDocuments({ createdBy: 'user-1' })).toBe(1);
    expect(
      (await ArtifactApp.findOne({ artifactAppId: initial.app.artifactAppId }))?.sourceMetadata
        ?.sourceKey,
    ).toBe(sourceKey);
  });

  test('concurrent first syncs resolve to one fully initialized app and version', async () => {
    const input = baseInput({ sourceMetadata });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => methods.syncArtifactAppWithVersion(input)),
    );

    expect(new Set(results.map(({ app }) => app.artifactAppId)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(await ArtifactApp.countDocuments({})).toBe(1);
    expect(await ArtifactVersion.countDocuments({})).toBe(1);
    expect(
      results.every(({ app, version }) => app.activeVersionId === version.artifactVersionId),
    ).toBe(true);
  });

  test('serializes concurrent standalone updates without duplicate versions', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    const updates = Array.from({ length: 4 }, (_, index) =>
      methods.syncArtifactAppWithVersion({
        ...input,
        version: {
          ...input.version,
          sourceSnapshot: `export default () => <div>update-${index}</div>;`,
        },
      }),
    );
    const results = await Promise.all(updates);
    const versions = await ArtifactVersion.find({ artifactAppId: first.app.artifactAppId })
      .sort({ versionNumber: 1 })
      .lean();
    const app = await ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId }).lean();

    expect(results.every(({ versionCreated }) => versionCreated)).toBe(true);
    expect(versions.map(({ versionNumber }) => versionNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(app?.latestVersionNumber).toBe(5);
    expect(
      versions.some(({ artifactVersionId }) => artifactVersionId === app?.activeVersionId),
    ).toBe(true);
  });

  test('deduplicates concurrent updates with identical content', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    const update = {
      ...input,
      version: { ...input.version, sourceSnapshot: 'export default () => <div>shared-v2</div>;' },
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => methods.syncArtifactAppWithVersion(update)),
    );

    expect(results.filter(({ versionCreated }) => versionCreated)).toHaveLength(1);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      2,
    );
  });

  test('does not advance the current version when version creation fails', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);

    await expect(
      methods.syncArtifactAppWithVersion({
        ...input,
        version: {
          ...input.version,
          artifactType: 'invalid-runtime' as CreateArtifactAppInput['version']['artifactType'],
          sourceSnapshot: 'invalid update',
        },
      }),
    ).rejects.toThrow();

    const unchangedApp = await ArtifactApp.findOne({
      artifactAppId: first.app.artifactAppId,
    }).lean();
    expect(unchangedApp?.latestVersionNumber).toBe(1);
    expect(unchangedApp?.activeVersionId).toBe(first.version.artifactVersionId);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      1,
    );

    const retry = await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'valid update' },
    });
    expect(retry.version.versionNumber).toBe(2);
  });

  test('recovers a version written before its app pointer was committed', async () => {
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    const orphanSnapshot = 'export default () => <div>recover me</div>;';
    const recoveredPreview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Recovered preview',
    };
    await ArtifactVersion.create({
      artifactVersionId: 'ver_recoverable',
      artifactAppId: first.app.artifactAppId,
      versionNumber: 2,
      artifactType: 'react',
      sourceSnapshot: orphanSnapshot,
      runtimeConfig: {},
      integrity: {
        sourceHash: computeSourceHash('react', orphanSnapshot),
        schemaVersion: 1,
      },
      createdBy: 'user-1',
      publication: { state: 'draft' },
      preview: recoveredPreview,
    });

    const recovered = await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: orphanSnapshot },
    });
    const persistedApp = await ArtifactApp.findOne({
      artifactAppId: first.app.artifactAppId,
    }).lean();

    expect(recovered.versionCreated).toBe(true);
    expect(recovered.version.artifactVersionId).toBe('ver_recoverable');
    expect(persistedApp?.latestVersionNumber).toBe(2);
    expect(persistedApp?.activeVersionId).toBe('ver_recoverable');
    expect(recovered.app.preview).toEqual(recoveredPreview);
    expect(persistedApp?.preview).toEqual(recoveredPreview);
    expect(await ArtifactVersion.countDocuments({ artifactAppId: first.app.artifactAppId })).toBe(
      2,
    );
  });
});

describe('CRUD', () => {
  test('get / list / update / delete', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());

    const fetched = await methods.getArtifactAppByAppId({ artifactAppId: app.artifactAppId });
    expect(fetched?.title).toBe('My Chart');

    const listed = await methods.listArtifactApps({ createdBy: 'user-1', limit: 20 });
    expect(listed.entries).toHaveLength(1);

    const updated = await methods.updateArtifactApp(
      { artifactAppId: app.artifactAppId },
      { title: 'Updated' },
    );
    expect(updated?.title).toBe('Updated');

    const del = await methods.deleteArtifactApp({ artifactAppId: app.artifactAppId });
    expect(del.deletedApp).toBe(true);
    expect(del.deletedVersions).toBe(1);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: app.artifactAppId })).toBeNull();
  });

  test('lists lightweight ACL candidates before hydrating preview metadata', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    };
    await methods.createArtifactAppWithVersion(
      baseInput({ version: { ...baseInput().version, preview } }),
    );

    const candidates = await methods.listArtifactApps({ createdBy: 'user-1', limit: 20 });
    expect(candidates.entries[0]).toEqual({
      id: expect.any(String),
      cursor: expect.any(String),
    });

    const hydrated = await methods.getArtifactAppsByIds(candidates.entries.map(({ id }) => id));
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.preview).toEqual(preview);
  });

  test('resolveArtifactAppId returns a plain string id for ACL checks', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const resolved = await methods.resolveArtifactAppId({ artifactAppId: app.artifactAppId });
    expect(resolved).toMatch(/^[a-f0-9]{24}$/);
  });

  test('paginates app records with opaque storage-owned cursors', async () => {
    await Promise.all(
      ['First', 'Second', 'Third'].map((title) =>
        methods.createArtifactAppWithVersion(baseInput({ title })),
      ),
    );

    const firstPage = await methods.listArtifactApps({ createdBy: 'user-1', limit: 2 });
    const secondPage = await methods.listArtifactApps({
      createdBy: 'user-1',
      limit: 2,
      cursor: firstPage.after ?? undefined,
    });

    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.after).toEqual(expect.any(String));
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    const appIds = new Set([...firstPage.entries, ...secondPage.entries].map(({ id }) => id));
    expect(appIds.size).toBe(3);
    await expect(
      methods.listArtifactApps({ createdBy: 'user-1', limit: 2, cursor: 'not-json' }),
    ).rejects.toThrow('Invalid artifact app cursor');
  });

  test('applies metadata search before pagination', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        methods.createArtifactAppWithVersion(
          baseInput({
            title: index === 24 ? 'Needle Artifact' : `Ordinary Artifact ${index}`,
            tags: index === 23 ? ['needle-tag'] : undefined,
          }),
        ),
      ),
    );

    const titleResult = await methods.listArtifactApps({
      createdBy: 'user-1',
      search: 'needle artifact',
      limit: 10,
    });
    const tagResult = await methods.listArtifactApps({
      createdBy: 'user-1',
      search: 'needle-tag',
      limit: 10,
    });

    const titleApps = await methods.getArtifactAppsByIds(titleResult.entries.map(({ id }) => id));
    expect(titleApps.map(({ title }) => title)).toEqual(['Needle Artifact']);
    expect(tagResult.entries).toHaveLength(1);
  });

  test('resumes a standalone deletion after a version cleanup failure', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const deleteVersions = jest
      .spyOn(ArtifactVersion, 'deleteMany')
      .mockRejectedValueOnce(new Error('temporary cleanup failure'));

    await expect(
      methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1'),
    ).rejects.toThrow('temporary cleanup failure');
    deleteVersions.mockRestore();
    expect(await methods.getArtifactAppByAppId({ artifactAppId: app.artifactAppId })).toMatchObject(
      {
        deletion: { requestedBy: 'user-1' },
      },
    );

    const retry = await methods.prepareArtifactAppDeletion(
      { artifactAppId: app.artifactAppId },
      'admin-1',
    );
    expect(retry.deletedVersions).toBe(1);
    expect(
      await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'admin-1'),
    ).toBe(true);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: app.artifactAppId })).toMatchObject(
      {
        status: 'archived',
        deletion: { requestedBy: 'user-1', finalizedAt: expect.any(Date) },
      },
    );
  });

  test('allows another authorized actor to join an in-progress deletion', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());

    const prepared = await Promise.all([
      methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1'),
      methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'admin-1'),
    ]);

    expect(prepared.every(({ found }) => found)).toBe(true);
    expect(prepared.reduce((count, result) => count + result.deletedVersions, 0)).toBe(1);
    await expect(
      Promise.all([
        methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1'),
        methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'admin-1'),
      ]),
    ).resolves.toEqual([true, true]);
  });

  test('keeps a durable source fence before and after deletion finalization', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-deleted',
      sourceKey: 'artifact:v1:identifier:deleted-report',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);

    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    await expect(methods.syncArtifactAppWithVersion(input)).rejects.toBeInstanceOf(
      ArtifactAppDeletedError,
    );
    await expect(
      Promise.all([
        methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1'),
        methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1'),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(methods.syncArtifactAppWithVersion(input)).rejects.toBeInstanceOf(
      ArtifactAppDeletedError,
    );
    expect(await methods.listArtifactApps({ createdBy: 'user-1', limit: 20 })).toMatchObject({
      entries: [],
    });
    expect(await ArtifactVersion.countDocuments({ artifactAppId: app.artifactAppId })).toBe(0);
  });

  test('explicitly restores a deleted source with a new draft snapshot', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-restored',
      sourceKey: 'artifact:v1:identifier:restored-report',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');

    expect(
      await methods.getDeletedArtifactAppBySource({
        createdBy: 'user-1',
        conversationId: sourceMetadata.conversationId,
        sourceKey: sourceMetadata.sourceKey,
      }),
    ).toMatchObject({ artifactAppId: app.artifactAppId });

    const restored = await methods.restoreArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'restored content' },
    });

    expect(restored.app).toMatchObject({
      artifactAppId: app.artifactAppId,
      status: 'draft',
      deletion: undefined,
    });
    expect(restored.version).toMatchObject({
      versionNumber: 2,
      sourceSnapshot: 'restored content',
    });
    expect(
      await methods.getDeletedArtifactAppBySource({
        createdBy: 'user-1',
        conversationId: sourceMetadata.conversationId,
        sourceKey: sourceMetadata.sourceKey,
      }),
    ).toBeNull();
  });

  test('does not restore an app whose deletion cleanup is unfinished', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-incomplete-delete',
      sourceKey: 'artifact:v1:identifier:incomplete-delete',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');

    expect(
      await methods.getDeletedArtifactAppBySource({
        createdBy: 'user-1',
        conversationId: sourceMetadata.conversationId,
        sourceKey: sourceMetadata.sourceKey,
      }),
    ).toBeNull();
    await expect(methods.restoreArtifactAppWithVersion(input)).rejects.toBeInstanceOf(
      ArtifactAppRestoreNotFoundError,
    );

    const unfinished = await ArtifactApp.findOne({ artifactAppId: app.artifactAppId });
    expect(unfinished?.deletion).toEqual(expect.objectContaining({ requestedBy: 'user-1' }));
    expect(unfinished?.deletion?.finalizedAt).toBeUndefined();
    expect(unfinished?.sourceMetadata?.conversationId).toBe(sourceMetadata.conversationId);

    await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    const restored = await methods.restoreArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'restored after finalize' },
    });
    expect(restored.app).toMatchObject({
      artifactAppId: app.artifactAppId,
      status: 'draft',
      deletion: undefined,
    });
  });

  test('creates a new restore version when staged content no longer matches', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-stale-restore',
      sourceKey: 'artifact:v1:identifier:stale-restore',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');

    const staleSnapshot = 'stale staged snapshot';
    const stalePreview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Stale preview',
    };
    await ArtifactVersion.create({
      artifactVersionId: 'ver_stale_restore',
      artifactAppId: app.artifactAppId,
      versionNumber: 2,
      artifactType: 'react',
      sourceSnapshot: staleSnapshot,
      runtimeConfig: {},
      integrity: {
        sourceHash: computeSourceHash('react', staleSnapshot),
        schemaVersion: 1,
      },
      createdBy: 'user-1',
      publication: { state: 'draft' },
      preview: stalePreview,
    });

    const restoredPreview = {
      ...stalePreview,
      alt: 'Current preview',
    };
    const restored = await methods.restoreArtifactAppWithVersion({
      ...input,
      title: 'Restored Chart',
      version: {
        ...input.version,
        sourceSnapshot: 'current restore snapshot',
        preview: restoredPreview,
      },
    });

    expect(restored.app).toMatchObject({
      artifactAppId: app.artifactAppId,
      title: 'Restored Chart',
      status: 'draft',
      deletion: undefined,
      preview: restoredPreview,
    });
    expect(restored.version).toMatchObject({
      versionNumber: 3,
      sourceSnapshot: 'current restore snapshot',
    });
    expect(restored.version.artifactVersionId).not.toBe('ver_stale_restore');
    expect(await ArtifactVersion.countDocuments({ artifactAppId: app.artifactAppId })).toBe(2);
  });

  test('recovers a matching staged restore version', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-matching-restore',
      sourceKey: 'artifact:v1:identifier:matching-restore',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');

    const restoreSnapshot = 'matching staged snapshot';
    await ArtifactVersion.create({
      artifactVersionId: 'ver_matching_restore',
      artifactAppId: app.artifactAppId,
      versionNumber: 2,
      artifactType: 'react',
      sourceSnapshot: restoreSnapshot,
      runtimeConfig: {},
      integrity: {
        sourceHash: computeSourceHash('react', restoreSnapshot),
        schemaVersion: 1,
      },
      createdBy: 'user-1',
      publication: { state: 'draft' },
    });

    const restored = await methods.restoreArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: restoreSnapshot },
    });

    expect(restored.version).toMatchObject({
      artifactVersionId: 'ver_matching_restore',
      versionNumber: 2,
      sourceSnapshot: restoreSnapshot,
    });
    expect(await ArtifactVersion.countDocuments({ artifactAppId: app.artifactAppId })).toBe(1);
  });
});

describe('deleteUserArtifactApps', () => {
  test('deletes the user apps, versions, and every resource ACL grant', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const other = await methods.createArtifactAppWithVersion(
      baseInput({ createdBy: 'user-2', title: 'Other Chart' }),
    );
    const ownerId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    await AclEntry.create([
      {
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: ownerId,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: new mongoose.Types.ObjectId(app.id),
        permBits: 7,
      },
      {
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: viewerId,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: new mongoose.Types.ObjectId(app.id),
        permBits: 1,
      },
      {
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: new mongoose.Types.ObjectId(app.id),
        permBits: 1,
      },
      {
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: viewerId,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: new mongoose.Types.ObjectId(other.app.id),
        permBits: 1,
      },
    ]);

    const result = await methods.deleteUserArtifactApps('user-1');

    expect(result).toEqual({ deletedApps: 1, deletedVersions: 1 });
    expect(await ArtifactApp.findOne({ artifactAppId: app.artifactAppId })).toBeNull();
    expect(await ArtifactVersion.countDocuments({ artifactAppId: app.artifactAppId })).toBe(0);
    expect(
      await AclEntry.countDocuments({
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: new mongoose.Types.ObjectId(app.id),
      }),
    ).toBe(0);
    expect(await ArtifactApp.findOne({ artifactAppId: other.app.artifactAppId })).not.toBeNull();
    expect(
      await AclEntry.countDocuments({
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: new mongoose.Types.ObjectId(other.app.id),
      }),
    ).toBe(1);
  });

  test('is a no-op when the user has no artifact apps', async () => {
    await expect(methods.deleteUserArtifactApps('missing-user')).resolves.toEqual({
      deletedApps: 0,
      deletedVersions: 0,
    });
  });
});

describe('detached source tombstones', () => {
  const sourceMetadata = {
    conversationId: 'conversation-detached',
    sourceKey: 'artifact:v1:identifier:detached-report',
  };

  async function detachSource(artifactAppId: string, conversationId: string) {
    await ArtifactApp.updateMany(
      { artifactAppId, 'sourceMetadata.conversationId': conversationId },
      [
        {
          $set: {
            'sourceMetadata.detachedConversationId': '$sourceMetadata.conversationId',
          },
        },
        { $unset: 'sourceMetadata.conversationId' },
      ],
    );
  }

  test('refuses to recreate a catalog record after the source conversation is detached', async () => {
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await detachSource(app.artifactAppId, sourceMetadata.conversationId);

    await expect(methods.syncArtifactAppWithVersion(input)).rejects.toBeInstanceOf(
      ArtifactAppDeletedError,
    );
    expect(await ArtifactApp.countDocuments({ createdBy: 'user-1' })).toBe(1);
    expect(
      (await ArtifactApp.findOne({ artifactAppId: app.artifactAppId }))?.sourceMetadata,
    ).toMatchObject({
      sourceKey: sourceMetadata.sourceKey,
      detachedConversationId: sourceMetadata.conversationId,
    });
    expect(
      (await ArtifactApp.findOne({ artifactAppId: app.artifactAppId }))?.sourceMetadata
        ?.conversationId,
    ).toBeUndefined();
  });

  test('does not restore a detached conversation link when sync races with deletion', async () => {
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    const update = {
      ...input,
      version: { ...input.version, sourceSnapshot: 'export default () => <div>next</div>;' },
    };

    const [syncResult] = await Promise.allSettled([
      methods.syncArtifactAppWithVersion(update),
      detachSource(app.artifactAppId, sourceMetadata.conversationId),
    ]);

    if (syncResult.status === 'fulfilled') {
      expect(syncResult.value.app.artifactAppId).toBe(app.artifactAppId);
    } else {
      expect(syncResult.reason).toBeInstanceOf(ArtifactAppDeletedError);
    }

    expect(await ArtifactApp.countDocuments({ createdBy: 'user-1' })).toBe(1);
    const persisted = await ArtifactApp.findOne({ artifactAppId: app.artifactAppId });
    expect(persisted?.sourceMetadata?.conversationId).toBeUndefined();
    expect(persisted?.sourceMetadata?.detachedConversationId).toBe(sourceMetadata.conversationId);
  });

  test('does not create an app when conversation deletion finishes after the final source check', async () => {
    const conversationId = 'conversation-first-insert-race';
    const input = baseInput({
      sourceMetadata: {
        conversationId,
        sourceKey: 'artifact:v1:identifier:first-insert-race',
      },
    });
    let releaseCheck: () => void = () => {
      throw new Error('afterSourceCheck was not reached');
    };
    const checkReached = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let resumeInsert: () => void = () => {
      throw new Error('insert gate was not armed');
    };
    const insertGate = new Promise<void>((resolve) => {
      resumeInsert = resolve;
    });

    const syncPromise = methods.syncArtifactAppWithVersion(input, {
      afterSourceCheck: async () => {
        releaseCheck();
        await insertGate;
      },
    });

    await checkReached;
    await methods.recordArtifactSourceTombstones('user-1', [conversationId]);
    resumeInsert();

    await expect(syncPromise).rejects.toBeInstanceOf(ArtifactAppDeletedError);
    expect(await ArtifactApp.countDocuments({ createdBy: 'user-1' })).toBe(0);
    expect(
      await ArtifactApp.countDocuments({ 'sourceMetadata.conversationId': conversationId }),
    ).toBe(0);
  });

  test('does not reattach a deleted conversation when restore finishes after source deletion', async () => {
    const conversationId = 'conversation-restore-race';
    const sourceMetadata = {
      conversationId,
      sourceKey: 'artifact:v1:identifier:restore-race',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');

    let releaseCheck: () => void = () => {
      throw new Error('afterSourceCheck was not reached');
    };
    const checkReached = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let resumeRestore: () => void = () => {
      throw new Error('restore gate was not armed');
    };
    const restoreGate = new Promise<void>((resolve) => {
      resumeRestore = resolve;
    });

    const restorePromise = methods.restoreArtifactAppWithVersion(
      {
        ...input,
        version: { ...input.version, sourceSnapshot: 'restored after race' },
      },
      {
        afterSourceCheck: async () => {
          releaseCheck();
          await restoreGate;
        },
      },
    );

    await checkReached;
    await methods.recordArtifactSourceTombstones('user-1', [conversationId]);
    await detachSource(app.artifactAppId, conversationId);
    resumeRestore();

    await expect(restorePromise).rejects.toBeInstanceOf(ArtifactAppDeletedError);
    const persisted = await ArtifactApp.findOne({ artifactAppId: app.artifactAppId });
    expect(persisted?.sourceMetadata?.conversationId).toBeUndefined();
    expect(persisted?.sourceMetadata?.detachedConversationId).toBe(conversationId);
    expect(persisted?.deletion).toEqual(expect.objectContaining({ requestedBy: 'user-1' }));
  });

  test('detaches a restored source when a tombstone lands during the restoring update', async () => {
    const conversationId = 'conversation-restore-tombstone-race';
    const sourceMetadata = {
      conversationId,
      sourceKey: 'artifact:v1:identifier:restore-tombstone-race',
    };
    const input = baseInput({ sourceMetadata });
    const { app } = await methods.syncArtifactAppWithVersion(input);
    await methods.prepareArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');
    await methods.finalizeArtifactAppDeletion({ artifactAppId: app.artifactAppId }, 'user-1');

    let releaseCheck: () => void = () => {
      throw new Error('afterSourceCheck was not reached');
    };
    const checkReached = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let resumeRestore: () => void = () => {
      throw new Error('restore gate was not armed');
    };
    const restoreGate = new Promise<void>((resolve) => {
      resumeRestore = resolve;
    });

    const restorePromise = methods.restoreArtifactAppWithVersion(
      {
        ...input,
        version: { ...input.version, sourceSnapshot: 'restored before tombstone' },
      },
      {
        afterSourceCheck: async () => {
          releaseCheck();
          await restoreGate;
        },
      },
    );

    await checkReached;
    await methods.recordArtifactSourceTombstones('user-1', [conversationId]);
    resumeRestore();

    await expect(restorePromise).rejects.toBeInstanceOf(ArtifactAppDeletedError);
    const persisted = await ArtifactApp.findOne({ artifactAppId: app.artifactAppId });
    expect(persisted?.sourceMetadata?.conversationId).toBeUndefined();
    expect(persisted?.sourceMetadata?.detachedConversationId).toBe(conversationId);
  });

  test('propagates a transient tombstone write so deletion can retry', async () => {
    const conversationId = 'conversation-tombstone-transient';
    const transient = Object.assign(new Error('transient tombstone write'), {
      code: 112,
      errorLabels: ['TransientTransactionError'],
    });
    const bulkWrite = jest
      .spyOn(ArtifactSourceTombstone, 'bulkWrite')
      .mockRejectedValueOnce(transient);

    await expect(methods.recordArtifactSourceTombstones('user-1', [conversationId])).rejects.toBe(
      transient,
    );
    expect(
      await ArtifactSourceTombstone.findOne({ createdBy: 'user-1', conversationId }),
    ).toBeNull();
    bulkWrite.mockRestore();
  });

  test('ignores a duplicate-key tombstone write only after the tombstone exists', async () => {
    const conversationId = 'conversation-tombstone-duplicate';
    await methods.recordArtifactSourceTombstones('user-1', [conversationId]);
    const duplicate = Object.assign(new Error('duplicate key'), { code: 11000 });
    const bulkWrite = jest
      .spyOn(ArtifactSourceTombstone, 'bulkWrite')
      .mockRejectedValueOnce(duplicate);

    await expect(
      methods.recordArtifactSourceTombstones('user-1', [conversationId]),
    ).resolves.toBeUndefined();

    bulkWrite.mockReset();
    bulkWrite.mockRejectedValueOnce(duplicate);
    await expect(
      methods.recordArtifactSourceTombstones('user-1', ['conversation-tombstone-missing']),
    ).rejects.toBe(duplicate);
    bulkWrite.mockRestore();
  });

  test('does not return a first insert when abandonment hits a retryable write error', async () => {
    const conversationId = 'conversation-abandon-retryable';
    const input = baseInput({
      sourceMetadata: {
        conversationId,
        sourceKey: 'artifact:v1:identifier:abandon-retryable',
      },
    });
    let releaseCheck: () => void = () => {
      throw new Error('afterSourceCheck was not reached');
    };
    const checkReached = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    let resumeInsert: () => void = () => {
      throw new Error('insert gate was not armed');
    };
    const insertGate = new Promise<void>((resolve) => {
      resumeInsert = resolve;
    });

    const conflict = Object.assign(new Error('write conflict'), { code: 112 });
    const updateMany = jest.spyOn(ArtifactApp, 'updateMany').mockImplementation(() => {
      throw conflict;
    });

    const syncPromise = methods.syncArtifactAppWithVersion(input, {
      afterSourceCheck: async () => {
        releaseCheck();
        await insertGate;
      },
      syncWriteRetryAttempts: 1,
    });

    try {
      await checkReached;
      await methods.recordArtifactSourceTombstones('user-1', [conversationId]);
      resumeInsert();

      await expect(syncPromise).rejects.toBe(conflict);
      expect(
        (await ArtifactApp.findOne({ 'sourceMetadata.conversationId': conversationId }))
          ?.sourceMetadata?.conversationId,
      ).toBe(conversationId);
    } finally {
      updateMany.mockRestore();
    }
  });
});

describe('version lifecycle', () => {
  test('paginates version metadata without returning stored snapshots', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-pagination',
      messageId: 'message-1',
      sourceKey: 'identifier:pagination',
    };
    const input = baseInput({ sourceMetadata });
    const first = await methods.syncArtifactAppWithVersion(input);
    await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'version two' },
    });
    await methods.syncArtifactAppWithVersion({
      ...input,
      version: { ...input.version, sourceSnapshot: 'version three' },
    });

    const firstPage = await methods.listArtifactVersions({
      artifactAppId: first.app.artifactAppId,
      limit: 2,
    });
    const secondPage = await methods.listArtifactVersions({
      artifactAppId: first.app.artifactAppId,
      limit: 2,
      cursor: firstPage.after ?? undefined,
    });

    expect(firstPage.versions.map(({ versionNumber }) => versionNumber)).toEqual([3, 2]);
    expect(firstPage.versions.every((version) => !('sourceSnapshot' in version))).toBe(true);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.versions.map(({ versionNumber }) => versionNumber)).toEqual([1]);
    expect(secondPage.hasMore).toBe(false);
    await expect(
      methods.listArtifactVersions({
        artifactAppId: first.app.artifactAppId,
        limit: 2,
        cursor: 'not-json',
      }),
    ).rejects.toThrow('Invalid artifact version cursor');
  });

  test('release then activate; activate rejects unreleased versions', async () => {
    const { app, version } = await methods.createArtifactAppWithVersion(baseInput());

    await expect(
      methods.activateArtifactVersion({
        artifactAppId: app.artifactAppId,
        versionNumber: 1,
      }),
    ).rejects.toThrow(/released/);

    const released = await methods.releaseArtifactVersion(
      { artifactAppId: app.artifactAppId, versionNumber: 1 },
      'user-1',
    );
    expect(released?.publication.state).toBe('released');
    expect(released?.publication.releasedBy).toBe('user-1');

    const activated = await methods.activateArtifactVersion({
      artifactAppId: app.artifactAppId,
      versionNumber: 1,
    });
    expect(activated?.app.activeVersionId).toBe(version.artifactVersionId);
  });

  test('activating a version with no preview clears the app’s existing preview', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'First preview',
    };
    const sourceMetadata = {
      conversationId: 'conversation-preview-clear',
      messageId: 'message-1',
      originalArtifactId: 'artifact-preview-clear',
      sourceKey: 'identifier:preview-clear',
    };
    const first = await methods.syncArtifactAppWithVersion(
      baseInput({ sourceMetadata, version: { ...baseInput().version, preview } }),
    );
    await methods.releaseArtifactVersion({ artifactAppId: first.app.artifactAppId }, 'user-1');
    await methods.activateArtifactVersion({
      artifactAppId: first.app.artifactAppId,
      versionNumber: 1,
    });
    const withPreview = await ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId })
      .lean()
      .orFail();
    expect(withPreview.preview).toEqual(preview);

    const second = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: { ...sourceMetadata, messageId: 'message-2' },
        version: { ...baseInput().version, sourceSnapshot: 'no preview here' },
      }),
    );
    expect(second.version.versionNumber).toBe(2);
    await methods.releaseArtifactVersion(
      { artifactAppId: first.app.artifactAppId, versionNumber: 2 },
      'user-1',
    );

    // `sync` already clears the preview correctly when it auto-activates v2 (line ~1683), so
    // roll back to v1 first — restoring the preview through the very function under test —
    // before re-activating v2, to isolate whether *activate* itself clears a stale preview
    // rather than piggybacking on sync's already-correct behavior.
    await methods.activateArtifactVersion({
      artifactAppId: first.app.artifactAppId,
      versionNumber: 1,
    });
    const rolledBack = await ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId })
      .lean()
      .orFail();
    expect(rolledBack.preview).toEqual(preview);

    const activated = await methods.activateArtifactVersion({
      artifactAppId: first.app.artifactAppId,
      versionNumber: 2,
    });
    expect(activated?.app.preview).toBeUndefined();
    const withoutPreview = await ArtifactApp.findOne({ artifactAppId: first.app.artifactAppId })
      .lean()
      .orFail();
    expect(withoutPreview.preview).toBeUndefined();
  });

  test('activating in standalone mode self-heals if the version is withdrawn between the app write and the recheck', async () => {
    const { app, version } = await methods.createArtifactAppWithVersion(baseInput());
    await methods.releaseArtifactVersion({ artifactAppId: app.artifactAppId }, 'user-1');

    const spy = jest.spyOn(ArtifactVersion, 'findOne').mockImplementationOnce(
      () =>
        ({
          exec: async () => {
            await ArtifactVersion.updateOne(
              { artifactVersionId: version.artifactVersionId },
              { $set: { 'publication.state': 'withdrawn' } },
            );
            return null;
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );

    try {
      await expect(
        methods.activateArtifactVersion({ artifactAppId: app.artifactAppId, versionNumber: 1 }),
      ).rejects.toThrow(/Only released versions/);
    } finally {
      spy.mockRestore();
    }

    const finalApp = await ArtifactApp.findOne({ artifactAppId: app.artifactAppId })
      .lean()
      .orFail();
    expect(finalApp.activeVersionId).toBeUndefined();
    expect(finalApp.preview).toBeUndefined();
    const finalVersion = await ArtifactVersion.findOne({
      artifactVersionId: version.artifactVersionId,
    })
      .lean()
      .orFail();
    expect(finalVersion.publication.state).toBe('withdrawn');
  });

  test('rollback: activate an older released version', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-rollback',
      messageId: 'message-1',
      originalArtifactId: 'artifact-rollback',
      sourceKey: 'identifier:rollback',
    };
    const first = await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));
    const { app, version: v1 } = first;
    await methods.releaseArtifactVersion(
      { artifactAppId: app.artifactAppId, versionNumber: 1 },
      'user-1',
    );
    const second = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: { ...sourceMetadata, messageId: 'message-2' },
        version: { ...baseInput().version, sourceSnapshot: 'v2' },
      }),
    );
    const v2 = second.version;
    await methods.releaseArtifactVersion(
      { artifactAppId: app.artifactAppId, versionNumber: 2 },
      'user-1',
    );
    await methods.activateArtifactVersion({ artifactAppId: app.artifactAppId, versionNumber: 2 });

    const rolledBack = await methods.activateArtifactVersion({
      artifactAppId: app.artifactAppId,
      versionNumber: 1,
    });
    expect(rolledBack?.app.activeVersionId).toBe(v1.artifactVersionId);
    expect(v2.versionNumber).toBe(2);
  });

  test('rollback restores the active app thumbnail from the selected version', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-preview-rollback',
      messageId: 'message-1',
      originalArtifactId: 'artifact-preview-rollback',
      sourceKey: 'identifier:preview-rollback',
    };
    const firstPreview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'First preview',
    };
    const secondPreview = {
      type: 'image' as const,
      imageUrl: 'data:image/webp;base64,UklGRgQAAABXRUJQ',
      alt: 'Second preview',
    };
    const first = await methods.syncArtifactAppWithVersion(
      baseInput({ sourceMetadata, version: { ...baseInput().version, preview: firstPreview } }),
    );
    await methods.releaseArtifactVersion(
      { artifactAppId: first.app.artifactAppId, versionNumber: 1 },
      'user-1',
    );
    await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: { ...sourceMetadata, messageId: 'message-2' },
        version: { ...baseInput().version, sourceSnapshot: 'v2', preview: secondPreview },
      }),
    );
    await methods.releaseArtifactVersion(
      { artifactAppId: first.app.artifactAppId, versionNumber: 2 },
      'user-1',
    );
    await methods.activateArtifactVersion({
      artifactAppId: first.app.artifactAppId,
      versionNumber: 2,
    });

    const rolledBack = await methods.activateArtifactVersion({
      artifactAppId: first.app.artifactAppId,
      versionNumber: 1,
    });

    expect(rolledBack?.app.preview).toEqual(firstPreview);
  });

  test('released version snapshot/hash are immutable across lifecycle transitions', async () => {
    const { app } = await methods.createArtifactAppWithVersion(baseInput());
    const released = await methods.releaseArtifactVersion(
      { artifactAppId: app.artifactAppId, versionNumber: 1 },
      'user-1',
    );
    const hashAtRelease = released?.integrity.sourceHash;

    await methods.withdrawArtifactVersion({ artifactAppId: app.artifactAppId, versionNumber: 1 });

    const reread = await methods.getArtifactVersion({
      artifactAppId: app.artifactAppId,
      versionNumber: 1,
    });
    expect(reread?.integrity.sourceHash).toBe(hashAtRelease);
    expect(reread?.publication.state).toBe('withdrawn');
  });

  test('withdrawing the active version clears the app pointer so viewers stop seeing it', async () => {
    const { app, version } = await methods.createArtifactAppWithVersion(baseInput());
    await methods.releaseArtifactVersion({ artifactAppId: app.artifactAppId }, 'user-1');
    const beforeWithdraw = await methods.getArtifactAppByAppId({
      artifactAppId: app.artifactAppId,
    });
    expect(beforeWithdraw?.activeVersionId).toBe(version.artifactVersionId);

    await methods.withdrawArtifactVersion({ artifactAppId: app.artifactAppId, versionNumber: 1 });

    const afterWithdraw = await methods.getArtifactAppByAppId({
      artifactAppId: app.artifactAppId,
    });
    expect(afterWithdraw?.activeVersionId).toBeUndefined();
  });

  test('withdrawing an inactive version leaves the app pointer untouched', async () => {
    const sourceMetadata = {
      conversationId: 'conversation-withdraw-inactive',
      messageId: 'message-1',
      originalArtifactId: 'artifact-withdraw-inactive',
      sourceKey: 'identifier:withdraw-inactive',
    };
    const first = await methods.syncArtifactAppWithVersion(baseInput({ sourceMetadata }));
    const { app, version: v1 } = first;
    await methods.releaseArtifactVersion(
      { artifactAppId: app.artifactAppId, versionNumber: 1 },
      'user-1',
    );
    const second = await methods.syncArtifactAppWithVersion(
      baseInput({
        sourceMetadata: { ...sourceMetadata, messageId: 'message-2' },
        version: { ...baseInput().version, sourceSnapshot: 'v2' },
      }),
    );
    const v2 = second.version;
    await methods.releaseArtifactVersion(
      { artifactAppId: app.artifactAppId, versionNumber: 2 },
      'user-1',
    );
    await methods.activateArtifactVersion({ artifactAppId: app.artifactAppId, versionNumber: 2 });

    await methods.withdrawArtifactVersion({ artifactAppId: app.artifactAppId, versionNumber: 1 });

    const afterWithdraw = await methods.getArtifactAppByAppId({
      artifactAppId: app.artifactAppId,
    });
    expect(afterWithdraw?.activeVersionId).toBe(v2.artifactVersionId);
    const withdrawn = await methods.getArtifactVersion({
      artifactAppId: app.artifactAppId,
      versionNumber: 1,
    });
    expect(withdrawn?.publication.state).toBe('withdrawn');
    expect(v1.versionNumber).toBe(1);
  });
});

describe('tenant isolation', () => {
  test('snapshot save guards preserve caller predicates and tenant isolation across saves', async () => {
    const document = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      const { app } = await methods.createArtifactAppWithVersion(
        baseInput({ tenantId: 'tenant-a' }),
      );
      return ArtifactVersion.findOne({ artifactAppId: app.artifactAppId }).orFail().exec();
    });
    document.$where = { createdBy: 'not-the-owner' };
    document.sourceSnapshot = 'draft edit';
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () => document.save()),
    ).rejects.toThrow();
    document.$where = { createdBy: 'user-1' };
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => document.save());
    expect(document.$where.createdBy).toBe('user-1');
    document.sourceSnapshot = 'cross-tenant edit';
    await expect(
      tenantStorage.run({ tenantId: 'tenant-b' }, async () => document.save()),
    ).rejects.toThrow();
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      const stored = await ArtifactVersion.findById(document._id).orFail();
      expect(stored.sourceSnapshot).toBe('draft edit');
    });
  });

  test('apps are scoped by tenant; cross-tenant reads return nothing', async () => {
    const appA = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.createArtifactAppWithVersion(baseInput({ tenantId: 'tenant-a' })),
    );
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      methods.createArtifactAppWithVersion(baseInput({ tenantId: 'tenant-b' })),
    );

    const fromB = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      methods.getArtifactAppByAppId({ artifactAppId: appA.app.artifactAppId }),
    );
    expect(fromB).toBeNull();

    const fromA = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.getArtifactAppByAppId({ artifactAppId: appA.app.artifactAppId }),
    );
    expect(fromA?.artifactAppId).toBe(appA.app.artifactAppId);

    const listB = await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      const candidates = await methods.listArtifactApps({ limit: 20 });
      return methods.getArtifactAppsByIds(candidates.entries.map(({ id }) => id));
    });
    expect(listB).toHaveLength(1);
    expect(listB[0]?.tenantId).toBe('tenant-b');
  });

  test('tenant-scoped deletion tombstones remain visible to later sync', async () => {
    const conversationId = 'conversation-tenant-tombstone';
    const input = baseInput({
      tenantId: 'tenant-a',
      sourceMetadata: {
        conversationId,
        sourceKey: 'artifact:v1:identifier:tenant-tombstone',
      },
    });

    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await methods.recordArtifactSourceTombstones('user-1', [conversationId]);
      const raw = await mongoose.connection.db
        ?.collection('artifactsourcetombstones')
        .findOne({ createdBy: 'user-1', conversationId });
      expect(raw?.tenantId).toBe('tenant-a');
      await expect(methods.syncArtifactAppWithVersion(input)).rejects.toBeInstanceOf(
        ArtifactAppDeletedError,
      );
      expect(await ArtifactApp.countDocuments({ createdBy: 'user-1' })).toBe(0);
    });
  });
});
