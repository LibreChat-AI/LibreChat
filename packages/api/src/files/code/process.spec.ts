import os from 'node:os';
import sharp from 'sharp';
import path from 'node:path';
import mongoose from 'mongoose';
import { mockClient } from 'aws-sdk-client-mock';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createMethods, fileSchema } from '@librechat/data-schemas';
import {
  FileContext,
  FileSources,
  getEndpointFileConfig,
  mergeFileConfig,
} from 'librechat-data-provider';
import type { CodeFileCommitData } from '@librechat/data-schemas';
import type { CodeOutputProcessorDeps } from './process';
import type { ServerRequest } from '~/types';
import { hasOfficeHtmlPath, extractCodeArtifactText, getExtractedTextFormat } from './extract';
import { createLocalFileDeleter, saveLocalBuffer, writeLocalFile } from '~/storage/local';
import { createFileProvisionRecovery, withFileProvisioning } from '../operations';
import { sanitizeArtifactPath, flattenArtifactPath } from '~/utils/files';
import { fromLocalUrlPath, stripCacheBust } from '~/storage/path';
import { createDeleteFileWithSecondaryStorage } from '../storage';
import { saveBufferToS3, getS3Key } from '~/storage/s3/crud';
import { getStorageMetadata } from '~/storage/metadata';
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
      config: { fileStrategy: FileSources.local, imageOutputType: 'webp' },
    } as typeof req;
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
