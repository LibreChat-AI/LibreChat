import type { AppConfig } from '@librechat/data-schemas';
import {
  getChatProjectTurnFailure,
  resolveAssistantProjectTurn,
  assertChatProjectInstructions,
  resolveApiConversationProject,
  ChatProjectResourcesChangedError,
  resolveInitializationProjectContext,
} from './turn';
import { assertModelBoundContent } from '../middleware/modelBoundContent';
import { CHAT_PROJECT_CONTEXT_UNAVAILABLE } from './context';

const pattern = { id: 'secret', label: 'secret code', regex: 'SECRET-[0-9]+' };
const filters = {
  agentInstructions: {
    pii: { fields: ['instructions'], starterPatterns: [], customPatterns: [pattern] },
  },
} as AppConfig['filters'];
const legacyPii = { customPatterns: [pattern] };
const project = {
  _id: 'project-a',
  instructions: 'Use the project policy.',
  contextRevision: 2,
  file_ids: [],
};
const getProjectFiles = jest.fn().mockResolvedValue([]);
const logger = { warn: jest.fn(), error: jest.fn() };

describe('getChatProjectTurnFailure', () => {
  it('maps changed project resources to a retryable conflict', () => {
    expect(getChatProjectTurnFailure(new ChatProjectResourcesChangedError())).toEqual({
      status: 409,
      code: 'PROJECT_RESOURCES_CHANGED',
      error: expect.stringContaining('retry'),
      retryable: true,
    });
  });

  it('maps an unavailable project to not found and ignores unrelated errors', () => {
    expect(getChatProjectTurnFailure(new Error(CHAT_PROJECT_CONTEXT_UNAVAILABLE))).toEqual({
      status: 404,
      error: 'Conversation context unavailable',
    });
    expect(getChatProjectTurnFailure(new Error('boom'))).toBeNull();
  });

  it('maps a project guidance policy rejection to its response body', () => {
    let rejection: unknown;
    try {
      assertChatProjectInstructions({
        context: { ...project, projectId: 'project-a', instructions: 'SECRET-42', resources: [] },
        filters,
      });
    } catch (error) {
      rejection = error;
    }
    expect(getChatProjectTurnFailure(rejection)).toEqual(
      expect.objectContaining({ status: 400, error: 'content_filter_block' }),
    );
  });
});

describe('assertChatProjectInstructions', () => {
  const context = (instructions: string) => ({
    projectId: 'project-a',
    contextRevision: 1,
    instructions,
    file_ids: [],
    resources: [],
  });

  it('applies the agent instruction filters to project guidance', () => {
    expect(() =>
      assertChatProjectInstructions({ context: context('Reference SECRET-42'), filters }),
    ).toThrow();
    expect(() =>
      assertChatProjectInstructions({ context: context('Nothing sensitive'), filters }),
    ).not.toThrow();
  });

  it('keeps legacy message PII scoped away from instructions', () => {
    expect(() =>
      assertModelBoundContent({
        legacyPii,
        agents: [{ instructions: 'Reference SECRET-42' }],
      }),
    ).not.toThrow();
  });

  it('skips absent or blank guidance', () => {
    expect(() => assertChatProjectInstructions({ context: null, filters })).not.toThrow();
    expect(() => assertChatProjectInstructions({ context: context('  '), filters })).not.toThrow();
  });
});

describe('resolveApiConversationProject', () => {
  const deps = (conversation: object | null, storedProject: object | null = project) => ({
    getConvo: jest.fn().mockResolvedValue(conversation),
    getChatProject: jest.fn().mockResolvedValue(storedProject),
    getProjectFiles,
    logger,
    logPrefix: '[Test]',
  });

  it('returns the stored conversation and its project guidance', async () => {
    const conversation = { conversationId: 'conversation-a', chatProjectId: 'project-a' };
    const result = await resolveApiConversationProject(
      { userId: 'user-a', conversationId: 'conversation-a' },
      deps(conversation),
    );
    expect(result).toEqual({
      ok: true,
      conversation,
      context: expect.objectContaining({ projectId: 'project-a', resources: [] }),
    });
  });

  it('degrades a stored membership whose project is gone', async () => {
    const result = await resolveApiConversationProject(
      { userId: 'user-a', conversationId: 'conversation-a' },
      deps({ conversationId: 'conversation-a', chatProjectId: 'project-a' }, null),
    );
    expect(result).toEqual(expect.objectContaining({ ok: true, context: null }));
  });

  it('rejects missing and read-only conversations', async () => {
    await expect(
      resolveApiConversationProject(
        { userId: 'user-a', conversationId: 'conversation-a' },
        deps(null),
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 404, reason: 'not_found' }));
    await expect(
      resolveApiConversationProject(
        { userId: 'user-a', conversationId: 'conversation-a', rejectSubagentThread: true },
        deps({ conversationId: 'conversation-a', subagentThread: { parentConversationId: 'p' } }),
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 409, reason: 'read_only' }));
  });

  it('maps a foreign-tenant conversation to not found and read failures to server errors', async () => {
    await expect(
      resolveApiConversationProject(
        { userId: 'user-a', tenantId: 'tenant-a', conversationId: 'conversation-a' },
        deps({ conversationId: 'conversation-a', tenantId: 'tenant-b' }),
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 404, reason: 'unavailable' }));

    const failing = deps(null);
    failing.getConvo.mockRejectedValueOnce(new Error('database down'));
    await expect(
      resolveApiConversationProject({ userId: 'user-a', conversationId: 'c' }, failing),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 500, reason: 'server_error' }));
    expect(logger.error).toHaveBeenCalledWith(
      '[Test] Conversation context resolution failed',
      expect.objectContaining({ type: 'Error' }),
    );
  });
});

