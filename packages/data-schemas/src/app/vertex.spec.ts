import { vertexAISchema, getVertexDeploymentName } from 'librechat-data-provider';
import type { TVertexAISchema } from 'librechat-data-provider';
import { defaultVertexModels, validateVertexConfig } from './vertex';

describe('defaultVertexModels', () => {
  /**
   * `loadEndpoints` swaps the shared Anthropic model list for the Vertex model
   * names, which fall back to these defaults when `vertex.models` is omitted.
   * A model missing here is invisible to every Vertex deployment that has not
   * enumerated models by hand.
   */
  it('includes the modern Opus family served by Vertex', () => {
    expect(defaultVertexModels).toEqual(
      expect.arrayContaining([
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
      ]),
    );
  });

  it('keeps the modern Sonnet models', () => {
    expect(defaultVertexModels).toEqual(
      expect.arrayContaining(['claude-sonnet-5', 'claude-sonnet-4-6']),
    );
  });

  it('uses bare IDs for the 4.6+ generation and @-dated IDs for older models', () => {
    const modern = defaultVertexModels.filter((model) =>
      /claude-(?:opus|sonnet)-(?:4-[6-9]|[5-9])$/.test(model),
    );
    expect(modern.length).toBeGreaterThan(0);
    modern.forEach((model) => expect(model).not.toContain('@'));

    expect(defaultVertexModels).toContain('claude-3-opus@20240229');
  });

  it('has no duplicate entries', () => {
    expect(new Set(defaultVertexModels).size).toBe(defaultVertexModels.length);
  });
});

describe('validateVertexConfig region gating', () => {
  /**
   * Specific regional endpoints serve Sonnet 4.6 and earlier only. Publishing
   * the modern defaults there would advertise models that 404 on first use.
   */
  const modern = [
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-haiku-5-5',
  ];
  const legacy = ['claude-sonnet-4-6', 'claude-3-7-sonnet-20250219', 'claude-3-opus@20240229'];

  it('drops multi-region-only defaults on a specific regional endpoint', () => {
    const config = validateVertexConfig({ region: 'us-east5' });

    modern.forEach((model) => expect(config?.modelNames).not.toContain(model));
    legacy.forEach((model) => expect(config?.modelNames).toContain(model));
  });

  it('drops them when the region comes from the schema default', () => {
    /** `region` is schema-defaulted, so an operator who omits it still lands on
     * a specific regional endpoint that cannot serve the modern models. */
    const config = validateVertexConfig(vertexAISchema.parse({}));

    expect(config?.region).toBe('us-east5');
    modern.forEach((model) => expect(config?.modelNames).not.toContain(model));
  });

  it.each(['global', 'us', 'eu', 'GLOBAL'])('keeps every default on %s', (region) => {
    const config = validateVertexConfig({ region });

    modern.forEach((model) => expect(config?.modelNames).toContain(model));
    legacy.forEach((model) => expect(config?.modelNames).toContain(model));
  });

  it('never prunes an explicit model list, even on a regional endpoint', () => {
    const config = validateVertexConfig({
      region: 'us-east5',
      models: ['claude-opus-5', 'claude-sonnet-4-6'],
    });

    expect(config?.modelNames).toEqual(['claude-opus-5', 'claude-sonnet-4-6']);
  });
});

