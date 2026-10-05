import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createArtifactAppMethods } from '@librechat/data-schemas';
import { ResourceType, AccessRoleIds, PermissionBits } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createArtifactAppHandlers, createSourceConversationExistsCheck } from '../handlers';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createArtifactAppMethods>;
let handlers: ReturnType<typeof createArtifactAppHandlers>;

interface GrantRecord {
  principalId: string;
  resourceType: string;
  resourceId: string;
  accessRoleId: string;
}

let grants: GrantRecord[];
let auditActions: string[];
let accessibleIds: string[];
let permissionBatchSizes: number[];
let removedPermissionIds: string[];

function makeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

/** Route bodies are validated by zod inside the handlers, so the mock body is
 * deliberately unconstrained rather than the chat-shaped `ServerRequest['body']`. */
type ReqOverrides = Partial<Omit<ServerRequest, 'body' | 'user'>> & {
  body?: unknown;
  user?: IUser;
};

function makeUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new mongoose.Types.ObjectId(),
    id: 'user-1',
    name: 'User One',
    email: 'user-one@example.com',
    emailVerified: true,
    provider: 'local',
    tenantId: undefined,
    ...overrides,
  } as IUser;
}

function makeReq(overrides: ReqOverrides = {}): ServerRequest {
  return {
    user: makeUser(),
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as ServerRequest;
}

const samplePreview = {
  type: 'image' as const,
  imageUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  alt: 'Chart preview',
};

const samplePublish = {
  title: 'My Chart',
  description: 'A bar chart',
  visibility: 'private' as const,
  artifact: {
    type: 'react' as const,
    content: 'export default () => <div>hello</div>;',
    title: 'Chart',
    preview: samplePreview,
  },
};

const syncBody = {
  title: 'Revenue chart',
  artifact: samplePublish.artifact,
  source: {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    originalArtifactId: 'render-1',
    sourceKey: 'artifact:v1:identifier:revenue-chart',
  },
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createArtifactAppMethods(mongoose);
  handlers = createArtifactAppHandlers({
    ...methods,
    getResourcePermissionsMap: async ({ resourceIds }) => {
      permissionBatchSizes.push(resourceIds.length);
      const accessibleSet = new Set(accessibleIds);
      return new Map(
        resourceIds.filter((id) => accessibleSet.has(id)).map((id) => [id, PermissionBits.VIEW]),
      );
    },
    grantPermission: async (params) => {
      grants.push({
        principalId: String(params.principalId),
        resourceType: params.resourceType,
        resourceId: String(params.resourceId),
        accessRoleId: params.accessRoleId,
      });
    },
    removeAllPermissions: async ({ resourceId }) => {
      removedPermissionIds.push(resourceId);
    },
    recordAuditEntry: async (input) => {
      auditActions.push(input.action);
    },
    sourceConversationExists: async () => true,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  grants = [];
  auditActions = [];
  accessibleIds = [];
  permissionBatchSizes = [];
  removedPermissionIds = [];
});

describe('createSourceConversationExistsCheck', () => {
  test('returns false when the conversation does not exist', async () => {
    const check = createSourceConversationExistsCheck(async () => null);
    expect(await check({ userId: 'user-1', conversationId: 'conversation-1' })).toBe(false);
  });

  test('excludes a temporary chat, since artifact apps/versions have no expiration', async () => {
    const check = createSourceConversationExistsCheck(async () => ({ isTemporary: true }));
    expect(await check({ userId: 'user-1', conversationId: 'conversation-1' })).toBe(false);
  });

  test('allows a permanent, existing conversation', async () => {
    const check = createSourceConversationExistsCheck(async () => ({ isTemporary: false }));
    expect(await check({ userId: 'user-1', conversationId: 'conversation-1' })).toBe(true);
  });
});

describe('publish', () => {
  test('creates app + version 1, grants owner ACL, and audits', async () => {
    const req = makeReq({ body: samplePublish });
    const res = makeRes();
    await handlers.publish(req, res);

    expect(res.statusCode).toBe(201);
    const body = res.body as {
      app: { artifactAppId: string; createdBy: string; preview?: { imageUrl: string } };
      version: {
        versionNumber: number;
        sourceSnapshot: string;
        preview?: { imageUrl: string };
        integrity: { sourceHash: string };
      };
    };
    expect(body.app.artifactAppId).toMatch(/^app_/);
    expect(body.app.createdBy).toBe('user-1');
    expect(body.app.preview).toEqual(samplePreview);
    expect(body.version.versionNumber).toBe(1);
    expect(body.version.sourceSnapshot).toBe(samplePublish.artifact.content);
    expect(body.version.preview).toEqual(samplePreview);
    expect(body.version.integrity.sourceHash).toHaveLength(64);

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      principalId: 'user-1',
      resourceType: ResourceType.ARTIFACT_APP,
      accessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
    });
    expect(auditActions).toContain('artifact_app.created');
  });

  test('ignores createdBy/tenantId supplied in the request body (§8.7)', async () => {
    const req = makeReq({
      body: { ...samplePublish, createdBy: 'attacker', tenantId: 'other-tenant' } as never,
    });
    const res = makeRes();
    await handlers.publish(req, res);

    const body = res.body as { app: { createdBy: string; tenantId?: string } };
    expect(body.app.createdBy).toBe('user-1');
    expect(body.app.tenantId).toBeUndefined();
  });

  test('rejects invalid payloads with 400', async () => {
    const req = makeReq({ body: { title: '' } });
    const res = makeRes();
    await handlers.publish(req, res);
    expect(res.statusCode).toBe(400);
  });

  test('rejects remote artifact previews before persistence', async () => {
    const req = makeReq({
      body: {
        ...samplePublish,
        artifact: {
          ...samplePublish.artifact,
          preview: {
            ...samplePreview,
            imageUrl: 'https://attacker.example/pixel.png',
          },
        },
      },
    });
    const res = makeRes();

    await handlers.publish(req, res);

    expect(res.statusCode).toBe(400);
    expect(await methods.listArtifactApps({ createdBy: 'user-1', limit: 20 })).toMatchObject({
      entries: [],
    });
  });

  test('snapshot is independent of later publishes of a mutated artifact', async () => {
    const first = makeRes();
    await handlers.publish(makeReq({ body: samplePublish }), first);
    const firstBody = first.body as { app: { artifactAppId: string } };

    const mutated = {
      ...samplePublish,
      artifact: { ...samplePublish.artifact, content: 'export default () => <div>changed</div>;' },
    };
    const second = makeRes();
    await handlers.publish(makeReq({ body: mutated }), second);

    const stored = await methods.getArtifactVersion({
      artifactAppId: firstBody.app.artifactAppId,
      versionNumber: 1,
    });
    expect(stored?.sourceSnapshot).toBe(samplePublish.artifact.content);
  });
});

