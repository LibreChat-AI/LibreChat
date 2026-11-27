import { applyCitationLimits, selectFileCitationSources } from './citations';

describe('file citation selection', () => {
  const sources = [
    { fileId: 'a', relevance: 0.9, page: 1 },
    { fileId: 'a', relevance: 0.8, page: 2 },
    { fileId: 'b', relevance: 0.7, page: 1 },
    { fileId: 'c', relevance: 0.2, page: 1 },
  ];

  it('applies per-file and total limits by relevance', () => {
    expect(applyCitationLimits(sources, 2, 1)).toEqual([sources[0], sources[2]]);
  });

  it('shares relevance and count selection without losing source identity', () => {
    expect(
      selectFileCitationSources(sources, {
        minRelevanceScore: 0.5,
        maxCitations: 3,
        maxCitationsPerFile: 1,
      }),
    ).toEqual([sources[0], sources[2]]);
  });

  it('handles artifacts without sources', () => {
    expect(selectFileCitationSources(undefined)).toEqual([]);
  });
});
