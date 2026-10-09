import type { Logger as WinstonLogger } from 'winston';
import type { z } from 'zod';
import type { webSearchSchema } from '../config';

export type SearchRefType = 'search' | 'image' | 'news' | 'video' | 'ref';

export enum DATE_RANGE {
  PAST_HOUR = 'h',
  PAST_24_HOURS = 'd',
  PAST_WEEK = 'w',
  PAST_MONTH = 'm',
  PAST_YEAR = 'y',
}

export type SearchProvider = 'serper' | 'searxng' | 'tavily' | 'keenable';
export type ScraperProvider = 'firecrawl' | 'serper' | 'tavily' | 'keenable';
export type RerankerType = 'infinity' | 'jina' | 'cohere' | 'none';

export interface Highlight {
  score: number;
  text: string;
  references?: UsedReferences;
}

export type ProcessedSource = {
  content?: string;
  attribution?: string;
  references?: References;
  highlights?: Highlight[];
  processed?: boolean;
};

export type ProcessedOrganic = OrganicResult & ProcessedSource;
export type ProcessedTopStory = TopStoryResult & ProcessedSource;
export type ValidSource = ProcessedOrganic | ProcessedTopStory;

export type ResultReference = {
  link: string;
  type: 'link' | 'image' | 'video' | 'file';
  title?: string;
  attribution?: string;
};
export interface SearchResultData {
  turn?: number;
  organic?: ProcessedOrganic[];
  topStories?: ProcessedTopStory[];
  images?: ImageResult[];
  videos?: VideoResult[];
  places?: PlaceResult[];
  news?: NewsResult[];
  shopping?: ShoppingResult[];
  knowledgeGraph?: KnowledgeGraphResult;
  answerBox?: AnswerBoxResult;
  peopleAlsoAsk?: PeopleAlsoAskResult[];
  relatedSearches?: Array<{ query: string }>;
  references?: ResultReference[];
  error?: string;
}

export interface SearchResult {
  data?: SearchResultData;
  error?: string;
  success: boolean;
}

export interface Source {
  link: string;
  html?: string;
  title?: string;
  snippet?: string;
  date?: string;
}

export interface SearchConfig {
  searchProvider?: SearchProvider;
  serperApiKey?: string;
  searxngInstanceUrl?: string;
  searxngApiKey?: string;
  searxngSearchOptions?: z.infer<typeof webSearchSchema>['searxngSearchOptions'];
  tavilyApiKey?: string;
  tavilySearchUrl?: string;
  tavilySearchOptions?: TavilyConfig['tavilySearchOptions'];
  keenableApiKey?: string;
  keenableApiUrl?: string;
  keenableSearchOptions?: KeenableConfig['keenableSearchOptions'];
}

export type References = {
  links: MediaReference[];
  images: MediaReference[];
  videos: MediaReference[];
};
export interface ScrapeResult {
  url: string;
  error?: boolean;
  content: string;
  attribution?: string;
  references?: References;
  highlights?: Highlight[];
}

export interface ProcessSourcesConfig {
  topResults?: number;
  strategies?: string[];
  filterContent?: boolean;
  reranker?: unknown;
  logger?: Logger;
}

export interface FirecrawlConfig {
  firecrawlApiKey?: string;
  firecrawlApiUrl?: string;
  firecrawlOptions?: {
    formats?: string[];
    includeTags?: string[];
    excludeTags?: string[];
    headers?: Record<string, string>;
    waitFor?: number;
    timeout?: number;
    maxAge?: number;
    mobile?: boolean;
    skipTlsVerification?: boolean;
    blockAds?: boolean;
    removeBase64Images?: boolean;
    parsePDF?: boolean;
    storeInCache?: boolean;
    zeroDataRetention?: boolean;
    location?: {
      country?: string;
      languages?: string[];
    };
    onlyMainContent?: boolean;
    changeTrackingOptions?: {
      modes?: string[];
      schema?: Record<string, unknown>;
      prompt?: string;
      tag?: string | null;
    };
  };
}

export interface TavilyConfig {
  tavilyApiKey?: string;
  tavilySearchUrl?: string;
  tavilyExtractUrl?: string;
  tavilySearchOptions?: z.infer<typeof webSearchSchema>['tavilySearchOptions'];
  tavilyScraperOptions?: z.infer<typeof webSearchSchema>['tavilyScraperOptions'];
}

export interface KeenableConfig {
  keenableApiKey?: string;
  keenableApiUrl?: string;
  keenableSearchOptions?: z.infer<typeof webSearchSchema>['keenableSearchOptions'];
  keenableScraperOptions?: z.infer<typeof webSearchSchema>['keenableScraperOptions'];
}