describe('artifact app configuration injection', () => {
  test('passes configured synchronization limits to the storage method', async () => {
    const syncArtifactAppWithVersion = jest.fn(methods.syncArtifactAppWithVersion);
    const configuredHandlers = createArtifactAppHandlers({
      ...methods,
      syncArtifactAppWithVersion,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
      getConfig: () => ({
        syncLockLeaseMs: 12_000,
        syncLockRetryDelayMs: 125,
        syncLockRetryAttempts: 8,
        syncWriteRetryAttempts: 4,
      }),
    });

    await configuredHandlers.sync(makeReq({ body: syncBody }), makeRes());

    expect(syncArtifactAppWithVersion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        syncLockLeaseMs: 12_000,
        syncLockRetryDelayMs: 125,
        syncLockRetryAttempts: 8,
        syncWriteRetryAttempts: 4,
      }),
    );
  });

  test('uses the configured scan batch size', async () => {
    const listArtifactApps = jest.fn().mockResolvedValue({
      entries: [],
      hasMore: false,
      after: null,
    });
    const configuredHandlers = createArtifactAppHandlers({
      ...methods,
      listArtifactApps,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
      getConfig: () => ({ scanBatchSize: 37 }),
    });

    await configuredHandlers.list(makeReq({}), makeRes());

    expect(listArtifactApps).toHaveBeenCalledWith(expect.objectContaining({ limit: 37 }));
  });
});

