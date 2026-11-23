import { createContext, useContext } from 'react';
import type { SearchResultData } from 'librechat-data-provider';
import type { Context } from 'react';

/** The web search results of the message being drawn, by the turn that produced them. */
export type SearchResults = {
  searchResults?: { [key: string]: SearchResultData };
};

export const SearchContext: Context<SearchResults> = createContext<SearchResults>({});
export const useSearchContext = (): SearchResults => useContext(SearchContext);
