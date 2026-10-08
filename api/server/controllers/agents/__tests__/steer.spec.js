const express = require('express');
const request = require('supertest');

const mockHandleSteerRequest = jest.fn();
const mockHandleSteerCancel = jest.fn();
const mockHandleSteerArm = jest.fn();
const mockCheckAccess = jest.fn();
const mockCheckPermission = jest.fn();
const mockHasCapability = jest.fn();
const mockGetAgent = jest.fn();
const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() };

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: { isRedis: false },
  handleSteerRequest: (...args) => mockHandleSteerRequest(...args),
  handleSteerCancel: (...args) => mockHandleSteerCancel(...args),
  handleSteerArm: (...args) => mockHandleSteerArm(...args),
  checkAccess: (...args) => mockCheckAccess(...args),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: (...args) => mockCheckPermission(...args),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: (...args) => mockHasCapability(...args),
}));

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  getAgent: (...args) => mockGetAgent(...args),
  getFiles: jest.fn(),
  updateFilesUsage: jest.fn(),
}));

const { Permissions, PermissionTypes, PermissionBits } = require('librechat-data-provider');
const SteerController = require('~/server/controllers/agents/steer');
const { SteerDeliveryController, SteerCancelController, SteerArmController } = SteerController;

const GENERATION_PROTOCOL_HEADER = 'x-librechat-generation-protocol';

/**
 * The guard ladder itself (validation, file sanitization, ownership, enqueue
 * codes) is typed logic in `@librechat/api` and is covered against the REAL
 * in-memory job manager by `packages/api/src/agents/steering/__tests__/request.spec.ts`.
 * This spec only pins the thin wrapper contract: pass-through of user/body,
 * verbatim status/body serialization, and the 500 failure envelope.
 */
