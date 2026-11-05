process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import type { EnvReferencePolicy } from './allowlist';

type Allowlist = typeof import('./allowlist');

/** Loaded after `CREDS_KEY` is set: the encryption key is read when data-schemas loads. */
let encryptV3: typeof import('@librechat/data-schemas').encryptV3;
let loadWebSearchConfig: typeof import('@librechat/data-schemas').loadWebSearchConfig;
let parseEnvAllowlist: Allowlist['parseEnvAllowlist'];
let getEnvReferenceIssues: Allowlist['getEnvReferenceIssues'];
let neutralizeEnvReferences: Allowlist['neutralizeEnvReferences'];
let collectEnvReferenceNames: Allowlist['collectEnvReferenceNames'];
let createEnvReferencePolicy: Allowlist['createEnvReferencePolicy'];
let isLiteralTextPath: Allowlist['isLiteralTextPath'];
let ENV_LITERAL_TEXT_PATHS: Allowlist['ENV_LITERAL_TEXT_PATHS'];
let ENV_REFERENCE_NOT_ALLOWED: string;

beforeAll(async () => {
  ({ encryptV3, loadWebSearchConfig } = await import('@librechat/data-schemas'));
  ({
    parseEnvAllowlist,
    getEnvReferenceIssues,
    neutralizeEnvReferences,
    collectEnvReferenceNames,
    createEnvReferencePolicy,
    isLiteralTextPath,
    ENV_LITERAL_TEXT_PATHS,
    ENV_REFERENCE_NOT_ALLOWED,
  } = await import('./allowlist'));
});

const yaml = {
  endpoints: {
    custom: [{ name: 'Gateway', apiKey: '${GATEWAY_KEY}', baseURL: 'https://${GATEWAY_HOST}/v1' }],
  },
  mcpServers: { github: { url: 'https://api.github.com/mcp', headers: { A: 'Bearer ${GH_PAT}' } } },
};

describe('parseEnvAllowlist', () => {
  it('splits names on commas and whitespace and drops empties', () => {
    expect(parseEnvAllowlist(' A_KEY, B_KEY\nC_KEY ,, ')).toEqual(['A_KEY', 'B_KEY', 'C_KEY']);
    expect(parseEnvAllowlist(undefined)).toEqual([]);
    expect(parseEnvAllowlist('')).toEqual([]);
  });
});

