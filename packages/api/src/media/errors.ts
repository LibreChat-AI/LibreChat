import type { MediaErrorCode, MediaProviderDiagnostic } from 'librechat-data-provider';

export class MediaServiceError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MediaServiceError';
  }
}

export class MediaProviderError extends Error {
  /**
   * The reason is safe for logs. The diagnostic is separately sanitized for the owning user;
   * neither the Error message nor its cause contains the raw provider response.
   */
  constructor(
    public readonly certainty: 'rejected' | 'uncertain',
    public readonly status?: number,
    public readonly reason?: string,
    public readonly diagnostic?: MediaProviderDiagnostic | undefined,
  ) {
    super('The media provider request could not be completed.');
    this.name = 'MediaProviderError';
    Object.defineProperty(this, 'diagnostic', { value: diagnostic, enumerable: false });
  }
}
