import type { TAttachment } from 'librechat-data-provider';
import {
  artifactTypeForAttachment,
  attachmentSalience,
  displayFilename,
  isImageAttachment,
  isInternalSandboxArtifact,
  isTextAttachment,
} from '../attachmentTypes';
import { TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';

const baseAttachment = (overrides: Partial<TAttachment> = {}): TAttachment =>
  ({
    file_id: 'file-1',
    filename: 'unset',
    filepath: '/files/file-1',
    type: 'application/octet-stream',
    ...overrides,
  }) as TAttachment;

describe('isImageAttachment', () => {
  it('returns true for image filenames with width, height, and filepath', () => {
    const attachment = baseAttachment({
      filename: 'chart.png',
      width: 800,
      height: 600,
      filepath: '/files/chart.png',
    } as Partial<TAttachment>);
    expect(isImageAttachment(attachment)).toBe(true);
  });

  it('returns false when filename is missing', () => {
    const attachment = baseAttachment({ filename: undefined as unknown as string });
    expect(isImageAttachment(attachment)).toBe(false);
  });

  it('returns false for non-image extensions', () => {
    const attachment = baseAttachment({
      filename: 'notes.txt',
      width: 800,
      height: 600,
    } as Partial<TAttachment>);
    expect(isImageAttachment(attachment)).toBe(false);
  });

  it('returns false when width is missing', () => {
    const attachment = baseAttachment({
      filename: 'chart.png',
      height: 600,
    } as Partial<TAttachment>);
    expect(isImageAttachment(attachment)).toBe(false);
  });

  it('returns false when height is missing', () => {
    const attachment = baseAttachment({
      filename: 'chart.png',
      width: 800,
    } as Partial<TAttachment>);
    expect(isImageAttachment(attachment)).toBe(false);
  });

  it('returns false when filepath is null', () => {
    const attachment = baseAttachment({
      filename: 'chart.png',
      width: 800,
      height: 600,
      filepath: null as unknown as string,
    } as Partial<TAttachment>);
    expect(isImageAttachment(attachment)).toBe(false);
  });
});

describe('isTextAttachment', () => {
  it('returns true when text is a non-empty string', () => {
    const attachment = baseAttachment({
      filename: 'output.csv',
      text: 'a,b,c\n1,2,3',
    } as Partial<TAttachment>);
    expect(isTextAttachment(attachment)).toBe(true);
  });

  it('returns false when text is missing', () => {
    expect(isTextAttachment(baseAttachment({ filename: 'output.csv' }))).toBe(false);
  });

  it('returns false when text is an empty string', () => {
    const attachment = baseAttachment({
      filename: 'empty.txt',
      text: '',
    } as Partial<TAttachment>);
    expect(isTextAttachment(attachment)).toBe(false);
  });

  it('returns false when text is non-string (e.g. null)', () => {
    const attachment = baseAttachment({
      filename: 'broken.txt',
      text: null as unknown as string,
    } as Partial<TAttachment>);
    expect(isTextAttachment(attachment)).toBe(false);
  });
});

describe('artifactTypeForAttachment', () => {
  it.each([
    ['index.html', 'text/html'],
    ['site.htm', 'text/html'],
    ['App.jsx', 'application/vnd.react'],
    ['App.tsx', 'application/vnd.react'],
    ['notes.md', 'text/markdown'],
    ['readme.markdown', 'text/markdown'],
    ['flow.mmd', 'application/vnd.mermaid'],
    ['flow.mermaid', 'application/vnd.mermaid'],
  ])('classifies %s as %s', (filename, expected) => {
    const attachment = baseAttachment({
      filename,
      text: 'content',
    } as Partial<TAttachment>);
    expect(artifactTypeForAttachment(attachment)).toBe(expected);
  });

  it('falls back to MIME for HTML when extension is missing', () => {
    const attachment = baseAttachment({
      filename: 'noext',
      type: 'text/html',
      text: 'content',
    } as unknown as Partial<TAttachment>);
    expect(artifactTypeForAttachment(attachment)).toBe('text/html');
  });

  it('returns null when there is no text content', () => {
    const attachment = baseAttachment({ filename: 'index.html' });
    expect(artifactTypeForAttachment(attachment)).toBeNull();
  });

  it('returns null for unsupported extensions', () => {
    /* CSV / DOCX / XLSX / PPTX now route through the office preview
     * buckets (rich HTML preview); use a binary type with no preview
     * pipeline instead. */
    const attachment = baseAttachment({
      filename: 'photo.jpg',
      text: undefined,
    });
    expect(artifactTypeForAttachment(attachment)).toBeNull();
  });
});

describe('isInternalSandboxArtifact', () => {
  it('matches the post-sanitization `.dirkeep` form', () => {
    // The backend renames `.dirkeep` → `_.dirkeep-<hash>` via
    // `sanitizeArtifactPath`'s collision-avoidance suffix.
    const attachment = baseAttachment({
      filename: 'test_folder/_.dirkeep-88b30b',
      bytes: 0,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(true);
  });

  it('matches a `.gitkeep` placeholder in its post-sanitization form', () => {
    const attachment = baseAttachment({
      filename: 'subdir/_.gitkeep-deadbe',
      bytes: 0,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(true);
  });

  it('does NOT match a bare `.dirkeep` (likely user-uploaded scaffolding)', () => {
    /** A bare `.dirkeep` never originates from the sandbox — the dotfile
     * rewrite + disambiguator step in `sanitizeArtifactPath` always
     * produces `_.dirkeep-<6 hex>`. Treat the bare form as user content
     * (e.g. a checked-in directory marker) and let it render. */
    const attachment = baseAttachment({
      filename: '.dirkeep',
      bytes: 0,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(false);
  });

  it('does NOT match a bare `.gitkeep` (the canonical project-scaffolding marker)', () => {
    const attachment = baseAttachment({
      filename: 'src/components/.gitkeep',
      bytes: 0,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(false);
  });

  it('does NOT match a non-empty file even if its leaf matches the sanitized form', () => {
    // Defense in depth: bytes > 0 means the user actually wrote
    // content, so don't hide it regardless of name.
    const attachment = baseAttachment({
      filename: '_.dirkeep-88b30b',
      bytes: 12,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(false);
  });

  it('does NOT match a regular file', () => {
    const attachment = baseAttachment({
      filename: 'test_folder/test_file.txt',
      bytes: 47,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(false);
  });

  it('does NOT match an empty user file with a normal name', () => {
    const attachment = baseAttachment({
      filename: 'empty.md',
      bytes: 0,
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(false);
  });

  it('does NOT match when bytes is undefined (size unknown ≠ empty)', () => {
    /** Non-code-exec attachment sources can omit `bytes` entirely. The
     * filter only fires for an *explicit* zero-byte placeholder so we
     * don't accidentally hide files we don't have size info for. */
    const attachment = baseAttachment({
      filename: '_.dirkeep-88b30b',
    } as Partial<TAttachment>);
    expect(isInternalSandboxArtifact(attachment)).toBe(false);
  });
});

describe('displayFilename', () => {
  it('strips suffix + restores leading dot for an extensionless sandbox dotfile', () => {
    expect(displayFilename('test_folder/_.dirkeep-88b30b')).toBe('test_folder/.dirkeep');
  });

  it('strips suffix + restores leading dot for a sanitized dotfile that has an extension', () => {
    expect(displayFilename('_.config-abcdef.txt')).toBe('.config.txt');
  });

  it('preserves directory components on the dotfile path', () => {
    expect(displayFilename('a/b/_.config-abcdef')).toBe('a/b/.config');
  });

  it('leaves a non-suffixed filename unchanged', () => {
    expect(displayFilename('test_file.txt')).toBe('test_file.txt');
  });

  it('leaves a user-named `_foo.txt` alone (no false-positive de-mangling)', () => {
    // No collision suffix → don't drop the underscore. A user-named
    // `_foo.txt` is real content, not sanitized.
    expect(displayFilename('_foo.txt')).toBe('_foo.txt');
  });

  it('handles undefined / empty input', () => {
    expect(displayFilename(undefined)).toBe('');
    expect(displayFilename('')).toBe('');
  });

  it('does not strip a trailing hex-looking suffix that is actually part of the stem', () => {
    // 7 chars after the dash → not the canonical 6-char hash form.
    expect(displayFilename('build-1234567.log')).toBe('build-1234567.log');
  });

  it('preserves a non-dotfile filename whose stem ends in `-<6 hex>` (codex regression)', () => {
    /** The previous regex stripped any `-<6 hex>` immediately before an
     * extension regardless of context. That collapsed legitimate
     * user-named files like `report-deadbe.csv` and `report-beef01.csv`
     * onto the same chip label `report.csv`. Without a structural
     * discriminator (the leading `_.` we use for the dotfile case),
     * we deliberately leave non-dotfile names alone — uglier when the
     * file *was* sanitized, but never collapses distinct files. */
    expect(displayFilename('report-deadbe.csv')).toBe('report-deadbe.csv');
    expect(displayFilename('report-beef01.csv')).toBe('report-beef01.csv');
    // Same shape inside a directory.
    expect(displayFilename('out/output-deadbe.csv')).toBe('out/output-deadbe.csv');
  });

  it('preserves an extensionless leaf that ends in 6 hex chars', () => {
    /** No `_.` prefix → no match. User-named hash-tail artifacts pass
     * through unchanged. */
    expect(displayFilename('build-a1b2c3')).toBe('build-a1b2c3');
  });

  it('preserves an extensionless leaf with hex suffix inside a directory', () => {
    expect(displayFilename('out/blob-deadbe')).toBe('out/blob-deadbe');
  });

  it('preserves a sanitized non-dotfile (we cannot tell sanitized from user-named here)', () => {
    /** `report 1.csv` → backend sanitizes to `report_1-<hash>.csv`.
     * We can't tell this apart from a user who literally named their
     * file `report_1-abcdef.csv`, so we deliberately leave it alone.
     * Recovering it cleanly would require backend metadata. */
    expect(displayFilename('report_1-abcdef.csv')).toBe('report_1-abcdef.csv');
  });
});

describe('attachmentSalience', () => {
  it('returns 0 for non-empty content (sorts first)', () => {
    expect(attachmentSalience(baseAttachment({ bytes: 47 } as Partial<TAttachment>))).toBe(0);
  });

  it('returns 1 only for an explicit zero-byte entry (sinks last)', () => {
    expect(attachmentSalience(baseAttachment({ bytes: 0 } as Partial<TAttachment>))).toBe(1);
  });

  it('treats undefined `bytes` as neutral so non-code-exec sources do not silently sink', () => {
    /** Web-search results, uploaded files where the schema omits `bytes`,
     * etc. should keep their input order — only an explicit `bytes === 0`
     * counts as the empty-placeholder shape we want to demote. */
    expect(attachmentSalience(baseAttachment({}))).toBe(0);
  });

  it('produces a stable bucket sort when used as `(a,b) => salience(a) - salience(b)`', () => {
    const real = baseAttachment({
      bytes: 47,
      filename: 'test_file.txt',
    } as Partial<TAttachment>);
    const placeholder = baseAttachment({
      bytes: 0,
      filename: '_.dirkeep-88b30b',
    } as Partial<TAttachment>);
    const sorted = [placeholder, real].sort(
      (a, b) => attachmentSalience(a) - attachmentSalience(b),
    );
    expect(sorted[0]).toBe(real);
    expect(sorted[1]).toBe(placeholder);
  });
});

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
});
