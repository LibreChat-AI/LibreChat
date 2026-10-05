import {
  sanitizeFilename,
  sanitizeArtifactPath,
  flattenArtifactPath,
  resolveUploadErrorMessage,
} from './files';
import { UnsupportedProviderAudioError } from '~/files/upload/errors';
import { ConcurrencyLimitError } from './promise';

jest.mock('node:crypto', () => {
  const actualModule = jest.requireActual('node:crypto');
  return {
    ...actualModule,
    randomBytes: jest.fn().mockReturnValue(Buffer.from('abc123', 'hex')),
  };
});

/* `sanitizeArtifactPath` and `flattenArtifactPath` use `crypto.createHash`
 * (real, not mocked) to produce a deterministic 6-hex disambiguator from
 * the input. Tests compute the expected hash inline so we can compare
 * exact strings without re-mocking. */
function expectedHexSuffix(input: string): string {
  const { createHash } = jest.requireActual('node:crypto');
  return createHash('sha256').update(input).digest('hex').slice(0, 6);
}

function utf8ByteLength(input: string): number {
  return Buffer.byteLength(input, 'utf8');
}

describe('sanitizeFilename', () => {
  test('removes directory components (1/2)', () => {
    expect(sanitizeFilename('/path/to/file.txt')).toBe('file.txt');
  });

  test('removes directory components (2/2)', () => {
    expect(sanitizeFilename('../../../../file.txt')).toBe('file.txt');
  });

  test('replaces non-alphanumeric characters', () => {
    expect(sanitizeFilename('file name@#$.txt')).toBe('file_name___.txt');
  });

  test('preserves Unicode filenames', () => {
    expect(sanitizeFilename('日本語レポート.xlsx')).toBe('日本語レポート.xlsx');
    expect(sanitizeFilename('résumé-данные-تقرير-보고서📊.csv')).toBe(
      'résumé-данные-تقرير-보고서📊.csv',
    );
  });

  test('normalizes decomposed Unicode marks before sanitizing', () => {
    expect(sanitizeFilename('Cafe\u0301.txt')).toBe('Café.txt');
  });

  test('preserves dots and hyphens', () => {
    expect(sanitizeFilename('file-name.with.dots.txt')).toBe('file-name.with.dots.txt');
  });

  test('prepends underscore to filenames starting with a dot', () => {
    expect(sanitizeFilename('.hiddenfile')).toBe('_.hiddenfile');
  });

  test('truncates long filenames', () => {
    const longName = 'a'.repeat(300) + '.txt';
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(255);
    expect(result).toMatch(/^a+-abc123\.txt$/);
  });

  test('truncates Unicode filenames by UTF-8 bytes, preserving the extension', () => {
    const longName = '界'.repeat(100) + '.txt';
    const result = sanitizeFilename(longName);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    expect(result.endsWith('-abc123.txt')).toBe(true);
  });

  test('handles filenames with no extension', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeFilename(longName);
    expect(result.length).toBe(255);
    expect(result).toMatch(/^a+-abc123$/);
  });

  test('handles empty input', () => {
    expect(sanitizeFilename('')).toBe('_');
  });

  test('handles input with only special characters', () => {
    expect(sanitizeFilename('@#$%^&*')).toBe('_______');
  });
});

