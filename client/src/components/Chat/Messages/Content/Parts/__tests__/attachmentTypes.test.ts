import type { TAttachment } from 'librechat-data-provider';
import { artifactTypeForAttachment } from '../attachmentTypes';
import { TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';

const baseAttachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    file_id: 'file-1',
    filename: 'unset',
    filepath: '/files/file-1',
    type: 'application/octet-stream',
    ...overrides,
  }) as TAttachment;

describe('artifactTypeForAttachment branching', () => {
  it('returns the mermaid type for .mmd files', () => {
    const attachment = baseAttachment({
      filename: 'flow.mmd',
      text: 'graph TD\nA-->B',
    } as Partial<TAttachment>);
    expect(artifactTypeForAttachment(attachment)).toBe(TOOL_ARTIFACT_TYPES.MERMAID);
  });

  it.each([
    ['index.html', TOOL_ARTIFACT_TYPES.HTML],
    ['App.tsx', TOOL_ARTIFACT_TYPES.REACT],
    ['notes.md', TOOL_ARTIFACT_TYPES.MARKDOWN],
  ])('returns the panel type for %s (not mermaid)', (filename, expected) => {
    const attachment = baseAttachment({
      filename,
      text: 'content',
    } as Partial<TAttachment>);
    const type = artifactTypeForAttachment(attachment);
    expect(type).toBe(expected);
    expect(type).not.toBe(TOOL_ARTIFACT_TYPES.MERMAID);
  });

  it('returns null when there is no text', () => {
    expect(artifactTypeForAttachment(baseAttachment({ filename: 'index.html' }))).toBeNull();
  });

  it.each([
    ['site.htm', TOOL_ARTIFACT_TYPES.HTML],
    ['App.jsx', TOOL_ARTIFACT_TYPES.REACT],
    ['readme.markdown', TOOL_ARTIFACT_TYPES.MARKDOWN],
    ['flow.mermaid', TOOL_ARTIFACT_TYPES.MERMAID],
  ])('classifies %s as %s', (filename, expected) => {
    const attachment = baseAttachment({
      filename,
      text: 'content',
    } as Partial<TAttachment>);
    expect(artifactTypeForAttachment(attachment)).toBe(expected);
  });

  it('falls back to the HTML type when the extension is missing', () => {
    const attachment = baseAttachment({
      filename: 'noext',
      type: 'text/html',
      text: 'content',
    } as unknown as Partial<TAttachment>);
    expect(artifactTypeForAttachment(attachment)).toBe(TOOL_ARTIFACT_TYPES.HTML);
  });

  it('returns null for a file with no preview pipeline', () => {
    const attachment = baseAttachment({
      filename: 'photo.jpg',
      text: undefined,
    });
    expect(artifactTypeForAttachment(attachment)).toBeNull();
  });
});
