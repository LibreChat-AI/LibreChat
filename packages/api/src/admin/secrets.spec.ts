process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Loaded via dynamic import in beforeAll so encryption initializes after
// CREDS_KEY is set above (encryptV3 reads the key at module load).
let decryptConfigSecret: typeof import('./secrets').decryptConfigSecret;
let encryptConfigSecretFields: typeof import('./secrets').encryptConfigSecretFields;
let encryptConfigSecrets: typeof import('./secrets').encryptConfigSecrets;
let getSecretPreview: typeof import('./secrets').getSecretPreview;
let getConfigSecretInputError: typeof import('./secrets').getConfigSecretInputError;
let getConfigSecretMutationPaths: typeof import('./secrets').getConfigSecretMutationPaths;
let getConfigSecretSections: typeof import('./secrets').getConfigSecretSections;
let isConfigSecretAncestorPath: typeof import('./secrets').isConfigSecretAncestorPath;
let getSecretAncestorPatterns: typeof import('./secrets').getSecretAncestorPatterns;
let matchesSecretPattern: typeof import('./secrets').matchesSecretPattern;
let isConfigSecretRelatedSegments: typeof import('./secrets').isConfigSecretRelatedSegments;
let isConfigSecretDescendantPath: typeof import('./secrets').isConfigSecretDescendantPath;
let isConfigSecretKeyRename: typeof import('./secrets').isConfigSecretKeyRename;
let preserveConfigSecrets: typeof import('./secrets').preserveConfigSecrets;
let redactConfigSecrets: typeof import('./secrets').redactConfigSecrets;
let redactResolvedConfigSecrets: typeof import('./secrets').redactResolvedConfigSecrets;
let resolveConfigSecret: typeof import('./secrets').resolveConfigSecret;
let resolveStoredConfigSecret: typeof import('./secrets').resolveStoredConfigSecret;
let getConfigSecretRules: typeof import('./secrets').getConfigSecretRules;
let resolveCustomEndpointSecrets: typeof import('./secrets').resolveCustomEndpointSecrets;
let resolveRuntimeConfigSecrets: typeof import('./secrets').resolveRuntimeConfigSecrets;
let carryRenamedConfigSecrets: typeof import('./secrets').carryRenamedConfigSecrets;
let isConfigSecretPreservablePatch: typeof import('./secrets').isConfigSecretPreservablePatch;
let UNPREVIEWED_SECRET_MASK: string;
let decryptV3: typeof import('@librechat/data-schemas').decryptV3;
let encryptV3: typeof import('@librechat/data-schemas').encryptV3;

beforeAll(async () => {
  ({
    decryptConfigSecret,
    encryptConfigSecretFields,
    encryptConfigSecrets,
    getSecretPreview,
    getConfigSecretInputError,
    getConfigSecretMutationPaths,
    getConfigSecretSections,
    isConfigSecretAncestorPath,
    getSecretAncestorPatterns,
    matchesSecretPattern,
    isConfigSecretRelatedSegments,
    isConfigSecretDescendantPath,
    isConfigSecretKeyRename,
    preserveConfigSecrets,
    redactConfigSecrets,
    redactResolvedConfigSecrets,
    resolveConfigSecret,
    resolveStoredConfigSecret,
    getConfigSecretRules,
    resolveCustomEndpointSecrets,
    resolveRuntimeConfigSecrets,
    carryRenamedConfigSecrets,
    isConfigSecretPreservablePatch,
    UNPREVIEWED_SECRET_MASK,
  } = await import('./secrets'));
  ({ decryptV3, encryptV3 } = await import('@librechat/data-schemas'));
});

describe('Langfuse config secrets', () => {
  it('encrypts direct field writes and stores a display secret key', () => {
    const out = encryptConfigSecretFields({
      'langfuse.publicKey': 'pk-lf-1',
      'langfuse.secretKey': 'sk-lf-secret',
    });

    expect(out['langfuse.secretKey']).toMatch(/^v3:/);
    expect(decryptV3(out['langfuse.secretKey'] as string)).toBe('sk-lf-secret');
    expect(out['langfuse.secretKeyPreview']).toBe('************');
    expect(out['langfuse.publicKey']).toBe('pk-lf-1');
  });

  it('encrypts object writes and removes client-supplied secret previews', () => {
    const out = encryptConfigSecrets({
      langfuse: {
        publicKey: 'pk-lf-1',
        secretKey: 'sk-lf-secret',
        secretKeyPreview: 'spoofed',
      },
    });

    expect(out.langfuse.secretKey).toMatch(/^v3:/);
    expect(decryptV3(out.langfuse.secretKey)).toBe('sk-lf-secret');
    expect(out.langfuse.secretKeyPreview).toBe('************');
    expect(out.langfuse.publicKey).toBe('pk-lf-1');
  });

  it('clears empty or non-string secret values', () => {
    expect(encryptConfigSecretFields({ 'langfuse.secretKey': '' })).toEqual({
      'langfuse.secretKey': '',
      'langfuse.secretKeyPreview': '',
    });

    expect(
      encryptConfigSecrets({
        langfuse: {
          secretKey: null,
          secretKeyPreview: 'spoofed',
        },
      }),
    ).toEqual({
      langfuse: {
        secretKey: '',
        secretKeyPreview: '',
      },
    });
  });

  it('rejects protected display-key writes and encrypted secret submissions', () => {
    expect(getConfigSecretInputError('langfuse.secretKeyPreview', 'spoofed')).toContain(
      'protected secret preview path',
    );
    expect(getConfigSecretInputError('langfuse.secretKey', 'v3:attacker-controlled')).toContain(
      'Encrypted config secret values',
    );
    expect(
      getConfigSecretInputError('langfuse', { secretKey: 'v3:attacker-controlled' }),
    ).toContain('Encrypted config secret values');
    expect(getConfigSecretInputError('langfuse.secretKey', 'sk-lf-secret')).toBeNull();
  });

  it('decrypts encrypted config secrets and rejects plaintext runtime values', () => {
    const encrypted = encryptConfigSecrets({
      langfuse: { secretKey: 'sk-lf-secret' },
    }).langfuse.secretKey;

    expect(decryptConfigSecret(encrypted)).toBe('sk-lf-secret');
    expect(decryptConfigSecret(' sk-plaintext ')).toBeUndefined();
    expect(decryptConfigSecret('')).toBeUndefined();
    expect(decryptConfigSecret('v3:not-valid-ciphertext')).toBeUndefined();
  });

  it('preserves existing encrypted secrets when object writes omit them', () => {
    const existing = encryptConfigSecrets({
      langfuse: {
        publicKey: 'pk-old',
        secretKey: 'sk-old',
      },
    });
    const next = encryptConfigSecrets({
      langfuse: {
        publicKey: 'pk-new',
      },
    });

    const preserved = preserveConfigSecrets(next, existing);
    const preservedLangfuse = preserved.langfuse as Record<string, string>;
    const existingLangfuse = existing.langfuse as Record<string, string>;

    expect(decryptV3(preservedLangfuse.secretKey)).toBe('sk-old');
    expect(preservedLangfuse.secretKeyPreview).toBe(existingLangfuse.secretKeyPreview);
    expect(preserved.langfuse.publicKey).toBe('pk-new');
  });

  it('migrates a legacy plaintext existing secret by encrypting it, and drops explicitly cleared secrets', () => {
    const next = encryptConfigSecrets({
      langfuse: {
        publicKey: 'pk-new',
      },
    });

    const fromPlaintext = preserveConfigSecrets(next, {
      langfuse: {
        publicKey: 'pk-old',
        secretKey: 'sk-plain-existing',
      },
    });
    const preservedLangfuse = fromPlaintext.langfuse as Record<string, string>;
    expect(preservedLangfuse.publicKey).toBe('pk-new');
    expect(decryptV3(preservedLangfuse.secretKey)).toBe('sk-plain-existing');
    expect(preservedLangfuse.secretKeyPreview).toBe(getSecretPreview('sk-plain-existing'));

    const existing = encryptConfigSecrets({
      langfuse: {
        secretKey: 'sk-old',
      },
    });
    const cleared = encryptConfigSecrets({
      langfuse: {
        secretKey: '',
      },
    });
    expect(preserveConfigSecrets(cleared, existing)).toEqual({
      langfuse: {
        secretKey: '',
        secretKeyPreview: '',
      },
    });
  });

  it('preserves existing secrets for object-valued ancestor patches', () => {
    const existing = encryptConfigSecrets({
      langfuse: {
        publicKey: 'pk-old',
        secretKey: 'sk-old',
      },
    });

    const preserved = preserveConfigSecrets({ publicKey: 'pk-new' }, existing, 'langfuse');
    const preservedLangfuse = preserved as Record<string, string>;
    const existingLangfuse = existing.langfuse as Record<string, string>;

    expect(decryptV3(preservedLangfuse.secretKey)).toBe('sk-old');
    expect(preservedLangfuse.secretKeyPreview).toBe(existingLangfuse.secretKeyPreview);
    expect(preserved.publicKey).toBe('pk-new');
  });

  it('redacts secret values while preserving secret previews', () => {
    const redacted = redactConfigSecrets({
      'langfuse.secretKey': 'literal',
      'langfuse.secretKeyPreview': 'literal-display',
      langfuse: {
        enabled: true,
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKey: 'v3:abc:def',
        secretKeyPreview: 'sk-lf-...cret',
      },
    });

    expect(redacted['langfuse.secretKey']).toBeUndefined();
    expect(redacted['langfuse.secretKeyPreview']).toBeUndefined();
    expect(redacted.langfuse).toEqual({
      enabled: true,
      destination: 'eu',
      publicKey: 'pk-lf-1',
      secretKeyPreview: '*************',
    });
  });

  it('previews a stored plaintext secret by its value only when reading stored overrides', () => {
    const encrypted = encryptConfigSecretFields({ 'webSearch.serperApiKey': 'serper-key-00001' });
    const stored = () => ({
      webSearch: {
        keenableApiKey: ' kn-legacy-plain-0002 ',
        searxngApiKey: 'short',
        tavilyApiKey: 'tvly-legacy-plain-0003',
        tavilyApiKeyPreview: '...kept',
        serperApiKey: encrypted['webSearch.serperApiKey'],
        jinaApiKey: '${JINA_API_KEY}',
        cohereApiKey: '',
      },
    });

    /** Ciphertext without a stored preview, and every value outside stored overrides, gets the
     *  fixed mask, which derives nothing from the value. */
    expect(redactConfigSecrets(stored(), { previewPlaintext: true })).toEqual({
      webSearch: {
        keenableApiKeyPreview: '...0002',
        searxngApiKeyPreview: '*****',
        tavilyApiKeyPreview: '...kept',
        serperApiKeyPreview: UNPREVIEWED_SECRET_MASK,
        jinaApiKey: '${JINA_API_KEY}',
      },
    });
    expect(redactConfigSecrets(stored())).toEqual({
      webSearch: {
        keenableApiKeyPreview: UNPREVIEWED_SECRET_MASK,
        searxngApiKeyPreview: UNPREVIEWED_SECRET_MASK,
        tavilyApiKeyPreview: '...kept',
        serperApiKeyPreview: UNPREVIEWED_SECRET_MASK,
        jinaApiKey: '${JINA_API_KEY}',
      },
    });
  });

  it('masks Langfuse header values while keeping their names', () => {
    const redacted = redactConfigSecrets({
      langfuse: {
        enabled: true,
        publicKey: 'pk-lf-1',
        headers: {
          'CF-Access-Client-Id': 'client-id',
          'CF-Access-Client-Secret': 'gateway-credential',
        },
      },
    });

    /** These reach `GET /api/admin/config/base` from librechat.yaml, where no
     *  scalar secret registration covers them — unmasked, any delegated admin
     *  with Langfuse read access receives the raw gateway credential. */
    expect(redacted.langfuse).toEqual({
      enabled: true,
      publicKey: 'pk-lf-1',
      headers: { 'CF-Access-Client-Id': '***', 'CF-Access-Client-Secret': '***' },
    });
    expect(JSON.stringify(redacted)).not.toContain('gateway-credential');
  });

  it('drops a malformed Langfuse headers value rather than serializing it', () => {
    const redacted = redactConfigSecrets({
      langfuse: { publicKey: 'pk-lf-1', headers: 'Bearer raw-credential' },
    });

    expect(redacted.langfuse).toEqual({ publicKey: 'pk-lf-1' });
    expect(JSON.stringify(redacted)).not.toContain('raw-credential');
  });

  it('strips legacy displaySecretKey companions and migrates them on preserve', () => {
    const redacted = redactConfigSecrets({
      langfuse: { publicKey: 'pk-lf-1', secretKey: 'v3:abc:def', displaySecretKey: 'sk-lf-...old' },
    });
    expect(redacted.langfuse).toEqual({ publicKey: 'pk-lf-1', secretKeyPreview: '************' });

    const alreadyMigrated = redactConfigSecrets({
      langfuse: {
        secretKey: 'v3:abc:def',
        secretKeyPreview: 'sk-lf-...new',
        displaySecretKey: 'sk-lf-...old',
      },
    });
    expect(alreadyMigrated.langfuse).toEqual({ secretKeyPreview: '************' });

    const encrypted = encryptConfigSecrets({
      langfuse: { secretKey: 'sk-lf-new-secret', displaySecretKey: 'sk-lf-...old' },
    }).langfuse as Record<string, string>;
    expect(encrypted.displaySecretKey).toBeUndefined();
    expect(encrypted.secretKeyPreview).toBe('...cret');

    const existing = {
      langfuse: {
        secretKey: encryptConfigSecrets({ langfuse: { secretKey: 'sk-lf-old-secret' } }).langfuse
          .secretKey,
        displaySecretKey: 'sk-lf-...cret',
      },
    };
    const preserved = preserveConfigSecrets({ langfuse: { publicKey: 'pk-new' } }, existing);
    const preservedLangfuse = preserved.langfuse as Record<string, string>;
    expect(decryptV3(preservedLangfuse.secretKey)).toBe('sk-lf-old-secret');
    expect(preservedLangfuse.secretKeyPreview).toBe('*************');
    expect(preservedLangfuse.displaySecretKey).toBeUndefined();

    expect(getConfigSecretInputError('langfuse.displaySecretKey', 'spoofed')).toContain(
      'protected secret preview path',
    );
  });
});

