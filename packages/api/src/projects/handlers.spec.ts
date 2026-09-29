import { MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH } from 'librechat-data-provider';
import type { Response } from 'express';
import { createProjectHandlers } from './handlers';

const projectId = '507f1f77bcf86cd799439011';

function request(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'owner', tenantId: 'tenant-a' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as never;
}

function response() {
  const result = { statusCode: 200, body: undefined as unknown };
  const res = {
    status: jest.fn((statusCode: number) => {
      result.statusCode = statusCode;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      result.body = body;
      return res;
    }),
  } as unknown as Response;
  return { res, result };
}

function setup(overrides: Partial<Parameters<typeof createProjectHandlers>[0]> = {}) {
  const deps = {
    listChatProjects: jest.fn(),
    createChatProject: jest.fn().mockResolvedValue({ _id: projectId }),
    getChatProject: jest.fn().mockResolvedValue({ _id: projectId, file_ids: [] }),
    updateChatProject: jest.fn().mockResolvedValue({ _id: projectId }),
    deleteChatProject: jest.fn().mockResolvedValue({ deletedCount: 1, modifiedCount: 1 }),
    assignConversationToProject: jest.fn(),
    addChatProjectFile: jest.fn(),
    removeChatProjectFile: jest.fn(),
    getProjectFiles: jest.fn().mockResolvedValue([]),
    getAvailableProjectFiles: jest.fn().mockResolvedValue({ files: [], nextCursor: null }),
    ...overrides,
  };
  return { handlers: createProjectHandlers(deps), deps };
}

