import copy from 'copy-to-clipboard';
import { ContentTypes } from 'librechat-data-provider';
import { renderHook, act } from '@testing-library/react';
import type {
  SearchResultData,
  ProcessedOrganic,
  TMessageContentParts,
} from 'librechat-data-provider';
import useCopyToClipboard, { hasCopyableText } from '~/hooks/Messages/useCopyToClipboard';

// Mock the copy-to-clipboard module
jest.mock('copy-to-clipboard');

describe('useCopyToClipboard', () => {
  const mockSetIsCopied = jest.fn();
  const mockCopy = copy as jest.MockedFunction<typeof copy>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCopy.mockReturnValue(true);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('Basic functionality', () => {
    it('should copy plain text without citations', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          text: 'Simple text without citations',
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).toHaveBeenCalledWith('Simple text without citations', {
        format: 'text/plain',
      });
      expect(mockSetIsCopied).toHaveBeenCalledWith(true);
    });

    it('should handle content array with text types', () => {
      const content = [
        { type: ContentTypes.TEXT, text: 'First line' },
        { type: ContentTypes.TEXT, text: 'Second line' },
      ];

      const { result } = renderHook(() =>
        useCopyToClipboard({
          content: content as TMessageContentParts[],
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).toHaveBeenCalledWith('First line\nSecond line', {
        format: 'text/plain',
      });
    });

    it('copies only response text and skips tools, errors, and thinking', () => {
      const content = [
        { type: ContentTypes.TEXT, text: 'I checked the deployment.' },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            type: 'tool_call',
            name: 'get_deployment',
            args: '{"service":"web"}',
            output: '{"status":"failed"}',
          },
        },
        { type: ContentTypes.THINK, think: 'Let me reason about this' },
        { type: ContentTypes.ERROR, error: 'Deployment lookup failed' },
        { type: ContentTypes.TEXT, text: 'The service is down.' },
      ] as TMessageContentParts[];

      const { result } = renderHook(() => useCopyToClipboard({ content }));

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).toHaveBeenCalledWith('I checked the deployment.\nThe service is down.', {
        format: 'text/plain',
      });
    });

    it('does not append a trailing newline when skipped parts follow the last text part', () => {
      const content = [
        { type: ContentTypes.TEXT, text: 'sudo rm nothing' },
        { type: ContentTypes.ERROR, error: 'Deployment lookup failed' },
      ] as TMessageContentParts[];

      const { result } = renderHook(() => useCopyToClipboard({ content }));

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).toHaveBeenCalledWith('sudo rm nothing', { format: 'text/plain' });
    });

    it('does not add blank lines for empty text parts', () => {
      const content = [
        { type: ContentTypes.TEXT, text: '' },
        { type: ContentTypes.TEXT, text: 'Only line' },
        { type: ContentTypes.TEXT, text: { value: '' } },
      ] as TMessageContentParts[];

      const { result } = renderHook(() => useCopyToClipboard({ content }));

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).toHaveBeenCalledWith('Only line', { format: 'text/plain' });
    });

    it('preserves the clipboard when the message has no response text', () => {
      const content = [
        { type: ContentTypes.ERROR, error: 'Something went wrong' },
      ] as TMessageContentParts[];

      const { result } = renderHook(() => useCopyToClipboard({ content }));

      let copied: boolean | undefined;
      act(() => {
        copied = result.current(mockSetIsCopied);
      });

      expect(copied).toBe(false);
      expect(mockCopy).not.toHaveBeenCalled();
      expect(mockSetIsCopied).not.toHaveBeenCalled();
    });

    it('reports whether the copy reached the clipboard', () => {
      const { result } = renderHook(() => useCopyToClipboard({ text: 'Copy me' }));

      let copied: boolean | undefined;
      act(() => {
        copied = result.current(mockSetIsCopied);
      });

      expect(copied).toBe(true);
    });

    it('does not report success when the clipboard write fails', () => {
      mockCopy.mockReturnValueOnce(false);
      const { result } = renderHook(() => useCopyToClipboard({ text: 'Copy me' }));

      let copied: boolean | undefined;
      act(() => {
        copied = result.current(mockSetIsCopied);
      });

      expect(copied).toBe(false);
      expect(mockSetIsCopied).not.toHaveBeenCalled();
    });

    it('preserves the clipboard when the message text is empty', () => {
      const { result } = renderHook(() => useCopyToClipboard({ text: '   ' }));

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).not.toHaveBeenCalled();
      expect(mockSetIsCopied).not.toHaveBeenCalled();
    });

    it('should reset isCopied after timeout', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          text: 'Test text',
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockSetIsCopied).toHaveBeenCalledWith(true);

      act(() => {
        jest.advanceTimersByTime(3000);
      });

      expect(mockSetIsCopied).toHaveBeenCalledWith(false);
    });
  });

  describe('hasCopyableText', () => {
    it('is false for a response made only of skipped parts', () => {
      const content = [
        { type: ContentTypes.TOOL_CALL, tool_call: { type: 'tool_call', name: 'search' } },
        { type: ContentTypes.ERROR, error: 'Something went wrong' },
      ] as TMessageContentParts[];

      expect(hasCopyableText({ content })).toBe(false);
    });

    it('is true when any text part carries content', () => {
      const content = [
        { type: ContentTypes.ERROR, error: 'Something went wrong' },
        { type: ContentTypes.TEXT, text: 'The service is down.' },
      ] as TMessageContentParts[];

      expect(hasCopyableText({ content })).toBe(true);
    });

    it('is false for whitespace-only text parts', () => {
      const content = [{ type: ContentTypes.TEXT, text: '   \n' }] as TMessageContentParts[];

      expect(hasCopyableText({ content })).toBe(false);
    });

    it('falls back to the message text when there are no content parts', () => {
      expect(hasCopyableText({ text: 'Plain response' })).toBe(true);
      expect(hasCopyableText({ text: '  ' })).toBe(false);
      expect(hasCopyableText({})).toBe(false);
    });

    it('is false for text that survives only as citation markup', () => {
      expect(hasCopyableText({ text: '\\ue202turn0search0' })).toBe(false);
    });

    it('is true when citation markup resolves against search results', () => {
      const searchResults = {
        '0': { organic: [{ link: 'https://example.com/1', title: 'Source 1' }] },
      };

      expect(hasCopyableText({ text: '\\ue202turn0search0', searchResults })).toBe(true);
    });

    it('agrees with the copy the hook would perform', () => {
      const source = { text: '\\ue202turn0search0' };
      const { result } = renderHook(() => useCopyToClipboard(source));

      let copied: boolean | undefined;
      act(() => {
        copied = result.current(mockSetIsCopied);
      });

      expect(copied).toBe(hasCopyableText(source));
      expect(copied).toBe(false);
    });
  });

  describe('Citation formatting', () => {
    const mockSearchResults: { [key: string]: SearchResultData } = {
      '0': {
        organic: [
          {
            link: 'https://example.com/search1',
            title: 'Search Result 1',
            snippet: 'This is a search result',
          },
        ],
        topStories: [
          {
            link: 'https://example.com/news1',
            title: 'News Story 1',
          },
          {
            link: 'https://example.com/news2',
            title: 'News Story 2',
          },
        ],
        images: [
          {
            link: 'https://example.com/image1',
            title: 'Image 1',
          },
        ],
        videos: [
          {
            link: 'https://example.com/video1',
            title: 'Video 1',
          },
        ],
      },
    };

    it('should format standalone search citations', () => {
      const text = 'This is a fact \\ue202turn0search0 from search.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `This is a fact [1] from search.

Citations:
[1] https://example.com/search1
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });

    it('should format news citations with correct mapping', () => {
      const text = 'Breaking news \\ue202turn0news0 and more news \\ue202turn0news1.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `Breaking news [1] and more news [2].

Citations:
[1] https://example.com/news1
[2] https://example.com/news2
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });

    it('should handle highlighted text with citations', () => {
      const text = '\\ue203This is highlighted text\\ue204 \\ue202turn0search0 with citation.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `**This is highlighted text** [1] with citation.

Citations:
[1] https://example.com/search1
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });

    it('should handle composite citations', () => {
      const text =
        'Multiple sources \\ue200\\ue202turn0search0\\ue202turn0news0\\ue202turn0news1\\ue201.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `Multiple sources [1][2][3].

Citations:
[1] https://example.com/search1
[2] https://example.com/news1
[3] https://example.com/news2
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });
  });

  describe('Citation deduplication', () => {
    it('should use same number for duplicate URLs', () => {
      const mockSearchResultsWithDupes: { [key: string]: SearchResultData } = {
        '0': {
          organic: [
            {
              link: 'https://example.com/article',
              title: 'Article from search',
            },
          ],
          topStories: [
            {
              link: 'https://example.com/article', // Same URL
              title: 'Article from news',
            },
          ],
        },
      };

      const text = 'First citation \\ue202turn0search0 and second \\ue202turn0news0.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResultsWithDupes,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `First citation [1] and second [1].

Citations:
[1] https://example.com/article
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });

    it('should handle multiple citations of the same source', () => {
      const mockSearchResults: { [key: string]: SearchResultData } = {
        '0': {
          organic: [
            {
              link: 'https://example.com/source1',
              title: 'Source 1',
            },
          ],
        },
      };

      const text =
        'First mention \\ue202turn0search0. Second mention \\ue202turn0search0. Third \\ue202turn0search0.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `First mention [1]. Second mention [1]. Third [1].

Citations:
[1] https://example.com/source1
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });
  });

  describe('Edge cases', () => {
    it('should handle missing search results gracefully', () => {
      const text = 'Text with citation \\ue202turn0search0 but no data.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: {},
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      // Updated expectation: Citation marker should be removed
      expect(mockCopy).toHaveBeenCalledWith('Text with citation but no data.', {
        format: 'text/plain',
      });
    });

    it('should handle invalid citation indices', () => {
      const mockSearchResults: { [key: string]: SearchResultData } = {
        '0': {
          organic: [
            {
              link: 'https://example.com/search1',
              title: 'Search Result 1',
            },
          ],
        },
      };

      const text = 'Valid citation \\ue202turn0search0 and invalid \\ue202turn0search5.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      // Updated expectation: Invalid citation marker should be removed
      const expectedText = `Valid citation [1] and invalid.

Citations:
[1] https://example.com/search1
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });

    it('should handle citations without links', () => {
      const mockSearchResults: { [key: string]: SearchResultData } = {
        '0': {
          organic: [
            {
              title: 'No link source',
              // No link property
            } as ProcessedOrganic,
          ],
        },
      };

      const text = 'Citation without link \\ue202turn0search0.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      // Updated expectation: Citation marker without link should be removed
      expect(mockCopy).toHaveBeenCalledWith('Citation without link.', {
        format: 'text/plain',
      });
    });

    it('should clean up orphaned citation lists at the end', () => {
      const mockSearchResults: { [key: string]: SearchResultData } = {
        '0': {
          organic: [
            { link: 'https://example.com/1', title: 'Source 1' },
            { link: 'https://example.com/2', title: 'Source 2' },
          ],
        },
      };

      const text = 'Text with citations \\ue202turn0search0.\n\n[1][2]';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `Text with citations [1].

Citations:
[1] https://example.com/1
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });
  });

  describe('All citation types', () => {
    const mockSearchResults: { [key: string]: SearchResultData } = {
      '0': {
        organic: [{ link: 'https://example.com/search', title: 'Search' }],
        topStories: [{ link: 'https://example.com/news', title: 'News' }],
        images: [{ link: 'https://example.com/image', title: 'Image' }],
        videos: [{ link: 'https://example.com/video', title: 'Video' }],
        references: [{ link: 'https://example.com/ref', title: 'Reference', type: 'link' }],
      },
    };

    it('should handle all citation types correctly', () => {
      const text =
        'Search \\ue202turn0search0, news \\ue202turn0news0, image \\ue202turn0image0, video \\ue202turn0video0, ref \\ue202turn0ref0.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `Search [1], news [2], image [3], video [4], ref [5].

Citations:
[1] https://example.com/search
[2] https://example.com/news
[3] https://example.com/image
[4] https://example.com/video
[5] https://example.com/ref
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });
  });

  describe('Complex scenarios', () => {
    it('should handle mixed highlighted text and composite citations', () => {
      const mockSearchResults: { [key: string]: SearchResultData } = {
        '0': {
          organic: [
            { link: 'https://example.com/1', title: 'Source 1' },
            { link: 'https://example.com/2', title: 'Source 2' },
          ],
          topStories: [{ link: 'https://example.com/3', title: 'News 1' }],
        },
      };

      const text =
        '\\ue203Highlighted text with citation\\ue204 \\ue202turn0search0 and composite \\ue200\\ue202turn0search1\\ue202turn0news0\\ue201.';

      const { result } = renderHook(() =>
        useCopyToClipboard({
          text,
          searchResults: mockSearchResults,
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const expectedText = `**Highlighted text with citation** [1] and composite [2][3].

Citations:
[1] https://example.com/1
[2] https://example.com/2
[3] https://example.com/3
`;

      expect(mockCopy).toHaveBeenCalledWith(expectedText, { format: 'text/plain' });
    });
  });

  describe('File citations', () => {
    it('resolves a file citation against the references collection', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          text: 'From the handbook \ue202turn0file0.',
          searchResults: {
            '0': {
              references: [{ link: 'https://example.com/handbook.pdf', title: 'Handbook' }],
            },
          } as unknown as { [key: string]: SearchResultData },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const [plainText] = mockCopy.mock.calls[0];
      expect(plainText).toContain('From the handbook [1].');
      expect(plainText).toContain('[1] https://example.com/handbook.pdf');
    });
  });

  describe('Rich text', () => {
    const getClipboardHtml = (): string => {
      const [, options] = mockCopy.mock.calls[0];
      const clipboardData = { setData: jest.fn() };
      options?.onCopy?.(clipboardData);
      const [format, html] = clipboardData.setData.mock.calls[0] ?? [];
      expect(format).toBe('text/html');
      return html as string;
    };

    it('should not add an html flavor when rich text is off', () => {
      const { result } = renderHook(() => useCopyToClipboard({ text: '# Title' }));

      act(() => {
        result.current(mockSetIsCopied);
      });

      expect(mockCopy).toHaveBeenCalledWith('# Title', { format: 'text/plain' });
    });

    it('should copy markdown as html alongside the plain text', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          text: '# Title\n\nSome **bold** text.',
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const [plainText, options] = mockCopy.mock.calls[0];
      expect(plainText).toBe('# Title\n\nSome **bold** text.');
      expect(options?.format).toBe('text/plain');
      expect(getClipboardHtml()).toBe('<h1>Title</h1>\n<p>Some <strong>bold</strong> text.</p>');
      expect(mockSetIsCopied).toHaveBeenCalledWith(true);
    });

    it('should convert content parts and citations to html', () => {
      const mockSearchResults: { [key: string]: SearchResultData } = {
        '0': { organic: [{ link: 'https://example.com/1', title: 'Source 1' }] },
      };

      const { result } = renderHook(() =>
        useCopyToClipboard({
          content: [
            { type: ContentTypes.TEXT, text: '## Findings' },
            { type: ContentTypes.TEXT, text: 'Cited \ue202turn0search0' },
          ] as TMessageContentParts[],
          searchResults: mockSearchResults,
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const html = getClipboardHtml();
      expect(html).toContain('<h2>Findings</h2>');
      expect(html).toContain('Cited [1]');
      expect(html).toContain('https://example.com/1');
    });

    it('does not let a markdown construct span two content parts', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          content: [
            { type: ContentTypes.TEXT, text: '```js' },
            { type: ContentTypes.TEXT, text: 'Prose that renders on its own.' },
          ] as TMessageContentParts[],
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const html = getClipboardHtml();
      expect(html).toContain('<p>Prose that renders on its own.</p>');
      expect(html).not.toContain('<code>Prose');
    });

    it('does not let a definition capture a generated citation marker', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          text: 'Cited \ue202turn0search0.\n\n[1]: https://other.example',
          searchResults: {
            '0': { organic: [{ link: 'https://example.com/1', title: 'Source 1' }] },
          } as { [key: string]: SearchResultData },
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const html = getClipboardHtml();
      expect(html).toContain('Cited [1].');
      expect(html).not.toContain('other.example">1</a>');
      expect(html).toContain('https://example.com/1');
    });

    it('scopes reserved citation labels to the part that generated them', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          content: [
            { type: ContentTypes.TEXT, text: 'Cited \ue202turn0search0.' },
            {
              type: ContentTypes.TEXT,
              text: 'See [manual][1].\n\n[1]: https://manual.example',
            },
          ] as TMessageContentParts[],
          searchResults: {
            '0': { organic: [{ link: 'https://example.com/1', title: 'Source 1' }] },
          } as { [key: string]: SearchResultData },
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const html = getClipboardHtml();
      expect(html).toContain('<p>Cited [1].</p>');
      expect(html).toContain('<a href="https://manual.example">manual</a>');
    });

    it('keeps the citation footer out of an unfinished construct', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          text: 'Cited \ue202turn0search0.\n\n```js\nconst a = 1;',
          searchResults: {
            '0': { organic: [{ link: 'https://example.com/1', title: 'Source 1' }] },
          } as { [key: string]: SearchResultData },
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const html = getClipboardHtml();
      expect(html).toContain(
        '<p>Citations:<br />[1] <a href="https://example.com/1">https://example.com/1</a></p>',
      );
      expect(html).toContain('<code>const a = 1;</code></pre>');
      expect(html).not.toContain('Citations:</code>');
    });

    it('keeps the part boundary out of the plain text', () => {
      const { result } = renderHook(() =>
        useCopyToClipboard({
          content: [
            { type: ContentTypes.TEXT, text: 'First line' },
            { type: ContentTypes.TEXT, text: 'Second line' },
          ] as TMessageContentParts[],
          searchResults: {
            '0': { organic: [{ link: 'https://example.com/1', title: 'Source 1' }] },
          } as { [key: string]: SearchResultData },
          richText: { variant: 'full', latex: false },
        }),
      );

      act(() => {
        result.current(mockSetIsCopied);
      });

      const [plainText] = mockCopy.mock.calls[0];
      expect(plainText).toBe('First line\nSecond line');
      expect(plainText).not.toContain('\ue210');
    });
  });
});
