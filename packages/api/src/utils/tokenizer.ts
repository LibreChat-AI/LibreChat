import { logger } from '@librechat/data-schemas';
import { Tokenizer as AiTokenizer } from 'ai-tokenizer';

export type EncodingName = 'o200k_base' | 'claude';

type EncodingData = ConstructorParameters<typeof AiTokenizer>[0];

const MAX_TOKENIZER_INPUT_LENGTH = 4 * 1024;
/** Bound BPE's quadratic merge work on uninterrupted text, including whitespace. */
const MAX_TOKENIZER_RUN_LENGTH = 256;
const WHITESPACE = /\s/u;

/** Near-exact budgeting count; seams can change BPE merges, but no content is omitted. */
function countBoundedTokens(text: string, tokenizer: AiTokenizer): number {
  let tokens = 0;
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + MAX_TOKENIZER_INPUT_LENGTH, text.length);
    let runLength = 0;
    let previousWhitespace = false;
    for (let index = offset; index < end; index++) {
      const whitespace = WHITESPACE.test(text[index]);
      runLength = whitespace === previousWhitespace ? runLength + 1 : 1;
      previousWhitespace = whitespace;
      if (runLength >= MAX_TOKENIZER_RUN_LENGTH) {
        end = index + 1;
        break;
      }
    }
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end--;
    }
    tokens += tokenizer.count(text.slice(offset, end));
    offset = end;
  }
  return tokens;
}

function estimateUnavailableTokenCount(text: string): number {
  return text.length > MAX_TOKENIZER_INPUT_LENGTH
    ? Buffer.byteLength(text, 'utf8')
    : Math.ceil(text.length / 4);
}

class Tokenizer {
  private tokenizersCache: Partial<Record<EncodingName, AiTokenizer>> = {};
  private loadingPromises: Partial<Record<EncodingName, Promise<void>>> = {};

  /** Pre-loads an encoding so that subsequent getTokenCount calls are accurate. */
  async initEncoding(encoding: EncodingName): Promise<void> {
    if (this.tokenizersCache[encoding]) {
      return;
    }
    if (this.loadingPromises[encoding]) {
      return this.loadingPromises[encoding];
    }
    this.loadingPromises[encoding] = (async () => {
      const data: EncodingData =
        encoding === 'claude'
          ? await import('ai-tokenizer/encoding/claude')
          : await import('ai-tokenizer/encoding/o200k_base');
      this.tokenizersCache[encoding] = new AiTokenizer(data);
    })();
    return this.loadingPromises[encoding];
  }

  /** Returns an initialized, deterministic budgeting counter that throws on tokenizer failure. */
  async createExactTokenCounter(encoding: EncodingName): Promise<(text: string) => number> {
    await this.initEncoding(encoding);
    const tokenizer = this.tokenizersCache[encoding];
    if (!tokenizer) {
      throw new Error(`Tokenizer encoding failed to initialize: ${encoding}`);
    }
    return (text: string): number => {
      try {
        return countBoundedTokens(text, tokenizer);
      } catch (error) {
        this.handleCountError(encoding, tokenizer, error);
        throw error;
      }
    };
  }

  getTokenCount(text: string, encoding: EncodingName = 'o200k_base'): number {
    const tokenizer = this.tokenizersCache[encoding];
    if (!tokenizer) {
      this.initEncoding(encoding);
      return estimateUnavailableTokenCount(text);
    }
    try {
      return countBoundedTokens(text, tokenizer);
    } catch (error) {
      this.handleCountError(encoding, tokenizer, error);
      return estimateUnavailableTokenCount(text);
    }
  }

  /**
   * Token count for content that must not be estimated, or `undefined` when it
   * cannot be produced, so the caller can omit a figure instead of publishing a
   * guess. Used for a value that is ADDED to exact provider accounting — see the
   * retained tool results of a turn stopped at the tool-call limit — where
   * {@link getTokenCount}'s cold-start/error estimate and chunk-boundary
   * approximation must not be added to exact provider accounting.
   *
   * The input is tokenized whole. Counting it in slices would be cheaper but not
   * exact — seams can change BPE merges — and this caller needs the real number. It costs
   * ~60 ms/MB, so the caller decides how much content is worth counting
   * (`endpoints.agents.maxRetainedToolCountChars`) rather than a bound here.
   */
  countExactTokens(text: string, encoding: EncodingName = 'o200k_base'): number | undefined {
    if (text.length === 0) {
      return 0;
    }
    const tokenizer = this.tokenizersCache[encoding];
    if (!tokenizer) {
      void this.initEncoding(encoding);
      return undefined;
    }
    try {
      return tokenizer.count(text);
    } catch (error) {
      this.handleCountError(encoding, tokenizer, error);
      return undefined;
    }
  }

  private handleCountError(encoding: EncodingName, tokenizer: AiTokenizer, error: unknown): void {
    logger.error('[Tokenizer] Error getting token count:', error);
    if (this.tokenizersCache[encoding] !== tokenizer) {
      return;
    }
    delete this.tokenizersCache[encoding];
    delete this.loadingPromises[encoding];
    void this.initEncoding(encoding).catch((initError: unknown) => {
      logger.error(`[Tokenizer] Error reloading ${encoding} encoding:`, initError);
    });
  }
}

const TokenizerSingleton: Tokenizer = new Tokenizer();

/**
 * Counts the number of tokens in a given text using ai-tokenizer with o200k_base encoding.
 * @param text - The text to count tokens in. Defaults to an empty string.
 * @returns The number of tokens in the provided text.
 */
export async function countTokens(text = ''): Promise<number> {
  await TokenizerSingleton.initEncoding('o200k_base');
  return TokenizerSingleton.getTokenCount(text, 'o200k_base');
}

export default TokenizerSingleton;
