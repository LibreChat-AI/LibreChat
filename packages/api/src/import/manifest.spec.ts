import type { ArchiveEntry } from './archive';
import {
  isGrokExport,
  parseManifest,
  resolveLayout,
  detectExportFormat,
  isClaudeConversation,
  hasClaudeConversationShape,
  hasChatGptConversationShape,
} from './manifest';

function entries(...names: string[]): ArchiveEntry[] {
  return names.map((name) => ({ name, bytes: 10 }));
}

describe('parseManifest', () => {
  it('reads version and sharded logical files', () => {
    const manifest = parseManifest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          logical_files: {
            'conversations.json': {
              files: ['conversations-000.json', 'conversations-001.json'],
              sharded: true,
            },
          },
        }),
      ),
    );
    expect(manifest?.version).toBe(1);
    expect(manifest?.logical_files['conversations.json'].files).toHaveLength(2);
  });

  it('returns null on malformed JSON rather than throwing', () => {
    expect(parseManifest(Buffer.from('not json'))).toBeNull();
  });

  it('returns null when logical_files entries have invalid files structure', () => {
    const manifest = parseManifest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          logical_files: {
            'conversations.json': {
              files: 'nope',
              sharded: true,
            },
          },
        }),
      ),
    );
    expect(manifest).toBeNull();
  });

  it('returns null when logical_files entries contain non-string filenames', () => {
    const manifest = parseManifest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          logical_files: {
            'conversations.json': {
              files: ['conversations-000.json', 123],
              sharded: true,
            },
          },
        }),
      ),
    );
    expect(manifest).toBeNull();
  });
});

describe('resolveLayout', () => {
  it('orders shards as the manifest declares them', () => {
    const layout = resolveLayout(
      entries('conversations-001.json', 'conversations-000.json', 'export_manifest.json'),
      {
        version: 1,
        logical_files: {
          'conversations.json': {
            files: ['conversations-000.json', 'conversations-001.json'],
            sharded: true,
          },
        },
      },
    );
    expect(layout.conversationShards).toEqual(['conversations-000.json', 'conversations-001.json']);
    expect(layout.version).toBe(1);
  });

  it('sorts shards naturally when there is no manifest (zero-padded)', () => {
    const layout = resolveLayout(
      entries('conversations-010.json', 'conversations-002.json', 'conversations-001.json'),
      null,
    );
    expect(layout.conversationShards).toEqual([
      'conversations-001.json',
      'conversations-002.json',
      'conversations-010.json',
    ]);
  });

  it('sorts shards numerically, not lexicographically (unpadded)', () => {
    const layout = resolveLayout(
      entries('conversations-10.json', 'conversations-2.json', 'conversations-1.json'),
      null,
    );
    expect(layout.conversationShards).toEqual([
      'conversations-1.json',
      'conversations-2.json',
      'conversations-10.json',
    ]);
  });

  it('prefers a single conversations.json when present', () => {
    const layout = resolveLayout(entries('conversations.json', 'user.json'), null);
    expect(layout.conversationShards).toEqual(['conversations.json']);
  });

  it('falls back to a lone json upload', () => {
    const layout = resolveLayout(entries('my-export.json'), null);
    expect(layout.conversationShards).toEqual(['my-export.json']);
  });

  it('falls back to a lone bare upload whose accepted MIME type supplied no json suffix', () => {
    const layout = resolveLayout(entries('my-export'), null, true);
    expect(layout.conversationShards).toEqual(['my-export']);
  });

  /** The extensionless fallback exists for a bare MIME-only upload. Letting it
   * claim the sole entry of a zip too made any single-file archive a shard, so
   * a zip holding one `readme.txt` was parsed as JSON and surfaced as a corrupt
   * archive instead of an unsupported import type. */
  it('does not treat the sole extensionless entry of a zip as a shard', () => {
    const layout = resolveLayout(entries('readme.txt'), null);
    expect(layout.conversationShards).toEqual([]);
  });

  it('does not treat a lone non-json zip entry as a shard even with an asset sibling', () => {
    const layout = resolveLayout(entries('readme.txt', 'file-abc.dat'), null);
    expect(layout.conversationShards).toEqual([]);
  });

  it('still resolves a lone json zip entry without the bare fallback', () => {
    const layout = resolveLayout(entries('my-export.json'), null);
    expect(layout.conversationShards).toEqual(['my-export.json']);
  });

  it('ignores manifest shards that are absent from the archive', () => {
    const layout = resolveLayout(entries('conversations-000.json'), {
      version: 1,
      logical_files: {
        'conversations.json': {
          files: ['conversations-000.json', 'conversations-001.json'],
          sharded: true,
        },
      },
    });
    expect(layout.conversationShards).toEqual(['conversations-000.json']);
  });

  it('separates asset entries and the asset name map', () => {
    const layout = resolveLayout(
      entries(
        'conversations.json',
        'conversation_asset_file_names.json',
        'file-abc.dat',
        'file_000.dat',
      ),
      null,
    );
    expect(layout.assetNames).toBe('conversation_asset_file_names.json');
    expect(layout.assetEntries.map((entry) => entry.name)).toEqual([
      'file-abc.dat',
      'file_000.dat',
    ]);
  });

  it('falls back to filename detection when manifest result is empty', () => {
    const layout = resolveLayout(
      entries('conversations-001.json', 'conversations-002.json', 'export_manifest.json'),
      {
        version: 1,
        logical_files: {
          'conversations.json': {
            files: ['conversations-000.json'],
            sharded: true,
          },
        },
      },
    );
    expect(layout.conversationShards).toEqual(['conversations-001.json', 'conversations-002.json']);
  });

  it('prefers conversations.json over sharded files when both are present', () => {
    const layout = resolveLayout(
      entries('conversations.json', 'conversations-000.json', 'conversations-001.json'),
      null,
    );
    expect(layout.conversationShards).toEqual(['conversations.json']);
  });

  it('does not trigger bare-json fallback when multiple json siblings are present', () => {
    const layout = resolveLayout(
      entries(
        'user.json',
        'shared_conversations.json',
        'message_feedback.json',
        'group_chats.json',
        'library_files.json',
      ),
      null,
    );
    expect(layout.conversationShards).toEqual([]);
  });

  it('finds a nested Grok conversation file beside its unrelated json siblings', () => {
    const prefix = 'ttl/30d/export_data/e618db0b/';
    const layout = resolveLayout(
      entries(
        `${prefix}prod-mc-auth-mgmt-api.json`,
        `${prefix}prod-mc-billing.json`,
        `${prefix}prod-grok-backend.json`,
        `${prefix}prod-mc-asset-server//0380cd07/content`,
      ),
      null,
    );
    expect(layout.conversationShards).toEqual([`${prefix}prod-grok-backend.json`]);
    expect(layout.assetEntries).toEqual([]);
  });

  it('finds an unnested Grok conversation file', () => {
    const layout = resolveLayout(entries('prod-grok-backend.json'), null);
    expect(layout.conversationShards).toEqual(['prod-grok-backend.json']);
  });

  it('does not match a filename that merely ends with the Grok name', () => {
    const layout = resolveLayout(entries('not-prod-grok-backend.json', 'other.json'), null);
    expect(layout.conversationShards).toEqual([]);
  });

  it('falls back to filename detection when malformed manifest is passed', () => {
    const layout = resolveLayout(entries('conversations-001.json', 'conversations-002.json'), {
      version: 1,
      logical_files: {
        'conversations.json': {
          files: 'nope',
          sharded: true,
        } as unknown as { files: string[]; sharded: boolean },
      },
    });
    expect(layout.conversationShards).toEqual(['conversations-001.json', 'conversations-002.json']);
  });
});

