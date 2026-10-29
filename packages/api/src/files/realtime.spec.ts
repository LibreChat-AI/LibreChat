import http from 'http';
import { logger } from '@librechat/data-schemas';
import { RealtimeTranscriptionErrorCode } from 'librechat-data-provider';
import type { Response } from 'express';
import type { AddressInfo } from 'net';
import type { STTConfig } from './transcription';
import {
  openRealtimeTranscription,
  getRealtimeTranscriptionTarget,
  isRealtimeTranscriptionAvailable,
  buildRealtimeTranscriptionSession,
  createRealtimeTranscriptionHandler,
} from './realtime';

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const API_KEY = 'sk-test-configured-key';
const CLIENT_SECRET = 'ek_test_ephemeral_secret';
const PROVIDER_DETAIL = 'PROVIDER-ECHO private request detail';

interface RecordedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type ProviderReply = { status: number; type: string; body: string };

const liveConfig = (overrides: Record<string, unknown> = {}): STTConfig => ({
  openai: {
    apiKey: API_KEY,
    model: 'gpt-transcribe',
    prompt: 'Retail and software terms.',
    keywords: ['LibreChat'],
    languages: ['de', 'en'],
    realtime: { model: 'gpt-live-transcribe', delay: 'low' },
    ...overrides,
  },
});

describe('getRealtimeTranscriptionTarget', () => {
  it('is off without an OpenAI realtime block', () => {
    expect(getRealtimeTranscriptionTarget(undefined)).toBeNull();
    expect(
      getRealtimeTranscriptionTarget({ openai: { apiKey: 'k', model: 'whisper-1' } }),
    ).toBeNull();
    expect(
      getRealtimeTranscriptionTarget({
        openai: { apiKey: 'k', model: 'm', realtime: { model: ' ' } },
      }),
    ).toBeNull();
  });

  it('is off for Azure OpenAI and for configs the recorded path rejects', () => {
    expect(
      getRealtimeTranscriptionTarget({
        azureOpenAI: { apiKey: 'k', instanceName: 'i', deploymentName: 'd', apiVersion: 'v' },
      }),
    ).toBeNull();
    expect(
      getRealtimeTranscriptionTarget({
        ...liveConfig(),
        azureOpenAI: { apiKey: 'k', instanceName: 'i', deploymentName: 'd', apiVersion: 'v' },
      }),
    ).toBeNull();
    expect(isRealtimeTranscriptionAvailable({ openai: { apiKey: 'k', model: 'm' } })).toBe(false);
  });

  it('defaults to the OpenAI API and normalizes the configured base URL', () => {
    expect(getRealtimeTranscriptionTarget(liveConfig())).toMatchObject({
      url: 'https://api.openai.com/v1',
      model: 'gpt-live-transcribe',
      delay: 'low',
    });
    expect(
      getRealtimeTranscriptionTarget({
        allowedAddresses: ['10.0.0.5:8443'],
        ...liveConfig({
          realtime: { url: 'https://example.openai.azure.com/openai/v1/', model: 'live' },
        }),
      }),
    ).toMatchObject({
      url: 'https://example.openai.azure.com/openai/v1',
      allowedAddresses: ['10.0.0.5:8443'],
    });
    expect(isRealtimeTranscriptionAvailable(liveConfig())).toBe(true);
  });
});

describe('buildRealtimeTranscriptionSession', () => {
  it('builds a manual-commit gpt-live-transcribe session with hints and delay', () => {
    const target = getRealtimeTranscriptionTarget(liveConfig())!;

    expect(buildRealtimeTranscriptionSession(target, 'en-US')).toEqual({
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: 'gpt-live-transcribe',
            prompt: 'Retail and software terms.',
            keywords: ['LibreChat'],
            languages: ['en'],
            delay: 'low',
          },
          turn_detection: null,
        },
      },
    });
  });

  it('gives older realtime models the singular language and no hint-only fields', () => {
    const target = getRealtimeTranscriptionTarget(
      liveConfig({ realtime: { model: 'gpt-4o-mini-transcribe', delay: 'low' } }),
    )!;

    const { transcription, turn_detection } = buildRealtimeTranscriptionSession(target, 'de-DE')
      .audio.input;

    expect(transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
      prompt: 'Retail and software terms.',
      language: 'de',
    });
    expect(turn_detection).toBeNull();
  });
});

