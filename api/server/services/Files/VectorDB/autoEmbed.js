const { logger } = require('@librechat/data-schemas');
const { uploadVectors } = require('./crud');

const TEXT_BEARING_MIME_RE =
  /^(application\/(pdf|json|xml|x-sh|x-tar|typescript|sql|yaml|epub\+zip|vnd\.coffeescript|msword|vnd\.ms-(word|powerpoint|excel)|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet))|text\/[\w.+-]+)$/;

const EXCLUDED_PREFIXES = ['image/', 'audio/', 'video/'];

/**
 * Whether a MIME type should be auto-embedded via rag-api for chat attachments.
 * Excludes images (go to Vision), audio (go to STT), and video.
 *
 * @param {string | undefined | null} mimetype
 * @returns {boolean}
 */
function isTextBearingMimeType(mimetype) {
  if (!mimetype || typeof mimetype !== 'string') {
    return false;
  }
  if (EXCLUDED_PREFIXES.some((prefix) => mimetype.startsWith(prefix))) {
    return false;
  }
  return TEXT_BEARING_MIME_RE.test(mimetype);
}

/**
 * Wrap uploadVectors with graceful degradation: never throws, returns { embedded: false }
 * on any failure. Intended for auto-RAG of chat-input paperclip attachments where a
 * failed embed must still allow the upload to succeed (user sees the attachment, just
 * without indexed-retrieval superpowers).
 *
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {Express.Multer.File} params.file
 * @param {string} params.file_id
 * @param {string} [params.entity_id]
 * @returns {Promise<{ embedded: boolean }>}
 */
async function tryEmbedChatAttachment({ req, file, file_id, entity_id }) {
  if (!process.env.RAG_API_URL) {
    return { embedded: false };
  }

  try {
    const result = await uploadVectors({ req, file, file_id, entity_id });
    return { embedded: Boolean(result?.embedded) };
  } catch (error) {
    logger.warn(
      `[tryEmbedChatAttachment] rag-api embed failed for file_id=${file_id}, falling back to inline attachment: ${error?.message || error}`,
    );
    return { embedded: false };
  }
}

module.exports = {
  isTextBearingMimeType,
  tryEmbedChatAttachment,
};
