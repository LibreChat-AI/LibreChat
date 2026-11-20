import {
  AGENT_SORT_CURSOR_ERROR_CODE,
  AGENT_SORT_OPTIONS,
  mapMarketplaceListError,
  marketplaceMineFilter,
  resolveMarketplaceListQuery,
} from './marketplace';

describe('resolveMarketplaceListQuery', () => {
  test('keeps every offered sort mode', () => {
    for (const sort of AGENT_SORT_OPTIONS) {
      expect(resolveMarketplaceListQuery({ sort }).sort).toBe(sort);
    }
  });

  test('leaves the mode unset so the endpoint keeps its own order', () => {
    for (const sort of ['', 'trending', 'AUTHOR', '$where', undefined]) {
      expect(resolveMarketplaceListQuery({ sort } as { sort?: string }).sort).toBeUndefined();
    }
  });

  test('ignores a repeated sort parameter rather than passing an array on', () => {
    expect(resolveMarketplaceListQuery({ sort: ['popular', 'author'] }).sort).toBeUndefined();
  });

  test('restricts to the caller only for mine=1', () => {
    expect(resolveMarketplaceListQuery({ mine: '1' }).mineOnly).toBe(true);
    for (const mine of ['0', 'true', '', ['1'], undefined]) {
      expect(resolveMarketplaceListQuery({ mine } as { mine?: string }).mineOnly).toBe(false);
    }
  });
});

describe('marketplaceMineFilter', () => {
  test('narrows to the caller only when the filter is on', () => {
    expect(marketplaceMineFilter(resolveMarketplaceListQuery({ mine: '1' }), 'user_1')).toEqual({
      author: 'user_1',
    });
  });

  test('contributes nothing otherwise, so the accessible set is untouched', () => {
    for (const mine of ['0', 'true', '', undefined]) {
      expect(
        marketplaceMineFilter(resolveMarketplaceListQuery({ mine } as { mine?: string }), 'user_1'),
      ).toEqual({});
    }
  });
});

describe('mapMarketplaceListError', () => {
  test('maps both cursor failure kinds to the conflict response', () => {
    for (const failure of ['ordering-mismatch', 'unreadable'] as const) {
      const error = Object.assign(new Error(`cursor ${failure}`), {
        code: AGENT_SORT_CURSOR_ERROR_CODE,
      });
      expect(mapMarketplaceListError(error)).toEqual({
        status: 409,
        body: { error: 'cursor_ordering_mismatch' },
      });
    }
  });

  test('leaves unrelated failures on the controller error path', () => {
    expect(mapMarketplaceListError(new Error('database unavailable'))).toBeUndefined();
  });
});
