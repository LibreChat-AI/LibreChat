const mockPause = jest.fn();
const mockGetJob = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: {
    approvals: { pause: (...args) => mockPause(...args) },
    getJob: (...args) => mockGetJob(...args),
  },
}));

const AgentClient = require('../client');

function clientForProjection() {
  const pendingAction = { actionId: 'action-1', expiresAt: Date.now() + 60_000 };
  return {
    stagedApproval: {
      streamId: 'conversation-1',
      pendingAction,
      discoveredTools: [],
      activityPhaseSnapshot: null,
    },
    pendingApproval: null,
    jobCreatedAt: 123,
  };
}

describe('AgentClient Event Actor pause projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('confirms the exact durable projection when Redis loses the pause reply', async () => {
    const self = clientForProjection();
    const suspension = { version: 1, suspensionId: 'suspension-1', attempt: 2 };
    mockPause.mockRejectedValue(new Error('reply lost'));
    mockGetJob.mockResolvedValue({
      createdAt: 123,
      status: 'requires_action',
      metadata: {
        pendingAction: self.stagedApproval.pendingAction,
        agentEventSuspension: suspension,
      },
    });

    await expect(AgentClient.prototype.publishStagedApproval.call(self, suspension)).resolves.toBe(
      true,
    );
    expect(self.pendingApproval).toBe(self.stagedApproval.pendingAction);
  });

  it('propagates an ambiguous failure when the durable projection does not match', async () => {
    const self = clientForProjection();
    const error = new Error('reply lost');
    mockPause.mockRejectedValue(error);
    mockGetJob.mockResolvedValue({
      createdAt: 123,
      status: 'requires_action',
      metadata: {
        pendingAction: self.stagedApproval.pendingAction,
        agentEventSuspension: { version: 1, suspensionId: 'different', attempt: 2 },
      },
    });

    await expect(
      AgentClient.prototype.publishStagedApproval.call(self, {
        version: 1,
        suspensionId: 'suspension-1',
        attempt: 2,
      }),
    ).rejects.toBe(error);
    expect(self.pendingApproval).toBeNull();
  });
});
