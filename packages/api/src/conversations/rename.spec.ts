import express from 'express';
import request from 'supertest';
import type { AppConfig, ConversationMethods } from '@librechat/data-schemas';
import { createRenameConversationHandler, getConversationTitleCapabilities } from './rename';

type RenameHandler = ReturnType<typeof createRenameConversationHandler>;
type RenameRequest = Parameters<RenameHandler>[0];

function setup(
  options: {
    enabled?: boolean;
    current?: RenameRequest['resolvedConversation'];
    authenticated?: boolean;
  } = {},
) {
  const config: AppConfig = {
    interfaceConfig: { runningChatRename: options.enabled ?? true },
  } as AppConfig;
  const deps = {
    saveConvo: jest
      .fn<
        ReturnType<ConversationMethods['saveConvo']>,
        Parameters<ConversationMethods['saveConvo']>
      >()
      .mockResolvedValue({
        conversationId: 'chat',
        title: 'New Chat',
        titleSetByUser: true,
        titleRevision: 1,
      } as Awaited<ReturnType<ConversationMethods['saveConvo']>>),
    getActiveRunIds: jest.fn().mockResolvedValue([]),
    logger: { error: jest.fn() },
  };
  const handler = createRenameConversationHandler(deps);
  const app = express();
  app.use(express.json());
  app.post('/rename', async (req, res) => {
    await handler(
      {
        body: req.body,
        user: options.authenticated === false ? undefined : { id: 'owner', tenantId: 'tenant' },
        config,
        resolvedConversation:
          options.current === undefined ? { title: 'Established chat' } : options.current,
      },
      res,
    );
  });
  return { app, deps, config };
}

const arg = { conversationId: 'chat', title: 'New Chat' };

describe('rename conversation', () => {
  it('claims an unchanged placeholder without rewriting messages or upserting', async () => {
    const { app, deps } = setup({ current: { title: 'New Chat' } });
    const response = await request(app).post('/rename').send({ arg });
    expect(response.status).toBe(201);
    expect(response.body.titleSetByUser).toBe(true);
    expect(deps.saveConvo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
      arg,
      expect.objectContaining({ titleSource: 'manual', appendMessageIds: [], noUpsert: true }),
    );
    expect(deps.getActiveRunIds).not.toHaveBeenCalled();
  });
  it.each([undefined, null, { title: 'New Chat' }, { title: '' }])(
    'fences unowned pending-title records during rollout: %j',
    async (current) => {
      const { app, deps } = setup({ enabled: false, current: current ?? null });
      expect((await request(app).post('/rename').send({ arg })).status).toBe(409);
      expect(deps.saveConvo).not.toHaveBeenCalled();
    },
  );
  it('fences an older active writer even if its row already has a real title', async () => {
    const { app, deps } = setup({ enabled: false });
    deps.getActiveRunIds.mockResolvedValue(['old-replica-run']);
    const response = await request(app).post('/rename').send({ arg });
    expect(response.status).toBe(409);
    expect(deps.getActiveRunIds).toHaveBeenCalledWith('owner', ['chat'], 'tenant');
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });
  it('retains rename for a settled titled conversation before the rollout fence opens', async () => {
    const { app, deps } = setup({ enabled: false });
    expect((await request(app).post('/rename').send({ arg })).status).toBe(201);
    expect(deps.saveConvo).toHaveBeenCalledTimes(1);
  });
  it('allows a settled owned placeholder while the rollout fence is off', async () => {
    const { app } = setup({ enabled: false, current: { title: 'New Chat', titleSetByUser: true } });
    expect((await request(app).post('/rename').send({ arg })).status).toBe(201);
  });
  it.each([
    {},
    { conversationId: 'chat' },
    { conversationId: 1, title: 'x' },
    { conversationId: 'chat', title: 1 },
  ])('rejects malformed title writes %j', async (arg) => {
    const { app, deps } = setup();
    expect((await request(app).post('/rename').send({ arg })).status).toBe(400);
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });
  it('does not write without an authenticated owner', async () => {
    const { app, deps } = setup({ authenticated: false });
    expect((await request(app).post('/rename').send({ arg })).status).toBe(401);
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });
  it('trims and bounds titles while preserving the resolved retention context', async () => {
    const expiredAt = new Date('2027-01-01');
    const { app, deps } = setup({ current: { title: 'Chat', isTemporary: true, expiredAt } });
    await request(app)
      .post('/rename')
      .send({ arg: { ...arg, title: `  ${'x'.repeat(1100)} ` } });
    expect(deps.saveConvo).toHaveBeenCalledWith(
      expect.objectContaining({ isTemporary: true, expiredAt }),
      { ...arg, title: 'x'.repeat(1024) },
      expect.anything(),
    );
  });
  it('blocks protected title content without publishing or saving it', async () => {
    const { app, config, deps } = setup();
    config.filters = {
      conversationTitles: {
        pii: {
          starterPatterns: [],
          customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
        },
      },
    };
    const response = await request(app)
      .post('/rename')
      .send({ arg: { ...arg, title: 'BLOCKED-TITLE' } });
    expect(response.status).toBe(400);
    expect(deps.saveConvo).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('BLOCKED-TITLE');
  });
  it.each([null, { message: 'private-storage-failure' }])(
    'distinguishes absence from failed persistence',
    async (saved) => {
      const { app, deps } = setup();
      deps.saveConvo.mockResolvedValue(saved);
      const response = await request(app).post('/rename').send({ arg });
      expect(response.status).toBe(saved === null ? 404 : 500);
      expect(JSON.stringify(response.body)).not.toContain('private-storage-failure');
    },
  );
  it('owns active-run lookup failures without writing or exposing diagnostics', async () => {
    const { app, deps } = setup({ enabled: false });
    deps.getActiveRunIds.mockRejectedValue(new Error('secret-worker-payload'));
    const response = await request(app).post('/rename').send({ arg });
    expect(response.status).toBe(500);
    expect(response.text).toBe('Error updating conversation');
    expect(deps.logger.error).toHaveBeenCalledWith('[rename] Conversation title update failed', {
      type: 'Error',
    });
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });
});

describe('title ownership capability', () => {
  it('advertises the protocol only after deployment opt-in', () => {
    expect(getConversationTitleCapabilities(undefined)).toEqual({});
    expect(
      getConversationTitleCapabilities({
        runningChatRename: false,
      } as AppConfig['interfaceConfig']),
    ).toEqual({});
    expect(
      getConversationTitleCapabilities({ runningChatRename: true } as AppConfig['interfaceConfig']),
    ).toEqual({ conversationTitleOwnershipVersion: 1 });
  });
});