describe('Config secret registry fields', () => {
  it('exposes the registered top-level sections', () => {
    expect([...getConfigSecretSections()].sort()).toEqual([
      'endpoints',
      'langfuse',
      'mcpConfig',
      'mcpServers',
      'ocr',
      'speech',
      'webSearch',
    ]);
  });

  it('encrypts assistants endpoint keys but leaves unrelated endpoints untouched', () => {
    const out = encryptConfigSecrets({
      endpoints: {
        assistants: { apiKey: 'sk-assist', disableBuilder: true },
        azureAssistants: { apiKey: '${AZURE_ASSISTANTS_API_KEY}' },
        custom: [{ name: 'my-endpoint', apiKey: '${MY_KEY}', baseURL: 'https://x' }],
      },
    });
    const endpoints = out.endpoints as {
      assistants: Record<string, unknown>;
      azureAssistants: Record<string, unknown>;
      custom: Array<Record<string, unknown>>;
    };
    expect(decryptV3(endpoints.assistants.apiKey as string)).toBe('sk-assist');
    expect(endpoints.assistants.disableBuilder).toBe(true);
    expect(endpoints.azureAssistants.apiKey).toBe('${AZURE_ASSISTANTS_API_KEY}');
    expect(endpoints.custom[0]).toEqual({
      name: 'my-endpoint',
      apiKey: '${MY_KEY}',
      baseURL: 'https://x',
    });
  });

  it('encrypts speech, ocr, and webSearch literals on object writes', () => {
    const out = encryptConfigSecrets({
      speech: {
        tts: { openai: { apiKey: 'sk-tts', model: 'tts-1' } },
        stt: { azureOpenAI: { apiKey: 'sk-stt', instanceName: 'inst' } },
      },
      ocr: { apiKey: 'sk-ocr', mistralModel: 'mistral-ocr-latest' },
      webSearch: { serperApiKey: 'sk-serper', searchProvider: 'serper' },
    });

    expect(decryptV3(out.speech.tts.openai.apiKey)).toBe('sk-tts');
    expect(out.speech.tts.openai.model).toBe('tts-1');
    expect(decryptV3(out.speech.stt.azureOpenAI.apiKey)).toBe('sk-stt');
    expect(out.speech.stt.azureOpenAI.instanceName).toBe('inst');
    expect(decryptV3(out.ocr.apiKey)).toBe('sk-ocr');
    expect(out.ocr.mistralModel).toBe('mistral-ocr-latest');
    expect(decryptV3(out.webSearch.serperApiKey)).toBe('sk-serper');
    expect(out.webSearch.searchProvider).toBe('serper');
  });

  it('keeps env placeholder references as plain strings for fields that allow them', () => {
    const out = encryptConfigSecrets({
      speech: { tts: { openai: { apiKey: '${TTS_API_KEY}' } } },
      ocr: { apiKey: '${OCR_API_KEY}' },
      webSearch: { serperApiKey: '${SERPER_API_KEY}' },
    });

    expect(out.speech.tts.openai.apiKey).toBe('${TTS_API_KEY}');
    expect(out.ocr.apiKey).toBe('${OCR_API_KEY}');
    expect(out.webSearch.serperApiKey).toBe('${SERPER_API_KEY}');
  });

  it('still encrypts placeholder-shaped Langfuse secrets (no placeholder exemption)', () => {
    const out = encryptConfigSecrets({ langfuse: { secretKey: '${LANGFUSE_SECRET_KEY}' } });
    expect(out.langfuse.secretKey).toMatch(/^v3:/);
    expect(decryptV3(out.langfuse.secretKey)).toBe('${LANGFUSE_SECRET_KEY}');
  });

  it('clears a stale display mask when a literal secret is rotated to an env placeholder', () => {
    const dottedOut = encryptConfigSecretFields({ 'ocr.apiKey': '${OCR_API_KEY}' });
    expect(dottedOut['ocr.apiKey']).toBe('${OCR_API_KEY}');
    expect(dottedOut['ocr.apiKeyPreview']).toBe('');

    const objectOut = encryptConfigSecrets({
      ocr: { apiKey: '${OCR_API_KEY}', apiKeyPreview: 'sk-sta...LE00' },
    });
    expect(objectOut.ocr.apiKey).toBe('${OCR_API_KEY}');
    expect(objectOut.ocr.apiKeyPreview).toBe('');
  });

  it('never persists a client-supplied display mask alongside an env placeholder secret', () => {
    const out = encryptConfigSecrets({
      ocr: { apiKey: '${OCR_API_KEY}', apiKeyPreview: 'sk-atk...ACK' },
    });
    expect(out.ocr.apiKey).toBe('${OCR_API_KEY}');
    expect(out.ocr.apiKeyPreview).toBe('');
  });

  it('trims whitespace from a literal secret before encrypting and masking', () => {
    const out = encryptConfigSecretFields({ 'ocr.apiKey': '  sk-padded-secret  ' });
    expect(decryptV3(out['ocr.apiKey'] as string)).toBe('sk-padded-secret');
    expect(out['ocr.apiKeyPreview']).toBe(getSecretPreview('sk-padded-secret'));
  });

  it('treats a whitespace-only literal secret as empty and clears it', () => {
    const out = encryptConfigSecretFields({ 'ocr.apiKey': '   ' });
    expect(out['ocr.apiKey']).toBe('');
    expect(out['ocr.apiKeyPreview']).toBe('');
  });

  it('masks short credentials fully instead of disclosing them via the preview companion', () => {
    expect(getSecretPreview('short12')).toBe('*******');
    expect(getSecretPreview('0123456789')).toBe('**********');
    expect(getSecretPreview('0123456789abcde')).toBe('***************');
  });

  it('reveals only the last four characters of a long secret, never a prefix', () => {
    const preview = getSecretPreview('sk-longer-secret-value');
    expect(preview).toBe('...alue');
    expect(preview).not.toContain('sk-');
  });

  it('encrypts dotted patch writes and sets a masked preview companion for every field', () => {
    const out = encryptConfigSecretFields({
      'speech.tts.openai.apiKey': 'sk-tts',
      'webSearch.serperApiKey': '${SERPER_API_KEY}',
      'ocr.apiKey': '',
    });

    expect(decryptV3(out['speech.tts.openai.apiKey'] as string)).toBe('sk-tts');
    expect(out['speech.tts.openai.apiKeyPreview']).toBe(getSecretPreview('sk-tts'));
    expect(out['webSearch.serperApiKey']).toBe('${SERPER_API_KEY}');
    expect(out['webSearch.serperApiKeyPreview']).toBe('');
    expect(out['ocr.apiKey']).toBe('');
    expect(out['ocr.apiKeyPreview']).toBe('');
    expect(Object.keys(out).sort()).toEqual([
      'ocr.apiKey',
      'ocr.apiKeyPreview',
      'speech.tts.openai.apiKey',
      'speech.tts.openai.apiKeyPreview',
      'webSearch.serperApiKey',
      'webSearch.serperApiKeyPreview',
    ]);
  });

  it('encrypts secrets nested inside object-valued ancestor patch entries and sets their preview companion', () => {
    type SpeechPatch = { tts: { openai: Record<string, string> } };
    const sectionPatch = encryptConfigSecretFields({
      speech: { tts: { openai: { apiKey: 'sk-tts', model: 'tts-1' } } },
    });
    const speech = sectionPatch.speech as SpeechPatch;
    expect(decryptV3(speech.tts.openai.apiKey)).toBe('sk-tts');
    expect(speech.tts.openai.apiKeyPreview).toBe(getSecretPreview('sk-tts'));
    expect(speech.tts.openai.model).toBe('tts-1');

    const midPatch = encryptConfigSecretFields({
      'speech.tts': { openai: { apiKey: 'sk-tts' } },
    });
    const tts = midPatch['speech.tts'] as SpeechPatch['tts'];
    expect(decryptV3(tts.openai.apiKey)).toBe('sk-tts');
    expect(tts.openai.apiKeyPreview).toBe(getSecretPreview('sk-tts'));

    const leafParentPatch = encryptConfigSecretFields({
      'speech.tts.openai': { apiKey: 'sk-tts', model: 'tts-1' },
    });
    const openai = leafParentPatch['speech.tts.openai'] as Record<string, string>;
    expect(decryptV3(openai.apiKey)).toBe('sk-tts');
    expect(openai.apiKeyPreview).toBe(getSecretPreview('sk-tts'));
  });

  it('strips dotted registry-related keys, including preview companions, from whole-override writes', () => {
    const out = encryptConfigSecrets({
      'speech.tts.openai.apiKey': 'sk-smuggled',
      'speech.tts.openai.apiKeyPreview': 'sk-spoofed...display',
      'ocr.apiKey': 'sk-smuggled',
      'webSearch.serperApiKey.nested': 'sk-smuggled',
      'speech.tts': { openai: { apiKey: 'sk-smuggled' } },
      ocr: { apiKey: 'sk-legit' } as Record<string, string>,
    });

    expect(out).not.toHaveProperty(['speech.tts.openai.apiKey']);
    expect(out).not.toHaveProperty(['speech.tts.openai.apiKeyPreview']);
    expect(out).not.toHaveProperty(['ocr.apiKey']);
    expect(out).not.toHaveProperty(['webSearch.serperApiKey.nested']);
    expect(out).not.toHaveProperty(['speech.tts']);
    expect(decryptV3(out.ocr.apiKey)).toBe('sk-legit');
    expect(out.ocr.apiKeyPreview).toBe(getSecretPreview('sk-legit'));
  });

  it('strips a nested array smuggled at any depth along a secret ancestor path, not just the top level', () => {
    const encrypted = encryptConfigSecrets({
      speech: { tts: { openai: [{ apiKey: 'sk-smuggled-via-array' }] } },
    });
    const speechOut = encrypted.speech as { tts: Record<string, unknown> };
    expect(speechOut.tts).not.toHaveProperty('openai');
    expect(JSON.stringify(encrypted)).not.toContain('sk-smuggled-via-array');

    const readBack = redactConfigSecrets(
      structuredClone({
        speech: { tts: { openai: [{ apiKey: 'sk-smuggled-via-array' }] } },
      }),
    );
    const speechRead = readBack.speech as { tts: Record<string, unknown> };
    expect(speechRead.tts).not.toHaveProperty('openai');
    expect(JSON.stringify(readBack)).not.toContain('sk-smuggled-via-array');
  });

  it('redacts secrets but keeps preview companions, env placeholders, and siblings visible on read', () => {
    const redacted = redactConfigSecrets({
      speech: {
        tts: {
          openai: {
            apiKey: 'sk-literal',
            apiKeyPreview: getSecretPreview('sk-literal'),
            model: 'tts-1',
          },
        },
        stt: {
          openai: { apiKey: 'v3:abc:def', apiKeyPreview: 'sk-old...-old', model: 'whisper-1' },
        },
      },
      ocr: { apiKey: '${OCR_API_KEY}', mistralModel: 'mistral-ocr-latest' },
      webSearch: {
        serperApiKey: 'sk-literal',
        serperApiKeyPreview: 'sk-lite...eral',
        searchProvider: 'serper',
      },
    });

    expect(redacted.speech.tts.openai).toEqual({
      apiKeyPreview: getSecretPreview('sk-literal'),
      model: 'tts-1',
    });
    expect(redacted.speech.stt.openai).toEqual({
      apiKeyPreview: '*************',
      model: 'whisper-1',
    });
    expect(redacted.ocr).toEqual({
      apiKey: '${OCR_API_KEY}',
      mistralModel: 'mistral-ocr-latest',
    });
    expect(redacted.webSearch).toEqual({
      serperApiKeyPreview: '**************',
      searchProvider: 'serper',
    });
  });

  it('preserves omitted encrypted secrets and their preview companion on nested object writes', () => {
    const existing = encryptConfigSecrets({
      speech: { tts: { openai: { apiKey: 'sk-old', model: 'tts-1' } as Record<string, string> } },
    });
    const existingDisplay = existing.speech.tts.openai.apiKeyPreview;
    expect(existingDisplay).toBe(getSecretPreview('sk-old'));

    const next = preserveConfigSecrets(
      { speech: { tts: { openai: { model: 'tts-2' } as Record<string, string> } } },
      existing,
    );
    expect(decryptV3(next.speech.tts.openai.apiKey)).toBe('sk-old');
    expect(next.speech.tts.openai.apiKeyPreview).toBe(existingDisplay);
    expect(next.speech.tts.openai.model).toBe('tts-2');

    const providerRemoved = preserveConfigSecrets({ speech: { tts: {} } }, existing);
    expect(providerRemoved.speech.tts).toEqual({});

    const ancestorPatch = preserveConfigSecrets(
      { openai: { model: 'tts-2' } as Record<string, string> },
      existing,
      'speech.tts',
    );
    expect(decryptV3(ancestorPatch.openai.apiKey)).toBe('sk-old');
    expect(ancestorPatch.openai.apiKeyPreview).toBe(existingDisplay);
  });

  it('does not preserve explicitly cleared secrets, and clears the preview companion too', () => {
    const cleared = encryptConfigSecrets({
      speech: { tts: { openai: { apiKey: '' } as Record<string, string> } },
    });
    expect(cleared.speech.tts.openai.apiKeyPreview).toBe('');
    const existing = encryptConfigSecrets({
      speech: { tts: { openai: { apiKey: 'sk-old' } as Record<string, string> } },
    });
    const preservedAfterClear = preserveConfigSecrets(cleared, existing);
    expect(preservedAfterClear.speech.tts.openai.apiKey).toBe('');
    expect(preservedAfterClear.speech.tts.openai.apiKeyPreview).toBe('');
  });

  it('migrates a legacy plaintext existing secret on an omitted allow-placeholder field too', () => {
    const fromPlaintext = preserveConfigSecrets(
      { ocr: { mistralModel: 'm' } },
      { ocr: { apiKey: 'sk-plain-existing' } },
    );
    const ocr = fromPlaintext.ocr as Record<string, string>;
    expect(ocr.mistralModel).toBe('m');
    expect(decryptV3(ocr.apiKey)).toBe('sk-plain-existing');
    expect(ocr.apiKeyPreview).toBe(getSecretPreview('sk-plain-existing'));
  });

  it('preserves an existing env placeholder secret verbatim without encrypting it', () => {
    const fromPlaceholder = preserveConfigSecrets(
      { ocr: { mistralModel: 'm' } },
      { ocr: { apiKey: '${OCR_API_KEY}' } },
    );
    const ocr = fromPlaceholder.ocr as Record<string, string>;
    expect(ocr.apiKey).toBe('${OCR_API_KEY}');
    expect(ocr.apiKeyPreview).toBeUndefined();
  });

  it('resolveConfigSecret decrypts, resolves env references, and passes literals through', () => {
    const encrypted = encryptConfigSecrets({ ocr: { apiKey: 'sk-ocr' } }).ocr.apiKey;
    expect(resolveConfigSecret(encrypted)).toBe('sk-ocr');

    process.env.SECRETS_SPEC_TEST_KEY = 'sk-from-env';
    expect(resolveConfigSecret('${SECRETS_SPEC_TEST_KEY}')).toBe('sk-from-env');
    delete process.env.SECRETS_SPEC_TEST_KEY;

    expect(resolveConfigSecret('sk-plain-literal')).toBe('sk-plain-literal');
    expect(resolveConfigSecret('')).toBe('');
    expect(resolveConfigSecret(undefined)).toBeUndefined();
    expect(resolveConfigSecret('v3:not-valid-ciphertext')).toBe('v3:not-valid-ciphertext');
    expect(resolveConfigSecret('v3:provider-literal-token')).toBe('v3:provider-literal-token');
  });

  it('resolveStoredConfigSecret decrypts and passes every other value through verbatim', () => {
    const encrypted = encryptConfigSecrets({ webSearch: { keenableApiKey: 'kn-stored' } }).webSearch
      .keenableApiKey;
    expect(resolveStoredConfigSecret(encrypted)).toBe('kn-stored');

    process.env.SECRETS_SPEC_TEST_KEY = 'sk-from-env';
    expect(resolveStoredConfigSecret('${SECRETS_SPEC_TEST_KEY}')).toBe('${SECRETS_SPEC_TEST_KEY}');
    expect(resolveStoredConfigSecret('kn-${SECRETS_SPEC_TEST_KEY}')).toBe(
      'kn-${SECRETS_SPEC_TEST_KEY}',
    );
    delete process.env.SECRETS_SPEC_TEST_KEY;

    expect(resolveStoredConfigSecret('kn-plain-literal')).toBe('kn-plain-literal');
    expect(resolveStoredConfigSecret('v3:provider-literal-token')).toBe(
      'v3:provider-literal-token',
    );
  });

  it('registers the Keenable web search key with its preview companion', () => {
    expect(getConfigSecretRules().secretFields).toContainEqual({
      path: 'webSearch.keenableApiKey',
      previewPath: 'webSearch.keenableApiKeyPreview',
      allowEnvPlaceholder: true,
    });
    const out = encryptConfigSecretFields({ 'webSearch.keenableApiKey': 'kn-0123456789abcdef' });
    expect(decryptV3(out['webSearch.keenableApiKey'] as string)).toBe('kn-0123456789abcdef');
    expect(out['webSearch.keenableApiKeyPreview']).toBe('...cdef');
  });

  it('reports mutation paths (including the preview companion) and ancestor/descendant checks for registry fields', () => {
    expect(getConfigSecretMutationPaths('speech.tts.openai.apiKey')).toEqual([
      'speech.tts.openai.apiKey',
      'speech.tts.openai.apiKeyPreview',
    ]);
    expect(getConfigSecretMutationPaths('webSearch.serperApiKey')).toEqual([
      'webSearch.serperApiKey',
      'webSearch.serperApiKeyPreview',
    ]);
    expect(getConfigSecretMutationPaths('langfuse.secretKey')).toEqual([
      'langfuse.secretKey',
      'langfuse.secretKeyPreview',
    ]);
    expect(getConfigSecretMutationPaths('speech.tts.openai.apiKeyPreview')).toEqual([
      'speech.tts.openai.apiKeyPreview',
    ]);

    for (const path of ['speech', 'speech.tts', 'speech.tts.openai', 'ocr', 'webSearch']) {
      expect(isConfigSecretAncestorPath(path)).toBe(true);
    }
    expect(isConfigSecretAncestorPath('speech.tts.openai.apiKey')).toBe(false);
    expect(isConfigSecretAncestorPath('interface')).toBe(false);

    expect(isConfigSecretDescendantPath('speech.tts.openai.apiKey.hidden')).toBe(true);
    expect(isConfigSecretDescendantPath('webSearch.serperApiKey.hidden')).toBe(true);
    expect(isConfigSecretDescendantPath('speech.tts.openai.apiKeyPreview.hidden')).toBe(true);
    expect(isConfigSecretDescendantPath('speech.tts.openai.model')).toBe(false);
  });

  it('derives ancestors from array secret containers as well as scalar secrets', () => {
    expect(isConfigSecretAncestorPath('endpoints')).toBe(true);
    expect(isConfigSecretAncestorPath('endpoints.custom')).toBe(false);
    expect(isConfigSecretAncestorPath('endpoints.assistants')).toBe(true);
    /** The container of the Azure group array secret. */
    expect(isConfigSecretAncestorPath('endpoints.azureOpenAI')).toBe(true);
    expect(isConfigSecretAncestorPath('endpoints.azureOpenAI.groups')).toBe(false);
    expect(isConfigSecretAncestorPath('endpoints.google')).toBe(false);

    expect(
      getSecretAncestorPatterns(['speech.tts.openai.apiKey', 'endpoints.custom']).sort(),
    ).toEqual(['endpoints', 'speech', 'speech.tts', 'speech.tts.openai']);
  });

  it('keeps dynamic segments in derived ancestors and matches them segment by segment', () => {
    expect(
      getSecretAncestorPatterns(['mcpServers.*.oauth.client_secret', 'mcpServers.*.apiKey.key']),
    ).toEqual(['mcpServers', 'mcpServers.*', 'mcpServers.*.oauth', 'mcpServers.*.apiKey']);

    expect(matchesSecretPattern('mcpServers.github.oauth', 'mcpServers.*.oauth')).toBe(true);
    expect(matchesSecretPattern('mcpServers.github', 'mcpServers.*')).toBe(true);
    expect(matchesSecretPattern('mcpServers.github.oauth.x', 'mcpServers.*.oauth')).toBe(false);
    expect(matchesSecretPattern('mcpServers', 'mcpServers.*')).toBe(false);
    expect(matchesSecretPattern('mcpSettings.github.oauth', 'mcpServers.*.oauth')).toBe(false);
  });

  it('relates a segment path to a secret it is, holds, or lies inside, comparing whole keys', () => {
    expect(isConfigSecretRelatedSegments(['webSearch'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['webSearch', 'serperApiKey'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['webSearch', 'serperApiKeyPreview'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['webSearch', 'serperApiKey', 'x'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['langfuse', 'displaySecretKey'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['endpoints', 'custom'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['endpoints', 'custom', 'my.endpoint'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['endpoints', 'custom', '0', 'apiKey'])).toBe(true);

    expect(isConfigSecretRelatedSegments(['webSearch', 'searchProvider'])).toBe(false);
    expect(isConfigSecretRelatedSegments(['webSearch', 'serperApiKey.x'])).toBe(false);
    expect(isConfigSecretRelatedSegments(['speech', 'tts.openai'])).toBe(false);
    expect(isConfigSecretRelatedSegments(['endpoints', 'custom', '0', 'headers', 'X.Id'])).toBe(
      false,
    );
    expect(
      isConfigSecretRelatedSegments(['endpoints', 'bedrock', 'inferenceProfiles', 'us.a.b']),
    ).toBe(false);
  });

  it('rejects encrypted submissions at registry paths and inside ancestor objects', () => {
    expect(getConfigSecretInputError('webSearch.serperApiKey', 'v3:attacker')).toContain(
      'Encrypted config secret values',
    );
    expect(
      getConfigSecretInputError('speech', { tts: { openai: { apiKey: 'v3:attacker' } } }),
    ).toContain('Encrypted config secret values');
    expect(getConfigSecretInputError('speech.tts.openai', { apiKey: 'v3:attacker' })).toContain(
      'Encrypted config secret values',
    );
    expect(getConfigSecretInputError('speech.tts.openai.apiKey', 'sk-legit')).toBeNull();
    expect(getConfigSecretInputError('ocr.apiKey', '${OCR_API_KEY}')).toBeNull();
  });

  describe('preview companion fields are write-side read-only for every registered field', () => {
    it.each([
      'ocr.apiKeyPreview',
      'speech.tts.openai.apiKeyPreview',
      'speech.stt.azureOpenAI.apiKeyPreview',
      'webSearch.serperApiKeyPreview',
      'webSearch.cohereApiKeyPreview',
      'webSearch.keenableApiKeyPreview',
      'endpoints.assistants.apiKeyPreview',
      'endpoints.azureAssistants.apiKeyPreview',
      'langfuse.secretKeyPreview',
    ])('rejects a direct dotted-patch write to %s', (previewPath) => {
      expect(getConfigSecretInputError(previewPath, 'attacker-supplied-display-value')).toContain(
        'Cannot write protected secret preview path',
      );
    });

    it('drops a client-supplied display value when the ancestor object omits the real secret, never storing it', () => {
      const out = encryptConfigSecretFields({
        speech: { tts: { openai: { model: 'tts-1', apiKeyPreview: 'attacker-injected-display' } } },
      });
      const openai = (out.speech as { tts: { openai: Record<string, unknown> } }).tts.openai;
      expect(openai).not.toHaveProperty('apiKeyPreview');
      expect(openai.model).toBe('tts-1');
    });

    it('overwrites a client-supplied display value with the server-computed one when a real secret is also present, never persisting the attacker value', () => {
      const out = encryptConfigSecretFields({
        webSearch: {
          serperApiKey: 'sk-real-secret',
          serperApiKeyPreview: 'v3:looks-encrypted-but-is-attacker-input',
        },
      });
      const webSearch = out.webSearch as Record<string, string>;
      expect(decryptV3(webSearch.serperApiKey)).toBe('sk-real-secret');
      expect(webSearch.serperApiKeyPreview).toBe(getSecretPreview('sk-real-secret'));
      expect(webSearch.serperApiKeyPreview).not.toBe('v3:looks-encrypted-but-is-attacker-input');
    });

    it('never encrypts or stores a display-path value submitted without its real secret, even if it looks like a secret literal', () => {
      const out = encryptConfigSecrets({
        ocr: { apiKeyPreview: 'this-should-never-be-treated-as-a-secret', mistralModel: 'x' },
      });
      expect(out.ocr).not.toHaveProperty('apiKeyPreview');
      expect(out.ocr).not.toHaveProperty('apiKey');
      expect(out.ocr.mistralModel).toBe('x');
    });
  });
});

describe('Custom endpoint config secrets', () => {
  const endpointsWith = (custom: Array<Record<string, unknown>>) => ({ endpoints: { custom } });

  it('encrypts literal API keys on full-document writes and stores display companions', () => {
    const out = encryptConfigSecrets(
      endpointsWith([
        { name: 'OpenRouter', apiKey: 'sk-or-super-secret', baseURL: 'https://openrouter.ai' },
      ]),
    );
    const entry = out.endpoints.custom[0] as Record<string, string>;

    expect(entry.apiKey).toMatch(/^v3:/);
    expect(decryptV3(entry.apiKey)).toBe('sk-or-super-secret');
    expect(entry.apiKeyPreview).toBe('...cret');
    expect(entry.baseURL).toBe('https://openrouter.ai');
  });

  it('leaves user_provided and env-reference API keys readable', () => {
    const out = encryptConfigSecrets(
      endpointsWith([
        { name: 'A', apiKey: 'user_provided', apiKeyPreview: 'spoofed' },
        { name: 'B', apiKey: '${OPENROUTER_KEY}' },
      ]),
    );
    const [a, b] = out.endpoints.custom as Array<Record<string, string>>;

    expect(a.apiKey).toBe('user_provided');
    expect(a.apiKeyPreview).toBeUndefined();
    expect(b.apiKey).toBe('${OPENROUTER_KEY}');
    expect(b.apiKeyPreview).toBeUndefined();
  });

  it('fully masks previews stored under the old prefix policy on read and preserve', () => {
    const stored = {
      langfuse: { secretKey: 'v3:abc:def', secretKeyPreview: 'sk-lf-...cret' },
      endpoints: {
        custom: [{ name: 'A', apiKey: 'v3:abc:def', apiKeyPreview: 'sk-or-...cret' }],
      },
    };
    const redacted = redactConfigSecrets(structuredClone(stored)) as typeof stored;
    expect(redacted.langfuse.secretKeyPreview).toBe('*************');
    expect(redacted.endpoints.custom[0].apiKeyPreview).toBe('*************');

    const preserved = preserveConfigSecrets(
      { langfuse: { publicKey: 'pk' }, endpoints: { custom: [{ name: 'A' }] } },
      structuredClone(stored),
    ) as unknown as typeof stored;
    expect(preserved.langfuse.secretKeyPreview).toBe('*************');
    expect(preserved.endpoints.custom[0].apiKeyPreview).toBe('*************');
  });

  it('encrypts section and array patched values from field maps', () => {
    const viaSection = encryptConfigSecretFields({
      endpoints: { custom: [{ name: 'A', apiKey: 'sk-section-key' }] },
    });
    const sectionEntry = (viaSection.endpoints as { custom: Array<Record<string, string>> })
      .custom[0];
    expect(decryptV3(sectionEntry.apiKey)).toBe('sk-section-key');
    expect(sectionEntry.apiKeyPreview).toBe('**************');

    const viaArray = encryptConfigSecretFields({
      'endpoints.custom': [{ name: 'A', apiKey: 'sk-array-key0' }],
    });
    const arrayEntry = (viaArray['endpoints.custom'] as Array<Record<string, string>>)[0];
    expect(decryptV3(arrayEntry.apiKey)).toBe('sk-array-key0');
    expect(arrayEntry.apiKeyPreview).toBe('*************');
  });

  it('clears empty, non-string, or pre-encrypted API key submissions', () => {
    const out = encryptConfigSecrets(
      endpointsWith([
        { name: 'A', apiKey: '' },
        { name: 'B', apiKey: null },
        { name: 'C', apiKey: 'v3:smuggled', apiKeyPreview: 'spoofed' },
      ]),
    );

    for (const item of out.endpoints.custom as Array<Record<string, string>>) {
      expect(item.apiKey).toBe('');
      expect(item.apiKeyPreview).toBe('');
    }
  });

  it('rejects encrypted submissions and indexed secret writes', () => {
    expect(
      getConfigSecretInputError('endpoints', { custom: [{ name: 'A', apiKey: 'v3:smuggled' }] }),
    ).toContain('Encrypted config secret values');
    expect(
      getConfigSecretInputError('endpoints.custom', [{ name: 'A', apiKey: 'v3:smuggled' }]),
    ).toContain('Encrypted config secret values');
    expect(getConfigSecretInputError('endpoints', [])).toBeNull();
    expect(getConfigSecretInputError('endpoints.custom.0.apiKey', 'sk-new')).toContain(
      'Cannot write secret fields by array index',
    );
    expect(getConfigSecretInputError('endpoints.custom.0.apiKeyPreview', undefined)).toContain(
      'Cannot write secret fields by array index',
    );
    expect(
      getConfigSecretInputError('endpoints.custom.0', { name: 'A', apiKey: 'sk-new' }),
    ).toContain('Cannot replace endpoints.custom entries by array index');
    expect(getConfigSecretInputError('endpoints.custom.0', { name: 'A' })).toContain(
      'Cannot replace endpoints.custom entries by array index',
    );
    expect(getConfigSecretInputError('endpoints.custom.0.baseURL', 'https://x')).toBeNull();
    expect(getConfigSecretInputError('endpoints.custom.apiKey', 'sk-smuggled')).toContain(
      'has no named fields',
    );
    expect(getConfigSecretInputError('endpoints.custom.slot.apiKey', 'sk-smuggled')).toContain(
      'has no named fields',
    );
    expect(getConfigSecretInputError('endpoints.custom.apiKeyPreview', 'spoofed')).toContain(
      'has no named fields',
    );
    expect(
      getConfigSecretInputError('endpoints.custom', [{ name: 'A', apiKey: 'sk-plain-1234' }]),
    ).toBeNull();
  });

  it('rejects and strips non-array protected containers', () => {
    expect(getConfigSecretInputError('endpoints', { custom: { apiKey: 'sk-smuggled' } })).toContain(
      'Protected secret container must be an array',
    );
    expect(getConfigSecretInputError('endpoints.custom', { apiKey: 'sk-smuggled' })).toContain(
      'Protected secret container must be an array',
    );
    expect(getConfigSecretInputError('endpoints', { custom: null })).toContain(
      'Protected secret container must be an array',
    );
    expect(getConfigSecretInputError('endpoints.custom', null)).toContain(
      'Protected secret container must be an array',
    );
    expect(getConfigSecretInputError('endpoints.custom', undefined)).toBeNull();

    const encrypted = encryptConfigSecrets({ endpoints: { custom: { apiKey: 'sk-smuggled' } } });
    expect(encrypted.endpoints).toEqual({});

    const nullStripped = encryptConfigSecrets({ endpoints: { custom: null } });
    expect(nullStripped.endpoints).toEqual({});

    const redacted = redactConfigSecrets({ endpoints: { custom: { apiKey: 'sk-smuggled' } } });
    expect(redacted.endpoints).toEqual({});

    const fields = encryptConfigSecretFields({ 'endpoints.custom': { apiKey: 'sk-smuggled' } });
    expect(fields['endpoints.custom']).toBeUndefined();
  });

  it('rejects positional-operator writes to secret fields', () => {
    expect(getConfigSecretInputError('endpoints.custom.$[].apiKey', 'sk-new-value')).toContain(
      'Cannot write secret fields by array index',
    );
    expect(getConfigSecretInputError('endpoints.custom.$.apiKeyPreview', 'spoof')).toContain(
      'Cannot write secret fields by array index',
    );
    expect(
      getConfigSecretInputError('endpoints.custom.$[elem]', { name: 'A', apiKey: 'sk-new' }),
    ).toContain('Cannot replace endpoints.custom entries by array index');
  });

  it('fully masks display previews of short secrets', () => {
    const out = encryptConfigSecrets(endpointsWith([{ name: 'A', apiKey: 'secret' }]));
    const entry = out.endpoints.custom[0] as Record<string, string>;

    expect(decryptV3(entry.apiKey)).toBe('secret');
    expect(entry.apiKeyPreview).toBe('******');
  });

  it('preserves omitted API keys by endpoint name across redacted round-trips', () => {
    const existing = encryptConfigSecrets(
      endpointsWith([
        { name: 'OpenRouter', apiKey: 'sk-or-old-secret' },
        { name: 'Renamed', apiKey: 'sk-renamed-1234' },
      ]),
    );

    const next = encryptConfigSecrets(
      endpointsWith([
        { name: 'OpenRouter', baseURL: 'https://openrouter.ai' },
        { name: 'BrandNew', baseURL: 'https://new.example' },
      ]),
    );
    const preserved = preserveConfigSecrets(next, existing);
    const [openRouter, brandNew] = preserved.endpoints.custom as Array<Record<string, string>>;

    expect(decryptV3(openRouter.apiKey)).toBe('sk-or-old-secret');
    expect(openRouter.apiKeyPreview).toBe('...cret');
    expect(brandNew.apiKey).toBeUndefined();
  });

  it('preserves and encrypts plaintext-legacy API keys on redacted round-trips', () => {
    const existing = endpointsWith([
      { name: 'Legacy', apiKey: 'sk-legacy-plaintext' },
      { name: 'EnvRef', apiKey: '${OPENROUTER_KEY}' },
    ]);
    const next = encryptConfigSecrets(
      endpointsWith([
        { name: 'Legacy', baseURL: 'https://legacy.example' },
        { name: 'EnvRef', baseURL: 'https://ref.example' },
      ]),
    );

    const preserved = preserveConfigSecrets(next, existing);
    const [legacy, envRef] = preserved.endpoints.custom as Array<Record<string, string>>;

    expect(legacy.apiKey).toMatch(/^v3:/);
    expect(decryptV3(legacy.apiKey)).toBe('sk-legacy-plaintext');
    expect(legacy.apiKeyPreview).toBe('...text');
    expect(envRef.apiKey).toBeUndefined();
  });

  it('matches identities verbatim so whitespace-distinct names keep their own keys', () => {
    const existing = encryptConfigSecrets(
      endpointsWith([
        { name: 'Prod', apiKey: 'sk-prod-exact-key' },
        { name: ' Prod ', apiKey: 'sk-prod-spaced-key' },
      ]),
    );
    const next = encryptConfigSecrets(endpointsWith([{ name: 'Prod' }, { name: ' Prod ' }]));

    const preserved = preserveConfigSecrets(next, existing);
    const [exact, spaced] = preserved.endpoints.custom as Array<Record<string, string>>;

    expect(decryptV3(exact.apiKey)).toBe('sk-prod-exact-key');
    expect(decryptV3(spaced.apiKey)).toBe('sk-prod-spaced-key');
  });

  it('matches endpoint names the runtime folds together as one identity', () => {
    const existing = encryptConfigSecrets(
      endpointsWith([
        { name: 'Ollama', apiKey: 'sk-ollama-stored-key' },
        { name: 'OpenRouter', apiKey: 'sk-or-stored-value' },
      ]),
    );
    const next = encryptConfigSecrets(endpointsWith([{ name: 'ollama' }, { name: 'openrouter' }]));

    const preserved = preserveConfigSecrets(next, existing);
    const [ollama, openRouter] = preserved.endpoints.custom as Array<Record<string, string>>;

    expect(decryptV3(ollama.apiKey)).toBe('sk-ollama-stored-key');
    expect(ollama.apiKeyPreview).toBe('...-key');
    expect(openRouter.apiKey).toBeUndefined();
  });

  /** A document stored before names were folded may hold both spellings; the runtime merge
   *  combines them in order, so an omitted key keeps the key that merge applies. */
  it.each([
    ['only the earlier item holds a key', [{ apiKey: 'sk-ollama-first-key' }, {}], 'first'],
    [
      'both items hold a key',
      [{ apiKey: 'sk-ollama-first-key' }, { apiKey: 'sk-ollama-second-key' }],
      'second',
    ],
  ])('keeps the combined key of two stored spellings when %s', (_case, keys, expected) => {
    const existing = encryptConfigSecrets(
      endpointsWith([
        { name: 'Ollama', baseURL: 'http://first/v1', ...keys[0] },
        { name: 'ollama', modelDisplayLabel: 'Second', ...keys[1] },
      ]),
    );

    const preserved = preserveConfigSecrets(
      encryptConfigSecrets(endpointsWith([{ name: 'ollama' }])),
      existing,
    );

    const [entry] = preserved.endpoints.custom as Array<Record<string, string>>;
    expect(decryptV3(entry.apiKey)).toBe(`sk-ollama-${expected}-key`);
    expect(entry.apiKeyPreview).toBe('...-key');
  });

  it('does not preserve keys for duplicated endpoint identities', () => {
    const existing = encryptConfigSecrets(
      endpointsWith([
        { name: 'Doubled', apiKey: 'sk-first-key-value' },
        { name: 'Doubled', apiKey: 'sk-second-key-value' },
        { name: 'Unique', apiKey: 'sk-unique-key-value' },
      ]),
    );
    const next = encryptConfigSecrets(endpointsWith([{ name: 'Doubled' }, { name: 'Unique' }]));

    const preserved = preserveConfigSecrets(next, existing);
    const [doubled, unique] = preserved.endpoints.custom as Array<Record<string, string>>;

    expect(doubled.apiKey).toBeUndefined();
    expect(decryptV3(unique.apiKey)).toBe('sk-unique-key-value');
  });

  it('preserves omitted API keys for array-valued patches, not cleared ones', () => {
    const existing = encryptConfigSecrets(endpointsWith([{ name: 'A', apiKey: 'sk-old-value' }]));

    const kept = preserveConfigSecrets(
      [{ name: 'A', baseURL: 'https://a.example' }],
      existing,
      'endpoints.custom',
    ) as Array<Record<string, string>>;
    expect(decryptV3(kept[0].apiKey)).toBe('sk-old-value');

    const cleared = preserveConfigSecrets(
      encryptConfigSecrets([{ name: 'A', apiKey: '' }], 'endpoints.custom'),
      existing,
      'endpoints.custom',
    ) as Array<Record<string, string>>;
    expect(cleared[0].apiKey).toBe('');
    expect(cleared[0].apiKeyPreview).toBe('');
  });

  it('redacts encrypted and plaintext-legacy keys while keeping readable references', () => {
    const redacted = redactConfigSecrets({
      endpoints: {
        custom: [
          { name: 'A', apiKey: 'v3:abc:def', apiKeyPreview: 'sk-a...key' },
          { name: 'B', apiKey: 'sk-plaintext-legacy' },
          { name: 'C', apiKey: 'user_provided' },
          { name: 'D', apiKey: '${OPENROUTER_KEY}' },
          { name: 'E', apiKey: '' },
        ],
      },
    });
    const [a, b, c, d, e] = redacted.endpoints.custom as Array<Record<string, string>>;

    expect(a.apiKey).toBeUndefined();
    expect(a.apiKeyPreview).toBe('**********');
    expect(b.apiKey).toBeUndefined();
    /** No stored preview: the fixed mask says a key is set without deriving anything from it. */
    expect(b.apiKeyPreview).toBe(UNPREVIEWED_SECRET_MASK);
    expect(c.apiKey).toBe('user_provided');
    expect(c.apiKeyPreview).toBeUndefined();
    expect(d.apiKey).toBe('${OPENROUTER_KEY}');
    expect(d.apiKeyPreview).toBeUndefined();
    expect(e.apiKey).toBe('');
    expect(e.apiKeyPreview).toBeUndefined();
  });

  it('resolves stored values for runtime use', () => {
    const encrypted = encryptConfigSecrets(endpointsWith([{ name: 'A', apiKey: 'sk-runtime' }]))
      .endpoints.custom[0] as Record<string, string>;

    expect(resolveConfigSecret(encrypted.apiKey)).toBe('sk-runtime');
    expect(resolveConfigSecret('sk-plain')).toBe('sk-plain');
    expect(resolveConfigSecret('${OPENROUTER_KEY}')).toBe('${OPENROUTER_KEY}');
    expect(resolveConfigSecret('v3:provider-literal-token')).toBe('v3:provider-literal-token');
    expect(resolveConfigSecret('v3:not-valid-ciphertext')).toBe('v3:not-valid-ciphertext');

    const resolved = resolveCustomEndpointSecrets({ name: 'A', apiKey: encrypted.apiKey });
    expect(resolved.apiKey).toBe('sk-runtime');
    const passthrough = { name: 'B', apiKey: 'user_provided' };
    expect(resolveCustomEndpointSecrets(passthrough)).toBe(passthrough);
  });
});

describe('MCP server secrets (record registry)', () => {
  type Server = {
    url?: string;
    apiKey?: Record<string, string>;
    oauth?: Record<string, string>;
  };
  const server = (overrides: Server = {}): Server => ({
    url: 'https://mcp.example.com/mcp',
    apiKey: { source: 'admin', authorization_type: 'bearer', key: 'sk-mcp-super-secret-key' },
    oauth: {
      client_id: 'client',
      client_secret: 'oauth-client-secret-value',
      authorization_url: 'https://auth.example.com/authorize',
      token_url: 'https://auth.example.com/token',
    },
    ...overrides,
  });
  const serversOf = (root: unknown) =>
    (root as { mcpServers: Record<string, Server> }).mcpServers as Record<string, Server>;

  it('encrypts both credentials on whole-document writes, with masked previews', () => {
    const out = serversOf(encryptConfigSecrets({ mcpServers: { github: server() } })).github;

    expect(decryptV3(out.apiKey!.key)).toBe('sk-mcp-super-secret-key');
    expect(out.apiKey!.keyPreview).toBe('...-key');
    expect(decryptV3(out.oauth!.client_secret)).toBe('oauth-client-secret-value');
    expect(out.oauth!.client_secretPreview).toBe('...alue');
    expect(out.url).toBe('https://mcp.example.com/mcp');
  });

  it('encrypts object writes at every level of a field map, and the dotted secret path', () => {
    const out = encryptConfigSecretFields({
      mcpServers: { a: server() },
      'mcpServers.b': server(),
      'mcpServers.c.apiKey': { source: 'admin', authorization_type: 'bearer', key: 'sk-c-key' },
      'mcpServers.d.oauth': { client_id: 'x', client_secret: 'sk-d-secret' },
      'mcpServers.e.apiKey.key': 'sk-e-dotted-secret-0001',
    });

    expect(decryptV3(serversOf(out).a.apiKey!.key)).toBe('sk-mcp-super-secret-key');
    expect(decryptV3((out['mcpServers.b'] as Server).oauth!.client_secret)).toBe(
      'oauth-client-secret-value',
    );
    const c = out['mcpServers.c.apiKey'] as Record<string, string>;
    expect(decryptV3(c.key)).toBe('sk-c-key');
    expect(c.keyPreview).toBe('********');
    const d = out['mcpServers.d.oauth'] as Record<string, string>;
    expect(decryptV3(d.client_secret)).toBe('sk-d-secret');
    expect(decryptV3(out['mcpServers.e.apiKey.key'] as string)).toBe('sk-e-dotted-secret-0001');
    expect(out['mcpServers.e.apiKey.keyPreview']).toBe('...0001');
  });

  it('keeps `${ENV}` and `{{VAR}}` references readable, and clears on an empty value', () => {
    const out = serversOf(
      encryptConfigSecrets({
        mcpServers: {
          env: server({ apiKey: { source: 'admin', authorization_type: 'bearer', key: '${K}' } }),
          user: server({
            apiKey: { source: 'admin', authorization_type: 'bearer', key: '{{USER_KEY}}' },
          }),
          cleared: server({ apiKey: { source: 'admin', authorization_type: 'bearer', key: '' } }),
        },
      }),
    );

    expect(out.env.apiKey).toMatchObject({ key: '${K}', keyPreview: '' });
    expect(out.user.apiKey).toMatchObject({ key: '{{USER_KEY}}', keyPreview: '' });
    expect(out.cleared.apiKey).toMatchObject({ key: '', keyPreview: '' });
  });

  it('keeps a server name that contains a dot as one key', () => {
    const out = serversOf(encryptConfigSecrets({ mcpServers: { 'acme.tools': server() } }));
    expect(decryptV3(out['acme.tools'].apiKey!.key)).toBe('sk-mcp-super-secret-key');

    const redacted = serversOf(redactConfigSecrets({ mcpServers: { 'acme.tools': server() } }));
    expect(redacted['acme.tools'].apiKey!.key).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
  });

  it('drops arrays where a secret could hide from the traversals', () => {
    const smuggled = {
      mcpServers: {
        list: [{ apiKey: { key: 'sk-in-array' } }],
        nested: { url: 'https://x', apiKey: [{ key: 'sk-in-array' }] },
      },
    };
    expect(JSON.stringify(encryptConfigSecrets(structuredClone(smuggled)))).not.toContain(
      'sk-in-array',
    );
    expect(JSON.stringify(redactConfigSecrets(structuredClone(smuggled)))).not.toContain(
      'sk-in-array',
    );
  });

  it('rejects ciphertext, writes to previews and writes inside a secret', () => {
    const ciphertext = encryptV3('sk-real');
    expect(getConfigSecretInputError('mcpServers.a.apiKey.key', ciphertext)).toContain(
      'Encrypted config secret values',
    );
    expect(
      getConfigSecretInputError('mcpServers', { a: { oauth: { client_secret: ciphertext } } }),
    ).toContain('mcpServers.a.oauth.client_secret');
    expect(getConfigSecretInputError('mcpServers.a', { apiKey: { key: 'v3:smuggled' } })).toContain(
      'Encrypted config secret values',
    );
    expect(getConfigSecretInputError('mcpServers.a.apiKey.keyPreview', 'x')).toContain(
      'protected secret preview',
    );
    expect(getConfigSecretInputError('mcpServers.a.oauth.client_secretPreview', 'x')).toContain(
      'protected secret preview',
    );
    expect(getConfigSecretInputError('mcpServers.a.apiKey.key', 'sk-plain')).toBeNull();
    expect(isConfigSecretDescendantPath('mcpServers.a.apiKey.key.inner')).toBe(true);
    expect(isConfigSecretDescendantPath('mcpServers.a.apiKey.authorization_type')).toBe(false);
  });

  it('treats every server and the objects on the way to a secret as secret ancestors', () => {
    for (const path of [
      'mcpServers',
      'mcpServers.a',
      'mcpServers.a.apiKey',
      'mcpServers.a.oauth',
    ]) {
      expect(isConfigSecretAncestorPath(path)).toBe(true);
      expect(isConfigSecretPreservablePatch(path, {})).toBe(true);
    }
    expect(isConfigSecretAncestorPath('mcpServers.a.headers')).toBe(false);
    expect(getConfigSecretSections()).toEqual(expect.arrayContaining(['mcpServers', 'mcpConfig']));
    expect(isConfigSecretRelatedSegments(['mcpServers', 'a', 'oauth', 'client_secret'])).toBe(true);
    expect(isConfigSecretRelatedSegments(['mcpServers', 'a', 'title'])).toBe(false);
  });

  it('removes a secret and its preview together', () => {
    expect(getConfigSecretMutationPaths('mcpServers.a.apiKey.key')).toEqual([
      'mcpServers.a.apiKey.key',
      'mcpServers.a.apiKey.keyPreview',
    ]);
    expect(getConfigSecretMutationPaths('mcpServers.a.oauth.client_secret')).toEqual([
      'mcpServers.a.oauth.client_secret',
      'mcpServers.a.oauth.client_secretPreview',
    ]);
    expect(getConfigSecretMutationPaths('mcpServers.a.url')).toEqual(['mcpServers.a.url']);
  });

  describe('omit to keep', () => {
    const stored = () => encryptConfigSecrets({ mcpServers: { a: server() } });

    it('keeps stored ciphertext and previews when a whole-document write omits them', () => {
      const existing = stored();
      const kept = serversOf(
        preserveConfigSecrets(
          {
            mcpServers: {
              a: {
                url: 'https://mcp.example.com/mcp',
                apiKey: { source: 'admin', authorization_type: 'bearer' },
                oauth: { client_id: 'client' },
              },
            },
          },
          existing,
        ),
      ).a;

      expect(kept.apiKey!.key).toBe(serversOf(existing).a.apiKey!.key);
      expect(kept.apiKey!.keyPreview).toBe('...-key');
      expect(kept.oauth!.client_secret).toBe(serversOf(existing).a.oauth!.client_secret);
    });

    it('keeps them for object patches at the server and at the secret parent', () => {
      const existing = stored();
      const atServer = preserveConfigSecrets(
        { url: 'https://mcp.example.com/mcp', apiKey: { source: 'admin' } },
        existing,
        'mcpServers.a',
      ) as Server;
      expect(atServer.apiKey!.key).toBe(serversOf(existing).a.apiKey!.key);

      const atParent = preserveConfigSecrets(
        { source: 'admin', authorization_type: 'basic' },
        existing,
        'mcpServers.a.apiKey',
      ) as Record<string, string>;
      expect(atParent.key).toBe(serversOf(existing).a.apiKey!.key);
    });

    it('does not resurrect a secret whose parent the write removed, or one it cleared', () => {
      const existing = stored();
      const removed = serversOf(
        preserveConfigSecrets({ mcpServers: { a: { url: 'https://x' } } }, existing),
      ).a;
      expect(removed.apiKey).toBeUndefined();

      const cleared = serversOf(
        preserveConfigSecrets(
          encryptConfigSecrets({ mcpServers: { a: server({ apiKey: { key: '' } }) } }),
          existing,
        ),
      ).a;
      expect(cleared.apiKey).toEqual({ key: '', keyPreview: '' });
    });

    it('encrypts a legacy plaintext secret it keeps, and drops a reference the client omitted', () => {
      const kept = serversOf(
        preserveConfigSecrets(
          { mcpServers: { legacy: { apiKey: { source: 'admin' } }, ref: { apiKey: {} } } },
          {
            mcpServers: {
              legacy: { apiKey: { key: 'sk-legacy-plaintext-0002' } },
              ref: { apiKey: { key: '${REF_KEY}' } },
            },
          },
        ),
      );
      expect(decryptV3(kept.legacy.apiKey!.key)).toBe('sk-legacy-plaintext-0002');
      expect(kept.legacy.apiKey!.keyPreview).toBe('...0002');
      expect(kept.ref.apiKey).toEqual({});
    });
  });

  describe('rename carry', () => {
    it('copies a stored secret to the renamed server and leaves the source alone', () => {
      const existing = encryptConfigSecrets({ mcpServers: { old: server() } });
      const next = { mcpServers: { renamed: { url: 'https://mcp.example.com/mcp', apiKey: {} } } };

      carryRenamedConfigSecrets(next, existing, [
        { path: 'mcpServers', previousName: 'old', name: 'renamed' },
      ]);

      const renamed = serversOf(next).renamed;
      expect(renamed.apiKey!.key).toBe(serversOf(existing).old.apiKey!.key);
      expect(renamed.apiKey!.keyPreview).toBe('...-key');
      expect(renamed.oauth).toBeUndefined();
      expect(serversOf(existing).old.apiKey!.key).toMatch(/^v3:/);
    });

    it('carries into a patch at the server path and never overwrites a supplied secret', () => {
      const existing = encryptConfigSecrets({ mcpServers: { old: server() } });
      const value: Server = {
        oauth: { client_id: 'client' },
        apiKey: { key: 'v3:new-ciphertext' },
      };

      carryRenamedConfigSecrets(
        value,
        existing,
        [{ path: 'mcpServers', previousName: 'old', name: 'renamed' }],
        'mcpServers.renamed',
      );

      expect(value.oauth!.client_secret).toBe(serversOf(existing).old.oauth!.client_secret);
      expect(value.apiKey!.key).toBe('v3:new-ciphertext');
    });
  });
});

describe('custom endpoint secrets of keyed paths and renames', () => {
  type Entry = Record<string, string>;
  const customOf = (root: unknown): Entry[] =>
    (root as { endpoints: { custom: Entry[] } }).endpoints.custom;
  const entry = (name: string, extra: Entry = {}): Entry => ({
    name,
    baseURL: `https://${name}.example.com/v1`,
    ...extra,
  });

  it('refuses a keyed path to an entry secret or its preview, and nothing else of the entry', () => {
    for (const field of ['apiKey', 'apiKeyPreview']) {
      expect(getConfigSecretInputError(`endpoints.custom["My EP"].${field}`, undefined)).toMatch(
        /by entry key/,
      );
    }
    expect(getConfigSecretInputError('endpoints.custom["My EP"]', undefined)).toBeNull();
    expect(getConfigSecretInputError('endpoints.custom["My EP"].headers.X', undefined)).toBeNull();
    expect(getConfigSecretInputError('endpoints.custom["apiKey"]', undefined)).toBeNull();
  });

  it('checks a path holding `["` that names no entry by key as the plain path it is', () => {
    const ciphertext = encryptV3('sk-real');
    for (const server of ['mcpServers.ab', 'mcpServers.a["b']) {
      expect(getConfigSecretInputError(`${server}.oauth.client_secret`, ciphertext)).toContain(
        'Encrypted config secret values',
      );
      expect(getConfigSecretInputError(`${server}.oauth.client_secretPreview`, 'x')).toContain(
        'protected secret preview',
      );
      expect(getConfigSecretInputError(server, { oauth: { client_secret: ciphertext } })).toContain(
        'Encrypted config secret values',
      );
    }
    expect(getConfigSecretInputError('modelSpecs.list["x"].apiKey', undefined)).toBeNull();
  });

  it('carries a stored endpoint key with its preview to the entry a rename names, by folded name', () => {
    const existing = encryptConfigSecrets({
      endpoints: { custom: [entry('Ollama', { apiKey: 'sk-ollama-0001' })] },
    });
    const next = { endpoints: { custom: [entry('local'), entry('other')] } };

    carryRenamedConfigSecrets(next, existing, [
      { path: 'endpoints.custom', previousName: 'ollama', name: 'local' },
    ]);

    const [stored] = customOf(existing);
    expect(customOf(next)[0]).toEqual({
      ...entry('local'),
      apiKey: stored.apiKey,
      apiKeyPreview: stored.apiKeyPreview,
    });
    expect(customOf(next)[1]).toEqual(entry('other'));
  });

  it('carries into a patch of the array, never over an entered key, and never a reference', () => {
    const existing = {
      endpoints: {
        custom: [
          entry('legacy', { apiKey: 'sk-legacy-plaintext-0002' }),
          entry('ref', { apiKey: '${REF_KEY}' }),
          entry('kept', { apiKey: 'sk-kept-0003' }),
        ],
      },
    };
    const value = [entry('a'), entry('b'), entry('c', { apiKey: 'v3:entered' })];

    carryRenamedConfigSecrets(
      value,
      existing,
      [
        { path: 'endpoints.custom', previousName: 'legacy', name: 'a' },
        { path: 'endpoints.custom', previousName: 'ref', name: 'b' },
        { path: 'endpoints.custom', previousName: 'kept', name: 'c' },
      ],
      'endpoints.custom',
    );

    expect(decryptV3(value[0].apiKey)).toBe('sk-legacy-plaintext-0002');
    expect(value[0].apiKeyPreview).toBe('...0002');
    expect(value[1].apiKey).toBeUndefined();
    expect(value[2].apiKey).toBe('v3:entered');
  });
});

describe('Azure OpenAI group secrets (array registry)', () => {
  const group = (name: string, apiKey?: string) => ({
    group: name,
    instanceName: `${name}-instance`,
    models: { 'gpt-4o': true },
    ...(apiKey !== undefined && { apiKey }),
  });
  const groupsOf = (root: unknown) =>
    (root as { endpoints: { azureOpenAI: { groups: Array<Record<string, string>> } } }).endpoints
      .azureOpenAI.groups;

  it('encrypts each group key with a preview and keeps references readable', () => {
    const out = groupsOf(
      encryptConfigSecrets({
        endpoints: {
          azureOpenAI: {
            groups: [
              group('east', 'azure-key-east-0000000000'),
              group('west', '${AZURE_WEST_KEY}'),
              group('user', 'user_provided'),
            ],
          },
        },
      }),
    );

    expect(decryptV3(out[0].apiKey)).toBe('azure-key-east-0000000000');
    expect(out[0].apiKeyPreview).toBe('...0000');
    expect(out[1].apiKey).toBe('${AZURE_WEST_KEY}');
    expect(out[2].apiKey).toBe('user_provided');
  });

  it('encrypts a patch of the endpoint object, whose path is now a secret ancestor', () => {
    expect(isConfigSecretAncestorPath('endpoints.azureOpenAI')).toBe(true);
    const out = encryptConfigSecretFields({
      'endpoints.azureOpenAI': { groups: [group('east', 'azure-key-east-0000000000')] },
    });
    const groups = (out['endpoints.azureOpenAI'] as { groups: Array<Record<string, string>> })
      .groups;
    expect(decryptV3(groups[0].apiKey)).toBe('azure-key-east-0000000000');
  });

  it('keeps an omitted key by group name', () => {
    const existing = encryptConfigSecrets({
      endpoints: { azureOpenAI: { groups: [group('east', 'azure-key-east-0000000000')] } },
    });
    const kept = groupsOf(
      preserveConfigSecrets({ endpoints: { azureOpenAI: { groups: [group('east')] } } }, existing),
    );
    expect(kept[0].apiKey).toBe(groupsOf(existing)[0].apiKey);
    expect(kept[0].apiKeyPreview).toBe('...0000');
  });

  it('refuses indexed and named writes under the group array', () => {
    expect(getConfigSecretInputError('endpoints.azureOpenAI.groups.0.apiKey', 'x')).toContain(
      'Cannot write secret fields by array index',
    );
    expect(getConfigSecretInputError('endpoints.azureOpenAI.groups.east', {})).toContain(
      'is an array and has no named fields',
    );
  });

  it('redacts YAML literal group keys in a resolved config with the fixed mask', () => {
    const redacted = groupsOf(
      redactConfigSecrets({
        endpoints: {
          azureOpenAI: {
            groups: [group('east', 'yaml-literal-azure-key'), group('west', '${AZ_KEY}')],
          },
        },
      }),
    );
    expect(redacted[0].apiKey).toBeUndefined();
    expect(redacted[0].apiKeyPreview).toBe(UNPREVIEWED_SECRET_MASK);
    expect(redacted[1].apiKey).toBe('${AZ_KEY}');
  });
});

describe('Azure OpenAI groupMap secrets (record registry)', () => {
  type Group = Record<string, string>;
  const groupMapOf = (root: unknown) =>
    (root as { endpoints: { azureOpenAI: { groupMap: Record<string, Group> } } }).endpoints
      .azureOpenAI.groupMap;

  it('encrypts a group key with a preview at every depth a write can name', () => {
    const plain = 'azure-groupmap-key-00001234';
    const out = encryptConfigSecretFields({
      endpoints: { azureOpenAI: { groupMap: { a: { apiKey: plain, instanceName: 'a' } } } },
      'endpoints.azureOpenAI': { groupMap: { b: { apiKey: plain } } },
      'endpoints.azureOpenAI.groupMap': { c: { apiKey: plain } },
      'endpoints.azureOpenAI.groupMap.d': { apiKey: plain },
      'endpoints.azureOpenAI.groupMap.e.apiKey': plain,
    });
    const stored = [
      groupMapOf(out).a,
      (out['endpoints.azureOpenAI'] as { groupMap: Record<string, Group> }).groupMap.b,
      (out['endpoints.azureOpenAI.groupMap'] as Record<string, Group>).c,
      out['endpoints.azureOpenAI.groupMap.d'] as Group,
      {
        apiKey: out['endpoints.azureOpenAI.groupMap.e.apiKey'] as string,
        apiKeyPreview: out['endpoints.azureOpenAI.groupMap.e.apiKeyPreview'] as string,
      },
    ];

    for (const group of stored) {
      expect(decryptV3(group.apiKey)).toBe(plain);
      expect(group.apiKeyPreview).toBe('...1234');
    }
    expect(groupMapOf(out).a.instanceName).toBe('a');
  });

  it('keeps `${VAR}` and `user_provided` readable, and refuses ciphertext and previews', () => {
    const out = groupMapOf(
      encryptConfigSecrets({
        endpoints: {
          azureOpenAI: { groupMap: { a: { apiKey: '${AZ_KEY}' }, b: { apiKey: 'user_provided' } } },
        },
      }),
    );
    expect(out.a.apiKey).toBe('${AZ_KEY}');
    expect(out.b.apiKey).toBe('user_provided');
    expect(
      getConfigSecretInputError('endpoints.azureOpenAI.groupMap.a.apiKey', encryptV3('x')),
    ).toContain('Encrypted config secret values cannot be submitted');
    expect(getConfigSecretInputError('endpoints.azureOpenAI.groupMap.a.apiKeyPreview', 'x')).toBe(
      'Cannot write protected secret preview path: endpoints.azureOpenAI.groupMap.a.apiKeyPreview',
    );
    expect(
      getConfigSecretInputError('endpoints.azureOpenAI', {
        groupMap: { a: { apiKey: encryptV3('x') } },
      }),
    ).toContain('endpoints.azureOpenAI.groupMap.a.apiKey');
  });

  it('keeps an omitted key, and encrypts legacy plaintext on the way', () => {
    const existing = {
      endpoints: {
        azureOpenAI: {
          groupMap: {
            a: { apiKey: encryptV3('azure-key-a'), apiKeyPreview: '...ey-a', instanceName: 'a' },
            legacy: { apiKey: 'legacy-plaintext-azure-key', instanceName: 'l' },
          },
        },
      },
    };
    const kept = groupMapOf(
      preserveConfigSecrets(
        { endpoints: { azureOpenAI: { groupMap: { a: { instanceName: 'a2' }, legacy: {} } } } },
        existing,
      ),
    );
    const patched = preserveConfigSecrets(
      { instanceName: 'a3' },
      existing,
      'endpoints.azureOpenAI.groupMap.a',
    ) as Group;

    expect(kept.a).toEqual({
      apiKey: groupMapOf(existing).a.apiKey,
      apiKeyPreview: '...ey-a',
      instanceName: 'a2',
    });
    expect(decryptV3(kept.legacy.apiKey)).toBe('legacy-plaintext-azure-key');
    expect(kept.legacy.apiKeyPreview).toBe('...-key');
    expect(patched.apiKey).toBe(groupMapOf(existing).a.apiKey);
  });

  it('redacts stored ciphertext and YAML literals, leaving references readable', () => {
    const redacted = groupMapOf(
      redactConfigSecrets({
        endpoints: {
          azureOpenAI: {
            groupMap: {
              stored: { apiKey: encryptV3('azure-key'), apiKeyPreview: '...-key' },
              yaml: { apiKey: 'yaml-literal-azure-key', instanceName: 'y' },
              env: { apiKey: '${AZURE_API_KEY}' },
            },
            modelGroupMap: { 'gpt-4o': { group: 'yaml' } },
          },
        },
      }),
    );

    expect(redacted).toEqual({
      stored: { apiKeyPreview: '...-key' },
      yaml: { apiKeyPreview: UNPREVIEWED_SECRET_MASK, instanceName: 'y' },
      env: { apiKey: '${AZURE_API_KEY}' },
    });
  });
});

describe('fixed-mask previews for unpreviewed secrets (BE-8)', () => {
  it('masks a YAML literal scalar secret without deriving anything from it', () => {
    const redacted = redactConfigSecrets({
      ocr: { apiKey: 'yaml-literal-ocr-key-1234', mistralModel: 'm' },
    }) as { ocr: Record<string, string> };
    expect(redacted.ocr).toEqual({ apiKeyPreview: UNPREVIEWED_SECRET_MASK, mistralModel: 'm' });
  });

  it('masks a placeholder in a field that does not keep placeholders, never a suffix of it', () => {
    const redacted = redactConfigSecrets({
      langfuse: { publicKey: 'pk', secretKey: '${LANGFUSE_SECRET_KEY}' },
    }) as { langfuse: Record<string, string> };
    expect(redacted.langfuse.secretKeyPreview).toBe(UNPREVIEWED_SECRET_MASK);
    expect(JSON.stringify(redacted)).not.toContain('KEY}');
  });

  it('leaves stored previews, readable references and empty values alone', () => {
    const redacted = redactConfigSecrets({
      ocr: { apiKey: '${OCR_API_KEY}' },
      webSearch: { serperApiKey: 'v3:abc:def', serperApiKeyPreview: '...abcd', jinaApiKey: '' },
      mcpServers: {
        a: { apiKey: { key: '${K}' } },
        b: { apiKey: { key: 'v3:abc:def', keyPreview: '...wxyz' } },
        c: { apiKey: { key: '' } },
        yaml: { oauth: { client_secret: 'yaml-literal' } },
      },
    }) as Record<string, Record<string, unknown>>;

    expect(redacted.ocr).toEqual({ apiKey: '${OCR_API_KEY}' });
    expect(redacted.webSearch).toEqual({ serperApiKeyPreview: '...abcd' });
    expect(redacted.mcpServers).toEqual({
      a: { apiKey: { key: '${K}' } },
      b: { apiKey: { keyPreview: '...wxyz' } },
      c: { apiKey: { key: '' } },
      yaml: { oauth: { client_secretPreview: UNPREVIEWED_SECRET_MASK } },
    });
  });

  it('redacts the resolved mcpConfig like the mcpServers section', () => {
    type Server = { apiKey?: Record<string, string>; oauth?: Record<string, string> };
    const redacted = redactConfigSecrets({
      mcpConfig: {
        a: { apiKey: { key: 'plaintext-after-decrypt', keyPreview: '...rypt' } },
        b: { oauth: { client_secret: 'yaml-literal' } },
      },
    }) as { mcpConfig: Record<string, Server> };

    expect(redacted.mcpConfig.a.apiKey).toEqual({ keyPreview: '...rypt' });
    expect(redacted.mcpConfig.b.oauth).toEqual({ client_secretPreview: UNPREVIEWED_SECRET_MASK });
  });
});

describe('resolveRuntimeConfigSecrets', () => {
  it('decrypts MCP credentials and Azure group keys, copying only what changes', () => {
    const untouched = { url: 'https://plain.example/mcp', apiKey: { key: '${K}' } };
    const yamlGroup = { apiKey: '${AZURE_YAML_KEY}', instanceName: 'yaml' };
    const config = {
      interfaceConfig: { prompts: true },
      mcpConfig: {
        stored: {
          url: 'https://mcp.example.com/mcp',
          apiKey: { source: 'admin', key: encryptV3('sk-runtime-key'), keyPreview: '...-key' },
          oauth: { client_id: 'c', client_secret: encryptV3('runtime-oauth-secret') },
        },
        untouched,
      },
      endpoints: {
        azureOpenAI: {
          groups: [{ group: 'east', apiKey: encryptV3('azure-runtime-key') }],
          groupMap: {
            west: { apiKey: encryptV3('azure-groupmap-runtime-key'), instanceName: 'west' },
            yaml: yamlGroup,
          },
        },
      },
    };
    const snapshot = structuredClone(config);

    const resolved = resolveRuntimeConfigSecrets(config);

    expect(resolved.mcpConfig.stored.apiKey.key).toBe('sk-runtime-key');
    expect(resolved.mcpConfig.stored.oauth.client_secret).toBe('runtime-oauth-secret');
    expect(resolved.endpoints.azureOpenAI.groups[0].apiKey).toBe('azure-runtime-key');
    expect(resolved.endpoints.azureOpenAI.groupMap.west.apiKey).toBe('azure-groupmap-runtime-key');
    expect(resolved.endpoints.azureOpenAI.groupMap.yaml).toBe(yamlGroup);
    expect(resolved.mcpConfig.untouched).toBe(untouched);
    expect(resolved.interfaceConfig).toBe(config.interfaceConfig);
    expect(config).toEqual(snapshot);
  });

  it('gives an empty credential, never ciphertext, when decryption fails', () => {
    /**
     * AES-CTR decrypts any well-formed payload, so a failure only comes from the key itself (a
     * misconfigured `CREDS_KEY`); an isolated copy of the module stands in for that.
     */
    const warn = jest.fn();
    jest.isolateModules(() => {
      jest.doMock('@librechat/data-schemas', () => ({
        ...jest.requireActual('@librechat/data-schemas'),
        logger: { warn, error: jest.fn(), info: jest.fn(), debug: jest.fn() },
        decryptV3: () => {
          throw new Error('Invalid key length');
        },
      }));
      const isolated = jest.requireActual<typeof import('./secrets')>('./secrets');
      const resolved = isolated.resolveRuntimeConfigSecrets({
        mcpConfig: { a: { apiKey: { key: `v3:${'0'.repeat(32)}:abcdef` } } },
      });
      expect(resolved.mcpConfig.a.apiKey.key).toBe('');
    });
    expect(warn).toHaveBeenCalledWith(
      '[adminConfig] Failed to decrypt config secret',
      expect.any(Error),
    );
  });

  it('returns the config itself when it carries no ciphertext', () => {
    const config = { mcpConfig: { a: { apiKey: { key: '${K}' } } }, endpoints: {} };
    expect(resolveRuntimeConfigSecrets(config)).toBe(config);
  });
});

describe('Resolved config secrets (Azure groups and the Vertex service key)', () => {
  const SERVICE_KEY_JSON =
    '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----x"}';

  it('removes literal Azure group keys from groupMap, merged groups and the raw YAML copy', () => {
    const azure = () => ({
      groups: [
        { group: 'east', apiKey: 'azure-literal-east-key', instanceName: 'east' },
        { group: 'west', apiKey: '${WEST_API_KEY}', instanceName: 'west' },
        { group: 'user', apiKey: 'user_provided', instanceName: 'user' },
        { group: 'blank', apiKey: '', instanceName: 'blank' },
      ],
      groupMap: {
        east: {
          apiKey: 'azure-literal-east-key',
          instanceName: 'east',
          models: { 'gpt-4o': true },
        },
        west: { apiKey: ' ${WEST_API_KEY} ', instanceName: 'west' },
        user: { apiKey: 'user_provided', instanceName: 'user' },
      },
    });
    const resolved = redactResolvedConfigSecrets({
      endpoints: { azureOpenAI: azure() },
      config: { endpoints: { azureOpenAI: azure() } },
    });
    redactResolvedConfigSecrets(resolved.config);

    expect(JSON.stringify(resolved)).not.toContain('azure-literal-east-key');
    for (const target of [resolved.endpoints.azureOpenAI, resolved.config.endpoints.azureOpenAI]) {
      expect(target.groups.map((group) => group.apiKey)).toEqual([
        undefined,
        '${WEST_API_KEY}',
        'user_provided',
        '',
      ]);
      expect(target.groups[0]).toEqual({ group: 'east', instanceName: 'east' });
    }
    expect(resolved.endpoints.azureOpenAI.groupMap).toEqual({
      east: { instanceName: 'east', models: { 'gpt-4o': true } },
      west: { apiKey: ' ${WEST_API_KEY} ', instanceName: 'west' },
      user: { apiKey: 'user_provided', instanceName: 'user' },
    });
  });

  it('removes the Vertex service key unless it is an unresolved environment reference', () => {
    const resolved = redactResolvedConfigSecrets({
      endpoints: {
        anthropic: {
          vertex: { serviceKeyFile: SERVICE_KEY_JSON, region: 'us-east5' },
          vertexConfig: { serviceKeyFile: '/secrets/vertex.json', region: 'us-east5' },
        },
      },
    });
    expect(resolved.endpoints.anthropic).toEqual({
      vertex: { region: 'us-east5' },
      vertexConfig: { region: 'us-east5' },
    });

    const referenced = redactResolvedConfigSecrets({
      endpoints: {
        anthropic: {
          vertex: { serviceKeyFile: '${GOOGLE_SERVICE_KEY_FILE}' },
          vertexConfig: { serviceKeyFile: '${GOOGLE_SERVICE_KEY_FILE}' },
        },
      },
    });
    expect(referenced.endpoints.anthropic.vertex.serviceKeyFile).toBe('${GOOGLE_SERVICE_KEY_FILE}');
    expect(referenced.endpoints.anthropic.vertexConfig.serviceKeyFile).toBe(
      '${GOOGLE_SERVICE_KEY_FILE}',
    );

    const userProvided = redactResolvedConfigSecrets({
      endpoints: { anthropic: { vertex: { serviceKeyFile: 'user_provided' } } },
    });
    expect(userProvided.endpoints.anthropic.vertex).toEqual({});
  });

  it('fails closed on malformed shapes: non-string values and swapped containers', () => {
    const resolved = redactResolvedConfigSecrets({
      endpoints: {
        azureOpenAI: {
          groups: { east: { apiKey: 'azure-literal-in-record' } },
          groupMap: [{ apiKey: 'azure-literal-in-array' }, { apiKey: { nested: 'object-key' } }],
        },
        anthropic: { vertex: { serviceKeyFile: { private_key: 'object-key' } } },
      },
    });

    expect(JSON.stringify(resolved)).not.toMatch(/azure-literal|object-key/);
  });

  it('leaves configs without these endpoints, and unrelated fields, untouched', () => {
    const config = {
      endpoints: { custom: [{ name: 'A', apiKey: 'custom-literal' }], azureOpenAI: null },
      speech: { tts: { openai: { apiKey: 'speech-literal' } } },
    };
    expect(redactResolvedConfigSecrets(structuredClone(config))).toEqual(config);
    expect(redactResolvedConfigSecrets(null)).toBeNull();
    expect(redactResolvedConfigSecrets('text')).toBe('text');
  });
});

describe('isConfigSecretKeyRename', () => {
  it('refuses a rename that would move a value onto or off a literal secret location', () => {
    expect(isConfigSecretKeyRename(['webSearch'], 'serperApiKey', 'other')).toBe(true);
    expect(isConfigSecretKeyRename(['webSearch'], 'other', 'serperApiKeyPreview')).toBe(true);
    expect(isConfigSecretKeyRename(['speech', 'tts'], 'openai', 'mine')).toBe(true);
    expect(isConfigSecretKeyRename(['langfuse'], 'displaySecretKey', 'x')).toBe(true);
  });

  it('refuses a rename inside a secret value', () => {
    expect(isConfigSecretKeyRename(['webSearch', 'serperApiKey'], 'a', 'b')).toBe(true);
  });

  it('allows renames that never touch a registered location', () => {
    expect(isConfigSecretKeyRename(['mcpServers'], 'a', 'b')).toBe(false);
    expect(isConfigSecretKeyRename(['mcpServers', 'a', 'headers'], 'X-Old', 'X-New')).toBe(false);
    expect(isConfigSecretKeyRename(['webSearch'], 'firecrawlOptions', 'other')).toBe(false);
    expect(
      isConfigSecretKeyRename(['endpoints', 'bedrock', 'inferenceProfiles'], 'us.a', 'eu.a'),
    ).toBe(false);
  });
});
