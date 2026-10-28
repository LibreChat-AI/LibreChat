import React from 'react';
import ReactMarkdown from 'react-markdown';
import { render } from '@testing-library/react';
import type { FadePlugin } from '../animate';
import {
  splitWords,
  beginRun,
  endRun,
  classifyValue,
  createFadeState,
  createFadePlugin,
  AnimatedText,
  FADE_DURATION_MS,
  FADE_STAGGER_MS,
  FADE_STAGGER_MAX_MS,
  FADE_HYDRATION_THRESHOLD,
} from '../animate';

let nowSpy: jest.SpyInstance<number, []>;
let mockedNow = 0;

const setTime = (value: number) => {
  mockedNow = value;
};

beforeEach(() => {
  mockedNow = 0;
  nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => mockedNow);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe('splitWords', () => {
  it('splits into word parts with trailing whitespace and round-trips exactly', () => {
    const value = '  Hello world,\nthis  is streamed ';
    const parts = splitWords(value);
    expect(parts.join('')).toBe(value);
    expect(parts[0]).toBe('  ');
    expect(parts[1]).toBe('Hello ');
    expect(parts[2]).toBe('world,\n');
  });

  it('splits CJK runs into smaller segments', () => {
    const parts = splitWords('これは日本語のテストです');
    expect(parts.join('')).toBe('これは日本語のテストです');
    expect(parts.length).toBeGreaterThan(1);
  });

  it('segments kana-only Japanese text without any Han characters', () => {
    const hiragana = splitWords('こんにちはせかい');
    expect(hiragana.join('')).toBe('こんにちはせかい');
    expect(hiragana.length).toBeGreaterThan(1);

    const katakana = splitWords('カタカナテキスト');
    expect(katakana.join('')).toBe('カタカナテキスト');
    expect(katakana.length).toBeGreaterThan(1);
  });

  it('segments spaceless Southeast Asian scripts', () => {
    const thai = splitWords('สวัสดีครับผมชื่อจอห์นและนี่คือการทดสอบ');
    expect(thai.join('')).toBe('สวัสดีครับผมชื่อจอห์นและนี่คือการทดสอบ');
    expect(thai.length).toBeGreaterThan(1);

    const burmese = splitWords('မင်္ဂလာပါကမ္ဘာကြီး');
    expect(burmese.join('')).toBe('မင်္ဂလာပါကမ္ဘာကြီး');
    expect(burmese.length).toBeGreaterThan(1);
  });
});

describe('classifyValue', () => {
  it('animates every word on the first run with capped stagger', () => {
    const state = createFadeState();
    const run = beginRun(state);
    const words = 'a b c d e f g h i j k l m'.split(' ').join(' ');
    const segments = classifyValue(run, words).filter((segment) => /\S/.test(segment.value));
    endRun(run);

    expect(segments.every((segment) => segment.animated)).toBe(true);
    expect(segments[0].delay).toBe(0);
    expect(segments[1].delay).toBe(FADE_STAGGER_MS);
    const maxDelay = Math.max(...segments.map((segment) => segment.delay));
    expect(maxDelay).toBe(FADE_STAGGER_MAX_MS);
  });

  it('does not animate whitespace parts', () => {
    const state = createFadeState();
    const run = beginRun(state);
    const segments = classifyValue(run, '  hello  ');
    endRun(run);
    const whitespace = segments.filter((segment) => !/\S/.test(segment.value));
    expect(whitespace.length).toBeGreaterThan(0);
    expect(whitespace.every((segment) => !segment.animated)).toBe(true);
  });

  it('only animates newly appended words on later runs', () => {
    const state = createFadeState();
    const first = beginRun(state);
    classifyValue(first, 'hello world ');
    endRun(first);

    setTime(FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1);
    const second = beginRun(state);
    const segments = classifyValue(second, 'hello world and more');
    endRun(second);

    const byValue = new Map(segments.map((segment) => [segment.value.trim(), segment]));
    expect(byValue.get('hello')?.animated).toBe(false);
    expect(byValue.get('world')?.animated).toBe(false);
    expect(byValue.get('and')?.animated).toBe(true);
    expect(byValue.get('more')?.animated).toBe(true);
  });

  it('replays identical animation props for words still inside their window', () => {
    const state = createFadeState();
    const first = beginRun(state);
    const firstSegments = classifyValue(first, 'hello world');
    endRun(first);
    const worldDelay = firstSegments.find((s) => s.value === 'world')?.delay;

    setTime(FADE_DURATION_MS / 2);
    const second = beginRun(state);
    const segments = classifyValue(second, 'hello world again');
    endRun(second);

    const world = segments.find((segment) => segment.value.trim() === 'world');
    expect(world?.animated).toBe(true);
    expect(world?.delay).toBe(worldDelay);
  });

  it('keeps animating a word that grows at the stream head', () => {
    const state = createFadeState();
    const first = beginRun(state);
    classifyValue(first, 'hel');
    endRun(first);

    setTime(FADE_DURATION_MS / 2);
    const second = beginRun(state);
    const segments = classifyValue(second, 'hello');
    endRun(second);
    expect(segments[0].animated).toBe(true);
    expect(segments[0].delay).toBe(0);
  });
});

describe('createFadePlugin', () => {
  const renderMarkdown = (fade: FadePlugin, content: string) => (
    /** @ts-ignore */
    <ReactMarkdown rehypePlugins={[fade.plugin]}>{content}</ReactMarkdown>
  );

  it('wraps words in fade spans on first render, including inline formatting', () => {
    const fade = createFadePlugin();
    const { container } = render(renderMarkdown(fade, 'Hello **bold** world'));
    const spans = container.querySelectorAll('span[data-lc-fade]');
    expect(spans.length).toBe(3);
    expect(container.textContent).toBe('Hello bold world');
  });

  it('does not wrap text inside code blocks or inline code', () => {
    const fade = createFadePlugin();
    const { container } = render(
      renderMarkdown(fade, 'text `inline code` more\n\n```\nconst x = 1;\n```'),
    );
    expect(container.querySelector('code span[data-lc-fade]')).toBeNull();
    expect(container.querySelector('pre span[data-lc-fade]')).toBeNull();
    expect(container.querySelectorAll('p span[data-lc-fade]').length).toBe(2);
  });

  it('only animates appended words across streamed re-renders', () => {
    const fade = createFadePlugin();
    const { container, rerender } = render(renderMarkdown(fade, 'Hello world'));
    fade.commit();

    setTime(FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1);
    rerender(renderMarkdown(fade, 'Hello world and more text'));

    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['and', 'more', 'text']);
    const bare = Array.from(container.querySelectorAll('p > span:not([data-lc-fade])')).map(
      (span) => span.textContent?.trim(),
    );
    expect(bare).toEqual(['Hello', 'world']);
  });

  it('does not re-animate words when markdown restructures around them', () => {
    const fade = createFadePlugin();
    const { container, rerender } = render(renderMarkdown(fade, 'Result is done and'));
    fade.commit();

    setTime(FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1);
    rerender(renderMarkdown(fade, 'Result is done and **final**'));

    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['final']);
  });

  it('treats the first render of a hydrated plugin as baseline without animating', () => {
    const fade = createFadePlugin(true);
    const hydrated = `word${' word'.repeat(Math.ceil(FADE_HYDRATION_THRESHOLD / 5) + 4)}`;
    const { container, rerender } = render(renderMarkdown(fade, hydrated));
    expect(container.querySelectorAll('span[data-lc-fade]').length).toBe(0);
    fade.commit();

    rerender(renderMarkdown(fade, `${hydrated} appended tail`));
    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['appended', 'tail']);
  });

  it('animates a large first render on a non-hydrated plugin (new block in one chunk)', () => {
    const fade = createFadePlugin();
    const large = `word${' word'.repeat(Math.ceil(FADE_HYDRATION_THRESHOLD / 5) + 4)}`;
    const { container } = render(renderMarkdown(fade, large));
    expect(container.querySelectorAll('span[data-lc-fade]').length).toBeGreaterThan(0);
  });

  it('re-classifies identically when a render is never committed', () => {
    const fade = createFadePlugin();
    const { container, rerender } = render(renderMarkdown(fade, 'Hello world'));

    setTime(FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1);
    rerender(renderMarkdown(fade, 'Hello world'));

    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['Hello', 'world']);
  });
});

