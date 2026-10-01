import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TImportError } from 'librechat-data-provider';
import type {
  ChatGptAttachment,
  ChatGptConversation,
  ConvertedMessage,
  ExportFormat,
  ImportedAsset,
  ImportProgress,
  ImportReport,
} from './types';
import type { SaveMessageDetails, RunImportInput, ProviderImportContext } from './sink';
import type { AssetReference } from './chatgpt/content';
import type { Archive } from './archive';
import {
  MANIFEST_ENTRY,
  parseManifest,
  resolveLayout,
  detectExportFormat,
  hasChatGptConversationShape,
  isChatGptConversation,
} from './manifest';
import { classifyImportError, recordItemError, recordError } from './errors';
import { collectAssetReferences } from './chatgpt/content';
import { convertConversation } from './chatgpt/convert';
import { runClaudeImport } from './claude/service';
import { runGrokImport } from './grok/service';
import { throttleCancelCheck } from './cancel';
import { isUsableExternalId } from './sink';
import { openArchive } from './archive';
import { ingestAssets } from './assets';

interface ExportScan {
  /** Shards that parsed and validated, in export order. The conversion pass
   * re-reads only these, so a shard already recorded in `errors` is never
   * reported twice. */
  shards: string[];
  conversations: number;
  pointers: string[];
  attachments: Map<string, ChatGptAttachment>;
  references: Map<string, AssetReference>;
  /** Set when the scan stopped early because the job was cancelled, so the run
   * does not go on to ingest assets for a partial pointer list. */
  cancelled?: boolean;
  /** The format the first shard that parsed turned out to be. A Claude or Grok
   * export aborts the scan immediately; neither has assets a conversation can
   * resolve, so nothing this pass collects applies to them. */
  format: ExportFormat;
}

class ShardShapeError extends Error {}

async function readShardJson(archive: Archive, shard: string): Promise<unknown> {
  return JSON.parse((await archive.read(shard)).toString('utf8')) as unknown;
}

function asChatGptConversations(parsed: unknown): ChatGptConversation[] {
  if (!Array.isArray(parsed)) {
    throw new ShardShapeError('expected an array of conversations');
  }
  if (!hasChatGptConversationShape(parsed)) {
    throw new ShardShapeError('expected ChatGPT conversation objects');
  }
  return parsed as ChatGptConversation[];
}

/**
 * Reads and validates one shard. Never retains the result: both passes drop
 * the parsed array as soon as they are done with it, which keeps peak heap
 * at one shard rather than the whole export.
 */
async function parseShard(archive: Archive, shard: string): Promise<ChatGptConversation[]> {
  return asChatGptConversations(await readShardJson(archive, shard));
}

function describeShardError(error: unknown, shard: string): TImportError {
  if (error instanceof ShardShapeError) {
    return {
      code:
        error.message === 'expected an array of conversations'
          ? 'shard_not_array'
          : 'shard_wrong_shape',
      location: shard,
    };
  }
  return {
    code: classifyImportError(error, `import shard ${shard}`),
    location: shard,
  };
}

function scanConversation(conv: ChatGptConversation, scan: ExportScan, seen: Set<string>): void {
  for (const node of Object.values(conv.mapping ?? {})) {
    if (!node.message) {
      continue;
    }
    for (const reference of collectAssetReferences(node.message)) {
      if (!seen.has(reference.pointer)) {
        seen.add(reference.pointer);
        scan.pointers.push(reference.pointer);
      }
      if (reference.width !== undefined || reference.height !== undefined) {
        scan.references.set(reference.pointer, reference);
      }
    }
    for (const attachment of node.message.metadata?.attachments ?? []) {
      scan.attachments.set(attachment.id, attachment);
    }
  }
}

