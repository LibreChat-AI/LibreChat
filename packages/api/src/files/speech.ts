import { scopedCacheKey } from '@librechat/data-schemas';
import { Time, getSpeechText, findLastSeparatorIndex } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

const MAX_NOT_FOUND_COUNT = 6;
const MAX_NO_CHANGE_COUNT = 10;

export type SpeechChunk = { text: string; isFinished: boolean };

type CachedSpeech = string | { text: string; complete?: boolean };

export interface SpeechMessageCache {
  get(key: string): Promise<CachedSpeech | null | undefined>;
  set(key: string, value: CachedSpeech, ttl?: number): unknown;
}

/**
 * Polls a message for the next text to stream as speech. Each call returns the chunks
 * finalized since the previous one, or an error string once the message stays missing or
 * unchanged too long. Only the answer is spoken: reasoning never reaches the chunks.
 * Must be created within the request's tenant scope, which the cache key captures.
 */
export function createSpeechChunkProcessor({
  user,
  messageId,
  cache,
  getMessage,
}: {
  user: string;
  messageId?: string;
  cache: SpeechMessageCache;
  getMessage: (filter: { user: string; messageId: string }) => Promise<TMessage | null>;
}): () => Promise<SpeechChunk[] | string> {
  if (!messageId) {
    throw new Error('Message ID is required');
  }

  let notFoundCount = 0;
  let noChangeCount = 0;
  let processedText = '';
  const cacheKey = scopedCacheKey(messageId);

  return async function processChunks() {
    if (notFoundCount >= MAX_NOT_FOUND_COUNT) {
      return `Message not found after ${MAX_NOT_FOUND_COUNT} attempts`;
    }

    if (noChangeCount >= MAX_NO_CHANGE_COUNT) {
      return `No change in message after ${MAX_NO_CHANGE_COUNT} attempts`;
    }

    const message: CachedSpeech | TMessage | null =
      (await cache.get(cacheKey)) || (await getMessage({ user, messageId }));

    if (!message) {
      notFoundCount++;
      return [];
    }

    const text = typeof message === 'string' ? message : getSpeechText(message);
    cache.set(cacheKey, { text, complete: true }, Time.FIVE_MINUTES);
    const complete =
      typeof message !== 'string' && (!('complete' in message) || message.complete !== false);

    if (text === processedText) {
      noChangeCount++;
    }

    const remainingText = text.slice(processedText.length);
    const chunks: SpeechChunk[] = [];

    if (!complete && remainingText.length >= 20) {
      const separatorIndex = findLastSeparatorIndex(remainingText);
      if (separatorIndex !== -1) {
        const chunkText = remainingText.slice(0, separatorIndex + 1);
        chunks.push({ text: chunkText, isFinished: false });
        processedText += chunkText;
      } else {
        chunks.push({ text: remainingText, isFinished: false });
        processedText = text;
      }
    } else if (complete && remainingText.trim().length > 0) {
      chunks.push({ text: remainingText.trim(), isFinished: true });
      processedText = text;
    }

    return chunks;
  };
}
