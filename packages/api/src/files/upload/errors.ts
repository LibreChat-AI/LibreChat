/** A direct audio attachment must be representable before the upload is persisted. */
export class UnsupportedProviderAudioError extends Error {
  readonly userErrorStatusCode = 415;

  constructor() {
    super('com_error_files_provider_audio_format');
    this.name = 'UnsupportedProviderAudioError';
  }
}

/** Expected admission pressure, not a malformed document or an internal failure. */
export class SpreadsheetBusyError extends Error {
  readonly code = 'SPREADSHEET_BUSY';
  readonly userErrorStatusCode = 503;

  constructor() {
    super('Spreadsheet processing is busy; retry later.');
    this.name = 'SpreadsheetBusyError';
  }
}
