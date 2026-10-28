jest.mock('~/admin/secrets', () => ({
  decryptConfigSecret: jest.fn((value: string) =>
    value === 'v3:test:tenant-a-secret' ? 'tenant-a-secret' : undefined,
  ),
}));

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import {
  logger,
  createModels,
  createMethods,
  tenantStorage,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import type {
  PromptRecord,
  PromptDatabase,
  PromptGroupRecord,
  CreatePromptGroupInput,
  LangfuseResolvedPrompt,
} from './types';
import type { PromptServiceDependencies, PromptService } from './service';
import { createPromptServiceFromAdapters, createPromptService } from './service';
import { createNativePromptAdapter } from './native';
import { PromptStoreError } from './errors';
import { createPromptStore } from './store';
import { CONSTANTS } from '~/mcp/enum';

const filters: FiltersConfig = {
  prompts: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
};

let mongo: MongoMemoryServer;
let db: PromptDatabase;
let grantPermission: jest.MockedFunction<PromptServiceDependencies['grantPermission']>;
let getAppConfig: jest.MockedFunction<PromptServiceDependencies['getAppConfig']>;
let service: PromptService;
let group: PromptGroupRecord;
let production: PromptRecord;
const author = new Types.ObjectId().toString();
const missingId = () => new Types.ObjectId().toString();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await mongoose.models.PromptGroup.syncIndexes();
});

