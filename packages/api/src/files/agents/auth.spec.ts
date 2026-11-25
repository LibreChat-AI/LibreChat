import { SystemRoles, PermissionBits } from 'librechat-data-provider';
import { checkAgentUploadAuth, verifyAgentUploadPermission } from './auth';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

describe('checkAgentUploadAuth', () => {
  const agent = { _id: 'agent-object-id', author: { toString: () => 'owner-id' } };
  const getAgent = jest.fn().mockResolvedValue(agent);
  const checkPermission = jest.fn().mockResolvedValue(false);

  beforeEach(() => {
    jest.clearAllMocks();
    getAgent.mockResolvedValue(agent);
    checkPermission.mockResolvedValue(false);
  });

  it('denies a permanent upload with no tool resource from a user without edit permission', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'attacker-id', userRole: SystemRoles.USER, agentId: 'agent_victim01' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(false);
    expect(checkPermission).toHaveBeenCalled();
  });

  it('allows a permanent upload with no tool resource when the user may edit the agent', async () => {
    checkPermission.mockResolvedValue(true);

    const result = await checkAgentUploadAuth(
      { userId: 'editor-id', userRole: SystemRoles.USER, agentId: 'agent_shared01' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
  });

  it('reports a missing agent to an admin rather than proceeding', async () => {
    getAgent.mockResolvedValue(null);

    const result = await checkAgentUploadAuth(
      { userId: 'admin-id', userRole: SystemRoles.ADMIN, agentId: 'missing-agent' },
      { getAgent, checkPermission },
    );

    expect(result).toMatchObject({ allowed: false, status: 404 });
  });

  it('allows the agent author without consulting permissions', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'owner-id', userRole: SystemRoles.USER, agentId: 'agent_own0001' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('asks only for view access on a message attachment', async () => {
    /* The attachment belongs to the conversation rather than the agent, so edit access is
     * too much. Skipping the check entirely was too little: the upload is validated under
     * the named agent's provider, so its rejections describe a record the caller may not
     * be allowed to see. */
    checkPermission.mockResolvedValue(true);

    const result = await checkAgentUploadAuth(
      {
        userId: 'viewer-id',
        userRole: SystemRoles.USER,
        agentId: 'agent_shared01',
        messageFile: 'true',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermission: PermissionBits.VIEW }),
    );
  });

  it('denies a message attachment naming an agent the caller cannot view', async () => {
    const result = await checkAgentUploadAuth(
      {
        userId: 'attacker-id',
        userRole: SystemRoles.USER,
        agentId: 'agent_victim01',
        messageFile: 'true',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(false);
  });

  it('allows a message attachment in an ephemeral conversation', async () => {
    /* An ephemeral id names no stored agent, so there is nothing to authorize against and
     * nothing for the provider resolution to read. Requiring view access refuses every
     * attachment in those conversations. */
    const result = await checkAgentUploadAuth(
      {
        userId: 'any-user',
        userRole: SystemRoles.USER,
        agentId: 'ephemeral-convo-1',
        messageFile: 'true',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('leaves an upload naming no agent alone', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'any-user', userRole: SystemRoles.USER, messageFile: 'true' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('still denies when a tool resource is supplied without permission', async () => {
    const result = await checkAgentUploadAuth(
      {
        userId: 'attacker-id',
        userRole: SystemRoles.USER,
        agentId: 'agent_victim01',
        toolResource: 'context',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(false);
  });
});

describe('verifyAgentUploadPermission', () => {
  const agent = { _id: 'agent-object-id', author: { toString: () => 'owner-id' } };
  const getAgent = jest.fn();
  const checkPermission = jest.fn();
  const makeRes = () => {
    const status = jest.fn();
    const res = { status, json: jest.fn() };
    status.mockReturnValue(res);
    return res as unknown as Parameters<typeof verifyAgentUploadPermission>[0]['res'];
  };
  const req = { user: { id: 'manager-id', role: SystemRoles.USER } } as unknown as Parameters<
    typeof verifyAgentUploadPermission
  >[0]['req'];

  beforeEach(() => {
    jest.clearAllMocks();
    getAgent.mockResolvedValue(agent);
    checkPermission.mockResolvedValue(false);
  });

  it('allows an upload the global capability permits after establishing the agent exists', async () => {
    /* The bypass lives here rather than at each route, because the two upload routes
     * answered it differently and an image upload was refused where a file one passed. */
    const denied = await verifyAgentUploadPermission({
      req,
      res: makeRes(),
      metadata: { agent_id: 'agent_victim01' },
      getAgent,
      checkPermission,
      hasUploadBypass: async () => true,
    });

    expect(denied).toBe(false);
    expect(getAgent).toHaveBeenCalled();
  });

  it('reports a missing agent rather than letting the capability waive it', async () => {
    getAgent.mockResolvedValue(null);
    const res = makeRes();

    const denied = await verifyAgentUploadPermission({
      req,
      res,
      metadata: { agent_id: 'missing-agent' },
      getAgent,
      checkPermission,
      hasUploadBypass: async () => true,
    });

    expect(denied).toBe(true);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies the same upload when the capability is absent', async () => {
    const denied = await verifyAgentUploadPermission({
      req,
      res: makeRes(),
      metadata: { agent_id: 'agent_victim01' },
      getAgent,
      checkPermission,
      hasUploadBypass: async () => false,
    });

    expect(denied).toBe(true);
  });

  it('denies rather than allowing when the capability lookup throws', async () => {
    const denied = await verifyAgentUploadPermission({
      req,
      res: makeRes(),
      metadata: { agent_id: 'agent_victim01' },
      getAgent,
      checkPermission,
      hasUploadBypass: async () => {
        throw new Error('capability service unavailable');
      },
    });

    expect(denied).toBe(true);
  });
});