describe('isGrokExport', () => {
  const entry = { conversation: { id: 'c1' }, responses: [] };

  it('accepts an object whose conversations carry a conversation envelope', () => {
    expect(isGrokExport({ conversations: [entry], projects: [], media_posts: [] })).toBe(true);
  });

  it('accepts mixed Grok records when a valid envelope remains reachable', () => {
    expect(isGrokExport({ conversations: [entry, null] })).toBe(true);
    expect(isGrokExport({ conversations: [null, entry] })).toBe(true);
  });

  it('rejects every shape that is not identifiably Grok', () => {
    expect(isGrokExport({ conversations: [] })).toBe(false);
    expect(isGrokExport({ conversations: 'nope' })).toBe(false);
    expect(isGrokExport({ conversations: [{ uuid: 'c1' }] })).toBe(false);
    expect(isGrokExport({ conversations: [null] })).toBe(false);
    expect(isGrokExport([entry])).toBe(false);
    expect(isGrokExport(null)).toBe(false);
    expect(isGrokExport('conversations')).toBe(false);
  });
});

describe('detectExportFormat', () => {
  it('resolves each supported format from its parsed shape', () => {
    expect(detectExportFormat([{ conversation_id: 'c1', mapping: {} }])).toBe('chatgpt');
    expect(detectExportFormat([{ uuid: 'c1', chat_messages: [] }])).toBe('claude');
    expect(detectExportFormat({ conversations: [{ conversation: { id: 'c1' } }] })).toBe('grok');
    expect(detectExportFormat([])).toBe('chatgpt');
  });

  it('returns null for objects and arrays matching no format', () => {
    expect(detectExportFormat({ version: 1, history: [] })).toBeNull();
    expect(detectExportFormat({ conversationId: 'c1', messages: [] })).toBeNull();
    expect(detectExportFormat([{ nothing: true }])).toBeNull();
    expect(detectExportFormat('nope')).toBeNull();
  });

  it('detects Claude when a malformed record follows a valid one', () => {
    expect(detectExportFormat([{ uuid: 'c1', chat_messages: [] }, null])).toBe('claude');
  });

  /** `uuid` keys the skip set and the `importedFrom` marker a re-import
   * dedupes against, and `chat_messages` is iterated as an array during
   * conversion. Presence alone let a missing, empty or wrongly typed value
   * through onto the Claude path. */
  it('rejects a Claude array whose uuid is missing, empty or not a string', () => {
    expect(detectExportFormat([{ chat_messages: [] }])).toBeNull();
    expect(detectExportFormat([{ uuid: '', chat_messages: [] }])).toBeNull();
    expect(detectExportFormat([{ uuid: 42, chat_messages: [] }])).toBeNull();
    expect(detectExportFormat([{ uuid: null, chat_messages: [] }])).toBeNull();
  });

  it('rejects a Claude array whose chat_messages is not an array', () => {
    expect(detectExportFormat([{ uuid: 'c1', chat_messages: null }])).toBeNull();
    expect(detectExportFormat([{ uuid: 'c1', chat_messages: 'nope' }])).toBeNull();
    expect(detectExportFormat([{ uuid: 'c1', chat_messages: {} }])).toBeNull();
    expect(detectExportFormat([{ uuid: 'c1' }])).toBeNull();
  });

  it('detects Claude when malformed records are mixed with valid ones', () => {
    expect(
      detectExportFormat([
        { uuid: 'c1', chat_messages: [] },
        { uuid: 'c2', chat_messages: null },
      ]),
    ).toBe('claude');
  });
});

