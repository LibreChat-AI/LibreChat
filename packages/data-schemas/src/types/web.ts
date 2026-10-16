import type { SearchCategories } from 'librechat-data-provider';

export type TWebSearchKeys =
  | 'serperApiKey'
  | 'searxngInstanceUrl'
  | 'searxngApiKey'
  | 'firecrawlApiKey'
  | 'firecrawlApiUrl'
  | 'firecrawlVersion'
  | 'tavilyApiKey'
  | 'tavilySearchUrl'
  | 'tavilyExtractUrl'
  | 'keenableApiKey'
  | 'keenableApiUrl'
  | 'jinaApiKey'
  | 'jinaApiUrl'
  | 'cohereApiKey'
  | 'cohereApiUrl';

export type TWebSearchCategories =
  | SearchCategories.PROVIDERS
  | SearchCategories.SCRAPERS
  | SearchCategories.RERANKERS;
