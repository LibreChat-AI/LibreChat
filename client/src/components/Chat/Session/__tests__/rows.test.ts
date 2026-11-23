import { FileContext, FileSources } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { collectFiles } from '../rows';

const message = (overrides: Partial<TMessage>): TMessage =>
  ({
    messageId: 'message',
    conversationId: 'convo',
    parentMessageId: null,
    isCreatedByUser: true,
    text: '',
    ...overrides,
  }) as TMessage;

describe('collectFiles', () => {
  it('says how the model receives each kind of upload', () => {
    const [search, code, text, image] = collectFiles([
      message({
        files: [
          { file_id: 'image', filename: 'shot.png', type: 'image/png', bytes: 2048 },
          { file_id: 'text', filename: 'notes.txt', source: FileSources.text },
          {
            file_id: 'code',
            filename: 'data.csv',
            llmDeliveryPath: 'none',
            metadata: { fileIdentifier: 'session/data.csv' },
          },
          { file_id: 'search', filename: 'manual.pdf', embedded: true },
        ],
      }),
    ]).reverse();

    expect(image).toMatchObject({ id: 'image', delivery: 'file', code: false, search: false });
    expect(image.bytes).toBe(2048);
    expect(text).toMatchObject({ delivery: 'text' });
    expect(code).toMatchObject({ delivery: 'none', code: true, search: false });
    expect(search).toMatchObject({ delivery: 'none', search: true, code: false });
  });

  it('keeps a file that is both sent to the model and placed in the code environment as both', () => {
    const [row] = collectFiles([
      message({
        files: [
          {
            file_id: 'both',
            filename: 'report.pdf',
            llmDeliveryPath: 'provider',
            metadata: { codeDestination: true },
          },
        ],
      }),
    ]);

    expect(row).toMatchObject({ delivery: 'file', code: true });
  });

  it('marks what the conversation produced, and reads files attached to a steer', () => {
    const rows = collectFiles([
      message({
        messageId: 'assistant',
        isCreatedByUser: false,
        attachments: [
          { file_id: 'chart', filename: 'chart.png', type: 'image/png' },
          { type: 'web_search' },
        ] as TMessage['attachments'],
        content: [
          { type: 'steer', steer: 'use this', files: [{ file_id: 'steered', filename: 's.txt' }] },
        ] as unknown as TMessage['content'],
      }),
      message({
        messageId: 'output',
        files: [{ file_id: 'out', filename: 'out.csv', context: FileContext.execute_code }],
      }),
    ]);

    expect(rows.map((row) => [row.id, row.made])).toEqual([
      ['out', true],
      ['chart', true],
      ['steered', false],
    ]);
  });

  it('lists a file a message refers to only from its content, such as a generated image', () => {
    const rows = collectFiles([
      message({
        messageId: 'assistant',
        isCreatedByUser: false,
        content: [
          { type: 'text', text: 'Here it is' },
          { type: 'image_file', image_file: { file_id: 'generated' } },
          { type: 'file', file: { file_id: 'block' } },
          { type: 'file', file_id: 'direct' },
        ] as unknown as TMessage['content'],
      }),
    ]);

    expect(rows.map((row) => [row.id, row.name, row.made, row.delivery])).toEqual([
      ['generated', '', true, 'file'],
      ['block', '', true, 'file'],
      ['direct', '', true, 'file'],
    ]);
    expect(rows[0].type).toBe('image/*');
  });

  it('prefers the message that stored a file over one that only points at it', () => {
    const rows = collectFiles([
      message({
        messageId: 'stored',
        files: [{ file_id: 'chart', filename: 'chart.png', type: 'image/png', bytes: 10 }],
      }),
      message({
        messageId: 'pointer',
        isCreatedByUser: false,
        content: [
          { type: 'image_file', image_file: { file_id: 'chart' } },
        ] as unknown as TMessage['content'],
      }),
      message({
        messageId: 'both',
        files: [{ file_id: 'photo', filename: 'photo.png' }],
        content: [
          { type: 'image_file', image_file: { file_id: 'photo' } },
        ] as unknown as TMessage['content'],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ['photo', 'photo.png'],
      ['chart', 'chart.png'],
    ]);
  });

  it('lists the newest first and a file named by several messages once', () => {
    const rows = collectFiles([
      message({ messageId: 'm1', files: [{ file_id: 'a', filename: 'a.txt' }] }),
      message({ messageId: 'm2', files: [{ file_id: 'b', filename: 'b.txt' }] }),
      message({
        messageId: 'm3',
        files: [
          { file_id: 'a', filename: 'a.txt' },
          { file_id: 'c', filename: 'c.txt' },
        ],
      }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not read a message again that it has already read', () => {
    const files = [{ file_id: 'a', filename: 'a.txt' }];
    const reads = jest.fn(() => files);
    const kept = message({ messageId: 'kept' });
    Object.defineProperty(kept, 'files', { get: reads });

    collectFiles([kept, message({ messageId: 'streaming-1' })]);
    collectFiles([kept, message({ messageId: 'streaming-2' })]);

    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('has nothing to list for a thread with no files or no messages', () => {
    expect(collectFiles([message({})])).toEqual([]);
    expect(collectFiles(undefined)).toEqual([]);
  });
});
