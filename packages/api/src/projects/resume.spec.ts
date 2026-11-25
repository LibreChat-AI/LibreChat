import type { ResumeProjectContextRequest } from './resume';
import {
  resolveResumeProjectContext,
  hasResumeProjectContextChanged,
  PROJECT_CONTEXT_CHANGED_REASON,
  rejectChangedResumeProjectContext,
} from './resume';
import { getChatProjectContextKey } from './context';

const project = {
  _id: 'project-a',
  tenantId: 'tenant-a',
  instructions: 'Use the project policy.',
  contextRevision: 3,
  file_ids: [],
};
const conversation = {
  conversationId: 'conversation-a',
  chatProjectId: 'project-a',
  user: 'user-a',
  tenantId: 'tenant-a',
};
const currentKey = getChatProjectContextKey({
  projectId: 'project-a',
  contextRevision: 3,
  instructions: project.instructions,
  file_ids: [],
  resources: [],
});

const createReq = (overrides: Partial<ResumeProjectContextRequest> = {}) =>
  ({
    user: { id: 'user-a', tenantId: 'tenant-a' },
    ...overrides,
  }) as ResumeProjectContextRequest;

const createDeps = (storedProject: object | null = project) => ({
  getConvo: jest.fn().mockResolvedValue(conversation),
  getChatProject: jest.fn().mockResolvedValue(storedProject),
  getProjectFiles: jest.fn().mockResolvedValue([]),
  logger: { warn: jest.fn(), error: jest.fn() },
  finalizeJob: jest.fn().mockResolvedValue(true),
  deleteCheckpoint: jest.fn().mockResolvedValue(undefined),
});

describe('resolveResumeProjectContext', () => {
  it('refreshes the conversation and clears cached project hydration', async () => {
    const req = createReq({
      resolvedConversation: { conversationId: 'stale' },
      chatProjectFiles: [],
      chatProjectFilesPromise: Promise.resolve([]),
    });
    const deps = createDeps();
    const context = await resolveResumeProjectContext(req, 'conversation-a', false, deps);
    expect(context?.projectId).toBe('project-a');
    expect(deps.getConvo).toHaveBeenCalledWith('user-a', 'conversation-a');
    expect(req.resolvedConversation).toBe(conversation);
    expect(req.chatProjectFiles).toBeUndefined();
    expect(req.chatProjectFilesPromise).toBeUndefined();
    expect(req.chatProjectContext).toBe(context);
  });

  it('uses the event binding tenant for a bound child conversation', async () => {
    const req = createReq({
      user: { id: 'user-a', tenantId: 'tenant-user' },
      _agentEventBindingParentConversationId: 'parent',
      _agentEventBindingTenantId: 'tenant-a',
    });
    const context = await resolveResumeProjectContext(req, 'conversation-a', false, createDeps());
    expect(context?.projectId).toBe('project-a');
  });

  it('treats a stored membership whose project is unavailable as no project context', async () => {
    const deps = createDeps({ ...project, tenantId: 'tenant-b' });
    const req = createReq();
    await expect(
      resolveResumeProjectContext(req, 'conversation-a', false, deps),
    ).resolves.toBeNull();
    expect(req.chatProjectContext).toBeNull();
  });
});

describe('hasResumeProjectContextChanged', () => {
  it('accepts an unchanged key without hydrating resources', async () => {
    const deps = createDeps();
    await expect(
      hasResumeProjectContextChanged(
        { req: createReq(), conversationId: 'conversation-a', expectedKey: currentKey },
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.getProjectFiles).not.toHaveBeenCalled();
  });

  it('rejects a changed revision after rehydrating resources', async () => {
    const deps = createDeps({ ...project, contextRevision: 4 });
    await expect(
      hasResumeProjectContextChanged(
        { req: createReq(), conversationId: 'conversation-a', expectedKey: currentKey },
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.getConvo).toHaveBeenCalledTimes(2);
  });

  it('resumes a legacy pause with no recorded key under the current project context', async () => {
    const deps = createDeps();
    const req = createReq();
    await expect(
      hasResumeProjectContextChanged(
        { req, conversationId: 'conversation-a', expectedKey: undefined },
        deps,
      ),
    ).resolves.toBe(false);
    expect(req.chatProjectContext?.instructions).toBe(project.instructions);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('without a recorded project context key'),
      { conversationId: 'conversation-a', projectId: 'project-a' },
    );
  });

  it('does not warn for a legacy pause without model-facing project context', async () => {
    const deps = createDeps({ ...project, instructions: '' });
    await expect(
      hasResumeProjectContextChanged(
        { req: createReq(), conversationId: 'conversation-a', expectedKey: undefined },
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});

describe('rejectChangedResumeProjectContext', () => {
  const params = { conversationId: 'conversation-a', expectedKey: currentKey };

  it('does not finalize an unchanged resume', async () => {
    const deps = createDeps();
    await expect(
      rejectChangedResumeProjectContext({ ...params, req: createReq() }, deps),
    ).resolves.toBe(false);
    expect(deps.finalizeJob).not.toHaveBeenCalled();
  });

  it('finalizes and prunes a changed resume', async () => {
    const deps = createDeps(null);
    await expect(
      rejectChangedResumeProjectContext({ ...params, req: createReq() }, deps),
    ).resolves.toBe(true);
    expect(deps.finalizeJob).toHaveBeenCalledWith(PROJECT_CONTEXT_CHANGED_REASON);
    expect(deps.deleteCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('skips pruning when the terminal CAS is lost and tolerates prune failures', async () => {
    const lost = createDeps(null);
    lost.finalizeJob.mockResolvedValue(false);
    await rejectChangedResumeProjectContext({ ...params, req: createReq() }, lost);
    expect(lost.deleteCheckpoint).not.toHaveBeenCalled();

    const pruneFails = createDeps(null);
    pruneFails.deleteCheckpoint.mockRejectedValue(new Error('checkpoint store down'));
    await expect(
      rejectChangedResumeProjectContext({ ...params, req: createReq() }, pruneFails),
    ).resolves.toBe(true);
    expect(pruneFails.logger.warn).toHaveBeenCalled();
  });

  it('propagates a terminalization failure', async () => {
    const deps = createDeps(null);
    deps.finalizeJob.mockRejectedValue(new Error('redis unavailable'));
    await expect(
      rejectChangedResumeProjectContext({ ...params, req: createReq() }, deps),
    ).rejects.toThrow('redis unavailable');
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
