import { Types } from 'mongoose';
import type { DeleteSkillResult, ISkillFile } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { SkillsHandlersDeps } from './handlers';
import type { ServerRequest } from '~/types';
import { createSkillsHandlers } from './handlers';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn(() => res) as Response['status'];
  res.json = jest.fn(() => res) as Response['json'];
  return res;
}

describe('skill delete handler', () => {
  it('retries dependent cleanup before the deleted skill becomes unreachable', async () => {
    const id = new Types.ObjectId().toString();
    const deleteBlob = jest.fn(async () => undefined);
    const incomplete: DeleteSkillResult = {
      deleted: true,
      skillAbsent: true,
      cleanupComplete: false,
      failedCleanupSteps: ['skill_files'],
    };
    const complete: DeleteSkillResult = {
      deleted: false,
      skillAbsent: true,
      cleanupComplete: true,
      failedCleanupSteps: [],
    };
    const deleteSkill = jest.fn().mockResolvedValueOnce(incomplete).mockResolvedValueOnce(complete);
    const file = {
      relativePath: 'references/query.sql',
      filepath: '/uploads/query.sql',
      source: 'local',
    } as ISkillFile & { _id: Types.ObjectId };
    const handlers = createSkillsHandlers({
      deleteSkill,
      listSkillFiles: jest.fn(async () => [file]),
      getStrategyFunctions: jest.fn(() => ({ deleteFile: deleteBlob })),
      isValidObjectIdString: jest.fn(() => true),
    } as unknown as SkillsHandlersDeps);
    const req = { params: { id } } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.delete(req, res);

    expect(deleteSkill).toHaveBeenCalledTimes(2);
    expect(deleteBlob).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id, deleted: true, cleanupComplete: true });
  });

  it('returns an evictable response when only non-file cleanup remains incomplete', async () => {
    const id = new Types.ObjectId().toString();
    const incomplete: DeleteSkillResult = {
      deleted: true,
      skillAbsent: true,
      cleanupComplete: false,
      failedCleanupSteps: ['permissions'],
    };
    const deleteSkill = jest.fn(async () => incomplete);
    const handlers = createSkillsHandlers({
      deleteSkill,
      listSkillFiles: jest.fn(async () => []),
      getStrategyFunctions: jest.fn(),
      isValidObjectIdString: jest.fn(() => true),
    } as unknown as SkillsHandlersDeps);
    const req = { params: { id } } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.delete(req, res);

    expect(deleteSkill).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id, deleted: true, cleanupComplete: false });
  });

  it('awaits blob cleanup and reports a partial deletion when storage rejects it', async () => {
    const id = new Types.ObjectId().toString();
    const deleteBlob = jest.fn(async () => {
      throw new Error('storage unavailable');
    });
    const handlers = createSkillsHandlers({
      deleteSkill: jest.fn(async () => ({
        deleted: true,
        skillAbsent: true,
        cleanupComplete: true,
        failedCleanupSteps: [],
      })),
      listSkillFiles: jest.fn(async () => [
        {
          relativePath: 'references/query.sql',
          filepath: '/uploads/query.sql',
          source: 'local',
        } as ISkillFile & { _id: Types.ObjectId },
      ]),
      getStrategyFunctions: jest.fn(() => ({ deleteFile: deleteBlob })),
      isValidObjectIdString: jest.fn(() => true),
    } as unknown as SkillsHandlersDeps);
    const req = { params: { id } } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.delete(req, res);

    expect(deleteBlob).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id, deleted: true, cleanupComplete: false });
  });
});

describe('skill create handler', () => {
  it('retries dependent cleanup after owner permission setup fails', async () => {
    const skillId = new Types.ObjectId();
    const deleteSkill = jest
      .fn()
      .mockResolvedValueOnce({
        deleted: true,
        skillAbsent: true,
        cleanupComplete: false,
        failedCleanupSteps: ['permissions'],
      })
      .mockResolvedValueOnce({
        deleted: false,
        skillAbsent: true,
        cleanupComplete: true,
        failedCleanupSteps: [],
      });
    const handlers = createSkillsHandlers({
      createSkill: jest.fn(async () => ({
        skill: { _id: skillId, name: 'permission-failure' },
        warnings: [],
      })),
      grantPermission: jest.fn(async () => {
        throw new Error('permission unavailable');
      }),
      deleteSkill,
    } as unknown as SkillsHandlersDeps);
    const req = {
      body: { name: 'permission-failure', description: 'Rollback test', body: '# Test' },
      user: { id: 'user-1', _id: new Types.ObjectId(), name: 'Test User' },
    } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.create(req, res);

    expect(deleteSkill).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
