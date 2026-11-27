import express from 'express';
import request from 'supertest';
import { createGeneratedTitleHandler } from './title';

function setup(authenticated = true) {
  const cache = {
    get: jest.fn().mockResolvedValue('Generated'),
    delete: jest.fn().mockResolvedValue(true),
    set: jest.fn(),
  };
  const deps = {
    getCache: () => cache,
    getConvoTitleState: jest.fn().mockResolvedValue(null),
    logger: { error: jest.fn() },
    delay: jest.fn().mockResolvedValue(undefined),
  };
  const handler = createGeneratedTitleHandler(deps);
  const app = express();
  app.get<{ conversationId: string }>('/title/:conversationId', async (req, res) => {
    await handler({ params: req.params, user: authenticated ? { id: 'user-1' } : undefined }, res);
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