describe('sanitizeArtifactPath', () => {
  test('preserves a single nested directory component', () => {
    expect(sanitizeArtifactPath('test_folder/test_file.txt')).toBe('test_folder/test_file.txt');
  });

  test('preserves multiple nested directory components', () => {
    expect(sanitizeArtifactPath('a/b/c/file.txt')).toBe('a/b/c/file.txt');
  });

  test('preserves Unicode path segments', () => {
    expect(sanitizeArtifactPath('分析/結果📊.csv')).toBe('分析/結果📊.csv');
  });

  test('replaces non-alphanumeric characters per segment + adds raw-input disambiguator', () => {
    /* Different raw inputs that sanitize to the same form (`out 1.csv`
     * vs `out_1.csv`, `out@1.csv` vs `out#1.csv`) would otherwise share
     * a `claimCodeFile` compound key and silently overwrite each other.
     * When character-level sanitization changed something, we embed a
     * deterministic SHA-256 prefix of the raw input in the leaf so
     * different raw inputs produce different safe forms. Same raw
     * input is still idempotent. */
    const raw = 'proj name/file@v1.txt';
    expect(sanitizeArtifactPath(raw)).toBe(`proj_name/file_v1-${expectedHexSuffix(raw)}.txt`);
  });

  test('falls back to basename for parent traversal', () => {
    expect(sanitizeArtifactPath('../escape.txt')).toBe('escape.txt');
  });

  test('resolves embedded parent traversal via path normalization (with disambiguator)', () => {
    /* `path.posix.normalize('a/../escape.txt')` collapses to `escape.txt`,
     * which then passes the traversal guard and goes through the normal
     * segment-split path. Because normalization mutated the input
     * (raw had `a/../`, safe form doesn't), the disambiguator fires —
     * raw `a/../escape.txt` and raw `escape.txt` would otherwise both
     * resolve to `escape.txt` and collide on `claimCodeFile`. */
    const raw = 'a/../escape.txt';
    expect(sanitizeArtifactPath(raw)).toBe(`escape-${expectedHexSuffix(raw)}.txt`);
  });

  test('falls back to basename for absolute paths', () => {
    expect(sanitizeArtifactPath('/abs/path.txt')).toBe('path.txt');
  });

  test('collapses redundant separators (with disambiguator)', () => {
    /* `dir//file.txt` and `dir/file.txt` would both resolve to
     * `dir/file.txt` without disambiguation — collision on
     * `claimCodeFile`. The empty-segment collapse counts as
     * mutation, so the disambiguator fires for the doubled-slash
     * variant and the clean one passes through unchanged. */
    const raw = 'dir//file.txt';
    expect(sanitizeArtifactPath(raw)).toBe(`dir/file-${expectedHexSuffix(raw)}.txt`);
  });

  test('strips current-directory segments (with disambiguator)', () => {
    const raw = './dir/./file.txt';
    expect(sanitizeArtifactPath(raw)).toBe(`dir/file-${expectedHexSuffix(raw)}.txt`);
  });

  test('prepends underscore on dotfile leaf and disambiguates against literal _.x', () => {
    /* `.hidden` and `_.hidden` both resolve to `_.hidden` without
     * disambiguation. The dotfile-prefix step counts as mutation, so
     * `.hidden` → `_.hidden-<hash>` and the literal `_.hidden` passes
     * through. The disambiguator appends at the end (rather than
     * splitting `_.hidden` into stem + extension) because `dot <= 1`. */
    const raw = 'dir/.hidden';
    expect(sanitizeArtifactPath(raw)).toBe(`dir/_.hidden-${expectedHexSuffix(raw)}`);
  });

  test('returns underscore for empty input', () => {
    expect(sanitizeArtifactPath('')).toBe('_');
  });

  test('caps the leaf segment at 255 chars with extension-preserving truncation', () => {
    /* Regression for the unbounded-leaf path: without the per-segment
     * cap, a 300-char artifact name would flow through to saveBuffer's
     * storage key (`${file_id}__${flatName}`) and trip ENAMETOOLONG on
     * filesystems that enforce NAME_MAX. */
    const longName = 'a'.repeat(300) + '.txt';
    const result = sanitizeArtifactPath(longName);
    expect(result.length).toBe(255);
    expect(result).toMatch(new RegExp(`^a+-${expectedHexSuffix(longName)}\\.txt$`));
  });

  test('caps Unicode leaf segments at 255 UTF-8 bytes with extension-preserving truncation', () => {
    const longName = '界'.repeat(100) + '.txt';
    const result = sanitizeArtifactPath(longName);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    expect(result.endsWith(`-${expectedHexSuffix(longName)}.txt`)).toBe(true);
  });

  test('caps the leaf when nested under a directory, preserving the directory verbatim', () => {
    const longLeaf = 'b'.repeat(300) + '.csv';
    const result = sanitizeArtifactPath(`reports/${longLeaf}`);
    const [dir, leaf] = result.split('/');
    expect(dir).toBe('reports');
    expect(leaf.length).toBe(255);
    expect(leaf).toMatch(new RegExp(`^b+-${expectedHexSuffix(longLeaf)}\\.csv$`));
  });

  test('caps non-leaf directory segments at 255 chars', () => {
    /* Directory components hit `NAME_MAX` independently of the leaf —
     * each `mkdir` along the path has to satisfy the per-component limit
     * regardless of the basename truncation. */
    const longDir = 'd'.repeat(300);
    const result = sanitizeArtifactPath(`${longDir}/notes.txt`);
    const [dir, leaf] = result.split('/');
    expect(dir.length).toBe(255);
    expect(dir).toMatch(new RegExp(`^d+-${expectedHexSuffix(longDir)}$`));
    expect(leaf).toBe('notes.txt');
  });

  test('caps Unicode non-leaf directory segments at 255 UTF-8 bytes', () => {
    const longDir = '界'.repeat(100);
    const result = sanitizeArtifactPath(`${longDir}/notes.txt`);
    const [dir, leaf] = result.split('/');
    expect(utf8ByteLength(dir)).toBeLessThanOrEqual(255);
    expect(dir.endsWith(`-${expectedHexSuffix(longDir)}`)).toBe(true);
    expect(leaf).toBe('notes.txt');
  });

  test('produces deterministic output across calls (no orphaned uploads on re-truncation)', () => {
    /* Codex review P2: `sanitizeFilename`'s `crypto.randomBytes(3)` made
     * the truncated form non-deterministic — re-uploading the same long
     * name would compute a different storage key, orphaning the previous
     * on-disk file under the reused `file_id`. The new helpers hash the
     * input so the same input always produces the same output. */
    const longName = 'a'.repeat(300) + '.txt';
    const a = sanitizeArtifactPath(longName);
    const b = sanitizeArtifactPath(longName);
    expect(a).toBe(b);
    /* Two *different* long names that share a truncation prefix must
     * still produce different outputs (collision avoidance). */
    const otherName = 'a'.repeat(299) + 'X.txt';
    expect(sanitizeArtifactPath(otherName)).not.toBe(a);
  });

  test('caps every segment in a nested path with mixed lengths', () => {
    /* Every segment respects the cap — the truncate is per-component,
     * not on the join. Use 2 segments here (rather than 3+) so the
     * joined form stays under `ARTIFACT_PATH_TOTAL_MAX` (512); the
     * total-cap fallback gets its own test below. */
    const segA = 'x'.repeat(260);
    const leaf = 'z'.repeat(260) + '.json';
    const result = sanitizeArtifactPath(`${segA}/${leaf}`);
    const parts = result.split('/');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBe(255);
    expect(parts[1].length).toBe(255);
    expect(parts[1]).toMatch(/\.json$/);
  });

  test('does not truncate filenames that are exactly at the 255-char limit', () => {
    /* Off-by-one guard: 255 itself is allowed (filesystem boundary), 256
     * is not. */
    const exact = 'e'.repeat(251) + '.txt'; // 255 chars total
    expect(sanitizeArtifactPath(exact)).toBe(exact);
    expect(sanitizeArtifactPath(`dir/${exact}`)).toBe(`dir/${exact}`);
  });

  test('falls back to leaf-only when total path length exceeds the DB-index cap (Codex review P2)', () => {
    /* MongoDB 4.0 rejects indexed values past 1024 bytes, and even on
     * 4.2+ where the limit is configurable, runaway nested paths bloat
     * the unique compound index on (file_id, filename, conversationId,
     * context). At 3+ at-cap (255-char) segments + separators the joined
     * form blows past the safety budget; the helper falls back to leaf-
     * only (already segment-capped to ≤ 255). */
    const segA = 'x'.repeat(255);
    const segB = 'y'.repeat(255);
    const segC = 'z'.repeat(255);
    const result = sanitizeArtifactPath(`${segA}/${segB}/${segC}/file.txt`);
    /* Joined would be ~768 chars + slashes; well past the 512 cap. */
    expect(result).toBe('file.txt');
  });

  test('falls back to leaf-only when Unicode path bytes exceed the DB-index cap', () => {
    const segA = '界'.repeat(80);
    const segB = '分'.repeat(80);
    const segC = '析'.repeat(80);
    const result = sanitizeArtifactPath(`${segA}/${segB}/${segC}/file.txt`);
    expect(result).toBe('file.txt');
  });

  test('keeps the nested path when total length is within the DB-index cap', () => {
    /* The cap doesn't fire for realistic outputs — typical artifact
     * depth is ≤ 3 segments × short names. */
    const result = sanitizeArtifactPath('reports/2026/q1.csv');
    expect(result).toBe('reports/2026/q1.csv');
  });

  describe('collision avoidance (Codex review P2)', () => {
    /* `sanitizeArtifactPath` is not injective — multiple raw inputs can
     * collapse to the same regex-and-normalize output. `claimCodeFile`
     * is keyed on the schema's compound unique
     * `(filename, conversationId, context, tenantId)` index, so a
     * collision would silently overwrite an earlier artifact's bytes
     * via a reused `file_id`. The disambiguator branch embeds a
     * SHA-256 prefix of the raw input in the leaf to keep different
     * raw inputs distinct. */
    test('different raw inputs that sanitize to the same form get distinct safe forms', () => {
      const a = sanitizeArtifactPath('out 1.csv');
      const b = sanitizeArtifactPath('out_1.csv');
      const c = sanitizeArtifactPath('out@1.csv');
      const d = sanitizeArtifactPath('out#1.csv');
      /* Pre-fix all four collapsed to `out_1.csv`. Post-fix only the
       * already-clean `out_1.csv` keeps that form; the others get
       * disambiguators based on their raw inputs. */
      expect(b).toBe('out_1.csv');
      expect(a).not.toBe(b);
      expect(c).not.toBe(b);
      expect(d).not.toBe(b);
      expect(a).not.toBe(c);
      expect(c).not.toBe(d);
    });

    test('whitespace-vs-underscore collision in directory segment', () => {
      /* Codex's specific example: `reports 2026/out.csv` and
       * `reports_2026/out.csv` would both have safeName
       * `reports_2026/out.csv` without disambiguation. */
      const a = sanitizeArtifactPath('reports 2026/out.csv');
      const b = sanitizeArtifactPath('reports_2026/out.csv');
      expect(b).toBe('reports_2026/out.csv');
      expect(a).not.toBe(b);
      /* The disambiguator is on the LEAF (not the mutated dir
       * segment) so the layout matches normal path-preserving
       * outputs. */
      expect(a.startsWith('reports_2026/out-')).toBe(true);
      expect(a.endsWith('.csv')).toBe(true);
    });

    test('dotfile prefix collision: `.x` vs `_.x`', () => {
      const a = sanitizeArtifactPath('.hidden');
      const b = sanitizeArtifactPath('_.hidden');
      expect(b).toBe('_.hidden');
      expect(a).not.toBe(b);
      expect(a).toBe(`_.hidden-${expectedHexSuffix('.hidden')}`);
    });

    test('normalization-only collisions get distinct safe forms', () => {
      const composed = 'reports/Café.csv';
      const decomposed = 'reports/Cafe\u0301.csv';
      const normalizedDecomposed = `reports/Café-${expectedHexSuffix(decomposed)}.csv`;

      expect(sanitizeArtifactPath(composed)).toBe(composed);
      expect(sanitizeArtifactPath(decomposed)).toBe(normalizedDecomposed);
      expect(normalizedDecomposed).not.toBe(composed);
    });

    test('idempotent: same raw input always produces the same safe form', () => {
      /* Disambiguator is deterministic (SHA-256 prefix of raw input),
       * so re-uploading the same long-or-mutated name lands at the
       * same storage key on every call. */
      const raw = 'proj name/data file.csv';
      expect(sanitizeArtifactPath(raw)).toBe(sanitizeArtifactPath(raw));
    });

    test('clean inputs (no mutation) skip the disambiguator', () => {
      /* Cosmetic: don't clutter human-readable filenames with a hash
       * when no collision is possible. The check is on the
       * post-regex form vs the raw input — when they match exactly,
       * the disambiguator branch doesn't fire. */
      expect(sanitizeArtifactPath('reports/2026/q1.csv')).toBe('reports/2026/q1.csv');
      expect(sanitizeArtifactPath('plain.txt')).toBe('plain.txt');
    });

    test('disambiguator survives leaf truncation (long mutated leaf)', () => {
      /* Long input + mutation: truncateLeafSegment caps at 255 first,
       * then embedDisambiguatorInLeaf re-trims to insert the input
       * hash. The seg-hash from the first truncation is replaced by
       * the input-hash from the second pass — that's intentional:
       * input-hash is the load-bearing collision-avoidance suffix. */
      const raw = 'data file ' + 'a'.repeat(280) + '.csv';
      const result = sanitizeArtifactPath(raw);
      expect(result.length).toBe(255);
      expect(result.endsWith(`-${expectedHexSuffix(raw)}.csv`)).toBe(true);
    });

    test('disambiguator survives total-cap fallback', () => {
      /* When joined > ARTIFACT_PATH_TOTAL_MAX, we fall back to the
       * leaf-only form. The leaf has already had the disambiguator
       * embedded, so the fallback preserves collision avoidance for
       * the pathological-depth case too. */
      const raw =
        'a b'.repeat(100) + '/' + 'c d'.repeat(100) + '/' + 'e f'.repeat(100) + '/file.csv';
      const result = sanitizeArtifactPath(raw);
      /* Result is leaf-only (no slashes). */
      expect(result.includes('/')).toBe(false);
      /* And carries the disambiguator. */
      expect(result.endsWith(`-${expectedHexSuffix(raw)}.csv`)).toBe(true);
    });
  });

  test('preserves the dotfile underscore prefix when the leaf also needs truncation', () => {
    /* A long hidden-file leaf (`._very_long_name`) goes through the
     * underscore-prefix branch first; truncation must run AFTER that
     * rewrite or the leaf would still leak past the cap. */
    const longHidden = '.' + 'a'.repeat(300);
    const result = sanitizeArtifactPath(`dir/${longHidden}`);
    const [dir, leaf] = result.split('/');
    expect(dir).toBe('dir');
    expect(leaf.length).toBe(255);
    expect(leaf.startsWith('_.')).toBe(true);
  });
});

