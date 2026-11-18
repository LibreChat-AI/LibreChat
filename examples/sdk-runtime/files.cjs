/**
 * Key-free, separate-process file transport demonstration. The temporary filesystem and
 * in-memory receipts are fixtures, not LibreChat's production authorization/publication adapter.
 */
const { once } = require('node:events');
const { fork } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { mkdtemp, open, rename, rm, writeFile } = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const {
  Annotation,
  StateGraph,
  START,
  END,
  messagesStateReducer,
} = require('@langchain/langgraph');
const { HumanMessage } = require('@librechat/agents/langchain/messages');
const {
  Run,
  Providers,
  FakeChatModel,
  GraphEvents,
  createHostFileService,
  HostFileAdmission,
  HostFileServiceError,
} = require('@librechat/agents');
const { createRemoteSdkRun, createRemoteSdkServer } = require('@librechat/api/sdk');

const identity = {
  runtimeId: 'file-example',
  agentId: 'example',
  userId: 'fixture-user',
  runId: 'fixture-run',
  conversationId: 'fixture-conversation',
};
const config = {
  runId: identity.runId,
  returnContent: true,
  tokenCounter: () => 1,
  graphConfig: {
    type: 'standard',
    agents: [
      {
        agentId: identity.agentId,
        provider: Providers.OPENAI,
        clientOptions: { model: 'fixture' },
        tools: [],
      },
    ],
  },
};

async function createFileRun(input) {
  const files = input.hostFiles;
  if (!files?.sources.length) throw new Error('An authorized host file is required');
  const run = await Run.create({ ...config, ...input.config });
  run.Graph.overrideModel = new FakeChatModel({
    responses: ['The transformed file has been published.'],
    sleep: 1,
  });
  const agent = run.graphRunnable;
  const State = Annotation.Root({
    messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
    artifact: Annotation({ reducer: (_previous, value) => value }),
    runStepState: Annotation({ reducer: (_previous, value) => value }),
  });
  run.graphRunnable = new StateGraph(State)
    .addNode('transform', async () => {
      const source = files.sources[0];
      // ASCII fixture: transformation preserves byte length. General encodings must supply
      // the actual output length and stream bounded chunks through their own encoder.
      const transformed = async function* () {
        for await (const chunk of files.read(source, input.signal)) {
          yield Buffer.from(Buffer.from(chunk).toString('ascii').toUpperCase(), 'ascii');
        }
      };
      return {
        artifact: await files.stage(
          {
            operationId: 'uppercase-upload',
            filename: 'uppercase.txt',
            mediaType: 'text/plain',
            bytes: source.bytes,
          },
          transformed(),
          input.signal,
        ),
      };
    })
    .addNode('publish', async (state) => {
      await files.publish(state.artifact, 'uppercase-publication', input.signal);
      return {};
    })
    .addNode('reply', agent)
    .addEdge(START, 'transform')
    .addEdge('transform', 'publish')
    .addEdge('publish', 'reply')
    .addEdge('reply', END)
    .compile(input.compileOptions);
  return run;
}

