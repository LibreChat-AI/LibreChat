import { z } from 'zod';
import { logger } from '@librechat/data-schemas';
import { filterPiiCustomPatternSchema } from 'librechat-data-provider';
import type {
  OutputProtectionResult,
  OutputProtectionTarget,
  OutputTextProtectionPolicy,
} from 'librechat-data-provider';
import type { TextContentFragment } from '../types';
import { createPiiTextTransformer, PiiTransformationError } from '../transform';
import { inspectContent } from '../runtime';
import corpus from './cases.json';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const targetSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('message'),
      field: z.literal('text'),
      provenance: z.literal('model'),
    })
    .strict(),
  z
    .object({
      source: z.literal('tool_argument'),
      field: z.literal('output'),
      provenance: z.literal('tool'),
      outcome: z.enum(['success', 'error']),
    })
    .strict(),
]);

const categorySchema = z
  .object({
    category: z.enum(['EMAIL', 'PHONE', 'NAME', 'CREDENTIAL', 'CUSTOM']),
    count: z.number().int().positive(),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().min(1),
    target: targetSchema,
    chunks: z.array(z.string()).min(1),
    format: z.enum(['plain', 'markdown', 'json', 'uri']),
    treatment: z.enum(['replaceable', 'inspect_only']),
    limits: z
      .object({
        maxCharacters: z.number().int().positive().optional(),
        maxMatches: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    expected: z.union([
      z.object({ content: z.string(), categories: z.array(categorySchema) }).strict(),
      z.object({ transformError: z.enum(['limit', 'unreplaceable', 'inspection']) }).strict(),
    ]),
  })
  .strict();

const fixtures = z
  .object({
    version: z.literal(1),
    canaries: z.array(z.string().min(1)).min(1),
    patterns: z.array(filterPiiCustomPatternSchema).min(1),
    cases: z.array(caseSchema).min(1),
  })
  .strict()
  .parse(corpus);

type ConformanceCase = z.infer<typeof caseSchema>;

const policy = {
  action: 'redact',
  starterPatterns: [],
  customPatterns: fixtures.patterns,
  timeoutMs: 1000,
} satisfies OutputTextProtectionPolicy;

function fragment(testCase: ConformanceCase, text: string): TextContentFragment {
  const target: OutputProtectionTarget = testCase.target;
  return {
    id: testCase.id,
    path: '/text',
    ...target,
    format: testCase.format,
    treatment: testCase.treatment,
    text,
  };
}

describe('A1 conformance corpus, current transformer baseline only', () => {
  beforeEach(() => jest.clearAllMocks());

  it('has unique cases and synthetic canaries covered by the fixtures', () => {
    expect(new Set(fixtures.cases.map(({ id }) => id)).size).toBe(fixtures.cases.length);
    for (const canary of fixtures.canaries) {
      expect(fixtures.cases.some(({ chunks }) => chunks.join('').includes(canary))).toBe(true);
      expect(canary.endsWith('@example.invalid') || canary.startsWith('A1_SECRET_CANARY_')).toBe(
        true,
      );
    }
  });

  it.each(fixtures.cases)('$id', (testCase) => {
    const text = testCase.chunks.join('');
    const session = createPiiTextTransformer({ ...policy, ...testCase.limits }).createSession();
    if ('transformError' in testCase.expected) {
      expect(() => session.transform(fragment(testCase, text))).toThrow(
        new PiiTransformationError(testCase.expected.transformError),
      );
      return;
    }
    const transformed = session.transform(fragment(testCase, text));
    const result: OutputProtectionResult = {
      version: 1,
      ok: true,
      value: {
        content: transformed.content,
        replacements: transformed.replacements,
        categories: transformed.categories,
      },
    };
    expect(result.value.content).toBe(testCase.expected.content);
    expect(result.value.categories).toEqual(testCase.expected.categories);
    expect(result.value.replacements).toBe(
      testCase.expected.categories.reduce((total, category) => total + category.count, 0),
    );
    for (const canary of fixtures.canaries) {
      expect(result.value.content).not.toContain(canary);
      expect(JSON.stringify(result.value.categories)).not.toContain(canary);
    }
  });

  it('demonstrates that independently transforming transport chunks is not a release gate', () => {
    const testCase = fixtures.cases.find(({ id }) => id === 'assistant-email-split');
    expect(testCase).toBeDefined();
    if (testCase == null) {
      throw new Error('Missing split fixture');
    }
    const session = createPiiTextTransformer(policy).createSession();
    const independentlyTransformed = testCase.chunks
      .map((chunk) => session.transform(fragment(testCase, chunk)).content)
      .join('');
    expect(independentlyTransformed).toContain(fixtures.canaries[0]);
  });

  it.each(['message', 'tool_argument'] as const)(
    'audit permits %s content and records metadata without matched values',
    (source) => {
      const testCase = fixtures.cases.find((row) => row.target.source === source);
      if (testCase == null) {
        throw new Error('Missing source fixture');
      }
      const text = testCase.chunks.join('');
      const pii = { ...policy, action: 'audit' as const };
      const filters = source === 'message' ? { messages: { pii } } : { toolArguments: { pii } };
      expect(inspectContent([fragment(testCase, text)], { filters })).toBeNull();
      expect(logger.info).toHaveBeenCalled();
      for (const canary of fixtures.canaries) {
        expect(JSON.stringify(jest.mocked(logger.info).mock.calls)).not.toContain(canary);
      }
    },
  );

  it.each(['block', 'redact'] as const)(
    'the legacy inspector still blocks %s matches without an integrated transformer',
    (action) => {
      const testCase = fixtures.cases[0];
      const pii = { ...policy, action };
      expect(
        inspectContent([fragment(testCase, testCase.chunks.join(''))], {
          filters: { messages: { pii } },
        }),
      ).toMatchObject({ source: 'message', field: 'text', ruleId: 'a1-email' });
    },
  );
});
