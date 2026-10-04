import type { TranslationKeys } from '~/hooks';

/** Localization keys for the sanitized English messages the import routes
 * return, shared by the upload response and a job's final `error`. */
export const IMPORT_ERROR_KEYS: Record<string, TranslationKeys> = {
  'Unsupported import type': 'com_ui_import_conversation_file_type_error',
  'The uploaded archive exceeds the allowed size limits':
    'com_ui_import_conversation_archive_too_large',
  'This JSON file is too large to import on its own. Compress it into a .zip and upload that instead':
    'com_ui_import_conversation_json_too_large',
  'The uploaded archive is corrupt or could not be read':
    'com_ui_import_conversation_archive_corrupt',
  'A storage error occurred while processing the import':
    'com_ui_import_conversation_storage_error',
  'The import could not be completed': 'com_ui_import_conversation_failed',
};