describe('createEnvReferencePolicy', () => {
  it('collects every name librechat.yaml references, embedded ones included', () => {
    expect([...collectEnvReferenceNames(yaml)].sort()).toEqual([
      'GATEWAY_HOST',
      'GATEWAY_KEY',
      'GH_PAT',
    ]);
  });

  it('allows YAML names, endpoint credential names and the extra list, nothing else', () => {
    const policy = createEnvReferencePolicy({ config: yaml, allowlist: ['EXTRA_NAME'] });
    const anywhere = ['endpoints', 'custom', '0', 'headers', 'X-Key'];

    expect(policy.allows('GATEWAY_KEY', anywhere)).toBe(true);
    expect(policy.allows('GH_PAT', anywhere)).toBe(true);
    expect(policy.allows('OPENAI_API_KEY', anywhere)).toBe(true);
    expect(policy.allows('BEDROCK_AWS_SECRET_ACCESS_KEY', anywhere)).toBe(true);
    expect(policy.allows('EXTRA_NAME', anywhere)).toBe(true);
    expect(policy.allows('MEILI_HTTP_ADDR', anywhere)).toBe(false);
    expect(policy.allows('HOME', anywhere)).toBe(false);
  });

  it('allows the OCR key reference loading fills in, only where it fills it in', () => {
    const configured = createEnvReferencePolicy({
      config: { ocr: { baseURL: 'https://ocr.internal.example/v1' } },
    });
    const keyed = createEnvReferencePolicy({
      config: { ocr: { apiKey: '${OCR_GATEWAY_KEY}', baseURL: 'https://ocr.internal.example' } },
    });
    const ocrKey = ['ocr', 'apiKey'];

    expect(configured.allows('OCR_API_KEY', ocrKey)).toBe(true);
    expect(configured.allows('OCR_API_KEY', ['endpoints', 'custom', '0', 'apiKey'])).toBe(false);
    expect(keyed.allows('OCR_GATEWAY_KEY', ['speech', 'tts', 'openai', 'url'])).toBe(true);
    expect(keyed.allows('OCR_API_KEY', ocrKey)).toBe(false);
    expect(createEnvReferencePolicy({ config: yaml }).allows('OCR_API_KEY', ocrKey)).toBe(false);
  });

  it('allows the web search defaults loading fills in, each at its own field only', () => {
    const policy = createEnvReferencePolicy({ config: yaml });
    const configured = createEnvReferencePolicy({
      config: { webSearch: { searxngInstanceUrl: 'https://search.internal.example' } },
    });
    const instanceUrl = ['webSearch', 'searxngInstanceUrl'];

    expect(policy.allows('SEARXNG_INSTANCE_URL', instanceUrl)).toBe(true);
    expect(policy.allows('FIRECRAWL_API_KEY', ['webSearch', 'firecrawlApiKey'])).toBe(true);
    expect(policy.allows('SEARXNG_INSTANCE_URL', ['webSearch', 'firecrawlApiUrl'])).toBe(false);
    expect(policy.allows('SERPER_API_KEY', ['endpoints', 'custom', '0', 'headers', 'X'])).toBe(
      false,
    );
    expect(configured.allows('SEARXNG_INSTANCE_URL', instanceUrl)).toBe(false);
  });

  it('accepts and keeps the web search section config reads return, written back', () => {
    const policy = createEnvReferencePolicy({ config: yaml });
    const written = { webSearch: loadWebSearchConfig(undefined) };

    expect(getEnvReferenceIssues(written, policy)).toEqual([]);
    expect(neutralizeEnvReferences(written, policy)).toEqual(written);
    expect(
      getEnvReferenceIssues(
        { endpoints: { custom: [{ name: 'X', headers: { K: '${SERPER_API_KEY}' } }] } },
        policy,
      ).map(({ path }) => path),
    ).toEqual(['endpoints.custom.0.headers.K']);
  });

  describe('Vertex AI settings, which reads return resolved', () => {
    const vertexYaml = {
      ...yaml,
      endpoints: {
        ...yaml.endpoints,
        anthropic: {
          vertex: {
            projectId: '${GCP_PROJECT}',
            region: '${GCP_REGION}',
            serviceKeyFile: '${GOOGLE_SERVICE_KEY_FILE}',
            models: { 'claude-sonnet-4-6': { deploymentName: '${SONNET_DEPLOYMENT}' } },
          },
        },
      },
    };
    const projectId = ['endpoints', 'anthropic', 'vertex', 'projectId'];
    const deployment = [
      'endpoints',
      'anthropic',
      'vertex',
      'models',
      'claude-opus-4-6',
      'deploymentName',
    ];
    const keyFile = ['endpoints', 'anthropic', 'vertex', 'serviceKeyFile'];

    it('allows only the names librechat.yaml references in its own Vertex AI settings', () => {
      const policy = createEnvReferencePolicy({ config: vertexYaml, allowlist: ['EXTRA_NAME'] });

      for (const name of ['GCP_PROJECT', 'GCP_REGION', 'SONNET_DEPLOYMENT']) {
        expect(policy.allows(name, projectId)).toBe(true);
        expect(policy.allows(name, deployment)).toBe(true);
      }
      for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GATEWAY_KEY', 'EXTRA_NAME']) {
        expect(policy.allows(name, projectId)).toBe(false);
        expect(policy.allows(name, deployment)).toBe(false);
        expect(policy.allows(name, ['endpoints', 'custom', '0', 'apiKey'])).toBe(true);
      }
      expect(policy.allows('GCP_PROJECT', ['endpoints', 'anthropic', 'apiKey'])).toBe(true);
    });

    it("allows the key file's names only in the key file, which the merge keeps librechat.yaml's", () => {
      const policy = createEnvReferencePolicy({ config: vertexYaml });

      expect(policy.allows('GOOGLE_SERVICE_KEY_FILE', keyFile)).toBe(true);
      expect(policy.allows('GOOGLE_SERVICE_KEY_FILE', projectId)).toBe(false);
      expect(policy.allows('GOOGLE_SERVICE_KEY_FILE', deployment)).toBe(false);
      expect(policy.allows('GCP_PROJECT', keyFile)).toBe(true);
    });

    it('allows no reference there when librechat.yaml configures no Vertex AI', () => {
      const policy = createEnvReferencePolicy({ config: yaml });
      const layer = {
        endpoints: {
          anthropic: {
            vertex: {
              projectId: '${OPENAI_API_KEY}',
              deploymentName: 'deployment-${GATEWAY_KEY}',
              models: { 'claude-opus-4-6': { deploymentName: '${ANTHROPIC_API_KEY}' } },
            },
          },
        },
      };

      expect(getEnvReferenceIssues(layer, policy).map(({ path }) => path)).toEqual([
        'endpoints.anthropic.vertex.projectId',
        'endpoints.anthropic.vertex.deploymentName',
        'endpoints.anthropic.vertex.models.claude-opus-4-6.deploymentName',
      ]);
      expect(neutralizeEnvReferences(layer, policy)).toEqual({
        endpoints: {
          anthropic: {
            vertex: {
              projectId: '',
              deploymentName: 'deployment-',
              models: { 'claude-opus-4-6': { deploymentName: '' } },
            },
          },
        },
      });
    });
  });

  it('never allows an infrastructure secret, even when YAML or the extra list names it', () => {
    const policy = createEnvReferencePolicy({
      config: { ocr: { apiKey: '${CREDS_KEY}' } },
      allowlist: ['JWT_SECRET', 'MONGO_URI'],
    });

    expect(policy.allows('CREDS_KEY', ['ocr', 'apiKey'])).toBe(false);
    expect(policy.allows('JWT_SECRET', [])).toBe(false);
    expect(policy.allows('MONGO_URI', [])).toBe(false);
  });
});

