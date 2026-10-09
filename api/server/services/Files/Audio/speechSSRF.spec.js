jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('./streamAudio', () => ({
  getRandomVoiceId: jest.fn(),
  createChunkProcessor: jest.fn(),
  splitTextIntoChunks: jest.fn(),
}));

const axios = require('axios');
const { STTService } = require('./STTService');
const { textToSpeech } = require('./TTSService');

afterEach(() => {
  jest.restoreAllMocks();
  axios.post.mockReset();
});

describe('STT sttRequest SSRF guard (real agent)', () => {
  const audioFile = { originalname: 'a.wav', mimetype: 'audio/wav', size: 1 };
  const audioBuffer = Buffer.from('audio');
  const provider = { url: 'http://10.0.0.5:8080', apiKey: 'sk', model: 'whisper-1' };

  it('blocks a private-IP provider url with ESSRF before any request goes out', async () => {
    const service = new STTService();
    await expect(
      service.sttRequest('openai', provider, { audioBuffer, audioFile, language: '' }),
    ).rejects.toMatchObject({ code: 'ESSRF' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('exempts a host:port in the section allowedAddresses and sets maxRedirects 0 with agents', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { text: 'ok' } });
    const service = new STTService();

    await service.sttRequest('openai', provider, { audioBuffer, audioFile, language: '' }, [
      '10.0.0.5:8080',
    ]);

    const options = axios.post.mock.calls[0][2];
    expect(options.maxRedirects).toBe(0);
    expect(options.httpAgent).toBeDefined();
    expect(options.httpsAgent).toBeDefined();
  });
});

describe('TTS textToSpeech SSRF guard (real agent)', () => {
  function buildReqRes(allowedAddresses) {
    const req = {
      body: { input: 'hi', voice: 'v1' },
      user: { id: 'u1' },
      config: {
        speech: {
          tts: {
            ...(allowedAddresses ? { allowedAddresses } : {}),
            localai: { url: 'http://10.0.0.5:8080', apiKey: 'sk', voices: ['v1'] },
          },
        },
      },
    };
    const res = {
      setHeader: jest.fn(),
      headersSent: false,
      status: jest.fn(() => ({ end: jest.fn(), send: jest.fn() })),
      end: jest.fn(),
    };
    return { req, res };
  }

  it('blocks a private-IP provider url and never issues the outbound request', async () => {
    const { req, res } = buildReqRes();

    await textToSpeech(req, res);

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('exempts a host:port in the section allowedAddresses and sets maxRedirects 0 with agents', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { pipe: jest.fn(), on: jest.fn() } });
    const { req, res } = buildReqRes(['10.0.0.5:8080']);

    await textToSpeech(req, res);

    const options = axios.post.mock.calls[0][2];
    expect(options.maxRedirects).toBe(0);
    expect(options.httpAgent).toBeDefined();
    expect(options.httpsAgent).toBeDefined();
  });
});
