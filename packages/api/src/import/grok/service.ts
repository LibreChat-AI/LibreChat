import { EModelEndpoint } from 'librechat-data-provider';
import type { TImportError } from 'librechat-data-provider';
import type { SaveMessageDetails, RunImportInput, ProviderImportContext } from '~/import/sink';
import type { GrokExport, ImportProgress, GrokConversationEntry } from '~/import/types';
import type { ConvertedGrokConversation } from './convert';
import type { Archive } from '~/import/archive';
import { recordError, recordItemError, classifyImportError } from '~/import/errors';
import { isGrokExport, isGrokConversationEntry } from '~/import/manifest';
import { convertGrokConversation } from './convert';
import { isUsableExternalId } from '~/import/sink';
import { throttleCancelCheck } from '../cancel';

export const GROK_SOURCE = 'grok';

/**
 * xAI has no first-class `EModelEndpoint`: it is only reachable as a `custom`
 * endpoint whose name each deployment chooses in `librechat.yaml`, so a
 * conversation stamped with it would fail endpoint and model validation
 * anywhere xAI is not configured. Imported Grok conversations therefore carry
 * the deployment-universal OpenAI endpoint (the same choice the ChatGPT and
 * ChatbotUI paths make) while each message keeps its raw Grok model slug.
 */
export const GROK_ENDPOINT: EModelEndpoint = EModelEndpoint.openAI;

class ShardShapeError extends Error {}

async function parseShard(archive: Archive, shard: string): Promise<GrokExport> {
  const parsed: unknown = JSON.parse((await archive.read(shard)).toString('utf8'));
  if (!isGrokExport(parsed)) {
    throw new ShardShapeError('expected a Grok export object');
  }
  return parsed;
}

function describeShardError(error: unknown, shard: string): TImportError {
  if (error instanceof ShardShapeError) {
    return { code: 'shard_wrong_shape', location: shard };
  }
  return {
    code: classifyImportError(error, `import shard ${shard}`),
    location: shard,
  };
}

function toSaveMessageDetails(
  message: ConvertedGrokConversation['messages'][number],
): SaveMessageDetails {
  return {
    messageId: message.messageId,
    parentMessageId: message.parentMessageId,
    text: message.text,
    sender: message.sender,
    isCreatedByUser: message.isCreatedByUser,
    isUserSubmitted: true,
    model: message.model,
    createdAt: message.createdAt,
    endpoint: GROK_ENDPOINT,
  };
}

/**
 * Converts one conversation and writes it to the batch sink, kept separate from
 * the run loop so a thrown conversion or write error is caught per conversation
 * rather than aborting the remaining ones.
 */
export function writeGrokConversation(
  entry: GrokConversationEntry,
  input: RunImportInput,
): ConvertedGrokConversation {
  const converted = convertGrokConversation(entry, { defaultModel: input.defaultModel });

  input.batch.startConversation(GROK_ENDPOINT);
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
      importedFrom: { source: GROK_SOURCE, externalId: converted.externalId },
    },
    converted.model,
  );

  return converted;
}

/**
 * Runs a Grok export through the same job pipeline ChatGPT and Claude exports
 * use.
 *
 * There is no asset phase: the binaries a Grok export ships belong to its
 * `media_posts` (Grok Imagine generations), which no conversation references, so
 * there is nothing for conversations to resolve and nothing to pre-scan. Each
 * shard is read exactly once and its conversation count folded into the progress
 * total as it is converted.
 */
export async function runGrokImport(context: ProviderImportContext): Promise<void> {
  const { archive, input, report } = context;

  const progress: ImportProgress = {
    conversations: { done: 0, total: 0 },
    messages: { done: 0, total: 0 },
    assets: { done: 0, total: 0 },
  };

  await input.onPhase?.('conversations');

  let cancelled = false;
  const checkCancelled = throttleCancelCheck(input.isCancelled);
  for (const shard of context.shards) {
    if (cancelled) {
      break;
    }

    let parsed: GrokExport;
    try {
      parsed = await parseShard(archive, shard);
    } catch (error) {
      recordError(report.errors, describeShardError(error, shard));
      continue;
    }

    progress.conversations.total += parsed.conversations.length;

    for (const entry of parsed.conversations) {
      if (await checkCancelled()) {
        cancelled = true;
        break;
      }

      if (!isGrokConversationEntry(entry)) {
        recordError(report.errors, { code: 'record_malformed', location: shard });
        progress.conversations.done += 1;
        await input.onProgress?.(progress);
        continue;
      }

      let externalId = '';
      try {
        const rawId = entry.conversation.id;
        /** Only a real id may key the skip set: adding `undefined` once makes
         * every later id-less conversation in the same export test as a
         * duplicate and get silently dropped. They are imported instead, just
         * not deduped. */
        const dedupable = isUsableExternalId(rawId);
        externalId = dedupable ? rawId : '';

        if (dedupable && input.existingExternalIds.has(rawId)) {
          report.skipped += 1;
        } else {
          const converted = writeGrokConversation(entry, input);
          progress.messages.done += converted.messages.length;
          report.imported += 1;
          /** The skip set is a snapshot taken at job start, so an id repeated
           * within one export would otherwise import twice. */
          if (dedupable) {
            input.existingExternalIds.add(rawId);
          }
        }
      } catch (error) {
        /** A conversation with no usable id still has to be nameable in the
         * report, so the entry falls back to a generic location rather than
         * an empty one. */
        const label = externalId || 'conversation';
        recordItemError(report.errors, error, `import ${label}`, label);
      }

      progress.conversations.done += 1;
      await input.batch.maybeFlush();
      await input.onProgress?.(progress);
    }
  }

  await input.batch.saveBatch();
}
