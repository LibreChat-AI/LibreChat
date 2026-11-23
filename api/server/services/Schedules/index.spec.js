const mockRecordScheduleOutcome = jest.fn();
const mockCreateSchedulesService = jest.fn(() => ({
  recordScheduleOutcome: mockRecordScheduleOutcome,
}));

jest.mock('@librechat/api', () => ({
  createSchedulesService: (...args) => mockCreateSchedulesService(...args),
}));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/services/Agents/triggers', () => ({ enqueueAgentTrigger: jest.fn() }));
jest.mock('./mcp', () => jest.fn());
jest.mock('./access', () => ({ resolveAgentFireAccess: jest.fn() }));
jest.mock('~/models', () => ({
  isAgentTriggerPrincipalActive: jest.fn(),
  findScheduleOwner: jest.fn(),
  initializeNullBalance: jest.fn(),
}));

const { recordExpiredScheduleApproval } = require('./index');

describe('recordExpiredScheduleApproval', () => {
  beforeEach(() => {
    mockRecordScheduleOutcome.mockReset().mockResolvedValue(true);
  });

  it('ignores ordinary generation approvals', async () => {
    await expect(
      recordExpiredScheduleApproval('conversation-1', { createdAt: 1000 }),
    ).resolves.toBeUndefined();

    expect(mockRecordScheduleOutcome).not.toHaveBeenCalled();
  });

  it('settles the exact scheduled generation as interrupted', async () => {
    await recordExpiredScheduleApproval('conversation-1', {
      createdAt: 1000,
      conversationId: 'conversation-1',
      scheduleId: 'schedule-1',
      scheduledFor: '2026-08-17T12:00:00.000Z',
    });

    expect(mockRecordScheduleOutcome).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      scheduledFor: '2026-08-17T12:00:00.000Z',
      streamId: 'conversation-1',
      jobCreatedAt: 1000,
      status: 'interrupted',
      conversationId: 'conversation-1',
      error: 'Approval expired before a decision was made',
    });
  });

  it('surfaces a failed durable settlement instead of reporting false success', async () => {
    mockRecordScheduleOutcome.mockResolvedValue(false);

    await expect(
      recordExpiredScheduleApproval('conversation-1', {
        createdAt: 1000,
        scheduleId: 'schedule-1',
        scheduledFor: '2026-08-17T12:00:00.000Z',
      }),
    ).rejects.toThrow('Failed to settle expired scheduled approval schedule-1');
  });
});

describe('schedule owner lookup', () => {
  it('selects the terms acceptance flag the fire-time terms check reads', async () => {
    const methods = require('~/models');
    const owner = { _id: 'user-1', termsAccepted: false };
    methods.findScheduleOwner.mockResolvedValue(owner);
    mockRecordScheduleOutcome.mockResolvedValue(true);
    let facade;
    jest.isolateModules(() => {
      facade = require('./index');
    });

    // The facade builds the service on first use and hands it the host adapters.
    await facade.recordExpiredScheduleApproval('conversation-1', {
      createdAt: 1000,
      scheduleId: 'schedule-1',
      scheduledFor: '2026-08-17T12:00:00.000Z',
    });
    const { findUserById } = mockCreateSchedulesService.mock.calls.at(-1)[0];
    await expect(findUserById('user-1')).resolves.toEqual(owner);
    expect(methods.findScheduleOwner).toHaveBeenCalledWith('user-1');
    expect(mockCreateSchedulesService.mock.calls.at(-1)[0].initializeNullBalance).toBe(
      methods.initializeNullBalance,
    );
  });
});
