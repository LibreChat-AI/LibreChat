import type { Logger as WinstonLogger } from 'winston';

export type SearchRefType = 'search' | 'image' | 'news' | 'video' | 'ref';

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

export type References = {
  links: MediaReference[];
  images: MediaReference[];
  videos: MediaReference[];
};
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
