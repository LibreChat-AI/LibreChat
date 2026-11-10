const { manifestToolMap, isAgentsOnlyTool } = require('./manifest');

describe('isAgentsOnlyTool', () => {
  it('flags ask_user_question (agentsOnly in the real manifest) in both wire shapes', () => {
    // Guard the data too: the whole assistants-rejection path keys on this flag.
    expect(manifestToolMap['ask_user_question']?.agentsOnly).toBe(true);

    expect(isAgentsOnlyTool('ask_user_question')).toBe(true);
    expect(isAgentsOnlyTool({ type: 'function', function: { name: 'ask_user_question' } })).toBe(
      true,
    );
  });

  it('does not flag ordinary manifest tools, unknown tools, or malformed inputs', () => {
    expect(isAgentsOnlyTool('calculator')).toBe(false);
    expect(isAgentsOnlyTool('nonexistent_tool')).toBe(false);
    expect(isAgentsOnlyTool({ type: 'function', function: { name: 'calculator' } })).toBe(false);
    expect(isAgentsOnlyTool(undefined)).toBe(false);
    expect(isAgentsOnlyTool({})).toBe(false);
    expect(isAgentsOnlyTool({ type: 'code_interpreter' })).toBe(false);
  });
});

describe('Flux authentication manifest', () => {
  const loadManifest = () => {
    let manifest;
    jest.isolateModules(() => {
      manifest = require('./manifest');
    });
    return manifest;
  };

  it.each(['azure-foundry', 'azure-foundry-images'])(
    'hides user API key configuration when %s is configured',
    (provider) => {
      const previousProvider = process.env.FLUX_API_PROVIDER;
      process.env.FLUX_API_PROVIDER = provider;

      try {
        const { manifestToolMap } = loadManifest();
        expect(manifestToolMap.flux.authConfig).toEqual([]);
        expect(manifestToolMap.flux.isAuthRequired).toBeUndefined();
        expect(manifestToolMap.flux.description).toContain('Microsoft Foundry');
        if (provider === 'azure-foundry-images') {
          expect(manifestToolMap.flux.description).toContain('FLUX-1.1-pro');
        }
      } finally {
        if (previousProvider === undefined) {
          delete process.env.FLUX_API_PROVIDER;
        } else {
          process.env.FLUX_API_PROVIDER = previousProvider;
        }
      }
    },
  );

  it('keeps the user API key configuration for direct BFL by default', () => {
    const previousProvider = process.env.FLUX_API_PROVIDER;
    delete process.env.FLUX_API_PROVIDER;

    try {
      const { manifestToolMap } = loadManifest();
      expect(manifestToolMap.flux.authConfig).toEqual(
        expect.arrayContaining([expect.objectContaining({ authField: 'FLUX_API_KEY' })]),
      );
      expect(manifestToolMap.flux.isAuthRequired).toBe('true');
    } finally {
      if (previousProvider !== undefined) {
        process.env.FLUX_API_PROVIDER = previousProvider;
      }
    }
  });
});
