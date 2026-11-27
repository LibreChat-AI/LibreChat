/** Whether two lists hold the same items in the same order, compared by identity. */
export function sameItems<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) {
      return false;
    }
  }
  return true;
}

/** Whether two sets hold the same members. */
export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const member of a) {
    if (!b.has(member)) {
      return false;
    }
  }
  return true;
}

/** Whether two maps hold the same keys with the same values; `same` compares the values. */
export function sameMap<K, V>(
  a: ReadonlyMap<K, V>,
  b: ReadonlyMap<K, V>,
  same: (left: V, right: V) => boolean = Object.is,
): boolean {
  if (a === b) {
    return true;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (!b.has(key) || !same(value, b.get(key) as V)) {
      return false;
    }
  }
  return true;
}
