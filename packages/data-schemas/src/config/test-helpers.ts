/**
 * Character reads a call makes. Every scan loop in `email.ts` reads the text through `charCodeAt`
 * or `codePointAt`, so counting them measures how the work grows with the input without a
 * wall-clock budget, which coverage, mutation runs and loaded hosts exceed.
 */
export function reads(run: () => unknown): number {
  const { charCodeAt, codePointAt } = String.prototype;
  let count = 0;
  String.prototype.charCodeAt = function (this: string, index: number): number {
    count++;
    return charCodeAt.call(this, index);
  };
  String.prototype.codePointAt = function (this: string, index: number): number | undefined {
    count++;
    return codePointAt.call(this, index);
  };
  try {
    run();
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    String.prototype.codePointAt = codePointAt;
  }
  return count;
}

/**
 * Reads per input character that a linear scan stays under. The adversarial floods in the specs
 * peak near 10; a scan that rereads up to its cap, or grows with the input, needs hundreds.
 */
export const READS_PER_CHAR = 24;