describe('automatic catalog sync', () => {
  test('creates once, then reuses the catalog record for identical content', async () => {
    const first = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), first);
    const second = makeRes();
    await handlers.sync(
      makeReq({
        body: {
          ...syncBody,
          source: { ...syncBody.source, messageId: 'message-2', originalArtifactId: 'render-2' },
        },
      }),
      second,
    );

    expect(first.statusCode).toBe(201);
    expect(
      (
        first.body as {
          app: { preview?: { imageUrl: string } };
          version: { preview?: { imageUrl: string } };
        }
      ).app.preview?.imageUrl,
    ).toBe(samplePreview.imageUrl);
    expect(
      (
        first.body as {
          app: { preview?: { imageUrl: string } };
          version: { preview?: { imageUrl: string } };
        }
      ).version.preview?.imageUrl,
    ).toBe(samplePreview.imageUrl);
    expect(second.statusCode).toBe(200);
    expect(second.body as { created: boolean; versionCreated: boolean }).toMatchObject({
      created: false,
      versionCreated: false,
    });
    expect(grants).toHaveLength(2);
  });

  test('reuses a catalog record created with the former truncated long source key', async () => {
    const sharedPrefix = `artifact:v1:identifier:${'x'.repeat(
      491 - 'artifact:v1:identifier:'.length,
    )}`;
    const legacySourceKey = `${sharedPrefix}old-tail!`;
    const sourceKey = `${sharedPrefix}:deadbeef`;
    const existing = await methods.createArtifactAppWithVersion({
      createdBy: 'user-1',
      title: syncBody.title,
      visibility: 'private',
      marketplace: { listed: true },
      sourceMetadata: { ...syncBody.source, sourceKey: legacySourceKey },
      version: {
        artifactType: syncBody.artifact.type,
        sourceSnapshot: syncBody.artifact.content,
        createdBy: 'user-1',
      },
    });
    const res = makeRes();

    await handlers.sync(
      makeReq({
        body: {
          ...syncBody,
          source: { ...syncBody.source, sourceKey, legacySourceKey },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as { app: { artifactAppId: string } }).app.artifactAppId).toBe(
      existing.app.artifactAppId,
    );
    expect(
      await methods.getArtifactAppBySource({
        createdBy: 'user-1',
        conversationId: 'conversation-1',
        sourceKey,
      }),
    ).not.toBeNull();
  });

  test('rejects a sync whose basedOnVersionNumber is already behind the current latest', async () => {
    const first = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), first);
    const staleBaseline = (first.body as { app: { latestVersionNumber: number } }).app
      .latestVersionNumber;

    const second = makeRes();
    await handlers.sync(
      makeReq({
        body: {
          ...syncBody,
          artifact: { ...syncBody.artifact, content: 'export default () => <div>v2</div>;' },
          source: { ...syncBody.source, messageId: 'message-2', originalArtifactId: 'render-2' },
        },
      }),
      second,
    );
    expect(second.statusCode).toBe(200);

    const third = makeRes();
    await handlers.sync(
      makeReq({
        body: {
          ...syncBody,
          artifact: { ...syncBody.artifact, content: 'export default () => <div>stale</div>;' },
          source: { ...syncBody.source, messageId: 'message-3', originalArtifactId: 'render-3' },
          basedOnVersionNumber: staleBaseline,
        },
      }),
      third,
    );
    expect(third.statusCode).toBe(409);

    const app = await methods.getArtifactAppByAppId({
      artifactAppId: (second.body as { app: { artifactAppId: string } }).app.artifactAppId,
    });
    expect(app?.latestVersionNumber).toBe(2);
  });

  test('returns an owner-only source lookup for the share button', async () => {
    await handlers.sync(makeReq({ body: syncBody }), makeRes());
    const res = makeRes();
    await handlers.getBySource(
      makeReq({
        query: {
          conversationId: syncBody.source.conversationId,
          sourceKey: syncBody.source.sourceKey,
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as { app: { id: string } }).app.id).toMatch(/^[a-f0-9]{24}$/);
  });
});