describe('ChatProject handlers', () => {
  it.each([
    ['non-string', 42],
    ['oversized', 'x'.repeat(MAX_CHAT_PROJECT_INSTRUCTIONS_LENGTH + 1)],
  ])('rejects %s instructions on create before persistence', async (_label, instructions) => {
    const { handlers, deps } = setup();
    const { res, result } = response();
    await handlers.createProject(request({ body: { name: 'Project', instructions } }), res);
    expect(result.statusCode).toBe(400);
    expect(deps.createChatProject).not.toHaveBeenCalled();
  });

  it('rejects invalid update instructions before persistence', async () => {
    const { handlers, deps } = setup();
    const { res, result } = response();
    await handlers.updateProject(
      request({ params: { projectId }, body: { instructions: null } }),
      res,
    );
    expect(result.statusCode).toBe(400);
    expect(deps.updateChatProject).not.toHaveBeenCalled();
  });

  it('passes a contextRevision through and maps a stale one to a 409 conflict', async () => {
    const { handlers, deps } = setup({
      updateChatProject: jest.fn().mockRejectedValue(new Error('Project revision conflict')),
    });
    const { res, result } = response();
    await handlers.updateProject(
      request({ params: { projectId }, body: { name: 'Renamed', contextRevision: 3 } }),
      res,
    );
    expect(deps.updateChatProject).toHaveBeenCalledWith(
      'owner',
      projectId,
      { name: 'Renamed', contextRevision: 3 },
      undefined,
    );
    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({
      message: 'Project was changed by another session',
      code: 'CHAT_PROJECT_CONFLICT',
    });
  });

  it('keeps last-writer behavior when contextRevision is absent and rejects invalid values', async () => {
    const updateChatProject = jest.fn().mockResolvedValue({ _id: projectId });
    const { handlers } = setup({ updateChatProject });
    const ok = response();
    await handlers.updateProject(request({ params: { projectId }, body: { name: 'A' } }), ok.res);
    expect(ok.result.statusCode).toBe(200);
    expect(updateChatProject.mock.calls[0][2]).toEqual({ name: 'A' });

    const bad = response();
    await handlers.updateProject(
      request({ params: { projectId }, body: { name: 'A', contextRevision: -1 } }),
      bad.res,
    );
    expect(bad.result.statusCode).toBe(400);
    expect(updateChatProject).toHaveBeenCalledTimes(1);
  });

  it('refuses an over-long description instead of storing a shortened one', async () => {
    const { handlers, deps } = setup();
    const description = 'd'.repeat(41);
    const config = { config: { projects: { maxDescriptionLength: 40 } } };

    const created = response();
    await handlers.createProject(
      request({ body: { name: 'Project', description }, ...config }),
      created.res,
    );
    expect(created.result.statusCode).toBe(400);
    expect(created.result.body).toEqual({ error: 'description must be at most 40 characters' });
    expect(deps.createChatProject).not.toHaveBeenCalled();

    const updated = response();
    await handlers.updateProject(
      request({ params: { projectId }, body: { description }, ...config }),
      updated.res,
    );
    expect(updated.result.statusCode).toBe(400);
    expect(deps.updateChatProject).not.toHaveBeenCalled();
  });

  it('surfaces atomic resource errors without pretending the attach succeeded', async () => {
    const { handlers } = setup({
      addChatProjectFile: jest.fn().mockRejectedValue(new Error('Project file limit reached')),
    });
    const { res, result } = response();
    await handlers.addProjectFile(
      request({ params: { projectId }, body: { file_id: 'file-1' } }),
      res,
    );
    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({ error: 'Project file limit reached' });
  });

  it('keeps missing resource references as unavailable placeholders', async () => {
    const { handlers } = setup({
      getChatProject: jest.fn().mockResolvedValue({ _id: projectId, file_ids: ['gone'] }),
    });
    const { res, result } = response();
    await handlers.listProjectFiles(request({ params: { projectId } }), res);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual([{ file_id: 'gone', availability: 'unavailable' }]);
  });

  it('excludes extracted text from available-file metadata', async () => {
    const file = {
      file_id: 'candidate',
      filename: 'candidate.txt',
      filepath: '/uploads/candidate.txt',
      object: 'file',
      type: 'text/plain',
      bytes: 10,
      usage: 0,
      embedded: true,
      context: 'message_attachment',
      user: 'owner',
      tenantId: 'tenant-a',
      text: 'must not be returned',
    };
    const { handlers } = setup({
      getChatProject: jest.fn().mockResolvedValue({
        _id: projectId,
        tenantId: 'tenant-a',
        file_ids: ['attached'],
      }),
      getAvailableProjectFiles: jest.fn().mockResolvedValue({
        files: [file],
        nextCursor: 'next',
      }),
    });
    const { res, result } = response();

    await handlers.listAvailableProjectFiles(
      request({
        params: { projectId },
        query: { limit: '2', cursor: projectId, search: 'candidate' },
      }),
      res,
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ files: [{ file_id: 'candidate' }] });
    expect(result.body).not.toHaveProperty('files.0.text');
  });

  it.each([{ limit: '0' }, { limit: '51' }, { limit: '1.5' }, { limit: 'nope' }])(
    'rejects invalid available-file limit %# before project access',
    async (query) => {
      const { handlers, deps } = setup();
      const { res, result } = response();
      await handlers.listAvailableProjectFiles(request({ params: { projectId }, query }), res);
      expect(result.statusCode).toBe(400);
      expect(deps.getChatProject).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed available-file cursors before project access', async () => {
    const { handlers, deps } = setup();
    const { res, result } = response();
    await handlers.listAvailableProjectFiles(
      request({ params: { projectId }, query: { cursor: 'malformed' } }),
      res,
    );
    expect(result.statusCode).toBe(400);
    expect(deps.getChatProject).not.toHaveBeenCalled();
  });
  it('denies available-file metadata for a foreign tenant', async () => {
    const { handlers, deps } = setup({
      getChatProject: jest.fn().mockResolvedValue({
        _id: projectId,
        tenantId: 'tenant-b',
        file_ids: [],
      }),
    });
    const { res, result } = response();
    await handlers.listAvailableProjectFiles(request({ params: { projectId } }), res);
    expect(result.statusCode).toBe(404);
    expect(deps.getAvailableProjectFiles).not.toHaveBeenCalled();
  });
});
