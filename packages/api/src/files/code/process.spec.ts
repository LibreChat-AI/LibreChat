import os from 'node:os';
import sharp from 'sharp';
import path from 'node:path';
import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mockClient } from 'aws-sdk-client-mock';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buffer as readStream } from 'node:stream/consumers';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createMethods, fileSchema } from '@librechat/data-schemas';
import {
  FileContext,
  FileSources,
  EToolResources,
  getEndpointFileConfig,
  mergeFileConfig,
} from 'librechat-data-provider';
import type { CodeFileCommitData, IMongoFile } from '@librechat/data-schemas';
import type { TFile } from 'librechat-data-provider';
import type { CodeOutputProcessorDeps } from './process';
import type { TGetFiles } from '~/agents/resources';
import type { CodeFileAgent } from './queued';
import type { ServerRequest } from '~/types';
import { hasOfficeHtmlPath, extractCodeArtifactText, getExtractedTextFormat } from './extract';
import { createLocalFileDeleter, saveLocalBuffer, writeLocalFile } from '~/storage/local';
import { createFileProvisionRecovery, withFileProvisioning } from '../operations';
import { sanitizeArtifactPath, flattenArtifactPath } from '~/utils/files';
import { createProvisionFilesCallback } from '../provision/callback';
import { fromLocalUrlPath, stripCacheBust } from '~/storage/path';
import { createDeleteFileWithSecondaryStorage } from '../storage';
import { createProvisionService } from '../provision/service';
import { saveBufferToS3, getS3Key } from '~/storage/s3/crud';
import { createCodeApiUploadRegistry } from '~/utils/code';
import { getStorageMetadata } from '~/storage/metadata';
import { prepareQueuedCodeFileContext } from './queued';
import { primeResources } from '~/agents/resources';
import { classifyCodeArtifact } from './classify';
import { createCodeFileDeleter } from './delete';
import { processCodeOutput } from './process';
import { selectCodeFiles } from './priming';
import * as s3 from '~/cdn/s3';

