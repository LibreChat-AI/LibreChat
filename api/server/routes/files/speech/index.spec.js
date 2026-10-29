const express = require('express');
const request = require('supertest');
const { RealtimeTranscriptionErrorCode } = require('librechat-data-provider');

const hits = { sttIp: 0, sttUser: 0 };

jest.mock('~/server/middleware', () => ({
  createSTTLimiters: jest.fn(() => ({
    sttIpLimiter: (req, res, next) => {
      hits.sttIp++;
      next();
    },
    sttUserLimiter: (req, res, next) => {
      hits.sttUser++;
      next();
    },
  })),
  createTTSLimiters: jest.fn(() => ({
    ttsIpLimiter: (req, res, next) => next(),
    ttsUserLimiter: (req, res, next) => next(),
  })),
}));

jest.mock('~/server/services/Files/Audio', () => ({
  speechToText: jest.fn((req, res) => res.status(200).json({ text: 'recorded' })),
}));
jest.mock('./tts', () => require('express').Router());
jest.mock('./customConfigSpeech', () => require('express').Router());

const liveConfig = {
  speech: {
    stt: {
      openai: { apiKey: 'sk', model: 'gpt-transcribe', realtime: { model: 'gpt-live-transcribe' } },
    },
  },
};

describe('speech route wiring', () => {
  let config;
  let app;

  beforeAll(() => {
    const speech = require('./index');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.config = config;
      next();
    });
    app.use('/api/files/speech', speech);
  });

  beforeEach(() => {
    hits.sttIp = 0;
    hits.sttUser = 0;
    config = liveConfig;
  });

  it('meters the live transcription route with both STT limiters', async () => {
    const response = await request(app)
      .post('/api/files/speech/stt/realtime')
      .send({ sdp: 'not an offer' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: RealtimeTranscriptionErrorCode.INVALID_OFFER });
    expect(hits.sttIp).toBe(1);
    expect(hits.sttUser).toBe(1);
  });

  it('reports live transcription as not configured without a realtime block', async () => {
    config = { speech: { stt: { openai: { apiKey: 'sk', model: 'gpt-transcribe' } } } };

    const response = await request(app)
      .post('/api/files/speech/stt/realtime')
      .send({ sdp: 'v=0\r\n' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: RealtimeTranscriptionErrorCode.NOT_CONFIGURED });
  });

  it('keeps the recorded transcription route in place', async () => {
    const response = await request(app).post('/api/files/speech/stt').send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ text: 'recorded' });
    expect(hits.sttIp).toBe(1);
  });
});
