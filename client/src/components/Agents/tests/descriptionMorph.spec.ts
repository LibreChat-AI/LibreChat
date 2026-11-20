import { measureWords, tokenizeWords, wordOffset } from '../descriptionMorph';

describe('tokenizeWords', () => {
  it.each([
    'Compare sources quickly.',
    'A readable description\nwith more detail.',
    '  leading and trailing  ',
    'tabs\tand\n\nblank lines',
    '',
  ])('rebuilds %j exactly from its tokens', (text) => {
    expect(tokenizeWords(text).join('')).toBe(text);
  });
});

describe('measureWords', () => {
  /** A clamp two 20px lines tall, at an offset the results must not carry. */
  const PARAGRAPH = { left: 100, top: 50, width: 200, clipHeight: 40 };
  const LINE_HEIGHT = 20;
  /** Word -> the line it was laid out on, and where it starts along it. */
  const LAYOUT: Record<string, { line: number; x: number; width: number }> = {
    Compare: { line: 0, x: 0, width: 60 },
    sources: { line: 0, x: 64, width: 50 },
    on: { line: 1, x: 0, width: 14 },
    the: { line: 1, x: 18, width: 20 },
    second: { line: 1, x: 42, width: 44 },
    clamped: { line: 2, x: 0, width: 58 },
    away: { line: 2, x: 62, width: 36 },
  };

  const rect = (left: number, top: number, width: number): DOMRect =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + LINE_HEIGHT,
      width,
      height: LINE_HEIGHT,
      x: left,
      y: top,
    }) as DOMRect;

  const paragraph = (text: string): HTMLParagraphElement => {
    const element = document.createElement('p');
    element.textContent = text;
    Object.defineProperty(element, 'clientHeight', { value: PARAGRAPH.clipHeight });
    jest
      .spyOn(element, 'getBoundingClientRect')
      .mockReturnValue(rect(PARAGRAPH.left, PARAGRAPH.top, PARAGRAPH.width));
    document.body.appendChild(element);
    return element;
  };

  beforeEach(() => {
    /* jsdom implements no Range geometry at all, so the layout the morph reads
       has to be supplied rather than spied on. */
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: function (this: Range) {
        const word = this.toString();
        /* A word the layout does not name is one broken across two lines,
           which is what a real wrapped word reports. */
        const placed = LAYOUT[word];
        const rects = placed
          ? [
              rect(
                PARAGRAPH.left + placed.x,
                PARAGRAPH.top + placed.line * LINE_HEIGHT,
                placed.width,
              ),
            ]
          : [
              rect(PARAGRAPH.left + 120, PARAGRAPH.top, 30),
              rect(PARAGRAPH.left, PARAGRAPH.top + LINE_HEIGHT, 40),
            ];
        return Object.assign(rects, {
          item: (index: number) => rects[index] ?? null,
        }) as DOMRectList;
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
    document.body.innerHTML = '';
  });

  it('reports each word against the paragraph, and what the clamp hides', () => {
    const text = 'Compare sources on the second clamped away';
    const boxes = measureWords(paragraph(text), tokenizeWords(text));

    expect(boxes).not.toBeNull();
    /* Offsets are paragraph-relative: the card's place on the page must not
       leak into a transform the dialog applies inside its own paragraph. */
    expect(boxes?.[0]).toEqual({ x: 0, y: 0, visible: true });
    expect(boxes?.[4]).toEqual({ x: 0, y: LINE_HEIGHT, visible: true });
    /* The third line is past the clamp, so those words have nowhere to travel
       from and are left to the fade. */
    expect(boxes?.[10]).toEqual({ x: 0, y: 2 * LINE_HEIGHT, visible: false });
    expect(boxes?.[12]?.visible).toBe(false);
    /* The gaps between words are not words. */
    expect(boxes?.[1]).toBeUndefined();
    expect(boxes?.[3]).toBeUndefined();
  });

  it('leaves a word broken across two lines out of the travel', () => {
    const text = 'Compare unwrappable';
    const boxes = measureWords(paragraph(text), tokenizeWords(text));

    expect(boxes?.[0]).toBeDefined();
    expect(boxes?.[2]).toBeUndefined();
  });

  it('refuses a paragraph showing different copy', () => {
    /* A background refresh can land a new description while the card the dialog
       morphs out of still shows the old one. Matching those two by index would
       fly every word in from the wrong place. */
    expect(
      measureWords(paragraph('The copy the card still shows'), tokenizeWords('New copy')),
    ).toBe(null);
  });
});

describe('wordOffset', () => {
  it('moves a word between the two wrappings without resizing it', () => {
    /* The two paragraphs are handed to each other by the shared layout
       animation, so the delta between their own coordinates is the whole
       transform: the word travels, like the title beside it, and is never
       scaled out of the card's smaller setting. */
    expect(wordOffset({ x: 10, y: 40 }, { x: 30, y: 8 })).toBe('translate3d(-20.00px, 32.00px, 0)');
  });
});