export interface ScraperContentResult {
  content: string;
}

export interface ScraperExtractionResult {
  no_extraction: ScraperContentResult;
}

export interface JinaRerankerResult {
  index: number;
  relevance_score: number;
  document?: string | { text: string };
}

export interface JinaRerankerResponse {
  model: string;
  usage: {
    total_tokens: number;
  };
  results: JinaRerankerResult[];
}

export interface CohereRerankerResult {
  index: number;
  relevance_score: number;
}

export interface CohereRerankerResponse {
  results: CohereRerankerResult[];
  id: string;
  meta: {
    api_version: {
      version: string;
      is_experimental: boolean;
    };
    billed_units: {
      search_units: number;
    };
  };
}

export type SafeSearchLevel = 0 | 1 | 2;

export type Logger = WinstonLogger;
export interface MediaReference {
  originalUrl: string;
  title?: string;
  text?: string;
}

export type UsedReferences = {
  type: 'link' | 'image' | 'video';
  originalIndex: number;
  reference: MediaReference;
}[];

/** Firecrawl */

export interface FirecrawlScrapeOptions {
  formats?: string[];
  includeTags?: string[];
  excludeTags?: string[];
  headers?: Record<string, string>;
  waitFor?: number;
  timeout?: number;
}

export interface ScrapeMetadata {
  // Core source information
  sourceURL?: string;
  url?: string;
  scrapeId?: string;
  statusCode?: number;
  // Basic metadata
  title?: string;
  description?: string;
  language?: string;
  favicon?: string;
  viewport?: string;
  robots?: string;
  'theme-color'?: string;
  // Open Graph metadata
  'og:url'?: string;
  'og:title'?: string;
  'og:description'?: string;
  'og:type'?: string;
  'og:image'?: string;
  'og:image:width'?: string;
  'og:image:height'?: string;
  'og:site_name'?: string;
  ogUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogSiteName?: string;
  // Article metadata
  'article:author'?: string;
  'article:published_time'?: string;
  'article:modified_time'?: string;
  'article:section'?: string;
  'article:tag'?: string;
  'article:publisher'?: string;
  publishedTime?: string;
  modifiedTime?: string;
  // Twitter metadata
  'twitter:site'?: string | boolean | number | null;
  'twitter:creator'?: string;
  'twitter:card'?: string;
  'twitter:image'?: string;
  'twitter:dnt'?: string;
  'twitter:app:name:iphone'?: string;
  'twitter:app:id:iphone'?: string;
  'twitter:app:url:iphone'?: string;
  'twitter:app:name:ipad'?: string;
  'twitter:app:id:ipad'?: string;
  'twitter:app:url:ipad'?: string;
  'twitter:app:name:googleplay'?: string;
  'twitter:app:id:googleplay'?: string;
  'twitter:app:url:googleplay'?: string;
  // Facebook metadata
  'fb:app_id'?: string;
  // App links
  'al:ios:url'?: string;
  'al:ios:app_name'?: string;
  'al:ios:app_store_id'?: string;
  // Allow for additional properties that might be present
  [key: string]: string | number | boolean | null | undefined;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    screenshot?: string;
    links?: string[];
    metadata?: ScrapeMetadata;
  };
  error?: string;
}

export interface FirecrawlScraperConfig {
  apiKey?: string;
  apiUrl?: string;
  formats?: string[];
  timeout?: number;
  logger?: Logger;
}

/** Serper API */
export interface VideoResult {
  title?: string;
  link?: string;
  snippet?: string;
  imageUrl?: string;
  duration?: string;
  source?: string;
  channel?: string;
  date?: string;
  position?: number;
}

export interface PlaceResult {
  position?: number;
  name?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  ratingCount?: number;
  category?: string;
  identifier?: string;
}

export interface NewsResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
  imageUrl?: string;
  position?: number;
}

export interface ShoppingResult {
  title?: string;
  source?: string;
  link?: string;
  price?: string;
  delivery?: string;
  imageUrl?: string;
  rating?: number;
  ratingCount?: number;
  offers?: string;
  productId?: string;
  position?: number;
}

export interface ScholarResult {
  title?: string;
  link?: string;
  publicationInfo?: string;
  snippet?: string;
  year?: number;
  citedBy?: number;
}

export interface ImageResult {
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  thumbnailUrl?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  source?: string;
  domain?: string;
  link?: string;
  googleUrl?: string;
  position?: number;
}

export interface SerperSearchPayload extends SerperSearchInput {
  /**
   * Search type/vertical
   * Options: "search" (web), "images", "news", "places", "videos"
   */
  type?: 'search' | 'images' | 'news' | 'places' | 'videos';

  /**
   * Starting index for search results pagination (used instead of page)
   */
  start?: number;

