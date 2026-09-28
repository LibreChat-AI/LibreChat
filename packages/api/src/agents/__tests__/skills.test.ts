/**
 * Mock the pieces of `@librechat/agents` the installed SDK version may not
 * export yet — the `Constants.SKILL_TOOL` stub and the tool definitions
 * needed to exercise `injectSkillCatalog`.
 *
 * `formatSkillCatalog` is deliberately NOT stubbed. Its truncation ladder is
 * the behaviour the catalog warnings report on, and a passthrough stub hides
 * every truncation the model actually sees.
 */
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  Constants: {
    ...(jest.requireActual('@librechat/agents') as { Constants: Record<string, unknown> })
      .Constants,
    SKILL_TOOL: 'skill',
  },
  SkillToolDefinition: {
    name: 'skill',
    description: `skill tool

CONSTRAINTS:
- Skill names come from the catalog only. Do not guess names.`,
    parameters: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Must match a name from the "Available Skills" section.',
        },
      },
      required: ['skillName'],
    },
  },
  ReadFileToolDefinition: {
    name: 'read_file',
    description: 'read file',
    parameters: {},
    responseFormat: 'content',
  },
  BashExecutionToolDefinition: {
    name: 'bash_tool',
    description: 'bash',
    schema: {},
  },
  buildBashExecutionToolDescription: ({
    enableToolOutputReferences,
  }: {
    enableToolOutputReferences?: boolean;
  } = {}): string =>
    enableToolOutputReferences === true ? 'bash {{tool<idx>turn<turn>}}' : 'bash',
}));

import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { SkillsScope } from 'librechat-data-provider';
import { HumanMessage, AIMessage } from '@librechat/agents/langchain/messages';
import {
  scopeSkillIds,
  resolveSkillActive,
  resolveAgentScopedSkillIds,
  resolveModelSpecSkillIds,
  injectSkillCatalog,
  buildSkillPrimeMessage,
  resolveManualSkills,
  resolveAlwaysApplySkills,
  injectManualSkillPrimes,
  injectSkillPrimes,
  selectSkillPrimesForTurn,
  collectFreshSkillPrimeNames,
  extractManualSkills,
  isSkillPrimeMessage,
  buildSkillPrimeContentParts,
  unionPrimeAllowedTools,
  MAX_MANUAL_SKILLS,
  MAX_ALWAYS_APPLY_SKILLS,
  MAX_PRIMED_SKILLS_PER_TURN,
} from '../skills';
import { extractInvokedSkillsFromPayload } from '../run';

type PageSkill = {
  _id: Types.ObjectId;
  name: string;
  description: string;
  author: Types.ObjectId;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
};

describe('extractInvokedSkillsFromPayload', () => {
  it('extracts skill names from assistant messages with skill tool_calls', () => {
    const payload = [
      { role: 'user', content: 'Analyze this' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call_1',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: JSON.stringify({ skillName: 'pdf-analyzer' }),
              output: 'Skill loaded.',
            },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result).toEqual(new Set(['pdf-analyzer']));
  });

  it('handles object args (not stringified)', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call_1',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: { skillName: 'code-review' },
              output: 'Loaded.',
            },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result).toEqual(new Set(['code-review']));
  });

  it('returns empty set for no skill tool_calls', () => {
    const payload = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: { id: 'call_1', name: 'web_search', args: '{}', output: 'Results' },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result.size).toBe(0);
  });

  it('skips non-assistant messages', () => {
    const payload = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call_1',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: '{"skillName":"x"}',
              output: '',
            },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result.size).toBe(0);
  });

  it('gracefully handles malformed JSON args', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call_1',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: '{bad json',
              output: '',
            },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result.size).toBe(0);
  });

  it('skips empty skillName', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call_1',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: '{"skillName":""}',
              output: '',
            },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result.size).toBe(0);
  });

  it('returns empty set for empty payload', () => {
    expect(extractInvokedSkillsFromPayload([]).size).toBe(0);
  });

  it('deduplicates across multiple messages', () => {
    const payload = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'c1',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: '{"skillName":"pdf"}',
              output: '',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'c2',
              name: 'skill' /* Constants.SKILL_TOOL */,
              args: '{"skillName":"pdf"}',
              output: '',
            },
          },
        ],
      },
    ];

    const result = extractInvokedSkillsFromPayload(payload);
    expect(result.size).toBe(1);
    expect(result.has('pdf')).toBe(true);
  });
});

describe('scopeSkillIds', () => {
  const makeId = () => new Types.ObjectId();

  it('returns the full set when agentSkills is undefined (not configured)', () => {
    const a = makeId();
    const b = makeId();
    const accessible = [a, b];
    expect(scopeSkillIds(accessible, undefined)).toBe(accessible);
  });

  it('returns the full set when agentSkills is null (not configured)', () => {
    const a = makeId();
    const b = makeId();
    const accessible = [a, b];
    expect(scopeSkillIds(accessible, null)).toBe(accessible);
  });

  it('returns the full set when agentSkills is an empty array (no allowlist)', () => {
    const accessible = [makeId(), makeId()];
    expect(scopeSkillIds(accessible, [])).toBe(accessible);
  });

  it('returns intersection when agentSkills overlaps accessibleSkillIds', () => {
    const a = makeId();
    const b = makeId();
    const c = makeId();
    const accessible = [a, b, c];
    const scoped = scopeSkillIds(accessible, [a.toString(), c.toString()]);
    expect(scoped).toHaveLength(2);
    expect(scoped.map((o) => o.toString())).toEqual([a.toString(), c.toString()]);
  });

  it('returns [] when agentSkills is disjoint from accessibleSkillIds', () => {
    const a = makeId();
    const b = makeId();
    const accessible = [a, b];
    const unrelated = makeId().toString();
    expect(scopeSkillIds(accessible, [unrelated])).toEqual([]);
  });

  it('returns the full accessible set when agentSkills exactly matches it', () => {
    const a = makeId();
    const b = makeId();
    const accessible = [a, b];
    const scoped = scopeSkillIds(accessible, [a.toString(), b.toString()]);
    expect(scoped).toHaveLength(2);
    expect(scoped.map((o) => o.toString()).sort()).toEqual([a.toString(), b.toString()].sort());
  });

  it('filters out agentSkills entries that the user does not have ACL access to', () => {
    const a = makeId();
    const accessible = [a];
    const notAccessible = makeId().toString();
    const scoped = scopeSkillIds(accessible, [a.toString(), notAccessible]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].toString()).toBe(a.toString());
  });

  it('returns [] when accessibleSkillIds is empty regardless of agentSkills', () => {
    expect(scopeSkillIds([], undefined)).toEqual([]);
    expect(scopeSkillIds([], [])).toEqual([]);
    expect(scopeSkillIds([], [new Types.ObjectId().toString()])).toEqual([]);
  });
});

describe('resolveAgentScopedSkillIds', () => {
  const makeId = () => new Types.ObjectId();
  const persistedAgent = (
    skills?: string[],
    skills_enabled?: boolean,
    skills_scope?: SkillsScope,
  ): {
    id: string;
    skills?: string[];
    skills_enabled?: boolean;
    skills_scope?: SkillsScope;
  } => ({
    id: 'agent_persisted_1',
    skills,
    skills_enabled,
    skills_scope,
  });
  const ephemeralAgent = (
    skills?: string[],
    skills_enabled?: boolean,
  ): { id: string; skills?: string[]; skills_enabled?: boolean } => ({
    id: 'ephemeral_convo_xyz',
    skills,
    skills_enabled,
  });

  it('returns [] when the skills capability is disabled, even with every other signal on', () => {
    const a = makeId();
    expect(
      resolveAgentScopedSkillIds({
        agent: persistedAgent([a.toString()], true),
        accessibleSkillIds: [a],
        skillsCapabilityEnabled: false,
        ephemeralSkillsToggle: true,
      }),
    ).toEqual([]);
  });

  it('returns [] when accessibleSkillIds is empty', () => {
    expect(
      resolveAgentScopedSkillIds({
        agent: ephemeralAgent(),
        accessibleSkillIds: [],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: true,
      }),
    ).toEqual([]);
  });

  describe('ephemeral agent', () => {
    it('returns [] when the skills badge toggle is off', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: ephemeralAgent(),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: false,
        }),
      ).toEqual([]);
    });

    it('returns the full accessible catalog when the skills badge toggle is on', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: ephemeralAgent(),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: true,
      });
      expect(scoped).toHaveLength(2);
      expect(scoped.map((o) => o.toString()).sort()).toEqual([a.toString(), b.toString()].sort());
    });

    it('returns the full accessible catalog when a model spec enables skills', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: ephemeralAgent(undefined, true),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
      });
      expect(scoped.map((o) => o.toString()).sort()).toEqual([a.toString(), b.toString()].sort());
    });

    it('returns the model-spec allowlist intersection when configured', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: ephemeralAgent([a.toString()], true),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
      });
      expect(scoped.map((o) => o.toString())).toEqual([a.toString()]);
    });

    it('treats an empty model-spec allowlist as explicit none', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: ephemeralAgent([], true),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: true,
        }),
      ).toEqual([]);
    });

    it('lets an explicit model-spec skills=false override the badge toggle', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: ephemeralAgent(undefined, false),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: true,
        }),
      ).toEqual([]);
    });
  });

  describe('persisted agent', () => {
    it('returns [] when `skills_enabled` is undefined (default / never toggled)', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: persistedAgent([a.toString()], undefined),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: false,
        }),
      ).toEqual([]);
    });

    it('returns [] when `skills_enabled` is false, even if an allowlist is set', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: persistedAgent([a.toString()], false),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: false,
        }),
      ).toEqual([]);
    });

    it('returns full accessible catalog when `skills_enabled` is true and allowlist is undefined', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: persistedAgent(undefined, true),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
      });
      expect(scoped).toHaveLength(2);
      expect(scoped.map((o) => o.toString()).sort()).toEqual([a.toString(), b.toString()].sort());
    });

    it('returns full accessible catalog when `skills_enabled` is true and allowlist is empty', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: persistedAgent([], true),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
      });
      expect(scoped).toHaveLength(2);
    });

    it('returns intersection when `skills_enabled` is true and allowlist overlaps accessible set', () => {
      const a = makeId();
      const b = makeId();
      const c = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: persistedAgent([a.toString(), c.toString()], true),
        accessibleSkillIds: [a, b, c],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
      });
      expect(scoped).toHaveLength(2);
      expect(scoped.map((o) => o.toString()).sort()).toEqual([a.toString(), c.toString()].sort());
    });

    it('returns no catalog for an enabled agent with explicit none scope', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: persistedAgent([], true, SkillsScope.none),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: false,
        }),
      ).toEqual([]);
    });

    it('returns the full catalog for explicit all scope even with stale selected ids', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: persistedAgent([a.toString()], true, SkillsScope.all),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
      });
      expect(scoped).toEqual([a, b]);
    });

    it('fails closed when explicit selected scope has no ids', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: persistedAgent([], true, SkillsScope.selected),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: false,
        }),
      ).toEqual([]);
    });

    it('is unaffected by the ephemeral toggle — the persisted config is authoritative', () => {
      const a = makeId();
      const b = makeId();
      const scoped = resolveAgentScopedSkillIds({
        agent: persistedAgent([a.toString()], true),
        accessibleSkillIds: [a, b],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: true,
      });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].toString()).toBe(a.toString());
    });

    it('still returns [] when `skills_enabled` is missing even if the ephemeral toggle is on', () => {
      const a = makeId();
      expect(
        resolveAgentScopedSkillIds({
          agent: persistedAgent(undefined, undefined),
          accessibleSkillIds: [a],
          skillsCapabilityEnabled: true,
          ephemeralSkillsToggle: true,
        }),
      ).toEqual([]);
    });
  });
});

