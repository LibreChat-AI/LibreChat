import type { FullToolCall } from './previews';
import { getToolCallPreviewRevision, hasToolCallPreview } from './previews';

const preview = (overrides: Partial<FullToolCall> = {}): FullToolCall => ({
  id: 'call_1',
  name: 'bash_tool',
  args: '{"command":"make"}',
  output: 'stdout:\nfirst\n…\n[exit code: 0]',
  outputTruncated: true,
  outputLength: 40_000,
  previewRevision: '1700000000000',
  ...overrides,
});

describe('getToolCallPreviewRevision', () => {
  it('is stable for the same preview', () => {
    expect(getToolCallPreviewRevision(preview())).toBe(getToolCallPreviewRevision(preview()));
  });

  it('changes when the head changes even with the same length and tail', () => {
    const before = getToolCallPreviewRevision(preview());
    const after = getToolCallPreviewRevision(
      preview({ output: 'stdout:\nfirsT\n…\n[exit code: 0]' }),
    );
    expect(after).not.toBe(before);
  });

  it('changes when the stored message changes, even if the preview looks identical', () => {
    expect(getToolCallPreviewRevision(preview({ previewRevision: '1700000000001' }))).not.toBe(
      getToolCallPreviewRevision(preview()),
    );
  });

  it('changes with the arguments and with object arguments', () => {
    expect(getToolCallPreviewRevision(preview({ args: { command: 'make test' } }))).not.toBe(
      getToolCallPreviewRevision(preview({ args: { command: 'make' } })),
    );
  });
});

describe('hasToolCallPreview', () => {
  it('reads only the shortening markers', () => {
    expect(hasToolCallPreview(preview())).toBe(true);
    expect(hasToolCallPreview({ previewRevision: '1' })).toBe(false);
    expect(hasToolCallPreview(undefined)).toBe(false);
  });
});
