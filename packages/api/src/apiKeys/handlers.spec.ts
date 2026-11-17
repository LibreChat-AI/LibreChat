import type { Request, Response } from 'express';
import { createApiKeyHandlers } from './handlers';

function setup(usesGrants?: (req: Request) => Promise<boolean>) {
  const keys = [{ id: 'key-1', name: 'CI', keyPrefix: 'sk-abc', createdAt: new Date(0) }];
  const handlers = createApiKeyHandlers({
    createAgentApiKey: jest.fn(),
    listAgentApiKeys: jest.fn(async () => keys),
    deleteAgentApiKey: jest.fn(),
    getAgentApiKeyById: jest.fn(),
    ...(usesGrants && { usesGrants }),
  });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const list = async () => {
    await handlers.listApiKeys(
      { user: { id: 'owner' } } as Parameters<typeof handlers.listApiKeys>[0],
      res as unknown as Response,
    );
    return res.json.mock.calls[res.json.mock.calls.length - 1]?.[0];
  };
  return { list, keys, res };
}

describe('listApiKeys', () => {
  it('lists keys as before where nothing says grants are in use', async () => {
    const { list, keys } = setup();
    expect(await list()).toEqual({ keys });
    expect(await setup(async () => false).list()).toEqual({ keys });
  });

  it('tells the client when key runs are limited to what the owner granted', async () => {
    const { list, keys } = setup(async () => true);
    expect(await list()).toEqual({ keys, grants: true });
  });

  it('does not list keys it could not establish the mode for', async () => {
    const { list, res } = setup(async () => {
      throw new Error('PRIVATE config store');
    });
    expect(await list()).toEqual({ error: 'Failed to list API keys' });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
