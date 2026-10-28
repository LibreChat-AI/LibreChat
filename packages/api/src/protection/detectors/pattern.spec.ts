import { RE2Set } from 're2js';
import type { MessageFilterPiiConfig } from 'librechat-data-provider';
import type { TextContentFragment } from '../types';
import { createPatternContentInspector, PatternConfigurationError } from './pattern';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function fragment(text: string): TextContentFragment {
  return {
    id: 'message.text',
    text,
    path: '/message/text',
    source: 'message',
    field: 'text',
    format: 'plain',
    treatment: 'replaceable',
    provenance: 'user',
  };
}

describe('pattern content inspector', () => {
  it('deduplicates identical regexes while retaining the first declaration metadata', () => {
    const add = jest.spyOn(RE2Set.prototype, 'add');
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [
        { id: 'first', label: 'First declaration', regex: 'SHARED-[0-9]+' },
        { id: 'second', label: 'Second declaration', regex: 'SHARED-[0-9]+' },
      ],
    };

    try {
      expect(
        createPatternContentInspector(config, { linearTime: true }).inspectFragment(
          fragment('SHARED-42'),
        ),
      ).toMatchObject({ ruleId: 'first', label: 'First declaration' });
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
    }
  });

  it('preserves declaration order when multiple custom regexes match', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [
        { id: 'broad', label: 'Broad', regex: 'ORDER' },
        { id: 'specific', label: 'Specific', regex: 'ORDER-[0-9]+' },
      ],
    };

    expect(
      createPatternContentInspector(config, { linearTime: true }).inspectFragment(
        fragment('ORDER-42'),
      ),
    ).toMatchObject({ ruleId: 'broad' });
  });

  it('keeps starter-pattern precedence and matching semantics', () => {
    const config: MessageFilterPiiConfig = {
      starterPatterns: ['bearer_header'],
      customPatterns: [{ id: 'custom', label: 'Custom', regex: 'bearer [^ ]+' }],
    };

    expect(
      createPatternContentInspector(config, { linearTime: true }).inspectFragment(
        fragment('Authorization: bEaReR contract-token'),
      ),
    ).toMatchObject({ ruleId: 'bearer_header' });
  });

  it.each([
    { config: { starterPatterns: ['bearer_header'] }, text: 'Bearer contract-token' },
    {
      config: {
        starterPatterns: [],
        customPatterns: [{ id: 'custom', label: 'Custom', regex: 'ORG-[A-Z]+' }],
      },
      text: 'ORG-SECRET',
    },
  ])('enforces a zero remaining allowance when locating $text', ({ config, text }) => {
    const inspector = createPatternContentInspector(config, { linearTime: true });

    expect(inspector.locate('clean text', 0)).toEqual([]);
    expect(inspector.locate('', 0)).toEqual([]);
    expect(() => inspector.locate(text, 0)).toThrow(PatternConfigurationError);
    expect(inspector.locate(text, 1)).toHaveLength(1);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid remaining match allowance %s before inspecting',
    (allowance) => {
      const inspector = createPatternContentInspector({}, { linearTime: true });
      expect(() => inspector.locate('clean text', allowance)).toThrow(PatternConfigurationError);
    },
  );

  it('memoizes a compiled set by config identity and memory limit', () => {
    const compile = jest.spyOn(RE2Set.prototype, 'compile');
    const config: MessageFilterPiiConfig = {
      starterPatterns: [],
      customPatterns: [{ id: 'cached', label: 'Cached', regex: 'CACHE-IDENTITY-[0-9]+' }],
    };

    try {
      const first = createPatternContentInspector(config, {
        linearTime: true,
        linearSetMaxMemoryBytes: 512_000,
      });
      const second = createPatternContentInspector(config, {
        linearTime: true,
        linearSetMaxMemoryBytes: 512_000,
      });
      const differentLimit = createPatternContentInspector(config, {
        linearTime: true,
        linearSetMaxMemoryBytes: 513_000,
      });
      createPatternContentInspector(config, {
        linearTime: true,
        linearSetMaxMemoryBytes: 514_000,
      });
      const evictedLimit = createPatternContentInspector(config, {
        linearTime: true,
        linearSetMaxMemoryBytes: 512_000,
      });

      expect(second).toBe(first);
      expect(differentLimit).not.toBe(first);
      expect(evictedLimit).not.toBe(first);
      expect(compile).toHaveBeenCalledTimes(4);
    } finally {
      compile.mockRestore();
    }
  });

  it('reads bounded config arrays numerically without dispatching their iterators', () => {
    let lengthReads = 0;
    let numericReads = 0;
    let iteratorReads = 0;
    const customPatterns = new Proxy(
      [{ id: 'numeric', label: 'Numeric', regex: 'NUMERIC-[0-9]+' }],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            lengthReads++;
          } else if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('custom iterator must not run');
          } else if (typeof property === 'string' && /^\d+$/.test(property)) {
            numericReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const config = { starterPatterns: [], customPatterns } as MessageFilterPiiConfig;

    const first = createPatternContentInspector(config, { linearTime: true });
    const second = createPatternContentInspector(config, { linearTime: true });

    expect(second).toBe(first);
    expect(lengthReads).toBe(1);
    expect(numericReads).toBe(1);
    expect(iteratorReads).toBe(0);
  });

  it.each(['starterPatterns', 'customPatterns', 'customPattern'] as const)(
    'normalizes a revoked %s proxy to a configuration error',
    (candidate) => {
      const { proxy, revoke } = Proxy.revocable([], {});
      revoke();
      let config: Record<string, unknown>;
      if (candidate === 'starterPatterns') {
        config = { starterPatterns: proxy };
      } else if (candidate === 'customPatterns') {
        config = { starterPatterns: [], customPatterns: proxy };
      } else {
        config = { starterPatterns: [], customPatterns: [proxy] };
      }

      expect(() =>
        createPatternContentInspector(config as MessageFilterPiiConfig, { linearTime: true }),
      ).toThrow(PatternConfigurationError);
    },
  );
});
