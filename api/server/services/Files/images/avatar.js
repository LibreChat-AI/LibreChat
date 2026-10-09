const sharp = require('sharp');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const { EImageOutputType } = require('librechat-data-provider');
const { createSSRFSafeAgents } = require('@librechat/api');
const { resizeAndConvert } = require('./resize');

const ALLOWED_AVATAR_PROTOCOLS = new Set(['http:', 'https:']);
/**
 * Cap response size to bound memory exposure if a malicious or compromised
 * `picture` URL serves a multi-GB payload. Avatars are at most a few hundred
 * KB in practice; 10 MB is well past any legitimate use.
 */
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/**
 * Fetches an image URL with SSRF protection: rejects non-http(s) schemes,
 * blocks resolution to private/loopback/link-local IPs at TCP connect time,
 * refuses to follow redirects to prevent post-validation rebinding, and caps
 * the response body so a hostile payload cannot exhaust memory before
 * `sharp()` rejects it.
 *
 * Per-call agent construction is intentional: avatar fetches are infrequent
 * (once per social login per user) and pooling adds complexity without a
 * measurable benefit on this path. If this ever becomes a hot path, hoist
 * the agents to module scope.
 */
async function fetchAvatarBuffer(input, fetchOptions = {}) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Invalid avatar URL');
  }
  if (!ALLOWED_AVATAR_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Refusing to fetch avatar over ${parsed.protocol}`);
  }

  const { httpAgent, httpsAgent } = createSSRFSafeAgents();
  /**
   * `node-fetch` v2's `timeout` is the total request budget (request initiation
   * through full body receipt), not a TCP-connect-only timeout. That is the
   * stronger of the two for this path — bounds total slow-loris exposure.
   */
  const response = await fetch(parsed.href, {
    headers: fetchOptions.headers,
    agent: (urlObj) => (urlObj.protocol === 'https:' ? httpsAgent : httpAgent),
    redirect: 'error',
    timeout: 5000,
    size: MAX_AVATAR_BYTES,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image from URL. Status: ${response.status}`);
  }

  const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_AVATAR_BYTES) {
    throw new Error(`Avatar response too large: ${contentLength} bytes`);
  }

  /**
   * Re-check after read in case the server lied about Content-Length or
   * omitted it. `node-fetch` v2 honors the `size` option above and throws on
   * overflow, but Defense-in-depth: assert on the actual buffer length.
   */
  const buffer = await response.buffer();
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new Error(`Avatar response too large: ${buffer.length} bytes`);
  }
  return buffer;
}

/**
 * Uploads an avatar image for a user. This function can handle various types of input (URL, Buffer, or File object),
 * processes the image to a square format, converts it to target format, and returns the resized buffer.
 *
 * @param {Object} params - The parameters object.
 * @param {string} params.userId - The unique identifier of the user for whom the avatar is being uploaded.
 * @param {string} options.desiredFormat - The desired output format of the image.
 * @param {(string|Buffer|File)} params.input - The input representing the avatar image. Can be a URL (string),
 *                                               a Buffer, or a File object.
 * @param {{ headers?: Record<string, string> }} [params.fetchOptions] - Optional headers for trusted avatar URLs.
 *
 * @returns {Promise<any>}
 *          A promise that resolves to a resized buffer.
 *
 * @throws {Error} Throws an error if the user ID is undefined, the input type is invalid, the image fetching fails,
 *                 or any other error occurs during the processing.
 */
async function resizeAvatar({ userId, input, desiredFormat = EImageOutputType.PNG, fetchOptions }) {
  try {
    if (userId === undefined) {
      throw new Error('User ID is undefined');
    }

    let imageBuffer;
    if (typeof input === 'string') {
      imageBuffer = await fetchAvatarBuffer(input, fetchOptions);
    } else if (input instanceof Buffer) {
      imageBuffer = input;
    } else if (typeof input === 'object' && input instanceof File) {
      const fileContent = await fs.readFile(input.path);
      imageBuffer = Buffer.from(fileContent);
    } else {
      throw new Error('Invalid input type. Expected URL, Buffer, or File.');
    }

    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;
    const minSize = Math.min(width, height);

    if (metadata.format === 'gif') {
      const resizedBuffer = await sharp(imageBuffer, { animated: true })
        .extract({
          left: Math.floor((width - minSize) / 2),
          top: Math.floor((height - minSize) / 2),
          width: minSize,
          height: minSize,
        })
        .resize(250, 250)
        .gif()
        .toBuffer();

      return resizedBuffer;
    }

    const squaredBuffer = await sharp(imageBuffer)
      .extract({
        left: Math.floor((width - minSize) / 2),
        top: Math.floor((height - minSize) / 2),
        width: minSize,
        height: minSize,
      })
      .toBuffer();

    const { buffer } = await resizeAndConvert({
      inputBuffer: squaredBuffer,
      desiredFormat,
    });
    return buffer;
  } catch (error) {
    logger.error('Error uploading the avatar:', error);
    throw error;
  }
}

module.exports = { resizeAvatar };
