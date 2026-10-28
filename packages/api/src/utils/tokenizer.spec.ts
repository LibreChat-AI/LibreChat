import { Tokenizer as AiTokenizer } from 'ai-tokenizer';
import type { EncodingName } from './tokenizer';
import Tokenizer, { countTokens } from './tokenizer';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

describe('Tokenizer', () => {
  it('should be a singleton (same instance)', async () => {
    const AnotherTokenizer = await import('./tokenizer');
    expect(Tokenizer).toBe(AnotherTokenizer.default);
  });

  describe('initEncoding', () => {
    it('uses the established estimate while the encoding initializes', () => {
      const text = 'Cold start token count';

      expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBe(Math.ceil(text.length / 4));
    });

    it('should load o200k_base encoding', async () => {
      await Tokenizer.initEncoding('o200k_base');
      const count = Tokenizer.getTokenCount('Hello, world!', 'o200k_base');
      expect(count).toBeGreaterThan(0);
    });

    it('should load claude encoding', async () => {
      await Tokenizer.initEncoding('claude');
      const count = Tokenizer.getTokenCount('Hello, world!', 'claude');
      expect(count).toBeGreaterThan(0);
    });

    it('keeps the oversized cold-start fallback and loads the encoding for the next count', async () => {
      await jest.isolateModulesAsync(async () => {
        const cold = (await import('./tokenizer')).default;
        const text = 'word '.repeat(4096);
        expect(cold.getTokenCount(text, 'o200k_base')).toBe(Buffer.byteLength(text, 'utf8'));
        await cold.initEncoding('o200k_base');
        expect(cold.getTokenCount(text, 'o200k_base')).toBeLessThan(text.length / 4);
      });
    });

    it('should deduplicate concurrent init calls', async () => {
      const [, , count] = await Promise.all([
        Tokenizer.initEncoding('o200k_base'),
        Tokenizer.initEncoding('o200k_base'),
        Tokenizer.initEncoding('o200k_base').then(() =>
          Tokenizer.getTokenCount('test', 'o200k_base'),
        ),
      ]);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('getTokenCount', () => {
    beforeAll(async () => {
      await Tokenizer.initEncoding('o200k_base');
      await Tokenizer.initEncoding('claude');
    });

    it('should return the number of tokens in the given text', () => {
      const count = Tokenizer.getTokenCount('Hello, world!', 'o200k_base');
      expect(count).toBeGreaterThan(0);
    });

    it('should count tokens using claude encoding', () => {
      const count = Tokenizer.getTokenCount('Hello, world!', 'claude');
      expect(count).toBeGreaterThan(0);
    });

    it('uses the same bounded count through the asynchronous public helper', async () => {
      const text = 'word '.repeat(4096);
      expect(await countTokens(text)).toBe(Tokenizer.getTokenCount(text, 'o200k_base'));
      expect(await countTokens(text)).toBeLessThan(text.length / 4);
    });

    it('uses the established fallback for the whole input after a later chunk fails', async () => {
      const text = 'word '.repeat(4096);
      const original = AiTokenizer.prototype.count;
      const count = jest
        .spyOn(AiTokenizer.prototype, 'count')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => {
          throw new Error('second chunk failed');
        });
      try {
        expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBe(Buffer.byteLength(text, 'utf8'));
        expect(count).toHaveBeenCalledTimes(2);
      } finally {
        count.mockRestore();
        await Tokenizer.initEncoding('o200k_base');
      }
      expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBeLessThan(text.length / 4);
    });
  });

  describe('createExactTokenCounter', () => {
    it('throws instead of returning a fallback estimate after a tokenizer failure', async () => {
      const counter = await Tokenizer.createExactTokenCounter('o200k_base');
      const count = jest.spyOn(AiTokenizer.prototype, 'count').mockImplementationOnce(() => {
        throw new Error('tokenizer failed');
      });
      try {
        expect(() => counter('Stable cached context')).toThrow('tokenizer failed');
      } finally {
        count.mockRestore();
        await Tokenizer.initEncoding('o200k_base');
      }
    });

    it('never caches a partial count after a later chunk fails and recovers on retry', async () => {
      const counter = await Tokenizer.createExactTokenCounter('o200k_base');
      const text = 'word '.repeat(4096);
      const original = AiTokenizer.prototype.count;
      const count = jest
        .spyOn(AiTokenizer.prototype, 'count')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => {
          throw new Error('second chunk failed');
        });
      try {
        expect(() => counter(text)).toThrow('second chunk failed');
        expect(count).toHaveBeenCalledTimes(2);
      } finally {
        count.mockRestore();
        await Tokenizer.initEncoding('o200k_base');
      }
      const reloaded = await Tokenizer.createExactTokenCounter('o200k_base');
      expect(counter(text)).toBe(reloaded(text));
    });
  });

  const encodings: EncodingName[] = ['o200k_base', 'claude'];
  describe.each(encodings)('bounded counting with %s', (encoding) => {
    let counter: (text: string) => number;
    beforeAll(async () => {
      counter = await Tokenizer.createExactTokenCounter(encoding);
    });

    it.each([4095, 4096, 4097, 8192, 8193, 65536])(
      'counts %i characters without a byte-count cliff',
      (length) => {
        const text = 'word '.repeat(Math.ceil(length / 5)).slice(0, length);
        const exact = Tokenizer.countExactTokens(text, encoding)!;
        expect(counter(text)).toBeGreaterThanOrEqual(exact * 0.99);
        expect(counter(text)).toBeLessThanOrEqual(exact * 1.01);
        expect(Tokenizer.getTokenCount(text, encoding)).toBe(counter(text));
      },
    );

    it.each([
      {
        label: 'minified JSON',
        text: JSON.stringify(
          Array.from({ length: 200 }, (_, id) => ({
            id,
            description: 'Search project documents',
            parameters: { type: 'object', required: ['query'] },
          })),
        ),
      },
      { label: 'CJK', text: '界'.repeat(4097) },
      { label: 'emoji', text: '😀'.repeat(4097) },
      { label: 'mixed density', text: 'word '.repeat(1024) + '界 '.repeat(2048) },
    ])('measures all of $label rather than extrapolating a prefix', ({ text }) => {
      const exact = Tokenizer.countExactTokens(text, encoding)!;
      expect(counter(text)).toBeGreaterThanOrEqual(exact * 0.98);
      expect(counter(text)).toBeLessThanOrEqual(exact * 1.02);
      expect(Tokenizer.getTokenCount(text, encoding)).toBe(counter(text));
    });

    it.each([
      { label: 'English', text: 'word '.repeat(4096) },
      { label: 'uninterrupted punctuation', text: '_'.repeat(8193) },
      { label: 'uninterrupted letters', text: 'a'.repeat(8193) },
      { label: 'whitespace', text: ' '.repeat(8193) },
      { label: 'Unicode whitespace', text: '\u2003'.repeat(8193) },
      { label: 'CJK', text: '界'.repeat(8193) },
      {
        label: 'surrogate at input boundary',
        text: 'word '.repeat(819) + '😀' + 'word '.repeat(819),
      },
      { label: 'surrogate at run boundary', text: 'a'.repeat(255) + '😀' + 'b'.repeat(500) },
    ])('bounds work without dropping or corrupting $label', ({ text }) => {
      const count = jest.spyOn(AiTokenizer.prototype, 'count');
      try {
        counter(text);
        const chunks = count.mock.calls.map(([chunk]) => chunk);
        expect(chunks.join('')).toBe(text);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.length).toBeLessThanOrEqual(4096);
          expect(chunk.length).toBeGreaterThan(0);
          expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk)).toBe(false);
          for (const run of chunk.match(/\s+|\S+/gu) ?? []) {
            expect(run.length).toBeLessThanOrEqual(256);
          }
        }
      } finally {
        count.mockRestore();
      }
    });

    it('keeps empty input empty', () => {
      expect(counter('')).toBe(0);
      expect(Tokenizer.getTokenCount('', encoding)).toBe(0);
    });
  });

  describe('countExactTokens', () => {
    beforeAll(async () => {
      await Tokenizer.initEncoding('o200k_base');
    });

    it("tokenizes oversized input whole without the budgeting counter's seam approximation", () => {
      /** Provider accounting must not carry a sum of slices: BPE merges can change at seams. */
      const text = 'word '.repeat(4096);
      const exact = Tokenizer.countExactTokens(text, 'o200k_base');
      expect(exact).toBeGreaterThan(0);
      expect(exact).toBeLessThan(Tokenizer.getTokenCount(text, 'o200k_base'));
      const bound = 4 * 1024;
      let sliced = 0;
      for (let index = 0; index < text.length; index += bound) {
        sliced += Tokenizer.countExactTokens(text.slice(index, index + bound), 'o200k_base') ?? 0;
      }
      expect(exact).toBeLessThan(sliced);
    });

    it('matches the tokenizer for input inside the fast-path bound', () => {
      const text = 'Hello, world!';
      expect(Tokenizer.countExactTokens(text, 'o200k_base')).toBe(
        Tokenizer.getTokenCount(text, 'o200k_base'),
      );
      expect(Tokenizer.countExactTokens('', 'o200k_base')).toBe(0);
    });

    it('returns nothing while the encoding is still cold', () => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cold = require('./tokenizer').default as typeof Tokenizer;
        expect(cold.countExactTokens('Uncounted tool result', 'o200k_base')).toBeUndefined();
      });
    });
  });
});