describe('isClaudeConversation', () => {
  it('accepts a conversation carrying both required fields', () => {
    expect(isClaudeConversation({ uuid: 'c1', chat_messages: [] })).toBe(true);
    expect(isClaudeConversation({ uuid: 'c1', chat_messages: [{ text: 'hi' }] })).toBe(true);
  });

  it('rejects anything that is not an object', () => {
    expect(isClaudeConversation(null)).toBe(false);
    expect(isClaudeConversation(undefined)).toBe(false);
    expect(isClaudeConversation('c1')).toBe(false);
  });

  it('rejects a malformed uuid or chat_messages', () => {
    expect(isClaudeConversation({ uuid: '', chat_messages: [] })).toBe(false);
    expect(isClaudeConversation({ uuid: 42, chat_messages: [] })).toBe(false);
    expect(isClaudeConversation({ uuid: 'c1', chat_messages: null })).toBe(false);
    expect(isClaudeConversation({ uuid: 'c1' })).toBe(false);
  });
});
describe('hasClaudeConversationShape', () => {
  it('requires at least one well-formed conversation', () => {
    expect(hasClaudeConversationShape([{ uuid: 'c1', chat_messages: [] }])).toBe(true);
    expect(hasClaudeConversationShape([])).toBe(false);
    expect(hasClaudeConversationShape([{ uuid: 'c1', chat_messages: [] }, { uuid: 'c2' }])).toBe(
      true,
    );
    expect(hasClaudeConversationShape([{ uuid: 'c2' }])).toBe(false);
  });
});

describe('hasChatGptConversationShape', () => {
  it('allows malformed records when a valid conversation remains', () => {
    expect(hasChatGptConversationShape([{ conversation_id: 'c1', mapping: {} }, null])).toBe(true);
    expect(hasChatGptConversationShape([null])).toBe(false);
    expect(hasChatGptConversationShape([])).toBe(true);
  });
});

describe('resolveLayout missing shards', () => {
  it('reports a manifest-listed shard the archive does not contain', () => {
    const manifest = parseManifest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          logical_files: {
            'conversations.json': {
              files: ['conversations-000.json', 'conversations-001.json'],
              sharded: true,
            },
          },
        }),
      ),
    );

    const layout = resolveLayout([{ name: 'conversations-000.json', bytes: 2 }], manifest);

    expect(layout.conversationShards).toEqual(['conversations-000.json']);
    expect(layout.missingShards).toEqual(['conversations-001.json']);
  });

  it('reports nothing missing when the filename fallback is used', () => {
    const layout = resolveLayout([{ name: 'conversations.json', bytes: 2 }], null);

    expect(layout.conversationShards).toEqual(['conversations.json']);
    expect(layout.missingShards).toEqual([]);
  });
});
