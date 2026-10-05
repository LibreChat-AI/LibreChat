import path from 'path';
import { extractMarkdownIsolated } from './native';

describe('AnyDoc native isolation', () => {
  const fixture = (name: string) => path.join(__dirname, '..', 'documents', name);

  test('extracts Markdown through the child process', async () => {
    const markdown = await extractMarkdownIsolated(fixture('structured.docx'), 'docx');

    expect(markdown).toContain('# Quarterly Report');
    expect(markdown).toContain('| Region | Units | Revenue |');
  });

  test('a missing file rejects instead of leaving the caller hanging', async () => {
    await expect(extractMarkdownIsolated(fixture('does-not-exist.docx'), 'docx')).rejects.toThrow();
  });

  /**
   * The inflate caps bound decompression, not conversion: an archive well inside them
   * still converts to tens of megabytes of Markdown. Enforcing that only in the parent
   * would serialize every byte through IPC and rebuild it in the API process before
   * anything rejected it, twice over at the child cap. The refusal has to come from the
   * child, which is why this drives the real one rather than a stub.
   */
  test('refuses an extraction larger than the storage limit before returning it', async () => {
    await expect(extractMarkdownIsolated(fixture('bomb.docx'), 'docx')).rejects.toThrow(
      /over the 15MB limit/,
    );
  }, 60_000);
});
