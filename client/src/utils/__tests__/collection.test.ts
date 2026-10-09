import type { InfiniteData } from '@tanstack/react-query';
import {
  addData,
  findPage,
  deleteData,
  updateFields,
  updateFieldsInPlace,
  normalizeData,
  getRecordByProperty,
} from '../collection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Item = { id: string; name: string; value?: number; updatedAt?: string };
type Page = { items: Item[]; nextCursor?: string };

function makeInfiniteData(pages: Page[]): InfiniteData<Page> {
  return {
    pages,
    pageParams: pages.map((_, i) => i),
  };
}

function makeItem(id: string, name: string, value?: number): Item {
  return { id, name, ...(value !== undefined ? { value } : {}) };
}

// ---------------------------------------------------------------------------
// findPage
// ---------------------------------------------------------------------------

describe('findPage', () => {
  it('returns correct pageIndex and index when item is on page 0', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha'), makeItem('b', 'Beta')] }]);
    const result = findPage(data, (page) => page.items.findIndex((i) => i.id === 'b'));
    expect(result).toEqual({ pageIndex: 0, index: 1 });
  });

  it('returns correct pageIndex and index when item is on a later page', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha')] },
      { items: [makeItem('b', 'Beta'), makeItem('c', 'Gamma')] },
    ]);
    const result = findPage(data, (page) => page.items.findIndex((i) => i.id === 'c'));
    expect(result).toEqual({ pageIndex: 1, index: 1 });
  });

  it('returns { pageIndex: -1, index: -1 } when item is not found', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);
    const result = findPage(data, (page) => page.items.findIndex((i) => i.id === 'z'));
    expect(result).toEqual({ pageIndex: -1, index: -1 });
  });

  it('returns { pageIndex: -1, index: -1 } when pages array is empty', () => {
    const data = makeInfiniteData([]);
    const result = findPage(data, (page) => page['items']?.findIndex(() => true) ?? -1);
    expect(result).toEqual({ pageIndex: -1, index: -1 });
  });
});

// ---------------------------------------------------------------------------
// updateFieldsInPlace
// ---------------------------------------------------------------------------

