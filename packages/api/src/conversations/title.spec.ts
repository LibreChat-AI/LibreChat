import express from 'express';
import request from 'supertest';
import {
  createGeneratedTitleHandler,
  executeAgentTitleModel,
  publishConversationTitle,
} from './title';

describe('agent title model execution', () => {
  function titleModel() {
    const result = { title: 'Generated' };
    const invocation = {
      admit: jest.fn().mockResolvedValue(undefined),
      generate: jest.fn().mockResolvedValue(result),
      finish: jest.fn(async (value: typeof result) => value.title),
    };
    const stages = {
      prepare: jest.fn().mockResolvedValue('provider options'),
      createInvocation: jest.fn().mockReturnValue(invocation),
      onError: jest.fn(),
    };
    return { invocation, result, stages };
  }

  it('passes the signal to the invocation and finishes a healthy result', async () => {
    const { invocation, result, stages } = titleModel();
    const { signal } = new AbortController();
    await expect(executeAgentTitleModel(signal, stages)).resolves.toBe('Generated');
    expect(stages.createInvocation).toHaveBeenCalledWith('provider options', signal);
    expect(invocation.finish).toHaveBeenCalledWith(result);
    expect(stages.onError).not.toHaveBeenCalled();
  });

  it('does not start provider setup for an already cancelled title', async () => {
    const { stages } = titleModel();
    const signal = AbortSignal.abort();
    await expect(executeAgentTitleModel(signal, stages)).rejects.toBe(signal.reason);
    expect(stages.prepare).not.toHaveBeenCalled();
  });

  it('does not construct a title invocation if setup completes after cancellation', async () => {
    const { stages } = titleModel();
    const controller = new AbortController();
    const reason = new Error('Title cancelled during setup');
    stages.prepare.mockImplementationOnce(async () => {
      controller.abort(reason);
      return 'late provider options';
    });
    await expect(executeAgentTitleModel(controller.signal, stages)).rejects.toBe(reason);
    expect(stages.createInvocation).not.toHaveBeenCalled();
  });

  it.each(['admit', 'generate'] as const)(
    'does not finish a title cancelled in %s',
    async (phase) => {
      const { invocation, result, stages } = titleModel();
      const controller = new AbortController();
      invocation[phase].mockImplementationOnce(async () => {
        controller.abort();
        return phase === 'generate' ? result : undefined;
      });
      await expect(executeAgentTitleModel(controller.signal, stages)).resolves.toBeUndefined();
      expect(stages.onError).toHaveBeenCalledWith(controller.signal.reason);
      expect(invocation.generate).toHaveBeenCalledTimes(phase === 'admit' ? 0 : 1);
      expect(invocation.finish).not.toHaveBeenCalled();
    },
  );
});

describe('generated title publication', () => {
  it.each([undefined, 8])(
    'discards an epoch 7 title when the current epoch is %s',
    async (epoch) => {
      const deps = {
        saveConvo: jest.fn(),
        getConvo: jest.fn(),
        titleCache: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
        getGenerationEpoch: jest.fn().mockResolvedValue(epoch),
      };
      await publishConversationTitle(deps, {
        ctx: { userId: 'user-1' },
        conversationId: 'chat',
        title: 'Generated',
        epoch: 7,
      });
      expect(deps.getGenerationEpoch).toHaveBeenCalledWith('chat');
      expect(deps.saveConvo).not.toHaveBeenCalled();
      expect(deps.titleCache.set).not.toHaveBeenCalled();
    },
  );

  it('keeps unscoped title publication independent of the epoch lookup', async () => {
    const deps = {
      saveConvo: jest.fn().mockResolvedValue({ title: 'Generated' }),
      getConvo: jest.fn(),
      titleCache: { get: jest.fn(), set: jest.fn(), delete: jest.fn() },
      getGenerationEpoch: jest.fn(),
    };
    await publishConversationTitle(deps, {
      ctx: { userId: 'user-1' },
      conversationId: 'chat',
      title: 'Generated',
    });
    expect(deps.getGenerationEpoch).not.toHaveBeenCalled();
    expect(deps.titleCache.set).toHaveBeenCalledWith('user-1-chat', 'Generated', 120_000);
  });
});

