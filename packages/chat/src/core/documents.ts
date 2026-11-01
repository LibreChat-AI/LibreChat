/** Agents and assistants are keyed by document id, and a message's `model`
 *  carries that id rather than a model name, so neither prefix may reach the
 *  header. */
const DOCUMENT_ID_PREFIXES = ['agent_', 'asst_'];

/** An agent or assistant document id: a storage key, never a name to show. */
export const isDocumentId = (value: string): boolean =>
  DOCUMENT_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
