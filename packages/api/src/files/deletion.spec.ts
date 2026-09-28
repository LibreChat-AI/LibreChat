import type { AgentResourceFileInput } from './deletion';
import {
  buildDeleteFilesResponse,
  deleteAgentResourceFiles,
  partitionAgentResourceFiles,
  PARTIAL_FILE_DELETION_MESSAGE,
} from './deletion';

describe('delete files response', () => {
  it('reports the caller’s success message when nothing failed', () => {
    expect(
      buildDeleteFilesResponse({ deletedFileIds: ['file-1'], failedFileIds: [] }, 'All gone'),
    ).toEqual({
      message: 'All gone',
      deletedFileIds: ['file-1'],
      failedFileIds: [],
    });
  });

  it('names the partial failure so a 200 is not read as a clean delete', () => {
    expect(
      buildDeleteFilesResponse(
        { deletedFileIds: ['file-1'], failedFileIds: ['file-2'] },
        'All gone',
      ),
    ).toEqual({
      message: PARTIAL_FILE_DELETION_MESSAGE,
      deletedFileIds: ['file-1'],
      failedFileIds: ['file-2'],
    });
  });

  it('answers with empty lists when there was nothing to delete', () => {
    expect(buildDeleteFilesResponse(undefined, 'All gone')).toEqual({
      message: 'All gone',
      deletedFileIds: [],
      failedFileIds: [],
    });
  });
});

type TestFile = { file_id: string; filename: string };

const input = (file_id: string, owner: string | null): AgentResourceFileInput<TestFile> => ({
  file_id,
  owner,
  file: { file_id, filename: `${file_id}.txt` },
});

describe('partition agent resource files', () => {
  const userId = 'user-1';
  const owned = input('owned', userId);
  const foreign = input('foreign', 'user-2');

  it('makes an attached file the caller owns a candidate for the delete pass', () => {
    expect(
      partitionAgentResourceFiles({
        requestedFileIds: ['owned'],
        attachedFileIds: ['owned'],
        files: [owned],
        toolResource: 'file_search',
        userId,
      }),
    ).toEqual({ ownedFiles: [owned], unlinkOnlyFiles: [] });
  });

  it('only unlinks an attached file owned by someone else', () => {
    expect(
      partitionAgentResourceFiles({
        requestedFileIds: ['foreign'],
        attachedFileIds: ['foreign'],
        files: [foreign],
        toolResource: 'file_search',
        userId,
      }),
    ).toEqual({
      ownedFiles: [],
      unlinkOnlyFiles: [{ tool_resource: 'file_search', file_id: 'foreign' }],
    });
  });

  it('only unlinks an attached file whose metadata record is gone', () => {
    expect(
      partitionAgentResourceFiles({
        requestedFileIds: ['missing'],
        attachedFileIds: ['missing'],
        files: [],
        toolResource: 'file_search',
        userId,
      }),
    ).toEqual({
      ownedFiles: [],
      unlinkOnlyFiles: [{ tool_resource: 'file_search', file_id: 'missing' }],
    });
  });

  it('does not treat an ownerless record as the caller’s', () => {
    expect(
      partitionAgentResourceFiles({
        requestedFileIds: ['orphan'],
        attachedFileIds: ['orphan'],
        files: [input('orphan', null)],
        toolResource: 'file_search',
        userId,
      }),
    ).toEqual({
      ownedFiles: [],
      unlinkOnlyFiles: [{ tool_resource: 'file_search', file_id: 'orphan' }],
    });
  });

  it('ignores files the tool resource does not hold', () => {
    expect(
      partitionAgentResourceFiles({
        requestedFileIds: ['owned', 'elsewhere'],
        attachedFileIds: ['owned'],
        files: [owned, input('elsewhere', userId)],
        toolResource: 'file_search',
        userId,
      }),
    ).toEqual({ ownedFiles: [owned], unlinkOnlyFiles: [] });
  });

  it('splits a mixed request and counts each file once', () => {
    expect(
      partitionAgentResourceFiles({
        requestedFileIds: ['owned', 'foreign', 'owned'],
        attachedFileIds: ['owned', 'foreign'],
        files: [owned, foreign],
        toolResource: 'ocr',
        userId,
      }),
    ).toEqual({
      ownedFiles: [owned],
      unlinkOnlyFiles: [{ tool_resource: 'ocr', file_id: 'foreign' }],
    });
  });
});