describe('get / list', () => {
  test('get retains the app and active-version rollout envelope', async () => {
    const created = makeRes();
    await handlers.publish(makeReq({ body: samplePublish }), created);
    const appId = (created.body as { app: { artifactAppId: string } }).app.artifactAppId;

    const res = makeRes();
    await handlers.get(makeReq({ params: { id: appId } as never }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      app: { artifactAppId: string };
      version: { artifactAppId: string };
    };
    expect(body.app.artifactAppId).toBe(appId);
    expect(body.version.artifactAppId).toBe(appId);
  });

  test('list returns only ACL-accessible apps', async () => {
    const a = makeRes();
    await handlers.publish(makeReq({ body: samplePublish }), a);
    const b = makeRes();
    await handlers.publish(makeReq({ body: { ...samplePublish, title: 'Second' } }), b);

    const resolvedA = await methods.resolveArtifactAppId({
      artifactAppId: (a.body as { app: { artifactAppId: string } }).app.artifactAppId,
    });
    accessibleIds = [resolvedA as string];

    const res = makeRes();
    await handlers.list(makeReq({}), res);
    const body = res.body as { apps: unknown[] };
    expect(body.apps).toHaveLength(1);
  });

  test('hydrates previews only after ACL filtering', async () => {
    const allowed = await methods.createArtifactAppWithVersion({
      createdBy: 'user-1',
      title: 'Allowed',
      visibility: 'private',
      version: {
        artifactType: 'react',
        sourceSnapshot: 'allowed',
        createdBy: 'user-1',
        preview: samplePreview,
      },
    });
    await methods.createArtifactAppWithVersion({
      createdBy: 'user-1',
      title: 'Denied',
      visibility: 'private',
      version: {
        artifactType: 'react',
        sourceSnapshot: 'denied',
        createdBy: 'user-1',
        preview: samplePreview,
      },
    });
    const getArtifactAppsByIds = jest.fn(methods.getArtifactAppsByIds);
    const filteringHandlers = createArtifactAppHandlers({
      ...methods,
      getArtifactAppsByIds,
      getResourcePermissionsMap: async ({ resourceIds }) =>
        new Map(
          resourceIds
            .filter((id) => id === allowed.app.id)
            .map((id) => [id, PermissionBits.VIEW | PermissionBits.SHARE]),
        ),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
    });

    const res = makeRes();
    await filteringHandlers.list(makeReq({ query: { scope: 'personal' } }), res);

    expect(getArtifactAppsByIds).toHaveBeenCalledWith([allowed.app.id]);
    expect((res.body as { apps: Array<{ title: string; permissionBits?: number }> }).apps).toEqual([
      expect.objectContaining({
        title: 'Allowed',
        preview: samplePreview,
        permissionBits: PermissionBits.VIEW | PermissionBits.SHARE,
      }),
    ]);
  });

  test('list separates personal and shared artifacts while all returns both', async () => {
    const personal = makeRes();
    await handlers.publish(makeReq({ body: { ...samplePublish, title: 'Personal' } }), personal);
    const shared = makeRes();
    await handlers.publish(
      makeReq({
        user: makeUser({ id: 'user-2', name: 'User Two', email: 'user-two@example.com' }),
        body: { ...samplePublish, title: 'Shared' },
      }),
      shared,
    );

    const personalApp = await methods.resolveArtifactAppId({
      artifactAppId: (personal.body as { app: { artifactAppId: string } }).app.artifactAppId,
    });
    const sharedApp = await methods.resolveArtifactAppId({
      artifactAppId: (shared.body as { app: { artifactAppId: string } }).app.artifactAppId,
    });
    accessibleIds = [personalApp as string, sharedApp as string];

    const personalResult = makeRes();
    await handlers.list(makeReq({ query: { scope: 'personal' } }), personalResult);
    const sharedResult = makeRes();
    await handlers.list(makeReq({ query: { scope: 'shared' } }), sharedResult);
    const allResult = makeRes();
    await handlers.list(makeReq({ query: { scope: 'all' } }), allResult);

    expect((personalResult.body as { apps: Array<{ title: string }> }).apps).toHaveLength(1);
    expect((personalResult.body as { apps: Array<{ title: string }> }).apps[0]?.title).toBe(
      'Personal',
    );
    expect((sharedResult.body as { apps: Array<{ title: string }> }).apps).toHaveLength(1);
    expect((sharedResult.body as { apps: Array<{ title: string }> }).apps[0]?.title).toBe('Shared');
    expect((allResult.body as { apps: unknown[] }).apps).toHaveLength(2);
  });

  test('list returns stable cursor pages and bounds ACL permission batches', async () => {
    const createdIds: string[] = [];
    for (let index = 0; index < 125; index++) {
      const { app } = await methods.createArtifactAppWithVersion({
        createdBy: 'user-1',
        title: `Artifact ${index}`,
        visibility: 'private',
        version: {
          artifactType: 'react',
          sourceSnapshot: `${samplePublish.artifact.content}-${index}`,
          createdBy: 'user-1',
        },
      });
      createdIds.push(app.id);
    }
    accessibleIds = createdIds;

    const paginatedHandlers = createArtifactAppHandlers({
      ...methods,
      getResourcePermissionsMap: async ({ resourceIds }) => {
        permissionBatchSizes.push(resourceIds.length);
        return new Map(resourceIds.map((id) => [id, PermissionBits.VIEW]));
      },
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
      getConfig: () => ({ scanBatchSize: 250, aclBatchSize: 100 }),
    });

    const first = makeRes();
    await paginatedHandlers.list(makeReq({ query: { scope: 'personal', limit: '10' } }), first);
    const firstPage = first.body as {
      apps: Array<{ id: string }>;
      has_more: boolean;
      after: string | null;
    };
    expect(firstPage.apps).toHaveLength(10);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.after).toEqual(expect.any(String));
    if (!firstPage.after) {
      throw new Error('Expected a cursor for the next artifact page');
    }

    const second = makeRes();
    await paginatedHandlers.list(
      makeReq({ query: { scope: 'personal', limit: '10', cursor: firstPage.after } }),
      second,
    );
    const secondPage = second.body as { apps: Array<{ id: string }> };
    expect(secondPage.apps).toHaveLength(10);
    expect(new Set([...firstPage.apps, ...secondPage.apps].map(({ id }) => id)).size).toBe(20);
    expect(Math.max(...permissionBatchSizes)).toBeLessThanOrEqual(100);
  });

  test('applies search before cursor pagination', async () => {
    const createdIds: string[] = [];
    for (let index = 0; index < 25; index++) {
      const { app } = await methods.createArtifactAppWithVersion({
        createdBy: 'user-1',
        title: index === 24 ? 'Needle Artifact' : `Ordinary Artifact ${index}`,
        visibility: 'private',
        version: {
          artifactType: 'react',
          sourceSnapshot: `${samplePublish.artifact.content}-${index}`,
          createdBy: 'user-1',
        },
      });
      createdIds.push(app.id);
    }
    accessibleIds = createdIds;

    const res = makeRes();
    await handlers.list(
      makeReq({ query: { scope: 'personal', limit: '10', search: 'needle' } }),
      res,
    );

    expect((res.body as { apps: Array<{ title: string }> }).apps).toEqual([
      expect.objectContaining({ title: 'Needle Artifact' }),
    ]);
  });

  test('redacts source conversation metadata from shared viewers', async () => {
    const created = makeRes();
    await handlers.sync(
      makeReq({
        user: makeUser({ id: 'user-2', email: 'user-two@example.com' }),
        body: syncBody,
      }),
      created,
    );
    const app = (created.body as { app: { id: string } }).app;
    accessibleIds = [app.id];

    const res = makeRes();
    await handlers.list(makeReq({ query: { scope: 'shared' } }), res);

    expect(
      (res.body as { apps: Array<{ sourceMetadata?: unknown }> }).apps[0]?.sourceMetadata,
    ).toBeUndefined();
  });

  test('lets resource managers discover apps without needing an explicit ACL grant', async () => {
    const created = makeRes();
    await handlers.publish(
      makeReq({
        user: makeUser({ id: 'user-2', name: 'User Two', email: 'user-two@example.com' }),
        body: { ...samplePublish, title: 'Owned by someone else' },
      }),
      created,
    );
    accessibleIds = [];

    const managerHandlers = createArtifactAppHandlers({
      ...methods,
      hasResourceManagementCapability: async () => true,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
    });

    const res = makeRes();
    await managerHandlers.list(makeReq({ query: { scope: 'shared' } }), res);

    expect((res.body as { apps: Array<{ title: string }> }).apps).toEqual([
      expect.objectContaining({ title: 'Owned by someone else' }),
    ]);
  });

  test('list rejects malformed cursors', async () => {
    const res = makeRes();
    await handlers.list(makeReq({ query: { cursor: 'not-a-cursor' } }), res);
    expect(res.statusCode).toBe(400);
  });

  test('get returns 404 for unknown id', async () => {
    const res = makeRes();
    await handlers.get(makeReq({ params: { id: 'app_missing' } as never }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('version lifecycle', () => {
  async function publishApp(): Promise<{ appId: string; versionId: string }> {
    const res = makeRes();
    await handlers.publish(makeReq({ body: samplePublish }), res);
    const body = res.body as {
      app: { artifactAppId: string };
      version: { artifactVersionId: string };
    };
    return { appId: body.app.artifactAppId, versionId: body.version.artifactVersionId };
  }

  test('release → activate updates the active version', async () => {
    const { appId, versionId } = await publishApp();
    const releaseRes = makeRes();
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      releaseRes,
    );
    expect((releaseRes.body as { publication: { state: string } }).publication.state).toBe(
      'released',
    );

    const activateRes = makeRes();
    await handlers.activateVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      activateRes,
    );
    expect(activateRes.statusCode).toBe(200);
    expect((activateRes.body as { activeVersionId: string }).activeVersionId).toBe(versionId);
  });

  test('activating an unreleased version returns 409', async () => {
    const { appId, versionId } = await publishApp();

    const res = makeRes();
    await handlers.activateVersion(makeReq({ params: { id: appId, versionId } as never }), res);
    expect(res.statusCode).toBe(409);
  });

  test('released version content is immutable across a re-release', async () => {
    const { appId, versionId } = await publishApp();

    const firstRelease = makeRes();
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      firstRelease,
    );
    const hashAfterFirst = (firstRelease.body as { integrity: { sourceHash: string } }).integrity
      .sourceHash;

    const secondRelease = makeRes();
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      secondRelease,
    );
    const hashAfterSecond = (secondRelease.body as { integrity: { sourceHash: string } }).integrity
      .sourceHash;

    expect(hashAfterSecond).toBe(hashAfterFirst);
  });
});

async function publishAppId(): Promise<string> {
  const res = makeRes();
  await handlers.publish(makeReq({ body: samplePublish }), res);
  return (res.body as { app: { artifactAppId: string } }).app.artifactAppId;
}

async function getActiveVersionId(appId: string): Promise<string> {
  const app = await methods.getArtifactAppByAppId({ artifactAppId: appId });
  if (!app?.activeVersionId) {
    throw new Error('Expected an active artifact version');
  }
  return app.activeVersionId;
}

let sourceSequence = 0;

async function createSyncedVersions(
  count: number,
): Promise<{ appId: string; versionIds: string[] }> {
  const sourceKey = `identifier:handler-test-${sourceSequence++}`;
  const versionIds: string[] = [];
  let appId = '';
  for (let index = 0; index < count; index++) {
    const res = makeRes();
    await handlers.sync(
      makeReq({
        body: {
          title: 'Synced artifact',
          artifact: {
            ...samplePublish.artifact,
            content: `${samplePublish.artifact.content}-${index}`,
          },
          source: {
            conversationId: `conversation-${sourceSequence}`,
            messageId: `message-${index}`,
            sourceKey,
          },
        },
      }),
      res,
    );
    const body = res.body as {
      app: { artifactAppId: string };
      version: { artifactVersionId: string };
    };
    appId = body.app.artifactAppId;
    versionIds.push(body.version.artifactVersionId);
  }
  return { appId, versionIds };
}

describe('update', () => {
  test('applies the patch and audits', async () => {
    const appId = await publishAppId();
    auditActions = [];

    const res = makeRes();
    await handlers.update(
      makeReq({ params: { id: appId } as never, body: { title: 'Renamed', category: 'charts' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { title: string; category: string };
    expect(body.title).toBe('Renamed');
    expect(body.category).toBe('charts');
    expect(auditActions).toContain('artifact_app.updated');
  });

  test('rejects an empty patch with 400', async () => {
    const appId = await publishAppId();
    const res = makeRes();
    await handlers.update(makeReq({ params: { id: appId } as never, body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  test('rejects an invalid field value with 400', async () => {
    const appId = await publishAppId();
    const res = makeRes();
    await handlers.update(makeReq({ params: { id: appId } as never, body: { title: '' } }), res);
    expect(res.statusCode).toBe(400);
  });

  /* Same §8.7 guarantee publish has: server-owned fields supplied by the
   * client must never be written through a patch. */
  test('ignores createdBy/tenantId supplied in the patch body', async () => {
    const appId = await publishAppId();
    const res = makeRes();
    await handlers.update(
      makeReq({
        params: { id: appId } as never,
        body: { title: 'Renamed', createdBy: 'attacker', tenantId: 'other-tenant' } as never,
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { createdBy: string; tenantId?: string };
    expect(body.createdBy).toBe('user-1');
    expect(body.tenantId).toBeUndefined();
  });

  test('returns 404 for an unknown app', async () => {
    const res = makeRes();
    await handlers.update(
      makeReq({ params: { id: 'app_missing' } as never, body: { title: 'Renamed' } }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('remove', () => {
  test('deletes the app with its versions and audits', async () => {
    const { appId } = await createSyncedVersions(2);
    auditActions = [];

    const res = makeRes();
    await handlers.remove(makeReq({ params: { id: appId } as never }), res);

    expect(res.statusCode).toBe(200);
    expect(auditActions).toContain('artifact_app.archived');
    expect(removedPermissionIds).toHaveLength(1);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: appId })).toMatchObject({
      status: 'archived',
      deletion: { finalizedAt: expect.any(Date) },
    });
    const versions = await methods.listArtifactVersions({ artifactAppId: appId, limit: 20 });
    expect(versions.versions).toHaveLength(0);

    const repeated = makeRes();
    await handlers.remove(makeReq({ params: { id: appId } as never }), repeated);
    expect(repeated.statusCode).toBe(200);
  });

  test('treats deleting an unknown app as an idempotent success', async () => {
    const res = makeRes();
    await handlers.remove(makeReq({ params: { id: 'app_missing' } as never }), res);
    expect(res.statusCode).toBe(200);
  });

  test('keeps deletion resumable when ACL cleanup fails', async () => {
    const { appId } = await createSyncedVersions(2);
    const removeAllPermissions = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary ACL failure'))
      .mockResolvedValue(undefined);
    const retryableHandlers = createArtifactAppHandlers({
      ...methods,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions,
      recordAuditEntry: async () => undefined,
    });

    const first = makeRes();
    await retryableHandlers.remove(makeReq({ params: { id: appId } as never }), first);
    expect(first.statusCode).toBe(500);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: appId })).toMatchObject({
      deletion: { requestedBy: 'user-1' },
    });

    const retry = makeRes();
    await retryableHandlers.remove(makeReq({ params: { id: appId } as never }), retry);
    expect(retry.statusCode).toBe(200);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: appId })).toMatchObject({
      status: 'archived',
      deletion: { finalizedAt: expect.any(Date) },
    });
    expect(removeAllPermissions).toHaveBeenCalledTimes(2);
  });

  test('does not restore after deletion when ACL cleanup has not finished', async () => {
    const created = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), created);
    const appId = (created.body as { app: { artifactAppId: string } }).app.artifactAppId;
    const removeAllPermissions = jest.fn().mockRejectedValue(new Error('temporary ACL failure'));
    const incompleteHandlers = createArtifactAppHandlers({
      ...methods,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async (params) => {
        grants.push({
          principalId: String(params.principalId),
          resourceType: params.resourceType,
          resourceId: String(params.resourceId),
          accessRoleId: params.accessRoleId,
        });
      },
      removeAllPermissions,
      recordAuditEntry: async () => undefined,
    });

    const removed = makeRes();
    await incompleteHandlers.remove(makeReq({ params: { id: appId } as never }), removed);
    expect(removed.statusCode).toBe(500);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: appId })).toMatchObject({
      deletion: { requestedBy: 'user-1' },
    });
    expect(
      (await methods.getArtifactAppByAppId({ artifactAppId: appId }))?.deletion?.finalizedAt,
    ).toBeUndefined();

    grants = [];
    const restored = makeRes();
    await incompleteHandlers.restore(makeReq({ body: syncBody }), restored);

    expect(restored.statusCode).toBe(404);
    expect(grants).toEqual([]);
    expect(await methods.getArtifactAppByAppId({ artifactAppId: appId })).toMatchObject({
      deletion: { requestedBy: 'user-1' },
    });
  });

  test('allows a resource administrator to delete without an artifact ACL', async () => {
    const { appId } = await createSyncedVersions(1);
    const administrativeHandlers = createArtifactAppHandlers({
      ...methods,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      hasResourceManagementCapability: async () => true,
      recordAuditEntry: async () => undefined,
    });

    const res = makeRes();
    await administrativeHandlers.remove(
      makeReq({
        params: { id: appId } as never,
        user: makeUser({ id: 'admin-user', email: 'admin@example.com' }),
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
  });

  test('returns 410 when a persistent queue retries a deleted source', async () => {
    const created = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), created);
    const appId = (created.body as { app: { artifactAppId: string } }).app.artifactAppId;
    await methods.prepareArtifactAppDeletion({ artifactAppId: appId }, 'user-1');
    await methods.finalizeArtifactAppDeletion({ artifactAppId: appId }, 'user-1');

    const res = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), res);

    expect(res.statusCode).toBe(410);
  });

  test('reports a deleted source and explicitly restores it with owner access', async () => {
    const created = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), created);
    const appId = (created.body as { app: { artifactAppId: string } }).app.artifactAppId;
    const removed = makeRes();
    await handlers.remove(makeReq({ params: { id: appId } as never }), removed);

    const lookup = makeRes();
    await handlers.getBySource(
      makeReq({
        query: {
          conversationId: syncBody.source.conversationId,
          sourceKey: syncBody.source.sourceKey,
        },
      }),
      lookup,
    );
    expect(lookup.statusCode).toBe(410);

    grants = [];
    const restored = makeRes();
    await handlers.restore(makeReq({ body: syncBody }), restored);

    expect(restored.statusCode).toBe(200);
    expect((restored.body as { app: { artifactAppId: string } }).app.artifactAppId).toBe(appId);
    expect(grants).toEqual([
      expect.objectContaining({
        principalId: 'user-1',
        accessRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
      }),
    ]);
  });

  test('returns 410 when the source conversation no longer exists', async () => {
    const missingSourceHandlers = createArtifactAppHandlers({
      ...methods,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
      sourceConversationExists: async () => false,
    });

    const res = makeRes();
    await missingSourceHandlers.sync(makeReq({ body: syncBody }), res);

    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({ error: 'Artifact was deleted and will not be synchronized' });
    expect(await mongoose.models.ArtifactApp.countDocuments()).toBe(0);
  });

  test('returns 410 when queued sync races with source conversation deletion', async () => {
    const ArtifactApp = mongoose.models.ArtifactApp;
    const created = makeRes();
    await handlers.sync(makeReq({ body: syncBody }), created);
    const appId = (created.body as { app: { artifactAppId: string } }).app.artifactAppId;

    let conversationExists = true;
    const racingHandlers = createArtifactAppHandlers({
      ...methods,
      getResourcePermissionsMap: async () => new Map(),
      grantPermission: async () => undefined,
      removeAllPermissions: async () => undefined,
      recordAuditEntry: async () => undefined,
      sourceConversationExists: async () => conversationExists,
    });

    const queued = makeRes();
    const [syncResult] = await Promise.allSettled([
      racingHandlers.sync(
        makeReq({
          body: {
            ...syncBody,
            artifact: {
              ...syncBody.artifact,
              content: 'export default () => <div>later</div>;',
            },
          },
        }),
        queued,
      ),
      (async () => {
        conversationExists = false;
        await ArtifactApp.updateMany({ artifactAppId: appId }, [
          {
            $set: {
              'sourceMetadata.detachedConversationId': '$sourceMetadata.conversationId',
            },
          },
          { $unset: 'sourceMetadata.conversationId' },
        ]);
      })(),
    ]);

    expect(syncResult.status).toBe('fulfilled');
    if (queued.statusCode !== 0) {
      expect([200, 201, 410]).toContain(queued.statusCode);
    }

    expect(await ArtifactApp.countDocuments()).toBe(1);
    const persisted = await ArtifactApp.findOne({ artifactAppId: appId }).lean<{
      sourceMetadata?: { conversationId?: string; detachedConversationId?: string };
    }>();
    expect(persisted?.sourceMetadata?.conversationId).toBeUndefined();
    expect(persisted?.sourceMetadata?.detachedConversationId).toBe(syncBody.source.conversationId);

    conversationExists = false;
    const retry = makeRes();
    await racingHandlers.sync(makeReq({ body: syncBody }), retry);
    expect(retry.statusCode).toBe(410);
    expect(await ArtifactApp.countDocuments()).toBe(1);
  });
});

describe('version reads', () => {
  test('listVersions returns paginated metadata without snapshots', async () => {
    const { appId } = await createSyncedVersions(3);

    const res = makeRes();
    await handlers.listVersions(
      makeReq({ params: { id: appId } as never, query: { limit: '2' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      versions: Array<{ versionNumber: number; sourceSnapshot?: string }>;
      has_more: boolean;
      after: string | null;
    };
    expect(body.versions.map((v) => v.versionNumber)).toEqual([3, 2]);
    expect(body.versions.every((version) => version.sourceSnapshot == null)).toBe(true);
    expect(body.has_more).toBe(true);
    expect(body.after).toEqual(expect.any(String));
    if (!body.after) {
      throw new Error('Expected a cursor for the second version page');
    }

    const next = makeRes();
    await handlers.listVersions(
      makeReq({ params: { id: appId } as never, query: { limit: '2', cursor: body.after } }),
      next,
    );
    expect((next.body as { versions: Array<{ versionNumber: number }> }).versions).toEqual([
      expect.objectContaining({ versionNumber: 1 }),
    ]);
  });

  test('listVersions returns an empty list for an unknown app', async () => {
    const res = makeRes();
    await handlers.listVersions(makeReq({ params: { id: 'app_missing' } as never }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { versions: unknown[] }).versions).toHaveLength(0);
  });

  test('listVersions hides withdrawn versions from a plain viewer but keeps them for the owner', async () => {
    const { appId } = await createSyncedVersions(2);
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId: await getActiveVersionId(appId) } as never }),
      makeRes(),
    );
    await handlers.withdrawVersion(
      makeReq({ params: { id: appId, versionId: await getActiveVersionId(appId) } as never }),
      makeRes(),
    );

    const app = await methods.getArtifactAppByAppId({ artifactAppId: appId });
    accessibleIds = [app?.id ?? ''];
    const viewer = makeUser({ id: 'viewer-1' });

    const viewerRes = makeRes();
    await handlers.listVersions(
      makeReq({ params: { id: appId } as never, user: viewer }),
      viewerRes,
    );
    expect(
      (viewerRes.body as { versions: Array<{ versionNumber: number }> }).versions.map(
        (v) => v.versionNumber,
      ),
    ).toEqual([1]);

    const ownerRes = makeRes();
    await handlers.listVersions(makeReq({ params: { id: appId } as never }), ownerRes);
    expect(
      (ownerRes.body as { versions: Array<{ versionNumber: number }> }).versions.map(
        (v) => v.versionNumber,
      ),
    ).toEqual([2, 1]);
  });

  test('getVersion returns the requested version', async () => {
    const appId = await publishAppId();
    const versionId = await getActiveVersionId(appId);

    const res = makeRes();
    await handlers.getVersion(makeReq({ params: { id: appId, versionId } as never }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { artifactVersionId: string }).artifactVersionId).toBe(versionId);
  });

  test('getVersion returns 404 for an unknown version', async () => {
    const appId = await publishAppId();
    const res = makeRes();
    await handlers.getVersion(
      makeReq({ params: { id: appId, versionId: 'ver_missing' } as never }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  /* Version ids must not be readable across apps: passing app B's id with
   * app A's version must miss, not leak A's snapshot. */
  test('getVersion does not resolve a version belonging to another app', async () => {
    const appA = await publishAppId();
    const versionA = await getActiveVersionId(appA);
    const appB = await publishAppId();

    const res = makeRes();
    await handlers.getVersion(makeReq({ params: { id: appB, versionId: versionA } as never }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('withdrawVersion', () => {
  test('withdraws a released version and audits', async () => {
    const appId = await publishAppId();
    const versionId = await getActiveVersionId(appId);
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      makeRes(),
    );
    auditActions = [];

    const res = makeRes();
    await handlers.withdrawVersion(makeReq({ params: { id: appId, versionId } as never }), res);

    expect(res.statusCode).toBe(200);
    expect(auditActions).toContain('artifact_version.withdrawn');
  });

  test('returns 404 for an unknown version', async () => {
    const appId = await publishAppId();
    const res = makeRes();
    await handlers.withdrawVersion(
      makeReq({ params: { id: appId, versionId: 'ver_missing' } as never }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  test('a withdrawn version is no longer reachable by a plain viewer', async () => {
    const appId = await publishAppId();
    const versionId = await getActiveVersionId(appId);
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      makeRes(),
    );
    await handlers.withdrawVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      makeRes(),
    );

    const app = await methods.getArtifactAppByAppId({ artifactAppId: appId });
    accessibleIds = [app?.id ?? ''];
    const viewer = makeUser({ id: 'viewer-1' });

    const res = makeRes();
    await handlers.getVersion(
      makeReq({ params: { id: appId, versionId } as never, user: viewer }),
      res,
    );
    expect(res.statusCode).toBe(404);
  });

  test('a withdrawn version stays reachable by the app owner for re-release', async () => {
    const appId = await publishAppId();
    const versionId = await getActiveVersionId(appId);
    await handlers.releaseVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      makeRes(),
    );
    await handlers.withdrawVersion(
      makeReq({ params: { id: appId, versionId } as never }),
      makeRes(),
    );

    const res = makeRes();
    await handlers.getVersion(makeReq({ params: { id: appId, versionId } as never }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { artifactVersionId: string }).artifactVersionId).toBe(versionId);
  });
});
