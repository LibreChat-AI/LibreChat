import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

import type { SaveMessageDetails, ConversationOverrides } from './sink';
import type { ImportPhase } from './types';

import { buildFixtureExport, cleanupFixtureExport } from './__data__/fixture';
import * as archiveModule from './archive';
import { runImport } from './service';

interface Recorded {
  conversations: Array<{ title: string; convo: ConversationOverrides; model: string }>;
  messages: SaveMessageDetails[];
}

function recorder(): { sink: Parameters<typeof runImport>[0]['batch']; recorded: Recorded } {
  const recorded: Recorded = { conversations: [], messages: [] };
  return {
    recorded,
    sink: {
      startConversation: () => undefined,
      saveMessage: (details) => {
        recorded.messages.push(details);
      },
      finishConversation: (title, _createdAt, convo, model) => {
        recorded.conversations.push({ title, convo, model });
      },
      maybeFlush: async () => false,
      saveBatch: async () => undefined,
    },
  };
}

const DEPS = {
  saveBuffer: async ({ fileName }: { fileName: string }) => ({
    filepath: `/uploads/u1/${fileName}`,
    source: 'local',
  }),
  createFile: async (data: { file_id: string }) => ({ file_id: data.file_id }),
};

const createdDirs: string[] = [];

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-service-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function shardedManifest(files: string[]): string {
  return JSON.stringify({
    version: 1,
    logical_files: { 'conversations.json': { files, sharded: true } },
  });
}

function textConversation(id: string, title: string, createTime: number): object {
  return {
    conversation_id: id,
    title,
    create_time: createTime,
    update_time: createTime + 100,
    default_model_slug: 'gpt-4o',
    is_archived: false,
    is_starred: false,
    pinned_time: null,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        parent: 'root',
        children: [],
        message: {
          id: 'u1',
          author: { role: 'user', name: null },
          create_time: createTime + 1,
          content: { content_type: 'text', parts: ['Hello there'] },
        },
      },
    },
  };
}

