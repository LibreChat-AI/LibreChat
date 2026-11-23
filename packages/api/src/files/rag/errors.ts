export type RagEmbeddingFailureCode = 'RAG_EMBEDDING_REFUSED' | 'RAG_EMBEDDING_OUTCOME_UNKNOWN';

/** Only a validated no-side-effect receipt establishes a definitive refusal. */
export class RagEmbeddingError extends Error {
  readonly code: RagEmbeddingFailureCode;

  constructor(code: RagEmbeddingFailureCode) {
    super(
      code === 'RAG_EMBEDDING_REFUSED'
        ? 'File embedding was refused. You can retry or delete the file.'
        : 'File embedding was not confirmed.',
    );
    this.name = 'RagEmbeddingError';
    this.code = code;
  }
}
