const http = require('node:http');
const express = require('express');
const { once } = require('node:events');

jest.mock('./streamAudio', () => ({
  getRandomVoiceId: (voices) => voices[0],
  createChunkProcessor: jest.fn(),
  splitTextIntoChunks: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const { logger } = require('@librechat/data-schemas');
const { createChunkProcessor, splitTextIntoChunks } = require('./streamAudio');
const { TTSService } = require('./TTSService');

/**
 * A text-to-speech provider that records every text it is asked to speak. A held provider never
 * answers, and emits `canceled` when the caller gives up on a request.
 */
async function startProvider({ hold = false } = {}) {
  const spoken = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      spoken.push(JSON.parse(body).input);
      server.emit('spoken');
      if (hold) {
        res.on('close', () => server.emit('canceled'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(`audio-${spoken.length};`);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, spoken, port: server.address().port };
}

/** Serves `handle` behind Express body parsing, as the speech routes are. */
async function startApp(provider, handle) {
  const app = express();
  const handled = [];
  app.use(express.json());
  app.post(/.*/, (req, res) => {
    req.user = { id: 'user-1' };
    req.config = {
      speech: {
        tts: {
          allowedAddresses: [`127.0.0.1:${provider.port}`],
          openai: {
            url: `http://127.0.0.1:${provider.port}/v1/audio/speech`,
            apiKey: 'sk-test',
            model: 'tts-1',
            voices: ['alloy'],
          },
        },
      },
    };
    handled.push(handle(req, res));
  });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, handled, port: server.address().port };
}

/**
 * Runs `handle` only once the client is gone, as when it leaves while the route's middleware
 * (authentication, limits, the audio run lock) still runs. `reached` resolves as the request
 * reaches the route, so the caller knows when to leave.
 */
function afterClientLeft(handle) {
  let enter;
  const reached = new Promise((resolve) => (enter = resolve));
  const wrapped = async (req, res) => {
    enter();
    if (!res.destroyed) {
      await once(res, 'close');
    }
    await handle(req, res);
  };
  return { reached, wrapped };
}

function post(port, path, body) {
  const request = http.request({
    port,
    path,
    host: '127.0.0.1',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  request.on('error', () => undefined);
  request.end(JSON.stringify(body));
  return request;
}

/** Scripted reads of a message being written: one result per read, then nothing new. */
function scriptPolls(results) {
  const polls = { count: 0, waiters: [] };
  createChunkProcessor.mockReturnValue(async () => {
    polls.count++;
    polls.waiters[polls.count - 1]?.();
    return results[polls.count - 1] ?? [];
  });
  polls.reach = (count) => new Promise((resolve) => (polls.waiters[count - 1] = resolve));
  return polls;
}

describe('TTSService speech for a listener', () => {
  const servers = [];
  const service = new TTSService();

  async function serve(handle, options) {
    const provider = await startProvider(options);
    const app = await startApp(provider, handle);
    servers.push(provider.server, app.server);
    return { provider, app };
  }

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  it('speaks every segment of a message in order to a listener who stays', async () => {
    scriptPolls([
      [{ text: 'The first sentence is spoken.', isFinished: false }],
      [],
      [{ text: 'The second sentence is spoken too.', isFinished: true }],
    ]);
    const { provider, app } = await serve((req, res) => service.streamAudio(req, res));

    const request = post(app.port, '/', { messageId: 'message-1', voice: 'alloy' });
    const [response] = await once(request, 'response');
    let audio = '';
    response.on('data', (chunk) => (audio += chunk));
    await once(response, 'end');
    await Promise.all(app.handled);

    expect(response.statusCode).toBe(200);
    expect(audio).toBe('audio-1;audio-2;');
    expect(provider.spoken).toEqual([
      'The first sentence is spoken.',
      'The second sentence is spoken too.',
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('stops reading the message and asks for no more speech once the listener leaves between segments', async () => {
    const polls = scriptPolls([
      [{ text: 'The first sentence is spoken.', isFinished: false }],
      [],
      [{ text: 'The second sentence is never paid for.', isFinished: true }],
    ]);
    const { provider, app } = await serve((req, res) => service.streamAudio(req, res));
    /** The second read finds nothing new, so playback waits before reading again. */
    const waiting = polls.reach(2);

    const request = post(app.port, '/', { messageId: 'message-1', voice: 'alloy' });
    const [response] = await once(request, 'response');
    response.on('error', () => undefined);
    await waiting;
    request.destroy();
    await Promise.all(app.handled);

    expect(provider.spoken).toEqual(['The first sentence is spoken.']);
    expect(polls.count).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('asks for no speech for a listener who left before automatic playback started', async () => {
    const polls = scriptPolls([[{ text: 'Nobody is listening.', isFinished: true }]]);
    const { reached, wrapped } = afterClientLeft((req, res) => service.streamAudio(req, res));
    const { provider, app } = await serve(wrapped);

    const request = post(app.port, '/', { messageId: 'message-1', voice: 'alloy' });
    await reached;
    request.destroy();
    await Promise.all(app.handled);

    expect(provider.spoken).toEqual([]);
    expect(polls.count).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a short text', 'Read this aloud.'],
    ['a long text read in chunks', 'Read this long text aloud. '.repeat(160)],
  ])(
    'asks for no speech for a listener who left before read-aloud of %s started',
    async (_, input) => {
      splitTextIntoChunks.mockReturnValue([
        { text: 'The first chunk.', isFinished: false },
        { text: 'The second chunk.', isFinished: true },
      ]);
      const { reached, wrapped } = afterClientLeft((req, res) =>
        service.processTextToSpeech(req, res),
      );
      const { provider, app } = await serve(wrapped);

      const request = post(app.port, '/manual', { input, voice: 'alloy' });
      await reached;
      request.destroy();
      await Promise.all(app.handled);

      expect(provider.spoken).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it('logs a listener who leaves during a provider request as a disconnect, not an error', async () => {
    scriptPolls([[{ text: 'The listener leaves while this is spoken.', isFinished: true }]]);
    const { provider, app } = await serve((req, res) => service.streamAudio(req, res), {
      hold: true,
    });

    const request = post(app.port, '/', { messageId: 'message-1', voice: 'alloy' });
    await once(provider.server, 'spoken');
    const canceled = once(provider.server, 'canceled');
    request.destroy();
    await Promise.all(app.handled);
    await canceled;

    expect(provider.spoken).toEqual(['The listener leaves while this is spoken.']);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/Client disconnected$/));
  });
});
