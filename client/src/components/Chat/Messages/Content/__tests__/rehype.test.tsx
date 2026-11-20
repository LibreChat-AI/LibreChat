import React from 'react';
import remarkMath from 'remark-math';
import ReactMarkdown from 'react-markdown';
import { render, screen, waitFor } from '@testing-library/react';
import { needsRehype, toRehypePlugins, useRehypeModules } from '../rehype';

function Preview({ text, detectsLanguage }: { text: string; detectsLanguage?: boolean }) {
  const modules = useRehypeModules(text, detectsLanguage);
  return (
    <div data-testid="preview" data-loaded={modules != null}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={
          toRehypePlugins(modules) as React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

describe('needsRehype', () => {
  it.each([
    ['inline math', 'mass $E=mc^2$'],
    ['bracket math', 'see \\(x\\)'],
    ['display math', '\\[x\\]'],
    ['a backtick fence', '```js\nconst a = 1;\n```'],
    ['a tilde fence', '~~~\nplain\n~~~'],
  ])('loads the plugins for %s', (_label, text) => {
    expect(needsRehype(text)).toBe(true);
  });

  it('skips plain prose, inline code and unlabeled indented code', () => {
    expect(needsRehype('Just a sentence with `inline` code and a list:\n- item')).toBe(false);
    expect(needsRehype('Intro\n\n    indented code')).toBe(false);
  });
});

describe('useRehypeModules', () => {
  it('renders plain text without loading anything', () => {
    render(<Preview text="Hello there" />);
    expect(screen.getByTestId('preview')).toHaveAttribute('data-loaded', 'false');
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('loads for a language-detecting renderer whatever the text', async () => {
    render(<Preview text={'- item\n\n      const answer = 42;'} detectsLanguage />);
    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loaded', 'true'),
    );
  });

  it('renders math once KaTeX arrives', async () => {
    const { container } = render(<Preview text="Energy is $$E=mc^2$$" />);
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
    expect(screen.getByTestId('preview')).toHaveAttribute('data-loaded', 'true');
  });
});
