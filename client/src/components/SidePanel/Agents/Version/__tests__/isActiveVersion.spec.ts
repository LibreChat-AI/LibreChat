import type { AgentState, VersionRecord } from '../types';
import { isActiveVersion } from '../isActiveVersion';

describe('isActiveVersion', () => {
  const createVersion = (overrides = {}): VersionRecord => ({
    name: 'Test Agent',
    description: 'Test Description',
    instructions: 'Test Instructions',
    artifacts: 'default',
    tools: ['tool1', 'tool2'],
    capabilities: ['capability1', 'capability2'],
    ...overrides,
  });

  const createAgentState = (overrides = {}): AgentState => ({
    name: 'Test Agent',
    description: 'Test Description',
    instructions: 'Test Instructions',
    artifacts: 'default',
    tools: ['tool1', 'tool2'],
    capabilities: ['capability1', 'capability2'],
    ...overrides,
  });

  test('returns true for the first version in versions array when currentAgent is null', () => {
    const versions = [
      createVersion({ name: 'First Version' }),
      createVersion({ name: 'Second Version' }),
    ];

    expect(isActiveVersion(versions[0], null, versions)).toBe(true);
    expect(isActiveVersion(versions[1], null, versions)).toBe(false);
  });

  test('returns true when all fields match exactly', () => {
    const version = createVersion();
    const currentAgent = createAgentState();
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
  });

  test('returns false when names do not match', () => {
    const version = createVersion();
    const currentAgent = createAgentState({ name: 'Different Name' });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns false when descriptions do not match', () => {
    const version = createVersion();
    const currentAgent = createAgentState({ description: 'Different Description' });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns false when instructions do not match', () => {
    const version = createVersion();
    const currentAgent = createAgentState({ instructions: 'Different Instructions' });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns false when artifacts do not match', () => {
    const version = createVersion();
    const currentAgent = createAgentState({ artifacts: 'different_artifacts' });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns false when handoff edges do not match', () => {
    const version = createVersion({
      edges: [{ from: 'router', to: 'researcher', edgeType: 'handoff' }],
    });
    const currentAgent = createAgentState({
      edges: [{ from: 'router', to: 'writer', edgeType: 'handoff' }],
    });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns true when handoff edges match', () => {
    const edges = [
      {
        from: 'router',
        to: 'researcher',
        edgeType: 'handoff',
        description: 'Delegate research',
        prompt: 'Provide the research brief',
        promptKey: 'context',
      },
    ];
    const version = createVersion({ edges });
    const currentAgent = createAgentState({ edges: edges.map((edge) => ({ ...edge })) });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
  });

  test('matches tools regardless of order', () => {
    const version = createVersion({ tools: ['tool1', 'tool2'] });
    const currentAgent = createAgentState({ tools: ['tool2', 'tool1'] });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
  });

  test('returns false when tools arrays have different lengths', () => {
    const version = createVersion({ tools: ['tool1', 'tool2'] });
    const currentAgent = createAgentState({ tools: ['tool1', 'tool2', 'tool3'] });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns false when tools do not match', () => {
    const version = createVersion({ tools: ['tool1', 'tool2'] });
    const currentAgent = createAgentState({ tools: ['tool1', 'different'] });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('matches capabilities regardless of order', () => {
    const version = createVersion({ capabilities: ['capability1', 'capability2'] });
    const currentAgent = createAgentState({ capabilities: ['capability2', 'capability1'] });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
  });

  test('returns false when capabilities arrays have different lengths', () => {
    const version = createVersion({ capabilities: ['capability1', 'capability2'] });
    const currentAgent = createAgentState({
      capabilities: ['capability1', 'capability2', 'capability3'],
    });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  test('returns false when capabilities do not match', () => {
    const version = createVersion({ capabilities: ['capability1', 'capability2'] });
    const currentAgent = createAgentState({ capabilities: ['capability1', 'different'] });
    const versions = [version];

    expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
  });

  describe('edge cases', () => {
    test('handles missing tools arrays', () => {
      const version = createVersion({ tools: undefined });
      const currentAgent = createAgentState({ tools: undefined });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('handles when version has tools but agent does not', () => {
      const version = createVersion({ tools: ['tool1', 'tool2'] });
      const currentAgent = createAgentState({ tools: undefined });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles when agent has tools but version does not', () => {
      const version = createVersion({ tools: undefined });
      const currentAgent = createAgentState({ tools: ['tool1', 'tool2'] });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles missing capabilities arrays', () => {
      const version = createVersion({ capabilities: undefined });
      const currentAgent = createAgentState({ capabilities: undefined });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('handles when version has capabilities but agent does not', () => {
      const version = createVersion({ capabilities: ['capability1', 'capability2'] });
      const currentAgent = createAgentState({ capabilities: undefined });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles when agent has capabilities but version does not', () => {
      const version = createVersion({ capabilities: undefined });
      const currentAgent = createAgentState({ capabilities: ['capability1', 'capability2'] });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles null values in fields', () => {
      const version = createVersion({ name: null });
      const currentAgent = createAgentState({ name: null });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('handles empty versions array', () => {
      const version = createVersion();
      const currentAgent = createAgentState();
      const versions = [];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles empty arrays for tools', () => {
      const version = createVersion({ tools: [] });
      const currentAgent = createAgentState({ tools: [] });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('handles empty arrays for capabilities', () => {
      const version = createVersion({ capabilities: [] });
      const currentAgent = createAgentState({ capabilities: [] });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('treats missing and empty handoff edges as equivalent', () => {
      const version = createVersion({ edges: undefined });
      const currentAgent = createAgentState({ edges: [] });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('handles missing artifacts field', () => {
      const version = createVersion({ artifacts: undefined });
      const currentAgent = createAgentState({ artifacts: undefined });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('handles when version has artifacts but agent does not', () => {
      const version = createVersion();
      const currentAgent = createAgentState({ artifacts: undefined });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles when agent has artifacts but version does not', () => {
      const version = createVersion({ artifacts: undefined });
      const currentAgent = createAgentState();
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('handles empty string for artifacts', () => {
      const version = createVersion({ artifacts: '' });
      const currentAgent = createAgentState({ artifacts: '' });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });
  });

  describe('restricted instructions-prompt links', () => {
    const restrictedStub = { source: 'native', restricted: true };
    const visibleLink = {
      source: 'native',
      groupId: 'group-a',
      selection: { type: 'production' },
    };

    test('a restricted stub with matchesCurrent true matches an equally restricted current link', () => {
      const version = createVersion({
        instructionsPrompt: { ...restrictedStub, matchesCurrent: true },
      });
      const currentAgent = createAgentState({
        instructionsPrompt: { ...restrictedStub },
      });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('a restricted stub with matchesCurrent false does not match, even on the latest/only version', () => {
      const version = createVersion({
        instructionsPrompt: { ...restrictedStub, matchesCurrent: false },
      });
      const currentAgent = createAgentState({
        instructionsPrompt: { ...restrictedStub },
      });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('a restricted stub with no matchesCurrent flag does not match', () => {
      const version = createVersion({
        instructionsPrompt: { ...restrictedStub },
      });
      const currentAgent = createAgentState({
        instructionsPrompt: { ...restrictedStub },
      });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('an older version with matchesCurrent true matches, even though a later snapshot does not', () => {
      // A revert `$set`s the document without appending a version, so the current
      // link can equal an older entry while the latest-appended one does not.
      const olderVersion = createVersion({
        name: 'Older Version',
        instructionsPrompt: { ...restrictedStub, matchesCurrent: true },
      });
      const latestVersion = createVersion({
        name: 'Latest Version',
        instructionsPrompt: { ...restrictedStub, matchesCurrent: false },
      });
      const currentAgent = createAgentState({
        name: 'Older Version',
        instructionsPrompt: { ...restrictedStub },
      });
      const versions = [olderVersion, latestVersion];

      expect(isActiveVersion(olderVersion, currentAgent, versions)).toBe(true);
      expect(isActiveVersion(latestVersion, currentAgent, versions)).toBe(false);
    });

    test('a restricted stub on only the version side is not active, even with matchesCurrent true', () => {
      const version = createVersion({
        instructionsPrompt: { ...restrictedStub, matchesCurrent: true },
      });
      const currentAgent = createAgentState({ instructionsPrompt: { ...visibleLink } });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('a restricted stub on only the current-agent side is not active', () => {
      const version = createVersion({ instructionsPrompt: { ...visibleLink } });
      const currentAgent = createAgentState({ instructionsPrompt: { ...restrictedStub } });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('visible, equal links still match', () => {
      const version = createVersion({ instructionsPrompt: { ...visibleLink } });
      const currentAgent = createAgentState({ instructionsPrompt: { ...visibleLink } });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(true);
    });

    test('visible links with different groups do not match', () => {
      const version = createVersion({ instructionsPrompt: { ...visibleLink } });
      const currentAgent = createAgentState({
        instructionsPrompt: { ...visibleLink, groupId: 'group-b' },
      });
      const versions = [version];

      expect(isActiveVersion(version, currentAgent, versions)).toBe(false);
    });

    test('with currentAgent null, restricted stubs never match each other, even index 0 against itself', () => {
      // There is no currentAgent here to resolve `matchesCurrent` against, so comparing
      // one version's restricted stub to another's must not trust either side's flag —
      // that flag only describes a comparison against the current agent. Base semantics
      // (never match a restricted stub against anything, including itself) apply, so
      // neither entry is reported active, matching how index 0 behaved before the
      // `matchesCurrent`-trusting server flag existed.
      const versions = [
        createVersion({
          name: 'Same Name',
          instructionsPrompt: { ...restrictedStub, matchesCurrent: true },
        }),
        createVersion({
          name: 'Same Name',
          instructionsPrompt: { ...restrictedStub, matchesCurrent: false },
        }),
      ];

      expect(isActiveVersion(versions[0], null, versions)).toBe(false);
      expect(isActiveVersion(versions[1], null, versions)).toBe(false);
    });
  });
});