describe('updateFieldsInPlace', () => {
  it('updates matching item fields without changing its position', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha'), makeItem('b', 'Beta'), makeItem('c', 'Gamma')] },
    ]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'b', name: 'BetaUpdated' },
      'items',
      'id',
    );

    // Item at index 1 is updated
    expect(result.pages[0].items[1]).toMatchObject({ id: 'b', name: 'BetaUpdated' });
    // Surrounding items are untouched
    expect(result.pages[0].items[0]).toMatchObject({ id: 'a', name: 'Alpha' });
    expect(result.pages[0].items[2]).toMatchObject({ id: 'c', name: 'Gamma' });
    // Total length preserved
    expect(result.pages[0].items).toHaveLength(3);
  });

  it('does NOT move the updated item to page 0 (unlike updateFields)', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha')] },
      { items: [makeItem('b', 'Beta'), makeItem('c', 'Gamma')] },
    ]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'c', name: 'GammaUpdated' },
      'items',
      'id',
    );

    // Item stays on page 1, index 1
    expect(result.pages[1].items[1]).toMatchObject({ id: 'c', name: 'GammaUpdated' });
    // Page 0 is unchanged
    expect(result.pages[0].items).toHaveLength(1);
    expect(result.pages[0].items[0]).toMatchObject({ id: 'a', name: 'Alpha' });
    // Page 1 length preserved
    expect(result.pages[1].items).toHaveLength(2);
  });

  it('does NOT set updatedAt on the updated item', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'a', name: 'AlphaChanged' },
      'items',
      'id',
    );

    expect(result.pages[0].items[0].updatedAt).toBeUndefined();
  });

  it('merges only the provided partial fields onto the existing item', () => {
    const data = makeInfiniteData([{ items: [{ id: 'a', name: 'Alpha', value: 42 }] }]);

    const result = updateFieldsInPlace<Page, Item>(data, { id: 'a', value: 99 }, 'items', 'id');

    expect(result.pages[0].items[0]).toMatchObject({ id: 'a', name: 'Alpha', value: 99 });
  });

  it('returns the data unchanged when the item is not found', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'z', name: 'Missing' },
      'items',
      'id',
    );

    expect(result.pages[0].items).toHaveLength(1);
    expect(result.pages[0].items[0]).toMatchObject({ id: 'a', name: 'Alpha' });
  });

  it('handles items across multiple pages, updating the correct page', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha')] },
      { items: [makeItem('b', 'Beta')] },
      { items: [makeItem('c', 'Gamma')] },
    ]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'b', name: 'BetaNew' },
      'items',
      'id',
    );

    expect(result.pages[0].items[0]).toMatchObject({ id: 'a', name: 'Alpha' });
    expect(result.pages[1].items[0]).toMatchObject({ id: 'b', name: 'BetaNew' });
    expect(result.pages[2].items[0]).toMatchObject({ id: 'c', name: 'Gamma' });
  });

  it('does not mutate the original data', () => {
    const original = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);
    const snapshot = JSON.stringify(original);

    updateFieldsInPlace<Page, Item>(original, { id: 'a', name: 'Changed' }, 'items', 'id');

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('handles an empty pages array without throwing', () => {
    const data = makeInfiniteData([]);

    expect(() =>
      updateFieldsInPlace<Page, Item>(data, { id: 'a', name: 'Alpha' }, 'items', 'id'),
    ).not.toThrow();
  });

  it('handles a page whose collection is empty without throwing', () => {
    const data = makeInfiniteData([{ items: [] }]);

    const result = updateFieldsInPlace<Page, Item>(data, { id: 'a', name: 'Alpha' }, 'items', 'id');

    expect(result.pages[0].items).toHaveLength(0);
  });

  it('updates the first item in a page correctly', () => {
    const data = makeInfiniteData([
      { items: [makeItem('first', 'First'), makeItem('second', 'Second')] },
    ]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'first', name: 'FirstUpdated' },
      'items',
      'id',
    );

    expect(result.pages[0].items[0]).toMatchObject({ id: 'first', name: 'FirstUpdated' });
    expect(result.pages[0].items[1]).toMatchObject({ id: 'second', name: 'Second' });
  });

  it('updates the last item in a page correctly', () => {
    const data = makeInfiniteData([
      { items: [makeItem('first', 'First'), makeItem('last', 'Last')] },
    ]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'last', name: 'LastUpdated' },
      'items',
      'id',
    );

    expect(result.pages[0].items[0]).toMatchObject({ id: 'first', name: 'First' });
    expect(result.pages[0].items[1]).toMatchObject({ id: 'last', name: 'LastUpdated' });
  });

  it('preserves pageParams on the returned data', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha')] },
      { items: [makeItem('b', 'Beta')] },
    ]);

    const result = updateFieldsInPlace<Page, Item>(
      data,
      { id: 'a', name: 'AlphaNew' },
      'items',
      'id',
    );

    expect(result.pageParams).toEqual(data.pageParams);
  });
});

// ---------------------------------------------------------------------------
// Contrast: updateFields DOES move item and set updatedAt
// ---------------------------------------------------------------------------