describe('delete agent resource files', () => {
  const userId = 'user-1';

  const makeDeps = (sharedFileIds: string[] = [], calls: string[] = []) => ({
    getSharedResourceFileIds: jest.fn().mockResolvedValue(sharedFileIds),
    removeAgentResourceFiles: jest.fn().mockImplementation(() => {
      calls.push('unlink');
      return Promise.resolve(undefined);
    }),
    deleteFiles: jest.fn().mockImplementation((files: TestFile[]) => {
      calls.push('destroy');
      return Promise.resolve({
        deletedFileIds: files.map((file) => file.file_id),
        failedFileIds: [],
      });
    }),
  });

  const run = (
    files: Array<AgentResourceFileInput<TestFile>>,
    deps: ReturnType<typeof makeDeps>,
    attachedFileIds?: string[],
  ) =>
    deleteAgentResourceFiles(
      {
        agentId: 'agent_1',
        agentObjectId: '65f000000000000000000001',
        toolResource: 'file_search',
        requestedFileIds: files.map((file) => file.file_id),
        attachedFileIds: attachedFileIds ?? files.map((file) => file.file_id),
        files,
        userId,
      },
      deps,
    );

  it('destroys a file this agent was the last to reference', async () => {
    const deps = makeDeps();
    const result = await run([input('owned', userId)], deps);

    expect(deps.deleteFiles).toHaveBeenCalledWith([{ file_id: 'owned', filename: 'owned.txt' }]);
    expect(deps.removeAgentResourceFiles).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: { deletedFileIds: ['owned'], failedFileIds: [] },
      unlinkedFileIds: [],
      destroyedFileIds: ['owned'],
    });
  });

  it('excludes the agent by a globally unique identity, not its logical id', async () => {
    const deps = makeDeps();
    await run([input('owned', userId)], deps);

    expect(deps.getSharedResourceFileIds).toHaveBeenCalledWith({
      file_ids: ['owned'],
      excludeAgentObjectId: '65f000000000000000000001',
      excludeToolResource: 'file_search',
    });
  });

  it('keeps a file another agent still references, unlinking it here only', async () => {
    const deps = makeDeps(['shared']);
    const result = await run([input('shared', userId)], deps);

    expect(deps.deleteFiles).not.toHaveBeenCalled();
    expect(deps.removeAgentResourceFiles).toHaveBeenCalledWith({
      agent_id: 'agent_1',
      files: [{ tool_resource: 'file_search', file_id: 'shared' }],
    });
    expect(result).toEqual({
      outcome: null,
      unlinkedFileIds: ['shared'],
      destroyedFileIds: [],
    });
  });

  it('destroys the last-reference file and unlinks the shared one in the same request', async () => {
    const deps = makeDeps(['shared']);
    const result = await run([input('shared', userId), input('owned', userId)], deps);

    expect(deps.deleteFiles).toHaveBeenCalledWith([{ file_id: 'owned', filename: 'owned.txt' }]);
    expect(deps.removeAgentResourceFiles).toHaveBeenCalledWith({
      agent_id: 'agent_1',
      files: [{ tool_resource: 'file_search', file_id: 'shared' }],
    });
    expect(result.unlinkedFileIds).toEqual(['shared']);
    expect(result.destroyedFileIds).toEqual(['owned']);
  });

  it('unlinks a file the caller does not own without asking to destroy it', async () => {
    const deps = makeDeps();
    const result = await run([input('foreign', 'user-2')], deps);

    expect(deps.getSharedResourceFileIds).not.toHaveBeenCalled();
    expect(deps.deleteFiles).not.toHaveBeenCalled();
    expect(deps.removeAgentResourceFiles).toHaveBeenCalledWith({
      agent_id: 'agent_1',
      files: [{ tool_resource: 'file_search', file_id: 'foreign' }],
    });
    expect(result.outcome).toBeNull();
  });

  it('touches nothing when the tool resource holds none of the requested files', async () => {
    const deps = makeDeps();
    const result = await run([input('owned', userId)], deps, []);

    expect(deps.getSharedResourceFileIds).not.toHaveBeenCalled();
    expect(deps.removeAgentResourceFiles).not.toHaveBeenCalled();
    expect(deps.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: null, unlinkedFileIds: [], destroyedFileIds: [] });
  });

  it('destroys before removing any reference, so a failed destroy leaves the file attached', async () => {
    const calls: string[] = [];
    const deps = makeDeps(['shared'], calls);
    await run([input('shared', userId), input('owned', userId)], deps);

    expect(calls).toEqual(['destroy', 'unlink']);
  });

  it('reports what the delete pass deleted rather than what it was handed', async () => {
    const deps = makeDeps();
    deps.deleteFiles.mockResolvedValue({
      deletedFileIds: ['owned'],
      failedFileIds: ['other-owned'],
    });
    const result = await run([input('owned', userId), input('other-owned', userId)], deps);

    expect(result.destroyedFileIds).toEqual(['owned']);
  });

  it('passes a partial delete outcome back to the caller', async () => {
    const deps = makeDeps();
    deps.deleteFiles.mockResolvedValue({ deletedFileIds: [], failedFileIds: ['owned'] });
    const result = await run([input('owned', userId)], deps);

    expect(result.outcome).toEqual({ deletedFileIds: [], failedFileIds: ['owned'] });
    expect(deps.removeAgentResourceFiles).not.toHaveBeenCalled();
  });
});
