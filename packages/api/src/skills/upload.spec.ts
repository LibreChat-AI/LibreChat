import { FileSources } from 'librechat-data-provider';
import type { Response } from 'express';
import { createSkillUploadHandler } from './upload';

type UploadDeps = Parameters<typeof createSkillUploadHandler>[0];
type UploadRequest = Parameters<ReturnType<typeof createSkillUploadHandler>>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const originalFile = {
  file_id: 'original',
  filepath: '/uploads/original',
  source: 'local',
  isExecutable: true,
};

function harness() {
  const skill = deferred<Awaited<ReturnType<UploadDeps['getSkillById']>>>();
  const file = deferred<Awaited<ReturnType<UploadDeps['getSkillFileByPath']>>>();
  const saveBuffer = jest.fn(async () => '/uploads/replacement');
  const deps = {
    getSkillById: jest.fn(() => skill.promise),
    getSkillFileByPath: jest.fn(() => file.promise),
    upsertSkillFile: jest.fn(async () => ({ ...originalFile, file_id: 'saved' })),
    resolveStorage: jest.fn(() => ({ source: FileSources.local, saveBuffer })),
    getStrategyFunctions: jest.fn(() => ({})),
  } satisfies UploadDeps;
  const req = {
    params: { id: 'skill-id', relativePath: ['references', 'guide.md'] },
    body: { relativePath: 'references/guide.md', expectedFileId: 'original' },
    user: { id: 'user-id', tenantId: 'tenant-id' },
    file: {
      originalname: 'guide.md',
      mimetype: 'text/markdown',
      buffer: Buffer.from('saved text'),
      size: 10,
    },
  } as unknown as UploadRequest;
  const res = {} as Response;
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return { skill, file, deps, saveBuffer, req, res, handler: createSkillUploadHandler(deps) };
}

describe('skill upload lookup ordering', () => {
  it.each(['skill', 'file'] as const)(
    'starts both privileged lookups before either resolves (%s first)',
    async (first) => {
      const h = harness();
      const pending = h.handler(h.req, h.res);

      expect(h.deps.getSkillById).toHaveBeenCalledWith('skill-id');
      expect(h.deps.getSkillFileByPath).toHaveBeenCalledWith('skill-id', 'references/guide.md');
      expect(h.saveBuffer).not.toHaveBeenCalled();
      if (first === 'skill') h.skill.resolve({ source: 'inline' });
      else h.file.resolve(originalFile);
      await Promise.resolve();
      expect(h.saveBuffer).not.toHaveBeenCalled();
      h.skill.resolve({ source: 'inline' });
      h.file.resolve(originalFile);
      await pending;

      expect(h.res.status).toHaveBeenCalledWith(200);
      expect(h.saveBuffer).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-id' }));
      expect(h.deps.upsertSkillFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedFileId: 'original',
          isExecutable: true,
          tenantId: 'tenant-id',
        }),
      );
    },
  );

  it('reuses the skill already resolved by ACL middleware', async () => {
    const h = harness();
    h.req.resourceAccess = { resourceInfo: { source: 'inline' } };
    const pending = h.handler(h.req, h.res);
    expect(h.deps.getSkillById).not.toHaveBeenCalled();
    expect(h.deps.getSkillFileByPath).toHaveBeenCalledTimes(1);
    h.file.resolve(originalFile);
    await pending;
    expect(h.res.status).toHaveBeenCalledWith(200);
  });

  it.each(['missing', 'managed', 'conflict', 'lookup failure'] as const)(
    'does not store bytes for %s',
    async (scenario) => {
      const h = harness();
      const pending = h.handler(h.req, h.res);
      h.file.resolve(scenario === 'conflict' ? null : originalFile);
      if (scenario === 'lookup failure') h.skill.reject(new Error('database unavailable'));
      else
        h.skill.resolve(
          scenario === 'missing' ? null : { source: scenario === 'managed' ? 'github' : 'inline' },
        );
      await pending;

      expect(h.res.status).toHaveBeenCalledWith(
        { missing: 404, managed: 403, conflict: 409, 'lookup failure': 500 }[scenario],
      );
      expect(h.deps.resolveStorage).not.toHaveBeenCalled();
      expect(h.saveBuffer).not.toHaveBeenCalled();
      expect(h.deps.upsertSkillFile).not.toHaveBeenCalled();
    },
  );
});
