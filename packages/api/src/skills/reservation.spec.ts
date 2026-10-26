import { FileContext, FileSources } from 'librechat-data-provider';
import {
  assertSavedSkillBlobMatchesReservation,
  createSkillBlobReserver,
  createSkillBufferWriter,
  createSkillStorageResolver,
  reserveSkillBlob,
} from './reservation';
import { extractFirebaseBlobPath } from '~/storage/ownedBlobDelete';
import { getS3Key } from '~/storage/s3/crud';

describe('Skill blob reservation', () => {
  it('reserves local and Firebase owner-scoped paths before upload', async () => {
    await expect(
      reserveSkillBlob({ source: FileSources.local, userId: 'owner', fileName: 'id__note.md' }),
    ).resolves.toMatchObject({ filepath: '/uploads/owner/id__note.md' });
    const firebase = await reserveSkillBlob({
      source: FileSources.firebase,
      userId: 'owner',
      fileName: 'id__note.md',
    });
    expect(extractFirebaseBlobPath(firebase.filepath)).toBe('uploads/owner/id__note.md');
  });

  it.each([FileSources.s3, FileSources.cloudfront, FileSources.azure_blob])(
    'uses the provider future-URL resolver for %s',
    async (source) => {
      const getFileURL = jest.fn(async () =>
        source === FileSources.azure_blob
          ? 'https://example.invalid/container/uploads/owner/id__note.md'
          : 'https://example.invalid/t/tenant-a/uploads/owner/id__note.md',
      );
      const reserved = await reserveSkillBlob({
        source,
        userId: 'owner',
        fileName: 'id__note.md',
        tenantId: 'tenant-a',
        getFileURL,
      });
      expect(getFileURL).toHaveBeenCalledWith({
        userId: 'owner',
        fileName: 'id__note.md',
        basePath: 'uploads',
        tenantId: 'tenant-a',
        storageRegion: undefined,
        includeRegionInPath: undefined,
        useInlinePath: undefined,
      });
      expect(reserved.filepath).toContain('/uploads/owner/id__note.md');
    },
  );

  it('fails closed for unsupported storage', async () => {
    await expect(
      reserveSkillBlob({ source: FileSources.openai, userId: 'owner', fileName: 'id__note.md' }),
    ).rejects.toThrow('Unsupported Skill storage strategy');
  });

  it('selects a Skill provider from config and requires save and delete capabilities', async () => {
    const getFileStrategy = jest.fn(() => FileSources.local);
    let canDelete = true;
    const getStrategyFunctions = jest.fn(() => ({
      saveBuffer: jest.fn(),
      deleteFile: canDelete ? jest.fn() : undefined,
    }));
    const reserve = createSkillBlobReserver({ getFileStrategy, getStrategyFunctions });
    await expect(
      reserve(Promise.resolve({ fileStrategy: FileSources.local }), {
        userId: 'owner',
        fileName: 'id__note.md',
        isImage: false,
      }),
    ).resolves.toMatchObject({ source: FileSources.local, filepath: '/uploads/owner/id__note.md' });
    expect(getFileStrategy).toHaveBeenCalledWith(
      { fileStrategy: FileSources.local },
      { context: FileContext.skill_file, isImage: false },
    );
    canDelete = false;
    await expect(
      reserve(
        { fileStrategy: FileSources.local },
        {
          userId: 'owner',
          fileName: 'id__note.md',
          isImage: false,
        },
      ),
    ).rejects.toThrow('Skill storage cannot guarantee cleanup');
  });

  it('rejects truthy non-function cleanup capabilities before reserving or writing', async () => {
    const getStrategyFunctions = () => ({
      saveBuffer: jest.fn(async () => '/uploads/owner/file-1'),
      deleteFile: true,
    });
    const resolve = createSkillStorageResolver({
      getFileStrategy: () => FileSources.local,
      getStrategyFunctions,
    });
    expect(() => resolve({}, { isImage: false })).toThrow('Skill storage cannot guarantee cleanup');

    const write = createSkillBufferWriter({ getStrategyFunctions });
    const reservation = await reserveSkillBlob({
      source: FileSources.local,
      userId: 'owner',
      fileName: 'file-1',
    });
    await expect(
      write({
        reservation,
        buffer: Buffer.from('content'),
      }),
    ).rejects.toThrow('Skill storage cannot guarantee cleanup');
  });

  it('writes to the reserved provider when live config changes before upload', async () => {
    const localSave = jest.fn(async () => '/uploads/owner/id__note.md');
    const firebaseSave = jest.fn(async () => 'https://firebase.invalid/o/other');
    const getFileStrategy = jest.fn(() => FileSources.local);
    const getStrategyFunctions = jest.fn((source: string) => ({
      saveBuffer: source === FileSources.local ? localSave : firebaseSave,
      deleteFile: jest.fn(),
    }));
    const resolve = createSkillStorageResolver({ getFileStrategy, getStrategyFunctions });
    const selected = resolve({}, { isImage: false });
    getFileStrategy.mockReturnValue(FileSources.firebase);
    const write = createSkillBufferWriter({ getStrategyFunctions });
    const reservation = await reserveSkillBlob({
      source: selected.source,
      userId: 'owner',
      fileName: 'id__note.md',
    });

    await expect(
      write({
        reservation,
        buffer: Buffer.from('note'),
      }),
    ).resolves.toMatchObject({
      source: FileSources.local,
      filepath: '/uploads/owner/id__note.md',
    });
    expect(localSave).toHaveBeenCalledTimes(1);
    expect(firebaseSave).not.toHaveBeenCalled();
    expect(getFileStrategy).toHaveBeenCalledTimes(1);
  });

  it('writes to the reserved uploads path without accepting a second location', async () => {
    const saveBuffer = jest.fn(async () => '/uploads/owner/id__note.md');
    const write = createSkillBufferWriter({
      getStrategyFunctions: () => ({ saveBuffer, deleteFile: jest.fn() }),
    });
    const reservation = await reserveSkillBlob({
      source: FileSources.local,
      userId: 'owner',
      fileName: 'id__note.md',
    });
    await write({
      reservation,
      buffer: Buffer.from('note'),
    });
    expect(saveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ basePath: 'uploads', userId: 'owner', fileName: 'id__note.md' }),
    );
  });

  it.each([FileSources.s3, FileSources.cloudfront])(
    'freezes the %s provider key across region-config changes',
    async (source) => {
      let configRegion = 'us-east-1';
      let includeRegion = true;
      const getFileURL = jest.fn(async (params) => {
        const key = getS3Key({
          ...params,
          storageRegion: params.storageRegion ?? configRegion,
          includeRegionInPath: params.includeRegionInPath ?? includeRegion,
          useInlinePath: params.useInlinePath ?? false,
        });
        return `https://cdn.example.test/${key}?signature=reserved`;
      });
      const saveBuffer = jest.fn(async (params) => {
        const key = getS3Key({
          ...params,
          storageRegion: params.storageRegion ?? configRegion,
          includeRegionInPath: params.includeRegionInPath ?? includeRegion,
          useInlinePath: params.useInlinePath ?? false,
        });
        return `https://cdn.example.test/${key}?signature=saved`;
      });
      const reservation = await reserveSkillBlob({
        source,
        userId: 'owner',
        fileName: 'id__note.md',
        tenantId: 'tenant-a',
        getFileURL,
      });
      expect(reservation.storageKey).toBe('r/us-east-1/t/tenant-a/uploads/owner/id__note.md');
      expect(Object.isFrozen(reservation.writeLocation)).toBe(true);
      configRegion = 'eu-west-1';
      includeRegion = false;
      const write = createSkillBufferWriter({
        getStrategyFunctions: () => ({ saveBuffer, deleteFile: jest.fn() }),
      });
      const saved = await write({ reservation, buffer: Buffer.from('note') });
      assertSavedSkillBlobMatchesReservation(reservation, saved.filepath);
      expect(saved.storageKey).toBe(reservation.storageKey);
      expect(saveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'uploads',
          tenantId: 'tenant-a',
          storageRegion: 'us-east-1',
          includeRegionInPath: true,
          useInlinePath: false,
        }),
      );
    },
  );

  it('keeps the default S3 key unprefixed despite a later regional default', async () => {
    const reservation = await reserveSkillBlob({
      source: FileSources.s3,
      userId: 'owner',
      fileName: 'id__note.md',
      getFileURL: async () => 'https://s3.example.test/uploads/owner/id__note.md',
    });
    expect(reservation.writeLocation).toMatchObject({
      includeRegionInPath: false,
      useInlinePath: false,
    });
    expect(reservation.storageKey).toBe('uploads/owner/id__note.md');
  });

  it.each([FileSources.local, FileSources.firebase, FileSources.azure_blob])(
    'matches the reserved %s object after a provider write',
    async (source) => {
      const reservation = await reserveSkillBlob({
        source,
        userId: 'owner',
        fileName: 'id__note.md',
        getFileURL: async () => 'https://azure.example.test/files/uploads/owner/id__note.md',
      });
      const saveBuffer = jest.fn(async ({ userId, fileName, basePath }) => {
        if (source === FileSources.local) return `/${basePath}/${userId}/${fileName}`;
        if (source === FileSources.firebase) {
          return `https://firebase.example.test/o/${encodeURIComponent(`${basePath}/${userId}/${fileName}`)}?token=new`;
        }
        return `https://azure.example.test/files/${basePath}/${userId}/${fileName}`;
      });
      const write = createSkillBufferWriter({
        getStrategyFunctions: () => ({ saveBuffer, deleteFile: jest.fn() }),
      });
      const saved = await write({ reservation, buffer: Buffer.from('note') });
      expect(() =>
        assertSavedSkillBlobMatchesReservation(reservation, saved.filepath),
      ).not.toThrow();
      expect(saveBuffer).toHaveBeenCalledWith(expect.objectContaining(reservation.writeLocation));
    },
  );

  it('rejects unsupported inline uploads and ambiguous provider keys before writing bytes', async () => {
    const getFileURL = jest.fn(async (params) => {
      const key = getS3Key({ ...params, useInlinePath: params.useInlinePath });
      return `https://cdn.example.test/${key}`;
    });
    await expect(
      reserveSkillBlob({
        source: FileSources.cloudfront,
        userId: 'owner',
        fileName: 'id__note.md',
        useInlinePath: true,
        getFileURL,
      }),
    ).rejects.toThrow('inline path is not supported');
    await expect(
      reserveSkillBlob({
        source: FileSources.s3,
        userId: 'owner',
        fileName: 'id__note.md',
        getFileURL: async () => 'https://cdn.example.test/t/wrong/uploads/owner/id__note.md',
      }),
    ).rejects.toThrow('different reserved object');
  });

  it('rejects an Azure write to another account or container with the same relative path', async () => {
    const reservation = await reserveSkillBlob({
      source: FileSources.azure_blob,
      userId: 'owner',
      fileName: 'id__note.md',
      getFileURL: async () =>
        'https://account-a.example.test/files/uploads/owner/id__note.md?reserved=signature',
    });
    expect(() =>
      assertSavedSkillBlobMatchesReservation(
        reservation,
        'https://account-b.example.test/files/uploads/owner/id__note.md',
      ),
    ).toThrow('outside its reserved location');
    expect(() =>
      assertSavedSkillBlobMatchesReservation(
        reservation,
        'https://account-a.example.test/other/uploads/owner/id__note.md',
      ),
    ).toThrow('outside its reserved location');
    expect(() =>
      assertSavedSkillBlobMatchesReservation(
        reservation,
        'https://account-a.example.test/files/uploads/owner/id__note.md?saved=signature',
      ),
    ).not.toThrow();
  });
});