describe('resolveAssistantProjectTurn', () => {
  it('seeds membership for a new conversation and formats guidance', async () => {
    const turn = await resolveAssistantProjectTurn(
      { userId: 'user-a', requestedProjectId: 'project-a' },
      {
        getConvo: jest.fn(),
        getChatProject: jest.fn().mockResolvedValue(project),
        getProjectFiles,
      },
    );
    expect(turn.rejection).toBeUndefined();
    if (turn.rejection) {
      return;
    }
    expect(turn.conversation).toBeNull();
    expect(turn.membershipProjectId).toBe('project-a');
    expect(turn.instructions).toContain(project.instructions);
  });

  it('keeps stored membership for an existing conversation', async () => {
    const getConvo = jest.fn().mockResolvedValue({ conversationId: 'c', chatProjectId: null });
    const turn = await resolveAssistantProjectTurn(
      { userId: 'user-a', conversationId: 'c', requestedProjectId: 'project-a' },
      { getConvo, getChatProject: jest.fn(), getProjectFiles },
    );
    expect(getConvo).toHaveBeenCalledWith('user-a', 'c');
    expect(turn).toEqual(
      expect.objectContaining({ context: null, instructions: '', membershipProjectId: null }),
    );
  });

  it('returns a not-found rejection for an unavailable requested project', async () => {
    const turn = await resolveAssistantProjectTurn(
      { userId: 'user-a', requestedProjectId: 'project-a' },
      { getConvo: jest.fn(), getChatProject: jest.fn().mockResolvedValue(null), getProjectFiles },
    );
    expect(turn.rejection).toEqual({
      status: 404,
      body: { error: 'Conversation context unavailable' },
    });
  });

  it('returns the policy rejection when guidance matches the instruction filters', async () => {
    const turn = await resolveAssistantProjectTurn(
      { userId: 'user-a', requestedProjectId: 'project-a', filters },
      {
        getConvo: jest.fn(),
        getChatProject: jest.fn().mockResolvedValue({ ...project, instructions: 'SECRET-7' }),
        getProjectFiles,
      },
    );
    expect(turn.rejection).toEqual({
      status: 400,
      body: expect.objectContaining({ error: 'content_filter_block' }),
    });
  });

  it('propagates unexpected read failures', async () => {
    await expect(
      resolveAssistantProjectTurn(
        { userId: 'user-a', requestedProjectId: 'project-a' },
        {
          getConvo: jest.fn(),
          getChatProject: jest.fn().mockRejectedValue(new Error('database down')),
          getProjectFiles,
        },
      ),
    ).rejects.toThrow('database down');
  });
});

describe('resolveInitializationProjectContext', () => {
  it('reuses an already-resolved context without reading', async () => {
    const getChatProject = jest.fn();
    const req = { user: { id: 'user-a' }, chatProjectContext: null };
    await expect(
      resolveInitializationProjectContext(
        { req, endpointOption: {}, conversationPromise: Promise.resolve(null) },
        { getConvo: jest.fn(), getChatProject, getProjectFiles },
      ),
    ).resolves.toBeNull();
    expect(getChatProject).not.toHaveBeenCalled();
  });

  it('resolves a bound child conversation in the event binding tenant', async () => {
    const getChatProject = jest.fn().mockResolvedValue({ ...project, tenantId: 'tenant-binding' });
    const req = {
      user: { id: 'user-a', tenantId: 'tenant-user' },
      body: { chatProjectId: 'project-a' },
      _agentEventBindingParentConversationId: 'parent',
      _agentEventBindingTenantId: 'tenant-binding',
    };
    const context = await resolveInitializationProjectContext(
      { req, endpointOption: {}, conversationPromise: Promise.resolve(null) },
      { getConvo: jest.fn(), getChatProject, getProjectFiles },
    );
    expect(context?.projectId).toBe('project-a');
    expect(getChatProject).toHaveBeenCalledWith('user-a', 'project-a');
  });
});
