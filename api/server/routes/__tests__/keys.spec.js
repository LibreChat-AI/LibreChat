const express = require('express');
const request = require('supertest');

jest.mock('~/models', () => ({
  updateUserKey: jest.fn(),
  deleteUserKey: jest.fn(),
  getUserKeyExpiry: jest.fn(),
}));

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());

let mockCredentialsConfig;

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: (req, res, next) => {
    req.config = { credentials: mockCredentialsConfig };
    next();
  },
}));

describe('Keys Routes', () => {
  let app;
  const { updateUserKey, deleteUserKey, getUserKeyExpiry } = require('~/models');

  beforeAll(() => {
    const keysRouter = require('../keys');

    app = express();
    app.use(express.json());

    app.use((req, res, next) => {
      req.user = { id: 'test-user-123' };
      next();
    });

    app.use('/api/keys', keysRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCredentialsConfig = undefined;
  });

  describe('PUT /', () => {
    it('should update a user key with the authenticated user ID', async () => {
      updateUserKey.mockResolvedValue({});

      const response = await request(app)
        .put('/api/keys')
        .send({ name: 'openAI', value: 'sk-test-key-123', expiresAt: '2026-12-31' });

      expect(response.status).toBe(201);
      expect(updateUserKey).toHaveBeenCalledWith({
        userId: 'test-user-123',
        name: 'openAI',
        value: 'sk-test-key-123',
        expiresAt: '2026-12-31',
      });
      expect(updateUserKey).toHaveBeenCalledTimes(1);
    });

    it('passes the configured credentials write format from the loaded request config', async () => {
      updateUserKey.mockResolvedValue({});
      mockCredentialsConfig = { writeFormat: 'legacy' };

      const response = await request(app).put('/api/keys').send({ name: 'openAI', value: 'sk-1' });

      expect(response.status).toBe(201);
      expect(updateUserKey).toHaveBeenCalledWith(
        expect.objectContaining({ writeFormat: 'legacy' }),
      );
    });

    it('should not allow userId override via request body (IDOR prevention)', async () => {
      updateUserKey.mockResolvedValue({});

      const response = await request(app).put('/api/keys').send({
        userId: 'attacker-injected-id',
        name: 'openAI',
        value: 'sk-attacker-key',
      });

      expect(response.status).toBe(201);
      expect(updateUserKey).toHaveBeenCalledWith({
        userId: 'test-user-123',
        name: 'openAI',
        value: 'sk-attacker-key',
        expiresAt: undefined,
      });
    });

    it('should ignore extraneous fields from request body', async () => {
      updateUserKey.mockResolvedValue({});

      const response = await request(app).put('/api/keys').send({
        name: 'openAI',
        value: 'sk-test-key',
        expiresAt: '2026-12-31',
        _id: 'injected-mongo-id',
        __v: 99,
        extra: 'should-be-ignored',
      });

      expect(response.status).toBe(201);
      expect(updateUserKey).toHaveBeenCalledWith({
        userId: 'test-user-123',
        name: 'openAI',
        value: 'sk-test-key',
        expiresAt: '2026-12-31',
      });
    });

    it('should handle missing optional fields', async () => {
      updateUserKey.mockResolvedValue({});

      const response = await request(app)
        .put('/api/keys')
        .send({ name: 'anthropic', value: 'sk-ant-key' });

      expect(response.status).toBe(201);
      expect(updateUserKey).toHaveBeenCalledWith({
        userId: 'test-user-123',
        name: 'anthropic',
        value: 'sk-ant-key',
        expiresAt: undefined,
      });
    });

    it('should return 400 when request body is null', async () => {
      const response = await request(app)
        .put('/api/keys')
        .set('Content-Type', 'application/json')
        .send('null');

      expect(response.status).toBe(400);
      expect(updateUserKey).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:name', () => {
    it('should delete a user key by name', async () => {
      deleteUserKey.mockResolvedValue({});

      const response = await request(app).delete('/api/keys/openAI');

      expect(response.status).toBe(204);
      expect(deleteUserKey).toHaveBeenCalledWith({
        userId: 'test-user-123',
        name: 'openAI',
      });
      expect(deleteUserKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('DELETE /', () => {
    it('should delete all keys when all=true', async () => {
      deleteUserKey.mockResolvedValue({});

      const response = await request(app).delete('/api/keys?all=true');

      expect(response.status).toBe(204);
      expect(deleteUserKey).toHaveBeenCalledWith({
        userId: 'test-user-123',
        all: true,
      });
    });

    it('should return 400 when all query param is not true', async () => {
      const response = await request(app).delete('/api/keys');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Specify either all=true to delete.' });
      expect(deleteUserKey).not.toHaveBeenCalled();
    });
  });

  describe('GET /', () => {
    it('should return key expiry for a given key name', async () => {
      const mockExpiry = { expiresAt: '2026-12-31' };
      getUserKeyExpiry.mockResolvedValue(mockExpiry);

      const response = await request(app).get('/api/keys?name=openAI');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockExpiry);
      expect(getUserKeyExpiry).toHaveBeenCalledWith({
        userId: 'test-user-123',
        name: 'openAI',
      });
    });
  });
});