describe('getEnvReferenceIssues', () => {
  let policy: EnvReferencePolicy;
  beforeAll(() => {
    policy = createEnvReferencePolicy({ config: yaml });
  });

  it('reports each string that references a disallowed name, by location only', () => {
    const issues = getEnvReferenceIssues(
      {
        custom: [
          { name: 'Mine', apiKey: '${GATEWAY_KEY}', baseURL: 'https://x/${OTHER_SECRET}' },
          { name: 'Theirs', headers: { 'X-Token': '${CREDS_KEY}' } },
        ],
      },
      policy,
      ['endpoints'],
    );

    expect(issues).toEqual([
      {
        path: 'endpoints.custom.0.baseURL',
        segments: ['endpoints', 'custom', '0', 'baseURL'],
        code: ENV_REFERENCE_NOT_ALLOWED,
      },
      {
        path: 'endpoints.custom.1.headers.X-Token',
        segments: ['endpoints', 'custom', '1', 'headers', 'X-Token'],
        code: ENV_REFERENCE_NOT_ALLOWED,
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain('OTHER_SECRET');
  });

  it('accepts allowed references, literals and `{{VAR}}` templates', () => {
    expect(
      getEnvReferenceIssues(
        {
          apiKey: '${OPENAI_API_KEY}',
          url: 'https://${GATEWAY_HOST}/mcp',
          key: '{{USER_TOKEN}}',
          literal: 'sk-plain',
          count: 3,
        },
        policy,
      ),
    ).toEqual([]);
  });

  /** The documented limit: the allowlist decides which names a value may name, not where it goes. */
  it('accepts an allowed name in any value, beside any host', () => {
    expect(
      getEnvReferenceIssues(
        {
          url: 'https://collector.example/${OPENAI_API_KEY}',
          headers: { Authorization: 'Bearer ${GATEWAY_KEY}' },
          apiKey: { key: '${GH_PAT}' },
        },
        policy,
        ['mcpServers', 'collector'],
      ),
    ).toEqual([]);
  });

  it('keeps a key that contains a dot as one segment', () => {
    const issues = getEnvReferenceIssues({ 'us.region': '${NOPE}' }, policy, ['x']);
    expect(issues[0].segments).toEqual(['x', 'us.region']);
  });
});

describe('neutralizeEnvReferences', () => {
  let policy: EnvReferencePolicy;
  beforeAll(() => {
    policy = createEnvReferencePolicy({ config: yaml });
  });

  it('resolves disallowed references to nothing and keeps allowed ones', () => {
    const layer = {
      endpoints: {
        custom: [
          {
            name: 'Mine',
            apiKey: '${CREDS_KEY}',
            baseURL: 'https://${GATEWAY_HOST}/${UNLISTED}',
          },
        ],
      },
    };

    expect(neutralizeEnvReferences(layer, policy)).toEqual({
      endpoints: { custom: [{ name: 'Mine', apiKey: '', baseURL: 'https://${GATEWAY_HOST}/' }] },
    });
  });

  it('returns the same objects when nothing changes, and never mutates the input', () => {
    const untouched = { ocr: { apiKey: '${GATEWAY_KEY}' }, interface: { prompts: true } };
    expect(neutralizeEnvReferences(untouched, policy)).toBe(untouched);

    const layer = { ocr: { apiKey: '${UNLISTED}' }, interface: { prompts: true } };
    const snapshot = structuredClone(layer);
    const result = neutralizeEnvReferences(layer, policy);
    expect(layer).toEqual(snapshot);
    expect(result.interface).toBe(layer.interface);
    expect(result.ocr).toEqual({ apiKey: '' });
  });

  it('leaves no reference that removing a disallowed one joins together', () => {
    const layer = {
      ocr: { baseURL: 'https://h/$${UNLISTED}{SOME_SECRET}' },
      speech: { tts: { openai: { url: 'https://h/$$${UNLISTED}{UNLISTED}{SOME_SECRET}' } } },
      webSearch: { jinaApiUrl: 'https://$${UNLISTED}{GATEWAY_HOST}/v1' },
    };

    expect(neutralizeEnvReferences(layer, policy)).toEqual({
      ocr: { baseURL: 'https://h/' },
      speech: { tts: { openai: { url: 'https://h/' } } },
      /** What is left is a reference the layer could have written itself. */
      webSearch: { jinaApiUrl: 'https://${GATEWAY_HOST}/v1' },
    });
  });

  it('judges ciphertext by its plaintext', () => {
    const disallowed = encryptV3('prefix-${UNLISTED}');
    const allowed = encryptV3('prefix-${GATEWAY_KEY}');
    const literal = encryptV3('sk-literal');

    expect(neutralizeEnvReferences({ a: disallowed, b: allowed, c: literal }, policy)).toEqual({
      a: '',
      b: allowed,
      c: literal,
    });
  });
});

describe('literal text', () => {
  const policy = () => createEnvReferencePolicy({ config: yaml });
  const prose = {
    interface: {
      customWelcome: 'Tip: JS template literals look like `${name}`',
      termsOfService: { modalContent: 'Hi ${user}' },
    },
    modelSpecs: {
      list: [
        {
          name: 'coder',
          preset: { promptPrefix: 'Prefer template literals like `${user.name}`.' },
        },
      ],
    },
    memory: { agent: { provider: 'openAI', model: 'gpt-4o', instructions: 'Keep ${x} as is' } },
    summarization: { prompt: 'Summarize ${input}', parameters: { apiKey: '${CREDS_KEY}' } },
    endpoints: { custom: [{ name: 'Gateway', titlePrompt: 'Title ${convo}', apiKey: '${X}' }] },
  };

  it('accepts `${...}` in text no reader expands, and still checks every other field', () => {
    expect(getEnvReferenceIssues(prose, policy()).map(({ path }) => path)).toEqual([
      'summarization.parameters.apiKey',
      'endpoints.custom.0.apiKey',
    ]);
    expect(getEnvReferenceIssues('Hi ${name}', policy(), ['interface', 'customWelcome'])).toEqual(
      [],
    );
  });

  it('leaves the text as written at runtime', () => {
    const out = neutralizeEnvReferences(prose, policy());
    expect(out.interface).toBe(prose.interface);
    expect(out.modelSpecs).toBe(prose.modelSpecs);
    expect(out.memory.agent.instructions).toBe('Keep ${x} as is');
    expect(out.summarization).toEqual({ prompt: 'Summarize ${input}', parameters: { apiKey: '' } });
    expect(out.endpoints.custom[0]).toEqual({
      name: 'Gateway',
      titlePrompt: 'Title ${convo}',
      apiKey: '',
    });
  });

  it('does not allow a name librechat.yaml mentions only in text', () => {
    const names = collectEnvReferenceNames({
      interface: { customWelcome: 'Hello ${SOME_SECRET}' },
      endpoints: { custom: [{ apiKey: '${GATEWAY_KEY}', titlePrompt: '${OTHER}' }] },
    });
    expect([...names]).toEqual(['GATEWAY_KEY']);
  });

  it('treats every listed prompt field as text, at exactly its path', () => {
    for (const path of ENV_LITERAL_TEXT_PATHS) {
      const segments = path.map((segment) => (segment === '*' ? '0' : segment));
      expect(isLiteralTextPath(segments)).toBe(true);
      expect(isLiteralTextPath([...segments, 'nested'])).toBe(false);
      expect(isLiteralTextPath(segments.slice(1))).toBe(false);
    }
    expect(isLiteralTextPath(['endpoints', 'openAI', 'headers', 'titlePrompt'])).toBe(false);
    expect(isLiteralTextPath(['endpoints', 'custom', '0', 'headers', 'titlePrompt'])).toBe(false);
    expect(isLiteralTextPath(['summarization', 'parameters', 'prompt'])).toBe(false);
    expect(isLiteralTextPath(['memory', 'agent', 'model_parameters', 'instructions'])).toBe(false);
  });
});

/**
 * Builds the value at `segments` (a numeric segment makes an array item) holding `value`, the way
 * an override would carry it.
 */
function nest(segments: readonly string[], value: unknown): unknown {
  if (segments.length === 0) {
    return value;
  }
  const [segment, ...rest] = segments;
  if (/^\d+$/.test(segment)) {
    const items: unknown[] = [];
    items[Number(segment)] = nest(rest, value);
    return items;
  }
  return { [segment]: nest(rest, value) };
}

describe('prompt-like key names under maps a reader expands', () => {
  /** Record maps whose keys the admin names and whose values a reader env-expands. */
  const EXPANDED_MAPS: readonly (readonly string[])[] = [
    ['mcpServers', 'leak', 'headers'],
    ['mcpServers', 'leak', 'oauth_headers'],
    ['mcpServers', 'leak', 'env'],
    ['mcpConfig', 'leak', 'headers'],
    ['mcpConfig', 'leak', 'oauth_headers'],
    ['mcpConfig', 'leak', 'env'],
    ['endpoints', 'custom', '0', 'headers'],
    ['endpoints', 'custom', '0', 'addParams'],
    ['endpoints', 'all', 'headers'],
    ['endpoints', 'openAI', 'headers'],
    ['endpoints', 'anthropic', 'headers'],
    ['endpoints', 'google', 'headers'],
    ['endpoints', 'bedrock', 'headers'],
    ['endpoints', 'bedrock', 'inferenceProfiles'],
    ['endpoints', 'agents', 'headers'],
    ['endpoints', 'assistants', 'headers'],
    ['endpoints', 'azureAssistants', 'headers'],
    ['endpoints', 'azureOpenAI', 'headers'],
    ['endpoints', 'azureOpenAI', 'groups', '0', 'additionalHeaders'],
    ['endpoints', 'azureOpenAI', 'groups', '0', 'addParams'],
    ['langfuse', 'headers'],
    ['webSearch', 'firecrawlOptions', 'headers'],
    ['summarization', 'parameters'],
    ['memory', 'agent', 'model_parameters'],
  ];
  /** Keys named like prompt fields, which inside these maps are still expanded. */
  const PROMPT_LIKE_KEYS = [
    'X-Prompt',
    'X-System-Prompt',
    'instructions',
    'prompt',
    'systemPrompt',
    'titlePrompt',
    'titlePromptTemplate',
  ];
  const cases = EXPANDED_MAPS.map((map) => ({ map, label: map.join('.') }));

  it.each(cases)('refuses ${HOME} under $label on write and resolves it to nothing', ({ map }) => {
    const policy = createEnvReferencePolicy({ config: yaml });
    for (const key of PROMPT_LIKE_KEYS) {
      const path = [...map, key];
      const issue = { path: path.join('.'), segments: path, code: ENV_REFERENCE_NOT_ALLOWED };
      expect(getEnvReferenceIssues(nest(path, '${HOME}'), policy)).toEqual([issue]);
      expect(
        getEnvReferenceIssues(nest(path.slice(2), '${HOME}'), policy, path.slice(0, 2)),
      ).toEqual([issue]);
      expect(neutralizeEnvReferences(nest(path, 'Bearer ${HOME}'), policy)).toEqual(
        nest(path, 'Bearer '),
      );
    }
  });

  it('allowlists a name librechat.yaml references only in such a map', () => {
    const names = collectEnvReferenceNames({
      mcpServers: { a: { headers: { 'X-Prompt': '${HEADER_KEY}' } } },
      endpoints: { custom: [{ headers: { 'X-System-Prompt': '${CUSTOM_HEADER_KEY}' } }] },
    });
    expect([...names].sort()).toEqual(['CUSTOM_HEADER_KEY', 'HEADER_KEY']);
  });
});

describe('Azure base URL templates', () => {
  const TEMPLATE_URL =
    'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}';
  const azure = (baseURL: string) => ({
    endpoints: {
      azureOpenAI: {
        groups: [{ group: 'east', apiKey: '${AZURE_API_KEY}', baseURL }],
        groupMap: { east: { baseURL } },
      },
    },
  });

  it('accepts and keeps `${INSTANCE_NAME}` and `${DEPLOYMENT_NAME}` in a group base URL', () => {
    const policy = createEnvReferencePolicy({ config: {} });
    expect(getEnvReferenceIssues(azure(TEMPLATE_URL), policy)).toEqual([]);
    expect(
      getEnvReferenceIssues(TEMPLATE_URL, policy, [
        'endpoints',
        'azureOpenAI',
        'groupMap',
        'east',
        'baseURL',
      ]),
    ).toEqual([]);
    const written = azure(TEMPLATE_URL);
    expect(neutralizeEnvReferences(written, policy)).toBe(written);
  });

  it('still polices every other name in that URL, and those names anywhere else', () => {
    const policy = createEnvReferencePolicy({ config: {} });
    const mixed = 'https://${INSTANCE_NAME}.example.com/${LC8_UNLISTED_NAME}';
    expect(getEnvReferenceIssues(azure(mixed), policy).map(({ path }) => path)).toEqual([
      'endpoints.azureOpenAI.groups.0.baseURL',
      'endpoints.azureOpenAI.groupMap.east.baseURL',
    ]);
    expect(neutralizeEnvReferences(azure(mixed), policy)).toEqual(
      azure('https://${INSTANCE_NAME}.example.com/'),
    );

    const elsewhere = {
      ocr: { baseURL: 'https://${INSTANCE_NAME}.example.com' },
      endpoints: { custom: [{ name: 'A', baseURL: 'https://${DEPLOYMENT_NAME}.example.com' }] },
    };
    expect(getEnvReferenceIssues(elsewhere, policy).map(({ path }) => path)).toEqual([
      'ocr.baseURL',
      'endpoints.custom.0.baseURL',
    ]);
  });

  it('does not allow those names elsewhere because librechat.yaml uses the templates', () => {
    expect([...collectEnvReferenceNames(azure(TEMPLATE_URL))]).toEqual(['AZURE_API_KEY']);
    const policy = createEnvReferencePolicy({ config: azure(TEMPLATE_URL) });
    expect(policy.allows('INSTANCE_NAME', ['ocr', 'baseURL'])).toBe(false);
  });
});

describe('opaque credentials', () => {
  const policy = () => createEnvReferencePolicy({ config: yaml });
  /** A provider token that happens to contain `${...}`. */
  const credential = 'pa${UNLISTED}ss';
  /** Keys every runtime reader uses as is once decrypted: OCR, speech, web search, Langfuse. */
  const opaque = {
    ocr: { apiKey: credential },
    speech: {
      tts: { openai: { apiKey: credential }, elevenlabs: { apiKey: credential } },
      stt: { azureOpenAI: { apiKey: credential } },
    },
    webSearch: { serperApiKey: credential, jinaApiKey: credential },
    langfuse: { secretKey: credential },
  };
  /** Keys their clients expand once decrypted (custom endpoints, Azure, MCP), or nothing reads yet. */
  const expanded = {
    endpoints: {
      custom: [{ name: 'Gateway', apiKey: credential }],
      azureOpenAI: {
        groups: [{ group: 'east', apiKey: credential }],
        groupMap: { east: { apiKey: credential } },
      },
      assistants: { apiKey: credential },
    },
    mcpServers: { tools: { apiKey: { key: credential }, oauth: { client_secret: credential } } },
  };

  it('accepts `${...}` inside a key read as is, but not a whole reference a field passes through', () => {
    expect(getEnvReferenceIssues(opaque, policy())).toEqual([]);
    expect(
      getEnvReferenceIssues(
        { ocr: { apiKey: '${UNLISTED}' }, webSearch: { serperApiKey: ' ${UNLISTED} ' } },
        policy(),
      ).map(({ path }) => path),
    ).toEqual(['ocr.apiKey', 'webSearch.serperApiKey']);
  });

  it('still checks keys their clients expand once decrypted', () => {
    expect(getEnvReferenceIssues(expanded, policy()).map(({ path }) => path)).toEqual([
      'endpoints.custom.0.apiKey',
      'endpoints.azureOpenAI.groups.0.apiKey',
      'endpoints.azureOpenAI.groupMap.east.apiKey',
      'endpoints.assistants.apiKey',
      'mcpServers.tools.apiKey.key',
      'mcpServers.tools.oauth.client_secret',
    ]);
  });

  it('matches the location by its segments, so a dotted key does not spell one', () => {
    expect(getEnvReferenceIssues({ 'ocr.apiKey': credential }, policy())).toHaveLength(1);
  });

  it("keeps an opaque key's ciphertext at runtime, and still blanks an expanded key's", () => {
    const stored = encryptV3(credential);
    const layer = {
      ocr: { apiKey: stored },
      webSearch: { jinaApiKey: stored },
      langfuse: { secretKey: stored },
      endpoints: { custom: [{ name: 'Gateway', apiKey: stored }] },
      mcpServers: { tools: { apiKey: { key: stored } } },
    };

    expect(neutralizeEnvReferences(layer, policy())).toEqual({
      ...layer,
      endpoints: { custom: [{ name: 'Gateway', apiKey: '' }] },
      mcpServers: { tools: { apiKey: { key: '' } } },
    });
  });

  /** `resolveConfigSecret` expands a stored plaintext key (legacy, or written before encryption). */
  it('still neutralizes a plaintext key stored at an opaque location', () => {
    expect(
      neutralizeEnvReferences({ speech: { tts: { openai: { apiKey: credential } } } }, policy()),
    ).toEqual({ speech: { tts: { openai: { apiKey: 'pass' } } } });
  });
});
