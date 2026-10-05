import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { PromptRequest, PromptHandlersDeps } from './handlers';
import type { PromptService } from './service';
import { createPromptHandlers } from './handlers';

function mockReq(overrides: Record<string, unknown> = {}): PromptRequest {
  return {
    user: { id: 'u1' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as PromptRequest;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  send: jest.Mock;
  json: jest.Mock;
}

function mockRes(): Response & MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: jest.fn((data: unknown) => {
      res.body = data;
      return res;
    }),
    json: jest.fn((data: unknown) => {
      res.body = data;
      return res;
    }),
  };
  return res as unknown as Response & MockRes;
}

function makeService(overrides: Partial<PromptService> = {}): PromptService {
  return {
    resolvePrompt: jest.fn(),
    getListPromptGroupsByAccess: jest.fn(),
    getPrompts: jest.fn().mockResolvedValue([]),
    createPromptGroup: jest.fn(),
    savePrompt: jest.fn(),
    getPromptGroup: jest.fn(),
    getPrompt: jest.fn(),
    incrementPromptGroupUsage: jest.fn(),
    updatePromptGroup: jest.fn(),
    makePromptProduction: jest.fn(),
    deletePrompt: jest.fn(),
    deletePromptGroup: jest.fn(),
    ...overrides,
  } as unknown as PromptService;
}

function makeDeps(overrides: Partial<PromptHandlersDeps> = {}): PromptHandlersDeps {
  return {
    service: makeService(),
    getPromptGroupAccessContext: jest.fn(),
    getEffectivePermissions: jest.fn(),
    ...overrides,
  };
}

const groupId = '507f1f77bcf86cd799439011';
const promptId = '507f1f77bcf86cd799439012';

/** The shape `canAccessPromptViaGroup` stores on a non-bypass request. */
function withLoadedRevision(overrides: Record<string, unknown> = {}): PromptRequest {
  return mockReq({
    params: { promptId },
    resourceAccess: { resourceInfo: { _id: groupId, prompt: { _id: promptId, groupId } } },
    ...overrides,
  });
}