beforeEach(async () => {
  grantPermission = jest.fn().mockResolvedValue(undefined);
  getAppConfig = jest.fn();
  service = createPromptService({ db, grantPermission, getAppConfig });
  const created = await service.createPromptGroup({
    prompt: { prompt: 'Production prompt', type: 'text' },
    group: { name: 'Service group' },
    author,
    authorName: 'Author',
  });
  if (!created.ok || created.value.prompt == null) {
    throw new Error('Test group was not created');
  }
  production = created.value.prompt;
  group = (await createPromptStore(db).getPromptGroup(production.groupId)) as PromptGroupRecord;
  grantPermission.mockClear();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.models.Prompt.deleteMany({});
  await mongoose.models.PromptGroup.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function addRevision(prompt: string): Promise<PromptRecord> {
  const result = await service.savePrompt({
    groupId: group._id,
    prompt: { prompt, type: 'text' },
    author,
  });
  if (!result.ok) {
    throw new Error('Test revision was not saved');
  }
  return result.value.prompt;
}

describe('createPromptService', () => {
  describe('resolvePrompt', () => {
    it('returns the Production revision', async () => {
      await expect(
        service.resolvePrompt({ groupId: group._id, selection: { type: 'production' }, filters }),
      ).resolves.toEqual({
        ok: true,
        value: {
          source: 'native',
          groupId: group._id,
          promptId: production._id,
          prompt: 'Production prompt',
          type: 'text',
        },
      });
    });

    it('rejects blocked selected content', async () => {
      const blocked = await addRevision('Contains PRIVATE-VALUE');

      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'exact', promptId: blocked._id },
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
    });

    it('returns an unavailable result for a missing selection', async () => {
      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'exact', promptId: missingId() },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unavailable_selection', reason: 'revision' },
      });
      await expect(
        service.resolvePrompt({ groupId: missingId(), selection: { type: 'production' } }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unavailable_selection', reason: 'production' },
      });
    });

    it('reads the group once when none is loaded', async () => {
      const read = jest.spyOn(db, 'getPromptGroup');

      await expect(
        service.resolvePrompt({ groupId: group._id, selection: { type: 'production' } }),
      ).resolves.toMatchObject({ ok: true, value: { promptId: production._id } });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('reads when the loaded group differs', async () => {
      const read = jest.spyOn(db, 'getPromptGroup');
      const otherGroup = { ...group, _id: missingId() };

      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'production' },
          loadedGroup: otherGroup,
        }),
      ).resolves.toMatchObject({ ok: true, value: { promptId: production._id } });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('does not prefetch a revision for a production selection', async () => {
      const revisionRead = jest.spyOn(db, 'getPrompt');

      await expect(
        service.resolvePrompt({ groupId: group._id, selection: { type: 'production' } }),
      ).resolves.toMatchObject({ ok: true, value: { promptId: production._id } });
      expect(revisionRead).not.toHaveBeenCalled();
    });

    it('reads a missing exact revision exactly once', async () => {
      const revisionRead = jest.spyOn(db, 'getPrompt');

      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'exact', promptId: missingId() },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unavailable_selection', reason: 'revision' },
      });
      expect(revisionRead).toHaveBeenCalledTimes(1);
    });

    it('resolves an exact revision for an unloaded group', async () => {
      const groupRead = jest.spyOn(db, 'getPromptGroup');

      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'exact', promptId: production._id },
        }),
      ).resolves.toEqual({
        ok: true,
        value: {
          source: 'native',
          groupId: group._id,
          promptId: production._id,
          prompt: 'Production prompt',
          type: 'text',
        },
      });
      expect(groupRead).toHaveBeenCalledTimes(1);
    });

    it('throws a PromptStoreError when the group read fails', async () => {
      const store = createPromptStore(db);
      jest.spyOn(store, 'getPromptGroup').mockRejectedValue(new Error('group read failed'));
      const routed = createPromptServiceFromAdapters({
        store,
        sources: {
          native: createNativePromptAdapter(store),
          langfuse: { resolvePrompt: jest.fn() },
        },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      const rejection: unknown = await routed
        .resolvePrompt({
          groupId: group._id,
          selection: { type: 'exact', promptId: production._id },
        })
        .catch((caught: unknown) => caught);

      expect(rejection).toBeInstanceOf(PromptStoreError);
      expect((rejection as PromptStoreError).stage).toBe('read');
    });
  });

  describe('getListPromptGroupsByAccess', () => {
    it('projects catalog content and marks public groups', async () => {
      const stored = await service.createPromptGroup({
        prompt: { prompt: 'PRIVATE-PROMPT', type: 'text' },
        group: { name: 'Stored before the filter' },
        author,
      });
      const blockedId = stored.ok ? stored.value.prompt?.groupId : undefined;
      expect(blockedId).toEqual(expect.any(String));

      const result = await service.getListPromptGroupsByAccess({
        accessibleIds: [group._id, blockedId as string],
        publiclyAccessibleIds: [group._id],
        ownedPromptGroupIds: [group._id],
        limit: 10,
        after: null,
        forReuse: true,
        filters,
      });

      expect(result).toEqual({
        data: [expect.objectContaining({ _id: group._id, isPublic: true })],
        has_more: false,
        after: null,
      });
    });

    it('filters by name without regular expression input', async () => {
      const input = {
        accessibleIds: [group._id],
        publiclyAccessibleIds: [],
        ownedPromptGroupIds: [group._id],
        limit: null,
        after: null,
        forReuse: false,
      };

      await expect(
        service.getListPromptGroupsByAccess({ ...input, name: 'service' }),
      ).resolves.toMatchObject({ data: [{ _id: group._id }] });
      await expect(
        service.getListPromptGroupsByAccess({ ...input, name: '.*' }),
      ).resolves.toMatchObject({ data: [] });
    });
  });

  describe('getPrompts', () => {
    it('redacts blocked revision history and keeps structural fields', async () => {
      const blocked = await addRevision('Contains PRIVATE-VALUE');

      const history = await service.getPrompts({ groupId: group._id, filters });

      expect(history).toHaveLength(2);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _id: blocked._id, prompt: '', contentFilterBlocked: true }),
          expect.objectContaining({ _id: production._id, prompt: 'Production prompt' }),
        ]),
      );
    });

    it('tags a read failure with the read stage', async () => {
      jest.spyOn(db, 'getPrompts').mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.getPrompts({ groupId: group._id })).rejects.toMatchObject({
        name: 'PromptStoreError',
        stage: 'read',
      });
    });
  });

  describe('createPromptGroup', () => {
    it('rejects a missing prompt or group name before writing', async () => {
      const create = jest.spyOn(db, 'createPromptGroup');

      await expect(
        service.createPromptGroup({
          prompt: { prompt: 'Safe', type: 'text' },
          group: { name: '' },
          author,
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'invalid_input', message: 'Prompt and group name are required' },
      });
      expect(create).not.toHaveBeenCalled();
    });

    it.each([
      [{ prompt: 'Text' }, 'Prompt type must be "text" or "chat"'],
      [{ prompt: 'Text', type: 'image' }, 'Prompt type must be "text" or "chat"'],
      [{ prompt: '  ', type: 'text' }, 'Prompt text is required and must be a non-empty string'],
    ])('rejects the first revision %j before writing', async (prompt, message) => {
      const create = jest.spyOn(db, 'createPromptGroup');

      await expect(
        service.createPromptGroup({
          prompt: prompt as CreatePromptGroupInput['prompt'],
          group: { name: 'New group' },
          author,
        }),
      ).resolves.toEqual({ ok: false, error: { type: 'invalid_input', message } });
      expect(create).not.toHaveBeenCalled();
    });

    it('stores only the prompt fields of the first revision', async () => {
      const otherGroupId = missingId();
      const result = await service.createPromptGroup({
        prompt: { prompt: 'New prompt', type: 'chat', groupId: otherGroupId },
        group: { name: 'New group' },
        author,
      });

      expect(result.ok).toBe(true);
      const prompt = result.ok ? result.value.prompt : null;
      expect(prompt).toMatchObject({ prompt: 'New prompt', type: 'chat', author });
      expect(prompt?.groupId).not.toBe(otherGroupId);
    });

    it('drops client-supplied source identity fields before writing the group', async () => {
      const create = jest.spyOn(db, 'createPromptGroup');
      const importedGroup = {
        name: 'Imported group',
        source: 'langfuse',
        sourcePromptName: 'langfuse-prompt',
        sourceProjectId: 'project-1',
        sourceDestination: 'destination-1',
      };

      const result = await service.createPromptGroup({
        prompt: { prompt: 'New prompt', type: 'text' },
        group: importedGroup,
        author,
      });

      expect(result.ok).toBe(true);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ group: { name: 'Imported group' } }),
      );

      const groupId = result.ok ? result.value.prompt?.groupId : undefined;
      // Read the raw document directly: toPromptGroupRecord defaults a missing `source` to
      // 'native', so asserting through it would prove nothing about what was actually stored.
      const stored = (await mongoose.models.PromptGroup.findById(groupId).lean()) as {
        source?: string;
      } | null;
      expect(stored?.source).toBe('native');
      expect(stored).not.toHaveProperty('sourcePromptName');
      expect(stored).not.toHaveProperty('sourceProjectId');
      expect(stored).not.toHaveProperty('sourceDestination');
    });

    it('rejects protected content before writing', async () => {
      const create = jest.spyOn(db, 'createPromptGroup');

      await expect(
        service.createPromptGroup({
          prompt: { prompt: 'Safe', type: 'text' },
          group: { name: 'PRIVATE-NAME' },
          author,
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
      expect(create).not.toHaveBeenCalled();
    });

    it('grants the creator ownership of the new group', async () => {
      const result = await service.createPromptGroup({
        prompt: { prompt: 'New prompt', type: 'text' },
        group: { name: 'New group' },
        author,
      });

      expect(result.ok).toBe(true);
      const groupId = result.ok ? result.value.prompt?.groupId : undefined;
      expect(grantPermission).toHaveBeenCalledWith({
        principalType: PrincipalType.USER,
        principalId: author,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: author,
      });
    });

    it('logs a failed ownership grant and still returns the new group', async () => {
      grantPermission.mockRejectedValueOnce(new Error('acl unavailable'));
      const logError = jest.spyOn(logger, 'error').mockImplementation(() => logger);

      await expect(
        service.createPromptGroup({
          prompt: { prompt: 'New prompt', type: 'text' },
          group: { name: 'New group' },
          author,
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('[createPromptGroup] Failed to grant owner permissions'),
        expect.any(Error),
      );
    });
  });

  describe('importSourceGroup', () => {
    const identity = {
      sourceDestination: 'us',
      sourceProjectId: 'project-1',
      sourcePromptName: 'synced-prompt',
    };

    it('creates a pointer group with source fields and no productionId, and grants a PUBLIC viewer as the system user', async () => {
      const outcome = await service.importSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(outcome).toBe('created');
      const found = await db.findLangfusePromptGroup(identity);
      expect(found).not.toBeNull();
      const stored = (await mongoose.models.PromptGroup.findById(found?._id).lean()) as {
        productionId?: unknown;
      } | null;
      expect(stored).toMatchObject({
        source: 'langfuse',
        ...identity,
        name: 'Synced prompt',
        author: new Types.ObjectId(author),
        authorName: 'Langfuse Sync',
      });
      expect(stored).not.toHaveProperty('productionId');
      expect(grantPermission).toHaveBeenCalledWith({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: found?._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: CONSTANTS.SYSTEM_USER_ID,
      });
    });

    it('leaves a second import for the same identity unchanged, without granting again', async () => {
      await service.importSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });
      grantPermission.mockClear();

      const outcome = await service.importSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(outcome).toBe('unchanged');
      expect(grantPermission).not.toHaveBeenCalled();
    });

    it('treats a race where findSourceGroup misses a row that already exists as unchanged, without granting', async () => {
      const store = createPromptStore(db);
      const created = await store.createSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });
      if (!created.ok) {
        throw new Error('Setup insert failed');
      }
      jest.spyOn(store, 'findSourceGroup').mockResolvedValue(null);
      const grantPublicViewer = jest.fn();
      const routed = createPromptServiceFromAdapters({
        store,
        sources: {
          native: createNativePromptAdapter(store),
          langfuse: { resolvePrompt: jest.fn() },
        },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer,
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      const outcome = await routed.importSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(outcome).toBe('unchanged');
      expect(grantPublicViewer).not.toHaveBeenCalled();
    });

    it('skips an empty name and warns with safe metadata only, saving nothing', async () => {
      const logWarn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      const outcome = await service.importSourceGroup({
        identity,
        name: '',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(outcome).toBe('skipped');
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith(
        '[importSourceGroup] Skipped a source group that failed validation',
        { name: '', code: 'invalid', type: 'Error' },
      );
      await expect(db.findLangfusePromptGroup(identity)).resolves.toBeNull();
    });

    it('deletes the newly created group and rethrows when the grant fails', async () => {
      const store = createPromptStore(db);
      const grantPublicViewer = jest.fn().mockRejectedValue(new Error('grant failed'));
      const logError = jest.fn();
      const routed = createPromptServiceFromAdapters({
        store,
        sources: {
          native: createNativePromptAdapter(store),
          langfuse: { resolvePrompt: jest.fn() },
        },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer,
        logger: { warn: jest.fn(), error: logError },
      });

      await expect(
        routed.importSourceGroup({
          identity,
          name: 'Synced prompt',
          author,
          authorName: 'Langfuse Sync',
        }),
      ).rejects.toThrow('grant failed');

      await expect(store.findSourceGroup(identity)).resolves.toBeNull();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('[importSourceGroup]'), {
        groupId: expect.any(String),
        type: 'Error',
      });
    });

    it('still rethrows the grant error and logs two errors when the rollback delete also fails', async () => {
      const store = createPromptStore(db);
      jest.spyOn(store, 'deletePromptGroup').mockRejectedValue(new Error('delete failed'));
      const grantPublicViewer = jest.fn().mockRejectedValue(new Error('grant failed'));
      const logError = jest.fn();
      const routed = createPromptServiceFromAdapters({
        store,
        sources: {
          native: createNativePromptAdapter(store),
          langfuse: { resolvePrompt: jest.fn() },
        },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer,
        logger: { warn: jest.fn(), error: logError },
      });

      await expect(
        routed.importSourceGroup({
          identity,
          name: 'Synced prompt',
          author,
          authorName: 'Langfuse Sync',
        }),
      ).rejects.toThrow('grant failed');

      expect(logError).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenNthCalledWith(1, expect.stringContaining('[importSourceGroup]'), {
        groupId: expect.any(String),
        type: 'Error',
      });
      expect(logError).toHaveBeenNthCalledWith(2, expect.stringContaining('[importSourceGroup]'), {
        groupId: expect.any(String),
        type: 'Error',
      });
    });
  });

  describe('savePrompt', () => {
    it.each([
      [undefined, 'Prompt is required'],
      [{ prompt: '  ', type: 'text' }, 'Prompt text is required and must be a non-empty string'],
      [{ type: 'text' }, 'Prompt text is required and must be a non-empty string'],
      [{ prompt: 'Text', type: 'image' }, 'Prompt type must be "text" or "chat"'],
    ])('rejects the payload %j', async (prompt, message) => {
      const save = jest.spyOn(db, 'savePrompt');

      await expect(service.savePrompt({ groupId: group._id, prompt, author })).resolves.toEqual({
        ok: false,
        error: { type: 'invalid_input', message },
      });
      expect(save).not.toHaveBeenCalled();
    });

    it('saves only the prompt fields into the route group without promoting', async () => {
      const otherGroupId = missingId();
      const result = await service.savePrompt({
        groupId: group._id,
        prompt: { prompt: 'Draft', type: 'chat', groupId: otherGroupId, author: missingId() },
        author,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { prompt: { groupId: group._id, author, prompt: 'Draft', type: 'chat' } },
      });
      await expect(db.getPromptGroup({ _id: group._id })).resolves.toMatchObject({
        productionId: new Types.ObjectId(production._id),
      });
    });

    it('rejects protected content before writing', async () => {
      const save = jest.spyOn(db, 'savePrompt');

      await expect(
        service.savePrompt({
          groupId: group._id,
          prompt: { prompt: 'PRIVATE-VALUE', type: 'text' },
          author,
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
      expect(save).not.toHaveBeenCalled();
    });

    it('tags a write failure with the write stage', async () => {
      jest.spyOn(db, 'savePrompt').mockRejectedValueOnce(new Error('database unavailable'));

      const error = await service
        .savePrompt({ groupId: group._id, prompt: { prompt: 'Text', type: 'text' }, author })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PromptStoreError);
      expect(error).toMatchObject({ stage: 'write', cause: expect.any(Error) });
    });
  });

  describe('getPromptGroup', () => {
    it('reuses a matching loaded group and redacts a blocked Production revision', async () => {
      const read = jest.spyOn(db, 'getPromptGroup');

      const result = await service.getPromptGroup({
        groupId: group._id,
        loadedGroup: {
          ...group,
          productionPrompt: { ...production, prompt: 'PRIVATE-PROMPT' },
        },
        filters,
      });

      expect(read).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: true,
        value: { productionPrompt: { prompt: '', contentFilterBlocked: true } },
      });
    });

    it('rejects blocked group metadata', async () => {
      await expect(
        service.getPromptGroup({
          groupId: group._id,
          loadedGroup: { ...group, name: 'PRIVATE-GROUP' },
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
    });

    it('returns null for an absent group and reads when the loaded group differs', async () => {
      const read = jest.spyOn(db, 'getPromptGroup');

      await expect(
        service.getPromptGroup({ groupId: missingId(), loadedGroup: group }),
      ).resolves.toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('tags a read failure with the read stage', async () => {
      jest.spyOn(db, 'getPromptGroup').mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.getPromptGroup({ groupId: group._id })).rejects.toMatchObject({
        stage: 'read',
      });
    });
  });

  describe('getPrompt', () => {
    it('reuses a matching loaded revision and rejects blocked content', async () => {
      const read = jest.spyOn(db, 'getPrompt');

      await expect(
        service.getPrompt({
          promptId: production._id,
          loadedRevision: { ...production, prompt: 'PRIVATE-PROMPT' },
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
      expect(read).not.toHaveBeenCalled();
    });

    it('returns the stored revision and null for an absent revision', async () => {
      await expect(service.getPrompt({ promptId: production._id })).resolves.toMatchObject({
        ok: true,
        value: production,
      });
      await expect(service.getPrompt({ promptId: missingId() })).resolves.toBeNull();
    });
  });

  describe('updatePromptGroup', () => {
    it('returns the schema details for an invalid update', async () => {
      const result = await service.updatePromptGroup({
        groupId: group._id,
        updates: { author: missingId() },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          type: 'invalid_input',
          message: 'Invalid request body',
          details: [expect.any(Object)],
        },
      });
    });

    it('rejects protected metadata before writing', async () => {
      const update = jest.spyOn(db, 'updatePromptGroup');

      await expect(
        service.updatePromptGroup({
          groupId: group._id,
          updates: { name: 'PRIVATE-NAME' },
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
      expect(update).not.toHaveBeenCalled();
    });

    it('updates the group and tags a missing group as a write failure', async () => {
      await expect(
        service.updatePromptGroup({ groupId: group._id, updates: { name: 'Renamed' } }),
      ).resolves.toMatchObject({ ok: true, value: { _id: group._id, name: 'Renamed' } });
      await expect(
        service.updatePromptGroup({ groupId: missingId(), updates: { name: 'Renamed' } }),
      ).rejects.toMatchObject({ stage: 'write' });
    });
  });

  describe('makePromptProduction', () => {
    it('promotes a loaded revision without another read', async () => {
      const draft = await addRevision('Draft');
      const read = jest.spyOn(db, 'getPrompt');

      await expect(
        service.makePromptProduction({ promptId: draft._id, loadedRevision: draft }),
      ).resolves.toEqual({
        ok: true,
        value: { message: 'Prompt production made successfully' },
        groupId: draft.groupId,
      });
      expect(read).not.toHaveBeenCalled();
    });

    it('reads the revision and surfaces its group id when no revision was loaded', async () => {
      const draft = await addRevision('Draft');
      const read = jest.spyOn(db, 'getPrompt');

      await expect(service.makePromptProduction({ promptId: draft._id })).resolves.toEqual({
        ok: true,
        value: { message: 'Prompt production made successfully' },
        groupId: draft.groupId,
      });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('does not promote blocked content', async () => {
      const blocked = await addRevision('Contains PRIVATE-VALUE');
      const promote = jest.spyOn(db, 'makePromptProduction');

      await expect(
        service.makePromptProduction({ promptId: blocked._id, filters }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
      expect(promote).not.toHaveBeenCalled();
    });

    it('does not promote when the preliminary read fails', async () => {
      const draft = await addRevision('Draft');
      jest.spyOn(db, 'getPrompt').mockRejectedValueOnce(new Error('database unavailable'));
      const promote = jest.spyOn(db, 'makePromptProduction');

      await expect(service.makePromptProduction({ promptId: draft._id })).rejects.toMatchObject({
        stage: 'read',
      });
      expect(promote).not.toHaveBeenCalled();
    });

    it('tags a missing revision as a write failure', async () => {
      await expect(service.makePromptProduction({ promptId: missingId() })).rejects.toMatchObject({
        stage: 'write',
        cause: { message: 'Prompt not found' },
      });
    });

    it('promotes through the source and omits the group id when no revision is found', async () => {
      const promptId = missingId();
      jest.spyOn(db, 'getPrompt').mockResolvedValueOnce(null);
      const promote = jest
        .spyOn(db, 'makePromptProduction')
        .mockResolvedValueOnce({ message: 'Prompt production made successfully' });

      await expect(service.makePromptProduction({ promptId })).resolves.toEqual({
        ok: true,
        value: { message: 'Prompt production made successfully' },
      });
      expect(promote).toHaveBeenCalledWith(promptId);
    });
  });

  describe('usage and deletion', () => {
    it('records usage and deletes groups', async () => {
      await expect(service.incrementPromptGroupUsage(group._id)).resolves.toEqual({
        numberOfGenerations: 1,
      });
      await expect(service.deletePromptGroup({ groupId: group._id })).resolves.toEqual({
        ok: true,
        value: { message: 'Prompt group deleted successfully' },
      });
    });

    it('deletes a native revision', async () => {
      const draft = await addRevision('Draft');

      await expect(
        service.deletePrompt({ groupId: group._id, promptId: draft._id }),
      ).resolves.toEqual({ ok: true, value: { prompt: 'Prompt deleted successfully' } });
      await expect(db.getPrompt({ _id: draft._id })).resolves.toBeNull();
    });

    it('collects revision ids after the guard when requested', async () => {
      const draft = await addRevision('Draft');

      const result = await service.deletePromptGroup({
        groupId: group._id,
        collectPromptIds: true,
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toMatchObject({
        message: 'Prompt group deleted successfully',
        promptIds: expect.arrayContaining([production._id, draft._id]),
      });
      await expect(db.getPromptGroup({ _id: group._id })).resolves.toBeNull();
    });

    it('does not collect revision ids when not requested', async () => {
      await expect(service.deletePromptGroup({ groupId: group._id })).resolves.toEqual({
        ok: true,
        value: { message: 'Prompt group deleted successfully' },
      });
    });

    it('deletes the group with no revision ids and logs when reading revisions fails', async () => {
      const logError = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      jest.spyOn(db, 'getPrompts').mockRejectedValueOnce(new Error('database unavailable'));

      const result = await service.deletePromptGroup({
        groupId: group._id,
        collectPromptIds: true,
      });

      expect(result).toEqual({
        ok: true,
        value: { message: 'Prompt group deleted successfully', promptIds: [] },
      });
      await expect(db.getPromptGroup({ _id: group._id })).resolves.toBeNull();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('[deletePromptGroup] Failed to read revisions'),
        { groupId: group._id, type: 'Error' },
      );
    });
  });

  describe('a source without mutations', () => {
    it('returns unsupported for each mutation before validating or writing', async () => {
      const {
        savePrompt: _save,
        makePromptProduction: _promote,
        deletePrompt: _delete,
        ...store
      } = createPromptStore(db);
      const readOnly = createPromptServiceFromAdapters({
        store,
        sources: {
          native: createNativePromptAdapter(store),
          langfuse: { resolvePrompt: jest.fn() },
        },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const readPrompt = jest.spyOn(db, 'getPrompt');
      const readGroup = jest.spyOn(db, 'getPromptGroup');
      const savePrompt = jest.spyOn(db, 'savePrompt');
      const makePromptProduction = jest.spyOn(db, 'makePromptProduction');
      const deletePrompt = jest.spyOn(db, 'deletePrompt');

      await expect(
        readOnly.savePrompt({ groupId: group._id, prompt: undefined, author }),
      ).resolves.toEqual({ ok: false, error: { type: 'unsupported', operation: 'savePrompt' } });
      await expect(readOnly.makePromptProduction({ promptId: production._id })).resolves.toEqual({
        ok: false,
        error: { type: 'unsupported', operation: 'makePromptProduction' },
      });
      await expect(
        readOnly.deletePrompt({ groupId: group._id, promptId: production._id }),
      ).resolves.toEqual({ ok: false, error: { type: 'unsupported', operation: 'deletePrompt' } });
      await expect(readOnly.getPrompts({ groupId: group._id })).resolves.toHaveLength(1);

      expect(readPrompt).not.toHaveBeenCalled();
      expect(readGroup).not.toHaveBeenCalled();
      expect(savePrompt).not.toHaveBeenCalled();
      expect(makePromptProduction).not.toHaveBeenCalled();
      expect(deletePrompt).not.toHaveBeenCalled();
    });
  });

  describe('routing by source', () => {
    function makeLangfuseGroup(overrides: Partial<PromptGroupRecord> = {}): PromptGroupRecord {
      return {
        _id: missingId(),
        name: 'Langfuse group',
        author,
        authorName: 'Author',
        source: 'langfuse',
        sourcePromptName: 'langfuse-prompt',
        ...overrides,
      };
    }

    function makeLangfuseResolved(
      overrides: Partial<LangfuseResolvedPrompt> & { readonly groupId: string },
    ): LangfuseResolvedPrompt {
      return {
        source: 'langfuse',
        prompt: 'Langfuse prompt text',
        type: 'text',
        version: 3,
        labels: ['production'],
        sourceUrl: 'https://cloud.langfuse.test/project/project-1/prompts/langfuse-prompt',
        ...overrides,
      };
    }

    /** A real stored group and revision, unlike `makeLangfuseGroup`'s in-memory record:
     *  this is what `readGroup` falls back to reading from the database when no
     *  `loadedGroup` matches, which includes the `MANAGE_PROMPTS` bypass path where
     *  `req.resourceAccess` is unset. */
    async function createPersistedLangfuseGroupWithPrompt() {
      const persistedGroup = await mongoose.models.PromptGroup.create({
        name: 'Persisted Langfuse group',
        author,
        authorName: 'Author',
        source: 'langfuse',
        sourcePromptName: 'langfuse-prompt',
        sourceProjectId: 'project-1',
        sourceDestination: 'destination-1',
      });
      const promptDoc = await mongoose.models.Prompt.create({
        groupId: persistedGroup._id,
        author,
        prompt: 'Synced from Langfuse',
        type: 'text',
      });
      return {
        groupId: persistedGroup._id.toString(),
        promptId: promptDoc._id.toString(),
      };
    }

    it('dispatches a Langfuse group to the Langfuse adapter', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const resolved = makeLangfuseResolved({ groupId: langfuseGroup._id });
      const resolvePrompt = jest.fn().mockResolvedValue({ ok: true, value: resolved });
      const store = createPromptStore(db);
      const routed = createPromptServiceFromAdapters({
        store,
        sources: { native: createNativePromptAdapter(store), langfuse: { resolvePrompt } },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      await expect(
        routed.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'production' },
          loadedGroup: langfuseGroup,
        }),
      ).resolves.toEqual({ ok: true, value: resolved });
      expect(resolvePrompt).toHaveBeenCalledWith({
        group: langfuseGroup,
        selection: { type: 'production' },
        loadedRevision: undefined,
      });
    });

    it('rejects a disallowed source before calling the adapter', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const resolvePrompt = jest.fn();
      const store = createPromptStore(db);
      const routed = createPromptServiceFromAdapters({
        store,
        sources: { native: createNativePromptAdapter(store), langfuse: { resolvePrompt } },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      await expect(
        routed.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'production' },
          loadedGroup: langfuseGroup,
          allowedSources: ['native'],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unsupported_source', source: 'langfuse' },
      });
      expect(resolvePrompt).not.toHaveBeenCalled();
    });

    it('content-filters a resolved Langfuse prompt the same as native content', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const resolved = makeLangfuseResolved({
        groupId: langfuseGroup._id,
        prompt: 'Contains PRIVATE-VALUE',
      });
      const resolvePrompt = jest.fn().mockResolvedValue({ ok: true, value: resolved });
      const store = createPromptStore(db);
      const routed = createPromptServiceFromAdapters({
        store,
        sources: { native: createNativePromptAdapter(store), langfuse: { resolvePrompt } },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      await expect(
        routed.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'production' },
          loadedGroup: langfuseGroup,
          filters,
        }),
      ).resolves.toMatchObject({ ok: false, error: { type: 'blocked_content' } });
    });

    it('returns read_only for savePrompt on a Langfuse group', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const save = jest.spyOn(db, 'savePrompt');

      await expect(
        service.savePrompt({
          groupId: langfuseGroup._id,
          prompt: { prompt: 'Text', type: 'text' },
          author,
          loadedGroup: langfuseGroup,
        }),
      ).resolves.toEqual({ ok: false, error: { type: 'read_only', source: 'langfuse' } });
      expect(save).not.toHaveBeenCalled();
    });

    it('returns read_only, not invalid_input, for an invalid payload on a Langfuse group', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const save = jest.spyOn(db, 'savePrompt');

      await expect(
        service.savePrompt({
          groupId: langfuseGroup._id,
          prompt: { prompt: '  ', type: 'text' },
          author,
          loadedGroup: langfuseGroup,
        }),
      ).resolves.toEqual({ ok: false, error: { type: 'read_only', source: 'langfuse' } });
      expect(save).not.toHaveBeenCalled();
    });

    it('returns read_only for updatePromptGroup on a Langfuse group', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const update = jest.spyOn(db, 'updatePromptGroup');

      await expect(
        service.updatePromptGroup({
          groupId: langfuseGroup._id,
          updates: { name: 'Renamed' },
          loadedGroup: langfuseGroup,
        }),
      ).resolves.toEqual({ ok: false, error: { type: 'read_only', source: 'langfuse' } });
      expect(update).not.toHaveBeenCalled();
    });

    it('returns read_only for deletePromptGroup on a Langfuse group', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const deleteGroup = jest.spyOn(db, 'deletePromptGroup');

      await expect(
        service.deletePromptGroup({ groupId: langfuseGroup._id, loadedGroup: langfuseGroup }),
      ).resolves.toEqual({ ok: false, error: { type: 'read_only', source: 'langfuse' } });
      expect(deleteGroup).not.toHaveBeenCalled();
    });

    it.each([
      ['no loaded group (the MANAGE_PROMPTS bypass path)', undefined],
      ['a loaded group whose _id differs', { ...group, _id: missingId() }],
    ])(
      'returns read_only for updatePromptGroup on a persisted Langfuse group with %s',
      async (_case, mismatchedLoadedGroup) => {
        const { groupId: langfuseGroupId } = await createPersistedLangfuseGroupWithPrompt();
        const update = jest.spyOn(db, 'updatePromptGroup');

        await expect(
          service.updatePromptGroup({
            groupId: langfuseGroupId,
            updates: { name: 'Renamed' },
            loadedGroup: mismatchedLoadedGroup,
          }),
        ).resolves.toEqual({ ok: false, error: { type: 'read_only', source: 'langfuse' } });
        expect(update).not.toHaveBeenCalled();
        await expect(db.getPromptGroup({ _id: langfuseGroupId })).resolves.toMatchObject({
          name: 'Persisted Langfuse group',
        });
      },
    );

    it.each([
      ['no loaded group (the MANAGE_PROMPTS bypass path)', undefined],
      ['a loaded group whose _id differs', { ...group, _id: missingId() }],
    ])(
      'returns read_only for deletePromptGroup on a persisted Langfuse group with %s',
      async (_case, mismatchedLoadedGroup) => {
        const { groupId: langfuseGroupId, promptId } =
          await createPersistedLangfuseGroupWithPrompt();
        const deleteGroup = jest.spyOn(db, 'deletePromptGroup');

        await expect(
          service.deletePromptGroup({
            groupId: langfuseGroupId,
            loadedGroup: mismatchedLoadedGroup,
          }),
        ).resolves.toEqual({ ok: false, error: { type: 'read_only', source: 'langfuse' } });
        expect(deleteGroup).not.toHaveBeenCalled();
        await expect(db.getPromptGroup({ _id: langfuseGroupId })).resolves.toMatchObject({
          name: 'Persisted Langfuse group',
        });
        await expect(db.getPrompt({ _id: promptId })).resolves.not.toBeNull();
      },
    );

    describe('mutations keyed by revision on a Langfuse group', () => {
      it('returns read_only for makePromptProduction on a revision of a Langfuse group', async () => {
        const { groupId: langfuseGroupId, promptId } =
          await createPersistedLangfuseGroupWithPrompt();
        const promote = jest.spyOn(db, 'makePromptProduction');

        await expect(service.makePromptProduction({ promptId })).resolves.toEqual({
          ok: false,
          error: { type: 'read_only', source: 'langfuse' },
        });
        expect(promote).not.toHaveBeenCalled();
        const storedGroup = (await db.getPromptGroup({ _id: langfuseGroupId })) as {
          productionId?: unknown;
        } | null;
        expect(storedGroup?.productionId).toBeUndefined();
      });

      it('returns read_only for deletePrompt on a revision of a Langfuse group', async () => {
        const { groupId: langfuseGroupId, promptId } =
          await createPersistedLangfuseGroupWithPrompt();
        const deletePromptSpy = jest.spyOn(db, 'deletePrompt');

        await expect(service.deletePrompt({ groupId: langfuseGroupId, promptId })).resolves.toEqual(
          { ok: false, error: { type: 'read_only', source: 'langfuse' } },
        );
        expect(deletePromptSpy).not.toHaveBeenCalled();
        await expect(db.getPrompt({ _id: promptId })).resolves.not.toBeNull();
      });
    });

    it('returns unsupported_selection for a version selection on a native group', async () => {
      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'version', version: 2 },
          loadedGroup: group,
        }),
      ).resolves.toEqual({ ok: false, error: { type: 'unsupported_selection', source: 'native' } });
    });

    it('rejects a disallowed source for an exact selection with nothing preloaded', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const store = createPromptStore(db);
      jest.spyOn(store, 'getPromptGroup').mockResolvedValue(langfuseGroup);
      const revisionRead = jest.spyOn(store, 'getPrompt');
      const resolvePrompt = jest.fn();
      const routed = createPromptServiceFromAdapters({
        store,
        sources: { native: createNativePromptAdapter(store), langfuse: { resolvePrompt } },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      await expect(
        routed.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'exact', promptId: production._id },
          allowedSources: ['native'],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unsupported_source', source: 'langfuse' },
      });
      expect(resolvePrompt).not.toHaveBeenCalled();
      expect(revisionRead).not.toHaveBeenCalled();
    });

    it('returns unsupported_selection for an exact selection dispatched to the Langfuse adapter', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const store = createPromptStore(db);
      jest.spyOn(store, 'getPromptGroup').mockResolvedValue(langfuseGroup);
      const resolvePrompt = jest.fn().mockResolvedValue({
        ok: false,
        error: { type: 'unsupported_selection', source: 'langfuse' },
      });
      const routed = createPromptServiceFromAdapters({
        store,
        sources: { native: createNativePromptAdapter(store), langfuse: { resolvePrompt } },
        grantCreatorOwnership: jest.fn(),
        grantPublicViewer: jest.fn(),
        logger: { warn: jest.fn(), error: jest.fn() },
      });

      await expect(
        routed.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'exact', promptId: production._id },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unsupported_selection', source: 'langfuse' },
      });
      expect(resolvePrompt).toHaveBeenCalledWith({
        group: langfuseGroup,
        selection: { type: 'exact', promptId: production._id },
        loadedRevision: undefined,
      });
    });

    it('returns no revisions for a Langfuse group', async () => {
      const langfuseGroup = makeLangfuseGroup();

      await expect(service.getPrompts({ groupId: langfuseGroup._id })).resolves.toEqual([]);
    });

    it('treats a stored group with no source field as native', async () => {
      // A group with no `source` field at all, not a `native` value.
      // `toPromptGroupRecord` is the only place that defaults it, so routing,
      // `allowedSources` and `savePrompt` must all agree the default is native
      // rather than treating the absence as unresolved.
      await mongoose.models.PromptGroup.collection.updateOne(
        { _id: new Types.ObjectId(group._id) },
        { $unset: { source: '' } },
      );

      await expect(
        service.resolvePrompt({ groupId: group._id, selection: { type: 'production' } }),
      ).resolves.toMatchObject({ ok: true, value: { source: 'native', promptId: production._id } });
      await expect(
        service.resolvePrompt({
          groupId: group._id,
          selection: { type: 'production' },
          allowedSources: ['native'],
        }),
      ).resolves.toMatchObject({ ok: true, value: { source: 'native' } });
      await expect(
        service.savePrompt({
          groupId: group._id,
          prompt: { prompt: 'Mixed-version revision', type: 'text' },
          author,
        }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  describe('the always-built Langfuse adapter', () => {
    const originalPromptSyncFlag = process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE;

    afterEach(() => {
      if (originalPromptSyncFlag === undefined) {
        delete process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE;
      } else {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = originalPromptSyncFlag;
      }
    });

    function makeLangfuseGroup(overrides: Partial<PromptGroupRecord> = {}): PromptGroupRecord {
      return {
        _id: missingId(),
        name: 'Langfuse group',
        author,
        authorName: 'Author',
        source: 'langfuse',
        sourcePromptName: 'langfuse-prompt',
        ...overrides,
      };
    }

    it('routes a Langfuse group to the Langfuse adapter, whose resolver reads the base config by role', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const langfuseGroup = makeLangfuseGroup();
      const findConfigByPrincipal = jest.spyOn(db, 'findConfigByPrincipal');
      const withLangfuse = createPromptService({ db, grantPermission, getAppConfig });

      // No stored base config, so the resolver's own `promptSync.enabled` check fails
      // the request as `disabled`.
      await expect(
        withLangfuse.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'production' },
          loadedGroup: langfuseGroup,
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'source_unavailable', source: 'langfuse', reason: 'disabled' },
      });
      expect(findConfigByPrincipal).toHaveBeenCalledWith(
        PrincipalType.ROLE,
        BASE_CONFIG_PRINCIPAL_ID,
      );
    });

    it('rejects a Langfuse group excluded by allowedSources without reading config', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const findConfigByPrincipal = jest.spyOn(db, 'findConfigByPrincipal');
      const nativeOnly = createPromptService({ db, grantPermission, getAppConfig });

      await expect(
        nativeOnly.resolvePrompt({
          groupId: langfuseGroup._id,
          selection: { type: 'production' },
          loadedGroup: langfuseGroup,
          allowedSources: ['native'],
        }),
      ).resolves.toEqual({
        ok: false,
        error: { type: 'unsupported_source', source: 'langfuse' },
      });
      expect(findConfigByPrincipal).not.toHaveBeenCalled();
      expect(getAppConfig).not.toHaveBeenCalled();
    });

    it('serves two concurrent Langfuse resolves on one shared instance, each tied to its own tenant and config', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const groupA = makeLangfuseGroup({
        sourcePromptName: 'prompt-a',
        sourceDestination: 'us',
        sourceProjectId: 'project-a',
        tenantId: 'a',
      });
      const groupB = makeLangfuseGroup({
        sourcePromptName: 'prompt-b',
        sourceDestination: 'us',
        sourceProjectId: 'project-b',
        tenantId: 'b',
      });

      // Each request reads its own stored credentials. Tenant a finishes later
      // with a mismatched project. Tenant b has no usable secret key.
      const findConfigByPrincipal = jest
        .spyOn(db, 'findConfigByPrincipal')
        .mockImplementation(async () => {
          const tenantId = tenantStorage.getStore()?.tenantId;
          await new Promise((resolve) => setTimeout(resolve, tenantId === 'a' ? 20 : 0));
          return {
            overrides: {
              langfuse: {
                promptSync: { enabled: true },
                publicKey: `tenant-${tenantId}-public-key`,
                secretKey: tenantId === 'a' ? 'v3:test:tenant-a-secret' : undefined,
                destination: 'us',
                projectId: tenantId === 'a' ? 'a-mismatched-project' : 'project-b',
              },
            },
          };
        });
      getAppConfig.mockResolvedValue({} as never);
      const shared = createPromptService({ db, grantPermission, getAppConfig });

      const [resultA, resultB] = await Promise.all([
        tenantStorage.run({ tenantId: 'a' }, async () =>
          shared.resolvePrompt({
            groupId: groupA._id,
            selection: { type: 'production' },
            loadedGroup: groupA,
          }),
        ),
        tenantStorage.run({ tenantId: 'b' }, async () =>
          shared.resolvePrompt({
            groupId: groupB._id,
            selection: { type: 'production' },
            loadedGroup: groupB,
          }),
        ),
      ]);

      expect(resultA).toEqual({
        ok: false,
        error: { type: 'source_unavailable', source: 'langfuse', reason: 'source_changed' },
      });
      expect(resultB).toEqual({
        ok: false,
        error: { type: 'source_unavailable', source: 'langfuse', reason: 'not_configured' },
      });
      expect(findConfigByPrincipal).toHaveBeenCalledTimes(2);
      expect(getAppConfig).toHaveBeenCalledTimes(2);
      expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'a' });
      expect(getAppConfig).toHaveBeenCalledWith({ tenantId: 'b' });
    });
  });
});
