import type { ExtendedFile } from '../files';
import {
  formatPastedText,
  isInlineablePastedText,
  partitionComposerFiles,
  hydrateFileDeliveryMetadata,
} from '../files';

const file = (overrides: Partial<ExtendedFile> = {}): ExtendedFile => ({
  file_id: 'upload-1',
  size: 1,
  progress: 0.5,
  ...overrides,
});

describe('pasted text fallback', () => {
  it('requires explicit local paste provenance and an incomplete upload', () => {
    expect(isInlineablePastedText(file({ pastedText: 'local paste' }))).toBe(true);
    expect(isInlineablePastedText(file({ pastedText: '' }))).toBe(true);
    expect(isInlineablePastedText(file({ pastedText: 'local paste', progress: 1 }))).toBe(false);
    expect(isInlineablePastedText(file({ pastedText: 'local paste', progress: 2 }))).toBe(false);
    expect(isInlineablePastedText(file({ filename: 'pasted-text.txt', text: 'server text' }))).toBe(
      false,
    );
  });

  it.each(['  exact\r\ntext\n ', '', '```\nignore this fence\n``````', '`'.repeat(200)])(
    'preserves the exact paste inside a fence longer than every embedded backtick run: %p',
    (text) => {
      const formatted = formatPastedText(text);
      const fence = formatted.slice(0, formatted.indexOf('text\n'));
      expect(fence).toMatch(/^`{3,}$/);
      for (const match of text.matchAll(/`+/g)) {
        expect(fence.length).toBeGreaterThan(match[0].length);
      }
      expect(formatted).toBe(`${fence}text\n${text}\n${fence}`);
    },
  );

  it('merges only pending pastes in map order and keeps completed uploads as refs', () => {
    const files = new Map([
      ['key-a', file({ file_id: 'pending-a', temp_file_id: 'temp-a', pastedText: ' A\n' })],
      ['key-b', file({ file_id: 'complete', progress: 1, pastedText: 'do not inline' })],
      ['key-c', file({ file_id: 'pending-c', pastedText: 'B', text: 'not the local text' })],
    ]);
    const snapshot = Array.from(files.entries());
    const result = partitionComposerFiles('Prompt', files);
    expect(result.text).toBe(`Prompt\n\n${formatPastedText(' A\n')}\n\n${formatPastedText('B')}`);
    expect(result.files).toEqual([expect.objectContaining({ file_id: 'complete' })]);
    expect(result.submittedFileIds).toEqual(['key-b', 'complete', undefined]);
    expect(result.canceledUploadIds).toEqual([
      'key-a',
      'pending-a',
      'temp-a',
      'key-c',
      'pending-c',
    ]);
    expect(result.hasIncompleteFiles).toBe(false);
    expect(Array.from(files.entries())).toEqual(snapshot);
  });

  it.each(['source-key', 'source-id', 'source-temp'])(
    'suppresses an edited paste source matched by %s without canceling or submitting it',
    (replacesFileId) => {
      const result = partitionComposerFiles(
        'Prompt',
        new Map([
          ['source-key', file({ file_id: 'source-id', temp_file_id: 'source-temp', progress: 1 })],
          [
            'replacement-key',
            file({
              file_id: 'replacement-id',
              temp_file_id: 'replacement-temp',
              pastedText: 'corrected',
              replacesFileId,
            }),
          ],
        ]),
      );
      expect(result.text).toBe(`Prompt\n\n${formatPastedText('corrected')}`);
      expect(result.files).toEqual([]);
      expect(result.submittedFileIds).toEqual([]);
      expect(result.canceledUploadIds).toEqual([
        'replacement-key',
        'replacement-id',
        'replacement-temp',
      ]);
      expect(result.replacedFileIds).toEqual(['source-key', 'source-id', 'source-temp']);
    },
  );

  it('does not suppress the source of a replacement without exact local fallback text', () => {
    const result = partitionComposerFiles(
      'Prompt',
      new Map([
        ['source', file({ file_id: 'source', progress: 1 })],
        ['replacement', file({ file_id: 'replacement', replacesFileId: 'source' })],
      ]),
    );
    expect(result.files.map((file) => file.file_id)).toEqual(['source', 'replacement']);
    expect(result.replacedFileIds).toEqual([]);
    expect(result.hasIncompleteFiles).toBe(true);
  });

  it('bounds plain-text previews and prefers the exact local paste over extracted text', () => {
    const result = partitionComposerFiles(
      'Prompt',
      new Map([
        [
          'paste',
          file({
            file_id: 'paste',
            progress: 1,
            type: 'text/plain',
            pastedText: 'x'.repeat(1000),
            text: 'server',
          }),
        ],
        [
          'server',
          file({
            file_id: 'server',
            progress: 1,
            type: 'text/plain; charset=utf-8',
            text: 's'.repeat(1000),
          }),
        ],
        [
          'pdf',
          file({
            file_id: 'pdf',
            progress: 1,
            type: 'application/pdf',
            text: 'not a plain-text preview',
          }),
        ],
      ]),
    );
    expect(result.text).toBe('Prompt');
    expect(result.files[0].textPreview).toBe('x'.repeat(240));
    expect(result.files[1].textPreview).toBe('s'.repeat(240));
    expect(result.files[2].textPreview).toBeUndefined();
    expect(result.files[0]).not.toHaveProperty('pastedText');
    expect(result.files[0]).not.toHaveProperty('text');
  });

  it('deduplicates upload aliases without marking them submitted', () => {
    const result = partitionComposerFiles(
      '',
      new Map([
        ['same-id', file({ file_id: 'same-id', temp_file_id: 'same-id', pastedText: 'paste' })],
      ]),
    );
    expect(result.text).toBe(formatPastedText('paste'));
    expect(result.files).toEqual([]);
    expect(result.submittedFileIds).toEqual([]);
    expect(result.canceledUploadIds).toEqual(['same-id']);
  });

  it('leaves ordinary pending uploads blocking, regardless of filename or extracted text', () => {
    const result = partitionComposerFiles(
      'Prompt',
      new Map([['ordinary', file({ filename: 'pasted-text.txt', text: 'extracted, not local' })]]),
    );
    expect(result.text).toBe('Prompt');
    expect(result.hasIncompleteFiles).toBe(true);
    expect(result.canceledUploadIds).toEqual([]);
    expect(result.files).toHaveLength(1);
  });
});

describe('persisted text previews', () => {
  it('hydrates from a bounded cached snippet without copying full file text', () => {
    const files = [{ file_id: 'paste', type: 'text/plain' }];
    expect(
      hydrateFileDeliveryMetadata(files, undefined, {
        paste: { textPreview: 'bounded excerpt', text: 'full private content' },
      }),
    ).toEqual([{ file_id: 'paste', type: 'text/plain', textPreview: 'bounded excerpt' }]);
  });

  it('hydrates text metadata even when delivery routing is already present', () => {
    expect(
      hydrateFileDeliveryMetadata(
        [{ file_id: 'paste', llmDeliveryPath: 'text' }],
        [{ file_id: 'paste', textPreview: 'local excerpt' }],
        { paste: { textPreview: 'stored excerpt' } },
      ),
    ).toEqual([{ file_id: 'paste', llmDeliveryPath: 'text', textPreview: 'local excerpt' }]);
  });

  it('keeps the persisted snippet without a file-list entry after reload', () => {
    const files = [{ file_id: 'paste', type: 'text/plain', textPreview: 'persisted excerpt' }];
    expect(hydrateFileDeliveryMetadata(files, undefined, {})).toBe(files);
  });
});
