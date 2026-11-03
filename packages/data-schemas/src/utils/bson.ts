/** MongoDB's physical document ceiling; reserve command and fixed metadata overhead. */
export const MAX_BSON_DOCUMENT_BYTES: number = 16 * 1024 * 1024;
export const BSON_WRITE_HEADROOM_BYTES: number = 64 * 1024;

export class ManagedDocumentTooLargeError extends Error {
  readonly code = 'document_limit';
  constructor() {
    super('The durable document exceeds its BSON storage budget');
    this.name = 'ManagedDocumentTooLargeError';
  }
}
