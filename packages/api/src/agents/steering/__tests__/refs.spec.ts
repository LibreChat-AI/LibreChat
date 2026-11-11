import { MAX_FILE_TEXT_PREVIEW_LENGTH } from 'librechat-data-provider';
import { toSteerFileRef } from '../refs';

describe('toSteerFileRef', () => {
  it('copies a bounded preview without trimming source whitespace', () => {
    const textPreview = ` \n${'x'.repeat(MAX_FILE_TEXT_PREVIEW_LENGTH)}\t`;
    expect(toSteerFileRef({ file_id: 'paste-1', textPreview })).toEqual({
      file_id: 'paste-1',
      textPreview: textPreview.slice(0, MAX_FILE_TEXT_PREVIEW_LENGTH),
    });
  });

  it('never derives a preview or model text from an untrusted text field', () => {
    expect(
      toSteerFileRef({ file_id: 'paste-1', type: 'text/plain', text: 'untrusted model text' }),
    ).toEqual({
      file_id: 'paste-1',
      type: 'text/plain',
    });
    expect(
      toSteerFileRef({
        file_id: 'paste-1',
        text: 'untrusted model text',
        textPreview: 'display only',
      }),
    ).toEqual({
      file_id: 'paste-1',
      textPreview: 'display only',
    });
  });

  it('keeps empty previews and drops malformed previews', () => {
    expect(toSteerFileRef({ file_id: 'paste-1', textPreview: '' })).toEqual({
      file_id: 'paste-1',
      textPreview: '',
    });
    expect(toSteerFileRef({ file_id: 'paste-1', textPreview: 42 })).toEqual({ file_id: 'paste-1' });
  });
});
