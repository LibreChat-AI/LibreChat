/** A direct audio attachment must be representable before the upload is persisted. */
export class UnsupportedProviderAudioError extends Error {
  readonly userErrorStatusCode = 415;

  constructor() {
    super('com_error_files_provider_audio_format');
    this.name = 'UnsupportedProviderAudioError';
  }
}