describe('validateVertexConfig values that would leave their place in the request', () => {
  /** Starts with `${` and ends with `}`, so it reads as one reference to a greedy pattern. */
  const WRAPPED = '${VERTEX_TEST_PROJECT}/../../endpoints/5678:rawPredict#${VERTEX_TEST_PROJECT}';

  beforeEach(() => {
    process.env.VERTEX_TEST_PROJECT = 'test-project';
  });

  afterEach(() => {
    delete process.env.VERTEX_TEST_REGION;
    delete process.env.VERTEX_TEST_PROJECT;
    delete process.env.VERTEX_TEST_DEPLOYMENT;
  });

  it('refuses a deployment or model name that only wraps ${VAR} references', () => {
    const settings: Array<Partial<TVertexAISchema>> = [
      { models: { 'claude-sonnet-4-6': { deploymentName: WRAPPED } } },
      { models: [WRAPPED] },
      { models: { [WRAPPED]: true } },
      { deploymentName: WRAPPED },
    ];
    for (const vertex of settings) {
      expect(validateVertexConfig({ region: 'us-east5', ...vertex })?.isValid).toBe(false);
    }
  });

  it('refuses a model name its requests send as written, whatever the default deployment', () => {
    const settings: Array<Partial<TVertexAISchema>> = [
      { deploymentName: 'claude-sonnet-4-6', models: ['../../endpoints/5678:rawPredict#'] },
      { deploymentName: 'claude-sonnet-4-6', models: { '../x#': false } },
      { models: { 'Claude Team': true } },
    ];
    for (const vertex of settings) {
      expect(validateVertexConfig({ region: 'us-east5', ...vertex })?.isValid).toBe(false);
    }
    expect(
      validateVertexConfig({
        region: 'us-east5',
        deploymentName: 'claude-sonnet-4-6',
        models: { 'Claude Team': true, 'Claude Opus': { deploymentName: 'claude-opus-4-6' } },
      })?.isValid,
    ).toBe(true);
  });

  it("resolves each model's own deployment name, as requests send it", () => {
    process.env.VERTEX_TEST_DEPLOYMENT = 'claude-sonnet-4-6@20250929';
    const config = validateVertexConfig({
      region: 'us-east5',
      models: { team: { deploymentName: '${VERTEX_TEST_DEPLOYMENT}' } },
    });

    expect(config?.isValid).toBe(true);
    expect(config?.modelDeploymentMap).toEqual({ team: 'claude-sonnet-4-6@20250929' });
    expect(getVertexDeploymentName('team', config ?? undefined)).toBe('claude-sonnet-4-6@20250929');

    delete process.env.VERTEX_TEST_DEPLOYMENT;
    expect(
      validateVertexConfig({
        region: 'us-east5',
        models: { team: { deploymentName: '${VERTEX_TEST_DEPLOYMENT}' } },
      })?.errors,
    ).toEqual(['Vertex AI deployment name environment variable for model "team" was not found.']);
  });

  it('refuses a region, project ID or deployment name that is not one host label or path segment', () => {
    const settings: Array<Partial<TVertexAISchema>> = [
      { region: 'evil.example.com/x#' },
      { projectId: '../other-project' },
      { deploymentName: 'claude/../../x' },
      { models: { 'claude-sonnet-4-6': { deploymentName: 'a?b' } } },
    ];
    for (const vertex of settings) {
      expect(validateVertexConfig({ region: 'us-east5', ...vertex })?.isValid).toBe(false);
    }
  });

  it('accepts the forms Vertex AI uses, and checks a ${VAR} once resolved', () => {
    expect(
      validateVertexConfig({
        region: 'europe-west1',
        projectId: 'example.com:my-project',
        models: { 'claude-sonnet-4-6': { deploymentName: 'claude-sonnet-4-6@20250929' } },
      })?.isValid,
    ).toBe(true);

    process.env.VERTEX_TEST_REGION = 'us-east5';
    expect(validateVertexConfig({ region: '${VERTEX_TEST_REGION}' })?.isValid).toBe(true);
    process.env.VERTEX_TEST_REGION = 'evil.example.com/';
    expect(validateVertexConfig({ region: '${VERTEX_TEST_REGION}' })?.isValid).toBe(false);
  });
});

describe('vertexAISchema', () => {
  it('takes a ${VAR} or a valid value for the settings that build the request URL', () => {
    expect(vertexAISchema.safeParse({ region: '${VERTEX_REGION}', projectId: 'p-1' }).success).toBe(
      true,
    );
    expect(vertexAISchema.safeParse({ region: 'us-east5/../x' }).success).toBe(false);
    expect(vertexAISchema.safeParse({ projectId: 'a/b' }).success).toBe(false);
    expect(vertexAISchema.safeParse({ deploymentName: '..' }).success).toBe(false);
    expect(vertexAISchema.safeParse({ models: { m: { deploymentName: 'x#y' } } }).success).toBe(
      false,
    );
  });

  it('takes only a whole reference to one variable as a ${VAR}', () => {
    const wrapped = '${GCP_PROJECT}/../../endpoints/5678:rawPredict#${GCP_PROJECT}';
    for (const vertex of [
      { projectId: wrapped },
      { deploymentName: wrapped },
      { region: '${GCP_REGION}.example.com/#${GCP_REGION}' },
      { models: { m: { deploymentName: wrapped } } },
      { models: { m: { deploymentName: '${GCP/../x}' } } },
    ]) {
      expect(vertexAISchema.safeParse(vertex).success).toBe(false);
    }
    expect(
      vertexAISchema.safeParse({ models: { m: { deploymentName: '${GCP_DEPLOYMENT}' } } }).success,
    ).toBe(true);
  });
});