describe('updateFields (contrast with updateFieldsInPlace)', () => {
  it('moves the updated item to page 0 and sets updatedAt', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha')] },
      { items: [makeItem('b', 'Beta')] },
    ]);

    const result = updateFields<Page, Item>(data, { id: 'b', name: 'BetaNew' }, 'items', 'id');

    // Item is now at the top of page 0
    expect(result.pages[0].items[0]).toMatchObject({ id: 'b', name: 'BetaNew' });
    expect(result.pages[0].items[0].updatedAt).toBeDefined();
    // Page 1 is now empty (item was removed)
    expect(result.pages[1].items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getRecordByProperty
// ---------------------------------------------------------------------------

describe('getRecordByProperty', () => {
  it('returns the matching record from page 0', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha'), makeItem('b', 'Beta')] }]);
    const result = getRecordByProperty<Page, Item>(data, 'items', (item) => item.id === 'b');
    expect(result).toMatchObject({ id: 'b', name: 'Beta' });
  });

  it('returns the matching record from a later page', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha')] },
      { items: [makeItem('b', 'Beta')] },
    ]);
    const result = getRecordByProperty<Page, Item>(data, 'items', (item) => item.id === 'b');
    expect(result).toMatchObject({ id: 'b', name: 'Beta' });
  });

  it('returns undefined when no item matches', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);
    const result = getRecordByProperty<Page, Item>(data, 'items', (item) => item.id === 'z');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addData
// ---------------------------------------------------------------------------

describe('addData', () => {
  it('unshifts new item onto page 0 when item does not already exist', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);
    const newItem = makeItem('b', 'Beta');

    const result = addData<Page, Item>(data, 'items', newItem, (page) =>
      page.items.findIndex((i) => i.id === newItem.id),
    );

    expect(result.pages[0].items[0]).toMatchObject({ id: 'b', name: 'Beta' });
    expect(result.pages[0].items).toHaveLength(2);
  });

  it('calls updateData instead when item already exists', () => {
    const existing = makeItem('a', 'Alpha');
    const data = makeInfiniteData([{ items: [existing] }]);

    const result = addData<Page, Item>(data, 'items', { id: 'a', name: 'AlphaUpdated' }, (page) =>
      page.items.findIndex((i) => i.id === 'a'),
    );

    // updateData moves the item to the top with an updatedAt
    expect(result.pages[0].items[0]).toMatchObject({ id: 'a', name: 'AlphaUpdated' });
    expect(result.pages[0].items[0].updatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deleteData
// ---------------------------------------------------------------------------

describe('deleteData', () => {
  it('removes the matching item from its page', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha'), makeItem('b', 'Beta')] }]);

    const result = deleteData<Page, InfiniteData<Page>>(data, 'items', (page) =>
      page.items.findIndex((i) => i.id === 'a'),
    );

    expect(result.pages[0].items).toHaveLength(1);
    expect(result.pages[0].items[0]).toMatchObject({ id: 'b', name: 'Beta' });
  });

  it('leaves data unchanged when item is not found', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'Alpha')] }]);

    const result = deleteData<Page, InfiniteData<Page>>(data, 'items', (page) =>
      page.items.findIndex((i) => i.id === 'z'),
    );

    expect(result.pages[0].items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeData
// ---------------------------------------------------------------------------

describe('normalizeData', () => {
  it('redistributes items evenly according to pageSize', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'A'), makeItem('b', 'B'), makeItem('c', 'C')] },
      { items: [makeItem('d', 'D')] },
    ]);

    const result = normalizeData<Page, Item>(data, 'items', 2);

    expect(result.pages[0].items).toHaveLength(2);
    expect(result.pages[1].items).toHaveLength(2);
  });

  it('removes empty pages after redistribution', () => {
    const data = makeInfiniteData([{ items: [makeItem('a', 'A')] }, { items: [] }]);

    const result = normalizeData<Page, Item>(data, 'items', 10);

    expect(result.pages).toHaveLength(1);
  });

  it('deduplicates items when uniqueProperty is provided', () => {
    const data = makeInfiniteData([
      { items: [makeItem('a', 'Alpha'), makeItem('a', 'AlphaDuplicate')] },
    ]);

    const result = normalizeData<Page, Item>(data, 'items', 10, 'id');

    const ids = result.pages.flatMap((p) => p.items.map((i) => i.id));
    expect(ids.filter((id) => id === 'a')).toHaveLength(1);
  });

  it('returns the data unchanged when pages array is empty', () => {
    const data = makeInfiniteData([]);
    const result = normalizeData<Page, Item>(data, 'items', 10);
    expect(result.pages).toHaveLength(0);
  });
});
