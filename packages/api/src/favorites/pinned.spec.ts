import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { AuthUserDocCacheStore } from '~/auth/userDocCache';
import type { PinnedOrderHandlersDeps } from './pinned';
import type { ServerRequest } from '~/types';
import {
  getCachedAuthUserDoc,
  invalidateCachedAuthUserDoc,
  setCachedAuthUserDoc,
} from '~/auth/userDocCache';
import { createPinnedOrderHandlers } from './pinned';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const makeRes = (onJson?: () => void) => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      onJson?.();
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
};

const ANONYMOUS = Symbol('anonymous');

const makeReq = (body: unknown, userId: string | typeof ANONYMOUS = 'user-1') =>
  ({
    body,
    user: userId === ANONYMOUS ? undefined : ({ id: userId } as IUser),
  }) as unknown as ServerRequest;

const makeAuthUserDocCacheStore = () => {
  const values = new Map<string, unknown>();
  const store: AuthUserDocCacheStore & { values: Map<string, unknown> } = {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  return store;
};

const setup = (overrides: Partial<PinnedOrderHandlersDeps> = {}) => {
  const stored: Record<string, string[]> = { 'user-1': ['convo:a', 'agent:b'] };
  const deps: PinnedOrderHandlersDeps = {
    getUserById: jest.fn(async (userId: string) =>
      stored[userId] ? ({ pinnedOrder: stored[userId] } as IUser) : null,
    ),
    updateUser: jest.fn(async (userId: string, updateData: Partial<IUser>) => {
      if (!stored[userId]) {
        return null;
      }
      stored[userId] = updateData.pinnedOrder ?? stored[userId];
      return { pinnedOrder: stored[userId] } as IUser;
    }),
    invalidateCachedAuthUserDoc: jest.fn(async (_userId: string) => undefined),
    ...overrides,
  };
  return { deps, handlers: createPinnedOrderHandlers(deps), stored };
};

describe('createPinnedOrderHandlers', () => {
  describe('getPinnedOrder', () => {
    it('returns the stored order', async () => {
      const { handlers, deps } = setup();
      const res = makeRes();
      await handlers.getPinnedOrder(makeReq(undefined), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(['convo:a', 'agent:b']);
      /* The schema deselects the field, so it has to be asked for by name. */
      expect(deps.getUserById).toHaveBeenCalledWith('user-1', '+pinnedOrder');
    });

    it('returns an empty array when the user has no order yet', async () => {
      const { handlers } = setup({ getUserById: async () => ({}) as IUser });
      const res = makeRes();
      await handlers.getPinnedOrder(makeReq(undefined), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('rejects an unauthenticated request', async () => {
      const { handlers } = setup();
      const res = makeRes();
      await handlers.getPinnedOrder(makeReq(undefined, ANONYMOUS), res);
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the user is gone', async () => {
      const { handlers } = setup({ getUserById: async () => null });
      const res = makeRes();
      await handlers.getPinnedOrder(makeReq(undefined), res);
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 when the read throws', async () => {
      const { handlers } = setup({
        getUserById: async () => {
          throw new Error('boom');
        },
      });
      const res = makeRes();
      await handlers.getPinnedOrder(makeReq(undefined), res);
      expect(res.statusCode).toBe(500);
    });
  });

  describe('updatePinnedOrder', () => {
    it('persists a valid order', async () => {
      const { handlers, stored } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['agent:b', 'convo:a'] }), res);
      expect(res.statusCode).toBe(200);
      expect(stored['user-1']).toEqual(['agent:b', 'convo:a']);
      expect(res.body).toEqual(['agent:b', 'convo:a']);
    });

    it('invalidates cached auth user state after persisting a new order', async () => {
      const store = makeAuthUserDocCacheStore();
      await setCachedAuthUserDoc(store, 'auth-user-doc-key', {
        id: 'user-1',
        pinnedOrder: ['convo:stale'],
      });
      expect(await getCachedAuthUserDoc(store, 'auth-user-doc-key')).toEqual(
        expect.objectContaining({ pinnedOrder: ['convo:stale'] }),
      );

      const { handlers } = setup({
        invalidateCachedAuthUserDoc: (userId) => invalidateCachedAuthUserDoc(store, { userId }),
      });
      const res = makeRes(() => {
        expect(store.values.has('auth-user-doc-key')).toBe(false);
      });
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['convo:fresh'] }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(['convo:fresh']);
      expect(await getCachedAuthUserDoc(store, 'auth-user-doc-key')).toBeUndefined();
    });

    /* `updateUser` returns a document without the deselected field, so the
     * answer has to come from what was validated rather than from the doc. */
    it('answers with the stored order even when the document omits the field', async () => {
      const { handlers } = setup({ updateUser: async () => ({}) as IUser });
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['convo:x', 'convo:y'] }), res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(['convo:x', 'convo:y']);
    });

    it('accepts an empty order', async () => {
      const { handlers } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: [] }), res);
      expect(res.statusCode).toBe(200);
    });

    it('rejects a non-array body', async () => {
      const { handlers, deps } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: 'convo:a' }), res);
      expect(res.statusCode).toBe(400);
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects empty and non-string entries', async () => {
      const { handlers } = setup();
      for (const pinnedOrder of [[''], [42], [null]]) {
        const res = makeRes();
        await handlers.updatePinnedOrder(makeReq({ pinnedOrder }), res);
        expect(res.statusCode).toBe(400);
      }
    });

    it('rejects duplicate entries', async () => {
      const { handlers } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['convo:a', 'convo:a'] }), res);
      expect(res.statusCode).toBe(400);
    });

    /* A model favorite keys as `model:${endpoint.length}:${endpoint}:${model}`
     * and the favorites endpoint accepts 256 characters for each half, so the
     * longest key a valid favorite can produce has to survive this validator. */
    it('accepts the longest key a valid model favorite can produce', async () => {
      const { handlers } = setup();
      const res = makeRes();
      const endpoint = 'e'.repeat(256);
      const longest = `model:${endpoint.length}:${endpoint}:${'m'.repeat(256)}`;
      expect(longest.length).toBeLessThanOrEqual(560);
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: [longest] }), res);
      expect(res.statusCode).toBe(200);
    });

    it('rejects a key past the per-key cap', async () => {
      const { handlers } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['x'.repeat(561)] }), res);
      expect(res.statusCode).toBe(400);
    });

    /* Pinning has no membership cap and the sidebar query drains every cursor,
     * so any count limit would reject a legitimate list. Only the size of the
     * document being written is bounded. */
    it('accepts an order with more entries than any count cap would allow', async () => {
      const { handlers, stored } = setup();
      const res = makeRes();
      const order = Array.from({ length: 5000 }, (_, index) => `convo:${index}`);
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: order }), res);
      expect(res.statusCode).toBe(200);
      expect(stored['user-1']).toHaveLength(5000);
    });

    it('rejects a payload past the total size guard', async () => {
      const { handlers } = setup();
      const res = makeRes();
      /* 512 keys of 512 bytes each is 256KB, one past the budget. */
      const order = Array.from({ length: 600 }, (_, index) => `convo:${index}:${'x'.repeat(500)}`);
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: order }), res);
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unauthenticated request', async () => {
      const { handlers, deps } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: [] }, ANONYMOUS), res);
      expect(res.statusCode).toBe(401);
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('returns 404 when the user is gone', async () => {
      const { handlers, deps } = setup({ updateUser: async () => null });
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['convo:a'] }), res);
      expect(res.statusCode).toBe(404);
      expect(deps.invalidateCachedAuthUserDoc).not.toHaveBeenCalled();
    });

    it('returns 500 when the write throws', async () => {
      const { handlers, deps } = setup({
        updateUser: async () => {
          throw new Error('boom');
        },
      });
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({ pinnedOrder: ['convo:a'] }), res);
      expect(res.statusCode).toBe(500);
      expect(deps.invalidateCachedAuthUserDoc).not.toHaveBeenCalled();
    });
  });

  describe('malformed bodies', () => {
    /* Express leaves `req.body` nullish for a request with no JSON body, and a
     * throw here would escape the handler into the generic error path. */
    it.each([[undefined], [null]])('answers 400 for a %p body', async (body) => {
      const { handlers, deps } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq(body), res);
      expect(res.statusCode).toBe(400);
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('answers 400 when the body carries no pinnedOrder', async () => {
      const { handlers } = setup();
      const res = makeRes();
      await handlers.updatePinnedOrder(makeReq({}), res);
      expect(res.statusCode).toBe(400);
    });
  });
});
