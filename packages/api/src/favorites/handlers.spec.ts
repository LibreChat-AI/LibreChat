import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createToolFavoritesHandlers } from './handlers';

function mockReq(overrides = {}) {
  return {
    user: { id: 'u1' },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown> | unknown[];
  status: jest.Mock;
  json: jest.Mock;
}

function mockRes() {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: MockRes['body']) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function createHandlers(overrides = {}) {
  const deps = {
    getToolFavorites: jest.fn().mockResolvedValue([{ itemType: 'tool', itemId: 'dalle' }]),
    addToolFavorite: jest.fn().mockResolvedValue({ ok: true, added: true }),
    removeToolFavorite: jest.fn().mockResolvedValue({ ok: true, removed: true }),
    ...overrides,
  };
  const handlers = createToolFavoritesHandlers(deps);
  return { handlers, deps };
}

describe('createToolFavoritesHandlers', () => {
  describe('listToolFavorites', () => {
    it('returns the favorites for the authenticated user', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.listToolFavorites(mockReq(), res);
      expect(deps.getToolFavorites).toHaveBeenCalledWith('u1');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual([{ itemType: 'tool', itemId: 'dalle' }]);
    });

    it('returns 401 without an authenticated user', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.listToolFavorites(mockReq({ user: undefined }), res);
      expect(res.statusCode).toBe(401);
      expect(deps.getToolFavorites).not.toHaveBeenCalled();
    });

    it('returns 500 when the dep throws', async () => {
      const { handlers } = createHandlers({
        getToolFavorites: jest.fn().mockRejectedValue(new Error('boom')),
      });
      const res = mockRes();
      await handlers.listToolFavorites(mockReq(), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('addToolFavorite', () => {
    it('adds a favorite from validated params', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.addToolFavorite(
        mockReq({ params: { itemType: 'mcp', itemId: 'everything' } }),
        res,
      );
      expect(deps.addToolFavorite).toHaveBeenCalledWith({
        userId: 'u1',
        itemType: 'mcp',
        itemId: 'everything',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ itemType: 'mcp', itemId: 'everything' });
    });

    it('rejects an unknown itemType with 400 before calling deps', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.addToolFavorite(mockReq({ params: { itemType: 'agent', itemId: 'x' } }), res);
      expect(res.statusCode).toBe(400);
      expect((res.body as Record<string, unknown>).code).toBe('INVALID_ITEM_TYPE');
      expect(deps.addToolFavorite).not.toHaveBeenCalled();
    });

    it.each([
      ['empty', ''],
      ['oversized', 'x'.repeat(257)],
    ])('rejects an %s itemId with 400', async (_label, itemId) => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.addToolFavorite(mockReq({ params: { itemType: 'tool', itemId } }), res);
      expect(res.statusCode).toBe(400);
      expect((res.body as Record<string, unknown>).code).toBe('INVALID_ITEM_ID');
      expect(deps.addToolFavorite).not.toHaveBeenCalled();
    });

    it('propagates the cap error code and limit as 400', async () => {
      const capError = Object.assign(new Error('Maximum of 100 favorites reached'), {
        code: 'MAX_FAVORITES_EXCEEDED',
        limit: 100,
      });
      const { handlers } = createHandlers({
        addToolFavorite: jest.fn().mockRejectedValue(capError),
      });
      const res = mockRes();
      await handlers.addToolFavorite(
        mockReq({ params: { itemType: 'skill', itemId: 'abc' } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        code: 'MAX_FAVORITES_EXCEEDED',
        message: 'Maximum of 100 favorites reached',
        limit: 100,
      });
    });

    it('returns 500 on unexpected dep failure', async () => {
      const { handlers } = createHandlers({
        addToolFavorite: jest.fn().mockRejectedValue(new Error('boom')),
      });
      const res = mockRes();
      await handlers.addToolFavorite(
        mockReq({ params: { itemType: 'builtin', itemId: 'web_search' } }),
        res,
      );
      expect(res.statusCode).toBe(500);
    });
  });

  describe('removeToolFavorite', () => {
    it('removes a favorite from validated params', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.removeToolFavorite(
        mockReq({ params: { itemType: 'tool', itemId: 'dalle' } }),
        res,
      );
      expect(deps.removeToolFavorite).toHaveBeenCalledWith({
        userId: 'u1',
        itemType: 'tool',
        itemId: 'dalle',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects an unknown itemType with 400', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.removeToolFavorite(
        mockReq({ params: { itemType: 'nope', itemId: 'x' } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(deps.removeToolFavorite).not.toHaveBeenCalled();
    });
  });
});
