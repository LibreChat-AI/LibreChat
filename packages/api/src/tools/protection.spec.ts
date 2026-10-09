import type { FiltersConfig } from 'librechat-data-provider';
import { ContentFilterError } from '../middleware/contentFilter';
import { assertDirectToolOutputAllowed } from './protection';

const filters: FiltersConfig = {
  toolArguments: {
    pii: {
      fields: ['output'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private output', regex: 'PRIVATE-OUTPUT' }],
    },
  },
};

describe('direct tool output protection', () => {
  it('blocks protected leaves in structured direct-call output', () => {
    expect(() =>
      assertDirectToolOutputAllowed(filters, 'execute_code', {
        nested: { value: 'PRIVATE-OUTPUT' },
      }),
    ).toThrow(ContentFilterError);
  });

  it('does not traverse output when output policy is inactive', () => {
    const output = {};
    Object.defineProperty(output, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not read');
      },
    });

    expect(() =>
      assertDirectToolOutputAllowed(
        { toolArguments: { pii: { fields: ['arguments'], starterPatterns: [] } } },
        'execute_code',
        output,
      ),
    ).not.toThrow();
  });

  it('allows an untraversable direct-call output for an audit-only policy', () => {
    const output = new Proxy(
      { value: 'hidden' },
      {
        ownKeys: () => {
          throw new Error('opaque');
        },
      },
    );

    expect(() =>
      assertDirectToolOutputAllowed(
        {
          toolArguments: {
            pii: {
              ...filters.toolArguments?.pii,
              action: 'audit',
            },
          },
        },
        'execute_code',
        output,
      ),
    ).not.toThrow();
  });
});
