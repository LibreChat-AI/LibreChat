// Mock all external dependencies so we can test getFileExtensionFromMime in isolation
jest.mock('axios');
jest.mock('form-data');
jest.mock('https-proxy-agent');
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  inspectContent: jest.fn(),
  extractFileContent: jest.fn((input) => [input]),
  hasActiveFileFieldPolicy: jest.fn((filters, candidates) => {
    const pii = filters?.files?.pii;
    if (pii == null) {
      return false;
    }
    const fieldSelected = candidates.some(
      (field) => pii.fields == null || pii.fields.includes(field),
    );
    const hasPatterns =
      pii.starterPatterns == null ||
      pii.starterPatterns.length > 0 ||
      (pii.customPatterns?.length ?? 0) > 0;
    const failClosed =
      pii.uninspectable === 'block' &&
      candidates.some(
        (field) =>
          ['content', 'extracted_text', 'transcript'].includes(field) &&
          (pii.fields == null || pii.fields.includes(field)),
      );
    return (hasPatterns && fieldSelected) || failClosed;
  }),
  genAzureEndpoint: jest.fn(),
  getSafeErrorMetadata: jest.fn((error) => ({
    type: error instanceof Error ? 'Error' : 'UnknownError',
    ...(Number.isInteger(error?.response?.status) && { status: error.response.status }),
  })),
  applyAxiosProxyConfig: jest.fn(),
  resolveConfigSecret: jest.fn((value) => value),
  applySSRFSafeAgentIfDirect: jest.fn(),
  contentFilterBlockResponse: jest.fn((finding) => ({
    error: 'content_filter_block',
    message: 'Submitted content contains a protected value. Remove it and try again.',
    source: finding.source,
    field: finding.field,
  })),
  getBlockedUninspectableFileField: jest.fn(),
  contentFilterUninspectableResponse: jest.fn((field) => ({
    error: 'content_filter_uninspectable',
    source: 'file',
    field,
  })),
}));
jest.mock('librechat-data-provider', () => ({
  extractEnvVariable: jest.fn(),
  /* Real selection logic: these tests are about which provider a schema resolves to. */
  listConfiguredSpeechProviders:
    jest.requireActual('librechat-data-provider').listConfiguredSpeechProviders,
  STTProviders: {},
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const fs = require('fs').promises;
const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const {
  inspectContent,
  extractFileContent,
  getSafeErrorMetadata,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedUninspectableFileField,
} = require('@librechat/api');
const { STTService, getFileExtensionFromMime, MIME_TO_EXTENSION_MAP } = require('./STTService');

describe('getFileExtensionFromMime', () => {
  it('should normalize audio/x-m4a to m4a', () => {
    expect(getFileExtensionFromMime('audio/x-m4a')).toBe('m4a');
  });

  it('should normalize audio/mp4 to m4a', () => {
    expect(getFileExtensionFromMime('audio/mp4')).toBe('m4a');
  });

  it('should normalize audio/x-wav to wav', () => {
    expect(getFileExtensionFromMime('audio/x-wav')).toBe('wav');
  });

  it('should normalize audio/x-flac to flac', () => {
    expect(getFileExtensionFromMime('audio/x-flac')).toBe('flac');
  });

  it('should normalize audio/mpeg to mp3', () => {
    expect(getFileExtensionFromMime('audio/mpeg')).toBe('mp3');
  });

  it('should return webm for audio/webm', () => {
    expect(getFileExtensionFromMime('audio/webm')).toBe('webm');
  });

  it('should return ogg for audio/ogg', () => {
    expect(getFileExtensionFromMime('audio/ogg')).toBe('ogg');
  });

  it('should fall back to webm for unknown MIME types', () => {
    expect(getFileExtensionFromMime('audio/somethingelse')).toBe('webm');
  });

  it('should return webm for null/undefined input', () => {
    expect(getFileExtensionFromMime(null)).toBe('webm');
    expect(getFileExtensionFromMime(undefined)).toBe('webm');
  });
});

describe('STTService.getProviderSchema provider detection', () => {
  const service = new STTService();

  const buildReq = (stt) => ({ config: { speech: { stt } } });

  it('resolves exactly one provider when allowedAddresses is set alongside it', async () => {
    const req = buildReq({
      allowedAddresses: ['127.0.0.1:8080'],
      openai: { url: 'http://127.0.0.1:8080', apiKey: 'sk', model: 'whisper-1' },
    });
    const [provider, schema] = await service.getProviderSchema(req);
    expect(provider).toBe('openai');
    expect(schema.url).toBe('http://127.0.0.1:8080');
  });

  it('reports "No provider is set" when only allowedAddresses is present', async () => {
    const req = buildReq({ allowedAddresses: ['127.0.0.1:8080'] });
    await expect(service.getProviderSchema(req)).rejects.toThrow('No provider is set');
  });

  it('reports "Multiple providers" when two providers are set even with allowedAddresses', async () => {
    const req = buildReq({
      allowedAddresses: ['127.0.0.1:8080'],
      openai: { url: 'http://127.0.0.1:8080', apiKey: 'sk', model: 'whisper-1' },
      azureOpenAI: {
        instanceName: 'inst',
        apiKey: 'sk',
        deploymentName: 'dep',
        apiVersion: '2024',
      },
    });
    await expect(service.getProviderSchema(req)).rejects.toThrow('Multiple providers are set');
  });
});

describe('STT audio format validation with MIME normalization', () => {
  const acceptedFormats = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'];

  /**
   * Mirrors the format validation logic in azureOpenAIProvider.
   * Only uses MIME_TO_EXTENSION_MAP for normalization so unknown audio
   * subtypes are not silently accepted via the webm default fallback.
   * Raw subtype matching is gated on audio/video prefix to prevent
   * non-audio types like text/webm from passing.
   */
  function isFormatAccepted(mimetype) {
    const [mimePrefix, rawFormat = ''] = mimetype.split('/');
    const isAudioMime = mimePrefix === 'audio' || mimePrefix === 'video';
    const isKnownMime = mimetype in MIME_TO_EXTENSION_MAP;
    const normalizedFormat = isKnownMime ? MIME_TO_EXTENSION_MAP[mimetype] : null;
    return (
      acceptedFormats.includes(normalizedFormat) ||
      (isAudioMime && acceptedFormats.includes(rawFormat))
    );
  }

  it('should accept audio/x-m4a (browser MIME for .m4a files)', () => {
    expect(isFormatAccepted('audio/x-m4a')).toBe(true);
  });

  it('should accept audio/x-wav', () => {
    expect(isFormatAccepted('audio/x-wav')).toBe(true);
  });

  it('should accept audio/x-flac', () => {
    expect(isFormatAccepted('audio/x-flac')).toBe(true);
  });

  it('should accept standard formats directly', () => {
    expect(isFormatAccepted('audio/mpeg')).toBe(true);
    expect(isFormatAccepted('audio/wav')).toBe(true);
    expect(isFormatAccepted('audio/ogg')).toBe(true);
    expect(isFormatAccepted('audio/webm')).toBe(true);
    expect(isFormatAccepted('audio/flac')).toBe(true);
    expect(isFormatAccepted('audio/mp3')).toBe(true);
    expect(isFormatAccepted('audio/mp4')).toBe(true);
    expect(isFormatAccepted('audio/mpga')).toBe(true);
  });

  it('should reject unknown audio subtypes', () => {
    expect(isFormatAccepted('audio/aac')).toBe(false);
    expect(isFormatAccepted('audio/somethingelse')).toBe(false);
    expect(isFormatAccepted('video/unknown')).toBe(false);
  });

  it('should accept application/ogg (valid Ogg container MIME type in the map)', () => {
    expect(isFormatAccepted('application/ogg')).toBe(true);
  });

  it('should reject non-audio types even if subtype matches an accepted format', () => {
    expect(isFormatAccepted('text/webm')).toBe(false);
    expect(isFormatAccepted('text/plain')).toBe(false);
    expect(isFormatAccepted('application/json')).toBe(false);
  });
});

describe('STT error disclosure protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not log a submitted invalid language value', () => {
    const submittedLanguage = 'PRIVATE-LANGUAGE@example.com';
    const service = new STTService();

    service.openAIProvider({ model: 'whisper-1' }, Buffer.from('audio'), {}, submittedLanguage);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid language format'));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(submittedLanguage);
  });

  it('logs only bounded metadata when the speech provider rejects a request', async () => {
    const rawProviderDetail = 'PRIVATE-AUDIO provider echoed submitted content';
    const providerError = Object.assign(new Error(rawProviderDetail), {
      response: {
        status: 502,
        data: rawProviderDetail,
        headers: { 'x-provider-debug': rawProviderDetail },
      },
    });
    const service = new STTService();
    service.providerStrategies.test = () => ['https://provider.test/stt', Buffer.from('audio'), {}];
    axios.post.mockRejectedValueOnce(providerError);

    await expect(
      service.sttRequest(
        'test',
        {},
        {
          audioBuffer: Buffer.from('audio'),
          audioFile: { mimetype: 'audio/webm' },
          language: '',
        },
      ),
    ).rejects.toBe(providerError);

    expect(getSafeErrorMetadata).toHaveBeenCalledWith(providerError);
    expect(logger.error).toHaveBeenCalledWith('[STT] Request failed for provider test:', {
      type: 'Error',
      status: 502,
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rawProviderDetail);
  });
});

describe('STT transcript content filtering', () => {
  let readFileSpy;
  let unlinkSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    readFileSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('audio'));
    unlinkSpy = jest.spyOn(fs, 'unlink').mockResolvedValue();
    inspectContent.mockReturnValue(null);
    getBlockedUninspectableFileField.mockReturnValue(null);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  const createRequest = (config) => ({
    config,
    file: {
      path: '/tmp/audio.webm',
      originalname: 'audio.webm',
      mimetype: 'audio/webm',
      size: 5,
    },
    body: {},
  });

  const createResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    sendStatus: jest.fn(),
  });

  const createService = (transcript) => {
    const service = new STTService();
    jest.spyOn(service, 'getProviderSchema').mockResolvedValue(['openai', {}]);
    jest.spyOn(service, 'sttRequest').mockResolvedValue(transcript);
    return service;
  };

  it('blocks a configured transcript before returning it to the client', async () => {
    const filters = { files: { pii: {} } };
    const finding = {
      label: 'protected value',
      source: 'file',
      field: 'transcript',
    };
    inspectContent.mockReturnValueOnce(null).mockReturnValueOnce(finding);
    const service = createService('submitted transcript');
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(extractFileContent).toHaveBeenCalledWith({ transcript: 'submitted transcript' });
    expect(inspectContent).toHaveBeenCalledWith([{ transcript: 'submitted transcript' }], {
      filters,
    });
    expect(contentFilterBlockResponse).toHaveBeenCalledWith(finding);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_block',
      message: 'Submitted content contains a protected value. Remove it and try again.',
      source: 'file',
      field: 'transcript',
    });
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/audio.webm');
  });

  it('blocks a configured filename before reading or sending the audio', async () => {
    const filters = { files: { pii: { fields: ['name'] } } };
    const finding = {
      label: 'protected value',
      source: 'file',
      field: 'name',
    };
    inspectContent.mockReturnValueOnce(finding);
    const service = createService('submitted transcript');
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(extractFileContent).toHaveBeenCalledWith({ name: 'audio.webm' });
    expect(inspectContent).toHaveBeenCalledWith([{ name: 'audio.webm' }], { filters });
    expect(contentFilterBlockResponse).toHaveBeenCalledWith(finding);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(service.getProviderSchema).not.toHaveBeenCalled();
    expect(service.sttRequest).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/audio.webm');
  });

  it('blocks uninspectable audio before sending it to the speech provider', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['content'],
          uninspectable: 'block',
        },
      },
    };
    getBlockedUninspectableFileField.mockReturnValueOnce('content');
    const service = createService('submitted transcript');
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(filters, ['content']);
    expect(contentFilterUninspectableResponse).toHaveBeenCalledWith('content');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_uninspectable',
      source: 'file',
      field: 'content',
    });
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(service.getProviderSchema).not.toHaveBeenCalled();
    expect(service.sttRequest).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/audio.webm');
  });

  it('transcribes and inspects audio when only transcript fail-close is configured', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          uninspectable: 'block',
        },
      },
    };
    getBlockedUninspectableFileField.mockImplementation((_filters, fields) =>
      fields.includes('transcript') ? 'transcript' : null,
    );
    const service = createService('submitted transcript');
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(filters, ['content']);
    expect(service.sttRequest).toHaveBeenCalledTimes(1);
    expect(extractFileContent).toHaveBeenCalledWith({ transcript: 'submitted transcript' });
    expect(res.json).toHaveBeenCalledWith({ text: 'submitted transcript' });
    expect(contentFilterUninspectableResponse).not.toHaveBeenCalled();
  });

  it('fails closed when a selected transcript cannot be produced', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          uninspectable: 'block',
        },
      },
    };
    getBlockedUninspectableFileField.mockImplementation((_filters, fields) =>
      fields.includes('transcript') ? 'transcript' : null,
    );
    const service = createService('');
    service.sttRequest.mockRejectedValueOnce(new Error('provider failed'));
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(filters, ['content']);
    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(filters, ['transcript']);
    expect(contentFilterUninspectableResponse).toHaveBeenCalledWith('transcript');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_uninspectable',
      source: 'file',
      field: 'transcript',
    });
    expect(res.sendStatus).not.toHaveBeenCalled();
  });

  it('fails closed when the speech provider returns a blank transcript', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['transcript'],
          uninspectable: 'block',
        },
      },
    };
    getBlockedUninspectableFileField.mockImplementation((_filters, fields) =>
      fields.includes('transcript') ? 'transcript' : null,
    );
    const service = createService('   ');
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(contentFilterUninspectableResponse).toHaveBeenCalledWith('transcript');
    expect(inspectContent).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ transcript: expect.anything() })]),
      expect.anything(),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_uninspectable',
      source: 'file',
      field: 'transcript',
    });
  });

  it('preserves the default-off transcript response path', async () => {
    const service = createService('submitted transcript');
    const res = createResponse();

    await service.processSpeechToText(createRequest({}), res);

    expect(inspectContent).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ text: 'submitted transcript' });
  });

  it('preserves the transcript path when the selected file policy has no active patterns', async () => {
    const filters = {
      files: {
        pii: { fields: ['transcript'], starterPatterns: [], customPatterns: [] },
      },
    };
    const service = createService('submitted transcript');
    const res = createResponse();

    await service.processSpeechToText(createRequest({ filters }), res);

    expect(inspectContent).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ text: 'submitted transcript' });
  });

  it('logs only bounded metadata when speech processing fails', async () => {
    const rawProviderDetail = 'PRIVATE-TRANSCRIPT echoed by provider';
    const providerError = Object.assign(new Error(rawProviderDetail), {
      response: { status: 503, data: rawProviderDetail },
    });
    const service = createService('');
    service.sttRequest.mockRejectedValueOnce(providerError);
    const res = createResponse();

    await service.processSpeechToText(createRequest({}), res);

    expect(res.sendStatus).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith(
      '[STT] An error occurred while processing the audio:',
      { type: 'Error', status: 503 },
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rawProviderDetail);
  });
});