/** Real Mongo claims, provisioning and filesystem bytes, including image conversion. */
describe('Generated file snapshots', () => {
  let mongo: MongoMemoryServer;
  let directory: string;
  let methods: ReturnType<typeof createMethods>;
  let deps: CodeOutputProcessorDeps;
  let req: ServerRequest & Required<Pick<ServerRequest, 'user' | 'config'>>;
  const user = new mongoose.Types.ObjectId().toString();
  const paths = () => ({ publicPath: directory, uploads: path.join(directory, 'uploads') });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    const File = mongoose.model('File', fileSchema);
    await File.init();
    methods = createMethods(mongoose);
  });

  beforeEach(async () => {
    await mongoose.models.File.deleteMany({});
    directory = await mkdtemp(path.join(os.tmpdir(), 'generated-snapshots-'));
    req = {
      user: { id: user, tenantId: 'tenant-a' },
      app: { locals: { codeApiUploadRegistry: createCodeApiUploadRegistry() } },
      config: { fileStrategy: FileSources.local, imageOutputType: 'webp' },
    } as unknown as typeof req;
    const saveBuffer: NonNullable<
      ReturnType<CodeOutputProcessorDeps['getStrategyFunctions']>['saveBuffer']
    > = (input) => saveLocalBuffer({ ...input, paths: paths(), basePath: 'uploads' });
    deps = {
      fileStorage: { ...methods, recovery: createFileProvisionRecovery() },
      claimCodeFile: methods.claimCodeFile,
      commitCodeFile: methods.commitCodeFile,
      getCodeOutputFileSettings: () => ({
        endpointFileConfig: getEndpointFileConfig({
          fileConfig: mergeFileConfig({}),
          endpoint: 'agents',
        }),
        fileSizeLimit: 1024 * 1024,
      }),
      downloadCodeOutputBuffer: async () => {
        throw new Error('Fixture requires prepared bytes');
      },
      createDownloadFallback: (input) => ({
        filename: input.name,
        filepath: 'fallback',
        conversationId: input.conversationId,
        expiresAt: input.expiresAt,
      }),
      getRetentionExpiry: async () => ({}),
      convertImage: async (_req, input, _detail, filename) => {
        const buffer = await sharp(input).webp({ lossless: true }).toBuffer();
        return {
          filepath: await saveBuffer({
            userId: user,
            tenantId: req.user.tenantId,
            buffer,
            fileName: filename,
            basePath: 'uploads',
          }),
          bytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        };
      },
      getStrategyFunctions: () => ({ saveBuffer }),
      determineFileType: async () => undefined,
      finalizePreview: async () => null,
      hasOfficeHtmlPath,
      sanitizeArtifactPath,
      flattenArtifactPath,
      classifyCodeArtifact,
      extractCodeArtifactText,
      getExtractedTextFormat,
      getStorageMetadata,
      logAxiosError: ({ error }) => {
        throw error;
      },
      logger: { warn: () => undefined, debug: () => undefined },
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel('File');
    await mongo?.stop();
  });

  async function emit(buffer: Buffer, messageId: string, name = 'report.txt', stamp?: number) {
    const result = await processCodeOutput(
      {
        req,
        id: 'same-live-object',
        session_id: 'same-live-session',
        name,
        messageId,
        toolCallId: `tool-${messageId}`,
        conversationId: 'conversation-a',
        preparedBuffer: buffer,
        freshClaimAfter: stamp,
      },
      deps,
    );
    const file = result?.file;
    if (!file || !('file_id' in file)) throw new Error('Expected a stored snapshot');
    return file;
  }

  async function reload(file_id: string) {
    const file = await mongoose.models.File.findOne({ file_id }).lean<CodeFileCommitData>();
    if (!file) throw new Error('Snapshot disappeared on reload');
    const bytes = await readFile(
      file.storageKey
        ? path.join(directory, 'objects', file.storageKey)
        : path.join(directory, fromLocalUrlPath(stripCacheBust(file.filepath))),
    );
    return { file, bytes };
  }

  function primingFile(file: IMongoFile): TFile {
    return {
      file_id: file.file_id,
      user: file.user.toString(),
      tenantId: file.tenantId,
      filename: file.filename,
      filepath: file.filepath,
      type: file.type,
      bytes: file.bytes,
      object: 'file',
      embedded: file.embedded === true,
      usage: file.usage ?? 1,
      context: file.context as FileContext,
      metadata: file.metadata,
      createdAt: file.createdAt,
      source: file.source as FileSources,
    };
  }

  async function initializeCode(
    ids: string[],
    privateIds: string[] = [],
    deferred = true,
    failOnceAt?: string,
    stale = false,
  ) {
    const files = (
      (await methods.getFiles({ file_id: { $in: ids }, user, tenantId: req.user.tenantId })) ?? []
    ).map(primingFile);
    const getFiles = jest.fn<ReturnType<TGetFiles>, Parameters<TGetFiles>>(async (filter) =>
      ((await methods.getFiles({ ...filter, user, tenantId: req.user.tenantId })) ?? []).map(
        primingFile,
      ),
    );
    const liveDirectory = path.join(directory, 'sandbox');
    const upload = jest.fn(async ({ stream, filename, onUploadStart }: Record<string, unknown>) => {
      if (!(stream instanceof Readable) || typeof filename !== 'string')
        throw new Error('Invalid upload');
      if (filename === failOnceAt) {
        failOnceAt = undefined;
        throw Object.assign(new Error('Upload rejected'), { response: { status: 400 } });
      }
      if (typeof onUploadStart === 'function') onUploadStart();
      await writeLocalFile(
        path.join(liveDirectory, path.dirname(filename)),
        path.basename(filename),
        await readStream(stream),
      );
      return {
        storage_session_id: 'same-live-session',
        file_id: filename === 'report.txt' ? 'same-live-object' : filename,
        filename,
      };
    });
    const service = createProvisionService({
      getStrategyFunctions: (source) =>
        source === FileSources.execute_code
          ? { handleFileUpload: upload }
          : {
              getDownloadStream: async (_req, filepath) =>
                createReadStream(path.join(directory, fromLocalUrlPath(stripCacheBust(filepath)))),
            },
      uploadVectors: async () => ({ embedded: true }),
      loadAuthValues: async () => ({}),
    });
    const checkSessionsAlive = jest.fn(service.checkSessionsAlive);
    const primed = await primeResources({
      req,
      getFiles,
      requestFileSet: new Set(),
      attachments: deferred ? undefined : Promise.resolve(files),
      provisionCandidates: deferred ? files : undefined,
      tool_resources: privateIds.length ? { execute_code: { file_ids: privateIds } } : {},
      agentId: 'agent-a',
      enabledToolResources: new Set([EToolResources.execute_code]),
      checkSessionsAlive,
    });
    const context: CodeFileAgent = {
      id: 'agent-a',
      tool_resources: primed.tool_resources,
      provisionState: primed.provisionState,
      fileConsumers: { executeCode: true, fileSearch: false },
    };
    // Eager tool loading runs before the lazy callback, as initializeAgent does.
    const eager = await selectCodeFiles({
      files: context.tool_resources?.execute_code?.files ?? [],
      privateFileIds: new Set(privateIds),
      routeKey: 'default',
      getFileInfo: async () => (stale ? null : { lastModified: new Date().toISOString() }),
    });
    for (const selected of eager.selected) {
      if (!selected.isActive)
        await writeLocalFile(
          path.join(liveDirectory, path.dirname(selected.sandboxName)),
          path.basename(selected.sandboxName),
          (await reload(selected.file.file_id)).bytes,
        );
    }
    prepareQueuedCodeFileContext(context, [context], user);
    const callback = createProvisionFilesCallback({
      req,
      fileStorage: deps.fileStorage,
      agentToolContexts: new Map([['agent-a', context]]),
      provisionToCodeEnv: service.provisionToCodeEnv,
      provisionToVectorDB: service.provisionToVectorDB,
      updateFile: async () => undefined,
      updateCodeEnvRef: async () => undefined,
      addEmbeddedEntity: async () => undefined,
    });
    const advertised = new Map(context.provisionState?.codeEnvDestinations);
    let mounted: Awaited<ReturnType<typeof callback>>;
    if (failOnceAt) {
      await expect(callback(['execute_code'], 'agent-a')).rejects.toThrow();
      expect(context.provisionState?.codeEnvDestinations).toEqual(advertised);
      mounted = await callback(['execute_code'], 'agent-a');
      expect(new Set(mounted.map((file) => file.name))).toEqual(new Set(advertised.values()));
    } else mounted = await callback(['execute_code'], 'agent-a');
    expect(getFiles).toHaveBeenCalledTimes(privateIds.length ? 1 : 0);
    expect(checkSessionsAlive.mock.calls.length).toBeLessThanOrEqual(1);
    const destinations = new Map(
      eager.selected.map((selected) => [selected.file.file_id, selected.sandboxName]),
    );
    for (const [id, name] of advertised) destinations.set(id, name);
    return { context, upload, advertised, mounted, destinations };
  }

  it.each([true, false])(
    'initializes the newest snapshot before eager/lazy partitioning (deferred %s)',
    async (deferred) => {
      const first = await emit(Buffer.from('Version 1'), 'message-1', 'report.txt', 100);
      await initializeCode([first.file_id], [], deferred);
      expect((await reload(first.file_id)).file.metadata?.codeEnvRef).toBeDefined();
      const second = await emit(Buffer.from('Version 2'), 'message-2', 'report.txt', 200);
      const next = await initializeCode([first.file_id, second.file_id], [], deferred);
      expect((await readFile(path.join(directory, 'sandbox/report.txt'))).toString()).toBe(
        'Version 2',
      );
      expect(next.advertised.get(second.file_id)).toBe('report.txt');
      expect(next.mounted.map((file) => file.name)).toEqual(['report.txt']);
      expect(next.context.tool_resources?.execute_code?.files?.map((file) => file.file_id)).toEqual(
        [second.file_id],
      );
      await initializeCode([first.file_id], [], deferred);
      expect((await readFile(path.join(directory, 'sandbox/report.txt'))).toString()).toBe(
        'Version 1',
      );
      expect((await reload(second.file_id)).bytes.toString()).toBe('Version 2');
    },
  );

  it('keeps tenant authorization and private collisions through initialization and lazy setup', async () => {
    const first = await emit(Buffer.from('Version 1'), 'message-1', 'report.txt', 100);
    await initializeCode([first.file_id]);
    const second = await emit(Buffer.from('Version 2'), 'message-2', 'report.txt', 200);
    req.user.tenantId = 'tenant-b';
    const foreign = await emit(Buffer.from('Foreign tenant'), 'foreign', 'report.txt', 300);
    req.user.tenantId = 'tenant-a';
    const privateFile = await emit(Buffer.from('Private setup'), 'private', 'report.txt', 400);
    await methods.updateFile({ file_id: privateFile.file_id, context: FileContext.agents });
    const next = await initializeCode(
      [first.file_id, second.file_id, foreign.file_id],
      [privateFile.file_id],
    );
    const name = next.advertised.get(second.file_id)!;
    expect(name).toBe('report.txt');
    expect((await readFile(path.join(directory, 'sandbox', name))).toString()).toBe('Version 2');
    const privateName = next.advertised.get(privateFile.file_id)!;
    expect(privateName).not.toBe(name);
    expect((await readFile(path.join(directory, 'sandbox', privateName))).toString()).toBe(
      'Private setup',
    );
    expect(next.advertised.has(foreign.file_id)).toBe(false);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const)(
    'keeps shared snapshots ahead of an already primed private resource (deferred %s, named %s)',
    async (deferred, named) => {
      const privateFile = await emit(Buffer.from('Private setup'), 'private', 'report.txt', 50);
      await methods.updateFile({ file_id: privateFile.file_id, context: FileContext.agents });
      await initializeCode([], [privateFile.file_id], deferred);
      expect((await reload(privateFile.file_id)).file.metadata?.codeEnvRef).toMatchObject({
        kind: 'agent',
        id: 'agent-a',
        sandboxFilename: 'report.txt',
      });
      if (!named)
        await mongoose.models.File.updateOne(
          { file_id: privateFile.file_id },
          {
            $unset: {
              'metadata.codeEnvRef.sandboxFilename': '',
              'metadata.codeEnvRefs.default.sandboxFilename': '',
            },
          },
        );
      const first = await emit(Buffer.from('Shared V1'), 'shared-1', 'report.txt', 100);
      const alone = await initializeCode([first.file_id], [], deferred);
      const next = await initializeCode([first.file_id], [privateFile.file_id], deferred);
      expect(next.destinations.get(first.file_id)).toBe(alone.destinations.get(first.file_id));
      expect(next.destinations.get(first.file_id)).toBe('report.txt');
      const privateName = next.destinations.get(privateFile.file_id)!;
      expect(privateName).toMatch(/^report-.+\.txt$/);
      expect((await readFile(path.join(directory, 'sandbox/report.txt'))).toString()).toBe(
        'Shared V1',
      );
      expect((await readFile(path.join(directory, 'sandbox', privateName))).toString()).toBe(
        'Private setup',
      );
      expect((await reload(privateFile.file_id)).file.metadata?.codeEnvRef?.sandboxFilename).toBe(
        privateName,
      );
      const second = await emit(Buffer.from('Shared V2'), 'shared-2', 'report.txt', 200);
      for (const ids of [
        [first.file_id, second.file_id],
        [first.file_id],
        [first.file_id, second.file_id],
      ]) {
        const restored = await initializeCode(ids, [privateFile.file_id], deferred);
        expect(restored.destinations.get(privateFile.file_id)).toBe(privateName);
        expect(restored.destinations.get(ids[ids.length - 1])).toBe('report.txt');
        expect((await readFile(path.join(directory, 'sandbox/report.txt'))).toString()).toBe(
          ids.length === 1 ? 'Shared V1' : 'Shared V2',
        );
        expect((await readFile(path.join(directory, 'sandbox', privateName))).toString()).toBe(
          'Private setup',
        );
      }
    },
  );

  it.each(['report.txt', 'nested/report-alias.txt'])(
    'restores a rewritten upload at its original destination %s on old branches',
    async (name) => {
      const uploaded = await emit(Buffer.from('Uploaded original'), 'upload', 'upload.txt', 50);
      await methods.updateFile({
        file_id: uploaded.file_id,
        context: FileContext.message_attachment,
        metadata: {
          codeDestination: true,
          codeEnvRef: {
            kind: 'user',
            id: user,
            storage_session_id: 'same-live-session',
            file_id: 'same-live-object',
            sandboxFilename: name,
          },
        },
      });
      await mongoose.models.File.updateOne(
        { file_id: uploaded.file_id },
        {
          $unset: { 'metadata.codeEnvSource': '', 'metadata.sourceDispatchedAt': '' },
          $set: { createdAt: new Date(50) },
        },
        { timestamps: false },
      );
      const live = path.join(directory, 'sandbox', name);
      await writeLocalFile(path.dirname(live), path.basename(live), Buffer.from('Version 1'));
      const first = await emit(await readFile(live), 'message-1', name, 100);
      await initializeCode([uploaded.file_id, first.file_id]);
      await writeLocalFile(path.dirname(live), path.basename(live), Buffer.from('Version 2'));
      const second = await emit(await readFile(live), 'message-2', name, 200);
      await initializeCode([uploaded.file_id, first.file_id, second.file_id]);
      expect((await readFile(path.join(directory, 'sandbox', name))).toString()).toBe('Version 2');
      const restored = await initializeCode([uploaded.file_id, first.file_id]);
      expect((await readFile(path.join(directory, 'sandbox', name))).toString()).toBe('Version 1');
      expect(
        restored.context.tool_resources?.execute_code?.files?.map((file) => file.file_id),
      ).toEqual([first.file_id]);
      expect((await reload(second.file_id)).bytes.toString()).toBe('Version 2');
    },
  );

  it.each([true, false])(
    'restores a literal WebP rewrite ahead of a stale converted legacy receipt (deferred %s)',
    async (deferred) => {
      const blue = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
        .png()
        .toBuffer();
      const green = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'green' },
      })
        .webp()
        .toBuffer();
      const legacy = await emit(blue, 'legacy', 'nested/chart.png', 100);
      await methods.updateFile({ file_id: legacy.file_id, context: FileContext.execute_code });
      await mongoose.models.File.updateOne(
        { file_id: legacy.file_id },
        { $unset: { 'metadata.codeEnvRef': '', 'metadata.codeEnvRefs': '' } },
      );
      const original = await initializeCode([legacy.file_id], [], deferred, undefined, true);
      const name = original.destinations.get(legacy.file_id)!;
      expect(name).toBe('nested/chart.webp');
      expect((await reload(legacy.file_id)).file.metadata?.codeEnvRef?.sandboxFilename).toBe(name);
      const live = path.join(directory, 'sandbox', name);
      await writeLocalFile(path.dirname(live), path.basename(live), green);
      const edited = await emit(await readFile(live), 'edited', name, 200);
      const oldBytes = (await reload(legacy.file_id)).bytes;
      const newBytes = (await reload(edited.file_id)).bytes;
      expect(oldBytes).not.toEqual(newBytes);
      let alias: string | undefined;
      for (const ids of [
        [legacy.file_id, edited.file_id],
        [legacy.file_id, edited.file_id],
        [legacy.file_id],
        [legacy.file_id, edited.file_id],
      ]) {
        await rm(path.join(directory, 'sandbox'), { recursive: true, force: true });
        const restored = await initializeCode(ids, [], deferred, undefined, true);
        expect(restored.destinations.size).toBe(ids.length);
        if (ids.length === 1) {
          expect(restored.destinations.get(legacy.file_id)).toBe(name);
          expect(await readFile(live)).toEqual(oldBytes);
        } else {
          expect(restored.destinations.get(edited.file_id)).toBe(name);
          const legacyName = restored.destinations.get(legacy.file_id)!;
          expect(legacyName).toMatch(/^nested\/chart-.+\.webp$/);
          if (alias) expect(legacyName).toBe(alias);
          alias = legacyName;
          expect(await readFile(live)).toEqual(newBytes);
          expect(await readFile(path.join(directory, 'sandbox', legacyName))).toEqual(oldBytes);
        }
        expect((await reload(legacy.file_id)).bytes).toEqual(oldBytes);
        expect((await reload(edited.file_id)).bytes).toEqual(newBytes);
      }
    },
  );

  it('retains distinct captured image paths across conversion, lazy mounts, eager reload and branch return', async () => {
    const blue = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .jpeg()
      .toBuffer();
    const first = await emit(blue, 'png', 'nested/chart.png', 100);
    await initializeCode([first.file_id]);
    const second = await emit(red, 'jpeg', 'nested/chart.jpeg', 200);
    const next = await initializeCode([first.file_id, second.file_id]);
    expect(next.destinations.size).toBe(2);
    expect(new Set(next.destinations.values()).size).toBe(2);
    const pngName = next.destinations.get(first.file_id)!;
    const jpegName = next.destinations.get(second.file_id)!;
    expect(pngName).toBe('nested/chart.webp');
    expect(jpegName).toMatch(/^nested\/chart-.+\.webp$/);
    const pngBytes = (await reload(first.file_id)).bytes;
    const jpegBytes = (await reload(second.file_id)).bytes;
    expect(await readFile(path.join(directory, 'sandbox', pngName))).toEqual(pngBytes);
    expect(await readFile(path.join(directory, 'sandbox', jpegName))).toEqual(jpegBytes);
    const eager = await initializeCode([first.file_id, second.file_id]);
    expect(eager.destinations).toEqual(next.destinations);
    const rewritten = await emit(red, 'png-rewritten', 'nested/chart.png', 300);
    const newer = await initializeCode([first.file_id, second.file_id, rewritten.file_id]);
    expect(newer.destinations.has(first.file_id)).toBe(false);
    expect(newer.destinations.size).toBe(2);
    await initializeCode([first.file_id, second.file_id]);
    expect(await readFile(path.join(directory, 'sandbox', pngName))).toEqual(pngBytes);
    expect(await readFile(path.join(directory, 'sandbox', jpegName))).toEqual(jpegBytes);
  });

  it.each([0, 1])(
    'gives a new literal write ownership of assigned image mount %s without merging captures',
    async (target) => {
      const blue = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
        .png()
        .toBuffer();
      const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
        .jpeg()
        .toBuffer();
      const green = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'green' },
      })
        .webp()
        .toBuffer();
      const a = await emit(blue, 'png', 'nested/chart.png', 100);
      await initializeCode([a.file_id]);
      const b = await emit(red, 'jpeg', 'nested/chart.jpeg', 200);
      const old = await initializeCode([a.file_id, b.file_id]);
      const original = target === 0 ? a : b;
      const editedPath = old.destinations.get(original.file_id)!;
      const live = path.join(directory, 'sandbox', editedPath);
      await writeLocalFile(path.dirname(live), path.basename(live), green);
      const edited = await emit(await readFile(live), 'edited', editedPath, 300);
      const next = await initializeCode(
        [a.file_id, b.file_id, edited.file_id],
        [],
        true,
        target === 1 ? editedPath : undefined,
      );
      expect(next.destinations.size).toBe(3);
      expect(next.destinations.get(edited.file_id)).toBe(editedPath);
      expect(next.destinations.get(original.file_id)).not.toBe(editedPath);
      expect(await readFile(live)).toEqual((await reload(edited.file_id)).bytes);
      expect(
        await readFile(path.join(directory, 'sandbox', next.destinations.get(original.file_id)!)),
      ).toEqual((await reload(original.file_id)).bytes);
      const again = await initializeCode([a.file_id, b.file_id, edited.file_id]);
      expect(again.destinations).toEqual(next.destinations);
      const branch = await initializeCode([a.file_id, b.file_id]);
      expect(branch.destinations.size).toBe(2);
      for (const file of [a, b])
        expect(
          await readFile(path.join(directory, 'sandbox', branch.destinations.get(file.file_id)!)),
        ).toEqual((await reload(file.file_id)).bytes);
      const returned = await initializeCode([a.file_id, b.file_id, edited.file_id]);
      expect(returned.destinations).toEqual(next.destinations);
      expect(await readFile(live)).toEqual((await reload(edited.file_id)).bytes);
    },
  );

  it.each(['report.txt', 'published/kept-name.txt'])(
    'mounts the owned published V1 copy instead of mutable provenance at %s',
    async (name) => {
      const scope = {
        userId: user,
        tenantId: 'tenant-a',
        conversationId: 'conversation-a',
        runId: 'run-publish',
        executionId: 'child',
        agentId: 'agent-a',
        sourceFileId: 'mutable-source',
      };
      const result = await processCodeOutput(
        {
          req,
          id: scope.sourceFileId,
          session_id: 'source-session',
          name: 'report.txt',
          conversationId: scope.conversationId,
          messageId: 'published-message',
          preparedBuffer: Buffer.from('Published V1'),
          publication: {
            scope,
            provenance: {
              runId: scope.runId,
              executionId: scope.executionId,
              agentId: scope.agentId,
              sourceFileId: scope.sourceFileId,
              publishedAt: new Date().toISOString(),
              inputFileIds: [],
            },
            publish: methods.publishRunArtifactFile,
            find: methods.findRunArtifactFile,
            discard: async () => undefined,
          },
        },
        deps,
      );
      if (!result?.file || !('file_id' in result.file)) throw new Error('Expected publication');
      const published = result.file;
      const unprovisioned = (await methods.getFiles({ file_id: published.file_id }))![0];
      const probe = jest.fn(async () => ({ lastModified: new Date().toISOString() }));
      const owned = {
        kind: 'user' as const,
        id: user,
        storage_session_id: 'owned-session',
        file_id: 'owned-copy',
        sandboxFilename: name,
        executionProfile: 'default' as const,
      };
      await withFileProvisioning({
        file: published,
        userId: user,
        storage: deps.fileStorage,
        destination: 'published-copy',
        operation: async (_claim, onUploadStart) => {
          onUploadStart();
          await writeLocalFile(directory, 'owned-copy', (await reload(published.file_id)).bytes);
          return {
            value: owned,
            commit: { code: { routeKey: 'default', ref: owned, legacyRef: owned } },
          };
        },
      });
      await writeLocalFile(directory, 'mutable-source', Buffer.from('Mutable V2'));
      const record = (await methods.getFiles({ file_id: published.file_id }))![0];
      const getFileInfo = jest.fn(async (ref: { file_id: string }) => ({
        lastModified: new Date().toISOString(),
        originalFilename: ref.file_id === 'owned-copy' ? name : 'wrong-live-name.txt',
      }));
      const selected = await selectCodeFiles({
        files: [primingFile(record)],
        routeKey: 'default',
        getFileInfo,
      });
      expect(selected.selected).toHaveLength(1);
      const mount = selected.selected[0];
      expect(mount.isActive).toBe(true);
      expect(await readFile(path.join(directory, mount.sourceRef.file_id!))).toEqual(
        Buffer.from('Published V1'),
      );
      expect(mount.sourceRef).toMatchObject(owned);
      expect(mount.sandboxName).toBe(name);
      expect(getFileInfo).toHaveBeenCalledTimes(1);
      expect(getFileInfo).toHaveBeenCalledWith(owned);
      expect(record.context).toBe(FileContext.run_artifact);
      expect(record.metadata?.codeEnvSource?.file_id).toBe('mutable-source');
      expect(
        (
          await selectCodeFiles({
            files: [primingFile(unprovisioned)],
            routeKey: 'default',
            getFileInfo: probe,
          })
        ).selected,
      ).toEqual([]);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each(['no-storage-writer', 'processing-before-upload'] as const)(
    'does not retain an unfinished snapshot claim after %s',
    async (mode) => {
      const kept = await emit(Buffer.from('Committed V1'), 'kept');
      if (mode === 'no-storage-writer') deps.getStrategyFunctions = () => ({});
      else
        deps.determineFileType = async () => {
          throw new Error('Processing failed before upload');
        };
      const attempt = processCodeOutput(
        {
          req,
          id: 'fallback-source',
          session_id: 'fallback-session',
          name: 'report.txt',
          messageId: 'fallback',
          conversationId: 'conversation-a',
          preparedBuffer: Buffer.from('Fallback bytes'),
        },
        deps,
      );
      if (mode === 'processing-before-upload')
        await expect(attempt).rejects.toThrow('Processing failed before upload');
      else expect((await attempt)?.file?.filepath).toBe('fallback');
      expect((await reload(kept.file_id)).bytes.toString()).toBe('Committed V1');
      expect(
        await mongoose.models.File.countDocuments({
          context: FileContext.execute_code_snapshot,
          user,
          tenantId: 'tenant-a',
        }),
      ).toBe(1);
    },
  );

  it('retains the unfinished claim after an uncertain external write', async () => {
    const kept = await emit(Buffer.from('Committed V1'), 'kept');
    const { saveBuffer } = deps.getStrategyFunctions(FileSources.local);
    deps.getStrategyFunctions = () => ({
      saveBuffer: async (input) => {
        await saveBuffer!(input);
        throw new Error('Storage acknowledgement lost');
      },
    });
    await expect(emit(Buffer.from('Uncertain V2'), 'uncertain')).rejects.toThrow(
      'File provisioning outcome is unknown',
    );
    const records = await mongoose.models.File.find({
      context: FileContext.execute_code_snapshot,
      user,
      tenantId: 'tenant-a',
    }).lean<IMongoFile[]>();
    expect(records).toHaveLength(2);
    const unfinished = records.find((file) => file.file_id !== kept.file_id)!;
    expect(unfinished.filepath).toBeUndefined();
    expect(unfinished.storageOperations?.provisioning).toHaveLength(1);
    await expect(
      deps.fileStorage.recovery.recover(
        { file_id: unfinished.file_id, userId: user, tenantId: 'tenant-a' },
        deps.fileStorage,
      ),
    ).rejects.toThrow('File provisioning outcome is unknown');
    expect(await mongoose.models.File.findOne({ file_id: unfinished.file_id }).lean()).toEqual(
      unfinished,
    );
    expect((await reload(kept.file_id)).bytes.toString()).toBe('Committed V1');
  });

  it('retains V1 and V2 bytes and message references after same-path rewrites and reload', async () => {
    const first = await emit(Buffer.from('Version 1'), 'message-1');
    const second = await emit(Buffer.from('Version 2'), 'message-2');
    const references = JSON.parse(JSON.stringify([first, second]));
    expect((await reload(references[0].file_id)).bytes.toString()).toBe('Version 1');
    expect((await reload(references[1].file_id)).bytes.toString()).toBe('Version 2');
    expect(first.file_id).not.toBe(second.file_id);
    expect((await reload(first.file_id)).file.messageId).toBe('message-1');
    expect((await reload(second.file_id)).file.messageId).toBe('message-2');
    expect(first.filename).toBe('report.txt');
    expect(second.filename).toBe('report.txt');
  });

  it('keeps each image generation after conversion and reload', async () => {
    const blue = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const first = await emit(blue, 'image-1', 'nested/chart.png');
    const second = await emit(red, 'image-2', 'nested/chart.png');
    expect((await reload(first.file_id)).bytes).toEqual(
      await sharp(blue).webp({ lossless: true }).toBuffer(),
    );
    expect((await reload(second.file_id)).bytes).toEqual(
      await sharp(red).webp({ lossless: true }).toBuffer(),
    );
    expect(first.filepath).not.toBe(second.filepath);
  });

  it('isolates simultaneous same-name outputs, including identical reads and older dispatches', async () => {
    const values = ['Version 1', 'Version 2', 'Version 2', 'Version 0'];
    const files = await Promise.all(
      values.map((value, index) =>
        emit(Buffer.from(value), `message-${index}`, 'report.txt', 400 - index),
      ),
    );
    expect(new Set(files.map((file) => file.file_id)).size).toBe(values.length);
    for (const [index, file] of files.entries()) {
      expect((await reload(file.file_id)).bytes.toString()).toBe(values[index]);
      expect((await reload(file.file_id)).file.user.toString()).toBe(user);
      expect((await reload(file.file_id)).file.tenantId).toBe('tenant-a');
    }
  });

  it.each([FileSources.s3, FileSources.cloudfront] as const)(
    'keeps immutable tenant-owned object keys with %s storage',
    async (source) => {
      const client = new S3Client({ region: 'us-east-1' });
      const remote = mockClient(client);
      jest.spyOn(s3, 'initializeS3').mockReturnValue(client);
      remote.on(PutObjectCommand).callsFake(async ({ Key, Body }) => {
        const location = path.join(directory, 'objects', Key);
        await writeLocalFile(path.dirname(location), path.basename(location), Body);
        return {};
      });
      req.config.fileStrategy = source;
      deps.getStrategyFunctions = () => ({
        saveBuffer: (input) =>
          saveBufferToS3({
            ...input,
            urlBuilder: async (options) =>
              `https://objects.example/${getS3Key({ ...options, basePath: options.basePath ?? 'images' })}`,
          }),
      });
      try {
        const first = await emit(Buffer.from('Version 1'), 'cloud-1');
        const second = await emit(Buffer.from('Version 2'), 'cloud-2');
        const original = await reload(first.file_id);
        const rewritten = await reload(second.file_id);
        expect(original.bytes.toString()).toBe('Version 1');
        expect(rewritten.bytes.toString()).toBe('Version 2');
        expect(original.file.storageKey).not.toBe(rewritten.file.storageKey);
        expect(original.file.storageKey).toContain('tenant-a');
        expect(original.file.storageKey).toContain(user);
        expect(remote.commandCalls(PutObjectCommand)).toHaveLength(2);
      } finally {
        remote.restore();
        client.destroy();
      }
    },
  );

  it('hydrates only message-referenced snapshots in the authenticated tenant and keeps the newest live path', async () => {
    const first = await emit(Buffer.from('Version 1'), 'message-1', 'report.txt', 100);
    const second = await emit(Buffer.from('Version 2'), 'message-2', 'report.txt', 200);
    const late = await emit(Buffer.from('Version 0'), 'late-harvest', 'report.txt', 50);
    const owner = { userId: user, tenantId: 'tenant-a' };
    const files = await methods.getCodeGeneratedFiles(
      'conversation-a',
      [first.file_id, second.file_id, late.file_id],
      owner,
    );
    expect(files).toHaveLength(3);
    expect(
      await methods.getCodeGeneratedFiles('conversation-a', [first.file_id], {
        ...owner,
        tenantId: 'other-tenant',
      }),
    ).toEqual([]);
    expect(
      await methods.getCodeGeneratedFiles('conversation-a', [first.file_id], {
        ...owner,
        userId: new mongoose.Types.ObjectId().toString(),
      }),
    ).toEqual([]);
    expect(
      (await methods.getCodeGeneratedFiles('conversation-a', [first.file_id], owner)).map(
        (file) => file.file_id,
      ),
    ).toEqual([first.file_id]);
    const getFileInfo = jest.fn(async () => ({
      lastModified: new Date().toISOString(),
      originalFilename: 'report.txt',
    }));
    const selected = await selectCodeFiles({
      files: files.map((file) => ({
        user: file.user.toString(),
        file_id: file.file_id,
        filename: file.filename,
        filepath: file.filepath,
        bytes: file.bytes,
        type: file.type,
        object: 'file',
        embedded: false,
        usage: file.usage,
        context: FileContext.execute_code_snapshot,
        createdAt: file.createdAt,
        metadata: file.metadata,
      })),
      routeKey: 'default',
      getFileInfo,
    });
    expect(selected.selected.map(({ file }) => file.file_id)).toEqual([second.file_id]);
    expect(selected.selected[0].sandboxName).toBe('report.txt');
    expect(selected.selected[0].isActive).toBe(false);
    expect(getFileInfo).not.toHaveBeenCalled();
    expect((await reload(first.file_id)).bytes.toString()).toBe('Version 1');
  });

  it('never reuses or deletes mutable recovery receipts after prime and a later rewrite', async () => {
    const liveDirectory = path.join(directory, 'sandbox');
    const livePath = path.join(liveDirectory, 'report.txt');
    await writeLocalFile(liveDirectory, 'report.txt', Buffer.from('Version 1'));
    const first = await emit(await readFile(livePath), 'message-1');
    const ref = first.metadata!.codeEnvSource!;
    await withFileProvisioning({
      file: first,
      userId: user,
      storage: deps.fileStorage,
      destination: 'code:default:report.txt',
      operation: async (_claim, onUploadStart) => {
        onUploadStart();
        await writeLocalFile(liveDirectory, 'report.txt', (await reload(first.file_id)).bytes);
        return { value: ref, commit: { code: { routeKey: 'default', ref, legacyRef: ref } } };
      },
    });
    await writeLocalFile(liveDirectory, 'report.txt', Buffer.from('Version 2'));
    const second = await emit(await readFile(livePath), 'message-2');
    const original = (await reload(first.file_id)).file;
    const getFileInfo = jest.fn(async () => ({ lastModified: new Date().toISOString() }));
    const selected = await selectCodeFiles({
      files: [
        {
          file_id: original.file_id,
          filename: original.filename,
          filepath: original.filepath,
          bytes: original.bytes,
          type: original.type,
          metadata: original.metadata,
          user: original.user.toString(),
          object: 'file',
          embedded: false,
          usage: original.usage ?? 1,
          context: FileContext.execute_code_snapshot,
        },
      ],
      routeKey: 'default',
      getFileInfo,
    });
    expect(selected.selected).toHaveLength(1);
    expect(selected.selected[0].isActive).toBe(false);
    expect(selected.selected[0].ref).toBeUndefined();
    expect(selected.selected[0].sandboxName).toBe('report.txt');
    expect(getFileInfo).not.toHaveBeenCalled();
    expect((await reload(first.file_id)).bytes.toString()).toBe('Version 1');
    expect((await reload(second.file_id)).bytes.toString()).toBe('Version 2');
    const httpClient = jest.fn(async () => undefined);
    const remove = createCodeFileDeleter({
      httpClient,
      getAuthHeaders: async () => ({}),
      getBaseUrl: () => 'https://code.example',
      routeKey: () => 'default',
      profileHeaders: () => ({}),
      downloadQuery: () => '',
      clearFileCodeEnvRefs: methods.clearFileCodeEnvRefs,
      logger: { warn: () => undefined },
    });
    expect(original.metadata?.codeEnvRef).toMatchObject({ file_id: 'same-live-object' });
    const removePrimary = createLocalFileDeleter({
      deleteRagFile: async () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const cleanupReq = {
      user: req.user,
      config: { fileConfig: { retainedFileCleanup: true } },
    };
    const removeSnapshot = createDeleteFileWithSecondaryStorage<
      typeof cleanupReq,
      typeof original,
      never
    >({
      source: FileSources.local,
      deleteFile: () => removePrimary({ user: req.user, config: { paths: paths() } }, original),
      getDeleteFile: () => (_request, file) => remove(req, file),
      clearFileEmbeddings: methods.clearFileEmbeddings,
      isFileStorageClean: methods.isFileStorageClean,
      fileStorage: { ...methods, recovery: deps.fileStorage.recovery },
      logger: { warn: () => undefined },
    });
    await removeSnapshot(cleanupReq, original);
    expect(httpClient).not.toHaveBeenCalled();
    expect((await readFile(livePath)).toString()).toBe('Version 2');
    expect((await reload(second.file_id)).bytes.toString()).toBe('Version 2');
    const reconciled = await mongoose.models.File.findOne({
      file_id: original.file_id,
    }).lean<CodeFileCommitData>();
    expect(reconciled?.metadata?.codeEnvRef).toBeUndefined();
    expect(reconciled?.metadata?.codeEnvRefs?.default).toBeUndefined();
  });

  it('deletes one primary snapshot without deleting another version', async () => {
    const first = await emit(Buffer.from('Version 1'), 'message-1');
    const second = await emit(Buffer.from('Version 2'), 'message-2');
    const remove = createLocalFileDeleter({
      deleteRagFile: async () => undefined,
      logger: { warn: () => undefined, error: () => undefined },
    });
    await remove({ user: req.user, config: { paths: paths() } }, first);
    expect((await reload(second.file_id)).bytes.toString()).toBe('Version 2');
  });
});
