const mockCreateAgentTriggerService = jest.fn();
const mockCreateBackgroundToolCompletionWakeupResolver = jest.fn(() => jest.fn());
const mockGenerationJobManager = {
  supportsDetachedAgentEventActions: true,
  getJob: jest.fn(),
  getAccountCleanupJobIdsForUser: jest.fn().mockResolvedValue([]),
  getGenerationAdmissionEvidence: jest.fn(),
};
const mockQueuedTurnLifecycle = {
  prepareContinue: jest.fn(),
  settleBeforeDeadLetter: jest.fn(),
  recordExecutionAdmission: jest.fn(),
  verifyExecutionAdmission: jest.fn(),
  initialize: jest.fn(),
  stop: jest.fn(),
  schedule: jest.fn(),
  cancel: jest.fn(),
};

jest.mock('@librechat/api', () => ({
  createCheckpointDeletionReclaimer: jest.fn((getJobs) => () => getJobs('owner', 'tenant')),
  createAgentTriggerService: (...args) => mockCreateAgentTriggerService(...args),
  createAgentContinuationResolver: jest.fn(() => jest.fn()),
  createAgentEventContinueResolver: jest.fn(() => jest.fn()),
  createBackgroundToolCompletionWakeupResolver: (...args) =>
    mockCreateBackgroundToolCompletionWakeupResolver(...args),
  createSubagentCompletionWakeupResolver: jest.fn(() => jest.fn()),
  createAgentQueuedTurnLifecycle: jest.fn(() => mockQueuedTurnLifecycle),
  BACKGROUND_TOOL_COMPLETION_SOURCE: 'background-tool-completion',
  SUBAGENT_COMPLETION_SOURCE: 'subagent-completion',
  AGENT_QUEUED_TURN_SOURCE: 'agent-queued-turn',
  GenerationJobManager: mockGenerationJobManager,
}));

jest.mock('~/models', () => ({
  isAgentTriggerPrincipalActive: jest.fn(),
}));

describe('agent trigger service composition', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGenerationJobManager.supportsDetachedAgentEventActions = true;
    let completionResultBatchSize = 8;
    mockCreateAgentTriggerService.mockReturnValue({
      initialize: jest.fn(async (options) => {
        completionResultBatchSize = options.completionResultBatchSize ?? 8;
      }),
      stop: jest.fn(),
      dispatch: jest.fn(),
      enqueue: jest.fn(),
      getDelivery: jest.fn(),
      getDeliveryStatus: jest.fn(),
      getDeadLetters: jest.fn(),
      requeue: jest.fn(),
      drainUser: jest.fn(),
      prepareUserPurge: jest.fn(),
      cancelUserPurge: jest.fn(),
      purgeUser: jest.fn(),
      getBackgroundCompletionResultBatchSize: () => completionResultBatchSize,
    });
  });

  it('uses complete owner job discovery for checkpoint evidence reclamation', async () => {
    require('./triggers');
    await mockCreateAgentTriggerService.mock.calls[0][0].reclaimCheckpointDeletions(25);
    expect(mockGenerationJobManager.getAccountCleanupJobIdsForUser).toHaveBeenCalledWith(
      'owner',
      'tenant',
    );
  });

  it('advertises detached completion capability for every compatible generation store', () => {
    require('./triggers');
    const supportsDetachedActionCompletion =
      mockCreateAgentTriggerService.mock.calls[0][0].supportsDetachedActionCompletion;

    expect(supportsDetachedActionCompletion()).toBe(true);
    mockGenerationJobManager.supportsDetachedAgentEventActions = false;
    expect(supportsDetachedActionCompletion()).toBe(false);
  });

  it('passes the recovery policy to both delivery and queued-turn workers', async () => {
    const { initializeAgentTriggerService } = require('./triggers');
    const options = {
      address: 'local',
      idlePolling: {
        queuedTurnMaxIntervalMs: 60_000,
        maintenanceMaxIntervalMs: 90_000,
        deliveryMaxIntervalMs: 5_000,
      },
    };
    await initializeAgentTriggerService(options);
    expect(mockCreateAgentTriggerService.mock.results[0].value.initialize).toHaveBeenCalledWith(
      options,
    );
    expect(mockQueuedTurnLifecycle.initialize).toHaveBeenCalledWith({ maxIdleIntervalMs: 60_000 });
  });

  it('injects the configured background completion batch size', async () => {
    const { initializeAgentTriggerService } = require('./triggers');
    await initializeAgentTriggerService({ address: 'local', completionResultBatchSize: 12 });

    const resolverDeps = mockCreateBackgroundToolCompletionWakeupResolver.mock.calls[0][0];
    expect(resolverDeps.getResultBatchSize()).toBe(12);
    expect(mockCreateAgentTriggerService.mock.results[0].value.initialize).toHaveBeenCalledWith({
      address: 'local',
      completionResultBatchSize: 12,
    });
  });
});
