/** Returns true when `id` is a 24-character hex string (MongoDB ObjectId format). */
export const isValidObjectIdString = (id: string): boolean => /^[a-f\d]{24}$/i.test(id);

/**
 * Returns true when `id` is an ObjectId exactly as `ObjectId#toString()` writes it: 24 lowercase
 * hex characters. Ids stored as strings (config `principalId`s) are matched by string equality,
 * so an uppercase spelling of a real id names a document no lookup will ever find.
 */
export const isCanonicalObjectIdString = (id: string): boolean => /^[a-f\d]{24}$/.test(id);
