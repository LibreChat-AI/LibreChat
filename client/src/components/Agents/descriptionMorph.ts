/**
 * Measurement for the word-level description morph.
 *
 * The card and the dialog wrap the same copy differently: the card clamps it to
 * three lines at a smaller size, the dialog sets all of it. To travel between
 * those two arrangements a word needs to know where it sat in each, so both
 * sides are measured as offsets inside the paragraph that owns them.
 *
 * Paragraph-relative offsets are what makes this safe to do mid-morph. The two
 * paragraphs are handed to each other by a shared layout animation, so at the
 * moment the dialog opens they occupy the same place on screen: a word's
 * position inside the card's paragraph and its position inside the dialog's are
 * directly comparable, and neither carries the transform that animation has
 * applied to the paragraphs themselves.
 */

/** One word's place inside the paragraph that renders it. */
export interface WordBox {
  /** Offset from the paragraph's own top-left corner, in CSS pixels. */
  x: number;
  y: number;
}

/** A word as the card left it, including whether the card's clamp showed it. */
export interface SourceWordBox extends WordBox {
  visible: boolean;
}

/** Tokens that are the gaps between words rather than words. */
export const WHITESPACE_TOKEN = /^\s+$/;
/** A word ending on the clip's last row is still shown; sub-pixel rows are not. */
const CLIP_TOLERANCE = 0.5;

/**
 * Words and the whitespace runs between them. Joining the tokens returns the
 * input unchanged, which is what keeps the morphed copy the same string — and
 * the same line breaks — as the copy the card and the screen reader get.
 */
export const tokenizeWords = (text: string): string[] =>
  text.split(/(\s+)/).filter((token) => token !== '');

/**
 * Where `paragraph` put each word of `tokens`, and whether it showed it.
 *
 * Ranges rather than wrappers: the source paragraph is one of many in a
 * virtualized grid and stays plain text, so nothing is added to a card for the
 * sake of an animation it may never take part in.
 *
 * Returns null when the paragraph is not rendering that exact copy — a
 * background refresh can land a new description while the card it morphs from
 * still shows the old one — because a word matched by index across two
 * different strings would fly in from the wrong place.
 */
export const measureWords = (
  paragraph: HTMLElement,
  tokens: string[],
): Array<SourceWordBox | undefined> | null => {
  if (paragraph.textContent !== tokens.join('')) {
    return null;
  }
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  /** `atEnd` keeps a word that finishes a text node inside that node. */
  const locate = (offset: number, atEnd: boolean): [Text, number] | null => {
    let remaining = offset;
    for (const node of nodes) {
      if (remaining < node.length || (atEnd && remaining === node.length)) {
        return [node, remaining];
      }
      remaining -= node.length;
    }
    return null;
  };

  const origin = paragraph.getBoundingClientRect();
  const clipBottom = origin.top + paragraph.clientTop + paragraph.clientHeight + CLIP_TOLERANCE;
  const boxes: Array<SourceWordBox | undefined> = new Array(tokens.length);
  const range = document.createRange();
  /* No range geometry, no wrapping to travel from: an environment without
     layout (jsdom, a print context) leaves every word to the dissolve. */
  if (typeof range.getClientRects !== 'function') {
    return null;
  }
  let offset = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!WHITESPACE_TOKEN.test(token)) {
      const start = locate(offset, false);
      const end = locate(offset + token.length, true);
      if (start != null && end != null) {
        range.setStart(start[0], start[1]);
        range.setEnd(end[0], end[1]);
        const rects = range.getClientRects();
        /* A word broken across two lines has no single box to travel from, so
           it is left to the fade rather than stretched between them. */
        if (rects.length === 1) {
          const rect = rects[0];
          boxes[index] = {
            x: rect.left - origin.left,
            y: rect.top - origin.top,
            visible: rect.bottom <= clipBottom,
          };
        }
      }
    }
    offset += token.length;
  }
  return boxes;
};

/**
 * The transform that puts a word where the other paragraph had it. Position
 * only: the word travels, the way the title and the avatar beside it do, and
 * the type is set at its final size from the first frame rather than being
 * scaled up out of the card's.
 */
export const wordOffset = (from: WordBox, to: WordBox): string =>
  `translate3d(${(from.x - to.x).toFixed(2)}px, ${(from.y - to.y).toFixed(2)}px, 0)`;
