import { enrichWithSkillConfigurable } from './skillConfigurable';

describe('enrichWithSkillConfigurable', () => {
  const req = { user: { id: 'user-1' } };
  const accessibleSkillIds = ['skill-a', 'skill-b'];

  it('augments configurable with req, accessibleSkillIds, and codeEnvAvailable', () => {
    const result = enrichWithSkillConfigurable({
      result: { loadedTools: [], configurable: { other: 'value' } },
      context: { req, accessibleSkillIds, codeEnvAvailable: true },
    });

    expect(result.configurable).toEqual({
      other: 'value',
      req,
      codeEnvAvailable: true,
      accessibleSkillIds,
      skillPrimedIdsByName: undefined,
      skillAuthoringAvailable: undefined,
      fileAuthoringToolNames: undefined,
    });
  });

  it('propagates codeEnvAvailable=false verbatim (not coerced)', () => {
    const result = enrichWithSkillConfigurable({
      result: { loadedTools: [], configurable: {} },
      context: { req, accessibleSkillIds, codeEnvAvailable: false },
    });

    expect(result.configurable.codeEnvAvailable).toBe(false);
  });

  it('threads skillPrimedIdsByName through unchanged', () => {
    const primed = { 'brand-guidelines': 'abc123' };
    const result = enrichWithSkillConfigurable({
      result: { loadedTools: [], configurable: {} },
      context: {
        req,
        accessibleSkillIds,
        codeEnvAvailable: true,
        skillPrimedIdsByName: primed,
      },
    });

    expect(result.configurable.skillPrimedIdsByName).toBe(primed);
  });

  it('supports the legacy positional shape', () => {
    const primed = { 'brand-guidelines': 'abc123' };
    const result = enrichWithSkillConfigurable(
      { loadedTools: [], configurable: {} },
      req,
      accessibleSkillIds,
      true,
      primed,
    );

    expect(result.configurable.skillPrimedIdsByName).toBe(primed);
  });

  it('threads skill authoring gates through unchanged', () => {
    const fileAuthoringToolNames = new Set(['create_file', 'edit_file']);
    const result = enrichWithSkillConfigurable({
      result: { loadedTools: [], configurable: {} },
      context: {
        req,
        accessibleSkillIds,
        codeEnvAvailable: true,
        skillAuthoringAvailable: true,
        fileAuthoringToolNames,
      },
    });

    expect(result.configurable.skillAuthoringAvailable).toBe(true);
    expect(result.configurable.fileAuthoringToolNames).toBe(fileAuthoringToolNames);
  });

  it('preserves loadedTools unchanged', () => {
    const tools = [{ name: 'x' }];
    const result = enrichWithSkillConfigurable({
      result: { loadedTools: tools, configurable: undefined },
      context: { req, accessibleSkillIds, codeEnvAvailable: false },
    });

    expect(result.loadedTools).toBe(tools);
  });
});