describe('resolveModelSpecSkillIds', () => {
  const userObjectId = new Types.ObjectId();

  it('resolves configured names against accessible skills and skips misses without failing', async () => {
    const knownId = new Types.ObjectId();
    const getSkillByName = jest.fn(async (name: string) => {
      if (name === 'known-skill') {
        return {
          _id: knownId,
          name,
          body: 'body',
          author: userObjectId,
        };
      }
      if (name === 'throws') {
        throw new Error('lookup failed');
      }
      return null;
    });

    const result = await resolveModelSpecSkillIds({
      names: [' known-skill ', 'missing-skill', 'throws', 'known-skill'],
      accessibleSkillIds: [knownId],
      getSkillByName,
    });

    expect(result.map((id) => id.toString())).toEqual([knownId.toString()]);
    expect(getSkillByName).toHaveBeenCalledTimes(3);
    expect(getSkillByName).toHaveBeenCalledWith('known-skill', [knownId], {
      preferModelInvocable: true,
    });
  });

  it('resolves configured names sequentially to avoid query bursts', async () => {
    const firstId = new Types.ObjectId();
    const secondId = new Types.ObjectId();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstLookup = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const getSkillByName = jest.fn(async (name: string) => {
      order.push(`start:${name}`);
      if (name === 'first') {
        await firstLookup;
        order.push(`end:${name}`);
        return {
          _id: firstId,
          name,
          body: 'body',
          author: userObjectId,
        };
      }
      order.push(`end:${name}`);
      return {
        _id: secondId,
        name,
        body: 'body',
        author: userObjectId,
      };
    });

    const promise = resolveModelSpecSkillIds({
      names: ['first', 'second'],
      accessibleSkillIds: [firstId, secondId],
      getSkillByName,
    });

    await Promise.resolve();
    expect(order).toEqual(['start:first']);

    releaseFirst();
    const result = await promise;

    expect(result.map((id) => id.toString())).toEqual([firstId.toString(), secondId.toString()]);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('returns [] when no skill lookup is available', async () => {
    const result = await resolveModelSpecSkillIds({
      names: ['known-skill'],
      accessibleSkillIds: [new Types.ObjectId()],
      getSkillByName: undefined,
    });

    expect(result).toEqual([]);
  });
});

describe('resolveSkillActive', () => {
  const makeSkill = (author: Types.ObjectId) => ({ _id: new Types.ObjectId(), author });

  it('fails closed when userId is undefined and no override is set', () => {
    const skill = makeSkill(new Types.ObjectId());
    expect(
      resolveSkillActive({
        skill,
        skillStates: {},
        userId: undefined,
        defaultActiveOnShare: true,
      }),
    ).toBe(false);
  });

  it('fails closed when userId is undefined even if defaultActiveOnShare is true', () => {
    const skill = makeSkill(new Types.ObjectId());
    expect(
      resolveSkillActive({
        skill,
        userId: undefined,
        defaultActiveOnShare: true,
      }),
    ).toBe(false);
  });

  it('respects explicit override = true regardless of ownership or config', () => {
    const userId = new Types.ObjectId().toString();
    const sharedSkill = makeSkill(new Types.ObjectId());
    expect(
      resolveSkillActive({
        skill: sharedSkill,
        skillStates: { [sharedSkill._id.toString()]: true },
        userId,
        defaultActiveOnShare: false,
      }),
    ).toBe(true);
  });

  it('respects explicit override = false even for owned skills', () => {
    const userObjectId = new Types.ObjectId();
    const userId = userObjectId.toString();
    const ownedSkill = makeSkill(userObjectId);
    expect(
      resolveSkillActive({
        skill: ownedSkill,
        skillStates: { [ownedSkill._id.toString()]: false },
        userId,
        defaultActiveOnShare: true,
      }),
    ).toBe(false);
  });

  it('respects explicit override = false even for deployment skills', () => {
    const deploymentSkill = { ...makeSkill(new Types.ObjectId()), deployment: true };
    expect(
      resolveSkillActive({
        skill: deploymentSkill,
        skillStates: { [deploymentSkill._id.toString()]: false },
        userId: undefined,
        defaultActiveOnShare: true,
      }),
    ).toBe(false);
  });

  it('defaults deployment skills to active without ownership or shared defaults', () => {
    const deploymentSkill = { ...makeSkill(new Types.ObjectId()), deployment: true };
    expect(
      resolveSkillActive({
        skill: deploymentSkill,
        skillStates: {},
        userId: undefined,
        defaultActiveOnShare: false,
      }),
    ).toBe(true);
  });

  it('owned skills default to active when no override is present', () => {
    const userObjectId = new Types.ObjectId();
    const userId = userObjectId.toString();
    const ownedSkill = makeSkill(userObjectId);
    expect(
      resolveSkillActive({
        skill: ownedSkill,
        skillStates: {},
        userId,
        defaultActiveOnShare: false,
      }),
    ).toBe(true);
  });

  it('shared skills default to inactive when defaultActiveOnShare is false', () => {
    const userId = new Types.ObjectId().toString();
    const sharedSkill = makeSkill(new Types.ObjectId());
    expect(
      resolveSkillActive({
        skill: sharedSkill,
        skillStates: {},
        userId,
        defaultActiveOnShare: false,
      }),
    ).toBe(false);
  });

  it('shared skills default to active when defaultActiveOnShare is true', () => {
    const userId = new Types.ObjectId().toString();
    const sharedSkill = makeSkill(new Types.ObjectId());
    expect(
      resolveSkillActive({
        skill: sharedSkill,
        skillStates: {},
        userId,
        defaultActiveOnShare: true,
      }),
    ).toBe(true);
  });

  it('treats skillStates = undefined identically to an empty object', () => {
    const userObjectId = new Types.ObjectId();
    const userId = userObjectId.toString();
    const ownedSkill = makeSkill(userObjectId);
    const sharedSkill = makeSkill(new Types.ObjectId());

    expect(resolveSkillActive({ skill: ownedSkill, userId, defaultActiveOnShare: false })).toBe(
      resolveSkillActive({
        skill: ownedSkill,
        skillStates: {},
        userId,
        defaultActiveOnShare: false,
      }),
    );
    expect(resolveSkillActive({ skill: sharedSkill, userId, defaultActiveOnShare: true })).toBe(
      resolveSkillActive({
        skill: sharedSkill,
        skillStates: {},
        userId,
        defaultActiveOnShare: true,
      }),
    );
  });

  it('defaults defaultActiveOnShare to false when the param is omitted', () => {
    const userId = new Types.ObjectId().toString();
    const sharedSkill = makeSkill(new Types.ObjectId());
    expect(resolveSkillActive({ skill: sharedSkill, skillStates: {}, userId })).toBe(false);
  });

  it('ignores defaultActiveOnShare for owned skills', () => {
    const userObjectId = new Types.ObjectId();
    const userId = userObjectId.toString();
    const ownedSkill = makeSkill(userObjectId);
    expect(
      resolveSkillActive({
        skill: ownedSkill,
        skillStates: {},
        userId,
        defaultActiveOnShare: false,
      }),
    ).toBe(true);
  });
});

describe('injectSkillCatalog', () => {
  const userId = new Types.ObjectId().toString();
  const userObjectId = new Types.ObjectId(userId);

  /** Minimal `Agent` shape `injectSkillCatalog` actually reads/writes. */
  type MockAgent = Parameters<typeof injectSkillCatalog>[0]['agent'];

  function makeAgent(): MockAgent {
    return { additional_instructions: undefined } as MockAgent;
  }

  function makeSkill(name: string, author: Types.ObjectId = userObjectId): PageSkill {
    return {
      _id: new Types.ObjectId(),
      name,
      description: `desc-${name}`,
      author,
    };
  }

  function buildPager(pages: PageSkill[][]) {
    return jest.fn().mockImplementation(async ({ cursor }: { cursor?: string | null }) => {
      const pageIndex = cursor ? Number(cursor) : 0;
      const skills = pages[pageIndex] ?? [];
      const has_more = pageIndex < pages.length - 1;
      return {
        skills,
        has_more,
        after: has_more ? String(pageIndex + 1) : null,
      };
    });
  }

  function baseParams(overrides: Partial<Parameters<typeof injectSkillCatalog>[0]> = {}) {
    return {
      agent: makeAgent(),
      toolDefinitions: undefined,
      toolRegistry: undefined,
      accessibleSkillIds: [new Types.ObjectId()],
      contextWindowTokens: 200_000,
      listSkillsByAccess: jest.fn(),
      userId,
      skillStates: {},
      defaultActiveOnShare: false,
      ...overrides,
    };
  }

  it('returns empty when no skills are accessible', async () => {
    const result = await injectSkillCatalog(
      baseParams({ accessibleSkillIds: [], listSkillsByAccess: jest.fn() }),
    );
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds).toEqual([]);
  });

  it('returns empty when listSkillsByAccess is not provided', async () => {
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess: undefined }));
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds).toEqual([]);
  });

  it('filters out inactive skills on a single page (shared, default inactive)', async () => {
    const owned = makeSkill('my-skill', userObjectId);
    const sharedInactive = makeSkill('other-skill', new Types.ObjectId());
    const listSkillsByAccess = buildPager([[owned, sharedInactive]]);
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess }));
    expect(result.skillCount).toBe(1);
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([owned._id.toString()]);
  });

  it('includes shared skills when defaultActiveOnShare is true', async () => {
    const shared = makeSkill('other-skill', new Types.ObjectId());
    const listSkillsByAccess = buildPager([[shared]]);
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, defaultActiveOnShare: true }),
    );
    expect(result.skillCount).toBe(1);
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([shared._id.toString()]);
  });

  it('honors explicit overrides (deactivated owned skill absent from catalog)', async () => {
    const owned = makeSkill('off', userObjectId);
    const listSkillsByAccess = buildPager([[owned]]);
    const result = await injectSkillCatalog(
      baseParams({
        listSkillsByAccess,
        skillStates: { [owned._id.toString()]: false },
      }),
    );
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds).toEqual([]);
  });

  it('paginates across pages and collects active skills from later pages', async () => {
    const sharedInactive = Array.from({ length: 3 }, (_, i) =>
      makeSkill(`shared-${i}`, new Types.ObjectId()),
    );
    const owned = makeSkill('my-skill', userObjectId);
    const listSkillsByAccess = buildPager([sharedInactive, [owned]]);
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess }));
    expect(result.skillCount).toBe(1);
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([owned._id.toString()]);
    expect(listSkillsByAccess).toHaveBeenCalledTimes(2);
  });

  it('stops paginating at MAX_CATALOG_PAGES even if no active skills found', async () => {
    const inactivePage = Array.from({ length: 10 }, (_, i) =>
      makeSkill(`shared-${i}`, new Types.ObjectId()),
    );
    // Build 12 pages, all inactive — scanner should stop at page cap.
    const pages = Array.from({ length: 12 }, () => inactivePage);
    const listSkillsByAccess = buildPager(pages);
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess }));
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds).toEqual([]);
    // MAX_CATALOG_PAGES = 10 — loop terminates after exactly 10 page fetches.
    expect(listSkillsByAccess).toHaveBeenCalledTimes(10);
  });

  it('terminates early when has_more is false even below the catalog limit', async () => {
    const owned = makeSkill('solo', userObjectId);
    const listSkillsByAccess = buildPager([[owned]]);
    await injectSkillCatalog(baseParams({ listSkillsByAccess }));
    expect(listSkillsByAccess).toHaveBeenCalledTimes(1);
  });

  it('appends the catalog text to agent.additional_instructions', async () => {
    const owned = makeSkill('my-skill', userObjectId);
    const listSkillsByAccess = buildPager([[owned]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));
    expect(agent.additional_instructions).toContain('my-skill');
    expect(agent.additional_instructions).toContain('desc-my-skill');
  });

  /** Truncated descriptions, as `[skillName, reachedChars, authoredChars]`. */
  function truncationWarnings(warnSpy: jest.SpyInstance): Array<[string, number, number]> {
    return warnSpy.mock.calls
      .map((call) => String(call[0]))
      .map((msg) =>
        /skill "([^"]+)" description reached the model truncated to (\d+) of (\d+)/.exec(msg),
      )
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], Number(m[2]), Number(m[3])]);
  }

  /** Skills whose description the catalog dropped entirely. */
  function droppedWarnings(warnSpy: jest.SpyInstance): string[] {
    return warnSpy.mock.calls
      .map((call) => String(call[0]))
      .map((msg) => /skill "([^"]+)" description was dropped from the model catalog/.exec(msg))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]);
  }

  it('warns when a skill description exceeds the catalog entry cap', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    const longSkill: PageSkill = {
      ...makeSkill('long-skill', userObjectId),
      description: 'x'.repeat(400),
    };
    const shortSkill = makeSkill('short-skill', userObjectId);
    const listSkillsByAccess = buildPager([[longSkill, shortSkill]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));

    const warnings = truncationWarnings(warnSpy);
    expect(warnings).toHaveLength(1);
    const [name, reached, authored] = warnings[0];
    expect(name).toBe('long-skill');
    expect(authored).toBe(400);
    expect(reached).toBeLessThan(authored);
    /* The catalog still reaches the model — the warning is additive. */
    expect(agent.additional_instructions).toContain('long-skill');
    expect(agent.additional_instructions).toContain('short-skill');
    warnSpy.mockRestore();
  });

  it('warns for a sub-cap description the catalog budget still truncates', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    /* Every description sits under the per-entry cap, so a warning keyed to
       that cap alone stays silent — but a catalog this size overruns its
       context budget and gets cut well below it anyway. */
    const skills = Array.from({ length: 8 }, (_, i) => ({
      ...makeSkill(`budget-skill-${i}`, userObjectId),
      description: 'x'.repeat(200),
    }));
    const listSkillsByAccess = buildPager([skills]);
    const agent = makeAgent();
    await injectSkillCatalog(
      baseParams({ listSkillsByAccess, agent, contextWindowTokens: 20_000 }),
    );

    const warnings = truncationWarnings(warnSpy);
    expect(warnings).toHaveLength(skills.length);
    for (const [, reached, authored] of warnings) {
      expect(authored).toBe(200);
      expect(reached).toBeGreaterThan(0);
      expect(reached).toBeLessThan(200);
    }
    warnSpy.mockRestore();
  });

  it('reports descriptions as dropped when the catalog falls back to names-only', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    const skills = Array.from({ length: 10 }, (_, i) => ({
      ...makeSkill(`dropped-skill-${i}`, userObjectId),
      description: 'x'.repeat(200),
    }));
    const listSkillsByAccess = buildPager([skills]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent, contextWindowTokens: 2_000 }));

    expect(droppedWarnings(warnSpy)).toHaveLength(skills.length);
    /* Names still reach the model even when every description is dropped. */
    expect(agent.additional_instructions).toContain('dropped-skill-0');
    warnSpy.mockRestore();
  });

  it('measures duplicate-named skills per entry rather than collapsing them', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    /* The catalog keeps both entries. Measuring by name alone would report the
       last entry's length for both and understate the first. */
    const longDup: PageSkill = {
      ...makeSkill('dup-skill', userObjectId),
      description: 'x'.repeat(400),
    };
    const shortDup: PageSkill = {
      ...makeSkill('dup-skill', userObjectId),
      description: 'y'.repeat(100),
    };
    const listSkillsByAccess = buildPager([[longDup, shortDup]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));

    const warnings = truncationWarnings(warnSpy);
    expect(warnings).toHaveLength(1);
    const [name, reached, authored] = warnings[0];
    expect(name).toBe('dup-skill');
    expect(authored).toBe(400);
    expect(reached).toBeGreaterThan(100);
    warnSpy.mockRestore();
  });

  it('does not flag multiline descriptions the catalog kept intact', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    /* Nothing strips newlines from a description, so a catalog entry is not
       one physical line — and a leading newline leaves the first one empty. */
    const multiline: PageSkill = {
      ...makeSkill('multiline-skill', userObjectId),
      description: 'First line of the description.\nSecond line with more triggers.',
    };
    const leading: PageSkill = {
      ...makeSkill('leading-newline-skill', userObjectId),
      description: '\nAll the real trigger text lives on line two.',
    };
    const listSkillsByAccess = buildPager([[multiline, leading]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));

    expect(truncationWarnings(warnSpy)).toEqual([]);
    expect(droppedWarnings(warnSpy)).toEqual([]);
    warnSpy.mockRestore();
  });

  it('stays aligned when a description imitates the next entry', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    /* A continuation line can look exactly like the next entry's marker. */
    const imitator: PageSkill = {
      ...makeSkill('imitator-skill', userObjectId),
      description: 'start\n- victim-skill: hijacked',
    };
    const victim: PageSkill = {
      ...makeSkill('victim-skill', userObjectId),
      description: 'y'.repeat(400),
    };
    const listSkillsByAccess = buildPager([[imitator, victim]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));

    expect(truncationWarnings(warnSpy).map(([name]) => name)).toEqual(['victim-skill']);
    warnSpy.mockRestore();
  });

  it('still flags a dropped description that collides with another skill name', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    /* Names-only drops every description, but a one-word description can occur
       verbatim in the catalog as another skill's name. */
    const named = makeSkill('research', userObjectId);
    const collider: PageSkill = {
      ...makeSkill('other-skill', userObjectId),
      description: 'research',
    };
    const filler = Array.from({ length: 20 }, (_, i) => ({
      ...makeSkill(`filler-skill-${i}`, userObjectId),
      description: 'y'.repeat(200),
    }));
    const listSkillsByAccess = buildPager([[named, collider, ...filler]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent, contextWindowTokens: 2_000 }));

    expect(droppedWarnings(warnSpy)).toContain('other-skill');
    warnSpy.mockRestore();
  });

  it('flags truncation that splices an entry tail onto the next entry rendering', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const warnSpy = jest.spyOn(logger, 'warn');
    /* Cutting here leaves the catalog holding this description's full text
       across two entries, so matching the rendering would suppress the warning. */
    const spliced: PageSkill = {
      ...makeSkill('spliced-skill', userObjectId),
      description: `${'z'.repeat(249)}\u2026\n- next-skill: next description`,
    };
    const next: PageSkill = {
      ...makeSkill('next-skill', userObjectId),
      description: 'next description',
    };
    const listSkillsByAccess = buildPager([[spliced, next]]);
    const agent = makeAgent();
    await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));

    expect(truncationWarnings(warnSpy).map(([name]) => name)).toEqual(['spliced-skill']);
    warnSpy.mockRestore();
  });

  it('honors a configured maxCatalogSkills below the default hard limit', async () => {
    const first = makeSkill('first-skill', userObjectId);
    const second = makeSkill('second-skill', userObjectId);
    const third = makeSkill('third-skill', userObjectId);
    const listSkillsByAccess = buildPager([[first, second, third]]);
    const agent = makeAgent();
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, agent, maxCatalogSkills: 2 }),
    );

    expect(result.skillCount).toBe(2);
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([
      first._id.toString(),
      second._id.toString(),
    ]);
    expect(agent.additional_instructions).toContain('first-skill');
    expect(agent.additional_instructions).toContain('second-skill');
    expect(agent.additional_instructions).not.toContain('third-skill');
  });

  it('fails closed when userId is absent (shared skills drop, owned would need override)', async () => {
    const owned = makeSkill('my-skill', userObjectId);
    const shared = makeSkill('shared-skill', new Types.ObjectId());
    const listSkillsByAccess = buildPager([[owned, shared]]);
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, userId: undefined, defaultActiveOnShare: true }),
    );
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds).toEqual([]);
  });

  it('excludes disableModelInvocation=true skills from catalog text but keeps them resolvable', async () => {
    const open = makeSkill('open-skill', userObjectId);
    const modelHidden: PageSkill = {
      ...makeSkill('hidden-skill', userObjectId),
      disableModelInvocation: true,
    };
    const listSkillsByAccess = buildPager([[open, modelHidden]]);
    const agent = makeAgent();
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));
    /* Catalog text only mentions the open skill — the disabled one costs
       zero context tokens. */
    expect(result.skillCount).toBe(1);
    expect(agent.additional_instructions).toContain('open-skill');
    expect(agent.additional_instructions).not.toContain('hidden-skill');
    /* But activeSkillIds keeps both — the runtime needs to resolve a
       hallucinated/stale call to the disabled skill so handleSkillToolCall
       can fire its explicit "cannot be invoked by the model" rejection
       instead of a misleading generic "not found". */
    expect(result.activeSkillIds.map((id) => id.toString()).sort()).toEqual(
      [open._id.toString(), modelHidden._id.toString()].sort(),
    );
  });

  it('catalog quota counts only model-visible skills (disabled rows do not consume slots)', async () => {
    /* Build 3 disabled skills + 1 invocable skill on a single page. With a
       hypothetical cap of 100 the disabled rows shouldn't crowd out the
       invocable one — but the bug we're guarding against is the cap getting
       consumed by disabled rows so the invocable one never lands in the
       catalog. Verify the invocable skill makes it in regardless of how
       many disabled rows precede it. */
    const disabled = (i: number): PageSkill => ({
      ...makeSkill(`disabled-${i}`, userObjectId),
      disableModelInvocation: true,
    });
    const visible = makeSkill('visible-skill', userObjectId);
    const listSkillsByAccess = buildPager([[disabled(1), disabled(2), disabled(3), visible]]);
    const agent = makeAgent();
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));
    expect(result.skillCount).toBe(1);
    expect(agent.additional_instructions).toContain('visible-skill');
    /* All four are accessible at runtime — disabled ones for the explicit
       rejection error, the visible one for normal execution. */
    expect(result.activeSkillIds).toHaveLength(4);
  });

  it('drops disabled docs from activeSkillIds when an invocable doc with the same name is in scope', async () => {
    /* Same-name collision: invocable + disabled. Without dedup, getSkillByName
       (sort by updatedAt desc) might pick the disabled doc and every model
       call to that name would fail with "cannot be invoked". The invocable
       doc must win the runtime ACL slot. */
    const invocable = makeSkill('shared-name', userObjectId);
    const disabledDup: PageSkill = {
      ...makeSkill('shared-name', userObjectId),
      disableModelInvocation: true,
    };
    const listSkillsByAccess = buildPager([[invocable, disabledDup]]);
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess }));
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([invocable._id.toString()]);
    expect(result.skillCount).toBe(1);
  });

  it('keeps the disabled doc in activeSkillIds when no invocable doc with the same name exists', async () => {
    /* Sole-disabled-name case: the disabled doc must stay so a hallucinated
       model invocation fires the explicit error path. */
    const onlyDisabled: PageSkill = {
      ...makeSkill('disabled-only', userObjectId),
      disableModelInvocation: true,
    };
    const otherInvocable = makeSkill('other-name', userObjectId);
    const listSkillsByAccess = buildPager([[onlyDisabled, otherInvocable]]);
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess }));
    expect(result.activeSkillIds.map((id) => id.toString()).sort()).toEqual(
      [onlyDisabled._id.toString(), otherInvocable._id.toString()].sort(),
    );
    /* Only otherInvocable counts toward the catalog — the disabled one stays
       runtime-resolvable for explicit error, but not in the model's prompt. */
    expect(result.skillCount).toBe(1);
  });

  it('omits catalog text + skill tool when every active skill is model-disabled, but keeps read_file', async () => {
    /* Edge case: only `disable-model-invocation` skills accessible. The
       model can't see any catalog and the `skill` tool isn't registered
       (no targets to invoke) — but `read_file` MUST stay registered.
       Manually-primed disabled skills still get their SKILL.md body in
       context, and the body may reference `references/*` files that
       require read_file to load. */
    const ownedHidden: PageSkill = {
      ...makeSkill('owned-hidden', userObjectId),
      disableModelInvocation: true,
    };
    const listSkillsByAccess = buildPager([[ownedHidden]]);
    const agent = makeAgent();
    const result = await injectSkillCatalog(baseParams({ listSkillsByAccess, agent }));
    expect(result.skillCount).toBe(0);
    expect(agent.additional_instructions).toBeUndefined();
    /* read_file is registered; the `skill` tool is NOT (would burn tokens
       advertising a tool with no model-reachable targets). */
    const definedNames = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(definedNames).toContain('read_file');
    expect(definedNames).not.toContain('skill');
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([ownedHidden._id.toString()]);
  });

  it('registers bash_tool alongside read_file when codeEnvAvailable, even with no catalog', async () => {
    /* Same edge case as above but with code env on — manually-primed
       skills can use bash_tool too. */
    const ownedHidden: PageSkill = {
      ...makeSkill('owned-hidden-code', userObjectId),
      disableModelInvocation: true,
    };
    const listSkillsByAccess = buildPager([[ownedHidden]]);
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, codeEnvAvailable: true }),
    );
    const definedNames = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(definedNames).toContain('read_file');
    expect(definedNames).toContain('bash_tool');
    expect(definedNames).not.toContain('skill');
  });

  it('registers bash_tool with the tool-output reference syntax guide when codeEnvAvailable', async () => {
    /**
     * Symmetry check with `initializeAgent`'s call: `injectSkillCatalog`
     * must forward `enableToolOutputReferences` so that if call order
     * ever flips (skills-first), the resulting `bash_tool` description
     * still contains the `{{tool<idx>turn<turn>}}` syntax guide. Using
     * the registry mock's stub of `buildBashExecutionToolDescription`
     * (defined at the top of this file), the guide collapses to a
     * `{{tool<idx>turn<turn>}}` literal substring when the flag is on
     * and is absent when off.
     */
    const owned = makeSkill('owned-skill', userObjectId);
    const listSkillsByAccess = buildPager([[owned]]);
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, codeEnvAvailable: true }),
    );
    const bashDef = (result.toolDefinitions ?? []).find((d) => d.name === 'bash_tool');
    expect(bashDef?.description).toContain('{{tool<idx>turn<turn>}}');
  });

  it('does NOT register bash_tool when codeEnvAvailable is false (skills-only agent)', async () => {
    /* Narrowing regression: `initializeAgent` now passes the per-agent
       effective flag (admin cap AND `agent.tools.includes('execute_code')`).
       A skills-only agent passes `false` here, and `bash_tool` must stay
       out of the registered toolDefinitions even with an active skill
       catalog. `read_file` still registers — manually-primed skills
       read their `references/*` from storage without a sandbox. */
    const owned = makeSkill('owned-skill', userObjectId);
    const listSkillsByAccess = buildPager([[owned]]);
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, codeEnvAvailable: false }),
    );
    const definedNames = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(definedNames).toContain('read_file');
    expect(definedNames).toContain('skill');
    expect(definedNames).not.toContain('bash_tool');
  });

  it('does not duplicate bash_tool/read_file already registered by the execute_code path', async () => {
    /* Simulates the Phase 8 dedupe: when an agent has both the
       `execute_code` capability (registers bash_tool+read_file via
       `registerCodeExecutionTools` before catalog injection) AND skills
       active, `injectSkillCatalog` must see the existing entries in the
       registry and skip re-adding. One copy of each reaches the LLM. */
    const owned = makeSkill('owned-skill', userObjectId);
    const listSkillsByAccess = buildPager([[owned]]);
    type ToolRegistryArg = NonNullable<Parameters<typeof injectSkillCatalog>[0]['toolRegistry']>;
    type ToolDef = Parameters<ToolRegistryArg['set']>[1];
    const preBash: ToolDef = {
      name: 'bash_tool',
      description: 'pre',
      parameters: { type: 'object', properties: {} },
    };
    const preRead: ToolDef = {
      name: 'read_file',
      description: 'pre',
      parameters: { type: 'object', properties: {} },
      responseFormat: 'content',
    };
    const preRegistry = new Map<string, ToolDef>() as unknown as ToolRegistryArg;
    preRegistry.set('bash_tool', preBash);
    preRegistry.set('read_file', preRead);
    const result = await injectSkillCatalog(
      baseParams({
        listSkillsByAccess,
        codeEnvAvailable: true,
        toolRegistry: preRegistry,
        toolDefinitions: [preBash, preRead],
      }),
    );
    const names = (result.toolDefinitions ?? []).map((d) => d.name);
    const bashOccurrences = names.filter((n) => n === 'bash_tool').length;
    const readOccurrences = names.filter((n) => n === 'read_file').length;
    expect(bashOccurrences).toBe(1);
    expect(readOccurrences).toBe(1);
    /* Skill tool still gets registered because there is at least one
       catalog-visible skill. */
    expect(names).toContain('skill');
  });

  it('registers the skill tool with an empty catalog when the run can author skills', async () => {
    /* A model that can write `skills/{skillName}/SKILL.md` needs the `skill`
       tool bound at init: definitions bind once per run, so a run that only
       learned about the skill after creating it could never invoke it. */
    const listSkillsByAccess = jest.fn();
    const agent = makeAgent();
    const result = await injectSkillCatalog(
      baseParams({
        agent,
        accessibleSkillIds: [],
        listSkillsByAccess,
        skillAuthoringAvailable: true,
      }),
    );

    const definedNames = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(definedNames).toContain('skill');
    expect(result.toolNames).toContain('skill');
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds).toEqual([]);
    expect(agent.additional_instructions).toBeUndefined();
    expect(listSkillsByAccess).not.toHaveBeenCalled();
  });

  it('omits the skill tool with an empty catalog when the run cannot author skills', async () => {
    const result = await injectSkillCatalog(
      baseParams({ accessibleSkillIds: [], listSkillsByAccess: jest.fn() }),
    );

    expect((result.toolDefinitions ?? []).map((d) => d.name)).not.toContain('skill');
    expect(result.toolNames).toEqual([]);
  });

  it('registers the skill tool for an authoring run whose only skill is model-disabled', async () => {
    const ownedHidden: PageSkill = {
      ...makeSkill('owned-hidden-authoring', userObjectId),
      disableModelInvocation: true,
    };
    const listSkillsByAccess = buildPager([[ownedHidden]]);
    const result = await injectSkillCatalog(
      baseParams({ listSkillsByAccess, skillAuthoringAvailable: true }),
    );

    const definedNames = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(definedNames).toContain('skill');
    expect(definedNames).toContain('read_file');
    expect(result.skillCount).toBe(0);
    expect(result.activeSkillIds.map((id) => id.toString())).toEqual([ownedHidden._id.toString()]);
  });

  it('advertises authored skills only on authoring runs', async () => {
    const owned = makeSkill('owned-skill', userObjectId);
    const authoring = await injectSkillCatalog(
      baseParams({
        listSkillsByAccess: buildPager([[owned]]),
        skillAuthoringAvailable: true,
      }),
    );
    const catalogOnly = await injectSkillCatalog(
      baseParams({ listSkillsByAccess: buildPager([[owned]]) }),
    );

    const authoringDef = (authoring.toolDefinitions ?? []).find((d) => d.name === 'skill');
    const catalogOnlyDef = (catalogOnly.toolDefinitions ?? []).find((d) => d.name === 'skill');
    expect(authoringDef?.description).toContain('a skill you created in this conversation');
    expect(catalogOnlyDef?.description).toContain('Skill names come from the catalog only');
  });

  it('replaces an already-registered skill definition instead of leaving it stale', async () => {
    /**
     * Counting occurrences is not enough: a surviving catalog-only definition
     * tells an authoring run's model that a name it just created is invalid,
     * which is the failure this registration exists to prevent. Assert the
     * definition that survives, and assert the registry the host handler
     * resolves agrees with the array the model reads.
     */
    const owned = makeSkill('owned-skill', userObjectId);
    type ToolRegistryArg = NonNullable<Parameters<typeof injectSkillCatalog>[0]['toolRegistry']>;
    type ToolDef = Parameters<ToolRegistryArg['set']>[1];
    const preSkill: ToolDef = {
      name: 'skill',
      description: 'pre-registered catalog-only definition',
      parameters: { type: 'object', properties: {} },
    };
    const preRegistry = new Map<string, ToolDef>() as unknown as ToolRegistryArg;
    preRegistry.set('skill', preSkill);

    const result = await injectSkillCatalog(
      baseParams({
        listSkillsByAccess: buildPager([[owned]]),
        skillAuthoringAvailable: true,
        toolRegistry: preRegistry,
        toolDefinitions: [preSkill],
      }),
    );

    const skillDefs = (result.toolDefinitions ?? []).filter((d) => d.name === 'skill');
    expect(skillDefs).toHaveLength(1);
    expect(skillDefs[0].description).not.toBe(preSkill.description);
    expect(skillDefs[0].description).toContain('a skill you created in this conversation');
    expect((preRegistry as unknown as Map<string, ToolDef>).get('skill')).toBe(skillDefs[0]);
  });

  it('keeps the non-authoring variant live when it replaces a stale definition', async () => {
    /* Same replacement on a run that cannot author: the model must end up with
       the SDK definition, never a leftover from an earlier registration. */
    const owned = makeSkill('owned-skill', userObjectId);
    type ToolRegistryArg = NonNullable<Parameters<typeof injectSkillCatalog>[0]['toolRegistry']>;
    type ToolDef = Parameters<ToolRegistryArg['set']>[1];
    const preSkill: ToolDef = {
      name: 'skill',
      description: 'stale definition from an earlier registration',
      parameters: { type: 'object', properties: {} },
    };
    const preRegistry = new Map<string, ToolDef>() as unknown as ToolRegistryArg;
    preRegistry.set('skill', preSkill);

    const result = await injectSkillCatalog(
      baseParams({
        listSkillsByAccess: buildPager([[owned]]),
        toolRegistry: preRegistry,
        toolDefinitions: [preSkill],
      }),
    );

    const skillDefs = (result.toolDefinitions ?? []).filter((d) => d.name === 'skill');
    expect(skillDefs).toHaveLength(1);
    expect(skillDefs[0].description).toContain('Skill names come from the catalog only');
    expect((preRegistry as unknown as Map<string, ToolDef>).get('skill')).toBe(skillDefs[0]);
  });
});