function buildApp(user = { id: 'user-1', tenantId: 'tenant-1' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.post('/chat/steer', SteerController);
  app.post('/chat/steer/deliver', SteerDeliveryController);
  app.post('/chat/steer/cancel', SteerCancelController);
  app.post('/chat/steer/arm', SteerArmController);
  return app;
}

describe('SteerController (wrapper)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults an unmarked request to v1 and serializes the marker in body and header', async () => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 202,
      body: {
        status: 'queued',
        steerId: 's1',
        position: 1,
        conversationId: 'c1',
        generationProtocolVersion: 1,
      },
    });

    const res = await request(buildApp())
      .post('/chat/steer')
      .send({ conversationId: 'c1', text: 'hello', files: [{ file_id: 'f1' }] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      status: 'queued',
      steerId: 's1',
      position: 1,
      conversationId: 'c1',
      generationProtocolVersion: 1,
    });
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('1');
    expect(mockHandleSteerRequest).toHaveBeenCalledWith(
      { id: 'user-1', tenantId: 'tenant-1' },
      { conversationId: 'c1', text: 'hello', files: [{ file_id: 'f1' }] },
      {
        generationProtocolVersion: 1,
        signal: expect.any(AbortSignal),
        getFiles: expect.any(Function),
        updateFilesUsage: expect.any(Function),
        checkAgentAccess: expect.any(Function),
      },
    );
  });

  it('passes rejection statuses through untouched', async () => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 409,
      body: { code: 'RUN_PAUSED', generationProtocolVersion: 1 },
    });

    const res = await request(buildApp()).post('/chat/steer').send({ conversationId: 'c1' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RUN_PAUSED');
    expect(res.body.generationProtocolVersion).toBe(1);
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('1');
  });

  it('makes trigger delivery strict and fences it to the declared agent', async () => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 202,
      body: { status: 'queued', generationProtocolVersion: 2 },
    });
    mockCheckAccess.mockResolvedValue(true);
    mockHasCapability.mockResolvedValue(true);

    await request(buildApp({ id: 'user-1', role: 'USER' }))
      .post('/chat/steer/deliver')
      .set('X-LibreChat-Generation-Protocol', '2')
      .send({
        agentId: 'agent-1',
        conversationId: 'c1',
        clientSteerId: 'delivery-1',
        text: 'move now',
        generationProtocolVersion: 2,
      });

    const options = mockHandleSteerRequest.mock.calls[0][2];
    expect(options).toEqual(
      expect.objectContaining({
        generationProtocolVersion: 2,
        requireIdempotentDelivery: true,
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(
      options.checkAgentAccess({ agentId: 'agent-1', endpoint: 'agents' }),
    ).resolves.toBe(true);
    await expect(
      options.checkAgentAccess({ agentId: 'agent-other', endpoint: 'agents' }),
    ).resolves.toBe(false);
    await expect(
      options.checkAgentAccess({ agentId: 'agent-1', endpoint: 'openAI' }),
    ).resolves.toBe(false);
  });

  it('500s with STEER_FAILED when the handler throws', async () => {
    mockHandleSteerRequest.mockRejectedValue(new Error('store down'));

    const res = await request(buildApp())
      .post('/chat/steer')
      .send({ conversationId: 'c1', text: 'x' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'STEER_FAILED', generationProtocolVersion: 1 });
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('1');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('passes an exact body+header v2 marker through the server rollout gate', async () => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 202,
      body: { status: 'queued', generationProtocolVersion: 2 },
    });

    const res = await request(buildApp())
      .post('/chat/steer')
      .set('X-LibreChat-Generation-Protocol', '2')
      .send({ conversationId: 'c1', text: 'hello', generationProtocolVersion: 2 });

    expect(mockHandleSteerRequest.mock.calls[0][2]).toEqual(
      expect.objectContaining({ generationProtocolVersion: 2 }),
    );
    expect(res.body.generationProtocolVersion).toBe(2);
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('2');
  });

  it.each([
    ['conflicting', '1'],
    ['malformed', 'not-a-version'],
  ])('downgrades %s body/header markers to v1', async (_label, header) => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 202,
      body: { status: 'queued', generationProtocolVersion: 1 },
    });

    const res = await request(buildApp())
      .post('/chat/steer')
      .set('X-LibreChat-Generation-Protocol', header)
      .send({ conversationId: 'c1', text: 'hello', generationProtocolVersion: 2 });

    expect(mockHandleSteerRequest.mock.calls[0][2]).toEqual(
      expect.objectContaining({ generationProtocolVersion: 1 }),
    );
    expect(res.body.generationProtocolVersion).toBe(1);
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('1');
  });

  it('passes an exact v2 advertisement to the package host contract', async () => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 202,
      body: { status: 'queued', generationProtocolVersion: 2 },
    });
    await request(buildApp())
      .post('/chat/steer')
      .set('X-LibreChat-Generation-Protocol', '2')
      .send({ conversationId: 'c1', text: 'hello', generationProtocolVersion: 2 });

    expect(mockHandleSteerRequest.mock.calls[0][2]).toEqual(
      expect.objectContaining({ generationProtocolVersion: 2 }),
    );
  });

  it('uses the package job cap, not the host maximum, for the final response marker', async () => {
    mockHandleSteerRequest.mockResolvedValue({
      status: 202,
      body: { status: 'queued', generationProtocolVersion: 1 },
    });

    const res = await request(buildApp())
      .post('/chat/steer')
      .set('X-LibreChat-Generation-Protocol', '2')
      .send({ conversationId: 'c1', text: 'hello', generationProtocolVersion: 2 });

    expect(mockHandleSteerRequest.mock.calls[0][2].generationProtocolVersion).toBe(2);
    expect(res.body.generationProtocolVersion).toBe(1);
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('1');
  });

  it.each([
    ['/chat/steer/cancel', mockHandleSteerCancel, { conversationId: 'c1', steerId: 's1' }],
    ['/chat/steer/arm', mockHandleSteerArm, { conversationId: 'c1', steerId: 's1' }],
  ])('negotiates and echoes protocol markers for %s', async (path, handler, body) => {
    handler.mockResolvedValue({
      status: 200,
      body: { ok: true, generationProtocolVersion: 2 },
    });

    const res = await request(buildApp())
      .post(path)
      .set('X-LibreChat-Generation-Protocol', '2')
      .send({ ...body, generationProtocolVersion: 2 });

    expect(handler).toHaveBeenCalledWith(
      { id: 'user-1', tenantId: 'tenant-1' },
      { ...body, generationProtocolVersion: 2 },
      { generationProtocolVersion: 2 },
    );
    expect(res.body.generationProtocolVersion).toBe(2);
    expect(res.headers[GENERATION_PROTOCOL_HEADER]).toBe('2');
  });
});

