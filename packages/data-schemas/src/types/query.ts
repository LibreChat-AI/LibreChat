/**
 * A criterion that matches a single value or any one of several.
 *
 * Storage-agnostic on purpose: it is part of the domain query vocabulary, not
 * of any engine's filter language.
 */
export type OneOrMany<T> = T | T[];
