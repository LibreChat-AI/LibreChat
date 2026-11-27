import { setTimeout as delay } from 'node:timers/promises';
import { logger, scopedCacheKey } from '@librechat/data-schemas';
import { Time, getSpeechText, findLastSeparatorIndex } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { Readable } from 'node:stream';
import type { Response } from 'express';
import { logAxiosError, pipeSegment } from '~/utils';

const MAX_NOT_FOUND_COUNT = 6;
const MAX_NO_CHANGE_COUNT = 10;
/** How long automatic playback waits before reading a message with no new text again. */
const POLL_INTERVAL_MS = 1250;

export type SpeechChunk = { text: string; isFinished: boolean };

type CachedSpeech = string | { text: string; complete?: boolean };

export interface SpeechMessageCache {
  get(key: string): Promise<CachedSpeech | null | undefined>;
  set(key: string, value: CachedSpeech, ttl?: number): unknown;
}

/** Default cap on the text one text-to-speech request may synthesize. */
export const DEFAULT_TTS_MAX_INPUT_CHARS = 20_000;

/** Lengths only: the text itself may be private. */
function warnSpeechCapped(length: number, maxInputChars: number): void {
  logger.warn(
    `[TTS] Text of ${length} characters exceeds speech.tts.maxInputChars (${maxInputChars}); reading the first ${maxInputChars}`,
  );
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
  maxInputChars = DEFAULT_TTS_MAX_INPUT_CHARS,
}: {
  user: string;
  messageId?: string;
  cache: SpeechMessageCache;
  getMessage: (filter: { user: string; messageId: string }) => Promise<TMessage | null>;
  /** Speech stops here: text past the cap is never sent to the provider. */
  maxInputChars?: number;
}): () => Promise<SpeechChunk[] | string> {
  if (!messageId) {
    throw new Error('Message ID is required');
  }

  let notFoundCount = 0;
  let noChangeCount = 0;
  let processedText = '';
  let warnedCap = false;
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

    const fullText = typeof message === 'string' ? message : getSpeechText(message);
    cache.set(cacheKey, { text: fullText, complete: true }, Time.FIVE_MINUTES);
    /** A message longer than the cap is read up to the cap, as if it ended there. */
    const capped = fullText.length >= maxInputChars;
    const text = capped ? fullText.slice(0, maxInputChars) : fullText;
    if (fullText.length > maxInputChars && !warnedCap) {
      warnedCap = true;
      warnSpeechCapped(fullText.length, maxInputChars);
    }
    const complete =
      capped ||
      (typeof message !== 'string' && (!('complete' in message) || message.complete !== false));

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

/**
 * Speaks a message while it is written: reads its finished text with `poll`, synthesizes each
 * chunk and writes the audio into `res` until the last chunk is spoken. Once `signal` aborts (the
 * client left), the message is not read again and no provider request is made for it.
 */
export async function streamSpeech({
  res,
  poll,
  signal,
  synthesize,
}: {
  res: Response;
  /** The chunk processor from `createSpeechChunkProcessor`. */
  poll: () => Promise<SpeechChunk[] | string>;
  /** Aborts when the client leaves, as the one from `abortOnClose(res)` does. */
  signal: AbortSignal;
  /** One provider request for `text`, resolving to its audio. */
  synthesize: (text: string) => Promise<Readable>;
}): Promise<void> {
  try {
    while (!signal.aborted) {
      const chunks = await poll();
      if (typeof chunks === 'string') {
        logger.error(`Error processing audio stream updates: ${chunks}`);
        res.status(500).end();
        return;
      }

      if (chunks.length === 0) {
        try {
          await delay(POLL_INTERVAL_MS, undefined, { signal });
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          throw error;
        }
        continue;
      }

      for (const chunk of chunks) {
        /** The client can leave while the message is read or a segment is written. */
        if (signal.aborted) {
          return;
        }
        try {
          const audio = await synthesize(chunk.text);
          await pipeSegment(audio, res, { end: chunk.isFinished });
        } catch (error) {
          logAxiosError({
            message: `[TTS] Error processing an audio stream update of ${chunk.text.length} characters:`,
            error,
          });
          if (!res.headersSent) {
            res.status(500).end();
          }
          return;
        }
        if (chunk.isFinished) {
          return;
        }
      }
    }
  } catch (error) {
    logAxiosError({ message: '[TTS] Failed to fetch audio:', error });
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
}

/**
 * The part of `input` one text-to-speech request may synthesize: the text up to the cap, so
 * one request cannot fan out into an unbounded number of paid provider calls. Longer text is
 * read up to the cap, the same as automatic playback of a long message.
 */
export function capSpeechInput(input: unknown, ttsConfig?: { maxInputChars?: number }): string {
  /** A request body can carry any JSON; only text is spoken, so the cap always counts characters. */
  if (typeof input !== 'string') {
    return '';
  }
  const maxInputChars = ttsConfig?.maxInputChars ?? DEFAULT_TTS_MAX_INPUT_CHARS;
  if (input.length <= maxInputChars) {
    return input;
  }
  warnSpeechCapped(input.length, maxInputChars);
  return input.slice(0, maxInputChars);
}
