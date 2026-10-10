import type { CanonicalProjectResource, ProjectFileRecord } from './resources';
import { getChatProjectContextKey, resolveChatProjectContext } from './context';
import { PARTIAL_RESOLVED_CONVERSATION } from '../agents/conversationSymbols';
import { toCanonicalProjectResource } from './resources';

const project = {
  _id: 'project-a',
  instructions: 'Use the project policy.',
  contextRevision: 3,
  file_ids: ['file-a'],
};
const getProjectFiles = jest.fn().mockResolvedValue([]);

const missingResources = (fileIds: string[]): CanonicalProjectResource[] =>
  fileIds.map((file_id) => ({
    file_id,
    identity: 'missing',
    availability: 'unavailable',
    version: 'missing',
  }));

describe('resolveChatProjectContext', () => {
  it('uses existing conversation membership over a request project override', async () => {
    const getChatProject = jest.fn().mockResolvedValue(project);
    const context = await resolveChatProjectContext(
      {
        userId: 'user-a',
        conversationId: 'conversation-a',
        requestedProjectId: 'project-b',
        resolvedConversation: { conversationId: 'conversation-a', chatProjectId: 'project-a' },
      },
      { getConvo: jest.fn(), getChatProject, getProjectFiles },
    );

    expect(context?.projectId).toBe('project-a');
    expect(getChatProject).toHaveBeenCalledWith('user-a', 'project-a');
    expect(getChatProject).toHaveBeenCalledTimes(1);
  });
  it('keeps authorized guidance available when the unused resource lookup would fail', async () => {
    const getChatProject = jest.fn().mockResolvedValue(project);
    const getProjectFiles = jest
      .fn()
      .mockRejectedValue(new Error('Project resource lookup unavailable'));

    const guidanceOnly = await resolveChatProjectContext(
      { userId: 'user-a', requestedProjectId: 'project-a', includeResources: false },
      { getConvo: jest.fn(), getChatProject, getProjectFiles },
    );
    expect(guidanceOnly).toEqual(
      expect.objectContaining({
        projectId: 'project-a',
        instructions: 'Use the project policy.',
        file_ids: ['file-a'],
        resources: [],
      }),
    );
    expect(getProjectFiles).not.toHaveBeenCalled();

    await expect(
      resolveChatProjectContext(
        { userId: 'user-a', requestedProjectId: 'project-a' },
        { getConvo: jest.fn(), getChatProject, getProjectFiles },
      ),
    ).rejects.toThrow('Project resource lookup unavailable');
    expect(getProjectFiles).toHaveBeenCalledTimes(1);
  });

  it('preserves an authoritative unscoped conversation', async () => {
    const getChatProject = jest.fn();
    await expect(
      resolveChatProjectContext(
        {
          userId: 'user-a',
          conversationId: 'conversation-a',
          requestedProjectId: 'project-a',
          resolvedConversation: { conversationId: 'conversation-a', chatProjectId: null },
        },
        { getConvo: jest.fn(), getChatProject, getProjectFiles },
      ),
    ).resolves.toBeNull();
    expect(getChatProject).not.toHaveBeenCalled();
  });

  it('does not reassign legacy conversations that have no membership field', async () => {
    await expect(
      resolveChatProjectContext(
        {
          userId: 'user-a',
          conversationId: 'conversation-a',
          requestedProjectId: 'project-a',
          resolvedConversation: { conversationId: 'conversation-a' },
        },
        {
          getConvo: jest.fn(),
          getChatProject: jest.fn().mockResolvedValue(project),
          getProjectFiles,
        },
      ),
    ).resolves.toBeNull();
  });

  it('reloads partial event snapshots instead of inheriting their stale Project', async () => {
    const partial = {
      conversationId: 'conversation-a',
      chatProjectId: 'stale-project',
      [PARTIAL_RESOLVED_CONVERSATION]: true,
    };
    const context = await resolveChatProjectContext(
      {
        userId: 'user-a',
        conversationId: 'conversation-a',
        resolvedConversation: partial,
      },
      {
        getConvo: jest.fn().mockResolvedValue({
          conversationId: 'conversation-a',
          chatProjectId: 'project-a',
        }),
        getChatProject: jest.fn().mockResolvedValue(project),
        getProjectFiles,
      },
    );
    expect(context?.projectId).toBe('project-a');
  });

  it('rejects a Project from a different or missing tenant scope', async () => {
    for (const projectTenant of ['tenant-b', undefined]) {
      await expect(
        resolveChatProjectContext(
          { userId: 'user-a', tenantId: 'tenant-a', requestedProjectId: 'project-a' },
          {
            getConvo: jest.fn(),
            getChatProject: jest.fn().mockResolvedValue({ ...project, tenantId: projectTenant }),
            getProjectFiles,
          },
        ),
      ).rejects.toThrow('Project context unavailable');
    }
  });

  it('degrades to no project context when the stored membership project is unavailable', async () => {
    for (const storedProject of [null, { ...project, tenantId: 'tenant-b' }]) {
      await expect(
        resolveChatProjectContext(
          {
            userId: 'user-a',
            tenantId: 'tenant-a',
            conversationId: 'conversation-a',
            requestedProjectId: 'project-b',
            resolvedConversation: {
              conversationId: 'conversation-a',
              chatProjectId: 'project-a',
              tenantId: 'tenant-a',
            },
          },
          {
            getConvo: jest.fn(),
            getChatProject: jest.fn().mockResolvedValue(storedProject),
            getProjectFiles,
          },
        ),
      ).resolves.toBeNull();
    }
  });

  it('degrades when a loaded conversation references an unavailable project', async () => {
    const getConvo = jest
      .fn()
      .mockResolvedValue({ conversationId: 'conversation-a', chatProjectId: 'project-a' });
    const getChatProject = jest.fn().mockResolvedValue(null);
    await expect(
      resolveChatProjectContext(
        { userId: 'user-a', conversationId: 'conversation-a' },
        { getConvo, getChatProject, getProjectFiles },
      ),
    ).resolves.toBeNull();
    expect(getChatProject).toHaveBeenCalledWith('user-a', 'project-a');
  });

  it('rejects an unauthorized requested project for a new conversation', async () => {
    await expect(
      resolveChatProjectContext(
        { userId: 'user-a', requestedProjectId: 'project-a' },
        { getConvo: jest.fn(), getChatProject: jest.fn().mockResolvedValue(null), getProjectFiles },
      ),
    ).rejects.toThrow('Project context unavailable');
  });
  it('keeps the resume key stable for normalized file identities', () => {
    const file: ProjectFileRecord = {
      _id: '507f1f77bcf86cd799439011',
      file_id: 'file-a',
      filename: 'file-a.txt',
      filepath: '/uploads/file-a.txt',
      object: 'file',
      type: 'text/plain',
      bytes: 12,
      usage: 0,
      embedded: true,
      context: 'message_attachment',
      user: 'user-a',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const makeContext = () => ({
      projectId: 'project-a',
      contextRevision: 1,
      instructions: '',
      file_ids: ['file-a'],
      resources: [toCanonicalProjectResource({ ...file })],
    });

    const first = makeContext();
    const second = makeContext();
    expect(first.resources[0]?.identity).toBe(file._id);
    expect(getChatProjectContextKey(first)).toBe(getChatProjectContextKey(second));
  });

  it('changes its stable key when revision or resources change without exposing instructions', () => {
    const first = getChatProjectContextKey({
      projectId: 'project-a',
      contextRevision: 1,
      instructions: 'secret one',
      file_ids: ['file-a'],
      resources: missingResources(['file-a']),
    });
    const second = getChatProjectContextKey({
      projectId: 'project-a',
      contextRevision: 2,
      instructions: 'secret two',
      file_ids: ['file-b'],
      resources: missingResources(['file-b']),
    });

    expect(first).not.toContain('secret');
    expect(first).not.toBe(second);
  });

  it('keeps distinct file ID sequences distinct in the resume key', () => {
    const first = getChatProjectContextKey({
      projectId: 'project-a',
      contextRevision: 1,
      instructions: '',
      file_ids: ['a', 'b,c'],
      resources: missingResources(['a', 'b,c']),
    });
    const second = getChatProjectContextKey({
      projectId: 'project-a',
      contextRevision: 1,
      instructions: '',
      file_ids: ['a,b', 'c'],
      resources: missingResources(['a,b', 'c']),
    });

    expect(first).not.toBe(second);
  });
});
