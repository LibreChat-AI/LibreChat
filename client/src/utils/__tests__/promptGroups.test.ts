import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { InfiniteCollections, QueryKeys } from 'librechat-data-provider';
import type { PromptGroupListResponse, TPromptGroup } from 'librechat-data-provider';
import type { InfiniteData } from '@tanstack/react-query';
import {
  addGroupToAll,
  addPromptGroup,
  deletePromptGroup,
  removeGroupFromAll,
  updateGroupFields,
  updateGroupFieldsInPlace,
  updateGroupInAll,
  updatePromptGroup,
  getSnippet,
  findPromptGroup,
} from '../promptGroups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGroup(overrides: Partial<TPromptGroup> = {}): TPromptGroup {
  return {
    _id: 'group-1',
    name: 'Default Group',
    numberOfGenerations: 0,
    onlyMyPrompts: false,
    ...overrides,
  } as TPromptGroup;
}

function makeInfiniteData(
  pages: Array<{ promptGroups: TPromptGroup[] }>,
): InfiniteData<PromptGroupListResponse> {
  return {
    pages: pages as PromptGroupListResponse[],
    pageParams: pages.map((_, i) => i),
  };
}

async function expectFirstAllGroupsFetchRestart(
  mutate: (queryClient: QueryClient) => void,
  freshList: TPromptGroup[],
) {
  const queryClient = new QueryClient();
  const queryKey = [QueryKeys.allPromptGroups];
  const staleList = [makeGroup({ _id: 'stale', name: 'Stale Group' })];
  const deferreds: Array<{ resolve: (value: TPromptGroup[]) => void }> = [];
  const queryFn = () => new Promise<TPromptGroup[]>((resolve) => deferreds.push({ resolve }));
  const observer = new QueryObserver<TPromptGroup[]>(queryClient, { queryKey, queryFn });
  const unsubscribe = observer.subscribe(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(deferreds).toHaveLength(1);

  mutate(queryClient);
  deferreds[0].resolve(staleList);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(deferreds).toHaveLength(2);

  deferreds[1].resolve(freshList);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(queryClient.getQueryData<TPromptGroup[]>(queryKey)).toEqual(freshList);

  unsubscribe();
  queryClient.clear();
}

// ---------------------------------------------------------------------------
// updateGroupFieldsInPlace
// ---------------------------------------------------------------------------

describe('updateGroupFieldsInPlace', () => {
  it('updates matching group fields without changing its position', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A' });
    const groupB = makeGroup({ _id: 'b', name: 'Group B' });
    const groupC = makeGroup({ _id: 'c', name: 'Group C' });

    const data = makeInfiniteData([{ promptGroups: [groupA, groupB, groupC] }]);

    const result = updateGroupFieldsInPlace(data, { _id: 'b', name: 'Group B Updated' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][1]).toMatchObject({
      _id: 'b',
      name: 'Group B Updated',
    });
    // Neighbours are unchanged
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({ _id: 'a' });
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][2]).toMatchObject({ _id: 'c' });
    // Length is preserved
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(3);
  });

  it('does NOT move the group to page 0 (stays on original page)', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A' });
    const groupB = makeGroup({ _id: 'b', name: 'Group B' });

    const data = makeInfiniteData([{ promptGroups: [groupA] }, { promptGroups: [groupB] }]);

    const result = updateGroupFieldsInPlace(data, { _id: 'b', name: 'Group B Updated' });

    // Group B stays on page 1
    expect(result.pages[1][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'b',
      name: 'Group B Updated',
    });
    // Page 0 is unchanged
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(1);
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({ _id: 'a' });
  });

  it('does NOT set updatedAt on the updated group', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A' });
    const data = makeInfiniteData([{ promptGroups: [groupA] }]);

    const result = updateGroupFieldsInPlace(data, { _id: 'a', name: 'Changed' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0].updatedAt).toBeUndefined();
  });

  it('returns data unchanged when the group is not found', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A' });
    const data = makeInfiniteData([{ promptGroups: [groupA] }]);
    const snapshot = JSON.stringify(data);

    const result = updateGroupFieldsInPlace(data, { _id: 'nonexistent', name: 'Ghost' });

    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('merges only the provided partial fields, preserving others', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A', numberOfGenerations: 5 });
    const data = makeInfiniteData([{ promptGroups: [groupA] }]);

    const result = updateGroupFieldsInPlace(data, { _id: 'a', name: 'Group A Renamed' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'a',
      name: 'Group A Renamed',
      numberOfGenerations: 5,
    });
  });

  it('does not mutate the original data', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A' });
    const data = makeInfiniteData([{ promptGroups: [groupA] }]);
    const snapshot = JSON.stringify(data);

    updateGroupFieldsInPlace(data, { _id: 'a', name: 'Changed' });

    expect(JSON.stringify(data)).toBe(snapshot);
  });

  it('handles an empty pages array without throwing', () => {
    const data = makeInfiniteData([]);
    expect(() => updateGroupFieldsInPlace(data, { _id: 'a', name: 'Ghost' })).not.toThrow();
  });

  it('handles a page with an empty promptGroups array without throwing', () => {
    const data = makeInfiniteData([{ promptGroups: [] }]);
    const result = updateGroupFieldsInPlace(data, { _id: 'a', name: 'Ghost' });
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(0);
  });

  it('preserves pageParams on the returned data', () => {
    const groupA = makeGroup({ _id: 'a', name: 'Group A' });
    const data = makeInfiniteData([{ promptGroups: [groupA] }]);

    const result = updateGroupFieldsInPlace(data, { _id: 'a', name: 'Changed' });

    expect(result.pageParams).toEqual(data.pageParams);
  });

  it('handles groups across three pages, updating only the matching page', () => {
    const data = makeInfiniteData([
      { promptGroups: [makeGroup({ _id: 'a', name: 'A' })] },
      { promptGroups: [makeGroup({ _id: 'b', name: 'B' })] },
      { promptGroups: [makeGroup({ _id: 'c', name: 'C' })] },
    ]);

    const result = updateGroupFieldsInPlace(data, { _id: 'c', name: 'C Updated' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'a',
      name: 'A',
    });
    expect(result.pages[1][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'b',
      name: 'B',
    });
    expect(result.pages[2][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'c',
      name: 'C Updated',
    });
  });
});

