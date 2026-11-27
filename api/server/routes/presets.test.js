const express = require('express');
const request = require('supertest');

let mockAppConfig = {};
const mockGetPresets = jest.fn();
const mockSavePreset = jest.fn();
const mockDeletePresets = jest.fn();

jest.mock('~/models', () => ({
  getPresets: mockGetPresets,
  savePreset: mockSavePreset,
  deletePresets: mockDeletePresets,
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
  configMiddleware: (req, _res, next) => {
    req.config = mockAppConfig;
    next();
  },
}));

const app = express();
app.use(express.json());
app.use('/api/presets', require('./presets'));

const privatePattern = {
  starterPatterns: [],
  customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
};

describe('preset content filtering', () => {
  beforeEach(() => {
    mockAppConfig = {};
    mockGetPresets.mockReset();
    mockSavePreset.mockReset();
    mockDeletePresets.mockReset();
  });

  it('returns stored presets unchanged when filters are not configured', async () => {
    const storedPreset = {
      presetId: 'preset-1',
      title: 'PRIVATE-TITLE',
      promptPrefix: 'PRIVATE-PROMPT',
      endpoint: 'openAI',
    };
    mockGetPresets.mockResolvedValue([storedPreset]);

    const response = await request(app).get('/api/presets').expect(200);

    expect(response.body).toEqual([storedPreset]);
    expect(mockGetPresets).toHaveBeenCalledWith('user-1');
  });

  it('redacts every policy-covered field from blocked stored presets', async () => {
    const safePreset = {
      presetId: 'safe-preset',
      title: 'Safe preset',
      promptPrefix: 'Safe instructions',
      endpoint: 'openAI',
    };
    const blockedPreset = {
      _id: 'blocked-record',
      presetId: 'blocked-preset',
      user: 'user-1',
      title: 'PRIVATE-TITLE',
      promptPrefix: 'PRIVATE-PROMPT',
      system: 'PRIVATE-SYSTEM',
      context: 'PRIVATE-CONTEXT',
      instructions: 'PRIVATE-INSTRUCTIONS',
      additional_instructions: 'PRIVATE-ADDITIONAL',
      greeting: 'PRIVATE-GREETING',
      examples: [{ input: 'PRIVATE-INPUT', output: 'PRIVATE-OUTPUT' }],
      endpoint: 'openAI',
      model: 'gpt-safe',
      order: 2,
    };
    mockGetPresets.mockResolvedValue([safePreset, blockedPreset]);
    mockAppConfig = {
      filters: {
        prompts: {
          pii: privatePattern,
        },
      },
    };

    const response = await request(app).get('/api/presets').expect(200);

    expect(response.body[0]).toEqual(safePreset);
    expect(response.body[1]).toEqual({
      _id: 'blocked-record',
      presetId: 'blocked-preset',
      user: 'user-1',
      title: '',
      endpoint: 'openAI',
      model: 'gpt-safe',
      order: 2,
      contentFilterBlocked: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-');
  });

  it('redacts blocked nested model request fields under the model-parameter scope', async () => {
    mockGetPresets.mockResolvedValue([
      {
        presetId: 'blocked-options',
        title: 'Safe title',
        endpoint: 'openAI',
        options: {
          vendor: {
            routingHint: 'PRIVATE-ROUTE',
          },
        },
      },
    ]);
    mockAppConfig = {
      filters: {
        modelParameters: {
          pii: privatePattern,
        },
      },
    };

    const response = await request(app).get('/api/presets').expect(200);

    expect(response.body).toEqual([
      {
        presetId: 'blocked-options',
        title: '',
        endpoint: 'openAI',
        contentFilterBlocked: true,
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE-ROUTE');
  });

  it('fails closed when selected stored preset fields exceed bounded traversal', async () => {
    mockGetPresets.mockResolvedValue([
      {
        presetId: 'oversized-examples',
        title: 'Safe title',
        endpoint: 'openAI',
        examples: Array.from({ length: 4_097 }, () => ({
          input: 'Safe input',
          output: 'Safe output',
        })),
      },
    ]);
    mockAppConfig = {
      filters: {
        prompts: {
          pii: { ...privatePattern, fields: ['example_input'] },
        },
      },
    };

    const response = await request(app).get('/api/presets').expect(200);

    expect(response.body).toEqual([
      {
        presetId: 'oversized-examples',
        title: '',
        endpoint: 'openAI',
        contentFilterBlocked: true,
      },
    ]);
  });

  it('does not apply a message-only policy to stored preset content', async () => {
    const storedPreset = {
      presetId: 'preset-1',
      title: 'PRIVATE-TITLE',
      promptPrefix: 'PRIVATE-PROMPT',
      endpoint: 'openAI',
    };
    mockGetPresets.mockResolvedValue([storedPreset]);
    mockAppConfig = {
      filters: {
        messages: {
          pii: privatePattern,
        },
      },
    };

    const response = await request(app).get('/api/presets').expect(200);

    expect(response.body).toEqual([storedPreset]);
  });
});