describe('runImport', () => {
  afterEach(() => {
    cleanupFixtureExport();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('imports every shard with state, citations, and assets', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.assetsImported).toBe(3);
    expect(report.assetsUnavailable).toBe(1);
    expect(report.errors).toEqual([]);

    const archived = recorded.conversations.find((entry) => entry.title === 'Amalfi trip');
    expect(archived?.convo.isArchived).toBe(true);
    expect(archived?.convo.importedFrom).toEqual({ source: 'chatgpt', externalId: 'ext-cited' });

    const pinned = recorded.conversations.find((entry) => entry.title === 'Photo review');
    expect(pinned?.convo.pinned).toBe(true);

    const cited = recorded.messages.find((message) =>
      String(message.text).startsWith('Stay in Positano'),
    );
    expect(cited?.attachments).toHaveLength(1);
  });

  it('carries width, height, and filename from attachment metadata through to message.files', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();

    await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    const withPhotos = recorded.messages.find((message) => message.text === 'compare these');
    expect(withPhotos?.files).toHaveLength(2);
    expect(withPhotos?.files?.[0]).toMatchObject({
      filename: 'first.jpg',
      width: 768,
      height: 1560,
    });
    expect(withPhotos?.files?.[1]).toMatchObject({
      filename: 'second.jpg',
      width: 1080,
      height: 2340,
    });
  });

  it('skips conversations already imported from the same export', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(['ext-cited']),
    });

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(recorded.conversations).toHaveLength(1);
  });

  /** `existingExternalIds` is typed `Set<string>` but filled from parsed JSON.
   * Adding a missing `conversation_id` to it once made every later id-less
   * conversation in the same export test as a duplicate, so an export carrying
   * two of them imported one and silently dropped the rest. */
  it('imports every conversation whose conversation_id is missing or not a string', async () => {
    const filepath = await writeZip({
      'conversations.json': JSON.stringify([
        { title: 'First without id', mapping: {} },
        { title: 'Second without id', mapping: {} },
        { title: 'First null id', conversation_id: null, mapping: {} },
        { title: 'Second null id', conversation_id: null, mapping: {} },
        { title: 'First empty id', conversation_id: '', mapping: {} },
        { title: 'Second empty id', conversation_id: '', mapping: {} },
      ]),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(6);
    expect(report.skipped).toBe(0);
    expect(recorded.conversations.map((conversation) => conversation.title)).toEqual([
      'First without id',
      'Second without id',
      'First null id',
      'Second null id',
      'First empty id',
      'Second empty id',
    ]);
  });

  it('still dedupes conversations that do carry a usable conversation_id', async () => {
    const filepath = await writeZip({
      'conversations.json': JSON.stringify([
        { title: 'First', conversation_id: 'ext-dup', mapping: {} },
        { title: 'Second', conversation_id: 'ext-dup', mapping: {} },
        { title: 'Other', conversation_id: 'ext-other', mapping: {} },
      ]),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.skipped).toBe(1);
    expect(recorded.conversations.map((conversation) => conversation.title)).toEqual([
      'First',
      'Other',
    ]);
  });

  /** Re-uploading a finished export used to ingest every asset before the
   * conversation loop reached the skip check, leaving a second copy of every
   * file and storage object behind that nothing referenced. */
  it('ingests no assets for an export whose conversations are all already imported', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();
    const saved: string[] = [];

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: {
        ...DEPS,
        saveBuffer: async ({ fileName }: { fileName: string }) => {
          saved.push(fileName);
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
      },
      batch: sink,
      existingExternalIds: new Set(['ext-cited', 'ext-media']),
    });

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(2);
    expect(report.assetsImported).toBe(0);
    expect(saved).toEqual([]);
    expect(recorded.conversations).toEqual([]);
  });

  /** A conversation is only buffered when it is converted; the flush is what
   * writes it. Pending pointers are promoted only after a successful flush, or
   * when the sink reports an ambiguous conversation write. */
  it('releases assets when a batch save reports no commit outcome', async () => {
    const filepath = await buildFixtureExport();
    const deleted: string[] = [];
    const recorded: string[] = [];

    await expect(
      runImport({
        filepath,
        userId: 'u1',
        defaultModel: 'gpt-4o',
        deps: {
          ...DEPS,
          deleteFile: async (asset: { file_id: string }) => {
            deleted.push(asset.file_id);
          },
        },
        batch: {
          startConversation: () => undefined,
          saveMessage: () => undefined,
          finishConversation: (title: string) => {
            recorded.push(title);
          },
          maybeFlush: async () => false,
          saveBatch: async () => {
            throw new Error('mongo unavailable');
          },
        },
        existingExternalIds: new Set(),
      }),
    ).rejects.toThrow('mongo unavailable');

    expect(recorded.length).toBeGreaterThan(0);
    expect(deleted).toHaveLength(3);
  });

  it('reports progress as it advances', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    const seen: number[] = [];

    await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
      onProgress: async (progress) => {
        seen.push(progress.conversations.done);
      },
    });

    expect(seen[seen.length - 1]).toBe(2);
  });

  it('announces the assets phase before the conversations phase', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    const phases: string[] = [];

    await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
      onPhase: async (phase) => {
        phases.push(phase);
      },
    });

    expect(phases).toEqual(['assets', 'conversations']);
  });

  it('reports asset progress against the referenced pointers, not every archive entry', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    const assetProgress: Array<{ done: number; total: number }> = [];

    await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
      onProgress: async (progress) => {
        assetProgress.push({ ...progress.assets });
      },
    });

    /** The fixture references 4 pointers, one of which has no `.dat` entry,
     * so `done` only reaches `total` because misses count as processed. */
    const last = assetProgress[assetProgress.length - 1];
    expect(last.total).toBe(4);
    expect(assetProgress.some((entry) => entry.done > 0 && entry.done < entry.total)).toBe(true);
    expect(last.done).toBe(last.total);
  });

  it('resolves an assistant-generated image into a nested image_file content part', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();

    await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    const generated = recorded.messages.find(
      (message) => message.text === 'Here is the coastline.',
    );
    expect(generated?.content).toEqual([
      { type: 'text', text: 'Here is the coastline.' },
      {
        type: 'image_file',
        image_file: expect.objectContaining({
          filename: 'file_generated',
          type: 'image/png',
          width: 1024,
          height: 1536,
        }),
      },
    ]);
  });

  it('never holds more than one shard of parsed conversations at a time', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    const readSizes: number[] = [];

    const realOpenArchive = archiveModule.openArchive;
    jest.spyOn(archiveModule, 'openArchive').mockImplementationOnce(async (path, options) => {
      const archive = await realOpenArchive(path, options);
      return {
        ...archive,
        read: async (name: string) => {
          const buffer = await archive.read(name);
          if (name.startsWith('conversations-')) {
            readSizes.push(buffer.byteLength);
          }
          return buffer;
        },
      };
    });

    await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    /** Two shards, read once to scan and once to convert: the conversion
     * pass streams them rather than keeping the first scan's objects. */
    expect(readSizes).toHaveLength(4);
  });

  it('stops early when cancelled', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
      isCancelled: async () => true,
    });

    expect(recorded.conversations).toHaveLength(0);
    expect(report.imported).toBe(0);
  });

  it('stops before the next conversation once cancellation is observed mid-run', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([
        textConversation('ext-first', 'First convo', 1700005000),
        textConversation('ext-second', 'Second convo', 1700006000),
      ]),
      'export_manifest.json': shardedManifest(['conversations-000.json']),
    });
    const { sink, recorded } = recorder();
    let checks = 0;
    /** The run reads cancellation at most once per second so a Redis-backed
     * job store is not hit once per conversation, so the clock has to move
     * for the second conversation's check to reach the store at all. */
    const start = Date.now();
    let elapsed = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => start + elapsed);

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
      /** Keyed off what has actually been written rather than a probe count,
       * so it keeps meaning "cancelled after the first conversation" however
       * many times the run checks along the way. */
      isCancelled: async () => {
        checks += 1;
        elapsed += 2000;
        return recorded.conversations.length >= 1;
      },
    });

    now.mockRestore();

    expect(checks).toBeGreaterThan(0);
    expect(recorded.conversations).toHaveLength(1);
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(0);
  });

  /** The scan runs before any phase is announced and spends real time
   * inflating and parsing a large sharded export. Without a check here the job
   * reports cancelled while the process works on through every shard. */
  it('abandons the pre-scan when the job is already cancelled', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([
        textConversation('ext-first', 'First convo', 1700005000),
      ]),
      'export_manifest.json': shardedManifest(['conversations-000.json']),
    });
    const { sink, recorded } = recorder();
    const reads: string[] = [];
    const realOpen = archiveModule.openArchive;
    jest.spyOn(archiveModule, 'openArchive').mockImplementation(async (path, options) => {
      const archive = await realOpen(path, options);
      return {
        ...archive,
        read: async (name: string) => {
          reads.push(name);
          return archive.read(name);
        },
      };
    });

    try {
      const report = await runImport({
        filepath,
        userId: 'u1',
        defaultModel: 'gpt-4o',
        deps: DEPS,
        batch: sink,
        existingExternalIds: new Set(),
        isCancelled: async () => true,
      });

      expect(recorded.conversations).toEqual([]);
      expect(report.imported).toBe(0);
      expect(reads).not.toContain('conversations-000.json');
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('records a shard parse failure and still imports the other shard', async () => {
    const filepath = await writeZip({
      'conversations-000.json': 'not valid json{',
      'conversations-001.json': JSON.stringify([
        textConversation('ext-good', 'Good convo', 1700002000),
      ]),
      'export_manifest.json': shardedManifest(['conversations-000.json', 'conversations-001.json']),
    });

    const { sink, recorded } = recorder();
    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'archive_corrupt',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations).toHaveLength(1);
    expect(recorded.conversations[0].title).toBe('Good convo');
  });

  it('records a shard that parses but is not an array and still imports the other shard', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify({ not: 'an array' }),
      'conversations-001.json': JSON.stringify([
        textConversation('ext-good3', 'Good convo three', 1700007000),
      ]),
      'export_manifest.json': shardedManifest(['conversations-000.json', 'conversations-001.json']),
    });

    const { sink, recorded } = recorder();
    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'shard_not_array',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations).toHaveLength(1);
    expect(recorded.conversations[0].title).toBe('Good convo three');
  });

  it('records a shard whose entries match no known export shape and still imports the other shard', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([{ uuid: 'c1', unrecognized: true }]),
      'conversations-001.json': JSON.stringify([
        textConversation('ext-good5', 'Good convo five', 1700009000),
      ]),
      'export_manifest.json': shardedManifest(['conversations-000.json', 'conversations-001.json']),
    });

    const { sink, recorded } = recorder();
    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'shard_wrong_shape',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations).toHaveLength(1);
    expect(recorded.conversations[0].title).toBe('Good convo five');
  });

  it('records malformed conversations and still imports valid records in the shard', async () => {
    const before = textConversation('ext-before-null', 'Before malformed entry', 1700009100);
    const after = textConversation('ext-after-null', 'After malformed shard', 1700009200);
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([before, null, after]),
      'conversations-001.json': JSON.stringify([
        textConversation('ext-other-shard', 'Other shard', 1700009300),
      ]),
      'export_manifest.json': shardedManifest(['conversations-000.json', 'conversations-001.json']),
    });

    const { sink, recorded } = recorder();
    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(3);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'record_malformed',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations.map((conversation) => conversation.title)).toEqual([
      'Before malformed entry',
      'After malformed shard',
      'Other shard',
    ]);
  });
  it('records a malformed mapping entry and still ingests assets from later conversations in the shard', async () => {
    const malformed = {
      ...textConversation('ext-malformed-mapping', 'Malformed mapping', 1700009400),
      mapping: { broken: null },
    };
    const later = {
      ...textConversation('ext-later-asset', 'Later asset', 1700009500),
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u1'] },
        u1: {
          id: 'u1',
          parent: 'root',
          children: [],
          message: {
            id: 'u1',
            author: { role: 'user', name: null },
            create_time: 1700009501,
            content: {
              content_type: 'multimodal_text',
              parts: [
                {
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'file-service://file-second',
                },
              ],
            },
            metadata: {
              attachments: [
                {
                  id: 'file-second',
                  name: 'second.png',
                  mime_type: 'image/png',
                  size: 4,
                },
              ],
            },
          },
        },
      },
    };
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([malformed, later]),
      'conversation_asset_file_names.json': JSON.stringify({ 'file-second.dat': 'second.png' }),
      'file-second.dat': JSON.stringify([0x89, 0x50, 0x4e, 0x47]),
      'export_manifest.json': shardedManifest(['conversations-000.json']),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.assetsImported).toBe(1);
    expect(report.errors).toHaveLength(2);
    expect(report.errors[0]).toEqual({
      code: 'failed',
      location: 'ext-malformed-mapping',
    });
    expect(recorded.messages.find((message) => message.text === '')?.files).toHaveLength(1);
  });

  it('records a conversation that fails to convert and still imports the others', async () => {
    const good = textConversation('ext-good2', 'Good convo two', 1700003000);
    const broken = {
      conversation_id: 'ext-broken',
      title: 'Broken convo',
      create_time: 1700004000,
      update_time: 1700004100,
      default_model_slug: 'gpt-4o',
      is_archived: false,
      is_starred: false,
      pinned_time: null,
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['bad'] },
        bad: {
          id: 'bad',
          parent: 'root',
          children: [],
          message: {
            id: 'bad',
            author: null,
            create_time: 1700004001,
            content: { content_type: 'text', parts: ['oops'] },
          },
        },
      },
    };

    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([good, broken]),
      'export_manifest.json': shardedManifest(['conversations-000.json']),
    });

    const { sink, recorded } = recorder();
    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: DEPS,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'failed',
      location: 'ext-broken',
    });
    expect(recorded.conversations).toHaveLength(1);
    expect(recorded.conversations[0].title).toBe('Good convo two');
  });

  it('counts asset errors separately from conversation errors and keeps every conversation', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();
    let saveCalls = 0;

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps: {
        saveBuffer: async ({ fileName }: { fileName: string }) => {
          saveCalls += 1;
          if (saveCalls === 1) {
            throw new Error('quota exceeded');
          }
          return { filepath: `/uploads/u1/${fileName}`, source: 'local' };
        },
        createFile: async (data: { file_id: string }) => ({ file_id: data.file_id }),
      },
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.assetsImported).toBe(2);
    /** One pointer names no entry in the archive, the other an entry whose
     * storage write failed: neither attachment reaches a message. */
    expect(report.assetsUnavailable).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'failed',
      location: 'file_generated.dat',
    });
    expect(recorded.conversations).toHaveLength(2);
  });

  it('closes the archive and rethrows when the final batch save fails', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    sink.saveBatch = async () => {
      throw new Error('db down');
    };

    let closed = false;
    const realOpenArchive = archiveModule.openArchive;
    jest.spyOn(archiveModule, 'openArchive').mockImplementationOnce(async (path, options) => {
      const archive = await realOpenArchive(path, options);
      return {
        ...archive,
        close: () => {
          closed = true;
          archive.close();
        },
      };
    });

    await expect(
      runImport({
        filepath,
        userId: 'u1',
        defaultModel: 'gpt-4o',
        deps: DEPS,
        batch: sink,
        existingExternalIds: new Set(),
      }),
    ).rejects.toThrow('db down');

    expect(closed).toBe(true);
  });
});