describe('createAgentAccessCheck (chat-route parity via job identity)', () => {
  /** Posts a steer to capture the wired deps, then exercises the callback. */
  async function captureAccessCheck(user) {
    mockHandleSteerRequest.mockResolvedValue({ status: 202, body: {} });
    await request(buildApp(user)).post('/chat/steer').send({ conversationId: 'c1', text: 'x' });
    return mockHandleSteerRequest.mock.calls[0][2].checkAgentAccess;
  }

  const roleUser = { id: 'user-1', tenantId: 'tenant-1', role: 'USER' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAccess.mockResolvedValue(true);
    mockHasCapability.mockResolvedValue(false);
    mockGetAgent.mockResolvedValue({ _id: 'oid-1', id: 'agent_abc' });
    mockCheckPermission.mockResolvedValue(true);
  });

  it('denies an agents run when the AGENTS:USE role gate fails, skipping resource calls', async () => {
    mockCheckAccess.mockResolvedValue(false);
    const check = await captureAccessCheck(roleUser);

    await expect(check({ agentId: 'agent_abc', endpoint: 'agents' })).resolves.toBe(false);
    expect(mockCheckAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
      }),
    );
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it('runs the VIEW resource check against the resolved agent', async () => {
    const check = await captureAccessCheck(roleUser);

    await expect(check({ agentId: 'agent_abc', endpoint: 'agents' })).resolves.toBe(true);
    expect(mockGetAgent).toHaveBeenCalledWith({ id: 'agent_abc' });
    expect(mockCheckPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        resourceId: 'oid-1',
        requiredPermission: PermissionBits.VIEW,
      }),
    );
  });

  it('denies when the agent is gone or the ACL check fails', async () => {
    const check = await captureAccessCheck(roleUser);

    mockGetAgent.mockResolvedValueOnce(null);
    await expect(check({ agentId: 'agent_abc', endpoint: 'agents' })).resolves.toBe(false);

    mockCheckPermission.mockResolvedValueOnce(false);
    await expect(check({ agentId: 'agent_abc', endpoint: 'agents' })).resolves.toBe(false);
  });

  it('honors the capability bypass without touching the agent or ACL', async () => {
    mockHasCapability.mockResolvedValue(true);
    const check = await captureAccessCheck(roleUser);

    await expect(check({ agentId: 'agent_abc', endpoint: 'agents' })).resolves.toBe(true);
    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it('allows ephemeral runs with no role gate (skipAgentCheck parity for non-agents endpoints)', async () => {
    const check = await captureAccessCheck(roleUser);

    await expect(check({ agentId: undefined, endpoint: 'openAI' })).resolves.toBe(true);
    expect(mockCheckAccess).not.toHaveBeenCalled();
    expect(mockCheckPermission).not.toHaveBeenCalled();
  });

  it('applies both gates when metadata has a real agent but no endpoint yet', async () => {
    const check = await captureAccessCheck(roleUser);

    await expect(check({ agentId: 'agent_abc', endpoint: undefined })).resolves.toBe(true);
    expect(mockCheckAccess).toHaveBeenCalled();
    expect(mockCheckPermission).toHaveBeenCalled();
  });
});