/**
 * First pass over the export: parses every shard once to learn how many
 * conversations there are and which assets they reference, then throws the
 * parsed conversations away. Asset ingestion needs every pointer up front,
 * so this walk is what lets the conversion pass stream shard by shard
 * instead of holding the entire export in memory.
 *
 * One corrupt or non-array shard is recorded in `errors` and excluded from
 * the conversion pass without discarding the conversations in the others.
 *
 * A conversation the conversion pass will skip contributes no pointers:
 * ingesting its assets would create a second copy of every file and storage
 * object on every re-upload of an export already imported, all of them
 * unreferenced once the conversation itself is skipped. It still counts
 * towards `conversations`, which is the progress denominator the skip loop
 * advances.
 */
async function scanExport(
  archive: Archive,
  shards: string[],
  errors: TImportError[],
  existingExternalIds: ReadonlySet<string>,
  isCancelled?: () => Promise<boolean>,
): Promise<ExportScan> {
  const scan: ExportScan = {
    shards: [],
    conversations: 0,
    pointers: [],
    attachments: new Map(),
    references: new Map(),
    format: 'chatgpt',
  };
  const seen = new Set<string>();
  let detected = false;

  for (const shard of shards) {
    /** The scan runs before any phase is announced, and a large sharded export
     * spends real time here inflating and parsing. Without this the job reports
     * cancelled while the process works on through every remaining shard. */
    if (isCancelled && (await isCancelled())) {
      scan.cancelled = true;
      return scan;
    }

    try {
      const parsed = await readShardJson(archive, shard);

      if (!detected) {
        detected = true;
        scan.format = detectExportFormat(parsed) ?? 'chatgpt';
        if (scan.format !== 'chatgpt') {
          return scan;
        }
      }

      const conversations = asChatGptConversations(parsed);
      scan.shards.push(shard);
      scan.conversations += conversations.length;
      for (const conv of conversations) {
        if (!isChatGptConversation(conv)) {
          recordError(errors, { code: 'record_malformed', location: shard });
          continue;
        }
        if (
          isUsableExternalId(conv.conversation_id) &&
          existingExternalIds.has(conv.conversation_id)
        ) {
          continue;
        }
        try {
          scanConversation(conv, scan, seen);
        } catch (error) {
          recordItemError(
            errors,
            error,
            `scan conversation ${conv.conversation_id}`,
            conv.conversation_id,
          );
        }
      }
    } catch (error) {
      recordError(errors, describeShardError(error, shard));
    }
  }

  return scan;
}

function toSaveMessageDetails(message: ConvertedMessage): SaveMessageDetails {
  return {
    messageId: message.messageId,
    parentMessageId: message.parentMessageId,
    text: message.text,
    sender: message.sender,
    isCreatedByUser: message.isCreatedByUser,
    isUserSubmitted: true,
    model: message.model,
    createdAt: message.createdAt,
    endpoint: EModelEndpoint.openAI,
    content: message.content,
    attachments: message.attachments,
    files: message.files,
  };
}

/** Converts one conversation and writes it to the batch sink. Kept separate
 * from the run loop so a thrown conversion or write error is caught per
 * conversation rather than aborting the remaining ones. Returns the message
 * count so the caller can advance `progress.messages.done` in one step. */
function importConversation(
  conv: ChatGptConversation,
  input: RunImportInput,
  assets: Map<string, ImportedAsset>,
  pendingPointers: Set<string>,
): number {
  const converted = convertConversation(conv, {
    userId: input.userId,
    assets,
    defaultModel: input.defaultModel,
  });

  input.batch.startConversation(EModelEndpoint.openAI);
  for (const message of converted.messages) {
    input.batch.saveMessage(toSaveMessageDetails(message));
  }
  input.batch.finishConversation(
    converted.title,
    converted.createdAt,
    {
      isArchived: converted.isArchived,
      pinned: converted.pinned,
      model: converted.model,
      importedFrom: { source: 'chatgpt', externalId: converted.externalId },
    },
    converted.model,
  );

  /** Held pending, not claimed. The conversation is only buffered at this
   * point, so an asset claimed here would survive the cleanup with nothing
   * referencing it if the run ends before the buffer is written.
   * `commitPending` promotes these once a flush lands, and
   * `claimPendingOnFailure` promotes them when one rejects ambiguously. */
  for (const message of converted.messages) {
    for (const pointer of message.assetPointers) {
      pendingPointers.add(pointer);
    }
  }

  return converted.messages.length;
}