describe('buildSkillPrimeMessage', () => {
  it('produces a meta user message carrying SKILL.md body and skillName marker', () => {
    const msg = buildSkillPrimeMessage({
      name: 'brand-guidelines',
      body: '# Brand guidelines\nUse blue.',
    });
    expect(msg).toEqual({
      role: 'user',
      content: '# Brand guidelines\nUse blue.',
      isMeta: true,
      source: 'skill',
      skillName: 'brand-guidelines',
    });
  });

  it('preserves empty-body content verbatim (resolver should filter before, but helper is agnostic)', () => {
    const msg = buildSkillPrimeMessage({ name: 'bare', body: '' });
    expect(msg.content).toBe('');
    expect(msg.isMeta).toBe(true);
  });
});

describe('resolveManualSkills', () => {
  const userId = new Types.ObjectId().toString();
  const userOid = new Types.ObjectId(userId);
  const otherAuthor = new Types.ObjectId();

  type SkillDoc = {
    _id: Types.ObjectId;
    name: string;
    body: string;
    author: Types.ObjectId;
    allowedTools?: string[];
    userInvocable?: boolean;
    deployment?: boolean;
  };

  const buildGetSkillByName =
    (skills: Record<string, SkillDoc | null>) =>
    async (name: string, _accessibleIds: Types.ObjectId[]) =>
      skills[name] ?? null;

  const mkSkill = (name: string, author: Types.ObjectId, body = `body of ${name}`): SkillDoc => ({
    _id: new Types.ObjectId(),
    name,
    body,
    author,
  });

  it('returns empty when no names supplied', async () => {
    const result = await resolveManualSkills({
      names: [],
      getSkillByName: buildGetSkillByName({}),
      accessibleSkillIds: [new Types.ObjectId()],
      userId,
    });
    expect(result).toEqual([]);
  });

  it('returns empty when no accessible IDs (ACL empty)', async () => {
    const result = await resolveManualSkills({
      names: ['foo'],
      getSkillByName: buildGetSkillByName({ foo: mkSkill('foo', userOid) }),
      accessibleSkillIds: [],
      userId,
    });
    expect(result).toEqual([]);
  });

  it('resolves owned skills to { name, body } pairs by default', async () => {
    const owned = mkSkill('my-skill', userOid, 'MY SKILL BODY');
    const result = await resolveManualSkills({
      names: ['my-skill'],
      getSkillByName: buildGetSkillByName({ 'my-skill': owned }),
      accessibleSkillIds: [owned._id],
      userId,
    });
    expect(result).toEqual([{ _id: owned._id, name: 'my-skill', body: 'MY SKILL BODY' }]);
  });

  it('passes allowedTools through when the skill doc carries the field', async () => {
    const owned: SkillDoc = {
      ...mkSkill('with-tools', userOid, 'body'),
      allowedTools: ['execute_code', 'read_file'],
    };
    const result = await resolveManualSkills({
      names: ['with-tools'],
      getSkillByName: buildGetSkillByName({ 'with-tools': owned }),
      accessibleSkillIds: [owned._id],
      userId,
    });
    expect(result).toEqual([
      {
        _id: owned._id,
        name: 'with-tools',
        body: 'body',
        allowedTools: ['execute_code', 'read_file'],
      },
    ]);
  });

  it('omits allowedTools when the skill doc does not declare it', async () => {
    const owned = mkSkill('no-tools', userOid, 'body');
    const [resolved] = await resolveManualSkills({
      names: ['no-tools'],
      getSkillByName: buildGetSkillByName({ 'no-tools': owned }),
      accessibleSkillIds: [owned._id],
      userId,
    });
    expect(resolved).toEqual({ _id: owned._id, name: 'no-tools', body: 'body' });
    expect(resolved).not.toHaveProperty('allowedTools');
  });

  it('preserves an empty allowedTools array (distinguishes "declared none" from "undeclared")', async () => {
    const owned: SkillDoc = { ...mkSkill('empty-tools', userOid, 'body'), allowedTools: [] };
    const [resolved] = await resolveManualSkills({
      names: ['empty-tools'],
      getSkillByName: buildGetSkillByName({ 'empty-tools': owned }),
      accessibleSkillIds: [owned._id],
      userId,
    });
    expect(resolved).toEqual({
      _id: owned._id,
      name: 'empty-tools',
      body: 'body',
      allowedTools: [],
    });
  });

  it('silently skips names with no backing skill (typo / ACL miss) without failing the batch', async () => {
    const real = mkSkill('real', userOid);
    const result = await resolveManualSkills({
      names: ['real', 'typo'],
      getSkillByName: buildGetSkillByName({ real }),
      accessibleSkillIds: [real._id],
      userId,
    });
    expect(result).toEqual([{ _id: real._id, name: 'real', body: 'body of real' }]);
  });

  it('does not log a raw submitted name when the requested skill cannot be resolved', async () => {
    const submittedName = 'PRIVATE-SKILL-NAME';
    const warn = jest.spyOn(logger, 'warn');

    const result = await resolveManualSkills({
      names: [submittedName],
      getSkillByName: buildGetSkillByName({}),
      accessibleSkillIds: [new Types.ObjectId()],
      userId,
    });

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[resolveManualSkills] Requested skill not found or not accessible',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(submittedName);
    warn.mockRestore();
  });

  it('silently skips skills with userInvocable: false, preserving the rest of the batch', async () => {
    const open = mkSkill('open', userOid);
    const modelOnly: SkillDoc = { ...mkSkill('model-only', userOid), userInvocable: false };
    const result = await resolveManualSkills({
      names: ['open', 'model-only'],
      getSkillByName: buildGetSkillByName({ open, 'model-only': modelOnly }),
      accessibleSkillIds: [open._id, modelOnly._id],
      userId,
    });
    /* Defense-in-depth: even if a popover-bypassing API caller names a
       userInvocable:false skill, the resolver drops it with a warn log
       rather than priming SKILL.md. The rest of the batch survives. */
    expect(result).toEqual([{ _id: open._id, name: 'open', body: 'body of open' }]);
  });

  it('passes preferUserInvocable to getSkillByName so name-collision picks the user-invocable doc, but does NOT pass preferModelInvocable (manual primes for disabled skills are supported)', async () => {
    /* Same-name collision scenario: the popover surfaced the older
       user-invocable doc; the resolver must look it up with
       preferUserInvocable so a newer model-only (`userInvocable: false`)
       duplicate doesn't silently shadow the user's selection. We
       deliberately do NOT pass preferModelInvocable — manually invoking
       a `disable-model-invocation: true` skill is the supported path
       (iter 4), and adding the model-invocable filter would skip those
       docs and break manual invocation of disabled skills. */
    const invocableDoc = mkSkill('collide', userOid, 'invocable body');
    const getSkillByName = jest.fn(
      async (
        _name: string,
        _ids: Types.ObjectId[],
        options?: { preferUserInvocable?: boolean; preferModelInvocable?: boolean },
      ) => {
        /* Return the invocable doc only when called with preferUserInvocable.
           Without the flag, this fake returns null (simulating the
           newer non-user-invocable duplicate scenario). */
        return options?.preferUserInvocable ? invocableDoc : null;
      },
    );
    const result = await resolveManualSkills({
      names: ['collide'],
      getSkillByName,
      accessibleSkillIds: [invocableDoc._id],
      userId,
    });
    expect(result).toEqual([{ _id: invocableDoc._id, name: 'collide', body: 'invocable body' }]);
    expect(getSkillByName).toHaveBeenCalledWith('collide', [invocableDoc._id], {
      preferUserInvocable: true,
    });
    /* Crucial: no preferModelInvocable — would skip disabled skills and
       break the iter 4 manual-prime exception for disabled skills. */
    const callOptions = getSkillByName.mock.calls[0][2];
    expect(callOptions).not.toHaveProperty('preferModelInvocable', true);
  });

  it('treats userInvocable: true (or absent) as user-invocable', async () => {
    const explicit: SkillDoc = { ...mkSkill('explicit', userOid), userInvocable: true };
    const implicit = mkSkill('implicit', userOid);
    const result = await resolveManualSkills({
      names: ['explicit', 'implicit'],
      getSkillByName: buildGetSkillByName({ explicit, implicit }),
      accessibleSkillIds: [explicit._id, implicit._id],
      userId,
    });
    expect(result).toEqual([
      { _id: explicit._id, name: 'explicit', body: 'body of explicit' },
      { _id: implicit._id, name: 'implicit', body: 'body of implicit' },
    ]);
  });

  it('dedupes repeated names, preserving first occurrence order', async () => {
    const a = mkSkill('a', userOid);
    const b = mkSkill('b', userOid);
    const result = await resolveManualSkills({
      names: ['a', 'b', 'a', 'b', 'a'],
      getSkillByName: buildGetSkillByName({ a, b }),
      accessibleSkillIds: [a._id, b._id],
      userId,
    });
    expect(result.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('filters shared skills when defaultActiveOnShare is false (unless override active=true)', async () => {
    const shared = mkSkill('shared', otherAuthor);
    const result = await resolveManualSkills({
      names: ['shared'],
      getSkillByName: buildGetSkillByName({ shared }),
      accessibleSkillIds: [shared._id],
      userId,
      defaultActiveOnShare: false,
    });
    expect(result).toEqual([]);
  });

  it('allows shared skills when defaultActiveOnShare is true', async () => {
    const shared = mkSkill('shared', otherAuthor, 'shared-body');
    const result = await resolveManualSkills({
      names: ['shared'],
      getSkillByName: buildGetSkillByName({ shared }),
      accessibleSkillIds: [shared._id],
      userId,
      defaultActiveOnShare: true,
    });
    expect(result).toEqual([{ _id: shared._id, name: 'shared', body: 'shared-body' }]);
  });

  it('allows deployment skills even when shared skills default inactive', async () => {
    const deployment = {
      ...mkSkill('deployment', otherAuthor, 'deployment-body'),
      deployment: true,
    };
    const result = await resolveManualSkills({
      names: ['deployment'],
      getSkillByName: buildGetSkillByName({ deployment }),
      accessibleSkillIds: [deployment._id],
      userId,
      defaultActiveOnShare: false,
    });
    expect(result).toEqual([{ _id: deployment._id, name: 'deployment', body: 'deployment-body' }]);
  });

  it('drops explicitly-deactivated skills (skillStates override wins over ownership default)', async () => {
    const owned = mkSkill('owned-off', userOid);
    const result = await resolveManualSkills({
      names: ['owned-off'],
      getSkillByName: buildGetSkillByName({ 'owned-off': owned }),
      accessibleSkillIds: [owned._id],
      userId,
      skillStates: { [owned._id.toString()]: false },
    });
    expect(result).toEqual([]);
  });

  it('allows explicitly-activated shared skill even when defaultActiveOnShare is false', async () => {
    const shared = mkSkill('shared-on', otherAuthor, 'on-body');
    const result = await resolveManualSkills({
      names: ['shared-on'],
      getSkillByName: buildGetSkillByName({ 'shared-on': shared }),
      accessibleSkillIds: [shared._id],
      userId,
      defaultActiveOnShare: false,
      skillStates: { [shared._id.toString()]: true },
    });
    expect(result).toEqual([{ _id: shared._id, name: 'shared-on', body: 'on-body' }]);
  });

  it('skips skills with empty bodies (priming nothing adds no value)', async () => {
    const empty = mkSkill('empty', userOid, '');
    const result = await resolveManualSkills({
      names: ['empty'],
      getSkillByName: buildGetSkillByName({ empty }),
      accessibleSkillIds: [empty._id],
      userId,
    });
    expect(result).toEqual([]);
  });

  it('swallows getSkillByName errors per-name so one bad lookup does not drop the rest', async () => {
    const good = mkSkill('good', userOid, 'good-body');
    const getSkillByName = async (name: string) => {
      if (name === 'boom') {
        throw new Error('db exploded');
      }
      return name === 'good' ? good : null;
    };
    const result = await resolveManualSkills({
      names: ['boom', 'good'],
      getSkillByName,
      accessibleSkillIds: [good._id],
      userId,
    });
    expect(result).toEqual([{ _id: good._id, name: 'good', body: 'good-body' }]);
  });

  it('truncates manual skill lists above MAX_MANUAL_SKILLS to bound concurrent DB lookups', async () => {
    const skills: Record<string, SkillDoc> = {};
    const names: string[] = [];
    for (let i = 0; i < MAX_MANUAL_SKILLS + 5; i++) {
      const name = `s${i}`;
      skills[name] = mkSkill(name, userOid, `body-${i}`);
      names.push(name);
    }
    const getSkillByName = jest.fn(buildGetSkillByName(skills));
    const result = await resolveManualSkills({
      names,
      getSkillByName,
      accessibleSkillIds: names.map((n) => skills[n]._id),
      userId,
    });
    expect(result).toHaveLength(MAX_MANUAL_SKILLS);
    expect(getSkillByName).toHaveBeenCalledTimes(MAX_MANUAL_SKILLS);
    // Preserves input order — drops the tail, keeps the head.
    expect(result.map((r) => r.name)).toEqual(names.slice(0, MAX_MANUAL_SKILLS));
  });

  it('applies the cap AFTER dedup so repeated names do not consume slots', async () => {
    const skills: Record<string, SkillDoc> = {};
    const uniqueCount = MAX_MANUAL_SKILLS;
    for (let i = 0; i < uniqueCount; i++) {
      const name = `u${i}`;
      skills[name] = mkSkill(name, userOid, `body-${i}`);
    }
    // Duplicate every name 3x — total length 3 × MAX_MANUAL_SKILLS, unique = MAX_MANUAL_SKILLS.
    const names: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < uniqueCount; i++) {
        names.push(`u${i}`);
      }
    }
    const result = await resolveManualSkills({
      names,
      getSkillByName: buildGetSkillByName(skills),
      accessibleSkillIds: Object.values(skills).map((s) => s._id),
      userId,
    });
    expect(result).toHaveLength(uniqueCount);
  });
});

describe('injectManualSkillPrimes', () => {
  const prime = (name: string, body: string) => ({ name, body });

  it('no-ops when manualSkillPrimes is empty', () => {
    const messages = [new HumanMessage('hello')];
    const map = { 0: 10 };
    const result = injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: map,
      manualSkillPrimes: [],
    });
    expect(result.inserted).toBe(0);
    expect(result.insertIdx).toBe(-1);
    expect(messages).toHaveLength(1);
    expect(result.indexTokenCountMap).toBe(map);
  });

  it('no-ops when initialMessages is empty', () => {
    const messages: HumanMessage[] = [];
    const result = injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [prime('foo', 'body')],
    });
    expect(result.inserted).toBe(0);
    expect(result.insertIdx).toBe(-1);
    expect(messages).toHaveLength(0);
  });

  it('inserts a single prime right before the last message when there is only one message', () => {
    const userMsg = new HumanMessage('What is X?');
    const messages = [userMsg];
    const result = injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: { 0: 7 },
      manualSkillPrimes: [prime('x', 'X means...')],
    });
    expect(result.inserted).toBe(1);
    expect(result.insertIdx).toBe(0);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('X means...');
    expect(messages[1]).toBe(userMsg);
    // The prior-index-0 count follows the message it was attached to: now at idx 1.
    expect(result.indexTokenCountMap).toEqual({ 1: 7 });
  });

  it('inserts multiple primes in input order right before the last message', () => {
    const messages: (HumanMessage | AIMessage)[] = [
      new HumanMessage('turn 1 user'),
      new AIMessage('turn 1 reply'),
      new HumanMessage('turn 2 user'),
    ];
    const result = injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: { 0: 1, 1: 2, 2: 3 },
      manualSkillPrimes: [prime('a', 'A body'), prime('b', 'B body')],
    });
    expect(result.inserted).toBe(2);
    expect(result.insertIdx).toBe(2);
    expect(messages).toHaveLength(5);
    expect(messages[0].content).toBe('turn 1 user');
    expect(messages[1].content).toBe('turn 1 reply');
    expect(messages[2].content).toBe('A body');
    expect(messages[3].content).toBe('B body');
    expect(messages[4].content).toBe('turn 2 user');
    // idx 0 unchanged, idx 1 unchanged, idx 2 shifts to 4 (+ numPrimes).
    expect(result.indexTokenCountMap).toEqual({ 0: 1, 1: 2, 4: 3 });
  });

  it('primes carry isMeta / source / skillName advisory markers in additional_kwargs', () => {
    const messages = [new HumanMessage('hi')];
    injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [prime('brand', 'brand-body')],
    });
    const primed = messages[0] as HumanMessage;
    expect(primed.additional_kwargs).toEqual({
      isMeta: true,
      source: 'skill',
      trigger: 'manual',
      skillName: 'brand',
    });
  });

  it('uses `>=` when shifting the map so the message originally at insertIdx follows its count forward', () => {
    // Regression guard: a `>` bug here would leave the last user message's
    // token count attached to one of the new primes instead.
    const messages = [new HumanMessage('older'), new HumanMessage('latest')];
    const result = injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: { 0: 5, 1: 11 },
      manualSkillPrimes: [prime('x', 'x body')],
    });
    // insertIdx = 1, numPrimes = 1. Entry at idx 1 must move to idx 2.
    expect(result.indexTokenCountMap).toEqual({ 0: 5, 2: 11 });
  });

  it('handles undefined indexTokenCountMap (formatAgentMessages omitted the map)', () => {
    const messages = [new HumanMessage('hi')];
    const result = injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [prime('x', 'body')],
    });
    expect(result.inserted).toBe(1);
    expect(result.indexTokenCountMap).toBeUndefined();
  });
});

