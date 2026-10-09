import { Types } from 'mongoose';
import type {
  MemoryByIdParams,
  SetMemoryByIdParams,
  SetMemoryByIdResult,
} from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import { createMemoryManagementHandlers } from './handlers';
import { projectStoredMemories } from './protection';

const filters: FiltersConfig = {
  memories: {
    pii: {
      fields: ['key'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'private' }],
    },
  },
};

function createResponse(): Response {
  const response = {} as Response;
  response.status = jest.fn(() => response);
  response.json = jest.fn(() => response);
  return response;
}

type HandlerRequest = Parameters<
  ReturnType<typeof createMemoryManagementHandlers>['updateById']
>[0];

function createRequest(request: Partial<HandlerRequest>): HandlerRequest {
  return Object.assign({} as HandlerRequest, request);
}

describe('createMemoryManagementHandlers', () => {
  const storedId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const setMemoryById = jest.fn(
    async (_params: SetMemoryByIdParams): Promise<SetMemoryByIdResult> => ({
      ok: true,
      memory: {
        _id: storedId,
        userId,
        key: 'private_key',
        value: 'safe replacement',
        agentId: 'agent-1',
        updated_at: new Date('2026-08-04T00:00:00.000Z'),
      },
    }),
  );
  const deleteMemoryById = jest.fn(async (_params: MemoryByIdParams) => ({ ok: true }));
  const countTokens = jest.fn(() => 2);
  const handlers = createMemoryManagementHandlers({
    setMemoryById,
    deleteMemoryById,
    countTokens,
    projectStoredMemories,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates through the opaque id without requiring or returning the stored key', async () => {
    const response = createResponse();
    const request = createRequest({
      params: { id: storedId.toString() },
      query: { agentId: ' agent-1 ' },
      body: { value: 'safe replacement' },
      user: { id: userId.toString() },
      config: { filters, memory: { charLimit: 100 } },
    });

    await handlers.updateById(request, response);

    expect(setMemoryById).toHaveBeenCalledWith({
      userId: userId.toString(),
      id: storedId.toString(),
      key: undefined,
      value: 'safe replacement',
      tokenCount: 2,
      agentId: 'agent-1',
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      updated: true,
      memory: expect.objectContaining({
        _id: storedId,
        key: '',
        value: 'safe replacement',
        contentFilterBlocked: true,
      }),
    });
    expect(JSON.stringify(jest.mocked(response.json).mock.calls)).not.toContain('private_key');
  });

  it('blocks a submitted replacement key before calling the model method', async () => {
    const response = createResponse();
    const request = createRequest({
      params: { id: storedId.toString() },
      query: {},
      body: { key: 'private_replacement', value: 'safe replacement' },
      user: { id: userId.toString() },
      config: { filters },
    });

    await handlers.updateById(request, response);

    expect(setMemoryById).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'content_filter_block', source: 'memory', field: 'key' }),
    );
    expect(JSON.stringify(jest.mocked(response.json).mock.calls)).not.toContain(
      'private_replacement',
    );
  });

  it('does not expose the stored key when response projection fails', async () => {
    const response = createResponse();
    const request = createRequest({
      params: { id: storedId.toString() },
      query: {},
      body: { value: 'safe replacement' },
      user: { id: userId.toString() },
      config: { filters },
    });
    const failingHandlers = createMemoryManagementHandlers({
      setMemoryById,
      deleteMemoryById,
      countTokens,
      projectStoredMemories: () => {
        throw new Error('projection failed for private_key');
      },
    });

    await failingHandlers.updateById(request, response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: 'Failed to update memory.' });
    expect(JSON.stringify(jest.mocked(response.json).mock.calls)).not.toContain('private_key');
  });

  it('deletes through the opaque id with owner and partition inputs', async () => {
    const response = createResponse();
    const request = createRequest({
      params: { id: storedId.toString() },
      query: { agentId: 'agent-1' },
      body: {},
      user: { id: userId.toString() },
    });

    await handlers.deleteById(request, response);

    expect(deleteMemoryById).toHaveBeenCalledWith({
      userId: userId.toString(),
      id: storedId.toString(),
      agentId: 'agent-1',
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ deleted: true });
  });
});
