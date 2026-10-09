const { createSpeechChunkProcessor } = require('@librechat/api');
const { CacheKeys, SEPARATORS, findLastSeparatorIndex } = require('librechat-data-provider');
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

/**
 * @param {string} user
 * @param {string} messageId
 * @returns {() => Promise<{ text: string, isFinished: boolean }[] | string>}
 */
function createChunkProcessor(user, messageId) {
  return createSpeechChunkProcessor({
    user,
    messageId,
    cache: getLogStores(CacheKeys.MESSAGES),
    getMessage,
  });
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
