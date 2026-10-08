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
let isConfigSecretDescendantPath: typeof import('./secrets').isConfigSecretDescendantPath;
let preserveConfigSecrets: typeof import('./secrets').preserveConfigSecrets;
let redactConfigSecrets: typeof import('./secrets').redactConfigSecrets;
let resolveConfigSecret: typeof import('./secrets').resolveConfigSecret;
let resolveCustomEndpointSecrets: typeof import('./secrets').resolveCustomEndpointSecrets;
let decryptV3: typeof import('@librechat/data-schemas').decryptV3;

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
    isConfigSecretDescendantPath,
    preserveConfigSecrets,
    redactConfigSecrets,
    resolveConfigSecret,
    resolveCustomEndpointSecrets,
  } = await import('./secrets'));
  ({ decryptV3 } = await import('@librechat/data-schemas'));
});

describe('Langfuse config secrets', () => {
  it('encrypts direct field writes and stores a display secret key', () => {
    const out = encryptConfigSecretFields({
      'langfuse.publicKey': 'pk-lf-1',
      'langfuse.secretKey': 'sk-lf-secret',
    });

    expect(out['langfuse.secretKey']).toMatch(/^v3:/);
    expect(decryptV3(out['langfuse.secretKey'] as string)).toBe('sk-lf-secret');
    expect(out['langfuse.secretKeyPreview']).toBe('sk-lf-...cret');
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
    expect(out.langfuse.secretKeyPreview).toBe('sk-lf-...cret');
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
      secretKeyPreview: 'sk-lf-...cret',
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
    expect(redacted.langfuse).toEqual({ publicKey: 'pk-lf-1', secretKeyPreview: 'sk-lf-...old' });

    const alreadyMigrated = redactConfigSecrets({
      langfuse: {
        secretKey: 'v3:abc:def',
        secretKeyPreview: 'sk-lf-...new',
        displaySecretKey: 'sk-lf-...old',
      },
    });
    expect(alreadyMigrated.langfuse).toEqual({ secretKeyPreview: 'sk-lf-...new' });

    const encrypted = encryptConfigSecrets({
      langfuse: { secretKey: 'sk-lf-new-secret', displaySecretKey: 'sk-lf-...old' },
    }).langfuse as Record<string, string>;
    expect(encrypted.displaySecretKey).toBeUndefined();
    expect(encrypted.secretKeyPreview).toBe('sk-lf-...cret');

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
    expect(preservedLangfuse.secretKeyPreview).toBe('sk-lf-...cret');
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
    expect(getSecretPreview('sk-longer-secret-value')).toBe('sk-lon...alue');
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
      apiKeyPreview: 'sk-old...-old',
      model: 'whisper-1',
    });
    expect(redacted.ocr).toEqual({
      apiKey: '${OCR_API_KEY}',
      mistralModel: 'mistral-ocr-latest',
    });
    expect(redacted.webSearch).toEqual({
      serperApiKeyPreview: 'sk-lite...eral',
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
    expect(entry.apiKeyPreview).toBe('sk-or-...cret');
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

  it('encrypts section and array patched values from field maps', () => {
    const viaSection = encryptConfigSecretFields({
      endpoints: { custom: [{ name: 'A', apiKey: 'sk-section-key' }] },
    });
    const sectionEntry = (viaSection.endpoints as { custom: Array<Record<string, string>> })
      .custom[0];
    expect(decryptV3(sectionEntry.apiKey)).toBe('sk-section-key');
    expect(sectionEntry.apiKeyPreview).toBe('sk-sec...-key');

    const viaArray = encryptConfigSecretFields({
      'endpoints.custom': [{ name: 'A', apiKey: 'sk-array-key0' }],
    });
    const arrayEntry = (viaArray['endpoints.custom'] as Array<Record<string, string>>)[0];
    expect(decryptV3(arrayEntry.apiKey)).toBe('sk-array-key0');
    expect(arrayEntry.apiKeyPreview).toBe('sk-arr...key0');
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
    expect(openRouter.apiKeyPreview).toBe('sk-or-...cret');
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
    expect(legacy.apiKeyPreview).toBe('sk-leg...text');
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
    expect(a.apiKeyPreview).toBe('sk-a...key');
    expect(b.apiKey).toBeUndefined();
    expect(c.apiKey).toBe('user_provided');
    expect(d.apiKey).toBe('${OPENROUTER_KEY}');
    expect(e.apiKey).toBe('');
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