/**
 * Deletes assets no committed conversation ended up referencing.
 *
 * The asset phase runs to completion before the first conversation is written,
 * so cancelling during it, or failing anywhere after it, otherwise leaves
 * every ingested file permanently orphaned: the rows are created with the TTL
 * disabled, and nothing else knows they exist. `expiresAt` is not an
 * alternative here; it is a MongoDB TTL index that drops the row and leaves
 * the storage object behind.
 */
async function releaseUnusedAssets(
  assets: Map<string, ImportedAsset>,
  usedPointers: Set<string>,
  input: RunImportInput,
): Promise<void> {
  const deleteFile = input.deps.deleteFile;
  if (!deleteFile || assets.size === 0) {
    return;
  }

  for (const [pointer, asset] of assets) {
    if (usedPointers.has(pointer)) {
      continue;
    }
    try {
      await deleteFile(asset);
    } catch (error) {
      logger.error(`[import] Could not remove the unreferenced asset ${asset.file_id}`, error);
    }
  }
}

export async function runImport(input: RunImportInput): Promise<ImportReport> {
  const archive = await openArchive(input.filepath);
  /** Assets ingested this run, and the pointers a committed conversation
   * claimed. Declared out here so the `finally` can release the difference on
   * every exit path: completed, cancelled, or thrown. */
  const ingested = new Map<string, ImportedAsset>();
  /** Claimed: referenced by a conversation the sink has actually committed. */
  const usedPointers = new Set<string>();
  /** Buffered but not yet flushed. Promoted on a successful flush, or on an
   * ambiguous rejection that may have committed the conversations. */
  const pendingPointers = new Set<string>();

  const commitPending = (): void => {
    for (const pointer of pendingPointers) {
      usedPointers.add(pointer);
    }
    pendingPointers.clear();
  };

  /**
   * Claims buffered pointers only when a rejected flush reports that its
   * conversation write may have committed, then rethrows.
   *
   * A message-write rejection is known not to have committed a conversation,
   * so those assets are released. A conversation-write rejection is ambiguous:
   * it can commit and still reject on a write concern timeout, a dropped
   * response, or a partially applied batch. Those pointers are retained so a
   * committed conversation never loses its assets.
   */
  const claimPendingOnFailure = async <T>(flush: () => Promise<T>): Promise<T> => {
    try {
      return await flush();
    } catch (error) {
      const outcome = input.batch.getLastFlushOutcome?.();
      if (outcome === 'ambiguous' || outcome === 'committed') {
        commitPending();
      }
      throw error;
    }
  };

  const report: ImportReport = {
    imported: 0,
    skipped: 0,
    assetsImported: 0,
    assetsUnavailable: 0,
    errors: [],
  };

  try {
    const hasManifest = archive.entries.some((entry) => entry.name === MANIFEST_ENTRY);
    const manifest = hasManifest ? parseManifest(await archive.read(MANIFEST_ENTRY)) : null;
    const layout = resolveLayout(archive.entries, manifest, archive.bare);

    /** A shard the manifest declares but the archive omits is missing data, not
     * an absent feature: without this the run imports what survived and reports
     * success, and the user never learns which conversations were skipped. */
    for (const shard of layout.missingShards) {
      recordError(report.errors, { code: 'shard_missing', location: shard });
    }

    const providerRun: ProviderImportContext = {
      archive,
      shards: layout.conversationShards,
      input,
      report,
    };

    /** `inspectExport` already identified the format and the route passes it
     * through, so a Claude or Grok export skips the asset scan entirely rather
     * than reading its single large shard an extra time to re-learn its shape. */
    if (input.format === 'claude') {
      await runClaudeImport(providerRun);
      return report;
    }
    if (input.format === 'grok') {
      await runGrokImport(providerRun);
      return report;
    }

    const scan = await scanExport(
      archive,
      layout.conversationShards,
      report.errors,
      input.existingExternalIds,
      input.isCancelled,
    );

    if (scan.cancelled) {
      return report;
    }

    if (scan.format === 'claude') {
      await runClaudeImport(providerRun);
      return report;
    }
    if (scan.format === 'grok') {
      await runGrokImport(providerRun);
      return report;
    }

    /** `messages.total` stays 0: the count is only known after conversion, so
     * the UI shows messages as a running count rather than a ratio.
     * `assets.total` counts the pointers the conversations actually
     * reference, not every `.dat` entry in the archive, so the counter can
     * reach its total even when the export ships assets nothing links to. */
    const progress: ImportProgress = {
      conversations: { done: 0, total: scan.conversations },
      messages: { done: 0, total: 0 },
      assets: { done: 0, total: scan.pointers.length },
    };
    await input.onPhase?.('assets');

    const checkAssetCancelled = throttleCancelCheck(input.isCancelled);
    const assetResult = await ingestAssets({
      archive,
      layout,
      userId: input.userId,
      tenantId: input.tenantId,
      expiredAt: input.expiredAt,
      pointers: scan.pointers,
      attachments: scan.attachments,
      references: scan.references,
      deps: input.deps,
      isCancelled: checkAssetCancelled,
      onProgress: async (done) => {
        progress.assets.done = done;
        await input.onProgress?.(progress);
      },
    });

    for (const [pointer, asset] of assetResult.map) {
      ingested.set(pointer, asset);
    }
    report.assetsImported = assetResult.imported;
    report.assetsUnavailable = assetResult.unavailable;
    for (const message of assetResult.errors) {
      recordError(report.errors, message);
    }

    await input.onPhase?.('conversations');

    let cancelled = false;
    const checkCancelled = throttleCancelCheck(input.isCancelled);
    for (const shard of scan.shards) {
      if (cancelled) {
        break;
      }

      let conversations: ChatGptConversation[];
      try {
        conversations = await parseShard(archive, shard);
      } catch (error) {
        recordError(report.errors, describeShardError(error, shard));
        continue;
      }

      for (const conv of conversations) {
        if (!isChatGptConversation(conv)) {
          progress.conversations.done += 1;
          await input.onProgress?.(progress);
          continue;
        }

        if (await checkCancelled()) {
          cancelled = true;
          break;
        }

        const externalId = conv.conversation_id;
        const dedupable = isUsableExternalId(externalId);

        if (dedupable && input.existingExternalIds.has(externalId)) {
          report.skipped += 1;
          progress.conversations.done += 1;
          /** Published like any other advance: re-importing a finished export
           * is all skips, and without this the bar sits at its old value for
           * the whole run and then jumps straight to completed. */
          await input.onProgress?.(progress);
          continue;
        }

        try {
          progress.messages.done += importConversation(
            conv,
            input,
            assetResult.map,
            pendingPointers,
          );
          report.imported += 1;
          /** The skip set is a snapshot taken once at job start, so without
           * this a `conversation_id` appearing twice in one export (across
           * shards, or because the user concatenated two exports) imports as
           * two separate conversations. */
          if (dedupable) {
            input.existingExternalIds.add(externalId);
          }
        } catch (error) {
          recordItemError(
            report.errors,
            error,
            `import conversation ${conv.conversation_id}`,
            conv.conversation_id,
          );
        }

        progress.conversations.done += 1;
        if (await claimPendingOnFailure(() => input.batch.maybeFlush())) {
          commitPending();
        }
        await input.onProgress?.(progress);
      }
    }

    await claimPendingOnFailure(() => input.batch.saveBatch());
    commitPending();
    return report;
  } catch (error) {
    logger.error('[import] Import run failed', error);
    throw error;
  } finally {
    await releaseUnusedAssets(ingested, usedPointers, input);
    archive.close();
  }
}
