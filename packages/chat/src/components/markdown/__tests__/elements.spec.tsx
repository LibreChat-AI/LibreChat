/**
 * @jest-environment jsdom
 */
import React from 'react';
import remarkGfm from 'remark-gfm';
import ReactMarkdown from 'react-markdown';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TAttachment, TUser } from 'librechat-data-provider';
import type { MessagePartsHost } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { markdownElements, markdownPreviewElements } from '../elements';
import { CodeBlockProvider } from '../../../react/parts/codeIndex';
import { MessagePartsHostProvider } from '../../../react/host';
import { buildAttachmentsByName } from '../../../core/media';
import { MediaContext } from '../../../react/parts/media';
import { triggerDownload } from '../../../core/download';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('../../../core/download', () => ({
  ...jest.requireActual('../../../core/download'),
  triggerDownload: jest.fn(),
}));

beforeAll(() => {
  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

type Elements = typeof markdownElements;

function draw(
  text: string,
  overrides: Partial<MessagePartsHost> = {},
  elements: Elements = markdownElements,
  attachments?: TAttachment[],
) {
  return render(
    <MessagePartsHostProvider host={createMessagePartsHost(overrides)}>
      <MediaContext.Provider
        value={{ attachmentsByName: attachments && buildAttachmentsByName(attachments) }}
      >
        <CodeBlockProvider>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={elements}>
            {text}
          </ReactMarkdown>
        </CodeBlockProvider>
      </MediaContext.Provider>
    </MessagePartsHostProvider>,
  );
}

const FENCES = '```python\nprint(1)\n```\n\n`inline`\n\n```js\nlet a;\n```\n';

describe('markdown code', () => {
  it('draws a fence as the package’s code block when the host adds nothing', () => {
    const { container } = draw(FENCES);
    const blocks = container.querySelectorAll('code.hljs');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveClass('language-python');
    expect(blocks[0]).toHaveTextContent('print(1)');
    expect(screen.getAllByRole('button', { name: 'com_ui_copy_code' })).toHaveLength(2);
    expect(screen.getByText('inline').tagName).toBe('CODE');
    expect(screen.getByText('inline')).not.toHaveClass('hljs');
  });

  it('hands a reply’s fences to the host in document order, as executable', () => {
    const renderCodeBlock = jest.fn(({ lang, blockIndex }) => (
      <div data-testid="block">{`${lang}:${blockIndex}`}</div>
    ));
    draw(FENCES, { renderCodeBlock });
    expect(screen.getAllByTestId('block').map((block) => block.textContent)).toEqual([
      'python:0',
      'js:1',
    ]);
    for (const [props] of renderCodeBlock.mock.calls) {
      expect(props.executable).toBe(true);
    }
  });

  it('hands a preview’s fences to the host as not executable', () => {
    const renderCodeBlock = jest.fn(({ lang }) => <div data-testid="block">{lang}</div>);
    draw('```python\nprint(1)\n```\n', { renderCodeBlock }, markdownPreviewElements);
    expect(screen.getByTestId('block')).toHaveTextContent('python');
    expect(renderCodeBlock).toHaveBeenCalledWith(
      expect.objectContaining({ executable: false, lang: 'python' }),
    );
  });

  it('selects the whole of an inline code span on double click', () => {
    draw('`inline`');
    fireEvent.doubleClick(screen.getByText('inline'));
    expect(window.getSelection()?.toString()).toBe('inline');
  });
});

describe('markdown mermaid fences', () => {
  const DIAGRAMS = '```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\ngraph TD; C-->D\n```\n';

  it('asks the host for each diagram, with an id for its position, behind a guard', () => {
    const renderMermaid = jest.fn(({ id }) => <div data-testid="diagram">{id}</div>);
    draw(DIAGRAMS, { renderMermaid });
    expect(screen.getAllByTestId('diagram').map((diagram) => diagram.textContent)).toEqual([
      'mermaid-0',
      'mermaid-1',
    ]);
    expect(renderMermaid).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'graph TD; A-->B\n', guarded: true }),
    );
  });

  it('asks for a preview’s diagram without an id or a guard', () => {
    const renderMermaid = jest.fn(() => <div data-testid="diagram" />);
    draw(DIAGRAMS, { renderMermaid }, markdownPreviewElements);
    expect(renderMermaid).toHaveBeenCalledWith({ code: 'graph TD; A-->B\n', guarded: false });
  });

  it('draws the fence as code for a host with no diagram, and not through its code block', () => {
    const renderCodeBlock = jest.fn(() => <div data-testid="block" />);
    const { container } = draw('```mermaid\ngraph TD; A-->B\n```\n', { renderCodeBlock });
    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(container.querySelector('code.language-mermaid')).toHaveTextContent('graph TD; A-->B');
  });

  it('gives the diagrams their own sequence, apart from the code blocks around them', () => {
    const renderMermaid = jest.fn(({ id }) => <div data-testid="diagram">{id}</div>);
    const renderCodeBlock = jest.fn(({ blockIndex }) => (
      <div data-testid="block">{blockIndex}</div>
    ));
    draw('```js\na\nb\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```js\nc\nd\n```\n', {
      renderMermaid,
      renderCodeBlock,
    });
    expect(screen.getAllByTestId('block').map((block) => block.textContent)).toEqual(['0', '1']);
    expect(screen.getByTestId('diagram')).toHaveTextContent('mermaid-0');
  });
});