  /**
   * Filtering for safe search
   * Options: "off", "moderate", "active"
   */
  safe?: 'off' | 'moderate' | 'active';
}

export type SerperSearchParameters = Pick<SerperSearchPayload, 'q' | 'type'> & {
  engine: 'google';
};

export interface OrganicResult {
  position?: number;
  title?: string;
  link: string;
  snippet?: string;
  date?: string;
  sitelinks?: Array<{
    title: string;
    link: string;
  }>;
}

export interface TopStoryResult {
  title?: string;
  link: string;
  source?: string;
  date?: string;
  imageUrl?: string;
}
export interface KnowledgeGraphResult {
  title?: string;
  type?: string;
  imageUrl?: string;
  description?: string;
  descriptionSource?: string;
  descriptionLink?: string;
  attributes?: Record<string, string>;
  website?: string;
}

export interface AnswerBoxResult {
  title?: string;
  snippet?: string;
  snippetHighlighted?: string[];
  link?: string;
  date?: string;
}

export interface PeopleAlsoAskResult {
  question?: string;
  snippet?: string;
  title?: string;
  link?: string;
}

export type RelatedSearches = Array<{ query: string }>;

export interface SerperSearchInput {
  /**
   * The search query string
   */
  q: string;

  /**
   * Country code for localized results
   * Examples: "us", "uk", "ca", "de", etc.
   */
  gl?: string;

  /**
   * Interface language
   * Examples: "en", "fr", "de", etc.
   */
  hl?: string;

  /**
   * Number of results to return (up to 100)
   */
  num?: number;
  /**
   * Specific location for contextual results
   * Example: "New York, NY"
   */
  location?: string;

  /**
   * Search autocorrection setting
   */
  autocorrect?: boolean;
  page?: number;
  /**
   * Date range for search results
   * Options: "h" (past hour), "d" (past 24 hours), "w" (past week),
   * "m" (past month), "y" (past year)
   * `qdr:${DATE_RANGE}`
   */
  tbs?: string;
}

export type SerperResultData = {
  searchParameters: SerperSearchPayload;
  organic?: OrganicResult[];
  topStories?: TopStoryResult[];
  images?: ImageResult[];
  videos?: VideoResult[];
  places?: PlaceResult[];
  news?: NewsResult[];
  shopping?: ShoppingResult[];
  peopleAlsoAsk?: PeopleAlsoAskResult[];
  relatedSearches?: RelatedSearches;
  knowledgeGraph?: KnowledgeGraphResult;
  answerBox?: AnswerBoxResult;
  credits?: number;
};

/** SearXNG */

export interface SearxNGSearchPayload {
  /**
   * The search query string
   * Supports syntax specific to different search engines
   * Example: "site:github.com SearXNG"
   */
  q: string;

  /**
   * Comma-separated list of search categories
   * Example: "general,images,news"
   */
  categories?: string;

  /**
   * Comma-separated list of search engines to use
   * Example: "google,bing,duckduckgo"
   */
  engines?: string;

  /**
   * Code of the language for search results
   * Example: "en", "fr", "de", "es"
   */
  language?: string;

  /**
   * Search page number
   * Default: 1
   */
  pageno?: number;

  /**
   * Time range filter for search results
   * Options: "day", "month", "year"
   */
  time_range?: 'day' | 'month' | 'year';

  /**
   * Output format of results
   * Options: "json", "csv", "rss"
   */
  format?: 'json' | 'csv' | 'rss';

  /**
   * Open search results on new tab
   * Options: `0` (off), `1` (on)
   */
  results_on_new_tab?: 0 | 1;

  /**
   * Proxy image results through SearxNG
   * Options: true, false
   */
  image_proxy?: boolean;

  /**
   * Service for autocomplete suggestions
   * Options: "google", "dbpedia", "duckduckgo", "mwmbl",
   *          "startpage", "wikipedia", "stract", "swisscows", "qwant"
   */
  autocomplete?: string;

  /**
   * Safe search filtering level
   * Options: "0" (off), "1" (moderate), "2" (strict)
   */
  safesearch?: 0 | 1 | 2;

  /**
   * Theme to use for results page
   * Default: "simple" (other themes may be available per instance)
   */
  theme?: string;

  /**
   * List of enabled plugins
   * Default: "Hash_plugin,Self_Information,Tracker_URL_remover,Ahmia_blacklist"
   */
  enabled_plugins?: string;

  /**
   * List of disabled plugins
   */
  disabled_plugins?: string;

  /**
   * List of enabled engines
   */
  enabled_engines?: string;

  /**
   * List of disabled engines
   */
  disabled_engines?: string;
}

export interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  img_src?: string;
}