describe('flattenArtifactPath', () => {
  test('joins path components with __ for storage keys', () => {
    expect(flattenArtifactPath('a/b/c.txt')).toBe('a__b__c.txt');
  });

  test('passes through paths with no separator', () => {
    expect(flattenArtifactPath('file.txt')).toBe('file.txt');
  });

  test('handles single-level nesting', () => {
    expect(flattenArtifactPath('test_folder/test_file.txt')).toBe('test_folder__test_file.txt');
  });

  test('passes through unchanged when no maxLength is supplied', () => {
    /* The cap is opt-in — callers that aren't building filesystem keys
     * (e.g. tests, log messages) shouldn't get truncation. */
    const longPath = 'a'.repeat(200) + '/' + 'b'.repeat(200) + '.txt';
    expect(flattenArtifactPath(longPath)).toBe(longPath.replace(/\//g, '__'));
  });

  test('passes through unchanged when flat form fits within maxLength', () => {
    expect(flattenArtifactPath('short/file.txt', 100)).toBe('short__file.txt');
    expect(flattenArtifactPath('short/file.txt', 15)).toBe('short__file.txt');
  });

  test('truncates flat form when it exceeds maxLength, preserving leaf extension', () => {
    /* Regression for the deep-nesting flat-key overflow path: three
     * 100-char segments → 308-char flat form that would blow past
     * NAME_MAX=255 once `${file_id}__` is prepended. The truncation
     * keeps the .ext on the leaf so download MIME inference still works. */
    const a = 'a'.repeat(100);
    const b = 'b'.repeat(100);
    const safePath = `${a}/${b}/c.txt`;
    const result = flattenArtifactPath(safePath, 200);
    expect(result.length).toBe(200);
    expect(result.endsWith('.txt')).toBe(true);
    expect(result).toMatch(new RegExp(`-${expectedHexSuffix(safePath)}\\.txt$`));
  });

  test('truncates Unicode flat forms by UTF-8 bytes', () => {
    const safePath = `${'界'.repeat(80)}/結果.csv`;
    const result = flattenArtifactPath(safePath, 100);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(100);
    expect(result.endsWith('.csv')).toBe(true);
    expect(result).toMatch(new RegExp(`-${expectedHexSuffix(safePath)}\\.csv$`));
  });

  test('preserves the extension even when only the leaf overflows', () => {
    const longLeaf = 'L'.repeat(300);
    const result = flattenArtifactPath(`${longLeaf}.json`, 200);
    expect(result.length).toBe(200);
    expect(result.endsWith('.json')).toBe(true);
  });

  test('falls back to whole-key truncation (no extension preservation) when ext is pathologically long', () => {
    /* `path.extname`-style logic: a single dot followed by 100 chars is
     * not a real extension. Keep the cap honored even if a contrived
     * input would yield a "stem budget" of zero or negative. */
    const result = flattenArtifactPath('stem.' + 'x'.repeat(100), 50);
    expect(result.length).toBe(50);
  });

  test('handles paths with no extension by truncating the stem', () => {
    const longName = 'n'.repeat(300);
    const result = flattenArtifactPath(longName, 50);
    expect(result.length).toBe(50);
    expect(result).toMatch(new RegExp(`-${expectedHexSuffix(longName)}$`));
  });

  test('matches the boundary length exactly when input is right at the cap', () => {
    /* Off-by-one guard: maxLength of N should allow flat forms of N. */
    const flat = 'a'.repeat(50);
    expect(flattenArtifactPath(flat, 50)).toBe(flat);
    expect(flattenArtifactPath(flat, 49).length).toBe(49);
  });

  test('produces deterministic output across calls (no orphaned uploads on re-flatten)', () => {
    /* Codex review P2: re-flattening the same input must produce the
     * same key so re-uploads land at the same storage location. The
     * hash-based suffix replaces the previous random one. */
    const longPath = 'a'.repeat(100) + '/b.csv';
    const a = flattenArtifactPath(longPath, 50);
    const b = flattenArtifactPath(longPath, 50);
    expect(a).toBe(b);
    /* And different inputs that share a truncation prefix still produce
     * different outputs (collision avoidance). */
    const otherPath = 'a'.repeat(100) + '/c.csv';
    expect(flattenArtifactPath(otherPath, 50)).not.toBe(a);
  });

  test('clamps the result to maxLength even when ext.length > maxLength - 7 (Codex review P2)', () => {
    /* Pathological maxLength: 5, ext: ".txt" (4 chars). Stem budget is
     * Math.max(0, 5 - 4 - 7) = 0, so the formula yields
     * `'' + '-' + 6-char-hash + '.txt'` = 11 chars — past maxLength.
     * The final clamp guarantees the result is ≤ maxLength regardless. */
    const result = flattenArtifactPath('foo/bar.txt', 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test('returns empty string when maxLength <= 0', () => {
    /* Edge case: a negative or zero budget can't fit any output. Don't
     * attempt to construct a key; let the caller handle the empty case
     * (in practice this never fires — `process.js` passes
     * `255 - file_id.length - 2`, and file_id is bounded). */
    expect(flattenArtifactPath('a/b.txt', 0)).toBe('');
    expect(flattenArtifactPath('a/b.txt', -5)).toBe('');
  });
});

describe('resolveUploadErrorMessage', () => {
  it.each([false, true])(
    'preserves the localized audio preflight error (redaction=%s)',
    (redact) => {
      expect(
        resolveUploadErrorMessage(new UnsupportedProviderAudioError(), undefined, redact),
      ).toBe('com_error_files_provider_audio_format');
    },
  );
  test('returns default message for null error', () => {
    expect(resolveUploadErrorMessage(null)).toBe('Error processing file');
  });

  test('returns default message for undefined error', () => {
    expect(resolveUploadErrorMessage(undefined)).toBe('Error processing file');
  });

  test('returns default message when error has no message property', () => {
    expect(resolveUploadErrorMessage({})).toBe('Error processing file');
  });

  test('returns default message for unrecognized error', () => {
    expect(resolveUploadErrorMessage({ message: 'ENOENT: no such file or directory' })).toBe(
      'Error processing file',
    );
  });

  test('preserves legacy file_ids error details by default', () => {
    expect(resolveUploadErrorMessage({ message: 'max file_ids reached' })).toBe(
      'Error processing file: max file_ids reached',
    );
  });

  test('maps file_ids errors to a fixed message when redaction is enabled', () => {
    const rawMessage = 'max file_ids reached for PRIVATE-UPLOAD';
    const result = resolveUploadErrorMessage({ message: rawMessage }, undefined, true);

    expect(result).toBe('Error processing file: File limit reached');
    expect(result).not.toContain('PRIVATE-UPLOAD');
  });

  test('preserves legacy "Invalid file format" details by default', () => {
    expect(resolveUploadErrorMessage({ message: 'Invalid file format: .xyz' })).toBe(
      'Invalid file format: .xyz',
    );
  });

  test('maps "Invalid file format" errors to a fixed message when redaction is enabled', () => {
    const result = resolveUploadErrorMessage(
      {
        message: 'Invalid file format: PRIVATE-UPLOAD.xyz',
      },
      undefined,
      true,
    );

    expect(result).toBe('Invalid file format');
    expect(result).not.toContain('PRIVATE-UPLOAD');
  });

  test('preserves legacy "exceeds token limit" details by default', () => {
    expect(resolveUploadErrorMessage({ message: 'Content exceeds token limit' })).toBe(
      'Content exceeds token limit',
    );
  });

  test('maps "exceeds token limit" errors to a fixed message when redaction is enabled', () => {
    const result = resolveUploadErrorMessage(
      {
        message: 'PRIVATE-UPLOAD content exceeds token limit',
      },
      undefined,
      true,
    );

    expect(result).toBe('File content exceeds token limit');
    expect(result).not.toContain('PRIVATE-UPLOAD');
  });

  test('preserves legacy "Unable to extract text from" details by default', () => {
    const msg = 'Unable to extract text from "doc.pdf". The document may be image-based.';
    expect(resolveUploadErrorMessage({ message: msg })).toBe(msg);
  });

  test('maps "Unable to extract text from" errors to a fixed message when redaction is enabled', () => {
    const result = resolveUploadErrorMessage(
      {
        message: 'Unable to extract text from "PRIVATE-UPLOAD.pdf". Provider response followed.',
      },
      undefined,
      true,
    );

    expect(result).toBe('Unable to extract text from file');
    expect(result).not.toContain('PRIVATE-UPLOAD');
  });

  /**
   * A refusal the caller can act on is worth surfacing; "Error processing file" tells
   * them to retry a document that will fail the same way, or not to retry one that
   * would have succeeded a moment later.
   */
  test('surfaces the shed-load refusal, which is retryable', () => {
    const limit = new ConcurrencyLimitError(
      'Too many document parsing requests are already waiting (2 running, 6 queued).',
    );

    expect(resolveUploadErrorMessage(limit)).toBe(limit.message);
    expect(limit.userErrorStatusCode).toBe(503);
  });

  /**
   * Each of these is permanent for the document that caused it: the caller has to send a
   * smaller or different one, and "Error processing file" invites them to retry the
   * same bytes instead. Matched on the code, so rewording a message cannot quietly turn
   * one back into a generic failure.
   */
  test.each([
    ['an oversized parser input', 'PARSER_INPUT_LIMIT', 'report.docx exceeds the 15MB limit'],
    ['an oversized extraction', 'PARSER_OUTPUT_LIMIT', 'anydoc extracted 22MB of text'],
    ['a refused archive', 'ARCHIVE_INVALID', 'report.docx: archive could not be read safely'],
    ['a zip bomb', 'ZIP_BOMB', 'evil.docx: entry count (9000) exceeds the 4096-entry cap'],
    [
      'a page-flooded PDF',
      'PDF_PAGE_LIMIT',
      'PDF contains 4000 pages, exceeding the 1000-page limit',
    ],
  ])('surfaces %s', (_label, code, message) => {
    expect(resolveUploadErrorMessage({ message, code })).toBe(message);
  });

  test('redacts document details from coded refusals when requested', () => {
    const result = resolveUploadErrorMessage(
      {
        code: 'ARCHIVE_INVALID',
        message: 'PRIVATE-UPLOAD.docx: archive could not be read safely',
      },
      undefined,
      true,
    );

    expect(result).toBe('Archive could not be read safely');
    expect(result).not.toContain('PRIVATE-UPLOAD');
  });

  test('redacts an oversized parser input to its stable client message', () => {
    const result = resolveUploadErrorMessage(
      {
        code: 'PARSER_INPUT_LIMIT',
        message: 'PRIVATE-UPLOAD.docx exceeds the 15MB parser limit',
      },
      undefined,
      true,
    );

    expect(result).toBe('Document exceeds the supported file size limit');
    expect(result).not.toContain('PRIVATE-UPLOAD');
  });

  test('still hides an untagged internal failure', () => {
    expect(resolveUploadErrorMessage({ message: 'ECONNREFUSED 127.0.0.1:6379' })).toBe(
      'Error processing file',
    );
  });

  test('accepts a custom default message', () => {
    expect(resolveUploadErrorMessage(null, 'Custom default')).toBe('Custom default');
  });

  test('uses custom default in the legacy file_ids message', () => {
    expect(resolveUploadErrorMessage({ message: 'file_ids limit' }, 'Upload failed')).toBe(
      'Upload failed: file_ids limit',
    );
  });

  test('uses custom default in the redacted file_ids message', () => {
    expect(resolveUploadErrorMessage({ message: 'file_ids limit' }, 'Upload failed', true)).toBe(
      'Upload failed: File limit reached',
    );
  });
});

describe('sanitizeFilename with real crypto', () => {
  // Temporarily unmock crypto for these tests
  beforeAll(() => {
    jest.resetModules();
    jest.unmock('node:crypto');
  });

  afterAll(() => {
    jest.resetModules();
    jest.mock('node:crypto', () => {
      const actualModule = jest.requireActual('node:crypto');
      return {
        ...actualModule,
        randomBytes: jest.fn().mockReturnValue(Buffer.from('abc123', 'hex')),
      };
    });
  });

  test('truncates long filenames with real crypto', async () => {
    const { sanitizeFilename: realSanitizeFilename } = await import('./files');
    const longName = 'b'.repeat(300) + '.pdf';
    const result = realSanitizeFilename(longName);

    expect(result.length).toBe(255);
    expect(result).toMatch(/^b+-[a-f0-9]{6}\.pdf$/);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  test('handles filenames with no extension with real crypto', async () => {
    const { sanitizeFilename: realSanitizeFilename } = await import('./files');
    const longName = 'c'.repeat(300);
    const result = realSanitizeFilename(longName);

    expect(result.length).toBe(255);
    expect(result).toMatch(/^c+-[a-f0-9]{6}$/);
    expect(result).not.toContain('.');
  });

  test('generates unique suffixes for identical long filenames', async () => {
    const { sanitizeFilename: realSanitizeFilename } = await import('./files');
    const longName = 'd'.repeat(300) + '.doc';
    const result1 = realSanitizeFilename(longName);
    const result2 = realSanitizeFilename(longName);

    expect(result1.length).toBe(255);
    expect(result2.length).toBe(255);
    expect(result1).not.toBe(result2); // Should be different due to random suffix
    expect(result1.endsWith('.doc')).toBe(true);
    expect(result2.endsWith('.doc')).toBe(true);
  });

  test('real crypto produces valid hex strings', async () => {
    const { sanitizeFilename: realSanitizeFilename } = await import('./files');
    const longName = 'test'.repeat(100) + '.txt';
    const result = realSanitizeFilename(longName);

    const hexMatch = result.match(/-([a-f0-9]{6})\.txt$/);
    expect(hexMatch).toBeTruthy();
    expect(hexMatch![1]).toMatch(/^[a-f0-9]{6}$/);
  });
});
