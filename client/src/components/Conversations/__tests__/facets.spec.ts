import { createStore } from 'jotai';
import {
  chatFacetParamsAtom,
  createdRangeAtom,
  endpointFilterAtom,
  facetFilterCountAtom,
  hasAttachmentsAtom,
  rangeCutoff,
  sharedOnlyAtom,
  resetFacetsAtom,
  toggleEndpointFilterAtom,
  updatedRangeAtom,
} from '../facets';

describe('rangeCutoff', () => {
  const now = new Date(2026, 8, 20, 15, 42, 7, 123);

  it('has no cutoff for "any time"', () => {
    expect(rangeCutoff('any', now)).toBeUndefined();
  });

  it('snaps to local midnight so the cutoff is stable within a day', () => {
    const morning = rangeCutoff('today', new Date(2026, 8, 20, 0, 0, 1));
    const evening = rangeCutoff('today', new Date(2026, 8, 20, 23, 59, 59));

    expect(morning?.getTime()).toBe(evening?.getTime());
    expect(morning?.getHours()).toBe(0);
    expect(morning?.getMinutes()).toBe(0);
  });

  it('counts today as the first of the previous-N-days windows', () => {
    /** "Previous 7 days" is today plus the six before it, not 7 x 24 hours. */
    expect(rangeCutoff('week', now)).toEqual(new Date(2026, 8, 14));
    expect(rangeCutoff('month', now)).toEqual(new Date(2026, 7, 22));
  });

  it('crosses a month boundary correctly', () => {
    expect(rangeCutoff('week', new Date(2026, 8, 3, 9, 0))).toEqual(new Date(2026, 7, 28));
  });
});

describe('chatFacetParamsAtom', () => {
  it('sends nothing while every facet is at its default', () => {
    const store = createStore();

    expect(store.get(chatFacetParamsAtom)).toEqual({
      updatedAfter: undefined,
      createdAfter: undefined,
      endpoints: undefined,
      hasFiles: undefined,
      sharedOnly: undefined,
    });
    expect(store.get(facetFilterCountAtom)).toBe(0);
  });

  it('sends the shared flag only when it is on', () => {
    const store = createStore();
    expect(store.get(chatFacetParamsAtom).sharedOnly).toBeUndefined();

    store.set(sharedOnlyAtom, true);
    expect(store.get(chatFacetParamsAtom).sharedOnly).toBe(true);
    expect(store.get(facetFilterCountAtom)).toBe(1);
  });

  it('shapes each facet as the list parameter the server takes', () => {
    const store = createStore();
    store.set(updatedRangeAtom, 'week');
    store.set(createdRangeAtom, 'today');
    store.set(toggleEndpointFilterAtom, 'openAI');
    store.set(hasAttachmentsAtom, true);
    store.set(sharedOnlyAtom, true);

    const params = store.get(chatFacetParamsAtom);

    expect(typeof params.updatedAfter).toBe('string');
    expect(new Date(params.updatedAfter as string).getTime()).not.toBeNaN();
    expect(typeof params.createdAfter).toBe('string');
    expect(params.endpoints).toEqual(['openAI']);
    expect(params.hasFiles).toBe(true);
    expect(params.sharedOnly).toBe(true);
    expect(store.get(facetFilterCountAtom)).toBe(5);
  });

  it('keeps the params identical across reads so the query key does not churn', () => {
    const store = createStore();
    store.set(updatedRangeAtom, 'week');

    expect(store.get(chatFacetParamsAtom).updatedAfter).toBe(
      store.get(chatFacetParamsAtom).updatedAfter,
    );
  });

  it('toggles an endpoint off again rather than repeating it', () => {
    const store = createStore();
    store.set(toggleEndpointFilterAtom, 'openAI');
    store.set(toggleEndpointFilterAtom, 'agents');
    expect(store.get(endpointFilterAtom)).toEqual(['openAI', 'agents']);

    store.set(toggleEndpointFilterAtom, 'openAI');
    expect(store.get(endpointFilterAtom)).toEqual(['agents']);
  });

  it('counts a multi-value facet once', () => {
    const store = createStore();
    store.set(toggleEndpointFilterAtom, 'openAI');
    store.set(toggleEndpointFilterAtom, 'agents');

    expect(store.get(facetFilterCountAtom)).toBe(1);
  });

  it('returns every facet to its default on reset', () => {
    const store = createStore();
    store.set(updatedRangeAtom, 'month');
    store.set(createdRangeAtom, 'year');
    store.set(toggleEndpointFilterAtom, 'openAI');
    store.set(hasAttachmentsAtom, true);
    store.set(sharedOnlyAtom, true);

    store.set(resetFacetsAtom);

    expect(store.get(facetFilterCountAtom)).toBe(0);
    expect(store.get(chatFacetParamsAtom)).toEqual({
      updatedAfter: undefined,
      createdAfter: undefined,
      endpoints: undefined,
      hasFiles: undefined,
      sharedOnly: undefined,
    });
  });
});