function setup(authenticated = true) {
  const cache = {
    get: jest.fn().mockResolvedValue('Generated'),
    delete: jest.fn().mockResolvedValue(true),
    set: jest.fn(),
  };
  const deps = {
    getCache: () => cache,
    getGenerationEpoch: jest.fn().mockResolvedValue(7),
    getConvoTitleState: jest.fn().mockResolvedValue(null),
    logger: { error: jest.fn() },
    delay: jest.fn().mockResolvedValue(undefined),
  };
  const handler = createGeneratedTitleHandler(deps);
  const app = express();
  app.get<{ conversationId: string }>('/title/:conversationId', async (req, res) => {
    await handler(
      { params: req.params, query: req.query, user: authenticated ? { id: 'user-1' } : undefined },
      res,
    );
  });
  return { app, cache, deps };
}

describe('generated title polling', () => {
  it('keeps legacy string cache values and generated responses compatible', async () => {
    const { app, cache, deps } = setup();
    const response = await request(app).get('/title/chat');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ title: 'Generated' });
    expect(deps.getConvoTitleState).toHaveBeenCalledWith('user-1', 'chat');
    expect(cache.delete).toHaveBeenCalledWith('user-1-chat');
  });

  it.each(['Newest rename', 'New Chat', ''])(
    'returns current manual authority for %s',
    async (title) => {
      const { app, deps } = setup();
      deps.getConvoTitleState.mockResolvedValue({ title, titleSetByUser: true, titleRevision: 2 });
      const response = await request(app).get('/title/chat');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ title, titleSetByUser: true, titleRevision: 2 });
    },
  );

  it('preserves the bounded not-ready polling delays without database reads', async () => {
    const { app, cache, deps } = setup();
    cache.get.mockResolvedValue(undefined);
    const response = await request(app).get('/title/chat');
    expect(response.status).toBe(404);
    expect(deps.delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
    expect(deps.getConvoTitleState).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('advertises a live pending title without delaying or reading the conversation', async () => {
    const { app, cache, deps } = setup();
    cache.get
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(String(Date.now() + 10_000));
    const response = await request(app).get('/title/chat?pending=1');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('title_pending');
    expect(cache.get).toHaveBeenNthCalledWith(2, 'pending:7:user-1-chat');
    expect(deps.delay).not.toHaveBeenCalled();
    expect(deps.getConvoTitleState).not.toHaveBeenCalled();
  });

  it('does not advertise an expired pending marker', async () => {
    const { app, cache, deps } = setup();
    cache.get.mockImplementation(async (key: string) =>
      key === 'pending:7:user-1-chat' ? String(Date.now() - 1) : undefined,
    );
    const response = await request(app).get('/title/chat?pending=1');
    expect(response.status).toBe(404);
    expect(response.body.code).toBeUndefined();
    expect(deps.delay).toHaveBeenCalledTimes(5);
  });

  it('lets multiple upgraded readers see the same title without consuming it', async () => {
    const { app, cache } = setup();
    for (let read = 0; read < 2; read++) {
      const response = await request(app).get('/title/chat?pending=1');
      expect(response.body).toEqual({ title: 'Generated' });
    }
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('does not consume the cache or expose diagnostics on a database failure', async () => {
    const { app, cache, deps } = setup();
    deps.getConvoTitleState.mockRejectedValue(new Error('secret-provider-payload'));
    const response = await request(app).get('/title/chat');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'title_read_failed' });
    expect(cache.delete).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith('[gen_title] Title lookup failed', {
      type: 'Error',
    });
  });

  it('does not read cache state without an authenticated owner', async () => {
    const { app, cache } = setup(false);
    expect((await request(app).get('/title/chat')).status).toBe(401);
    expect(cache.get).not.toHaveBeenCalled();
  });
});
