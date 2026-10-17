import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import {
  logger,
  createModels,
  createMethods,
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
import { createPromptCatalogStore, createNativePromptAdapter } from './native';
import { PromptStoreError } from './errors';

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
  group = (await createPromptCatalogStore(db).getPromptGroup(
    production.groupId,
  )) as PromptGroupRecord;
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
      const native = createNativePromptAdapter(db);
      const catalog = createPromptCatalogStore(db);
      jest.spyOn(catalog, 'getPromptGroup').mockRejectedValue(new Error('group read failed'));
      const routed = createPromptServiceFromAdapters({
        native,
        langfuse: { resolvePrompt: jest.fn() },
        catalog,
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
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
      await expect(service.deletePromptGroup(group._id)).resolves.toEqual({
        message: 'Prompt group deleted successfully',
      });
    });
  });

  describe('a source without mutations', () => {
    it('returns unsupported for each mutation before validating or writing', async () => {
      const {
        savePrompt: _save,
        makePromptProduction: _promote,
        deletePrompt: _delete,
        ...native
      } = createNativePromptAdapter(db);
      const readOnly = createPromptServiceFromAdapters({
        native,
        langfuse: { resolvePrompt: jest.fn() },
        catalog: createPromptCatalogStore(db),
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
      });

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
        ...overrides,
      };
    }

    it('dispatches a Langfuse group to the Langfuse adapter', async () => {
      const langfuseGroup = makeLangfuseGroup();
      const resolved = makeLangfuseResolved({ groupId: langfuseGroup._id });
      const resolvePrompt = jest.fn().mockResolvedValue({ ok: true, value: resolved });
      const routed = createPromptServiceFromAdapters({
        native: createNativePromptAdapter(db),
        langfuse: { resolvePrompt },
        catalog: createPromptCatalogStore(db),
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
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
      const routed = createPromptServiceFromAdapters({
        native: createNativePromptAdapter(db),
        langfuse: { resolvePrompt },
        catalog: createPromptCatalogStore(db),
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
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
      const routed = createPromptServiceFromAdapters({
        native: createNativePromptAdapter(db),
        langfuse: { resolvePrompt },
        catalog: createPromptCatalogStore(db),
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
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

    it('returns unsupported for savePrompt on a Langfuse group', async () => {
      const langfuseGroup = makeLangfuseGroup();

      await expect(
        service.savePrompt({
          groupId: langfuseGroup._id,
          prompt: { prompt: 'Text', type: 'text' },
          author,
          loadedGroup: langfuseGroup,
        }),
      ).resolves.toEqual({ ok: false, error: { type: 'unsupported', operation: 'savePrompt' } });
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
      const catalog = createPromptCatalogStore(db);
      jest.spyOn(catalog, 'getPromptGroup').mockResolvedValue(langfuseGroup);
      const native = createNativePromptAdapter(db);
      const revisionRead = jest.spyOn(native, 'getPrompt');
      const resolvePrompt = jest.fn();
      const routed = createPromptServiceFromAdapters({
        native,
        langfuse: { resolvePrompt },
        catalog,
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
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
      const catalog = createPromptCatalogStore(db);
      jest.spyOn(catalog, 'getPromptGroup').mockResolvedValue(langfuseGroup);
      const resolvePrompt = jest.fn().mockResolvedValue({
        ok: false,
        error: { type: 'unsupported_selection', source: 'langfuse' },
      });
      const routed = createPromptServiceFromAdapters({
        native: createNativePromptAdapter(db),
        langfuse: { resolvePrompt },
        catalog,
        grantCreatorOwnership: jest.fn(),
        logger: { error: jest.fn() },
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
  });
});