describe('extractManualSkills', () => {
  it('returns undefined for null / non-object bodies', () => {
    expect(extractManualSkills(null)).toBeUndefined();
    expect(extractManualSkills(undefined)).toBeUndefined();
    expect(extractManualSkills('string')).toBeUndefined();
    expect(extractManualSkills(42)).toBeUndefined();
  });

  it('returns undefined when manualSkills is missing or not an array', () => {
    expect(extractManualSkills({})).toBeUndefined();
    expect(extractManualSkills({ manualSkills: 'foo' })).toBeUndefined();
    expect(extractManualSkills({ manualSkills: { 0: 'foo' } })).toBeUndefined();
  });

  it('passes through valid string[] input untouched', () => {
    expect(extractManualSkills({ manualSkills: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('filters out non-string elements that a TS-oblivious payload might include', () => {
    expect(
      extractManualSkills({
        manualSkills: ['ok', 123, null, { $gt: '' }, undefined, 'also-ok'],
      }),
    ).toEqual(['ok', 'also-ok']);
  });

  it('filters out empty strings', () => {
    expect(extractManualSkills({ manualSkills: ['', 'real', ''] })).toEqual(['real']);
  });

  it('returns undefined when the array is present but contains no valid strings', () => {
    expect(extractManualSkills({ manualSkills: [123, null, ''] })).toBeUndefined();
    expect(extractManualSkills({ manualSkills: [] })).toBeUndefined();
  });
});

describe('isSkillPrimeMessage', () => {
  it('returns true for a prime produced by injectManualSkillPrimes', () => {
    const messages = [new HumanMessage('user turn')];
    injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [{ name: 'x', body: 'x body' }],
    });
    expect(isSkillPrimeMessage(messages[0])).toBe(true);
  });

  it('returns false for plain HumanMessage / AIMessage without the marker', () => {
    expect(isSkillPrimeMessage(new HumanMessage('hi'))).toBe(false);
    expect(isSkillPrimeMessage(new AIMessage('reply'))).toBe(false);
  });

  it('returns false for additional_kwargs with a different source', () => {
    const m = new HumanMessage({
      content: 'x',
      additional_kwargs: { source: 'not-a-skill' },
    });
    expect(isSkillPrimeMessage(m)).toBe(false);
  });

  it('returns false for non-object / null / undefined inputs', () => {
    expect(isSkillPrimeMessage(null)).toBe(false);
    expect(isSkillPrimeMessage(undefined)).toBe(false);
    expect(isSkillPrimeMessage('just a string')).toBe(false);
    expect(isSkillPrimeMessage(42)).toBe(false);
  });

  it('filter() on a mixed array keeps the non-prime messages', () => {
    const user = new HumanMessage('real turn');
    const messages: (HumanMessage | AIMessage)[] = [new AIMessage('reply'), user];
    injectManualSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [{ name: 'x', body: 'x body' }],
    });
    // After priming: [AIMessage, primeHumanMessage, user]
    const stripped = messages.filter((m) => !isSkillPrimeMessage(m));
    expect(stripped).toHaveLength(2);
    expect(stripped[1]).toBe(user);
  });
});

describe('buildSkillPrimeContentParts', () => {
  it('produces one completed tool_call content part per prime', () => {
    const parts = buildSkillPrimeContentParts(
      [
        { name: 'brand', body: '# Brand' },
        { name: 'legal', body: '# Legal' },
      ],
      { runId: 'msg_abc' },
    );
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('tool_call');
    expect(parts[0].tool_call.name).toBe('skill');
    expect(parts[0].tool_call.progress).toBe(1);
    expect(parts[0].tool_call.type).toBe('tool_call');
  });

  it('encodes skillName as a JSON string in args (matches the SkillCall renderer contract)', () => {
    const [part] = buildSkillPrimeContentParts([{ name: 'pdf-reader', body: '...' }], {
      runId: 'msg_1',
    });
    expect(JSON.parse(part.tool_call.args)).toEqual({ skillName: 'pdf-reader' });
  });

  it('produces a human-readable output string the frontend can expand', () => {
    const [part] = buildSkillPrimeContentParts([{ name: 'research', body: '...' }], {
      runId: 'msg_1',
    });
    expect(part.tool_call.output).toContain('research');
    expect(part.tool_call.output).toContain('loaded');
  });

  it('assigns unique tool_call IDs seeded from runId + index', () => {
    const parts = buildSkillPrimeContentParts(
      [
        { name: 'a', body: 'a' },
        { name: 'b', body: 'b' },
      ],
      { runId: 'msg_xyz' },
    );
    const ids = parts.map((p) => p.tool_call.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toContain('msg_xyz');
    expect(ids[1]).toContain('msg_xyz');
  });

  it('returns an empty array for empty input', () => {
    expect(buildSkillPrimeContentParts([], { runId: 'msg_1' })).toEqual([]);
  });

  it('respects startOffset when seeding IDs (callers prepending to a populated list)', () => {
    const first = buildSkillPrimeContentParts([{ name: 'x', body: 'x' }], { runId: 'msg_1' });
    const second = buildSkillPrimeContentParts([{ name: 'x', body: 'x' }], {
      runId: 'msg_1',
      startOffset: 5,
    });
    expect(first[0].tool_call.id).not.toBe(second[0].tool_call.id);
  });
});

describe('unionPrimeAllowedTools', () => {
  it('returns no extras when no primes carry allowedTools', () => {
    const result = unionPrimeAllowedTools({
      primes: [{ name: 'a' }, { name: 'b', allowedTools: [] }],
      agentToolNames: ['web_search'],
    });
    expect(result.extraToolNames).toEqual([]);
    expect(result.perSkillExtras.size).toBe(0);
  });

  it('skips tools already configured on the agent (agent baseline wins)', () => {
    const result = unionPrimeAllowedTools({
      primes: [{ name: 'skill-a', allowedTools: ['web_search', 'execute_code'] }],
      agentToolNames: ['web_search'],
    });
    /* web_search is already on the agent — only execute_code is "extra". */
    expect(result.extraToolNames).toEqual(['execute_code']);
    expect(result.perSkillExtras.get('skill-a')).toEqual(['execute_code']);
  });

  it('dedupes across skills (same tool requested by two primes counts once)', () => {
    const result = unionPrimeAllowedTools({
      primes: [
        { name: 'skill-a', allowedTools: ['execute_code', 'read_file'] },
        { name: 'skill-b', allowedTools: ['execute_code', 'web_search'] },
      ],
      agentToolNames: [],
    });
    expect(result.extraToolNames.sort()).toEqual(['execute_code', 'read_file', 'web_search']);
    /* Per-skill attribution credits the FIRST skill that contributed
       a tool name — keeps debug logs stable instead of duplicating. */
    expect(result.perSkillExtras.get('skill-a')).toEqual(['execute_code', 'read_file']);
    expect(result.perSkillExtras.get('skill-b')).toEqual(['web_search']);
  });

  it('filters out empty / non-string entries (defensive — frontmatter parser should already)', () => {
    const result = unionPrimeAllowedTools({
      primes: [
        {
          name: 'skill-a',
          allowedTools: ['execute_code', '', 42 as unknown as string, 'web_search'],
        },
      ],
      agentToolNames: [],
    });
    expect(result.extraToolNames).toEqual(['execute_code', 'web_search']);
  });

  it('omits skills with no contribution from the per-skill map', () => {
    const result = unionPrimeAllowedTools({
      primes: [
        { name: 'skill-on-agent', allowedTools: ['web_search'] },
        { name: 'skill-extra', allowedTools: ['execute_code'] },
      ],
      agentToolNames: ['web_search'],
    });
    expect(result.extraToolNames).toEqual(['execute_code']);
    expect(result.perSkillExtras.get('skill-on-agent')).toBeUndefined();
    expect(result.perSkillExtras.get('skill-extra')).toEqual(['execute_code']);
  });

  it('preserves first-occurrence order across skills (deterministic for log readability)', () => {
    const result = unionPrimeAllowedTools({
      primes: [
        { name: 'a', allowedTools: ['z-tool'] },
        { name: 'b', allowedTools: ['m-tool', 'a-tool'] },
        { name: 'c', allowedTools: ['z-tool', 'b-tool'] },
      ],
      agentToolNames: [],
    });
    expect(result.extraToolNames).toEqual(['z-tool', 'm-tool', 'a-tool', 'b-tool']);
  });
});

describe('resolveAlwaysApplySkills', () => {
  const userId = new Types.ObjectId().toString();
  const userOid = new Types.ObjectId(userId);
  const otherAuthor = new Types.ObjectId();

  type AlwaysApplyRow = {
    _id: Types.ObjectId;
    name: string;
    body: string;
    author: Types.ObjectId | string;
    allowedTools?: string[];
    deployment?: boolean;
  };

  const mkRow = (
    name: string,
    author: Types.ObjectId,
    body = `body of ${name}`,
  ): AlwaysApplyRow => ({
    _id: new Types.ObjectId(),
    name,
    body,
    author,
  });

  /** Single-page lister — emits every row on page 1, then signals `has_more: false`. */
  const buildLister = (rows: AlwaysApplyRow[]) =>
    jest.fn().mockResolvedValue({ skills: rows, has_more: false, after: null });

  /**
   * Multi-page lister driven by a cursor string. Each `page` is a
   * slice of rows emitted on the matching cursor call, with `has_more`
   * / `after` set automatically so the resolver advances through the
   * pages in order.
   */
  const buildPagedLister = (pages: AlwaysApplyRow[][]) =>
    jest.fn().mockImplementation(async (args: { cursor?: string | null }) => {
      const idx = args.cursor ? Number(args.cursor) : 0;
      const skills = pages[idx] ?? [];
      const has_more = idx < pages.length - 1;
      return { skills, has_more, after: has_more ? String(idx + 1) : null };
    });

  it('returns empty when accessibleSkillIds is empty', async () => {
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([mkRow('foo', userOid)]),
      accessibleSkillIds: [],
      userId,
    });
    expect(result).toEqual([]);
  });

  it('resolves owned always-apply skills into the prime shape by default', async () => {
    const row = mkRow('my-always', userOid, 'BODY');
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([row]),
      accessibleSkillIds: [row._id],
      userId,
    });
    expect(result).toEqual([{ _id: row._id, name: 'my-always', body: 'BODY' }]);
  });

  it('passes allowedTools through when the row declares them', async () => {
    const row: AlwaysApplyRow = {
      ...mkRow('with-tools', userOid, 'body'),
      allowedTools: ['execute_code'],
    };
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([row]),
      accessibleSkillIds: [row._id],
      userId,
    });
    expect(result).toEqual([
      { _id: row._id, name: 'with-tools', body: 'body', allowedTools: ['execute_code'] },
    ]);
  });

  it('filters shared always-apply skills when defaultActiveOnShare is false', async () => {
    const shared = mkRow('shared', otherAuthor);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([shared]),
      accessibleSkillIds: [shared._id],
      userId,
      defaultActiveOnShare: false,
    });
    expect(result).toEqual([]);
  });

  it('allows shared always-apply skills when defaultActiveOnShare is true', async () => {
    const shared = mkRow('shared-on', otherAuthor, 'shared-body');
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([shared]),
      accessibleSkillIds: [shared._id],
      userId,
      defaultActiveOnShare: true,
    });
    expect(result).toEqual([{ _id: shared._id, name: 'shared-on', body: 'shared-body' }]);
  });

  it('allows deployment always-apply skills even when shared skills default inactive', async () => {
    const deployment: AlwaysApplyRow = {
      ...mkRow('deployment-always', otherAuthor, 'deployment body'),
      deployment: true,
    };
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([deployment]),
      accessibleSkillIds: [deployment._id],
      userId,
      defaultActiveOnShare: false,
    });
    expect(result).toEqual([
      { _id: deployment._id, name: 'deployment-always', body: 'deployment body' },
    ]);
  });

  it('honors explicit deactivation override even for owned skills', async () => {
    const owned = mkRow('owned-off', userOid);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([owned]),
      accessibleSkillIds: [owned._id],
      userId,
      skillStates: { [owned._id.toString()]: false },
    });
    expect(result).toEqual([]);
  });

  it('skips rows with empty bodies (priming nothing adds no value)', async () => {
    const empty = mkRow('empty', userOid, '');
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: buildLister([empty]),
      accessibleSkillIds: [empty._id],
      userId,
    });
    expect(result).toEqual([]);
  });

  it('issues a paginated fetch with a roomy page size (not the active budget as the DB cap)', async () => {
    const row = mkRow('n1', userOid);
    const lister = buildLister([row]);
    await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [row._id],
      userId,
    });
    // Page size must be larger than MAX_ALWAYS_APPLY_SKILLS so a single
    // page normally suffices; using the budget itself as the DB cap would
    // starve the active-state filter when early rows are inactive.
    const call = lister.mock.calls[0][0] as { limit: number };
    expect(call.limit).toBeGreaterThan(MAX_ALWAYS_APPLY_SKILLS);
  });

  it('respects a caller-supplied maxAlwaysApplySkills cap on the number of active primes', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => mkRow(`n${i}`, userOid));
    const lister = buildLister(rows);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: rows.map((r) => r._id),
      userId,
      maxAlwaysApplySkills: 3,
    });
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(['n0', 'n1', 'n2']);
  });

  it('stops paginating once maxAlwaysApplySkills active primes are collected', async () => {
    const page1 = Array.from({ length: 5 }, (_, i) => mkRow(`p1-${i}`, userOid));
    const page2 = Array.from({ length: 5 }, (_, i) => mkRow(`p2-${i}`, userOid));
    const lister = buildPagedLister([page1, page2]);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [...page1, ...page2].map((r) => r._id),
      userId,
      maxAlwaysApplySkills: 3,
    });
    expect(result).toHaveLength(3);
    // Only needed the first page's first 3 rows — never asked for page 2.
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it('returns [] when maxAlwaysApplySkills is 0 (no-op short-circuit before DB)', async () => {
    const lister = buildLister([mkRow('n1', userOid)]);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [new Types.ObjectId()],
      userId,
      maxAlwaysApplySkills: 0,
    });
    expect(result).toEqual([]);
    expect(lister).not.toHaveBeenCalled();
  });

  it('paginates across inactive-for-user rows to fill the active budget (no silent starvation)', async () => {
    // Page 1 is all shared-inactive (defaultActiveOnShare: false).
    const inactivePage = Array.from({ length: 5 }, (_, i) => mkRow(`shared-${i}`, otherAuthor));
    // Page 2 has owned (always-active) rows that should backfill the budget.
    const ownedPage = Array.from({ length: 3 }, (_, i) => mkRow(`owned-${i}`, userOid));
    const lister = buildPagedLister([inactivePage, ownedPage]);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [...inactivePage, ...ownedPage].map((r) => r._id),
      userId,
      defaultActiveOnShare: false,
      maxAlwaysApplySkills: 5,
    });
    expect(result.map((r) => r.name)).toEqual(['owned-0', 'owned-1', 'owned-2']);
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('dedupes duplicate-named always-apply skills (keeps first/freshest by DB sort)', async () => {
    // Same `name` but distinct `_id` — mimics two authors in the same
    // tenant shipping skills with matching names that both ended up in
    // the user's accessible set. DB sort puts the row returned first
    // as the "fresher" one (updatedAt desc).
    const fresh = mkRow('shared-name', userOid, 'FRESH BODY');
    const stale = mkRow('shared-name', otherAuthor, 'STALE BODY');
    const lister = buildLister([fresh, stale]);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [fresh._id, stale._id],
      userId,
      defaultActiveOnShare: true,
    });
    expect(result).toEqual([{ _id: fresh._id, name: 'shared-name', body: 'FRESH BODY' }]);
  });

  it('dedupes across page boundaries, not just within a single page', async () => {
    const page1 = [mkRow('dup', userOid, 'FIRST')];
    const page2 = [mkRow('dup', userOid, 'SECOND')];
    const lister = buildPagedLister([page1, page2]);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [page1[0]._id, page2[0]._id],
      userId,
      maxAlwaysApplySkills: 5,
    });
    expect(result).toEqual([{ _id: page1[0]._id, name: 'dup', body: 'FIRST' }]);
  });

  it('stops after MAX_ALWAYS_APPLY_PAGES even when no active row is found', async () => {
    const inactivePage = Array.from({ length: 20 }, (_, i) => mkRow(`shared-${i}`, otherAuthor));
    // 12 inactive pages — loop must cap out at MAX_ALWAYS_APPLY_PAGES (10)
    // rather than scanning indefinitely.
    const pages = Array.from({ length: 12 }, () => inactivePage);
    const lister = buildPagedLister(pages);
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: inactivePage.map((r) => r._id),
      userId,
      defaultActiveOnShare: false,
    });
    expect(result).toEqual([]);
    expect(lister).toHaveBeenCalledTimes(10);
  });

  it('terminates early when has_more is false even below the active budget', async () => {
    const page = [mkRow('solo', userOid)];
    const lister = buildPagedLister([page]);
    await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [page[0]._id],
      userId,
    });
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it('swallows lister errors and returns [] so a DB blip does not block the turn', async () => {
    const lister = jest.fn().mockRejectedValue(new Error('db down'));
    const result = await resolveAlwaysApplySkills({
      listAlwaysApplySkills: lister,
      accessibleSkillIds: [new Types.ObjectId()],
      userId,
    });
    expect(result).toEqual([]);
  });
});