// ---------------------------------------------------------------------------
// Contrast: updateGroupFields DOES move item and set updatedAt
// ---------------------------------------------------------------------------

describe('updateGroupFields (contrast with updateGroupFieldsInPlace)', () => {
  it('moves updated group to page 0 and sets updatedAt', () => {
    const data = makeInfiniteData([
      { promptGroups: [makeGroup({ _id: 'a', name: 'A' })] },
      { promptGroups: [makeGroup({ _id: 'b', name: 'B' })] },
    ]);

    const result = updateGroupFields(data, { _id: 'b', name: 'B Updated' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'b',
      name: 'B Updated',
    });
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0].updatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// addPromptGroup
// ---------------------------------------------------------------------------

describe('addPromptGroup', () => {
  it('adds a new group to the top of page 0', () => {
    const existing = makeGroup({ _id: 'a', name: 'A' });
    const data = makeInfiniteData([{ promptGroups: [existing] }]);
    const newGroup = makeGroup({ _id: 'new', name: 'New Group' });

    const result = addPromptGroup(data, newGroup);

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({ _id: 'new' });
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(2);
  });

  it('updates via updateData when the group already exists', () => {
    const existing = makeGroup({ _id: 'a', name: 'A' });
    const data = makeInfiniteData([{ promptGroups: [existing] }]);

    const result = addPromptGroup(data, { ...existing, name: 'A Updated' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'a',
      name: 'A Updated',
    });
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0].updatedAt).toBeDefined();
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updatePromptGroup
// ---------------------------------------------------------------------------

describe('updatePromptGroup', () => {
  it('moves the updated group to the top of page 0 and sets updatedAt', () => {
    const groupA = makeGroup({ _id: 'a', name: 'A' });
    const groupB = makeGroup({ _id: 'b', name: 'B' });
    const data = makeInfiniteData([{ promptGroups: [groupA, groupB] }]);

    const result = updatePromptGroup(data, { ...groupB, name: 'B Updated' });

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({
      _id: 'b',
      name: 'B Updated',
    });
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0].updatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deletePromptGroup
// ---------------------------------------------------------------------------

describe('deletePromptGroup', () => {
  it('removes the matching group from its page', () => {
    const groupA = makeGroup({ _id: 'a', name: 'A' });
    const groupB = makeGroup({ _id: 'b', name: 'B' });
    const data = makeInfiniteData([{ promptGroups: [groupA, groupB] }]);

    const result = deletePromptGroup(data, 'a');

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(1);
    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS][0]).toMatchObject({ _id: 'b' });
  });

  it('leaves data unchanged when the group is not found', () => {
    const groupA = makeGroup({ _id: 'a', name: 'A' });
    const data = makeInfiniteData([{ promptGroups: [groupA] }]);

    const result = deletePromptGroup(data, 'nonexistent');

    expect(result.pages[0][InfiniteCollections.PROMPT_GROUPS]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findPromptGroup
// ---------------------------------------------------------------------------

describe('findPromptGroup', () => {
  it('returns matching group from page 0', () => {
    const groupA = makeGroup({ _id: 'a', name: 'A' });
    const groupB = makeGroup({ _id: 'b', name: 'B' });
    const data = makeInfiniteData([{ promptGroups: [groupA, groupB] }]);

    const result = findPromptGroup(data, (g) => g._id === 'b');

    expect(result).toMatchObject({ _id: 'b', name: 'B' });
  });

  it('returns matching group from a later page', () => {
    const data = makeInfiniteData([
      { promptGroups: [makeGroup({ _id: 'a', name: 'A' })] },
      { promptGroups: [makeGroup({ _id: 'b', name: 'B' })] },
    ]);

    const result = findPromptGroup(data, (g) => g._id === 'b');

    expect(result).toMatchObject({ _id: 'b' });
  });

  it('returns undefined when no group matches', () => {
    const data = makeInfiniteData([{ promptGroups: [makeGroup({ _id: 'a' })] }]);
    expect(findPromptGroup(data, (g) => g._id === 'z')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSnippet
// ---------------------------------------------------------------------------

describe('getSnippet', () => {
  it('returns the full string when it is within the default length', () => {
    const short = 'Hello';
    expect(getSnippet(short)).toBe('Hello');
  });

  it('truncates and appends ellipsis when string exceeds default length', () => {
    const long = 'a'.repeat(60);
    const result = getSnippet(long);
    expect(result.endsWith('...')).toBe(true);
    expect(result.length).toBe(56);
  });

  it('respects a custom length parameter', () => {
    const text = 'abcdefghij';
    const result = getSnippet(text, 7);
    expect(result).toBe('abcd...');
    expect(result.length).toBe(7);
  });

  it('returns the original string when it equals the length exactly', () => {
    const text = 'a'.repeat(56);
    expect(getSnippet(text)).toBe(text);
  });

  it('handles an empty string without throwing', () => {
    expect(getSnippet('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// addGroupToAll
// ---------------------------------------------------------------------------

describe('addGroupToAll', () => {
  it('does not seed the all-prompt-groups list before its first fetch', () => {
    const queryClient = new QueryClient();
    addGroupToAll(queryClient, makeGroup({ _id: 'group-new' }));
    expect(queryClient.getQueryData([QueryKeys.allPromptGroups])).toBeUndefined();
  });

  it('appends to an already fetched list', () => {
    const queryClient = new QueryClient();
    const existing = [makeGroup({ _id: 'group-a' })];
    queryClient.setQueryData([QueryKeys.allPromptGroups], existing);
    addGroupToAll(queryClient, makeGroup({ _id: 'group-b' }));
    expect(queryClient.getQueryData<TPromptGroup[]>([QueryKeys.allPromptGroups])).toHaveLength(2);
  });

  it('restarts a first fetch already in flight so it settles with the created group', async () => {
    const queryClient = new QueryClient();
    const queryKey = [QueryKeys.allPromptGroups];
    const newList = [makeGroup({ _id: 'group-new' })];
    const deferreds: Array<{ resolve: (value: TPromptGroup[]) => void }> = [];
    const queryFn = () => new Promise<TPromptGroup[]>((resolve) => deferreds.push({ resolve }));
    const observer = new QueryObserver<TPromptGroup[]>(queryClient, { queryKey, queryFn });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deferreds).toHaveLength(1);

    addGroupToAll(queryClient, makeGroup({ _id: 'group-new' }));
    deferreds[0].resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    /* The pre-creation read must not be allowed to stand: a restart has to
       have started a second fetch that can settle with the created group. */
    expect(deferreds).toHaveLength(2);
    deferreds[1].resolve(newList);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData<TPromptGroup[]>(queryKey)).toEqual(newList);
    unsubscribe();
    queryClient.clear();
  });

  it('refetches an errored list after creation so the command appears', async () => {
    const queryClient = new QueryClient();
    const queryKey = [QueryKeys.allPromptGroups];
    const newList = [makeGroup({ _id: 'group-new' })];
    const deferreds: Array<{
      resolve: (value: TPromptGroup[]) => void;
      reject: (reason: Error) => void;
    }> = [];
    const queryFn = () =>
      new Promise<TPromptGroup[]>((resolve, reject) => deferreds.push({ resolve, reject }));
    const observer = new QueryObserver<TPromptGroup[]>(queryClient, {
      queryKey,
      queryFn,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    deferreds[0].reject(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getQueryState(queryKey)?.status).toBe('error');

    addGroupToAll(queryClient, makeGroup({ _id: 'group-new' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deferreds).toHaveLength(2);
    deferreds[1].resolve(newList);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData<TPromptGroup[]>(queryKey)).toEqual(newList);
    unsubscribe();
    queryClient.clear();
  });
});

describe('all-prompt-groups mutation reconciliation', () => {
  it('restarts a first fetch that would overwrite a group update', async () => {
    expect.assertions(3);
    const updatedGroup = makeGroup({ _id: 'stale', name: 'Updated Group' });
    await expectFirstAllGroupsFetchRestart(
      (queryClient) => updateGroupInAll(queryClient, { _id: 'stale', name: 'Updated Group' }),
      [updatedGroup],
    );
  });

  it('restarts a first fetch that would restore a deleted group', async () => {
    expect.assertions(3);
    await expectFirstAllGroupsFetchRestart(
      (queryClient) => removeGroupFromAll(queryClient, 'stale'),
      [],
    );
  });
});
