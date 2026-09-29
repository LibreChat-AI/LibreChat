import { RE2JS, RE2Set } from 're2js';
import { logger } from '@librechat/data-schemas';
import { FILTER_PII_STARTER_PATTERNS } from 'librechat-data-provider';
import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { ContentFieldMap, ContentSource, TextContentFragment } from './types';
import {
  createConfiguredContentInspector,
  inspectContent,
  inspectContentWithTraversal,
} from './runtime';
import { ContentTraversalLimitError } from './adapters/nested';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const BLOCK_PATTERN = {
  id: 'org-token',
  label: 'organization token',
  regex: 'ORG-[A-Z]+',
};

const STARTER_PATTERN_CASES = [
  ['sk_prefix', 'sk-project-CONTRACT'],
  ['bearer_header', 'Authorization: Bearer contract-token'],
  ['api_key_header', 'api-key: contract-token'],
] as const;

function fragment<Source extends ContentSource>(
  source: Source,
  field: ContentFieldMap[Source],
  text = 'ORG-SECRET',
): Extract<TextContentFragment, { source: Source }> {
  return {
    id: `${source}.${field}`,
    text,
    path: `/${source}/${field}`,
    source,
    field,
    format: 'plain',
    treatment: 'replaceable',
    provenance: 'user',
  } as Extract<TextContentFragment, { source: Source }>;
}