describe('injectSkillPrimes', () => {
  const manual = (name: string, body: string) => ({ name, body });
  const always = (name: string, body: string) => ({ name, body });

  it('selects the shared model-bound prime set before downstream consumers run', () => {
    const selected = selectSkillPrimesForTurn({
      manualSkillPrimes: [manual('shared', 'manual'), manual('explicit', 'explicit')],
      alwaysApplySkillPrimes: [
        always('shared', 'discarded'),
        always('ambient-1', 'ambient-1'),
        always('ambient-2', 'ambient-2'),
      ],
      maxPrimesPerTurn: 3,
    });

    expect(selected.manualSkillPrimes.map(({ name }) => name)).toEqual(['shared', 'explicit']);
    expect(selected.alwaysApplySkillPrimes.map(({ name }) => name)).toEqual(['ambient-1']);
    expect(selected.alwaysApplyDedupedFromManual).toBe(1);
    expect(selected.alwaysApplyDropped).toBe(1);
  });

  it('splices both lists with always-apply first, manual last (closer to user msg)', () => {
    const userMsg = new HumanMessage('what next?');
    const messages = [userMsg];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [manual('brand', 'brand-body')],
      alwaysApplySkillPrimes: [always('legal', 'legal-body')],
    });
    expect(result.inserted).toBe(2);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('legal-body');
    expect(messages[1].content).toBe('brand-body');
    expect(messages[2]).toBe(userMsg);
  });

  it('tags triggers distinctly on each primed HumanMessage', () => {
    const messages = [new HumanMessage('hello')];
    injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [manual('m', 'm-body')],
      alwaysApplySkillPrimes: [always('a', 'a-body')],
    });
    const alwaysPrime = messages[0] as HumanMessage;
    const manualPrime = messages[1] as HumanMessage;
    expect(alwaysPrime.additional_kwargs.trigger).toBe('always-apply');
    expect(manualPrime.additional_kwargs.trigger).toBe('manual');
  });

  it('is a no-op when both lists are empty/undefined', () => {
    const messages = [new HumanMessage('hi')];
    const map = { 0: 7 };
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: map,
    });
    expect(result.inserted).toBe(0);
    expect(result.insertIdx).toBe(-1);
    expect(messages).toHaveLength(1);
    expect(result.indexTokenCountMap).toBe(map);
  });

  it('truncates always-apply first when combined total exceeds maxPrimesPerTurn', () => {
    const messages = [new HumanMessage('user')];
    const manualSkillPrimes = [manual('m1', 'm1'), manual('m2', 'm2')];
    const alwaysApplySkillPrimes = [always('a1', 'a1'), always('a2', 'a2'), always('a3', 'a3')];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes,
      alwaysApplySkillPrimes,
      maxPrimesPerTurn: 3, // total 5, cap 3 → 1 always-apply survives
    });
    expect(result.inserted).toBe(3);
    expect(result.alwaysApplyDropped).toBe(2);
    // Ordering: [a1, m1, m2, user]
    expect(messages.map((m) => (m as HumanMessage).content)).toEqual(['a1', 'm1', 'm2', 'user']);
  });

  it('preserves all manual primes when the cap is below their count (budget clamped to 0)', () => {
    const messages = [new HumanMessage('user')];
    const manualSkillPrimes = Array.from({ length: 5 }, (_, i) => manual(`m${i}`, `m${i}`));
    const alwaysApplySkillPrimes = [always('a1', 'a1'), always('a2', 'a2')];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes,
      alwaysApplySkillPrimes,
      maxPrimesPerTurn: 3,
    });
    // Manual (5) already exceeds cap (3); budget for always-apply is 0.
    expect(result.alwaysApplyDropped).toBe(2);
    // All 5 manual primes still land (cap defense is manual-preserving; upstream
    // resolver is responsible for capping manual to MAX_MANUAL_SKILLS before here).
    expect(result.inserted).toBe(5);
    const contents = messages.map((m) => (m as HumanMessage).content);
    expect(contents).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'user']);
  });

  it('uses MAX_PRIMED_SKILLS_PER_TURN as the default combined cap', () => {
    const messages = [new HumanMessage('user')];
    // Land exactly 1 over the cap so we can observe the drop
    const overCapCount = MAX_PRIMED_SKILLS_PER_TURN + 1;
    const alwaysApplySkillPrimes = Array.from({ length: overCapCount }, (_, i) =>
      always(`a${i}`, `a${i}`),
    );
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      alwaysApplySkillPrimes,
    });
    expect(result.alwaysApplyDropped).toBe(1);
    expect(result.inserted).toBe(MAX_PRIMED_SKILLS_PER_TURN);
  });

  it('shifts indexTokenCountMap for combined splices', () => {
    const messages = [new HumanMessage('user-0'), new HumanMessage('user-1')];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: { 0: 3, 1: 5 },
      manualSkillPrimes: [manual('m', 'm-body')],
      alwaysApplySkillPrimes: [always('a', 'a-body')],
    });
    // insertIdx = 1, numPrimes = 2 → entry at idx 1 moves to idx 3
    expect(result.indexTokenCountMap).toEqual({ 0: 3, 3: 5 });
  });

  it('drops an always-apply prime whose name is already in the manual list (no double-prime)', () => {
    const messages = [new HumanMessage('user')];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [manual('legal', 'manual-body')],
      alwaysApplySkillPrimes: [always('legal', 'always-body')],
    });
    // Only the manual variant survives; same SKILL.md body never lands twice.
    expect(result.inserted).toBe(1);
    expect(result.alwaysApplyDedupedFromManual).toBe(1);
    expect(messages).toHaveLength(2);
    expect((messages[0] as HumanMessage).content).toBe('manual-body');
    expect((messages[0] as HumanMessage).additional_kwargs.trigger).toBe('manual');
  });

  it('dedups only the overlapping name and keeps disjoint always-apply primes', () => {
    const messages = [new HumanMessage('user')];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes: [manual('shared', 'shared-manual')],
      alwaysApplySkillPrimes: [always('shared', 'shared-always'), always('distinct', 'dist-body')],
    });
    expect(result.inserted).toBe(2);
    expect(result.alwaysApplyDedupedFromManual).toBe(1);
    // Order: always-apply first (distinct), then manual (shared), then user.
    const contents = messages.map((m) => (m as HumanMessage).content);
    expect(contents).toEqual(['dist-body', 'shared-manual', 'user']);
  });

  it('dedups before applying the combined cap so the cap reflects real primes', () => {
    const messages = [new HumanMessage('user')];
    const manualSkillPrimes = [manual('shared', 'mb')];
    // Two always-apply entries, one of which overlaps manual. After dedup:
    // manual(1) + always-apply(1) = 2, well under the cap — no warn-level drop.
    const alwaysApplySkillPrimes = [always('shared', 'ab'), always('ambient', 'amb-body')];
    const result = injectSkillPrimes({
      initialMessages: messages,
      indexTokenCountMap: undefined,
      manualSkillPrimes,
      alwaysApplySkillPrimes,
      maxPrimesPerTurn: 3,
    });
    expect(result.alwaysApplyDedupedFromManual).toBe(1);
    expect(result.alwaysApplyDropped).toBe(0);
    expect(result.inserted).toBe(2);
  });
});

