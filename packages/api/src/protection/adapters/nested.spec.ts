import type { FiltersConfig } from 'librechat-data-provider';
import {
  ContentTraversalLimitError,
  isContentTraversalProtected,
  visitNestedStrings,
} from './nested';

describe('visitNestedStrings', () => {
  it.each([Number.NaN, -1])(
    'fails closed for an invalid array length %s without dispatching its iterator',
    (invalidLength) => {
      let iteratorReads = 0;
      const value = new Proxy(['PRIVATE-NESTED'], {
        get(target, property, receiver) {
          if (property === 'length') {
            return invalidLength;
          }
          if (property === Symbol.iterator) {
            iteratorReads++;
            throw new Error('nested iterator must not run');
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const onString = jest.fn();

      expect(visitNestedStrings(value, '/value', onString)).toBe(false);
      expect(onString).not.toHaveBeenCalled();
      expect(iteratorReads).toBe(0);
    },
  );

  it('captures an array length once before bounded numeric traversal', () => {
    let lengthReads = 0;
    const value = new Proxy(['retained'], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const values: string[] = [];

    expect(visitNestedStrings(value, '/value', (text) => values.push(text))).toBe(true);
    expect(values).toEqual(['retained']);
    expect(lengthReads).toBe(1);
  });
});

describe('isContentTraversalProtected', () => {
  it.each([
    {
      source: 'prompt' as const,
      error: new ContentTraversalLimitError([], [{ source: 'prompt', fields: ['example_input'] }]),
      filters: {
        prompts: { pii: { fields: ['example_input'], starterPatterns: ['sk_prefix'] } },
      } satisfies FiltersConfig,
    },
    {
      source: 'conversation_starter' as const,
      error: new ContentTraversalLimitError(
        [],
        [{ source: 'conversation_starter', fields: ['text'] }],
      ),
      filters: {
        conversationStarters: { pii: { fields: ['text'], starterPatterns: ['sk_prefix'] } },
      } satisfies FiltersConfig,
    },
    {
      source: 'conversation_title' as const,
      error: new ContentTraversalLimitError(
        [],
        [{ source: 'conversation_title', fields: ['title'] }],
      ),
      filters: {
        conversationTitles: { pii: { fields: ['title'], starterPatterns: ['sk_prefix'] } },
      } satisfies FiltersConfig,
    },
    {
      source: 'feedback' as const,
      error: new ContentTraversalLimitError([], [{ source: 'feedback', fields: ['text'] }]),
      filters: {
        feedback: { pii: { fields: ['text'], starterPatterns: ['sk_prefix'] } },
      } satisfies FiltersConfig,
    },
  ])('fails closed for bounded $source traversal selected by policy', ({ error, filters }) => {
    expect(isContentTraversalProtected({ error, filters })).toBe(true);
  });
});
