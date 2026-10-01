const { scopedCacheKey } = require('@librechat/data-schemas');
const {
  Time,
  CacheKeys,
  SEPARATORS,
  parseTextParts,
  findLastSeparatorIndex,
} = require('librechat-data-provider');
const { getLogStores } = require('~/cache');
const { getMessage } = require('~/models');

/**
 * @param {string[]} voiceIds - Array of voice IDs
 * @returns {string}
 */
function getRandomVoiceId(voiceIds) {
  const randomIndex = Math.floor(Math.random() * voiceIds.length);
  return voiceIds[randomIndex];
}

/**
 * @typedef {Object} VoiceSettings
 * @property {number} similarity_boost
 * @property {number} stability
 * @property {boolean} use_speaker_boost
 */

/**
 * @typedef {Object} GenerateAudioBulk
 * @property {string} model_id
 * @property {string} text
 * @property {VoiceSettings} voice_settings
 */

/**
 * @typedef {Object} TextToSpeechClient
 * @property {function(Object): Promise<stream.Readable>} generate
 */

/**
 * @typedef {Object} AudioChunk
 * @property {string} audio
 * @property {boolean} isFinal
 * @property {Object} alignment
 * @property {number[]} alignment.char_start_times_ms
 * @property {number[]} alignment.chars_durations_ms
 * @property {string[]} alignment.chars
 * @property {Object} normalizedAlignment
 * @property {number[]} normalizedAlignment.char_start_times_ms
 * @property {number[]} normalizedAlignment.chars_durations_ms
 * @property {string[]} normalizedAlignment.chars
 */

const MAX_NOT_FOUND_COUNT = 6;
const MAX_NO_CHANGE_COUNT = 10;

/**
 * @param {string} user
 * @param {string} messageId
 * @returns {() => Promise<{ text: string, isFinished: boolean }[]>}
 */
function createChunkProcessor(user, messageId) {
  let notFoundCount = 0;
  let noChangeCount = 0;
  let processedText = '';
  if (!messageId) {
    throw new Error('Message ID is required');
  }

  const messageCache = getLogStores(CacheKeys.MESSAGES);
  // Captured at creation time — must be called within an active request ALS scope
  const cacheKey = scopedCacheKey(messageId);

  /**
   * @returns {Promise<{ text: string, isFinished: boolean }[] | string>}
   */
  async function processChunks() {
    if (notFoundCount >= MAX_NOT_FOUND_COUNT) {
      return `Message not found after ${MAX_NOT_FOUND_COUNT} attempts`;
    }

    if (noChangeCount >= MAX_NO_CHANGE_COUNT) {
      return `No change in message after ${MAX_NO_CHANGE_COUNT} attempts`;
    }

    /** @type { string | { text: string; complete: boolean } } */
    let message = await messageCache.get(cacheKey);
    if (!message) {
      message = await getMessage({ user, messageId });
    }

    if (!message) {
      notFoundCount++;
      return [];
    } else {
      const text = message.content?.length > 0 ? parseTextParts(message.content, true) : message.text;
      messageCache.set(
        cacheKey,
        {
          text,
          complete: true,
        },
        Time.FIVE_MINUTES,
      );
    }

    const text = typeof message === 'string' ? message : message.text;
    const complete = typeof message === 'string' ? false : (message.complete ?? true);

    if (text === processedText) {
      noChangeCount++;
    }

    const remainingText = text.slice(processedText.length);
    const chunks = [];

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
  }

  return processChunks;
}

/**
 * @param {string} text
 * @param {number} [chunkSize=4000]
 * @returns {{ text: string, isFinished: boolean }[]}
 */
function splitTextIntoChunks(text, chunkSize = 4000) {
  if (!text) {
    throw new Error('Text is required');
  }

  const chunks = [];
  let startIndex = 0;
  const textLength = text.length;

  while (startIndex < textLength) {
    let endIndex = Math.min(startIndex + chunkSize, textLength);
    let chunkText = text.slice(startIndex, endIndex);

    if (endIndex < textLength) {
      let lastSeparatorIndex = -1;
      for (const separator of SEPARATORS) {
        const index = chunkText.lastIndexOf(separator);
        if (index !== -1) {
          lastSeparatorIndex = Math.max(lastSeparatorIndex, index);
        }
      }

      if (lastSeparatorIndex !== -1) {
        endIndex = startIndex + lastSeparatorIndex + 1;
        chunkText = text.slice(startIndex, endIndex);
      } else {
        const nextSeparatorIndex = text.slice(endIndex).search(/\S/);
        if (nextSeparatorIndex !== -1) {
          endIndex += nextSeparatorIndex;
          chunkText = text.slice(startIndex, endIndex);
        }
      }
    }

    chunkText = chunkText.trim();
    if (chunkText) {
      chunks.push({
        text: chunkText,
        isFinished: endIndex >= textLength,
      });
    } else if (chunks.length > 0) {
      chunks[chunks.length - 1].isFinished = true;
    }

    startIndex = endIndex;
    while (startIndex < textLength && text[startIndex].trim() === '') {
      startIndex++;
    }
  }

  return chunks;
}

/**
 *
 * @param {AsyncIterable<string>} llmStream
 */
async function* llmMessageSource(llmStream) {
  for await (const chunk of llmStream) {
    const message = chunk.choices[0].delta.content;
    if (message) {
      yield message;
    }
  }
}

module.exports = {
  findLastSeparatorIndex,
  createChunkProcessor,
  splitTextIntoChunks,
  llmMessageSource,
  getRandomVoiceId,
};
