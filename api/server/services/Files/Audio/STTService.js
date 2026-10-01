const axios = require('axios');
const fs = require('fs').promises;
const FormData = require('form-data');
const { Readable } = require('stream');
const { logger } = require('@librechat/data-schemas');
const {
  inspectContent,
  extractFileContent,
  hasActiveFileFieldPolicy,
  genAzureEndpoint,
  getSafeErrorMetadata,
  applyAxiosProxyConfig,
  resolveConfigSecret,
  applySSRFSafeAgentIfDirect,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedUninspectableFileField,
} = require('@librechat/api');
const {
  STTProviders,
  extractEnvVariable,
  listConfiguredSpeechProviders,
} = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');

/**
 * Maps MIME types to their corresponding file extensions for audio files.
 * @type {Object}
 */
const MIME_TO_EXTENSION_MAP = {
  // MP4 container formats
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  // Ogg formats
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'application/ogg': 'ogg',
  // Wave formats
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  // MP3 formats
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mpeg3': 'mp3',
  // WebM formats
  'audio/webm': 'webm',
  // Additional formats
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/**
 * Validates and extracts ISO-639-1 language code from a locale string.
 * @param {string} language - The language/locale string (e.g., "en-US", "en", "zh-CN")
 * @returns {string|null} The ISO-639-1 language code (e.g., "en") or null if invalid
 */
function getValidatedLanguageCode(language) {
  try {
    if (!language) {
      return null;
    }

    const normalizedLanguage = language.toLowerCase();
    const isValidLocaleCode = /^[a-z]{2}(-[a-z]{2})?$/.test(normalizedLanguage);

    if (isValidLocaleCode) {
      return normalizedLanguage.split('-')[0];
    }

    logger.warn(
      '[STT] Invalid language format. Expected ISO-639-1 locale code like "en-US" or "en". Skipping language parameter.',
    );
    return null;
  } catch (error) {
    logger.error('[STT] Error validating language code:', getSafeErrorMetadata(error));
    return null;
  }
}

/**
 * Gets the file extension from the MIME type.
 * @param {string} mimeType - The MIME type.
 * @returns {string} The file extension.
 */
function getFileExtensionFromMime(mimeType) {
  // Default fallback
  if (!mimeType) {
    return 'webm';
  }

  // Direct lookup (fastest)
  const extension = MIME_TO_EXTENSION_MAP[mimeType];
  if (extension) {
    return extension;
  }

  // Try to extract subtype as fallback
  const subtype = mimeType.split('/')[1]?.toLowerCase();

  // If subtype matches a known extension
  if (['mp3', 'mp4', 'ogg', 'wav', 'webm', 'm4a', 'flac'].includes(subtype)) {
    return subtype === 'mp4' ? 'm4a' : subtype;
  }

  // Generic checks for partial matches
  if (subtype?.includes('mp4') || subtype?.includes('m4a')) {
    return 'm4a';
  }
  if (subtype?.includes('ogg')) {
    return 'ogg';
  }
  if (subtype?.includes('wav')) {
    return 'wav';
  }
  if (subtype?.includes('mp3') || subtype?.includes('mpeg')) {
    return 'mp3';
  }
  if (subtype?.includes('webm')) {
    return 'webm';
  }

  return 'webm'; // Default fallback
}

/**
 * Service class for handling Speech-to-Text (STT) operations.
 * @class
 */
class STTService {
  constructor() {
    this.providerStrategies = {
      [STTProviders.OPENAI]: this.openAIProvider,
      [STTProviders.AZURE_OPENAI]: this.azureOpenAIProvider,
    };
  }

  /**
   * Creates a singleton instance of STTService.
   * @static
   * @async
   * @returns {Promise<STTService>} The STTService instance.
   * @throws {Error} If the custom config is not found.
   */
  static async getInstance() {
    return new STTService();
  }

  /**
   * Retrieves the configured STT provider and its schema.
   * @param {ServerRequest} req - The request object.
   * @returns {Promise<[string, Object, (string[]|undefined)]>} A promise that resolves to the provider name, its schema, and the section-level allowedAddresses exemption list.
   * @throws {Error} If no STT schema is set, multiple providers are set, or no provider is set.
   */
  async getProviderSchema(req) {
    const appConfig =
      req.config ??
      (await getAppConfig({
        role: req?.user?.role,
        userId: req?.user?.id,
        tenantId: req?.user?.tenantId,
      }));
    const sttSchema = appConfig?.speech?.stt;
    if (!sttSchema) {
      throw new Error(
        'No STT schema is set. Did you configure STT in the custom config (librechat.yaml)?',
      );
    }

    const providers = listConfiguredSpeechProviders(sttSchema);

    if (providers.length !== 1) {
      throw new Error(
        providers.length > 1
          ? 'Multiple providers are set. Please set only one provider.'
          : 'No provider is set. Please set a provider.',
      );
    }

    const [provider, schema] = providers[0];
    return [provider, schema, sttSchema.allowedAddresses];
  }

  /**
   * Recursively removes undefined properties from an object.
   * @param {Object} obj - The object to clean.
   * @returns {void}
   */
  removeUndefined(obj) {
    Object.keys(obj).forEach((key) => {
      if (obj[key] && typeof obj[key] === 'object') {
        this.removeUndefined(obj[key]);
        if (Object.keys(obj[key]).length === 0) {
          delete obj[key];
        }
      } else if (obj[key] === undefined) {
        delete obj[key];
      }
    });
  }

  /**
   * Prepares the request for the OpenAI STT provider.
   * @param {Object} sttSchema - The STT schema for OpenAI.
   * @param {Stream} audioReadStream - The audio data to be transcribed.
   * @param {Object} audioFile - The audio file object (unused in OpenAI provider).
   * @param {string} language - The language code for the transcription.
   * @returns {Array} An array containing the URL, data, and headers for the request.
   */
  openAIProvider(sttSchema, audioReadStream, audioFile, language) {
    const url = sttSchema?.url || 'https://api.openai.com/v1/audio/transcriptions';
    const apiKey = resolveConfigSecret(sttSchema.apiKey) || '';

    const data = {
      file: audioReadStream,
      model: sttSchema.model,
    };

    const validLanguage = getValidatedLanguageCode(language);
    if (validLanguage) {
      data.language = validLanguage;
    }

    const headers = {
      'Content-Type': 'multipart/form-data',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    };
    [headers].forEach(this.removeUndefined);

    return [url, data, headers];
  }

  /**
   * Prepares the request for the Azure OpenAI STT provider.
   * @param {Object} sttSchema - The STT schema for Azure OpenAI.
   * @param {Buffer} audioBuffer - The audio data to be transcribed.
   * @param {Object} audioFile - The audio file object containing originalname, mimetype, and size.
   * @param {string} language - The language code for the transcription.
   * @returns {Array} An array containing the URL, data, and headers for the request.
   * @throws {Error} If the audio file size exceeds 25MB or the audio file format is not accepted.
   */
  azureOpenAIProvider(sttSchema, audioBuffer, audioFile, language) {
    const url = `${genAzureEndpoint({
      azureOpenAIApiInstanceName: extractEnvVariable(sttSchema?.instanceName),
      azureOpenAIApiDeploymentName: extractEnvVariable(sttSchema?.deploymentName),
    })}/audio/transcriptions?api-version=${extractEnvVariable(sttSchema?.apiVersion)}`;

    const apiKey = sttSchema.apiKey ? resolveConfigSecret(sttSchema.apiKey) || '' : '';

    if (audioBuffer.byteLength > 25 * 1024 * 1024) {
      throw new Error('The audio file size exceeds the limit of 25MB');
    }

    const acceptedFormats = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'];
    const [mimePrefix, rawFormat = ''] = audioFile.mimetype.split('/');
    const isAudioMime = mimePrefix === 'audio' || mimePrefix === 'video';
    const isKnownMime = audioFile.mimetype in MIME_TO_EXTENSION_MAP;
    const normalizedFormat = isKnownMime ? MIME_TO_EXTENSION_MAP[audioFile.mimetype] : null;
    if (
      !acceptedFormats.includes(normalizedFormat) &&
      !(isAudioMime && acceptedFormats.includes(rawFormat))
    ) {
      throw new Error(`The audio file format ${rawFormat} is not accepted`);
    }

    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: audioFile.originalname,
      contentType: audioFile.mimetype,
    });

    const validLanguage = getValidatedLanguageCode(language);
    if (validLanguage) {
      formData.append('language', validLanguage);
    }

    const headers = {
      ...(apiKey && { 'api-key': apiKey }),
    };

    [headers].forEach(this.removeUndefined);

    return [url, formData, { ...headers, ...formData.getHeaders() }];
  }

  /**
   * Sends an STT request to the specified provider.
   * @async
   * @param {string} provider - The STT provider to use.
   * @param {Object} sttSchema - The STT schema for the provider.
   * @param {Object} requestData - The data required for the STT request.
   * @param {Buffer} requestData.audioBuffer - The audio data to be transcribed.
   * @param {Object} requestData.audioFile - The audio file object containing originalname, mimetype, and size.
   * @param {string} requestData.language - The language code for the transcription.
   * @param {string[]} [allowedAddresses] - Section-level SSRF exemption list of host:port pairs.
   * @returns {Promise<string>} A promise that resolves to the transcribed text.
   * @throws {Error} If the provider is invalid, the response status is not 200, or the response data is missing.
   */
  async sttRequest(provider, sttSchema, { audioBuffer, audioFile, language }, allowedAddresses) {
    const strategy = this.providerStrategies[provider];
    if (!strategy) {
      throw new Error('Invalid provider');
    }

    const fileExtension = getFileExtensionFromMime(audioFile.mimetype);

    const audioReadStream = Readable.from(audioBuffer);
    audioReadStream.path = `audio.${fileExtension}`;

    const [url, data, headers] = strategy.call(
      this,
      sttSchema,
      audioReadStream,
      audioFile,
      language,
    );

    const options = { headers };

    applyAxiosProxyConfig(options, url);
    applySSRFSafeAgentIfDirect(options, url, allowedAddresses);

    try {
      const response = await axios.post(url, data, options);

      if (response.status !== 200) {
        throw new Error('Invalid response from the STT API');
      }

      if (!response.data || !response.data.text) {
        throw new Error('Missing data in response from the STT API');
      }

      return response.data.text.trim();
    } catch (error) {
      logger.error(`[STT] Request failed for provider ${provider}:`, getSafeErrorMetadata(error));
      throw error;
    }
  }

  /**
   * Processes a speech-to-text request.
   * @async
   * @param {Object} req - The request object.
   * @param {Object} res - The response object.
   * @returns {Promise<void>}
   */
  async processSpeechToText(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'No audio file provided in the FormData' });
    }

    try {
      if (hasActiveFileFieldPolicy(req.config?.filters, ['name', 'content', 'transcript'])) {
        const finding = inspectContent(extractFileContent({ name: req.file.originalname }), {
          filters: req.config.filters,
        });
        if (finding != null) {
          res.status(400).json(contentFilterBlockResponse(finding));
          return;
        }
        const uninspectableField = getBlockedUninspectableFileField(req.config.filters, [
          'content',
        ]);
        if (uninspectableField != null) {
          res.status(400).json(contentFilterUninspectableResponse(uninspectableField));
          return;
        }
      }

      let text;
      try {
        const audioBuffer = await fs.readFile(req.file.path);
        const audioFile = {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        };
        const [provider, sttSchema, allowedAddresses] = await this.getProviderSchema(req);
        const language = req.body?.language || '';
        text = await this.sttRequest(
          provider,
          sttSchema,
          { audioBuffer, audioFile, language },
          allowedAddresses,
        );
      } catch (error) {
        const uninspectableField = getBlockedUninspectableFileField(req.config?.filters, [
          'transcript',
        ]);
        if (uninspectableField != null) {
          res.status(400).json(contentFilterUninspectableResponse(uninspectableField));
          return;
        }
        throw error;
      }
      if (
        (typeof text !== 'string' || text.trim().length === 0) &&
        getBlockedUninspectableFileField(req.config?.filters, ['transcript']) != null
      ) {
        res.status(400).json(contentFilterUninspectableResponse('transcript'));
        return;
      }
      if (hasActiveFileFieldPolicy(req.config?.filters, ['transcript'])) {
        const finding = inspectContent(extractFileContent({ transcript: text }), {
          filters: req.config.filters,
        });
        if (finding != null) {
          res.status(400).json(contentFilterBlockResponse(finding));
          return;
        }
      }
      res.json({ text });
    } catch (error) {
      logger.error(
        '[STT] An error occurred while processing the audio:',
        getSafeErrorMetadata(error),
      );
      res.sendStatus(500);
    } finally {
      try {
        await fs.unlink(req.file.path);
        logger.debug('[/speech/stt] Temp. audio upload file deleted');
      } catch {
        logger.debug('[/speech/stt] Temp. audio upload file already deleted');
      }
    }
  }
}

/**
 * Factory function to create an STTService instance.
 * @async
 * @returns {Promise<STTService>} A promise that resolves to an STTService instance.
 */
async function createSTTService() {
  return STTService.getInstance();
}

/**
 * Wrapper function for speech-to-text processing.
 * @async
 * @param {Object} req - The request object.
 * @param {Object} res - The response object.
 * @returns {Promise<void>}
 */
async function speechToText(req, res) {
  const sttService = await createSTTService();
  await sttService.processSpeechToText(req, res);
}

module.exports = { STTService, speechToText, getFileExtensionFromMime, MIME_TO_EXTENSION_MAP };
