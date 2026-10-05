import express from 'express';
import request from 'supertest';
import { createUserKeyUpdateHandler } from './keys';

describe('user key update HTTP handler', () => {
  const updateUserKey = jest.fn();
  let app: express.Express;
  beforeEach(() => {
    updateUserKey.mockReset().mockResolvedValue(undefined);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { user: { id: 'authenticated-owner' } });
      next();
    });
    app.put('/api/keys', createUserKeyUpdateHandler({ updateUserKey }));
  });
  it.each(['google', 'openAI', 'Custom'])(
    'stores the complete %s credential envelope with one update',
    async (name) => {
      const value = JSON.stringify({
        GOOGLE_API_KEY: 'api-key',
        GOOGLE_SERVICE_KEY: { project_id: 'project' },
      });
      expect(
        (await request(app).put('/api/keys').send({ name, value, expiresAt: '' })).status,
      ).toBe(201);
      expect(updateUserKey).toHaveBeenCalledTimes(1);
      expect(updateUserKey).toHaveBeenCalledWith({
        userId: 'authenticated-owner',
        name,
        value,
        expiresAt: '',
      });
    },
  );
  it.each([
    { name: '', value: 'key' },
    { name: 'google', value: '' },
    { name: 'google', value: 'key', expiresAt: 'not-a-date' },
  ])('refuses malformed key requests', async (body) => {
    expect((await request(app).put('/api/keys').send(body)).status).toBe(400);
    expect(updateUserKey).not.toHaveBeenCalled();
  });
  it('redacts persistence errors', async () => {
    updateUserKey.mockRejectedValue(new Error('sensitive-key'));
    const response = await request(app).put('/api/keys').send({ name: 'google', value: 'key' });
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('sensitive-key');
  });
});