describe('collectFreshSkillPrimeNames', () => {
  it('returns the union of manual + always-apply prime names', () => {
    const names = collectFreshSkillPrimeNames({
      manualSkillPrimes: [{ name: 'pdf-analyzer' }, { name: 'code-review' }],
      alwaysApplySkillPrimes: [{ name: 'clickhouse-best-practices' }],
    });
    expect(names).toEqual(new Set(['pdf-analyzer', 'code-review', 'clickhouse-best-practices']));
  });

  it('dedupes a skill that is both manual and always-apply', () => {
    const names = collectFreshSkillPrimeNames({
      manualSkillPrimes: [{ name: 'clickhouse-best-practices' }],
      alwaysApplySkillPrimes: [{ name: 'clickhouse-best-practices' }],
    });
    expect(names.size).toBe(1);
    expect(names.has('clickhouse-best-practices')).toBe(true);
  });

  it('handles undefined / empty inputs', () => {
    expect(collectFreshSkillPrimeNames({}).size).toBe(0);
    expect(
      collectFreshSkillPrimeNames({
        manualSkillPrimes: [],
        alwaysApplySkillPrimes: [],
      }).size,
    ).toBe(0);
  });

  it('collects names from only one side when the other is absent', () => {
    expect(
      collectFreshSkillPrimeNames({
        alwaysApplySkillPrimes: [{ name: 'only-always' }],
      }),
    ).toEqual(new Set(['only-always']));
    expect(
      collectFreshSkillPrimeNames({
        manualSkillPrimes: [{ name: 'only-manual' }],
      }),
    ).toEqual(new Set(['only-manual']));
  });
});
