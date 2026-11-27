const express = require('express');
const request = require('supertest');

const mockBlockResponse = {
  error: 'content_filter_block',
  message: 'Submitted content contains a protected value. Remove it and try again.',
  source: 'message',
  field: 'text',
};

jest.mock('@librechat/api', () => ({
  inspectContent: jest.fn(),
  extractStoredMessageContent: jest.fn((input) => [input]),
  contentFilterBlockResponse: jest.fn(() => mockBlockResponse),
  restoreTenantContextFromReq: (req, res, next) => next(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
}));

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { AUDIO_RUNS: 'audio-runs' },
  hasActivePiiFields: jest.fn((pii, candidates) => {
    if (pii == null) {
      return false;
    }
    const hasPatterns =
      pii.starterPatterns == null ||
      pii.starterPatterns.length > 0 ||
      (pii.customPatterns?.length ?? 0) > 0;
    return (
      hasPatterns && candidates.some((field) => pii.fields == null || pii.fields.includes(field))
    );
  }),
}));

jest.mock('~/server/services/Files/Audio', () => ({
  getVoices: jest.fn(),
  streamAudio: jest.fn(),
  textToSpeech: jest.fn((req, res) => res.sendStatus(200)),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));

const {
  inspectContent,
  extractStoredMessageContent,
  contentFilterBlockResponse,
} = require('@librechat/api');
const { textToSpeech } = require('~/server/services/Files/Audio');
const router = require('./tts');

const createApp = (config) => {
  const app = express();
  app.use((req, res, next) => {
    req.config = config;
    next();
  });
  app.use(router);
  return app;
};

describe('manual TTS content filtering', () => {
  beforeEach(() => {
    inspectContent.mockReturnValue(null);
  });

  it('blocks configured message content before calling the TTS provider', async () => {
    const filters = { messages: { pii: {} } };
    const finding = {
      label: 'protected value',
      source: 'message',
      field: 'text',
    };
    inspectContent.mockReturnValueOnce(finding);

    const response = await request(createApp({ filters }))
      .post('/manual')
      .field('input', 'submitted text');

    expect(response.status).toBe(400);
    expect(response.body).toEqual(mockBlockResponse);
    expect(extractStoredMessageContent).toHaveBeenCalledWith({ text: 'submitted text' });
    expect(inspectContent).toHaveBeenCalledWith([{ text: 'submitted text' }], {
      filters,
    });
    expect(contentFilterBlockResponse).toHaveBeenCalledWith(finding);
    expect(textToSpeech).not.toHaveBeenCalled();
  });

  it('preserves the default-off path without inspecting the input', async () => {
    const response = await request(createApp({})).post('/manual').field('input', 'submitted text');

    expect(response.status).toBe(200);
    expect(inspectContent).not.toHaveBeenCalled();
    expect(textToSpeech).toHaveBeenCalledTimes(1);
  });

  it('preserves the input path when the selected message policy has no active patterns', async () => {
    const filters = {
      messages: {
        pii: { fields: ['text'], starterPatterns: [], customPatterns: [] },
      },
    };

    const response = await request(createApp({ filters }))
      .post('/manual')
      .field('input', 'submitted text');

    expect(response.status).toBe(200);
    expect(inspectContent).not.toHaveBeenCalled();
    expect(textToSpeech).toHaveBeenCalledTimes(1);
  });

  it('does not broaden the legacy chat-only filter to manual TTS', async () => {
    const response = await request(createApp({ messageFilter: { pii: {} } }))
      .post('/manual')
      .field('input', 'submitted text');

    expect(response.status).toBe(200);
    expect(inspectContent).not.toHaveBeenCalled();
    expect(textToSpeech).toHaveBeenCalledTimes(1);
  });
});