/**
 * Assets are ingested in full before the first conversation is written, so a
 * run that stops in between leaves every file it created referenced by
 * nothing. The rows are created with the TTL disabled and nothing else knows
 * they exist, so the run has to clean up after itself.
 */
describe('runImport asset cleanup', () => {
  function recordingDeps() {
    const deleted: string[] = [];
    return {
      deleted,
      deps: {
        ...DEPS,
        deleteFile: async (asset: { file_id: string }) => {
          deleted.push(asset.file_id);
        },
      },
    };
  }

  it('keeps every asset a committed conversation references', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    const { deleted, deps } = recordingDeps();

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.assetsImported).toBeGreaterThan(0);
    expect(deleted).toEqual([]);
  });

  it('removes every asset when the run is cancelled before any conversation lands', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();
    const { deleted, deps } = recordingDeps();

    /** Cancels the moment the asset phase has finished, which is the window
     * the conversation loop exits immediately on. */
    let assetsDone = false;
    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps,
      batch: sink,
      existingExternalIds: new Set(),
      onPhase: async (phase) => {
        if (phase === 'conversations') {
          assetsDone = true;
        }
      },
      isCancelled: async () => assetsDone,
    });

    expect(report.assetsImported).toBeGreaterThan(0);
    expect(recorded.conversations).toEqual([]);
    expect(deleted).toHaveLength(report.assetsImported);
  });

  it('can clean up assets after a cancellation-store read fails during ingestion', async () => {
    const filepath = await buildFixtureExport();
    const { sink, recorded } = recorder();
    const { deleted, deps } = recordingDeps();
    let phase: ImportPhase = 'queued';
    let assetChecks = 0;

    const report = await runImport({
      filepath,
      userId: 'u1',
      defaultModel: 'gpt-4o',
      deps,
      batch: sink,
      existingExternalIds: new Set(),
      onPhase: async (nextPhase) => {
        phase = nextPhase;
      },
      isCancelled: async () => {
        if (phase === 'conversations') {
          return true;
        }
        if (phase === 'assets') {
          assetChecks += 1;
          if (assetChecks === 1) {
            throw new Error('cancellation store unavailable');
          }
        }
        return false;
      },
    });

    expect(report.assetsImported).toBeGreaterThan(0);
    expect(recorded.conversations).toEqual([]);
    expect(deleted).toHaveLength(report.assetsImported);
  });

  /** The incremental flush is ambiguous for the same reason the final save is,
   * so the conversations buffered up to that point keep their assets. Only the
   * later conversations the run never reached are genuinely unreferenced: the
   * fixture's first conversation claims one of its three assets, and the two
   * belonging to the conversation that was never converted are released. */
  it('keeps the assets buffered before an ambiguous incremental flush rejection', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();
    const { deleted, deps } = recordingDeps();
    sink.maybeFlush = async () => {
      throw new Error('write concern timeout');
    };
    sink.getLastFlushOutcome = () => 'ambiguous';

    await expect(
      runImport({
        filepath,
        userId: 'u1',
        defaultModel: 'gpt-4o',
        deps,
        batch: sink,
        existingExternalIds: new Set(),
      }),
    ).rejects.toThrow('write concern timeout');

    expect(deleted).toHaveLength(2);
  });

  it('is a no-op when the caller supplies no delete function', async () => {
    const filepath = await buildFixtureExport();
    const { sink } = recorder();

    await expect(
      runImport({
        filepath,
        userId: 'u1',
        defaultModel: 'gpt-4o',
        deps: DEPS,
        batch: sink,
        existingExternalIds: new Set(),
        isCancelled: async () => true,
      }),
    ).resolves.toBeDefined();
  });
});
