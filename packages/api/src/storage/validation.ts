export function assertPathSegment(
  label: string,
  value: string | null | undefined,
  errorPrefix = 'path segment',
): string {
  const segment = value?.toString?.() ?? '';

  if (!segment) {
    throw new Error(`[${errorPrefix}] ${label} must not be empty`);
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw new Error(`[${errorPrefix}] ${label} must not contain slashes: "${segment}"`);
  }
  if (segment === '.' || segment === '..') {
    throw new Error(`[${errorPrefix}] ${label} must not contain path traversal: "${segment}"`);
  }
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new Error(`[${errorPrefix}] ${label} contains unsafe path characters: "${segment}"`);
    }
  }

  return segment;
}

export function assertS3FileName(
  label: string,
  value: string | null | undefined,
  errorPrefix = 'S3 key',
): string {
  const fileName = value?.toString?.() ?? '';

  if (!fileName) {
    throw new Error(`[${errorPrefix}] ${label} must not be empty`);
  }
  if (fileName.includes('\\')) {
    throw new Error(`[${errorPrefix}] ${label} must not contain backslashes: "${fileName}"`);
  }
  for (let i = 0; i < fileName.length; i++) {
    const code = fileName.charCodeAt(i);
    if (code <= 31 || code === 127) {
      throw new Error(`[${errorPrefix}] ${label} contains unsafe path characters: "${fileName}"`);
    }
  }

  const components = fileName.split('/');
  for (const component of components) {
    if (!component) {
      throw new Error(`[${errorPrefix}] ${label} must not contain empty path components`);
    }
    if (component === '.' || component === '..') {
      throw new Error(`[${errorPrefix}] ${label} must not contain path traversal: "${fileName}"`);
    }
  }

  return fileName;
}

export function sanitizeContentDispositionFilename(filename: string): string {
  let sanitized = '';
  for (const character of filename) {
    const code = character.charCodeAt(0);
    if (
      character === '"' ||
      character === '\\' ||
      character === ';' ||
      code <= 31 ||
      code === 127
    ) {
      continue;
    }
    sanitized += character;
  }
  return sanitized || 'download';
}
