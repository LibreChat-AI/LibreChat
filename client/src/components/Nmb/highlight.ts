import type { TNmbFinding } from 'librechat-data-provider';

export type Piece = { text: string; finding?: TNmbFinding };

/** Findings on one segment, clipped to the text, ordered, and without overlaps (first wins). */
export function findingsForSegment(findings: TNmbFinding[], segment: string, length: number) {
  const out: TNmbFinding[] = [];
  let cursor = 0;
  const sorted = findings
    .filter((f) => f.location.segment === segment && f.action !== 'ALLOW')
    .filter(
      (f) =>
        f.location.start >= 0 && f.location.end > f.location.start && f.location.start < length,
    )
    .sort((a, b) => a.location.start - b.location.start || b.location.end - a.location.end);
  for (const f of sorted) {
    if (f.location.start < cursor) {
      continue;
    }
    out.push({ ...f, location: { ...f.location, end: Math.min(f.location.end, length) } });
    cursor = Math.min(f.location.end, length);
  }
  return out;
}

/** Splits a segment into plain text and highlighted finding spans. */
export function splitSegment(text: string, findings: TNmbFinding[], segment: string): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const f of findingsForSegment(findings, segment, text.length)) {
    if (f.location.start > cursor) {
      pieces.push({ text: text.slice(cursor, f.location.start) });
    }
    pieces.push({ text: text.slice(f.location.start, f.location.end), finding: f });
    cursor = f.location.end;
  }
  if (cursor < text.length) {
    pieces.push({ text: text.slice(cursor) });
  }
  return pieces;
}

/**
 * A preview of the masked text. Final placeholder numbers are assigned by the scanner on
 * approval, so this shows the entity type instead.
 */
export function maskPreview(text: string, findings: TNmbFinding[], segment: string): string {
  return splitSegment(text, findings, segment)
    .map((p) => (p.finding ? `<${p.finding.entity}>` : p.text))
    .join('');
}

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The original text a finding covers. */
export const findingValue = (
  finding: TNmbFinding,
  segments: Array<{ location: string; text: string }>,
): string => {
  const seg = segments.find((s) => s.location === finding.location.segment);
  return seg ? seg.text.slice(finding.location.start, finding.location.end) : '';
};
