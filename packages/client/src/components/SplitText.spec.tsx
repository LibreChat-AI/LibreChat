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

  it.each([
    ['rtl', 'Welcome to reeva::chat', ['Welcome', 'to', 'reeva::chat']],
    ['ltr', 'שלום עולם', ['שלום', 'עולם']],
  ])('uses the accessible copy to resolve %s-document greeting %s', (dir, text, expectedWords) => {
    const previousDir = document.documentElement.dir;
    document.documentElement.dir = dir;
    try {
      const { container } = render(<SplitText text={text} />);
      const paragraph = container.querySelector('p');
      expect(paragraph).toHaveAttribute('dir', 'auto');

      const accessibleCopy = paragraph?.querySelector('.sr-only');
      expect(paragraph?.firstElementChild).toBe(accessibleCopy);
      expect(accessibleCopy).toHaveTextContent(text);
      expect(accessibleCopy?.closest('[aria-hidden="true"]')).toBeNull();

      const wordBoxes = container.querySelectorAll('p > span[dir="auto"]');
      expect(wordBoxes).toHaveLength(expectedWords.length);
      for (const [index, box] of Array.from(wordBoxes).entries()) {
        expect(box).toHaveAttribute('aria-hidden', 'true');
        expect(
          Array.from(box.querySelectorAll('span.inline-block'))
            .map((span) => span.textContent)
            .join(''),
        ).toBe(expectedWords[index]);
      }
    } finally {
      document.documentElement.dir = previousDir;
    }
  });
});
