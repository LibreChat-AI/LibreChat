import { Constants, Tools } from 'librechat-data-provider';
import type { TAttachment, TMessage } from 'librechat-data-provider';
import {
  aggregateSessionSources,
  countSessionSources,
  hasSessionSources,
  liveAttachmentsForConversation,
} from '../aggregate';

const messageId = 'message-1';
const conversationId = 'convo-1';

function message(attachments: TAttachment[]): TMessage {
  return {
    messageId,
    parentMessageId: 'parent-1',
    conversationId,
    createdAt: '2026-01-01T00:00:00.000Z',
    text: '',
    isCreatedByUser: false,
    attachments,
  };
}

function webSearchAttachment(data: Record<string, unknown>): TAttachment {
  return {
    messageId,
    toolCallId: 'call-1',
    conversationId,
    type: Tools.web_search,
    [Tools.web_search]: data,
  } as TAttachment;
}

function fileSearchAttachment(sources: Record<string, unknown>[]): TAttachment {
  return {
    messageId,
    toolCallId: 'call-2',
    conversationId,
    type: Tools.file_search,
    [Tools.file_search]: { sources },
  } as TAttachment;
}

describe('aggregateSessionSources', () => {
  it('returns empty groups for a conversation without attachments', () => {
    const sources = aggregateSessionSources([message([])]);
    expect(sources).toEqual({ links: [], news: [], images: [], files: [] });
    expect(hasSessionSources(sources)).toBe(false);
    expect(countSessionSources(sources)).toBe(0);
  });

  it('collects organic results, news, images and link references from web search', () => {
    const sources = aggregateSessionSources([
      message([
        webSearchAttachment({
          organic: [{ title: 'Result A', link: 'https://a.example/page', snippet: 'Snippet A' }],
          topStories: [{ title: 'Story B', link: 'https://news.example/b' }],
          images: [{ title: 'Image C', imageUrl: 'https://img.example/c.jpg' }],
          references: [
            { title: 'Ref D', link: 'https://d.example/ref', type: 'link', snippet: 'Ref snippet' },
          ],
        }),
      ]),
    ]);

    expect(sources.links.map((source) => source.link)).toEqual([
      'https://a.example/page',
      'https://d.example/ref',
    ]);
    expect(sources.news.map((source) => source.link)).toEqual(['https://news.example/b']);
    expect(sources.images.map((image) => image.imageUrl)).toEqual(['https://img.example/c.jpg']);
    expect(sources.files).toEqual([]);
    expect(hasSessionSources(sources)).toBe(true);
  });

  it('deduplicates links and images across messages, keeping the first occurrence', () => {
    const attachmentData = {
      organic: [{ title: 'First', link: 'https://a.example/page' }],
      images: [{ imageUrl: 'https://img.example/c.jpg' }],
    };
    const sources = aggregateSessionSources([
      message([webSearchAttachment(attachmentData)]),
      message([
        webSearchAttachment({
          organic: [{ title: 'Second', link: 'https://a.example/page' }],
          images: [{ imageUrl: 'https://img.example/c.jpg' }],
        }),
      ]),
    ]);

    expect(sources.links).toHaveLength(1);
    expect(sources.links[0].title).toBe('First');
    expect(sources.images).toHaveLength(1);
  });

  it('routes image and file references to their groups', () => {
    const sources = aggregateSessionSources([
      message([
        webSearchAttachment({
          references: [
            { title: 'Pic', link: 'https://img.example/pic.jpg', type: 'image' },
            {
              title: 'Doc.pdf',
              link: '#file-file-1',
              type: 'file',
              fileId: 'file-1',
              pages: [2, 4],
            },
          ],
        }),
      ]),
    ]);

    expect(sources.images.map((image) => image.imageUrl)).toEqual(['https://img.example/pic.jpg']);
    expect(sources.files).toHaveLength(1);
    expect(sources.files[0]).toMatchObject({
      file_id: 'file-1',
      filename: 'Doc.pdf',
      pages: [2, 4],
      messageId,
      toolCallId: 'call-1',
    });
  });

  it('merges pages of the same cited file across turns', () => {
    const sources = aggregateSessionSources([
      message([
        webSearchAttachment({
          references: [
            { title: 'Doc.pdf', link: '#file-file-1', type: 'file', fileId: 'file-1', pages: [4] },
          ],
        }),
        fileSearchAttachment([{ fileId: 'file-1', fileName: 'Doc.pdf', pages: [1, 2] }]),
      ]),
    ]);

    expect(sources.files).toHaveLength(1);
    expect(sources.files[0].pages).toEqual([1, 2, 4]);
  });

  it('collects agent file-search sources', () => {
    const sources = aggregateSessionSources([
      message([
        fileSearchAttachment([
          { fileId: 'file-9', fileName: 'Report.pdf', bytes: 2048, pages: [3, 5] },
        ]),
      ]),
    ]);

    expect(sources.links).toEqual([]);
    expect(sources.files).toHaveLength(1);
    expect(sources.files[0]).toMatchObject({
      file_id: 'file-9',
      filename: 'Report.pdf',
      bytes: 2048,
      pages: [3, 5],
    });
  });

  it('includes still-streaming attachments the message cache has not saved', () => {
    const saved = message([]);
    const live = webSearchAttachment({
      organic: [{ title: 'Live result', link: 'https://live.example/x' }],
    });
    const sources = aggregateSessionSources([saved], [live]);

    expect(sources.links.map((source) => source.link)).toEqual(['https://live.example/x']);
  });

  it("live attachment selection takes only the conversation's own", () => {
    const own = webSearchAttachment({
      organic: [{ title: 'Mine', link: 'https://mine.example/x' }],
    });
    const foreign = webSearchAttachment({
      organic: [{ title: 'Other convo', link: 'https://other.example/x' }],
    });
    const selected = liveAttachmentsForConversation(
      {
        'message-1': [own],
        'message-2': [{ ...foreign, conversationId: Constants.PENDING_CONVO } as TAttachment],
        'message-3': undefined,
      },
      conversationId,
    );

    expect(selected).toEqual([own]);
  });
});