async function worker() {
  const server = createRemoteSdkServer({
    runtimeId: identity.runtimeId,
    secret: process.env.SDK_FILE_EXAMPLE_SECRET,
    authorize: (who) => Object.entries(identity).every(([key, value]) => who[key] === value),
    createRun: createFileRun,
  });
  server.server.listen(0, '127.0.0.1', () => process.send({ port: server.server.address().port }));
  process.once('message', () => {
    void server.close().then(() => process.disconnect());
  });
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-sdk-files-'));
  const secret = randomUUID() + randomUUID();
  const records = new Map();
  const publications = new Map();
  const bytes = Buffer.from('bounded host file transport\n'.repeat(4096));
  const source = {
    reference: 'input',
    revision: 'immutable-1',
    filename: 'input.txt',
    mediaType: 'text/plain',
    bytes: bytes.length,
  };
  const sourcePath = join(directory, 'input');
  try {
    await writeFile(sourcePath, bytes);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  records.set(source.reference, { file: source, path: sourcePath });
  function resolve(reference, revision) {
    const record = records.get(reference);
    if (!record) throw new HostFileServiceError('forbidden');
    if (record.file.revision !== revision) throw new HostFileServiceError('conflict');
    return record;
  }
  const store = {
    read: async (request, signal) => {
      signal?.throwIfAborted();
      const record = resolve(request.reference, request.revision);
      const handle = await open(record.path, 'r');
      try {
        const data = Buffer.alloc(request.length);
        const { bytesRead } = await handle.read(data, 0, data.length, request.offset);
        return {
          reference: request.reference,
          revision: request.revision,
          offset: request.offset,
          data: data.subarray(0, bytesRead),
        };
      } finally {
        await handle.close();
      }
    },
    stage: async (request, content, signal) => {
      const path = join(directory, randomUUID());
      const handle = await open(path, 'wx');
      const hash = createHash('sha256');
      let committed = false;
      try {
        for await (const chunk of content) {
          signal?.throwIfAborted();
          await handle.writeFile(chunk);
          hash.update(chunk);
        }
        const sha256 = hash.digest('hex');
        const file = {
          reference: request.operationId,
          revision: sha256,
          filename: request.filename,
          mediaType: request.mediaType,
          bytes: request.bytes,
          sha256,
        };
        const previous = records.get(request.operationId);
        if (previous) {
          if (previous.file.sha256 !== sha256) throw new HostFileServiceError('conflict');
          return previous.file;
        }
        records.set(file.reference, { file, path });
        committed = true;
        return file;
      } finally {
        await handle.close();
        if (!committed) await rm(path, { force: true });
      }
    },
    publish: async (request, signal) => {
      signal?.throwIfAborted();
      const record = resolve(request.reference, request.revision);
      const previous = publications.get(request.operationId);
      if (previous) {
        if (
          previous.file.reference !== record.file.reference ||
          previous.file.revision !== record.file.revision
        )
          throw new HostFileServiceError('conflict');
        return previous;
      }
      const publishedPath = join(directory, 'published-' + randomUUID());
      await rename(record.path, publishedPath);
      record.path = publishedPath;
      const receipt = { operationId: request.operationId, file: record.file };
      publications.set(request.operationId, receipt);
      return receipt;
    },
  };
  const child = fork(__filename, ['--worker'], {
    env: { ...process.env, SDK_FILE_EXAMPLE_SECRET: secret },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    const [{ port }] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Worker exited before listening');
      }),
    ]);
    const files = createHostFileService({
      identity,
      descriptor: {
        version: 1,
        operations: ['read', 'stage', 'publish'],
        maxFileBytes: 1024 * 1024,
        maxChunkBytes: 16 * 1024,
      },
      store,
      admission: new HostFileAdmission({
        maxConcurrentOperations: 4,
        maxBufferedBytes: 128 * 1024,
      }),
      timeoutMs: 10000,
    });
    let events = 0;
    const started = performance.now();
    const run = await createRemoteSdkRun({
      config: {
        ...config,
        customHandlers: {
          [GraphEvents.ON_MESSAGE_DELTA]: {
            handle: () => {
              events++;
            },
          },
        },
      },
      identity,
      remote: { url: `ws://127.0.0.1:${port}/sdk`, secret },
      hostServices: { files: { ...files, sources: [source] } },
    });
    const content = await run.processStream(
      { messages: [new HumanMessage('Transform and publish the attachment')] },
      { version: 'v2', configurable: { thread_id: identity.conversationId } },
    );
    const expected = createHash('sha256')
      .update(bytes.toString('ascii').toUpperCase())
      .digest('hex');
    if (
      publications.size !== 1 ||
      records.get('uppercase-upload')?.file.sha256 !== expected ||
      !events
    )
      throw new Error('File graph acceptance failed');
    console.log(
      JSON.stringify(
        {
          bytes: bytes.length,
          publications: publications.size,
          messageEvents: events,
          elapsedMs: Math.round(performance.now() - started),
          content,
        },
        null,
        2,
      ),
    );
  } finally {
    if (child.connected) child.send('stop');
    const timer = setTimeout(() => child.kill(), 5000);
    if (child.exitCode === null) await once(child, 'exit');
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv.includes('--worker')) void worker().catch(() => process.exit(1));
else
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
