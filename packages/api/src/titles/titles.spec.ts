import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { TitleMarker, TitleTasks } from './task';
import type { ServerRequest } from '~/types';
import type { TitleOwner } from './stream';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { TitleStream, titleKey, titleStreamId } from './stream';
import { createTitleStreamHandler } from './route';
import { createTitleTasks } from './task';

type Methods = Pick<
  ConversationMethods,
  'saveConvo' | 'getConvo' | 'getConvoTitleState' | 'deleteConvos'
>;

let mongoServer: MongoMemoryServer;
let methods: Methods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** A generation the test releases by hand, which also ends when its signal aborts. */
const heldTitle = () => {
  const held = deferred<string | undefined>();
  let signal: AbortSignal | undefined;
  const generate = jest.fn((received: AbortSignal) => {
    signal = received;
    received.addEventListener('abort', () => held.resolve(undefined), { once: true });
    return held.promise;
  });
  return { generate, release: held.resolve, signal: () => signal };
};

function setup() {
  const store = new Map<string, TitleMarker>();
  const markers = {
    get: jest.fn(async (key: string) => store.get(key)),
    set: jest.fn(async (key: string, marker: TitleMarker) => store.set(key, marker)),
    delete: jest.fn(async (key: string) => store.delete(key)),
  };
  const legacy = new Map<string, string>();
  const cache = { set: jest.fn(async (key: string, title: string) => legacy.set(key, title)) };
  const transport = new InMemoryEventTransport();
  const stream = new TitleStream(transport);
  const logger = { debug: jest.fn(), error: jest.fn() };
  const tasks: TitleTasks = createTitleTasks({
    saveConvo: methods.saveConvo,
    getConvoTitleState: methods.getConvoTitleState,
    markers,
    cache,
    stream,
    logger,
  });
  const handler = createTitleStreamHandler({
    getConvoTitleState: methods.getConvoTitleState,
    markers,
    stream,
    logger,
  });
  const app = express();
  app.get('/:userId/:conversationId/title/stream', (req, res) => {
    void handler(Object.assign(req, { user: { id: req.params.userId } }) as ServerRequest, res);
  });
  return { store, markers, legacy, transport, stream, logger, tasks, app };
}

const owner = (): TitleOwner => ({ userId: `user-${randomUUID()}`, conversationId: randomUUID() });

const ctxFor = ({ userId }: TitleOwner) => ({ userId });

/** Creates the conversation row a first turn's user message write would create. */
const createRow = (target: TitleOwner, title: string | null = 'New Chat') =>
  methods.saveConvo(
    ctxFor(target),
    { conversationId: target.conversationId, endpoint: 'agents', title: title ?? undefined },
    { context: 'titles.spec row' },
  );

/** Every settlement the stream publishes for a conversation. */
const listen = (stream: TitleStream, target: TitleOwner) => {
  const settled: unknown[] = [];
  const subscription = stream.subscribe(target, {
    onSettled: (settlement) => settled.push(settlement),
    onError: jest.fn(),
  });
  return { settled, subscription };
};

const readStream = (app: express.Express, target: TitleOwner, userId = target.userId) =>
  request(app)
    .get(`/${userId}/${target.conversationId}/title/stream`)
    .buffer(true)
    .parse((res, done) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => done(null, body));
    })
    .then((response) =>
      (response.body as string)
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice('data: '.length))),
    );

const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
};

