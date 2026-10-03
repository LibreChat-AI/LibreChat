import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { Constants, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { SaveMessageDetails, ConversationOverrides } from '~/import/sink';
import type { ImportPhase, ImportProgress } from '~/import/types';
import { buildClaudeFixtureExport, cleanupClaudeFixtureExport } from '~/import/__data__/claude';
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
  defaultModel: 'claude-opus-4-7',
  deps: DEPS,
};

const localDirs: string[] = [];

function claudeConversation(uuid: string, name: string) {
  return {
    uuid,
    name,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:01.000Z',
    chat_messages: [],
  };
}

afterEach(() => {
  cleanupClaudeFixtureExport();
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-claude-service-'));
  localDirs.push(dir);
  const filepath = path.join(dir, 'export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

describe('inspectExport for a Claude export', () => {
  it('identifies the zipped layout and counts its conversations', async () => {
    const filepath = await buildClaudeFixtureExport();

    const inspected = await inspectExport(filepath);

    expect(inspected.format).toBe('claude');
    expect(inspected.summary).toEqual({
      source: 'claude',
      manifestVersion: null,
      conversations: 2,
      shards: 1,
      assets: 0,
      assetBytes: 0,
      archived: 0,
      starred: 0,
    });
  });

  it('identifies a bare conversations.json upload the same way', async () => {
    const filepath = await buildClaudeFixtureExport({ bare: true });

    const inspected = await inspectExport(filepath);

    expect(inspected.format).toBe('claude');
    expect(inspected.summary.source).toBe('claude');
    expect(inspected.summary.conversations).toBe(2);
  });

  it('inspects mixed shards and reports malformed records during import', async () => {
    const valid = claudeConversation('valid', 'Valid');
    const secondValid = claudeConversation('valid-2', 'Second valid');
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([valid]),
      'conversations-001.json': JSON.stringify([secondValid, null]),
    });
    const inspected = await inspectExport(filepath);
    const { sink, recorded } = recorder();

    expect(inspected.summary).toMatchObject({ conversations: 2, shards: 2 });

    const report = await runImport({
      ...BASE,
      filepath,
      format: inspected.format,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(recorded.conversations).toHaveLength(2);
    expect(report.imported).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'record_malformed',
      location: 'conversations-001.json',
    });
  });

  /** `uuid` is the external id the skip set and the `importedFrom` marker are
   * keyed by, so a missing or wrongly typed one imports duplicates on every
   * re-import instead of being skipped. Presence of `chat_messages` alone used
   * to be the whole check. */
  it('rejects a shard whose conversation uuid is missing, empty or not a string', async () => {
    for (const uuid of [undefined, '', 42, null]) {
      const filepath = await writeZip({
        'conversations.json': JSON.stringify([{ ...claudeConversation('valid', 'Valid'), uuid }]),
      });

      await expect(inspectExport(filepath)).rejects.toThrow('Unsupported import type');
    }
  });

  it('rejects a shard whose chat_messages is not an array', async () => {
    for (const chatMessages of [undefined, null, 'nope', {}]) {
      const filepath = await writeZip({
        'conversations.json': JSON.stringify([
          { ...claudeConversation('valid', 'Valid'), chat_messages: chatMessages },
        ]),
      });

      await expect(inspectExport(filepath)).rejects.toThrow('Unsupported import type');
    }
  });
});

describe('runImport for a Claude export', () => {
  it('imports a zipped export end to end on the anthropic endpoint', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect(recorded.endpoints).toEqual([EModelEndpoint.anthropic, EModelEndpoint.anthropic]);
    expect(recorded.conversations.map((entry) => entry.title)).toEqual([
      'Branching answer',
      'Tooling run',
    ]);
    expect(recorded.conversations[0].convo.importedFrom).toEqual({
      source: 'claude',
      externalId: 'claude-branched',
    });
    expect(
      recorded.messages.every((message) => message.endpoint === EModelEndpoint.anthropic),
    ).toBe(true);
  });

  it('detects the format itself when the caller does not declare it', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(recorded.endpoints[0]).toBe(EModelEndpoint.anthropic);
  });

  it('imports a bare conversations.json upload through the same pipeline', async () => {
    const filepath = await buildClaudeFixtureExport({ bare: true });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(recorded.conversations).toHaveLength(2);
  });

  it('preserves the branch and drops only the contentless message', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink, recorded } = recorder();

    await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    const branched = recorded.messages.slice(0, 4);
    const root = branched.find((message) => message.text === 'Which town should I stay in?');
    const siblings = branched.filter((message) => message.parentMessageId === root?.messageId);
    expect(root?.parentMessageId).toBe(Constants.NO_PARENT);
    expect(siblings).toHaveLength(2);

    /** `t6` carries only an unavailable file reference, so it is dropped and
     * `t7` re-parents onto `t5`. */
    const tooling = recorded.messages.slice(4);
    expect(tooling).toHaveLength(6);
    const recovered = tooling.find(
      (message) => message.text === 'Recovered from the flat text field.',
    );
    const viewCall = tooling.find(
      (message) =>
        message.content?.some(
          (part) => part.type === ContentTypes.TOOL_CALL && part.tool_call.name === 'view',
        ) === true,
    );
    expect(recovered?.parentMessageId).toBe(viewCall?.messageId);
  });

  it('emits paired, error and unmatched tool calls as finished tool_call parts', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink, recorded } = recorder();

    await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    const calls = recorded.messages.flatMap(
      (message) => message.content?.filter((part) => part.type === ContentTypes.TOOL_CALL) ?? [],
    );
    const byName = new Map(
      calls.map((part) => [
        part.type === ContentTypes.TOOL_CALL ? part.tool_call.name : '',
        part.type === ContentTypes.TOOL_CALL ? part.tool_call : undefined,
      ]),
    );

    expect(
      calls.every((part) => part.type === ContentTypes.TOOL_CALL && part.tool_call.progress === 1),
    ).toBe(true);
    expect(byName.get('bash_tool')?.args).toBe(
      '{"command":"ls -la","description":"List the directory"}',
    );
    expect(byName.get('bash_tool')?.output).toBe('{"returncode":0,"stdout":"src\\n"}');
    expect(byName.get('artifacts')?.output).toBe('Error:\nInput validation errors occurred');
    expect(byName.get('view')?.output).toBeUndefined();
  });

  it('carries citation anchors and the merged web_search attachment', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink, recorded } = recorder();

    await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    const cited = recorded.messages.find((message) => message.text.includes('turn0search'));
    expect(cited?.text).toContain('turn0search0');
    expect(cited?.text).toContain('turn0search1');
    expect(cited?.attachments?.[0].web_search.organic).toEqual([
      {
        link: 'https://www.librechat.ai/docs/configuration/redis',
        title: 'Redis Configuration Guide',
      },
      { link: 'https://www.librechat.ai/docs/configuration/dotenv' },
    ]);
  });

  it('reports extracted attachments as imported and file references as unavailable', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    /** One extraction carried over; one attachment without extraction, two
     * `files` references and one image result block are unavailable. */
    expect(report.assetsImported).toBe(1);
    expect(report.assetsUnavailable).toBe(4);
  });

  it('skips a conversation already imported under the same external id', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(['claude-branched']),
    });

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(recorded.conversations).toHaveLength(1);
    expect(recorded.conversations[0].convo.importedFrom.externalId).toBe('claude-tools');
  });

  it('reports progress with the shard total folded in', async () => {
    const filepath = await buildClaudeFixtureExport();
    const { sink } = recorder();
    const phases: ImportPhase[] = [];
    const snapshots: ImportProgress[] = [];

    await runImport({
      ...BASE,
      filepath,
      format: 'claude',
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
    const filepath = await buildClaudeFixtureExport();
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
      format: 'claude',
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

  it('records a shard that is not an array and imports nothing from it', async () => {
    const filepath = await writeZip({
      'conversations.json': JSON.stringify({ uuid: 'c1', chat_messages: [] }),
    });
    const { sink } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'shard_not_array',
      location: 'conversations.json',
    });
  });

  it('records a shard whose entries are not Claude-shaped', async () => {
    const filepath = await writeZip({
      'conversations.json': JSON.stringify([{ uuid: 'c1', mapping: {} }]),
    });
    const { sink } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(0);
    expect(report.errors[0]).toEqual({
      code: 'shard_wrong_shape',
      location: 'conversations.json',
    });
  });

  it('imports the valid records of a shard containing a malformed later entry', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([
        claudeConversation('before-null', 'Before malformed entry'),
        null,
      ]),
      'conversations-001.json': JSON.stringify([
        claudeConversation('after-null', 'After malformed shard'),
      ]),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'record_malformed',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations.map((conversation) => conversation.title)).toEqual([
      'Before malformed entry',
      'After malformed shard',
    ]);
  });

  /** Same shard error contract as any other shape mismatch: the shard is
   * recorded and skipped, the next one still imports. Before the uuid and
   * chat_messages types were checked, this shard imported a conversation whose
   * `importedFrom.externalId` was undefined, so every re-import duplicated it. */
  it('skips a shard whose conversation uuid is not a string and continues', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([
        { ...claudeConversation('unused', 'Bad uuid'), uuid: 42 },
      ]),
      'conversations-001.json': JSON.stringify([claudeConversation('good', 'Good shard')]),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'shard_wrong_shape',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations.map((conversation) => conversation.title)).toEqual([
      'Good shard',
    ]);
  });

  it('skips a shard whose chat_messages is not an array and continues', async () => {
    const filepath = await writeZip({
      'conversations-000.json': JSON.stringify([
        { ...claudeConversation('bad-messages', 'Bad messages'), chat_messages: null },
      ]),
      'conversations-001.json': JSON.stringify([claudeConversation('good', 'Good shard')]),
    });
    const { sink, recorded } = recorder();

    const report = await runImport({
      ...BASE,
      filepath,
      format: 'claude',
      batch: sink,
      existingExternalIds: new Set(),
    });

    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toEqual({
      code: 'shard_wrong_shape',
      location: 'conversations-000.json',
    });
    expect(recorded.conversations.map((conversation) => conversation.title)).toEqual([
      'Good shard',
    ]);
  });
});
