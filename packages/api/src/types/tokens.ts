export interface TokenConfig {
  [key: string]: number;
  prompt: number;
  completion: number;
}

/** An endpoint's config object mapping model keys to their respective prompt, completion rates, and context limit */
export type EndpointTokenConfig = Record<string, TokenConfig>;
