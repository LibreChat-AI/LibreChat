import { excelMimeTypes } from 'librechat-data-provider';

export type CodeArtifactCategory = 'utf8-text' | 'document' | 'presentation' | 'other';

const UTF8_TEXT_EXTENSIONS = new Set<string>([
  // plaintext / data
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'log',
  'html',
  'htm',
  'svg',
  'env',
  // shell / scripts
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  // web
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  // popular languages
  'py',
  'pyi',
  'ipynb',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'scala',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'm',
  'mm',
  'swift',
  'php',
  'pl',
  'pm',
  'r',
  'jl',
  'lua',
  'dart',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'cljs',
  'fs',
  'fsx',
  // data / build / config
  'sql',
  'graphql',
  'gql',
  'proto',
  'dockerfile',
  'makefile',
  'gradle',
  'tf',
  'hcl',
  'patch',
  'diff',
  // diagrams
  'mmd',
  'mermaid',
]);

const UTF8_TEXT_MIME_PREFIXES = ['text/'] as const;
const UTF8_TEXT_MIME_EXACT = new Set<string>([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/x-httpd-php',
  'application/sql',
  'application/graphql',
  'image/svg+xml',
]);

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const POTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.template';

const DOCUMENT_EXTENSIONS = new Set<string>(['docx', 'odt', 'xlsx', 'xls', 'ods']);
const PRESENTATION_EXTENSIONS = new Set<string>(['pptx', 'potx']);

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
};

/**
 * Lookup key for extensionless filenames (Makefile, Dockerfile, etc.).
 * Matches against the same UTF8_TEXT_EXTENSIONS set so familiar bare names
 * still get inline text rendering.
 */
const bareNameOf = (name: string): string => {
  if (name.includes('.')) {
    return '';
  }
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return name.slice(slash + 1).toLowerCase();
};

const isUtf8TextMime = (mime: string): boolean => {
  if (UTF8_TEXT_MIME_EXACT.has(mime)) {
    return true;
  }
  for (const prefix of UTF8_TEXT_MIME_PREFIXES) {
    if (mime.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};

const isDocumentMime = (mime: string): boolean => {
  if (mime === DOCX_MIME || mime === ODT_MIME) {
    return true;
  }
  return excelMimeTypes.test(mime) || mime === 'application/vnd.oasis.opendocument.spreadsheet';
};

/**
 * Decide how to render a file produced by the code-execution sandbox.
 * Extension wins over MIME for code/text files because content sniffing tends
 * to label `.py`/`.json`/`.csv` as `application/octet-stream`.
 */
export function classifyCodeArtifact(name: string, mimeType: string): CodeArtifactCategory {
  const ext = extensionOf(name);
  if (ext && UTF8_TEXT_EXTENSIONS.has(ext)) {
    return 'utf8-text';
  }
  if (ext && DOCUMENT_EXTENSIONS.has(ext)) {
    return 'document';
  }
  if (ext && PRESENTATION_EXTENSIONS.has(ext)) {
    return 'presentation';
  }
  const bare = bareNameOf(name);
  if (bare && UTF8_TEXT_EXTENSIONS.has(bare)) {
    return 'utf8-text';
  }
  if (isUtf8TextMime(mimeType)) {
    return 'utf8-text';
  }
  if (isDocumentMime(mimeType)) {
    return 'document';
  }
  if (mimeType === PPTX_MIME || mimeType === POTX_MIME) {
    return 'presentation';
  }
  return 'other';
}