describe('createPromptHandlers linked-instructions cache clearing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('makePromptProduction', () => {
    it('clears the production key for the promoted revision’s group', async () => {
      const invalidateLinkedPrompt = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        makePromptProduction: jest.fn().mockResolvedValue({
          ok: true,
          value: { message: 'Prompt production made successfully' },
          groupId,
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.makePromptProduction(withLoadedRevision(), res);

      expect(invalidateLinkedPrompt).toHaveBeenCalledTimes(1);
      expect(invalidateLinkedPrompt).toHaveBeenCalledWith(groupId, []);
      expect(res.statusCode).toBe(200);
    });

    it('does not clear the cache when the promote is rejected', async () => {
      const invalidateLinkedPrompt = jest.fn();
      const service = makeService({
        makePromptProduction: jest
          .fn()
          .mockResolvedValue({ ok: false, error: { type: 'invalid_input', message: 'bad' } }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.makePromptProduction(withLoadedRevision(), res);

      expect(invalidateLinkedPrompt).not.toHaveBeenCalled();
    });

    it('clears the cache from the service result when no resourceInfo was loaded (capability bypass)', async () => {
      const invalidateLinkedPrompt = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        makePromptProduction: jest.fn().mockResolvedValue({
          ok: true,
          value: { message: 'Prompt production made successfully' },
          groupId,
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.makePromptProduction(mockReq({ params: { promptId } }), res);

      expect(invalidateLinkedPrompt).toHaveBeenCalledTimes(1);
      expect(invalidateLinkedPrompt).toHaveBeenCalledWith(groupId, []);
      expect(res.statusCode).toBe(200);
    });

    it('does not clear the cache when the promoted revision has no group id', async () => {
      const invalidateLinkedPrompt = jest.fn();
      const service = makeService({
        makePromptProduction: jest.fn().mockResolvedValue({
          ok: true,
          value: { message: 'Prompt production made successfully' },
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.makePromptProduction(withLoadedRevision(), res);

      expect(invalidateLinkedPrompt).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });
  });

  describe('deletePrompt', () => {
    it('clears the production key and an exact key for the deleted revision', async () => {
      const invalidateLinkedPrompt = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        deletePrompt: jest
          .fn()
          .mockResolvedValue({ ok: true, value: { prompt: 'Prompt deleted successfully' } }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.deletePrompt(mockReq({ params: { promptId }, query: { groupId } }), res);

      expect(invalidateLinkedPrompt).toHaveBeenCalledTimes(1);
      expect(invalidateLinkedPrompt).toHaveBeenCalledWith(groupId, [promptId]);
    });

    it('does not clear the cache when the delete is rejected', async () => {
      const invalidateLinkedPrompt = jest.fn();
      const service = makeService({
        deletePrompt: jest
          .fn()
          .mockResolvedValue({ ok: false, error: { type: 'invalid_input', message: 'bad' } }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.deletePrompt(mockReq({ params: { promptId }, query: { groupId } }), res);

      expect(invalidateLinkedPrompt).not.toHaveBeenCalled();
    });
  });

  describe('deletePromptGroup', () => {
    it('reads every revision before deleting and clears an exact key for each', async () => {
      const invalidateLinkedPrompt = jest.fn().mockResolvedValue(undefined);
      const callOrder: string[] = [];
      const service = makeService({
        getPrompts: jest.fn().mockImplementation(async () => {
          callOrder.push('getPrompts');
          return [{ _id: 'prompt-1' }, { _id: 'prompt-2' }];
        }),
        deletePromptGroup: jest.fn().mockImplementation(async () => {
          callOrder.push('deletePromptGroup');
          return { message: 'Prompt group deleted successfully' };
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.deletePromptGroup(mockReq({ params: { groupId } }), res);

      expect(service.getPrompts).toHaveBeenCalledWith({ groupId });
      expect(invalidateLinkedPrompt).toHaveBeenCalledTimes(1);
      expect(invalidateLinkedPrompt).toHaveBeenCalledWith(groupId, ['prompt-1', 'prompt-2']);
      // The revisions are read before the group (and its prompts) are deleted.
      expect(callOrder).toEqual(['getPrompts', 'deletePromptGroup']);
    });

    it('does not read revisions when no cache dependency is wired', async () => {
      const service = makeService({
        deletePromptGroup: jest
          .fn()
          .mockResolvedValue({ message: 'Prompt group deleted successfully' }),
      });
      const handlers = createPromptHandlers(makeDeps({ service }));
      const res = mockRes();

      await handlers.deletePromptGroup(mockReq({ params: { groupId } }), res);

      expect(service.getPrompts).not.toHaveBeenCalled();
    });

    it('still deletes the group and clears the cache with no ids when reading revisions rejects', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const invalidateLinkedPrompt = jest.fn().mockResolvedValue(undefined);
      const service = makeService({
        getPrompts: jest.fn().mockRejectedValue(new Error('read failed')),
        deletePromptGroup: jest
          .fn()
          .mockResolvedValue({ message: 'Prompt group deleted successfully' }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.deletePromptGroup(mockReq({ params: { groupId } }), res);

      expect(service.deletePromptGroup).toHaveBeenCalledWith(groupId);
      expect(res.statusCode).toBe(200);
      expect(invalidateLinkedPrompt).toHaveBeenCalledWith(groupId, []);
      expect(errorSpy).toHaveBeenCalledWith(
        '[prompts] Failed to read revisions before deleting the group',
        {
          groupId,
          type: 'Error',
        },
      );
    });
  });

  describe('writes that do not change what a linked agent reads', () => {
    it('does not clear the cache after creating a prompt group', async () => {
      const invalidateLinkedPrompt = jest.fn();
      const service = makeService({
        createPromptGroup: jest.fn().mockResolvedValue({
          ok: true,
          value: { prompt: null, group: { _id: groupId, name: 'g' } },
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.createPromptGroup(
        mockReq({ body: { prompt: { prompt: 'x', type: 'text' }, group: { name: 'g' } } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(invalidateLinkedPrompt).not.toHaveBeenCalled();
    });

    it('does not clear the cache after adding a revision', async () => {
      const invalidateLinkedPrompt = jest.fn();
      const service = makeService({
        savePrompt: jest.fn().mockResolvedValue({ ok: true, value: { prompt: {} } }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.savePrompt(
        mockReq({ params: { groupId }, body: { prompt: { prompt: 'x', type: 'text' } } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(invalidateLinkedPrompt).not.toHaveBeenCalled();
    });
  });

  describe('cache clear failures', () => {
    it('logs a cache clear failure and still returns the write’s success response', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const invalidateLinkedPrompt = jest.fn().mockRejectedValue(new Error('cache down'));
      const service = makeService({
        makePromptProduction: jest.fn().mockResolvedValue({
          ok: true,
          value: { message: 'Prompt production made successfully' },
          groupId,
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      await handlers.makePromptProduction(withLoadedRevision(), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ message: 'Prompt production made successfully' });
      expect(errorSpy).toHaveBeenCalledWith(
        '[prompts] Failed to clear the linked-instructions cache',
        {
          groupId,
          type: 'Error',
        },
      );
    });
  });

  describe('cache clear bound', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('promote returns 200 and logs once after the limit when the clear never settles', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const invalidateLinkedPrompt = jest.fn().mockReturnValue(new Promise(() => {}));
      const service = makeService({
        makePromptProduction: jest.fn().mockResolvedValue({
          ok: true,
          value: { message: 'Prompt production made successfully' },
          groupId,
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      const pending = handlers.makePromptProduction(withLoadedRevision(), res);
      await jest.advanceTimersByTimeAsync(1000);
      await pending;

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[prompts] Failed to clear the linked-instructions cache',
        {
          groupId,
          type: 'Error',
        },
      );
    });

    it('promote honors a configured timeout shorter than the default', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const invalidateLinkedPrompt = jest.fn().mockReturnValue(new Promise(() => {}));
      const service = makeService({
        makePromptProduction: jest.fn().mockResolvedValue({
          ok: true,
          value: { message: 'Prompt production made successfully' },
          groupId,
        }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();
      const req = withLoadedRevision({
        config: {
          endpoints: { agents: { linkedInstructions: { native: { cacheClearTimeoutMs: 50 } } } },
        },
      });

      const pending = handlers.makePromptProduction(req, res);
      await jest.advanceTimersByTimeAsync(50);
      await pending;

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('deletePrompt returns 200 and logs once after the limit when the clear never settles', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const invalidateLinkedPrompt = jest.fn().mockReturnValue(new Promise(() => {}));
      const service = makeService({
        deletePrompt: jest
          .fn()
          .mockResolvedValue({ ok: true, value: { prompt: 'Prompt deleted successfully' } }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      const pending = handlers.deletePrompt(
        mockReq({ params: { promptId }, query: { groupId } }),
        res,
      );
      await jest.advanceTimersByTimeAsync(1000);
      await pending;

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[prompts] Failed to clear the linked-instructions cache',
        {
          groupId,
          type: 'Error',
        },
      );
    });

    it('deletePromptGroup returns 200 and logs once after the limit when the clear never settles', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const invalidateLinkedPrompt = jest.fn().mockReturnValue(new Promise(() => {}));
      const service = makeService({
        getPrompts: jest.fn().mockResolvedValue([{ _id: 'prompt-1' }]),
        deletePromptGroup: jest
          .fn()
          .mockResolvedValue({ message: 'Prompt group deleted successfully' }),
      });
      const handlers = createPromptHandlers(makeDeps({ service, invalidateLinkedPrompt }));
      const res = mockRes();

      const pending = handlers.deletePromptGroup(mockReq({ params: { groupId } }), res);
      await jest.advanceTimersByTimeAsync(1000);
      await pending;

      expect(res.statusCode).toBe(200);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[prompts] Failed to clear the linked-instructions cache',
        {
          groupId,
          type: 'Error',
        },
      );
    });
  });
});
