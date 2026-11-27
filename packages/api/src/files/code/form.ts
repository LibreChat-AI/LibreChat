import * as path from 'path';

import type FormData from 'form-data';

export interface CodeEnvFileOptions {
  filename: string;
  filepath?: string;
}

const CODE_ENV_SAFE_ASCII_FILEPATH_CHAR_PATTERN = /^[a-zA-Z0-9._\-/]$/;
const CODE_ENV_UNSAFE_UNICODE_FILEPATH_CHAR_PATTERN = /[^\p{L}\p{M}\p{N}\p{Emoji}\u200d._\-/]/u;

function hasUnsafeCodeEnvFilepathChar(filepath: string): boolean {
  for (const char of filepath) {
    if (char.charCodeAt(0) <= 0x7f) {
      if (!CODE_ENV_SAFE_ASCII_FILEPATH_CHAR_PATTERN.test(char)) {
        return true;
      }
      continue;
    }

    if (CODE_ENV_UNSAFE_UNICODE_FILEPATH_CHAR_PATTERN.test(char)) {
      return true;
    }
  }

  return false;
}

function isSafeCodeEnvFilepath(filepath: string): boolean {
  if (!filepath || filepath.startsWith('/') || hasUnsafeCodeEnvFilepathChar(filepath)) {
    return false;
  }

  const segments = filepath.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function getCodeEnvBasename(filepath: string): string {
  const basename = getSafeCodeEnvFilename(path.posix.basename(filepath));

  if (!basename || basename === '.' || basename === '..') {
    return 'file';
  }

  return basename;
}

function getSafeCodeEnvFilename(filename: string): string {
  return Array.from(filename, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? '_' : char;
  }).join('');
}

/**
 * Uses `filepath` for nested names because `form-data` strips directories from
 * the bare string filename overload before codeapi can preserve safe paths.
 */
export function getCodeEnvFileOptions(filename: string): CodeEnvFileOptions {
  const normalized = filename.replace(/\\/g, '/');
  const basename = getCodeEnvBasename(normalized);

  if (normalized === filename && filename === basename) {
    return { filename: getSafeCodeEnvFilename(filename) };
  }

  if (!isSafeCodeEnvFilepath(normalized)) {
    return { filename: basename };
  }

  return { filename: basename, filepath: normalized };
}

/** The destination encoded by the multipart adapter, including its safe-path fallback. */
export function getCodeEnvUploadFilename(filename: string): string {
  const options = getCodeEnvFileOptions(filename);
  return options.filepath ?? options.filename;
}

/** Older upload strategies may omit the receipt name; use their shared multipart normalization. */
export function getUploadedCodeEnvFilename(
  uploaded: { filename?: string },
  requestedFilename: string,
): string {
  return uploaded.filename || getCodeEnvUploadFilename(requestedFilename);
}

export function appendCodeEnvFile(
  form: FormData,
  stream: NodeJS.ReadableStream,
  filename: string,
): void {
  form.append('file', stream, getCodeEnvFileOptions(filename));
}
