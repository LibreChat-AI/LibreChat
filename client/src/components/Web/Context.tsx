import { createContext, useContext } from 'react';
import type { SearchRefType, ValidSource, ResultReference } from 'librechat-data-provider';
import type * as t from './types';
import { useSearchContext } from '~/Providers';

export interface CitationContextType {
  hoveredCitationId: string | null;
  setHoveredCitationId: (id: string | null) => void;
}

export const CitationContext = createContext<CitationContextType>({
  hoveredCitationId: null,
  setHoveredCitationId: () => {},
});

export function useHighlightState(citationId: string | undefined) {
  const { hoveredCitationId } = useContext(CitationContext);
  return citationId && hoveredCitationId === citationId;
}

export type CitationSource = (ValidSource | ResultReference) & {
  turn: number;
  refType: string | SearchRefType;
  index: number;
};

const refTypeMap: Record<string | SearchRefType, string> = {
  search: 'organic',
  ref: 'references',
  news: 'topStories',
  file: 'references',
  image: 'images',
  video: 'videos',
};

export function useCitation({
  turn,
  index,
  refType: _refType,
}: {
  turn: number;
  index: number;
  refType?: SearchRefType | string;
}): (t.Citation & t.Reference) | undefined {
  const { searchResults } = useSearchContext();
  if (!_refType) {
    return undefined;
  }
  const refType = refTypeMap[_refType.toLowerCase()]
    ? refTypeMap[_refType.toLowerCase()]
    : _refType;

  if (!searchResults || !searchResults[turn] || !searchResults[turn][refType]) {
    return undefined;
  }

  const source: CitationSource = searchResults[turn][refType][index];

  if (!source) {
    return undefined;
  }

  return {
    ...source,
    turn,
    refType: _refType.toLowerCase(),
    index,
    link: source.link ?? '',
    title: source.title ?? '',
    snippet: source['snippet'] ?? '',
    attribution: source.attribution ?? '',
  };
}

export function useCompositeCitations(
  citations: Array<{ turn: number; refType: SearchRefType | string; index: number }>,
): Array<t.Citation & t.Reference> {
  const { searchResults } = useSearchContext();

  const result: Array<t.Citation & t.Reference> = [];

  for (const { turn, refType: _refType, index } of citations) {
    const refType = refTypeMap[_refType.toLowerCase()]
      ? refTypeMap[_refType.toLowerCase()]
      : _refType;

    if (!searchResults || !searchResults[turn] || !searchResults[turn][refType]) {
      continue;
    }
    const source: CitationSource = searchResults[turn][refType][index];
    if (!source) {
      continue;
    }

    result.push({
      ...source,
      turn,
      refType: _refType.toLowerCase(),
      index,
      link: source.link ?? '',
      title: source.title ?? '',
      snippet: source['snippet'] ?? '',
      attribution: source.attribution ?? '',
    });
  }

  return result;
}