describe('configured content inspection', () => {
  it('does no work when neither the generic nor legacy filter is configured', () => {
    expect(createConfiguredContentInspector({})).toBeNull();
    expect(inspectContent([fragment('message', 'text')], {})).toBeNull();
  });

  it('blocks a partial fragment before returning its traversal failure', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          fields: ['frontmatter'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const error = new ContentTraversalLimitError(
      [fragment('skill', 'frontmatter')],
      [{ source: 'skill', fields: ['frontmatter'] }],
    );

    const result = inspectContentWithTraversal(
      () => {
        throw error;
      },
      { filters },
    );

    expect(result.finding).toMatchObject({ source: 'skill', field: 'frontmatter' });
    expect(result.traversalError).toBeNull();
  });

  it('returns a traversal failure when its incomplete scope remains protected', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          fields: ['frontmatter'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const error = new ContentTraversalLimitError(
      [fragment('skill', 'frontmatter', 'safe visible value')],
      [{ source: 'skill', fields: ['frontmatter'] }],
    );

    const result = inspectContentWithTraversal(
      () => {
        throw error;
      },
      { filters },
    );

    expect(result).toEqual({ finding: null, traversalError: error });
  });

  it('ignores a traversal failure outside the selected policy fields', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          fields: ['description'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const error = new ContentTraversalLimitError(
      [fragment('skill', 'frontmatter')],
      [{ source: 'skill', fields: ['frontmatter'] }],
    );

    const result = inspectContentWithTraversal(
      () => {
        throw error;
      },
      { filters },
    );

    expect(result).toEqual({ finding: null, traversalError: null });
  });

  it('selects generic rules by both source and field and returns raw-free metadata', () => {
    const filters: FiltersConfig = {
      prompts: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const secret = 'ORG-DO-NOT-ECHO';

    const finding = inspectContent(
      [
        fragment('prompt', 'description', secret),
        fragment('message', 'text', secret),
        fragment('prompt', 'instructions', secret),
      ],
      { filters },
    );

    expect(finding).toEqual({
      detectorId: 'pii-pattern',
      ruleId: 'org-token',
      label: 'organization token',
      source: 'prompt',
      field: 'instructions',
      provenance: 'user',
      fragmentId: 'prompt.instructions',
      fragmentPath: '/prompt/instructions',
    });
    expect(JSON.stringify(finding)).not.toContain(secret);
  });

  it('records audit-only findings without returning an enforcement finding or raw text', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          action: 'audit',
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const secret = 'ORG-DO-NOT-ECHO';

    expect(inspectContent([fragment('message', 'text', secret)], { filters })).toBeNull();
    const metadata = {
      action: 'audit',
      detectorId: 'pii-pattern',
      ruleId: 'org-token',
      label: 'organization token',
      source: 'message',
      field: 'text',
      provenance: 'user',
      occurrences: 1,
    };
    expect(logger.info).toHaveBeenCalledWith(
      `[content-filter] Audit-only finding ${JSON.stringify(metadata)}`,
      metadata,
    );
    const calls = (logger.info as jest.Mock).mock.calls;
    expect(JSON.stringify(calls[calls.length - 1])).not.toContain(secret);
  });

  it('continues past audit-only findings to enforce blocking policies', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          action: 'audit',
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
      prompts: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };

    expect(
      inspectContent([fragment('message', 'text'), fragment('prompt', 'instructions')], {
        filters,
      }),
    ).toMatchObject({ source: 'prompt', field: 'instructions' });
  });

  it('records audit findings even when an earlier legacy rule blocks the same fragment', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          action: 'audit',
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const legacyPii: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [BLOCK_PATTERN],
    };

    expect(
      inspectContent([{ ...fragment('message', 'text'), id: 'chat.text' }], {
        filters,
        legacyPii,
      }),
    ).toMatchObject({ ruleId: 'org-token' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('"action":"audit"'),
      expect.objectContaining({ action: 'audit', ruleId: 'org-token' }),
    );
  });

  it('does not fail closed on incomplete audit-only traversal', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          action: 'audit',
          fields: ['frontmatter'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const error = new ContentTraversalLimitError(
      [fragment('skill', 'frontmatter', 'safe visible value')],
      [{ source: 'skill', fields: ['frontmatter'] }],
    );

    expect(
      inspectContentWithTraversal(
        () => {
          throw error;
        },
        { filters },
      ),
    ).toEqual({ finding: null, traversalError: null });
  });

  it('keeps explicit opaque-file blocking active during an audit-only rollout', () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          action: 'audit',
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
          uninspectable: 'block',
        },
      },
    };
    const error = new ContentTraversalLimitError(
      [fragment('file', 'content', 'safe visible value')],
      [{ source: 'file', fields: ['content'] }],
    );

    expect(
      inspectContentWithTraversal(
        () => {
          throw error;
        },
        { filters },
      ),
    ).toEqual({ finding: null, traversalError: error });
  });

  it('treats an omitted fields list as every field within only that source', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };

    const finding = inspectContent(
      [fragment('message', 'text'), fragment('skill', 'frontmatter')],
      { filters },
    );

    expect(finding).toMatchObject({
      source: 'skill',
      field: 'frontmatter',
    });
  });

  it('keeps all starter patterns enabled when only custom patterns are configured', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };

    expect(
      inspectContent([fragment('message', 'text', 'sk-proj-DEFAULT-STARTER')], { filters }),
    ).toMatchObject({
      ruleId: 'sk_prefix',
    });
  });

  it.each(STARTER_PATTERN_CASES)('registers the %s starter pattern', (ruleId, text) => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [ruleId],
        },
      },
    };

    expect(inspectContent([fragment('message', 'text', text)], { filters })).toMatchObject({
      ruleId,
    });
  });

  it('keeps the runtime starter catalog aligned with the public schema', () => {
    expect(FILTER_PII_STARTER_PATTERNS).toEqual(STARTER_PATTERN_CASES.map(([ruleId]) => ruleId));
  });

  it('treats an explicit empty starter list with no custom patterns as no text matching', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [],
        },
      },
    };

    expect(
      inspectContent([fragment('message', 'text', 'sk-project-EXPLICITLY-DISABLED')], { filters }),
    ).toBeNull();
    expect(createConfiguredContentInspector({ filters })).toBeNull();
    expect(
      createConfiguredContentInspector({
        legacyPii: { starterPatterns: [] },
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: 'messages',
      filters: { messages: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('message', 'quote'),
    },
    {
      name: 'assembled message context',
      filters: { messages: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('assembled_context', 'assembled_context'),
    },
    {
      name: 'prompts',
      filters: { prompts: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('prompt', 'context'),
    },
    {
      name: 'agent instructions',
      filters: { agentInstructions: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('agent_instruction', 'additional_instructions'),
    },
    {
      name: 'conversation starters',
      filters: { conversationStarters: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('conversation_starter', 'text'),
    },
    {
      name: 'conversation titles',
      filters: { conversationTitles: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('conversation_title', 'title'),
    },
    {
      name: 'feedback',
      filters: { feedback: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('feedback', 'text'),
    },
    {
      name: 'skills',
      filters: { skills: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('skill', 'instructions'),
    },
    {
      name: 'memories',
      filters: { memories: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('memory', 'value'),
    },
    {
      name: 'files',
      filters: { files: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('file', 'transcript'),
    },
    {
      name: 'tool arguments',
      filters: { toolArguments: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('tool_argument', 'arguments'),
    },
    {
      name: 'model parameters',
      filters: { modelParameters: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('model_parameter', 'request_fields'),
    },
    {
      name: 'action metadata',
      filters: { actionMetadata: { pii: { customPatterns: [BLOCK_PATTERN] } } },
      content: fragment('action_metadata', 'authorization_url'),
    },
  ] satisfies readonly {
    name: string;
    filters: FiltersConfig;
    content: TextContentFragment;
  }[])('registers the $name source', ({ filters, content }) => {
    expect(inspectContent([content], { filters })).toMatchObject({
      source: content.source,
      field: content.field,
    });
  });

  it('keeps quote and assembled-context field selections independent', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };

    expect(
      inspectContent(
        [fragment('message', 'quote'), fragment('assembled_context', 'assembled_context')],
        { filters },
      ),
    ).toBeNull();
    expect(inspectContent([fragment('message', 'text')], { filters })).not.toBeNull();
  });

  it('keeps the legacy message rule active alongside generic source rules', () => {
    const legacyPii: MessageFilterPiiConfig = {};
    const filters: FiltersConfig = {
      prompts: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };

    expect(
      inspectContent(
        [
          {
            ...fragment('message', 'text', 'sk-proj-LEGACY'),
            id: 'external-message.0.content',
            path: '/0/content',
          },
        ],
        {
          filters,
          legacyPii,
        },
      ),
    ).toMatchObject({
      detectorId: 'legacy-pattern',
      source: 'message',
    });
    expect(
      inspectContent([fragment('prompt', 'instructions')], {
        filters,
        legacyPii,
      }),
    ).toMatchObject({
      detectorId: 'pii-pattern',
      source: 'prompt',
    });
  });

  it.each([
    {
      name: 'external message names before content',
      fragments: [
        {
          ...fragment('message', 'name', 'sk-proj-LEGACY'),
          id: 'external-message.0.name',
        },
        {
          ...fragment('message', 'text', 'sk-proj-LEGACY'),
          id: 'external-message.0.content',
        },
      ],
    },
    {
      name: 'edited content before decision responses',
      fragments: [
        {
          ...fragment('message', 'content_part', 'sk-proj-LEGACY'),
          id: 'chat.edited-content.text',
        },
        {
          ...fragment('message', 'decision_response', 'sk-proj-LEGACY'),
          id: 'chat.decision.0.response',
        },
      ],
    },
  ])('does not let legacy-ineligible $name suppress eligible content', ({ fragments }) => {
    expect(inspectContent(fragments, { legacyPii: {} })).toMatchObject({
      detectorId: 'legacy-pattern',
      ruleId: 'sk_prefix',
    });
  });

  it('memoizes inspectors by config identity and stops reading after the first finding', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const inspector = createConfiguredContentInspector({ filters });
    const readLater = jest.fn();
    function* content(): Generator<TextContentFragment> {
      yield fragment('message', 'text');
      readLater();
      yield fragment('message', 'text', 'ORG-LATER');
    }

    expect(createConfiguredContentInspector({ filters })).toBe(inspector);
    expect(inspector?.inspect(content())).not.toBeNull();
    expect(readLater).not.toHaveBeenCalled();
  });

  it('allocates shared regex-set memory by unique config identity', () => {
    const sharedPii = {
      starterPatterns: [],
      customPatterns: [
        { id: 'shared-memory', label: 'Shared memory', regex: 'SHARED-MEMORY-[0-9]+' },
      ],
    };
    const filters = {
      messages: { pii: sharedPii },
      prompts: { pii: sharedPii },
    } as FiltersConfig;
    const setCompile = jest.spyOn(RE2Set.prototype, 'compile');

    try {
      expect(createConfiguredContentInspector({ filters })).not.toBeNull();
      expect(setCompile).toHaveBeenCalledTimes(1);
      expect((setCompile.mock.contexts[0] as unknown as { readonly maxMem: number }).maxMem).toBe(
        8 * 1_024 * 1_024,
      );
    } finally {
      setCompile.mockRestore();
    }
  });

  it('inspects identical text once per applicable source filter', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
      files: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const patternTest = jest.spyOn(RE2Set.prototype, 'match');
    let callCount = 0;

    try {
      expect(
        inspectContent(
          [
            fragment('skill', 'instructions', 'repeated safe text'),
            fragment('skill', 'imported_text', 'repeated safe text'),
            fragment('skill', 'file_text', 'repeated safe text'),
            fragment('file', 'content', 'repeated safe text'),
            fragment('file', 'extracted_text', 'repeated safe text'),
          ],
          { filters },
        ),
      ).toBeNull();
      callCount = patternTest.mock.calls.length;
    } finally {
      patternTest.mockRestore();
    }

    expect(callCount).toBe(2);
  });

  it('shares dedupe state across one bounded inspection session only', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const inspector = createConfiguredContentInspector({ filters });
    const session = inspector?.createSession();
    const patternTest = jest.spyOn(RE2Set.prototype, 'match');

    try {
      expect(
        session?.inspectFragment(fragment('message', 'text', 'repeated safe text')),
      ).toBeNull();
      expect(
        session?.inspect([fragment('message', 'content_part', 'repeated safe text')]),
      ).toBeNull();
      expect(patternTest).toHaveBeenCalledTimes(1);

      expect(
        inspector?.createSession().inspect([fragment('message', 'text', 'repeated safe text')]),
      ).toBeNull();
      expect(patternTest).toHaveBeenCalledTimes(2);
    } finally {
      patternTest.mockRestore();
    }
  });

  it('bounds cross-batch dedupe memory without skipping inspection', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    };
    const session = createConfiguredContentInspector({ filters })?.createSession();
    const patternTest = jest.spyOn(RE2Set.prototype, 'match');

    try {
      expect(
        session?.inspect(
          Array.from({ length: 4_097 }, (_, index) =>
            fragment('message', 'text', `safe unique text ${index}`),
          ),
        ),
      ).toBeNull();
      expect(patternTest).toHaveBeenCalledTimes(4_097);

      expect(
        session?.inspectFragment(fragment('message', 'text', 'safe unique text 0')),
      ).toBeNull();
      expect(patternTest).toHaveBeenCalledTimes(4_097);
      expect(
        session?.inspectFragment(fragment('message', 'text', 'safe unique text 4096')),
      ).toBeNull();
      expect(patternTest).toHaveBeenCalledTimes(4_098);
    } finally {
      patternTest.mockRestore();
    }
  });

  it('evaluates ambiguous custom patterns with the linear-time engine', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [],
          customPatterns: [{ id: 'ambiguous', label: 'ambiguous text', regex: '(a|aa)+$' }],
        },
      },
    };

    expect(
      inspectContent([fragment('message', 'text', `${'a'.repeat(100_000)}!`)], { filters }),
    ).toBeNull();
  });

  it('rejects aggregate pattern count before compiling regex programs or sets', () => {
    const makePatterns = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        label: `${prefix} ${index}`,
        regex: `${prefix.toUpperCase()}-${index}`,
      }));
    const filters = {
      messages: {
        pii: { starterPatterns: [], customPatterns: makePatterns('message-count', 128) },
      },
      prompts: {
        pii: { starterPatterns: [], customPatterns: makePatterns('prompt-count', 129) },
      },
    } as FiltersConfig;
    const regexCompile = jest.spyOn(RE2JS, 'compile');
    const setCompile = jest.spyOn(RE2Set.prototype, 'compile');

    try {
      expect(() => createConfiguredContentInspector({ filters })).toThrow(
        'custom patterns exceed 256 configured patterns',
      );
      expect(regexCompile).not.toHaveBeenCalled();
      expect(setCompile).not.toHaveBeenCalled();
    } finally {
      regexCompile.mockRestore();
      setCompile.mockRestore();
    }
  });

  it('rejects aggregate regex characters before compiling regex programs or sets', () => {
    const makePatterns = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        label: `${prefix} ${index}`,
        regex: `${prefix}${index}${'x'.repeat(512 - prefix.length - String(index).length)}`,
      }));
    const filters = {
      messages: {
        pii: { starterPatterns: [], customPatterns: makePatterns('character-message', 9) },
      },
      prompts: {
        pii: { starterPatterns: [], customPatterns: makePatterns('character-prompt', 8) },
      },
    } as FiltersConfig;
    const regexCompile = jest.spyOn(RE2JS, 'compile');
    const setCompile = jest.spyOn(RE2Set.prototype, 'compile');

    try {
      expect(() => createConfiguredContentInspector({ filters })).toThrow(
        'custom patterns exceed 8192 regex characters',
      );
      expect(regexCompile).not.toHaveBeenCalled();
      expect(setCompile).not.toHaveBeenCalled();
    } finally {
      regexCompile.mockRestore();
      setCompile.mockRestore();
    }
  });

  it('stops shared instruction measurement at the first aggregate overflow', () => {
    const makeSource = (prefix: string) => ({
      pii: {
        starterPatterns: [],
        customPatterns: Array.from({ length: 8 }, (_, index) => ({
          id: `${prefix}-${index}`,
          label: `${prefix} ${index}`,
          regex: `a{1000}${prefix.toUpperCase()}${index}`,
        })),
      },
    });
    const filters = {
      messages: makeSource('phase-message'),
      prompts: makeSource('phase-prompt'),
      skills: makeSource('phase-skill'),
    } as FiltersConfig;
    const regexCompile = jest.spyOn(RE2JS, 'compile');
    const setCompile = jest.spyOn(RE2Set.prototype, 'compile');

    try {
      expect(() => createConfiguredContentInspector({ filters })).toThrow(
        'custom patterns exceed 8192 compiled instructions',
      );
      const firstAttemptCompiles = regexCompile.mock.calls.length;
      expect(firstAttemptCompiles).toBeGreaterThan(8);
      expect(firstAttemptCompiles).toBeLessThan(24);
      expect(setCompile).not.toHaveBeenCalled();

      expect(() => createConfiguredContentInspector({ filters })).toThrow(
        'custom patterns exceed 8192 compiled instructions',
      );
      expect(regexCompile).toHaveBeenCalledTimes(firstAttemptCompiles);
      expect(setCompile).not.toHaveBeenCalled();
    } finally {
      regexCompile.mockRestore();
      setCompile.mockRestore();
    }
  });

  it('enforces one aggregate instruction budget across legacy and source-aware rules', () => {
    const makePatterns = (prefix: string) =>
      Array.from({ length: 5 }, (_, index) => ({
        id: `${prefix}-${index}`,
        label: `${prefix} ${index}`,
        regex: `b{900}${prefix.toUpperCase()}${index}`,
      }));
    const filters = {
      messages: {
        pii: { starterPatterns: [], customPatterns: makePatterns('combined-filter') },
      },
    } as FiltersConfig;
    const legacyPii = {
      starterPatterns: [],
      customPatterns: makePatterns('combined-legacy'),
    } as MessageFilterPiiConfig;

    expect(() => createConfiguredContentInspector({ filters, legacyPii })).toThrow(
      'custom patterns exceed 8192 compiled instructions',
    );
  });

  it('accepts the aggregate custom-pattern count boundary', () => {
    const makePatterns = (prefix: string) =>
      Array.from({ length: 128 }, (_, index) => ({
        id: `${prefix}-${index}`,
        label: `${prefix} ${index}`,
        regex: `${prefix.toUpperCase()}-${index}`,
      }));
    const filters = {
      messages: {
        pii: { starterPatterns: [], customPatterns: makePatterns('boundary-message') },
      },
      prompts: {
        pii: { starterPatterns: [], customPatterns: makePatterns('boundary-prompt') },
      },
    } as FiltersConfig;

    expect(createConfiguredContentInspector({ filters })).not.toBeNull();
  });

  it('bounds fields and pattern carriers without dispatching custom iterators', () => {
    let fieldLengthReads = 0;
    let fieldIteratorReads = 0;
    const fields = new Proxy(['text'], {
      get(target, property, receiver) {
        if (property === 'length') {
          fieldLengthReads++;
        } else if (property === Symbol.iterator) {
          fieldIteratorReads++;
          throw new Error('field iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const filters = {
      messages: {
        pii: {
          fields,
          starterPatterns: [],
          customPatterns: [BLOCK_PATTERN],
        },
      },
    } as FiltersConfig;

    expect(createConfiguredContentInspector({ filters })).not.toBeNull();
    expect(fieldLengthReads).toBe(1);
    expect(fieldIteratorReads).toBe(0);

    for (const property of ['fields', 'starterPatterns', 'customPatterns'] as const) {
      let lengthReads = 0;
      let numericReads = 0;
      let iteratorReads = 0;
      const sparse = new Proxy(new Array<unknown>(10_000_000), {
        get(target, key, receiver) {
          if (key === 'length') {
            lengthReads++;
          } else if (key === Symbol.iterator) {
            iteratorReads++;
            throw new Error('sparse iterator must not run');
          } else if (typeof key === 'string' && /^\d+$/.test(key)) {
            numericReads++;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const pii = {
        fields: ['text'],
        starterPatterns: [],
        customPatterns: [BLOCK_PATTERN],
        [property]: sparse,
      };

      expect(() =>
        createConfiguredContentInspector({
          filters: { messages: { pii } } as FiltersConfig,
        }),
      ).toThrow('may contain at most 256 entries');
      expect(lengthReads).toBe(1);
      expect(numericReads).toBe(0);
      expect(iteratorReads).toBe(0);
    }

    const { proxy: revokedFields, revoke } = Proxy.revocable([], {});
    revoke();
    expect(() =>
      createConfiguredContentInspector({
        filters: {
          messages: {
            pii: {
              fields: revokedFields,
              starterPatterns: [],
              customPatterns: [BLOCK_PATTERN],
            },
          },
        } as FiltersConfig,
      }),
    ).toThrow('fields could not be inspected safely');
  });

  it('fails closed when typed callers bypass the compiled-program schema budget', () => {
    const filters: FiltersConfig = {
      messages: {
        pii: {
          starterPatterns: [],
          customPatterns: Array.from({ length: 9 }, (_, index) => ({
            id: `expanded-${index}`,
            label: `Expanded ${index}`,
            regex: `a{1000}Q${index}`,
          })),
        },
      },
    };

    expect(() => createConfiguredContentInspector({ filters })).toThrow(
      'custom patterns exceed 8192 compiled instructions',
    );
  });
});
