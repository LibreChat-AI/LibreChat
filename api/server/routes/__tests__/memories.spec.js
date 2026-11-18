const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  generateCheckAccess: jest.fn(() => (req, res, next) => next()),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  getAllUserMemories: jest.fn(),
  getUserMemories: jest.fn(),
  toggleUserMemories: jest.fn(),
  getRoleByName: jest.fn(),
  createMemory: jest.fn(),
  deleteMemory: jest.fn(),
  setMemory: jest.fn(),
  getAgents: jest.fn(),
}));

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
}));

const { Tokenizer } = require('@librechat/api');
const { createMemory, getUserMemories, setMemory } = require('~/models');

/** Over the tokenizer's 4 KiB slice length, where the cold-start estimate is the byte length. */
const LONG_VALUE = 'The user prefers concise answers about gardening. '.repeat(100).trim();

/** Drops the loaded o200k encoding so the next count runs as the first one after startup. */
function resetTokenizer() {
  delete Tokenizer.tokenizersCache.o200k_base;
  delete Tokenizer.loadingPromises.o200k_base;
}

async function exactTokenCount(value) {
  const count = await Tokenizer.createExactTokenCounter('o200k_base');
  return count(value);
}

describe('memories routes', () => {
  let app;

  beforeAll(() => {
    const memoriesRouter = require('../memories');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 'user-1', role: 'USER' };
      next();
    });
    app.use('/api/memories', memoriesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /', () => {
    it('returns 400 when the key contains invalid characters', async () => {
      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'My Key!', value: 'some value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('lowercase letters and underscores');
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('returns 400 when the key contains uppercase letters', async () => {
      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'myKey', value: 'some value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('lowercase letters and underscores');
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('creates a memory when the key is valid', async () => {
      getUserMemories
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ key: 'my_key', value: 'some value', tokenCount: 5 }]);
      createMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'my_key', value: 'some value' });

      expect(response.status).toBe(201);
      expect(response.body.created).toBe(true);
      expect(createMemory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', key: 'my_key' }),
      );
    });

    it('stores the exact token count for a long value saved before the tokenizer loads', async () => {
      resetTokenizer();
      getUserMemories.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      createMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'long_key', value: LONG_VALUE });

      expect(response.status).toBe(201);
      const { tokenCount } = createMemory.mock.calls[0][0];
      expect(tokenCount).toBe(await exactTokenCount(LONG_VALUE));
      expect(tokenCount).toBeLessThan(Buffer.byteLength(LONG_VALUE, 'utf8') / 2);
    });
  });

  describe('PATCH /:key', () => {
    it('stores the exact token count for a long update saved before the tokenizer loads', async () => {
      resetTokenizer();
      getUserMemories
        .mockResolvedValueOnce([{ key: 'my_key', value: 'old value', tokenCount: 5 }])
        .mockResolvedValueOnce([]);
      setMemory.mockResolvedValue({ ok: true });

      const response = await request(app).patch('/api/memories/my_key').send({ value: LONG_VALUE });

      expect(response.status).toBe(200);
      const { tokenCount } = setMemory.mock.calls[0][0];
      expect(tokenCount).toBe(await exactTokenCount(LONG_VALUE));
      expect(tokenCount).toBeLessThan(Buffer.byteLength(LONG_VALUE, 'utf8') / 2);
    });

    it('returns 400 when renaming to a key with invalid characters', async () => {
      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: 'New Key', value: 'updated value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('lowercase letters and underscores');
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('returns 400 when the key is not a string', async () => {
      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: 123, value: 'updated value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Key must be a string.');
      expect(setMemory).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only rename instead of updating the existing memory', async () => {
      getUserMemories.mockResolvedValue([{ key: 'my_key', value: 'old value', tokenCount: 5 }]);
      setMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: ' \t\n ', value: 'updated value' });

      expect(response.status).toBe(400);
      expect(setMemory).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('trims the new key before validating and renaming', async () => {
      const { deleteMemory } = require('~/models');
      getUserMemories
        .mockResolvedValueOnce([{ key: 'my_key', value: 'old value', tokenCount: 5 }])
        .mockResolvedValueOnce([{ key: 'new_key', value: 'updated value', tokenCount: 5 }]);
      createMemory.mockResolvedValue({ ok: true });
      deleteMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: '  new_key  ', value: 'updated value' });

      expect(response.status).toBe(200);
      expect(createMemory).toHaveBeenCalledWith(expect.objectContaining({ key: 'new_key' }));
      expect(deleteMemory).toHaveBeenCalledWith(expect.objectContaining({ key: 'my_key' }));
    });

    it('updates the value when the key is unchanged', async () => {
      getUserMemories
        .mockResolvedValueOnce([{ key: 'my_key', value: 'old value', tokenCount: 5 }])
        .mockResolvedValueOnce([{ key: 'my_key', value: 'updated value', tokenCount: 5 }]);
      setMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ value: 'updated value' });

      expect(response.status).toBe(200);
      expect(response.body.updated).toBe(true);
      expect(setMemory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', key: 'my_key' }),
      );
    });
  });
});
