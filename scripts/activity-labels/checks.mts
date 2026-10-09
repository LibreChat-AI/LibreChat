/**
 * Mechanical label checks. These catch format violations and the two
 * measurable prose failures (register collapse via first-word tallies,
 * cross-batch redundancy via content-word overlap); commit-log READABILITY
 * still needs the human pass over results/latest.md.
 */
import type { ToolEntry } from './types.mts';

const STOPWORDS = new Set<string>([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'with',
  'for',
  'in',
  'on',
  'at',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'as',
  'by',
  'from',
  'that',
  'this',
  'both',
  'all',
  'no',
  'not',
  'via',
]);

export function words(label: string): string[] {
  return label.trim().split(/\s+/).filter(Boolean);
}

const SUFFIXES = ['ations', 'ation', 'ence', 'ance', 'ings', 'ing', 'ed', 'es', 's'];

/** Crude suffix stemmer so persists/persistence/persisted collide — enough
 *  for overlap detection; linguistic correctness is not the goal. */
export function stem(word: string): string {
  if (word.length < 5) {
    return word;
  }
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

export function contentWords(label: string): string[] {
  return words(label.toLowerCase().replace(/[^a-z0-9/._-]+/g, ' '))
    .filter((word) => !STOPWORDS.has(word))
    .map(stem);
}

/** Payload tokens carry the informative delta between template-shaped
 *  labels: numbers, versions, paths, filenames. */
function isPayload(word: string): boolean {
  return /\d/.test(word) || word.includes('/') || word.includes('.');
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersection += 1;
    }
  }
  return intersection / (setA.size + setB.size - intersection);
}

const GENERIC_OPENER = /^(ran|used|executed|called|invoked|performed)\b/i;
const COUNT_ECHO = /\b\d+\s+(tools?|commands?|calls?)\b/i;
const DUP_THRESHOLD = 0.5;

/**
 * @param label generated label text
 * @param entries the batch's tool entries (for tool-name echo detection)
 * @param previousLabels labels generated EARLIER in the same case chain,
 *   regardless of whether the variant saw them — redundancy is measured
 *   uniformly so continuity variants can be compared against blind ones.
 */
interface CheckLabelOptions {
  entries?: readonly ToolEntry[];
  previousLabels?: readonly string[];
}

interface CheckLabelResult {
  flags: string[];
  wordCount: number;
  firstWord: string;
  maxOverlap: number;
}

export function checkLabel(
  label: string,
  { entries = [], previousLabels = [] }: CheckLabelOptions = {},
): CheckLabelResult {
  const flags: string[] = [];
  const wordList = words(label);
  if (wordList.length < 4 || wordList.length > 9) {
    flags.push(`len:${wordList.length}`);
  }
  if (/[.!?,;:]$/.test(label.trim())) {
    flags.push('punct');
  }
  if (/^["'`]|["'`]$/.test(label.trim())) {
    flags.push('quote');
  }
  if (/[*`]|^#|\[.*\]\(/.test(label)) {
    flags.push('md');
  }
  if (GENERIC_OPENER.test(label.trim())) {
    flags.push('opener');
  }
  const lower = label.toLowerCase();
  for (const entry of entries) {
    const name = entry.toolName.toLowerCase();
    if (name.length > 3 && (lower.includes(name) || lower.includes(name.replace(/_/g, ' ')))) {
      flags.push(`tool-echo:${entry.toolName}`);
      break;
    }
  }
  if (COUNT_ECHO.test(label)) {
    flags.push('count-echo');
  }
  /** Overlap splits into two flags: `restate` (high overlap, no payload
   *  delta — the line adds nothing over a previous header; the production
   *  2/3 and 7/8 failure) and `template` (high overlap but the differing
   *  tokens are numbers/paths — same sentence frame, new information, e.g.
   *  fib(1)→fib(2). Often fine, arguably better than synonym churn). */
  const own = contentWords(label);
  let maxOverlap = 0;
  let worst: string[] | null = null;
  for (const previous of previousLabels) {
    const other = contentWords(previous);
    const overlap = jaccard(own, other);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      worst = other;
    }
  }
  if (maxOverlap > DUP_THRESHOLD && worst != null) {
    const otherSet = new Set(worst);
    const ownSet = new Set(own);
    const differing = [
      ...own.filter((word) => !otherSet.has(word)),
      ...worst.filter((word) => !ownSet.has(word)),
    ];
    const informativeDelta = differing.some(isPayload);
    flags.push(`${informativeDelta ? 'template' : 'restate'}:${maxOverlap.toFixed(2)}`);
  }
  return { flags, wordCount: wordList.length, firstWord: wordList[0] ?? '', maxOverlap };
}