describe('AnimatedText', () => {
  it('renders new words in fade spans and settles old words to plain text', () => {
    const { container, rerender } = render(<AnimatedText text="thinking about" />);
    expect(container.querySelectorAll('span[data-lc-fade]').length).toBe(2);

    setTime(FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1);
    rerender(<AnimatedText text="thinking about the answer" />);

    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['the', 'answer']);
    expect(container.textContent).toBe('thinking about the answer');
  });

  it('treats large hydrated text as baseline without animating', () => {
    const hydrated = `word${' word'.repeat(Math.ceil(FADE_HYDRATION_THRESHOLD / 5) + 4)}`;
    const { container, rerender } = render(<AnimatedText text={hydrated} />);
    expect(container.querySelectorAll('span[data-lc-fade]').length).toBe(0);

    rerender(<AnimatedText text={`${hydrated} appended tail`} />);
    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['appended', 'tail']);
  });

  it('collapses the settled prefix into one text node and only renders the tail per word', () => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    const base = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const { container, rerender } = render(<AnimatedText text={base} />);

    setTime(settle);
    rerender(<AnimatedText text={`${base} next`} />);
    setTime(settle * 2);
    rerender(<AnimatedText text={`${base} next one`} />);

    const [first, ...rest] = Array.from(container.childNodes);
    expect(first.nodeType).toBe(Node.TEXT_NODE);
    expect(first.textContent).toBe(`${base} `);
    expect(rest.length).toBeLessThanOrEqual(2);
    const animated = Array.from(container.querySelectorAll('span[data-lc-fade]')).map((span) =>
      span.textContent?.trim(),
    );
    expect(animated).toEqual(['one']);
    expect(container.textContent).toBe(`${base} next one`);
  });

  it('keeps the last word out of the settled prefix so it can keep growing', () => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    const { container, rerender } = render(<AnimatedText text="alpha beta" />);
    setTime(settle);
    rerender(<AnimatedText text="alpha beta" />);
    setTime(settle * 2);
    rerender(<AnimatedText text="alpha betamax" />);

    expect(container.firstChild?.textContent).toBe('alpha ');
    expect(container.childNodes).toHaveLength(2);
    expect(container.textContent).toBe('alpha betamax');
  });

  it.each([
    ['a spaceless CJK run', '我们需要先分析这个问题然后给出答案'.repeat(8), '首先考虑'],
    ['an unsegmented run without whitespace', 'x'.repeat(200), 'yyyy'],
    ['spaced words', 'word '.repeat(60), 'more '],
  ])('only classifies a bounded tail per render for %s', (_label, base, appended) => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    const { container, rerender } = render(<AnimatedText text={base} />);
    setTime(settle);
    rerender(<AnimatedText text={`${base}${appended}`} />);
    setTime(settle * 2);

    const execSpy = jest.spyOn(RegExp.prototype, 'exec');
    rerender(<AnimatedText text={`${base}${appended}${appended}`} />);
    const classified = execSpy.mock.calls.reduce(
      (longest, [input], index) =>
        execSpy.mock.contexts[index].source === '\\S+\\s*'
          ? Math.max(longest, input.length)
          : longest,
      0,
    );
    execSpy.mockRestore();

    expect(classified).toBeGreaterThan(0);
    expect(classified).toBeLessThanOrEqual(64 + appended.length * 2);
    expect(container.textContent).toBe(`${base}${appended}${appended}`);
  });

  it.each([
    ['ZWJ families and combining marks', ['\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 'e\u0301']],
    ['skin-tone modifiers', ['\u{1F44D}\u{1F3FD}', '\u{1F44B}\u{1F3FF}']],
    ['regional-indicator flags', ['\u{1F1FA}\u{1F1F8}', '\u{1F1EF}\u{1F1F5}']],
  ])('never cuts the settled prefix inside a grapheme cluster: %s', (_label, clusters) => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    let text = clusters.join('').repeat(40);
    const { container, rerender } = render(<AnimatedText text={text} />);
    for (let step = 1; step <= 12; step++) {
      setTime(settle * step);
      text += step % 3 === 0 ? 'x' : clusters[step % clusters.length];
      rerender(<AnimatedText text={text} />);
      const first = container.firstChild?.textContent ?? '';
      expect(first.length).toBeGreaterThan(0);
      const units = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      );
      expect(units.some((unit) => unit.index === first.length)).toBe(true);
    }
    expect(container.textContent).toBe(text);
  });

  it('does not cut inside a spaceless run when Intl.Segmenter is unavailable', () => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    const segmenter = Intl.Segmenter;
    const flags = '\u{1F1FA}\u{1F1F8}\u{1F1EF}\u{1F1F5}';
    try {
      Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
      let Isolated: typeof AnimatedText = AnimatedText;
      jest.isolateModules(() => {
        jest.doMock('react', () => React);
        Isolated = jest.requireActual<typeof import('../animate')>('../animate').AnimatedText;
      });
      let text = `a ${flags.repeat(20)}`;
      const { container, rerender } = render(<Isolated text={text} />);
      for (let step = 1; step <= 6; step++) {
        setTime(settle * step);
        text += step % 2 === 0 ? 'x' : flags;
        rerender(<Isolated text={text} />);
        const settledLength = container.firstChild?.textContent?.length ?? 0;
        expect(settledLength).toBeLessThanOrEqual(2);
      }
      expect(container.textContent).toBe(text);
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { value: segmenter, configurable: true });
    }
  });

  it('re-classifies from the start when the text no longer extends the settled prefix', () => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    const { container, rerender } = render(<AnimatedText text="first draft here" />);
    setTime(settle);
    rerender(<AnimatedText text="first draft here now" />);
    setTime(settle * 2);
    rerender(<AnimatedText text="replaced text" />);

    expect(container.textContent).toBe('replaced text');
  });

  it('renders the current characters when a rewrite keeps the probed prefix regions', () => {
    const settle = FADE_DURATION_MS + FADE_STAGGER_MAX_MS + 1;
    const head = 'h'.repeat(40);
    const edge = 'e'.repeat(40);
    const original = `${head} ${'a'.repeat(30)} ${edge} tail`;
    const rewritten = `${head} ${'b'.repeat(30)} ${edge} tail more`;
    const { container, rerender } = render(<AnimatedText text={original} />);
    setTime(settle);
    rerender(<AnimatedText text={`${original} next`} />);
    setTime(settle * 2);
    rerender(<AnimatedText text={rewritten} />);

    expect(container.textContent).toBe(rewritten);
  });
});
