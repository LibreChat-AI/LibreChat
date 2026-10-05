import { vertexAISchema } from 'librechat-data-provider';
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