describe('title task', () => {
  it('saves the title, then settles it, after the chat that admitted it has moved on', async () => {
    const { tasks, stream, store, legacy } = setup();
    const target = owner();
    await createRow(target);
    const { settled } = listen(stream, target);
    const title = heldTitle();

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    expect(store.get(titleKey(target))?.attempt).toBe(attempt.id);
    const run = attempt.run({ generate: title.generate, timeoutMs: 60_000 });

    await waitFor(() => title.generate.mock.calls.length === 1);
    expect(settled).toEqual([]);
    title.release('Late Title');
    await run;

    const row = await methods.getConvo(target.userId, target.conversationId);
    expect(row?.title).toBe('Late Title');
    expect(settled).toEqual([
      {
        attempt: attempt.id,
        title: { conversationId: target.conversationId, title: 'Late Title' },
      },
    ]);
    expect(store.has(titleKey(target))).toBe(false);
    expect(legacy.get(`${target.userId}-${target.conversationId}`)).toBe('Late Title');
  });

  it('cancels a generation that outlives its own deadline', async () => {
    const { tasks, stream } = setup();
    const target = owner();
    await createRow(target);
    const { settled } = listen(stream, target);
    const title = heldTitle();

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    await attempt.run({ generate: title.generate, timeoutMs: 50 });

    expect(title.signal()?.aborted).toBe(true);
    expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe('New Chat');
    expect(settled).toEqual([{ attempt: attempt.id }]);
  });

  it('waits for the conversation row before saving', async () => {
    const { tasks } = setup();
    const target = owner();
    const ready = deferred<void>();

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    const run = attempt.run({
      generate: async () => 'Early Title',
      ready: ready.promise,
      timeoutMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await createRow(target);
    ready.resolve();
    await run;

    expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe(
      'Early Title',
    );
  });

  it('keeps a manual rename made while the title was generating', async () => {
    const { tasks, stream } = setup();
    const target = owner();
    await createRow(target);
    const { settled } = listen(stream, target);
    const title = heldTitle();

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    const run = attempt.run({ generate: title.generate, timeoutMs: 60_000 });
    await methods.saveConvo(
      ctxFor(target),
      { conversationId: target.conversationId, title: 'My Rename' },
      { context: 'titles.spec rename', titleSource: 'manual' },
    );
    title.release('Generated Title');
    await run;

    const row = await methods.getConvo(target.userId, target.conversationId);
    expect(row?.title).toBe('My Rename');
    expect(settled).toEqual([
      {
        attempt: attempt.id,
        title: expect.objectContaining({ title: 'My Rename', titleSetByUser: true }),
      },
    ]);
  });

  it('never recreates a conversation deleted while its title was generating', async () => {
    const { tasks, stream, markers } = setup();
    const target = owner();
    await createRow(target);
    const { settled } = listen(stream, target);
    const title = heldTitle();

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    const run = attempt.run({ generate: title.generate, timeoutMs: 60_000 });
    await waitFor(() => title.generate.mock.calls.length === 1);
    await methods.deleteConvos(target.userId, { conversationId: target.conversationId });
    await tasks.cancel(target);
    await run;

    expect(title.signal()?.aborted).toBe(true);
    expect(await methods.getConvo(target.userId, target.conversationId)).toBeNull();
    expect(markers.set).toHaveBeenCalledTimes(1);
    expect(settled).toEqual([{}]);
  });

  it('fences out an attempt on another replica once a newer one owns the conversation', async () => {
    const local = setup();
    /** A second process: same shared markers and database, its own in-flight attempts. */
    const remote = createTitleTasks({
      saveConvo: methods.saveConvo,
      getConvoTitleState: methods.getConvoTitleState,
      markers: local.markers,
      cache: { set: jest.fn() },
      stream: local.stream,
      logger: { debug: jest.fn(), error: jest.fn() },
    });
    const target = owner();
    await createRow(target);
    const stale = heldTitle();

    const older = await remote.admit({ ...target, ctx: ctxFor(target) });
    const olderRun = older.run({ generate: stale.generate, timeoutMs: 60_000 });
    await waitFor(() => stale.generate.mock.calls.length === 1);
    const newer = await local.tasks.admit({ ...target, ctx: ctxFor(target) });
    stale.release('Stale Title');
    await olderRun;
    await newer.run({ generate: async () => 'Newer Title', timeoutMs: 60_000 });

    expect(stale.signal()?.aborted).toBe(false);
    expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe(
      'Newer Title',
    );
  });

  it('keeps a title that finished before the turn was stopped', async () => {
    const { tasks } = setup();
    const target = owner();
    const ready = deferred<void>();
    const generated = deferred<void>();

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    const run = attempt.run({
      generate: async () => {
        generated.resolve();
        return 'Finished Title';
      },
      ready: ready.promise,
      timeoutMs: 60_000,
    });
    await generated.promise;
    attempt.stop();
    await createRow(target);
    ready.resolve();
    await run;

    expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe(
      'Finished Title',
    );
  });

  it('cancels the generation of a stopped turn and of a failed one', async () => {
    const { tasks } = setup();
    for (const end of ['stop', 'discard'] as const) {
      const target = owner();
      await createRow(target);
      const title = heldTitle();
      const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
      const run = attempt.run({ generate: title.generate, timeoutMs: 60_000 });
      await waitFor(() => title.generate.mock.calls.length === 1);
      attempt[end]();
      await run;

      expect(title.signal()?.aborted).toBe(true);
      expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe(
        'New Chat',
      );
    }
  });

  it('fences an older attempt out once a newer one owns the conversation', async () => {
    const { tasks, stream } = setup();
    const target = owner();
    await createRow(target);
    const { settled } = listen(stream, target);
    const older = heldTitle();

    const first = await tasks.admit({ ...target, ctx: ctxFor(target) });
    const firstRun = first.run({ generate: older.generate, timeoutMs: 60_000 });
    await waitFor(() => older.generate.mock.calls.length === 1);
    const second = await tasks.admit({ ...target, ctx: ctxFor(target) });
    await firstRun;
    await second.run({ generate: async () => 'Newer Title', timeoutMs: 60_000 });

    expect(older.signal()?.aborted).toBe(true);
    expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe(
      'Newer Title',
    );
    expect(settled).toEqual([
      { attempt: second.id, title: expect.objectContaining({ title: 'Newer Title' }) },
    ]);
  });

  it('still saves the title when the shared marker cannot be written', async () => {
    const { tasks, markers, logger } = setup();
    const target = owner();
    await createRow(target);
    markers.set.mockRejectedValueOnce(new Error('cache unavailable'));

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    await attempt.run({ generate: async () => 'Unfenced Title', timeoutMs: 60_000 });

    expect(logger.error).toHaveBeenCalledWith(
      '[titles] Failed to admit title attempt',
      expect.anything(),
    );
    expect((await methods.getConvo(target.userId, target.conversationId))?.title).toBe(
      'Unfenced Title',
    );
  });

  it('settles an attempt that never ran, and ignores a run after release', async () => {
    const { tasks, stream, store } = setup();
    const target = owner();
    const { settled } = listen(stream, target);
    const generate = jest.fn(async () => 'Never');

    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    await attempt.release();
    await attempt.run({ generate, timeoutMs: 60_000 });

    expect(generate).not.toHaveBeenCalled();
    expect(store.has(titleKey(target))).toBe(false);
    expect(settled).toEqual([{ attempt: attempt.id }]);
  });
});

describe('title stream route', () => {
  it('answers with the saved title at once', async () => {
    const { app } = setup();
    const target = owner();
    await createRow(target, 'Saved Title');

    expect(await readStream(app, target)).toEqual([
      {
        event: 'title',
        data: { conversationId: target.conversationId, title: 'Saved Title' },
      },
      { final: true, titleSettled: true },
    ]);
  });

  it('reports nothing pending when no attempt owns the conversation', async () => {
    const { app } = setup();
    const target = owner();
    await createRow(target);

    expect(await readStream(app, target)).toEqual([{ final: true, titleSettled: false }]);
  });

  it('holds the stream open until the pending attempt settles', async () => {
    const { app, tasks, transport } = setup();
    const target = owner();
    await createRow(target);
    const title = heldTitle();
    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    const run = attempt.run({ generate: title.generate, timeoutMs: 60_000 });

    const frames = readStream(app, target);
    await waitFor(() => transport.getSubscriberCount(titleStreamId(target)) > 0);
    title.release('Streamed Title');
    await run;

    expect(await frames).toEqual([
      {
        event: 'title',
        data: { conversationId: target.conversationId, title: 'Streamed Title' },
      },
      { final: true, titleSettled: true },
    ]);
  });

  it('replays a settlement that landed before the browser reconnected', async () => {
    const { app, tasks } = setup();
    const target = owner();
    await createRow(target);
    const attempt = await tasks.admit({ ...target, ctx: ctxFor(target) });
    await attempt.run({ generate: async () => undefined, timeoutMs: 60_000 });

    expect(await readStream(app, target)).toEqual([{ final: true, titleSettled: true }]);
  });

  it("never reveals another user's pending or saved title", async () => {
    const { app, tasks } = setup();
    const target = owner();
    await createRow(target, 'Private Title');
    await tasks.admit({ ...target, ctx: ctxFor(target) });

    expect(await readStream(app, target, 'someone-else')).toEqual([
      { final: true, titleSettled: false },
    ]);
  });

  it('reports what the row holds once the owning lease expires', async () => {
    const { app, store } = setup();
    const target = owner();
    await createRow(target);
    store.set(titleKey(target), { attempt: 'crashed', expiresAt: Date.now() + 50 });
    setTimeout(() => store.delete(titleKey(target)), 25);

    expect(await readStream(app, target)).toEqual([{ final: true, titleSettled: false }]);
  });
});
