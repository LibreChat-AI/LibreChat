import { finalizeFileDeletion } from './finalize';

const files = [{ file_id: 'gone' }, { file_id: 'kept' }];
const params = { deletedFileIds: ['gone', 'kept'], failedFileIds: [], files, userId: 'owner' };
function setup() {
  const deleteFiles = jest.fn().mockResolvedValue({
    deletedCount: 1,
    deletedFileIds: ['gone'],
    failedFileIds: ['kept'],
  });
  const removeAgentResourceFilesFromAllAgents = jest.fn().mockResolvedValue(undefined);
  const logger = { error: jest.fn() };
  const deps = { deleteFiles, removeAgentResourceFilesFromAllAgents, logger };
  return deps;
}

it('cleans only successful file references after a mixed-snapshot metadata batch', async () => {
  const deps = setup();
  expect(await finalizeFileDeletion(params, deps)).toEqual({
    deletedFileIds: ['gone'],
    failedFileIds: ['kept'],
  });
  expect(deps.deleteFiles).toHaveBeenCalledWith(['gone', 'kept'], undefined, {
    files,
    userId: 'owner',
  });
  expect(deps.removeAgentResourceFilesFromAllAgents).toHaveBeenCalledWith({ file_ids: ['gone'] });
});

it('does not finalize any file whose storage cleanup failed', async () => {
  const deps = setup();
  deps.deleteFiles.mockResolvedValue({ deletedFileIds: ['gone'], failedFileIds: [] });
  expect(await finalizeFileDeletion({ ...params, failedFileIds: ['kept'] }, deps)).toEqual({
    deletedFileIds: ['gone'],
    failedFileIds: ['kept'],
  });
  expect(deps.deleteFiles).toHaveBeenCalledWith(['gone'], undefined, expect.anything());
});

it('returns unresolved metadata ids as failures instead of silently claiming success', async () => {
  const deps = setup();
  deps.deleteFiles.mockResolvedValue({ deletedFileIds: ['gone'], failedFileIds: [] });
  expect(await finalizeFileDeletion(params, deps)).toEqual({
    deletedFileIds: ['gone'],
    failedFileIds: ['kept'],
  });
});

it('finalizes references for idempotently confirmed absent metadata', async () => {
  const deps = setup();
  deps.deleteFiles.mockResolvedValue({
    deletedCount: 0,
    deletedFileIds: ['gone', 'kept'],
    failedFileIds: [],
  });
  expect(await finalizeFileDeletion(params, deps)).toEqual({
    deletedFileIds: ['gone', 'kept'],
    failedFileIds: [],
  });
  expect(deps.removeAgentResourceFilesFromAllAgents).toHaveBeenCalledWith({
    file_ids: ['gone', 'kept'],
  });
});

it('does not read or finalize metadata when no storage deletion succeeded', async () => {
  const deps = setup();
  expect(
    await finalizeFileDeletion({ ...params, deletedFileIds: [], failedFileIds: ['kept'] }, deps),
  ).toEqual({ deletedFileIds: [], failedFileIds: ['kept'] });
  expect(deps.deleteFiles).not.toHaveBeenCalled();
  expect(deps.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
});

it('propagates metadata outages without removing agent references', async () => {
  const deps = setup();
  const failure = new Error('private database detail');
  deps.deleteFiles.mockRejectedValue(failure);
  await expect(finalizeFileDeletion(params, deps)).rejects.toBe(failure);
  expect(deps.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
  expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain('private database detail');
});

it.each([
  { deletedCount: 1 },
  { deletedFileIds: ['unknown'], failedFileIds: [] },
  { deletedFileIds: ['gone'], failedFileIds: ['gone'] },
  { deletedFileIds: [], failedFileIds: ['unknown'] },
])('rejects an unconfirmed or contradictory metadata receipt: %p', async (receipt) => {
  const deps = setup();
  deps.deleteFiles.mockResolvedValue(receipt);
  await expect(finalizeFileDeletion(params, deps)).rejects.toThrow();
  expect(deps.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
});

it('keeps best-effort agent cleanup failure distinct from confirmed metadata deletion', async () => {
  const deps = setup();
  deps.removeAgentResourceFilesFromAllAgents.mockRejectedValue(
    new Error('private database detail'),
  );
  expect(await finalizeFileDeletion(params, deps)).toEqual({
    deletedFileIds: ['gone'],
    failedFileIds: ['kept'],
  });
  expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain('private database detail');
});
