/**
 * The thing an event is about, and the thing a conversation watches: in phase 1, a GitHub
 * pull request.
 *
 * A pull request is identified by GitHub's numeric repository id and its number, never by the
 * repository's name. The id survives a rename or a transfer, while a name does not, compares
 * without case, and can be claimed by a different repository once it is free. The name is
 * display text and travels beside the item, not inside it.
 */
export interface Item {
  provider: 'github';
  kind: 'pr';
  /** GitHub's numeric id of the repository the pull request was opened against. */
  repo: number;
  number: number;
}

const KEY = /^github:pr:([1-9]\d{0,15})#([1-9]\d{0,15})$/;

/** Ids and numbers are positive integers a JSON number carries exactly. */
export function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The stored form of an item, `github:pr:<repository id>#<number>`. It is unique within one
 * connection: repository ids are assigned per GitHub host.
 *
 * Throws on an item whose ids are not positive integers, because a key built from one would
 * not read back as the same item.
 */
export function itemKey(item: Item): string {
  if (!isId(item.repo) || !isId(item.number)) {
    throw new RangeError('An item key needs a positive repository id and number');
  }
  return `${item.provider}:${item.kind}:${item.repo}#${item.number}`;
}

/** The item a stored key names, or `null` when the text is not a key `itemKey` produces. */
export function parseItemKey(key: string): Item | null {
  const match = KEY.exec(key);
  if (match == null) {
    return null;
  }
  const repo = Number(match[1]);
  const number = Number(match[2]);
  if (!isId(repo) || !isId(number)) {
    return null;
  }
  return { provider: 'github', kind: 'pr', repo, number };
}