describe('openRealtimeTranscription', () => {
  let server: http.Server;
  let baseUrl: string;
  let allowedAddresses: string[];
  let requests: RecordedRequest[];
  let replies: Record<string, ProviderReply>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const reply = replies[req.url ?? ''] ?? { status: 404, type: 'text/plain', body: '' };
        res.writeHead(reply.status, { 'Content-Type': reply.type });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
    allowedAddresses = [`127.0.0.1:${port}`];
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    requests = [];
    replies = {
      '/v1/realtime/client_secrets': {
        status: 200,
        type: 'application/json',
        body: JSON.stringify({ value: CLIENT_SECRET, expires_at: 1 }),
      },
      '/v1/realtime/calls': { status: 201, type: 'application/sdp', body: ANSWER },
    };
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const localConfig = (overrides: Record<string, unknown> = {}): STTConfig => ({
    allowedAddresses,
    ...liveConfig({
      realtime: { url: baseUrl, model: 'gpt-live-transcribe', delay: 'minimal' },
      ...overrides,
    }),
  });

  it('mints a client secret with the server key, then exchanges the SDP with that secret', async () => {
    const result = await openRealtimeTranscription(localConfig(), {
      sdp: OFFER,
      language: 'zh-TW',
    });

    expect(result).toEqual({ ok: true, sdp: ANSWER });
    expect(requests).toHaveLength(2);

    const [secretRequest, callRequest] = requests;
    expect(secretRequest.method).toBe('POST');
    expect(secretRequest.url).toBe('/v1/realtime/client_secrets');
    expect(secretRequest.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(secretRequest.body)).toEqual({
      expires_after: { anchor: 'created_at', seconds: 60 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: {
              model: 'gpt-live-transcribe',
              prompt: 'Retail and software terms.',
              keywords: ['LibreChat'],
              languages: ['zh-tw'],
              delay: 'minimal',
            },
            turn_detection: null,
          },
        },
      },
    });

    expect(callRequest.url).toBe('/v1/realtime/calls');
    expect(callRequest.headers.authorization).toBe(`Bearer ${CLIENT_SECRET}`);
    expect(callRequest.headers['content-type']).toBe('application/sdp');
    expect(callRequest.body).toBe(OFFER);
  });

  it('returns no credential to the browser', async () => {
    const result = await openRealtimeTranscription(localConfig(), { sdp: OFFER });

    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });

  it('reports a missing realtime block as not configured without calling the provider', async () => {
    const result = await openRealtimeTranscription(
      { allowedAddresses, openai: { apiKey: API_KEY, model: 'gpt-transcribe' } },
      { sdp: OFFER },
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      code: RealtimeTranscriptionErrorCode.NOT_CONFIGURED,
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['a missing offer', undefined],
    ['a non-string offer', { type: 'offer' }],
    ['a non-SDP offer', 'hello'],
    ['an oversized offer', `v=0\r\n${'a'.repeat(64 * 1024)}`],
  ])('rejects %s without calling the provider', async (_label, sdp) => {
    const result = await openRealtimeTranscription(localConfig(), { sdp } as never);

    expect(result).toEqual({
      ok: false,
      status: 400,
      code: RealtimeTranscriptionErrorCode.INVALID_OFFER,
    });
    expect(requests).toHaveLength(0);
  });

  it('ignores an oversized language instead of forwarding it', async () => {
    await openRealtimeTranscription(localConfig(), { sdp: OFFER, language: 'e'.repeat(36) });

    const { transcription } = JSON.parse(requests[0].body).session.audio.input;
    expect(transcription.languages).toEqual(['de', 'en']);
  });

  it('hides provider detail when the client secret is refused', async () => {
    replies['/v1/realtime/client_secrets'] = {
      status: 401,
      type: 'application/json',
      body: JSON.stringify({ error: { message: PROVIDER_DETAIL } }),
    };

    const result = await openRealtimeTranscription(localConfig(), { sdp: OFFER });

    expect(result).toEqual({
      ok: false,
      status: 502,
      code: RealtimeTranscriptionErrorCode.PROVIDER_ERROR,
    });
    expect(requests).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[STT] Failed to open a live transcription session:',
      { type: 'Error', status: 401 },
    );
    expect(JSON.stringify(result)).not.toContain(PROVIDER_DETAIL);
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain(PROVIDER_DETAIL);
  });

  it('fails when the provider answers without a client secret', async () => {
    replies['/v1/realtime/client_secrets'] = {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({ expires_at: 1 }),
    };

    const result = await openRealtimeTranscription(localConfig(), { sdp: OFFER });

    expect(result).toMatchObject({
      ok: false,
      code: RealtimeTranscriptionErrorCode.PROVIDER_ERROR,
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['rejects the call', { status: 400, type: 'application/json', body: '{"error":{}}' }],
    ['answers with something other than SDP', { status: 201, type: 'text/plain', body: 'nope' }],
  ])('fails when the provider %s', async (_label, reply) => {
    replies['/v1/realtime/calls'] = reply;

    const result = await openRealtimeTranscription(localConfig(), { sdp: OFFER });

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      code: RealtimeTranscriptionErrorCode.PROVIDER_ERROR,
    });
    expect(requests).toHaveLength(2);
  });

  it('blocks a private realtime URL unless allowedAddresses exempts it', async () => {
    const blocked = await openRealtimeTranscription(
      { ...localConfig(), allowedAddresses: undefined },
      { sdp: OFFER },
    );

    expect(blocked).toMatchObject({
      ok: false,
      code: RealtimeTranscriptionErrorCode.PROVIDER_ERROR,
    });
    expect(requests).toHaveLength(0);
  });
});

describe('createRealtimeTranscriptionHandler', () => {
  const createResponse = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  };

  it('responds with the coded error when live transcription is off', async () => {
    const res = createResponse();

    await createRealtimeTranscriptionHandler()(
      { config: { speech: {} }, body: { sdp: OFFER } } as never,
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: RealtimeTranscriptionErrorCode.NOT_CONFIGURED });
  });

  it('responds with the coded error for an invalid offer', async () => {
    const res = createResponse();

    await createRealtimeTranscriptionHandler()(
      { config: { speech: { stt: liveConfig() } }, body: {} } as never,
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: RealtimeTranscriptionErrorCode.INVALID_OFFER });
  });
});