describe('markdown links', () => {
  const user = { id: 'u1' } as TUser;
  const FILE = '[report](https://example.test/api/files/u1/f1/report.csv)';

  beforeEach(() => jest.mocked(triggerDownload).mockClear());

  it('opens an ordinary link in a new tab', () => {
    draw('[docs](https://example.test/docs)', { useUser: () => user });
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.test/docs');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('leaves a link to the user’s file an ordinary link for a host with no download', () => {
    draw(FILE, { useUser: () => user });
    const link = screen.getByRole('link', { name: 'report' });
    expect(link).toHaveAttribute('href', 'https://example.test/api/files/u1/f1/report.csv');
    fireEvent.click(link);
    expect(triggerDownload).not.toHaveBeenCalled();
  });

  it('downloads the user’s file through the host, under its own name', async () => {
    const download = jest.fn(() => Promise.resolve('blob:saved'));
    const useFileDownload = jest.fn(() => download);
    draw(FILE, { useUser: () => user, useFileDownload });
    expect(useFileDownload).toHaveBeenCalledWith('f1');
    const link = screen.getByRole('link', { name: 'report' });
    expect(link).toHaveAttribute('href', '/api/files/u1/f1/report.csv');
    fireEvent.click(link);
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('blob:saved', 'report.csv'));
  });

  it('tells the reader when the file could not be fetched', async () => {
    const toast = jest.fn();
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    draw(FILE, {
      useUser: () => user,
      useToast: () => toast,
      useFileDownload: () => () => Promise.resolve(undefined),
    });
    fireEvent.click(screen.getByRole('link', { name: 'report' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({ status: 'error', message: 'com_ui_download_error' }),
    );
    expect(triggerDownload).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('asks the host about no file for another user’s path', () => {
    const useFileDownload = jest.fn(() => () => Promise.resolve('blob:x'));
    draw('[theirs](https://example.test/api/files/u2/f9/secret.csv)', {
      useUser: () => user,
      useFileDownload,
    });
    expect(useFileDownload).toHaveBeenCalledWith('');
    expect(screen.getByRole('link', { name: 'theirs' })).toHaveAttribute(
      'href',
      'https://example.test/api/files/u2/f9/secret.csv',
    );
  });
});

describe('markdown images, blocks and tables', () => {
  it('resolves an image a run produced by the name the reply gives it', () => {
    const attachment = { filename: 'chart.png', filepath: '/images/u1/chart.png' } as TAttachment;
    draw('![Chart](chart.png)', {}, markdownElements, [attachment]);
    expect(screen.getByRole('img', { name: 'Chart' })).toHaveAttribute(
      'src',
      '/images/u1/chart.png',
    );
  });

  it('leaves an image source no attachment answers to as written', () => {
    draw('![Logo](https://example.test/logo.png)');
    expect(screen.getByRole('img', { name: 'Logo' })).toHaveAttribute(
      'src',
      'https://example.test/logo.png',
    );
  });

  it('lets each paragraph and heading find its own direction', () => {
    draw('# Title\n\nBody');
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Body')).toHaveAttribute('dir', 'auto');
  });

  it('gives a list and a quote the direction of their text', () => {
    const { container } = draw('- שלום\n- עולם\n\n> hello\n');
    expect(container.querySelector('ul')).toHaveAttribute('dir', 'rtl');
    expect(container.querySelector('blockquote')).toHaveAttribute('dir', 'ltr');
  });

  it('wraps a table in one frame that takes the table’s direction', () => {
    const { container } = draw('| שלום | עולם |\n| --- | --- |\n| א | ב |\n');
    const frame = container.querySelector('.markdown-table-wrapper');
    expect(frame).toHaveAttribute('dir', 'rtl');
    expect(frame?.querySelector('table')).not.toBeNull();
  });
});
