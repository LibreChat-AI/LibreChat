import { FileSources } from 'librechat-data-provider';
import {
  getPreviewKind,
  isExtractedTextPreviewLoading,
  shouldUseExtractedTextPreview,
  shouldUseSharedFileDownload,
} from '../preview';
import { getDownloadFilename } from '~/utils/downloadFile';

describe('FilePreviewDialog text-source behavior', () => {
  it('previews extracted PDF content as text', () => {
    expect(getPreviewKind('report.pdf', 'application/pdf', FileSources.text)).toBe('text');
  });

  it('downloads extracted content with a text extension', () => {
    expect(getDownloadFilename('report.pdf', 'file-1', FileSources.text)).toBe('report.pdf.txt');
    expect(getDownloadFilename('notes.txt', 'file-2', FileSources.text)).toBe('notes.txt');
  });

  it('preserves the original behavior for stored files', () => {
    expect(getPreviewKind('report.pdf', 'application/pdf', FileSources.local)).toBe('pdf');
    expect(getDownloadFilename('report.pdf', 'file-3', FileSources.local)).toBe('report.pdf');
  });

  it('uses stored extracted text when the delivery path is text', () => {
    expect(shouldUseExtractedTextPreview('text')).toBe(true);
    expect(shouldUseExtractedTextPreview('provider')).toBe(false);
    expect(shouldUseExtractedTextPreview(undefined)).toBe(false);
  });

  it('stops showing a pending preview as loading when polling fails', () => {
    expect(isExtractedTextPreviewLoading('pending', false, true)).toBe(false);
    expect(isExtractedTextPreviewLoading('pending', false, false)).toBe(true);
  });

  it('routes any identified file through the share boundary in a shared view', () => {
    expect(shouldUseSharedFileDownload('share-1', 'file-1')).toBe(true);
    expect(shouldUseSharedFileDownload('share-1', undefined)).toBe(false);
    expect(shouldUseSharedFileDownload(undefined, 'file-1')).toBe(false);
  });
});
