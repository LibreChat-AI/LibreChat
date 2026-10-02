/**
 * The part of [x0, x1] that no blocked range covers, preferring the free stretch that contains
 * `near` (where Lia already stands) and otherwise the widest one. Returns null when nothing at
 * least `minWidth` wide is left.
 */
export function freeSpan(
  x0: number,
  x1: number,
  blocked: ReadonlyArray<readonly [number, number]>,
  near: number,
  minWidth = 0,
): readonly [number, number] | null {
  let spans: Array<[number, number]> = [[x0, x1]];
  for (const [b0, b1] of blocked) {
    const next: Array<[number, number]> = [];
    for (const [s0, s1] of spans) {
      if (b1 <= s0 || b0 >= s1) {
        next.push([s0, s1]);
        continue;
      }
      if (b0 > s0) {
        next.push([s0, b0]);
      }
      if (b1 < s1) {
        next.push([b1, s1]);
      }
    }
    spans = next;
  }
  const usable = spans.filter(([s0, s1]) => s1 - s0 >= minWidth);
  if (usable.length === 0) {
    return null;
  }
  const containing = usable.find(([s0, s1]) => near >= s0 && near <= s1);
  if (containing) {
    return containing;
  }
  return usable.reduce((best, span) => (span[1] - span[0] > best[1] - best[0] ? span : best));
}
