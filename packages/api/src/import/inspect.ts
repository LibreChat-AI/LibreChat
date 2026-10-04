import type { ExportFormat, GrokExport, ImportSummary } from './types';
import type { ExportLayout } from './manifest';
import {
  MANIFEST_ENTRY,
  isGrokExport,
  isGrokConversationEntry,
  isClaudeConversation,
  isChatGptConversation,
  parseManifest,
  resolveLayout,
  detectExportFormat,
  hasClaudeConversationShape,
  hasChatGptConversationShape,
} from './manifest';
import { openArchive } from './archive';

interface ShardTotals {
  conversations: number;
  archived: number;
  starred: number;
  shards: number;
}

function tallyChatGptShard(conversations: unknown[], totals: ShardTotals): void {
  for (const conversation of conversations) {
    if (!isChatGptConversation(conversation)) {
      continue;
    }
    totals.conversations += 1;
    if (conversation.is_archived === true) {
      totals.archived += 1;
    }
    if (conversation.is_starred === true || conversation.pinned_time != null) {
      totals.starred += 1;
    }
  }
}

function tallyClaudeShard(conversations: unknown[], totals: ShardTotals): void {
  for (const conversation of conversations) {
    if (isClaudeConversation(conversation)) {
      totals.conversations += 1;
    }
  }
}

function tallyGrokExport(parsed: GrokExport, totals: ShardTotals): void {
  for (const entry of parsed.conversations) {
    if (!isGrokConversationEntry(entry)) {
      continue;
    }
    totals.conversations += 1;
    if (entry.conversation?.starred === true) {
      totals.starred += 1;
    }
  }
}

export async function inspectExport(
  filepath: string,
): Promise<{ summary: ImportSummary; layout: ExportLayout; format: ExportFormat }> {
  const archive = await openArchive(filepath);

  try {
    const hasManifest = archive.entries.some((entry) => entry.name === MANIFEST_ENTRY);
    const manifest = hasManifest ? parseManifest(await archive.read(MANIFEST_ENTRY)) : null;
    const layout = resolveLayout(archive.entries, manifest, archive.bare);

    if (layout.conversationShards.length === 0) {
      throw new Error('Unsupported import type');
    }

    /** The conversation, archived and starred counts the confirmation screen
     * shows exist nowhere but inside the shards, so they cannot be read from
     * a header: the shards have to be parsed. Each one is parsed, tallied
     * and dropped before the next is read, so peak heap stays at a single
     * shard rather than the whole export. The format is decided by the first
     * valid shard's parsed shape, the only thing distinguishing a Claude
     * export (whose conversations carry `chat_messages`) or a Grok one (an
     * object keyed by `conversations`) from a ChatGPT one. Malformed shards
     * and records are left for `runImport` to report and skip. */
    const totals: ShardTotals = { conversations: 0, archived: 0, starred: 0, shards: 0 };
    let format: ExportFormat | null = null;

    for (const shard of layout.conversationShards) {
      try {
        const parsed: unknown = JSON.parse((await archive.read(shard)).toString('utf8'));
        const shardFormat = detectExportFormat(parsed);
        if (shardFormat === null || (format !== null && shardFormat !== format)) {
          continue;
        }
        format ??= shardFormat;

        if (format === 'grok') {
          if (!isGrokExport(parsed)) {
            continue;
          }
          tallyGrokExport(parsed, totals);
          totals.shards += 1;
          continue;
        }

        if (!Array.isArray(parsed)) {
          continue;
        }

        if (format === 'claude') {
          if (!hasClaudeConversationShape(parsed)) {
            continue;
          }
          tallyClaudeShard(parsed, totals);
          totals.shards += 1;
          continue;
        }

        if (!hasChatGptConversationShape(parsed)) {
          continue;
        }
        tallyChatGptShard(parsed, totals);
        totals.shards += 1;
      } catch {
        continue;
      }
    }

    if (format === null || totals.shards === 0) {
      throw new Error('Unsupported import type');
    }

    if (format === 'grok') {
      /** A Grok export's binaries belong to its `media_posts`, which no
       * conversation references, and it has no archived flag, so both
       * counters are structurally zero rather than untallied. `starred` is a
       * real per-conversation field and is counted. */
      return {
        layout,
        format,
        summary: {
          source: 'grok',
          manifestVersion: null,
          conversations: totals.conversations,
          shards: totals.shards,
          assets: 0,
          assetBytes: 0,
          archived: 0,
          starred: totals.starred,
        },
      };
    }

    if (format === 'claude') {
      /** A Claude export ships no binaries and has no archived or starred
       * flags, so those counters are structurally zero rather than untallied. */
      return {
        layout,
        format,
        summary: {
          source: 'claude',
          manifestVersion: null,
          conversations: totals.conversations,
          shards: totals.shards,
          assets: 0,
          assetBytes: 0,
          archived: 0,
          starred: 0,
        },
      };
    }

    let assetBytes = 0;
    for (const entry of layout.assetEntries) {
      assetBytes += entry.bytes;
    }

    return {
      layout,
      format: 'chatgpt',
      summary: {
        source: layout.version === null ? 'chatgpt-legacy' : 'chatgpt',
        manifestVersion: layout.version,
        conversations: totals.conversations,
        shards: totals.shards,
        assets: layout.assetEntries.length,
        assetBytes,
        archived: totals.archived,
        starred: totals.starred,
      },
    };
  } finally {
    archive.close();
  }
}
