import { logger } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { PromptRequest, PromptHandlersDeps } from './handlers';
import type { PromptService } from './service';
import { contentFilterBlockResponse } from '../middleware/contentFilter';
import { LangfusePromptRequestError } from '../langfuse/prompts';
import { createPromptHandlers } from './handlers';
import { PromptStoreError } from './errors';

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

    it('forwards the group canAccessPromptGroupResource already loaded to savePrompt', async () => {
      const loadedGroupRecord = { _id: groupId, source: 'native' };
      const savePrompt = jest.fn().mockResolvedValue({ ok: true, value: { prompt: {} } });
      const service = makeService({ savePrompt });
      const handlers = createPromptHandlers(makeDeps({ service }));
      const res = mockRes();

      await handlers.savePrompt(
        mockReq({
          params: { groupId },
          body: { prompt: { prompt: 'x', type: 'text' } },
          resourceAccess: { resourceInfo: loadedGroupRecord },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(savePrompt).toHaveBeenCalledWith(
        expect.objectContaining({ loadedGroup: loadedGroupRecord }),
      );
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

describe('createPromptHandlers resolvePrompt', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function resolveReq(version?: string): PromptRequest {
    return mockReq({ params: { groupId }, query: version == null ? {} : { version } });
  }

  it('resolves production when no version is given', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: true,
      value: { source: 'native', groupId, promptId, prompt: 'Hi', type: 'text' },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(resolvePrompt).toHaveBeenCalledWith({
      groupId,
      selection: { type: 'production' },
      loadedGroup: undefined,
      filters: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ source: 'native', groupId, promptId, prompt: 'Hi', type: 'text' });
  });

  it('resolves an exact version for a Langfuse group', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        source: 'langfuse',
        groupId,
        prompt: 'Hi',
        type: 'text',
        version: 3,
        labels: ['production'],
      },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq('3'), res);

    expect(resolvePrompt).toHaveBeenCalledWith({
      groupId,
      selection: { type: 'version', version: 3 },
      loadedGroup: undefined,
      filters: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      source: 'langfuse',
      groupId,
      prompt: 'Hi',
      type: 'text',
      version: 3,
      labels: ['production'],
    });
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects an invalid version %s without calling the service',
    async (version) => {
      const resolvePrompt = jest.fn();
      const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
      const res = mockRes();

      await handlers.resolvePrompt(resolveReq(version), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ code: 'invalid_request' });
      expect(resolvePrompt).not.toHaveBeenCalled();
    },
  );

  it('rejects a duplicated ?version query parameter without calling the service', async () => {
    const resolvePrompt = jest.fn();
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();
    const req = mockReq({ params: { groupId }, query: { version: ['3', '4'] } });

    await handlers.resolvePrompt(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'invalid_request' });
    expect(resolvePrompt).not.toHaveBeenCalled();
  });

  it('rejects a bracketed ?version[] query parameter without calling the service', async () => {
    const resolvePrompt = jest.fn();
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();
    const req = mockReq({ params: { groupId }, query: { version: ['3'] } });

    await handlers.resolvePrompt(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'invalid_request' });
    expect(resolvePrompt).not.toHaveBeenCalled();
  });

  it('maps a native group rejecting ?version to 400 invalid_request', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: false,
      error: { type: 'unsupported_selection', source: 'native' },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq('2'), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ code: 'invalid_request' });
  });

  it('maps blocked_content to the shared content filter response', async () => {
    const finding = {
      detectorId: 'pii-pattern',
      ruleId: 'org-token',
      label: 'organization token',
      source: 'prompt' as const,
      field: 'text' as const,
      provenance: 'user' as const,
      fragmentId: 'prompt.text',
      fragmentPath: '/prompt/text' as const,
    };
    const resolvePrompt = jest
      .fn()
      .mockResolvedValue({ ok: false, error: { type: 'blocked_content', finding } });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(contentFilterBlockResponse(finding));
  });

  it('maps a native unavailable_selection to 404 not_found', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'production' },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
  });

  it('maps source_not_found to 404 with the Langfuse message', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: false,
      error: { type: 'source_not_found', source: 'langfuse' },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'not_found', message: 'Prompt not found in Langfuse' });
  });

  it('maps unsupported_content to 422 unsupported_type', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: false,
      error: { type: 'unsupported_content', reason: 'chat_prompt' },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ code: 'unsupported_type' });
  });

  it.each([
    ['disabled', 404, { code: 'not_available' }],
    ['not_configured', 409, { code: 'not_configured' }],
    ['source_changed', 409, { code: 'source_changed' }],
  ] as const)('maps source_unavailable reason %s to %i %j', async (reason, status, body) => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: false,
      error: { type: 'source_unavailable', source: 'langfuse', reason },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual(body);
  });

  it('maps a thrown Langfuse timeout to 504', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const resolvePrompt = jest
      .fn()
      .mockRejectedValue(new LangfusePromptRequestError('timeout', 'Langfuse request timed out'));
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ code: 'timeout' });
  });

  it('maps a thrown Langfuse 401 to 502, never 401', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const resolvePrompt = jest
      .fn()
      .mockRejectedValue(
        new LangfusePromptRequestError('unauthorized', 'Langfuse responded with 401', 401),
      );
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(502);
    expect(res.statusCode).not.toBe(401);
    expect(res.body).toEqual({ code: 'unauthorized' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('maps a thrown Langfuse upstream error to 502 and relays the upstream status', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const resolvePrompt = jest
      .fn()
      .mockRejectedValue(
        new LangfusePromptRequestError('upstream', 'Langfuse responded with 500', 500),
      );
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ code: 'upstream', status: 500 });
  });

  it('maps a thrown read PromptStoreError to 404 not_found', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const resolvePrompt = jest
      .fn()
      .mockRejectedValue(new PromptStoreError('read', new Error('db down')));
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
  });

  it('returns 500 for an unexpected thrown error', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const resolvePrompt = jest.fn().mockRejectedValue(new Error('database unavailable'));
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Error resolving prompt' });
    expect(errorSpy).toHaveBeenCalledWith('Error resolving prompt', expect.any(Error));
  });

  it('falls back to 500 for an unlisted error variant such as unsupported_source', async () => {
    const resolvePrompt = jest.fn().mockResolvedValue({
      ok: false,
      error: { type: 'unsupported_source', source: 'native' },
    });
    const handlers = createPromptHandlers(makeDeps({ service: makeService({ resolvePrompt }) }));
    const res = mockRes();

    await handlers.resolvePrompt(resolveReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Error resolving prompt' });
  });
});
