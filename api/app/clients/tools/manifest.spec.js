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
