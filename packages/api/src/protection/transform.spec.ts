import type { FiltersConfig } from 'librechat-data-provider';
import type { TextContentFragment } from './types';
import { createPiiTextTransformer, PiiTransformationError } from './transform';
import { inspectContent } from './runtime';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const pii: NonNullable<NonNullable<FiltersConfig['messages']>['pii']> = {
  action: 'redact' as const,
  starterPatterns: [],
  fields: ['text'],
  customPatterns: [
    {
      id: 'email',
      label: 'Email address',
      regex: '(?i)[a-z]+@[a-z]+\\.[a-z]+',
      category: 'email' as const,
    },
  ],
};

function fragment(text: string, extras: Partial<TextContentFragment> = {}): TextContentFragment {
  return {
    id: 'chat.text',
    path: '/text',
    text,
    source: 'message',
    field: 'text',
    format: 'plain',
    treatment: 'replaceable',
    provenance: 'user',
    ...extras,
  } as TextContentFragment;
}

describe('opt-in PII text transformation', () => {
  it('leaves the existing inspection path blocking until a caller integrates transformation', () => {
    const filters: FiltersConfig = { messages: { pii } };
    expect(inspectContent([fragment('Alice@Example.com')], { filters })).toMatchObject({
      detectorId: 'pii-pattern',
      ruleId: 'email',
    });
  });

  it('uses typed placeholders and returns no matched values in metadata', () => {
    const session = createPiiTextTransformer(pii).createSession();
    const first = session.transform(fragment('😀 Alice@Example.com, Alice@Example.com'));
    const second = session.transform(fragment('Next: Bob@Example.com and Alice@Example.com'));

    expect(first).toEqual({
      version: 1,
      content: '😀 [EMAIL_1], [EMAIL_1]',
      replacements: 2,
      categories: [{ category: 'EMAIL', count: 2 }],
    });
    expect(second.content).toBe('Next: [EMAIL_2] and [EMAIL_1]');
    expect(JSON.stringify(first.categories)).not.toContain('Alice');
    expect(JSON.stringify(second.categories)).not.toContain('Bob');
    const newTurn = createPiiTextTransformer(pii).createSession();
    expect(newTurn.transform(fragment('Bob@Example.com')).content).toBe('[EMAIL_1]');
  });

  it('never aliases a user-supplied placeholder to another private value', () => {
    const session = createPiiTextTransformer(pii).createSession();
    expect(session.transform(fragment('[EMAIL_1] Alice@Example.com')).content).toBe(
      '[EMAIL_1] [EMAIL_2]',
    );
    expect(() => session.transform(fragment('A forged [EMAIL_2] marker'))).toThrow(
      PiiTransformationError,
    );
  });

  it('reserves literal markers across selected fragments without sharing session state', () => {
    const transformer = createPiiTextTransformer(pii);
    const session = transformer.createSession();
    const independent = transformer.createSession();

    expect(session.transform(fragment('[EMAIL_1] [EMAIL_3]'))).toEqual({
      version: 1,
      content: '[EMAIL_1] [EMAIL_3]',
      replacements: 0,
      categories: [],
    });
    expect(session.transform(fragment('Alice@Example.com')).content).toBe('[EMAIL_2]');
    expect(independent.transform(fragment('Alice@Example.com')).content).toBe('[EMAIL_1]');
    expect(session.transform(fragment('Bob@Example.com Alice@Example.com')).content).toBe(
      '[EMAIL_4] [EMAIL_2]',
    );
    expect(session.transform(fragment('[EMAIL_1]'))).toMatchObject({ replacements: 0 });
    expect(() => session.transform(fragment('[EMAIL_4]'))).toThrow(PiiTransformationError);
  });

  it('still charges selected literal markers against the character budget', () => {
    const session = createPiiTextTransformer({ ...pii, maxCharacters: 18 }).createSession();
    expect(session.transform(fragment('[EMAIL_1]')).replacements).toBe(0);
    expect(session.transform(fragment('[EMAIL_2]')).replacements).toBe(0);
    expect(() => session.transform(fragment('[EMAIL_3]'))).toThrow(PiiTransformationError);
  });

  it('does not charge an excluded field against the selected character budget', () => {
    const text = 'Alice@Example.com';
    const session = createPiiTextTransformer({
      ...pii,
      maxCharacters: text.length,
    }).createSession();
    const excluded = fragment(text.repeat(100), { field: 'summary' });

    expect(session.transform(excluded)).toEqual({
      version: 1,
      content: excluded.text,
      replacements: 0,
      categories: [],
    });
    expect(session.transform(fragment(text)).content).toBe('[EMAIL_1]');
  });

  it('neither validates nor reserves excluded markers before or after selected fragments', () => {
    const session = createPiiTextTransformer(pii).createSession();
    const excluded = fragment('[EMAIL_1] [EMAIL_2]', { field: 'summary' });

    expect(session.transform(excluded).content).toBe(excluded.text);
    expect(session.transform(fragment('Alice@Example.com')).content).toBe('[EMAIL_1]');
    expect(session.transform(excluded).content).toBe(excluded.text);
    expect(session.transform(fragment('Bob@Example.com')).content).toBe('[EMAIL_2]');
  });

  it('accepts clean and empty fragments at the match limit but rejects one more match', () => {
    const session = createPiiTextTransformer({ ...pii, maxMatches: 1 }).createSession();

    expect(session.transform(fragment('Alice@Example.com')).replacements).toBe(1);
    for (const text of ['No private details here.', '']) {
      expect(session.transform(fragment(text))).toEqual({
        version: 1,
        content: text,
        replacements: 0,
        categories: [],
      });
    }
    expect(() => session.transform(fragment('Alice@Example.com'))).toThrow(PiiTransformationError);
  });

  it('redacts selected built-in credential headers without leaking the value', () => {
    const session = createPiiTextTransformer({
      action: 'redact',
      starterPatterns: ['bearer_header'],
    }).createSession();
    const result = session.transform(fragment('Authorization: bEaReR contract-token'));
    expect(result.content).toBe('Authorization: [CREDENTIAL_1]');
    expect(JSON.stringify(result.categories)).not.toContain('contract-token');
  });

  it('merges overlapping patterns so partial sensitive values never survive', () => {
    const config = {
      action: 'redact' as const,
      starterPatterns: [],
      customPatterns: [
        { id: 'early', label: 'early', regex: 'ORG-SECRET', category: 'credential' as const },
        { id: 'later', label: 'later', regex: 'SECRET-DATA', category: 'custom' as const },
      ],
    };
    const result = createPiiTextTransformer(config)
      .createSession()
      .transform(fragment('prefix ORG-SECRET-DATA suffix'));
    expect(result.content).toBe('prefix [CREDENTIAL_1] suffix');
    expect(result.replacements).toBe(1);
    expect(result.content).not.toContain('SECRET');
  });

  it('respects configured fields without attempting to replace other fields', () => {
    const session = createPiiTextTransformer(pii).createSession();
    expect(session.transform(fragment('Alice@Example.com', { field: 'summary' })).content).toBe(
      'Alice@Example.com',
    );
    expect(session.transform(fragment('Alice@Example.com')).content).toBe('[EMAIL_1]');
  });

  it('fails closed for non-replaceable matches and structured or URI content', () => {
    for (const extras of [
      { treatment: 'inspect_only' as const },
      { format: 'json' as const },
      { format: 'uri' as const },
    ]) {
      expect(() =>
        createPiiTextTransformer(pii)
          .createSession()
          .transform(fragment('Alice@Example.com', extras)),
      ).toThrow(PiiTransformationError);
    }
  });

  it('bounds characters and matches across all fragments in one session', () => {
    const config = {
      ...pii,
      maxCharacters: 50,
      maxMatches: 2,
    };
    const session = createPiiTextTransformer(config).createSession();
    expect(session.transform(fragment('A@b.com A@b.com')).replacements).toBe(2);
    expect(() => session.transform(fragment('C@d.com'))).toThrow(PiiTransformationError);
    expect(() =>
      createPiiTextTransformer({ ...config, maxCharacters: 4 })
        .createSession()
        .transform(fragment('Alice@Example.com')),
    ).toThrow(PiiTransformationError);
  });

  it('rejects empty regex matches, invalid limits and missing redact action without echoing input', () => {
    expect(() => createPiiTextTransformer({ ...pii, maxMatches: -1 })).toThrow();
    expect(() => createPiiTextTransformer({ ...pii, maxMatches: 0 })).toThrow();
    expect(() => createPiiTextTransformer({ ...pii, action: 'block' })).toThrow();
    const session = createPiiTextTransformer({
      action: 'redact',
      starterPatterns: [],
      customPatterns: [{ id: 'empty', label: 'empty', regex: 'a*' }],
    }).createSession();
    let failure: Error | undefined;
    try {
      session.transform(fragment('secret value'));
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(PiiTransformationError);
    expect(failure?.message).not.toContain('secret value');
  });
});
