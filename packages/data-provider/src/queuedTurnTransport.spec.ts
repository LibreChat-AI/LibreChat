import { enqueueAgentQueuedTurn } from './data-service';
import * as endpoints from './api-endpoints';
import request from './request';

jest.mock('./request', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
const get = jest.mocked(request.get);
const post = jest.mocked(request.post);
const payload = {
  conversationId: 'conversation',
  parentMessageId: 'parent',
  clientRequestId: 'retry-id',
  text: 'later',
};
const protocolError = {
  response: { status: 409, data: { code: 'QUEUED_TURN_PROTOCOL_REQUIRED' } },
};

beforeEach(() => jest.resetAllMocks());

it('keeps snapshot-free requests on the legacy endpoint', async () => {
  await enqueueAgentQueuedTurn(payload);
  expect(get).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(endpoints.agentQueuedTurns(), payload);
});

it.each(['ask', 'acceptEdits', 'fullAccess'] as const)(
  'sends a %s snapshot only to v2',
  async (codeApprovalMode) => {
    await enqueueAgentQueuedTurn({ ...payload, codeApprovalMode });
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(endpoints.agentQueuedTurns(2), {
      ...payload,
      codeApprovalMode,
    });
  },
);

it.each([404, 501])(
  'rejects an unstructured old-replica %s without v1 fallback',
  async (status) => {
    post.mockRejectedValue({ response: { status } });
    await expect(
      enqueueAgentQueuedTurn({ ...payload, codeApprovalMode: 'fullAccess' }),
    ).rejects.toMatchObject(protocolError);
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [501, 'QUEUED_TURN_PRIORITY_UNSUPPORTED'],
  [501, 'QUEUED_TURNS_UNSUPPORTED'],
  [404, 'CONVERSATION_NOT_FOUND'],
])('preserves structured %s %s origin responses', async (status, code) => {
  const error = { response: { status, data: { code } } };
  post.mockRejectedValue(error);
  await expect(
    enqueueAgentQueuedTurn({ ...payload, codeApprovalMode: 'ask', priority: true }),
  ).rejects.toBe(error);
});

it('recovers a committed receipt after list access is revoked without changing the request', async () => {
  const timeout = new Error('lost response');
  post
    .mockRejectedValueOnce(timeout)
    .mockResolvedValueOnce({ receipt: { queuedTurnId: 'durable-row' } });
  const input = { ...payload, codeApprovalMode: 'acceptEdits' as const };
  await expect(enqueueAgentQueuedTurn(input)).rejects.toBe(timeout);
  get.mockRejectedValue({ response: { status: 403 } });
  await expect(enqueueAgentQueuedTurn(input)).resolves.toMatchObject({
    receipt: { queuedTurnId: 'durable-row' },
  });
  expect(get).not.toHaveBeenCalled();
  expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
});

it('does not depend on a capability list before sending', async () => {
  get.mockRejectedValue(new Error('list unavailable'));
  post.mockResolvedValue({ receipt: { queuedTurnId: 'durable-row' } });
  await expect(
    enqueueAgentQueuedTurn({ ...payload, codeApprovalMode: 'ask' }),
  ).resolves.toMatchObject({
    receipt: { queuedTurnId: 'durable-row' },
  });
  expect(get).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledTimes(1);
});
