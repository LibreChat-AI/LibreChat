import { render } from '@testing-library/react';
import SplitText from './SplitText';

describe('SplitText', () => {
  it('renders emojis correctly', () => {
    const emojis = ['🚧', '❤️‍🔥', '💜', '🦎', '❌', '✅', '⚠️'];
    const originalText = emojis.join('');

    const { container } = render(<SplitText text={originalText} />);
    const textSpans = container.querySelectorAll('p > span > span.inline-block');

    // Reconstruct the text by joining all span contents
    const reconstructedText = Array.from(textSpans)
      .map((span) => span.textContent)
      .join('')
      .trim();
    // Compare the reconstructed text with the original
    expect(reconstructedText).toBe(originalText);

    // Check the first character specifically as the reconstructed text could hide issues
    for (let i = 0; i < emojis.length; i++) {
      expect(Array.from(textSpans)[i].textContent).toBe(emojis[i]);
    }
  });

  it('resolves direction from the text, not the document, for every word box', () => {
    document.documentElement.dir = 'rtl';
    try {
      const { container } = render(<SplitText text="Welcome to reeva::chat" />);
      const paragraph = container.querySelector('p');
      expect(paragraph).toHaveAttribute('dir', 'auto');
      const wordBoxes = container.querySelectorAll('p > span');
      /** three words plus nothing else at that level */
      expect(wordBoxes).toHaveLength(3);
      for (const box of Array.from(wordBoxes)) {
        expect(box).toHaveAttribute('dir', 'auto');
      }
      /** Grapheme order inside a word is the source order; the direction
       *  attribute, not reordering, decides how the boxes lay out. */
      const firstWord = Array.from(wordBoxes[0].querySelectorAll('span.inline-block'))
        .map((span) => span.textContent)
        .join('');
      expect(firstWord).toBe('Welcome');
    } finally {
      document.documentElement.dir = '';
    }
  });
});
