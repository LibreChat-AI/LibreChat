import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { SaveMessageDetails, ConversationOverrides } from '~/import/sink';
import type { ImportPhase, ImportProgress } from '~/import/types';
import {
  GROK_ENTRY_PATH,
  buildGrokFixtureExport,
  cleanupGrokFixtureExport,
} from '~/import/__data__/grok';
import { inspectExport } from '~/import/inspect';
import { runImport } from '~/import/service';

interface Recorded {
  conversations: Array<{ title: string; convo: ConversationOverrides; model: string }>;
  messages: SaveMessageDetails[];
  endpoints: Array<string | undefined>;
}

function recorder(): { sink: Parameters<typeof runImport>[0]['batch']; recorded: Recorded } {
  const recorded: Recorded = { conversations: [], messages: [], endpoints: [] };
  return {
    recorded,
    sink: {
      startConversation: (endpoint) => {
        recorded.endpoints.push(endpoint);
      },
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

const BASE = {
  userId: 'u1',
  defaultModel: 'gpt-4o-mini',
  deps: DEPS,
};

const localDirs: string[] = [];

afterEach(() => {
  cleanupGrokFixtureExport();
  for (const dir of localDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  localDirs.length = 0;
});

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-grok-service-'));
  localDirs.push(dir);
  const filepath = path.join(dir, 'export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function byText(messages: SaveMessageDetails[], text: string): SaveMessageDetails {
  const found = messages.find((message) => message.text === text);
  if (!found) {
    throw new Error(`no saved message with text ${text}`);
  }
  return found;
}

describe('inspectExport for a Grok export', () => {
  it('finds the nested conversation file and counts conversations and stars', async () => {
    const filepath = await buildGrokFixtureExport();

    const inspected = await inspectExport(filepath);

    expect(inspected.format).toBe('grok');
    expect(inspected.layout.conversationShards).toEqual([GROK_ENTRY_PATH]);
    expect(inspected.summary).toEqual({
      source: 'grok',
      manifestVersion: null,
      conversations: 2,
      shards: 1,
      assets: 0,
      assetBytes: 0,
      archived: 0,
      starred: 1,
    });
  });

  it('identifies a bare prod-grok-backend.json upload the same way', async () => {
    const filepath = await buildGrokFixtureExport({ bare: true });

    const inspected = await inspectExport(filepath);

    expect(inspected.format).toBe('grok');
    expect(inspected.summary.source).toBe('grok');
    expect(inspected.summary.conversations).toBe(2);
    expect(inspected.summary.starred).toBe(1);
  });

  /** An object carrying nothing but an empty `conversations` array is not
   * identifiably Grok, so it stays unsupported rather than being imported as an
   * empty export of a format it may not be. */
  it('rejects an export whose conversations array is empty', async () => {
    const filepath = await writeZip({
      [GROK_ENTRY_PATH]: JSON.stringify({ conversations: [], projects: [], media_posts: [] }),
    });

    await expect(inspectExport(filepath)).rejects.toThrow(/Unsupported import type/);
  });

  it('counts valid records in a Grok shard that also contains a malformed record', async () => {
    const filepath = await writeZip({
      [GROK_ENTRY_PATH]: JSON.stringify({
        conversations: [
          { conversation: { id: 'ok-1', starred: true }, responses: [] },
          null,
          { conversation: { id: 'ok-2' }, responses: [] },
        ],
      }),
    });

    const inspected = await inspectExport(filepath);

    expect(inspected.format).toBe('grok');
    expect(inspected.summary.conversations).toBe(2);
    expect(inspected.summary.starred).toBe(1);
    expect(inspected.summary.shards).toBe(1);
  });

  it('does not mistake a Claude or ChatGPT export for a Grok one', async () => {
    const chatgpt = await writeZip({
      'conversations.json': JSON.stringify([{ conversation_id: 'c1', mapping: {} }]),
    });
    const claude = await writeZip({
      'conversations.json': JSON.stringify([{ uuid: 'c1', chat_messages: [] }]),
    });

    expect((await inspectExport(chatgpt)).format).toBe('chatgpt');
    expect((await inspectExport(claude)).format).toBe('claude');
  });
});

describe('runImport for a Grok export', () => {
  it('imports a zipped export end to end on the OpenAI endpoint', async () => {
    const filepath = await buildGrokFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.assetsImported).toBe(0);
    expect(report.assetsUnavailable).toBe(0);
    expect(recorded.endpoints).toEqual([EModelEndpoint.openAI, EModelEndpoint.openAI]);
    expect(recorded.conversations.map((entry) => entry.title)).toEqual([
      'Amalfi trip planning',
      'Recovering a cut-off script',
    ]);
    expect(recorded.conversations[0].convo.importedFrom).toEqual({
      source: 'grok',
      externalId: 'grok-branched',
    });
    expect(recorded.conversations[1].convo.pinned).toBe(true);
    expect(recorded.messages.every((message) => message.endpoint === EModelEndpoint.openAI)).toBe(
      true,
    );
  });

  it('detects the format itself when the caller does not declare it', async () => {
    const filepath = await buildGrokFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(recorded.endpoints[0]).toBe(EModelEndpoint.openAI);
  });

  it('imports a bare prod-grok-backend.json upload through the same pipeline', async () => {
    const filepath = await buildGrokFixtureExport({ bare: true });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(recorded.messages).toHaveLength(10);
  });

  it('keeps the branch, the retry roots and the raw per-message models', async () => {
    const filepath = await buildGrokFixtureExport();
    const { sink, recorded } = recorder();

    await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    const branched = recorded.messages.slice(0, 5);
    const root = byText(branched, 'Where should I stay? https://earthtrekkers.com/amalfi');
    const siblings = branched.filter((message) => message.parentMessageId === root.messageId);

    expect(root.parentMessageId).toBe(Constants.NO_PARENT);
    expect(siblings).toHaveLength(2);
    expect(byText(branched, 'Positano.').sender).toBe('Grok 4.1 Thinking');
    expect(byText(branched, 'Positano.').model).toBe('grok-4-1-thinking-1129');
    expect(byText(branched, 'Ravello.').model).toBe('grok-3');
    /** Blank model on a human turn and on an assistant turn: both fall back to
     * the endpoint default, only the sender differs. */
    expect(root.model).toBe(BASE.defaultModel);
    expect(root.sender).toBe('user');
    expect(byText(branched, 'Quieter, and the gardens.').model).toBe(BASE.defaultModel);
    expect(byText(branched, 'Quieter, and the gardens.').sender).toBe('Grok');

    /** The retried conversation: the textless response is dropped, its child
     * re-parents onto the opening prompt, and the second prompt and the
     * dangling follow-up are roots of their own. */
    const retried = recorded.messages.slice(5);
    expect(retried).toHaveLength(5);
    expect(byText(retried, 'Here is the completed script.').parentMessageId).toBe(
      byText(retried, 'Complete this script.').messageId,
    );
    const roots = retried.filter((message) => message.parentMessageId === Constants.NO_PARENT);
    expect(roots).toHaveLength(3);
    expect(byText(retried, 'Second attempt.').createdAt.toISOString()).toBe(
      '2026-07-15T10:01:00.000Z',
    );
  });

  it('skips a conversation already imported under the same external id', async () => {
    const filepath = await buildGrokFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(['grok-branched']),
    });

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(recorded.conversations).toHaveLength(1);
    expect(recorded.conversations[0].convo.importedFrom.externalId).toBe('grok-retried');
  });

  /** `existingExternalIds` is typed `Set<string>` but filled from parsed JSON.
   * Adding a missing id to it once made every later id-less conversation in
   * the same export test as a duplicate, so an export carrying two of them
   * imported one and silently dropped the rest. */
  it('imports every conversation whose id is missing or not a string', async () => {
    const conversation = (id: unknown, title: string) => ({
      conversation: { id, title, create_time: '2026-07-15T10:00:00Z' },
      responses: [],
    });
    const filepath = await writeZip({
      'prod-grok-backend.json': JSON.stringify({
        conversations: [
          conversation('grok-real', 'Has an id'),
          conversation(undefined, 'First without id'),
          conversation(undefined, 'Second without id'),
          conversation(null, 'First null id'),
          conversation(null, 'Second null id'),
          conversation('', 'First empty id'),
          conversation('', 'Second empty id'),
        ],
      }),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(7);
    expect(report.skipped).toBe(0);
    expect(recorded.conversations).toHaveLength(7);
  });

  it('reports progress with the shard total folded in and no asset phase', async () => {
    const filepath = await buildGrokFixtureExport();
    const { sink } = recorder();
    const phases: ImportPhase[] = [];
    const snapshots: ImportProgress[] = [];

    await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
      onPhase: async (phase) => {
        phases.push(phase);
      },
      onProgress: async (progress) => {
        snapshots.push(JSON.parse(JSON.stringify(progress)) as ImportProgress);
      },
    });

    expect(phases).toEqual(['conversations']);
    expect(snapshots[snapshots.length - 1]).toEqual({
      conversations: { done: 2, total: 2 },
      messages: { done: 10, total: 0 },
      assets: { done: 0, total: 0 },
    });
  });

  it('stops early when cancelled', async () => {
    const filepath = await buildGrokFixtureExport();
    const { sink, recorded } = recorder();
    let calls = 0;
    /** The run reads cancellation at most once per second so a Redis-backed
     * job store is not hit once per conversation, so the clock has to move
     * for the second conversation's check to reach the store at all. */
    const start = Date.now();
    let elapsed = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => start + elapsed);

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
      isCancelled: async () => {
        calls += 1;
        elapsed += 2000;
        return calls > 1;
      },
    });

    now.mockRestore();

    expect(report.imported).toBe(1);
    expect(recorded.conversations).toHaveLength(1);
  });

  it('records a shard that is not a Grok export and imports nothing from it', async () => {
    const filepath = await writeZip({
      [GROK_ENTRY_PATH]: JSON.stringify({ conversations: 'not an array' }),
    });
    const { sink } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'shard_wrong_shape',
      location: GROK_ENTRY_PATH,
    });
  });

  it('records a conversation missing its id without aborting the rest of the shard', async () => {
    const filepath = await writeZip({
      [GROK_ENTRY_PATH]: JSON.stringify({
        conversations: [
          { conversation: { id: 'ok-1' }, responses: [] },
          { responses: [] },
          { conversation: { id: 'ok-2' }, responses: [] },
        ],
      }),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'record_malformed',
      location: GROK_ENTRY_PATH,
    });
    expect(recorded.conversations.map((entry) => entry.convo.importedFrom.externalId)).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });

  it('reports a malformed Grok record and imports valid records around it', async () => {
    const filepath = await writeZip({
      [GROK_ENTRY_PATH]: JSON.stringify({
        conversations: [
          { conversation: { id: 'ok-1', title: 'First' }, responses: [] },
          null,
          { conversation: { id: 'ok-2', title: 'Second' }, responses: [] },
        ],
      }),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'grok',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'record_malformed',
      location: GROK_ENTRY_PATH,
    });
    expect(recorded.conversations.map((entry) => entry.convo.importedFrom.externalId)).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });
});
