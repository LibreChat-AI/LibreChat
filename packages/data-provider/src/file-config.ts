import { z } from 'zod';
import type { EndpointFileConfig, FileConfig, RegexLike } from './types/files';
import type { ResponsesApiRouting } from './types';
import { EModelEndpoint, isAgentsEndpoint, isDocumentSupportedProvider } from './schemas';
import { normalizeEndpointName } from './utils';

/** Parallel storage deletions during rollback of a failed skill archive import. */
export const DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY = 8;

export const supportsFiles = {
  [EModelEndpoint.openAI]: true,
  [EModelEndpoint.google]: true,
  [EModelEndpoint.assistants]: true,
  [EModelEndpoint.azureAssistants]: true,
  [EModelEndpoint.agents]: true,
  [EModelEndpoint.azureOpenAI]: true,
  [EModelEndpoint.anthropic]: true,
  [EModelEndpoint.custom]: true,
  [EModelEndpoint.bedrock]: true,
};

export const excelFileTypes = [
  'application/vnd.ms-excel',
  'application/msexcel',
  'application/x-msexcel',
  'application/x-ms-excel',
  'application/x-excel',
  'application/x-dos_ms_excel',
  'application/xls',
  'application/x-xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const fullMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
  'text/css',
  'text/calendar',
  'text/vtt',
  'image/jpeg',
  'text/javascript',
  'image/gif',
  'image/png',
  'image/heic',
  'image/heif',
  'application/x-tar',
  'application/x-sh',
  'application/typescript',
  'application/sql',
  'application/yaml',
  'application/vnd.coffeescript',
  'application/xml',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-parquet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.graphics',
  'image/svg',
  'image/svg+xml',
  'message/rfc822',
  // Video formats
  'video/mp4',
  'video/avi',
  'video/mov',
  'video/wmv',
  'video/flv',
  'video/webm',
  'video/mkv',
  'video/m4v',
  'video/3gp',
  'video/ogv',
  // Audio formats
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/wma',
  'audio/opus',
  'audio/mpeg',
  ...excelFileTypes,
];

export const codeInterpreterMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
  'text/css',
  'text/calendar',
  'image/jpeg',
  'text/javascript',
  'image/gif',
  'image/png',
  'image/heic',
  'image/heif',
  'application/x-tar',
  'application/typescript',
  'application/xml',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-parquet',
  ...excelFileTypes,
];

export const retrievalMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
];

export const imageExtRegex = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i;

/** @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html */
export type BedrockDocumentFormat =
  | 'pdf'
  | 'csv'
  | 'doc'
  | 'docx'
  | 'xls'
  | 'xlsx'
  | 'html'
  | 'txt'
  | 'md';

/** Maps MIME types to Bedrock Converse API document format values */
export const bedrockDocumentFormats: Record<string, BedrockDocumentFormat> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/**
 * Whether an upload belongs to the conversation rather than to the agent. The value
 * arrives from multipart form data, so it can be the string "false", which is truthy.
 * Shared so the route, the authorization check and processing cannot disagree about it.
 */
export const isMessageFileUpload = (value?: boolean | string | null): boolean =>
  value === true || value === 'true';

/**
 * Whether the upload's conversation uses the Responses API, which decides whether Azure
 * can carry a document natively. Multipart form data has no booleans, so it arrives as
 * the string "true".
 */
export const isResponsesApiUpload = (value?: boolean | string | null): boolean =>
  value === true || value === 'true';

/**
 * The name a file carries inside the code sandbox.
 *
 * Image uploads are converted to the configured output type while the record keeps the
 * original filename, so the extension has to follow the stored bytes or the sandbox
 * decoder is handed a mismatch. Provisioning and priming both resolve the mount path
 * from here: deriving it twice under different rules leaves a later turn advertising a
 * path that does not exist in the sandbox.
 */
export const resolveSandboxFilename = (filename: string, mimeType?: string | null): string => {
  if (!mimeType?.startsWith('image/')) {
    return filename;
  }
  const subtype = mimeType.slice('image/'.length);
  if (!['webp', 'png', 'jpeg', 'gif'].includes(subtype)) {
    return filename;
  }
  const accepted = subtype === 'jpeg' ? ['.jpg', '.jpeg'] : [`.${subtype}`];
  const lastDot = filename.lastIndexOf('.');
  const currentExt = lastDot > 0 ? filename.slice(lastDot).toLowerCase() : '';
  if (accepted.includes(currentExt)) {
    return filename;
  }
  const base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return `${base}${accepted[0]}`;
};

/**
 * The Responses setting a turn actually runs on. A saved agent's own record wins, since
 * execution reads its model parameters; a conversation only answers for itself. Upload
 * and delivery must agree here, or a document is stored as raw provider content and then
 * re-resolved to text it has no extraction for.
 */
export const resolveUseResponsesApi = (
  agentValue?: boolean | null,
  conversationValue?: boolean | null,
): boolean | undefined => agentValue ?? conversationValue ?? undefined;

/** Models whose native OpenAI and Azure execution defaults to Responses. Keep
 * this shared with client upload routing so documents follow the API that the
 * backend will actually invoke. Explicit false remains an opt-out. */
export const prefersResponsesApiByModel = (model?: string | null): boolean =>
  typeof model === 'string' && /^gpt-6-(?:astra|sol|luna)(?:-|$)/i.test(model);

/** The server has transport and administrator settings the browser cannot see.
 * Missing policy never enables model-based uploads (including during upgrades). */
export const resolveEffectiveUseResponsesApi = ({
  value,
  endpoint,
  model,
  routing,
  webSearch,
}: {
  value?: boolean | null;
  endpoint?: string | null;
  model?: string | null;
  routing?: ResponsesApiRouting;
  webSearch?: boolean | null;
}): boolean | undefined => {
  if (endpoint !== EModelEndpoint.openAI && endpoint !== EModelEndpoint.azureOpenAI) {
    return value ?? undefined;
  }
  let policy = model ? routing?.[model] : undefined;
  if (!policy && model && prefersResponsesApiByModel(model)) {
    const family = /^gpt-6-(?:astra|sol|luna)(?=-|$)/i.exec(model)?.[0].toLowerCase();
    policy = family ? routing?.[`${family}-*`] : undefined;
  }
  policy ??= routing?.['*'];
  if (!policy) return value ?? undefined;
  if (webSearch && policy.withWebSearch) policy = policy.withWebSearch;
  if (value == null) return policy.default;
  return value ? policy.on : policy.off;
};

export const isBedrockDocumentType = (mimeType?: string): boolean =>
  mimeType != null && mimeType in bedrockDocumentFormats;

/** MIME types Bedrock's Converse document path can send to the model (mirrors `bedrockDocumentFormats`). */
export const bedrockDocumentMimeTypes: readonly string[] = Object.keys(bedrockDocumentFormats);

/** File extensions accepted by Bedrock document uploads (for input accept attributes) */
export const bedrockDocumentExtensions =
  '.pdf,.csv,.doc,.docx,.xls,.xlsx,.html,.htm,.txt,.md,application/pdf,text/csv,application/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html,text/plain,text/markdown';

/** Textual `application/*` MIME types that can be decoded and sent as plain text */
const textualApplicationTypes = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/sql',
  'application/typescript',
  'application/x-sh',
  'application/csv',
]);

/**
 * MIME types the Anthropic Messages API accepts as a plain-text document source
 * (`source.type: 'text'`)
 */
export const isAnthropicTextDocumentType = (mimeType?: string): boolean =>
  mimeType != null && (mimeType.startsWith('text/') || textualApplicationTypes.has(mimeType));

/**
 * MIME types the Anthropic Messages API document path can send to the model
 * (mirrors `isBedrockDocumentType`): PDF via base64, textual types via a
 * plain-text document source. All other types are rejected with a provider 400.
 */
export const isAnthropicDocumentType = (mimeType?: string): boolean =>
  mimeType === 'application/pdf' || isAnthropicTextDocumentType(mimeType);

export const excelMimeTypes =
  /^application\/(vnd\.ms-excel|msexcel|x-msexcel|x-ms-excel|x-excel|x-dos_ms_excel|xls|x-xls|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/;

export const textMimeTypes =
  /^(text\/(x-c|x-csharp|tab-separated-values|x-c\+\+|x-h|x-java|html|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|css|vtt|javascript|csv|xml|calendar))$/;

export const applicationMimeTypes =
  /^(application\/(epub\+zip|csv|json|msword|pdf|x-tar|x-sh|x-zip-compressed|typescript|sql|yaml|x-parquet|vnd\.apache\.parquet|vnd\.coffeescript|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.(presentation|template)|spreadsheetml\.sheet)|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)|xml|zip))$/;

export const imageMimeTypes = /^image\/(jpeg|gif|png|webp|heic|heif)$/;

export const audioMimeTypes =
  /^audio\/(mp3|mpeg|mpeg3|wav|wave|x-wav|ogg|vorbis|mp4|m4a|x-m4a|flac|x-flac|webm|aac|wma|opus)$/;

export const videoMimeTypes = /^video\/(mp4|avi|mov|wmv|flv|webm|mkv|m4v|3gp|ogv)$/;

export const defaultOCRMimeTypes = [
  imageMimeTypes,
  excelMimeTypes,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)$/,
  /^application\/vnd\.openxmlformats-officedocument\.presentationml\.template$/,
  /^application\/vnd\.ms-(word|powerpoint)$/,
  /^application\/epub\+zip$/,
  /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)$/,
];

/** MIME types handled by the built-in document parser (pdf, docx, excel variants, ods/odt) */
export const documentParserMimeTypes = [
  excelMimeTypes,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
  /^application\/vnd\.oasis\.opendocument\.spreadsheet$/,
  /^application\/vnd\.oasis\.opendocument\.text$/,
];

export const defaultTextMimeTypes = [/^[\w.-]+\/[\w.-]+$/];

export const defaultSTTMimeTypes = [audioMimeTypes];

export const supportedMimeTypes = [
  textMimeTypes,
  excelMimeTypes,
  applicationMimeTypes,
  imageMimeTypes,
  videoMimeTypes,
  audioMimeTypes,
  /** Supported by LC Code Interpreter API */
  /^image\/(svg|svg\+xml)$/,
  /** .eml email files */
  /^message\/rfc822$/,
];

export const codeInterpreterMimeTypes = [
  textMimeTypes,
  excelMimeTypes,
  applicationMimeTypes,
  imageMimeTypes,
];

export const codeTypeMapping: { [key: string]: string } = {
  c: 'text/x-c', // .c - C source
  cs: 'text/x-csharp', // .cs - C# source
  cpp: 'text/x-c++', // .cpp - C++ source
  h: 'text/x-h', // .h - C/C++ header
  md: 'text/markdown', // .md - Markdown
  php: 'text/x-php', // .php - PHP source
  py: 'text/x-python', // .py - Python source
  rb: 'text/x-ruby', // .rb - Ruby source
  tex: 'text/x-tex', // .tex - LaTeX source
  java: 'text/x-java', // .java - Java source
  js: 'text/javascript', // .js - JavaScript source
  sh: 'application/x-sh', // .sh - Shell script
  ts: 'application/typescript', // .ts - TypeScript source
  tar: 'application/x-tar', // .tar - Tar archive
  zip: 'application/zip', // .zip - ZIP archive
  txt: 'text/plain', // .txt - Plain text file
  log: 'text/plain', // .log - Log file
  csv: 'text/csv', // .csv - Comma-separated values
  tsv: 'text/tab-separated-values', // .tsv - Tab-separated values
  parquet: 'application/x-parquet', // .parquet - Apache Parquet columnar storage
  json: 'application/json', // .json - JSON file
  xml: 'application/xml', // .xml - XML file
  html: 'text/html', // .html - HTML file
  htm: 'text/html', // .htm - HTML file
  css: 'text/css', // .css - CSS file
  yml: 'application/yaml', // .yml - YAML
  yaml: 'application/yaml', // .yaml - YAML
  sql: 'application/sql', // .sql - SQL (IANA registered)
  dart: 'text/plain', // .dart - Dart source
  coffee: 'application/vnd.coffeescript', // .coffee - CoffeeScript (IANA registered)
  go: 'text/plain', // .go - Go source
  rs: 'text/plain', // .rs - Rust source
  swift: 'text/plain', // .swift - Swift source
  kt: 'text/plain', // .kt - Kotlin source
  kts: 'text/plain', // .kts - Kotlin script
  scala: 'text/plain', // .scala - Scala source
  lua: 'text/plain', // .lua - Lua source
  r: 'text/plain', // .r - R source
  pl: 'text/plain', // .pl - Perl source
  pm: 'text/plain', // .pm - Perl module
  groovy: 'text/plain', // .groovy - Groovy source
  gradle: 'text/plain', // .gradle - Gradle build script
  clj: 'text/plain', // .clj - Clojure source
  cljs: 'text/plain', // .cljs - ClojureScript source
  cljc: 'text/plain', // .cljc - Clojure common source
  elm: 'text/plain', // .elm - Elm source
  eml: 'message/rfc822', // .eml - Email message (RFC 822)
  erl: 'text/plain', // .erl - Erlang source
  hrl: 'text/plain', // .hrl - Erlang header
  ex: 'text/plain', // .ex - Elixir source
  exs: 'text/plain', // .exs - Elixir script
  hs: 'text/plain', // .hs - Haskell source
  lhs: 'text/plain', // .lhs - Literate Haskell source
  ml: 'text/plain', // .ml - OCaml source
  mli: 'text/plain', // .mli - OCaml interface
  fs: 'text/plain', // .fs - F# source
  fsx: 'text/plain', // .fsx - F# script
  lisp: 'text/plain', // .lisp - Lisp source
  cl: 'text/plain', // .cl - Common Lisp source
  scm: 'text/plain', // .scm - Scheme source
  rkt: 'text/plain', // .rkt - Racket source
  jsx: 'text/plain', // .jsx - React JSX
  tsx: 'text/plain', // .tsx - React TSX
  vue: 'text/plain', // .vue - Vue component
  svelte: 'text/plain', // .svelte - Svelte component
  astro: 'text/plain', // .astro - Astro component
  scss: 'text/plain', // .scss - SCSS source
  sass: 'text/plain', // .sass - Sass source
  less: 'text/plain', // .less - Less source
  styl: 'text/plain', // .styl - Stylus source
  toml: 'text/plain', // .toml - TOML config
  ini: 'text/plain', // .ini - INI config
  cfg: 'text/plain', // .cfg - Config file
  conf: 'text/plain', // .conf - Config file
  env: 'text/plain', // .env - Environment file
  properties: 'text/plain', // .properties - Java properties
  graphql: 'text/plain', // .graphql - GraphQL schema/query
  gql: 'text/plain', // .gql - GraphQL schema/query
  proto: 'text/plain', // .proto - Protocol Buffers
  dockerfile: 'text/plain', // Dockerfile
  makefile: 'text/plain', // Makefile
  cmake: 'text/plain', // .cmake - CMake script
  rake: 'text/plain', // .rake - Rake task
  gemspec: 'text/plain', // .gemspec - Ruby gem spec
  bash: 'text/plain', // .bash - Bash script
  zsh: 'text/plain', // .zsh - Zsh script
  fish: 'text/plain', // .fish - Fish script
  ps1: 'text/plain', // .ps1 - PowerShell script
  psm1: 'text/plain', // .psm1 - PowerShell module
  bat: 'text/plain', // .bat - Batch script
  cmd: 'text/plain', // .cmd - Windows command script
  asm: 'text/plain', // .asm - Assembly source
  s: 'text/plain', // .s - Assembly source
  v: 'text/plain', // .v - V or Verilog source
  zig: 'text/plain', // .zig - Zig source
  nim: 'text/plain', // .nim - Nim source
  cr: 'text/plain', // .cr - Crystal source
  d: 'text/plain', // .d - D source
  pas: 'text/plain', // .pas - Pascal source
  pp: 'text/plain', // .pp - Pascal/Puppet source
  f90: 'text/plain', // .f90 - Fortran 90 source
  f95: 'text/plain', // .f95 - Fortran 95 source
  f03: 'text/plain', // .f03 - Fortran 2003 source
  jl: 'text/plain', // .jl - Julia source
  m: 'text/plain', // .m - Objective-C/MATLAB source
  mm: 'text/plain', // .mm - Objective-C++ source
  ada: 'text/plain', // .ada - Ada source
  adb: 'text/plain', // .adb - Ada body
  ads: 'text/plain', // .ads - Ada spec
  cob: 'text/plain', // .cob - COBOL source
  cbl: 'text/plain', // .cbl - COBOL source
  tcl: 'text/plain', // .tcl - Tcl source
  awk: 'text/plain', // .awk - AWK script
  sed: 'text/plain', // .sed - Sed script
  odt: 'application/vnd.oasis.opendocument.text', // .odt - OpenDocument Text
  ods: 'application/vnd.oasis.opendocument.spreadsheet', // .ods - OpenDocument Spreadsheet
  odp: 'application/vnd.oasis.opendocument.presentation', // .odp - OpenDocument Presentation
  odg: 'application/vnd.oasis.opendocument.graphics', // .odg - OpenDocument Graphics
  doc: 'application/msword', // .doc - Word (legacy)
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx - Word
  xls: 'application/vnd.ms-excel', // .xls - Excel (legacy)
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx - Excel
  ppt: 'application/vnd.ms-powerpoint', // .ppt - PowerPoint (legacy)
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx - PowerPoint
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template', // .potx - PowerPoint template
  ics: 'text/calendar', // .ics - iCalendar
  ical: 'text/calendar', // .ical - iCalendar
  ifb: 'text/calendar', // .ifb - iCalendar free/busy
  icalendar: 'text/calendar', // .icalendar - iCalendar
};

/** Maps image extensions to MIME types for formats browsers may not recognize */
export const imageTypeMapping: { [key: string]: string } = {
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Normalizes non-standard MIME types that browsers may report to their canonical forms */
export const mimeTypeAliases: Readonly<Record<string, string>> = {
  'application/x-zip-compressed': 'application/zip',
  'text/x-python-script': 'text/x-python',
  'text/x-markdown': 'text/markdown',
  /** freedesktop shared-mime-info (Chrome on Linux) */
  'application/x-shellscript': 'application/x-sh',
  /** libmagic, i.e. `file --mime-type` */
  'text/x-shellscript': 'application/x-sh',
};

/**
 * Infers the MIME type from a file's extension when the browser doesn't recognize it,
 * and normalizes known non-standard MIME type aliases to their canonical forms.
 * @param fileName - The file name including its extension
 * @param currentType - The MIME type reported by the browser (may be empty string)
 * @returns The normalized or inferred MIME type; empty string if unresolvable
 */
export function inferMimeType(fileName: string, currentType: string): string {
  if (currentType) {
    return mimeTypeAliases[currentType] ?? currentType;
  }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return codeTypeMapping[extension] || imageTypeMapping[extension] || currentType;
}

export const retrievalMimeTypes = [
  /^(text\/(x-c|x-c\+\+|x-h|html|x-java|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|vtt|xml))$/,
  /^(application\/(json|pdf|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.(presentation|template))))$/,
];

export const megabyte = 1024 * 1024;
/** Helper function to get megabytes value */
export const mbToBytes = (mb: number): number => mb * megabyte;

const defaultSizeLimit = mbToBytes(512);
const defaultSkillImportSizeLimit = mbToBytes(50);
const defaultTokenLimit = 100000;
const defaultContextSizeLimit = mbToBytes(128);
const defaultContextCharLimit = 1_000_000;
const assistantsFileConfig = {
  fileLimit: 10,
  fileSizeLimit: defaultSizeLimit,
  totalSizeLimit: defaultSizeLimit,
  supportedMimeTypes,
  disabled: false,
};

export const fileConfig = {
  endpoints: {
    [EModelEndpoint.assistants]: assistantsFileConfig,
    [EModelEndpoint.azureAssistants]: assistantsFileConfig,
    [EModelEndpoint.agents]: assistantsFileConfig,
    [EModelEndpoint.anthropic]: {
      fileLimit: 10,
      fileSizeLimit: defaultSizeLimit,
      totalSizeLimit: defaultSizeLimit,
      supportedMimeTypes,
      disabled: false,
    },
    default: {
      fileLimit: 10,
      fileSizeLimit: defaultSizeLimit,
      totalSizeLimit: defaultSizeLimit,
      supportedMimeTypes,
      disabled: false,
    },
  },
  skills: {
    fileSizeLimit: defaultSkillImportSizeLimit,
    importCleanupConcurrency: DEFAULT_SKILL_IMPORT_CLEANUP_CONCURRENCY,
  },
  serverFileSizeLimit: defaultSizeLimit,
  avatarSizeLimit: mbToBytes(2),
  fileTokenLimit: defaultTokenLimit,
  fileContextSizeLimit: defaultContextSizeLimit,
  fileContextCharLimit: defaultContextCharLimit,
  clientImageResize: {
    enabled: false,
    maxWidth: 1900,
    maxHeight: 1900,
    quality: 0.92,
    enforced: false,
  },
  ocr: {
    supportedMimeTypes: defaultOCRMimeTypes,
  },
  text: {
    supportedMimeTypes: defaultTextMimeTypes,
  },
  stt: {
    supportedMimeTypes: defaultSTTMimeTypes,
  },
  checkType: function (fileType: string, supportedTypes: RegexLike[] = supportedMimeTypes) {
    return supportedTypes.some((regex) => regex.test(fileType));
  },
};

const supportedMimeTypesSchema = z
  .array(
    z.string().superRefine((pattern, context) => {
      try {
        compileMimeRegex(pattern);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid MIME type regex: not supported by the configured regex engine',
        });
      }
    }),
  )
  .optional();

export const DefaultLLMDeliveryPath = z.enum(['provider', 'text', 'none']);
export type TDefaultLLMDeliveryPath = z.infer<typeof DefaultLLMDeliveryPath>;

export const defaultLLMDeliveryPathSchema = z.object({
  fallback: DefaultLLMDeliveryPath.optional(),
  overrides: z.record(DefaultLLMDeliveryPath).optional(),
});
export type TDefaultLLMDeliveryPathConfig = z.infer<typeof defaultLLMDeliveryPathSchema>;
type TDeliveryPathOverrides = NonNullable<TDefaultLLMDeliveryPathConfig['overrides']>;

export const endpointFileConfigSchema = z.object({
  disabled: z.boolean().optional(),
  fileLimit: z.number().min(0).optional(),
  fileSizeLimit: z.number().min(0).optional(),
  totalSizeLimit: z.number().min(0).optional(),
  supportedMimeTypes: supportedMimeTypesSchema.optional(),
  defaultLLMDeliveryPath: defaultLLMDeliveryPathSchema.optional(),
  legacyFileUploadUX: z.boolean().optional(),
  textFallbackWithoutTools: z.boolean().optional(),
});

const skillFileConfigSchema = z.object({
  fileSizeLimit: z.number().min(0).optional(),
  importCleanupConcurrency: z.number().int().positive().optional(),
});

export const fileConfigSchema = z.object({
  endpoints: z.record(endpointFileConfigSchema).optional(),
  skills: skillFileConfigSchema.optional(),
  serverFileSizeLimit: z.number().min(0).optional(),
  avatarSizeLimit: z.number().min(0).optional(),
  fileTokenLimit: z.number().min(0).optional(),
  fileContextSizeLimit: z.number().min(0).optional(),
  fileContextCharLimit: z.number().min(0).optional(),
  codeEnvLivenessSafeWindowMs: z.number().min(0).optional(),
  imageGeneration: z
    .object({
      percentage: z.number().min(0).max(100).optional(),
      px: z.number().min(0).optional(),
    })
    .optional(),
  clientImageResize: z
    .object({
      enabled: z.boolean().optional(),
      maxWidth: z.number().min(1).optional(),
      maxHeight: z.number().min(1).optional(),
      quality: z.number().min(0).max(1).optional(),
    })
    .optional(),
  ocr: z
    .object({
      supportedMimeTypes: supportedMimeTypesSchema.optional(),
    })
    .optional(),
  text: z
    .object({
      supportedMimeTypes: supportedMimeTypesSchema.optional(),
    })
    .optional(),
  defaultLLMDeliveryPath: defaultLLMDeliveryPathSchema.optional(),
  legacyFileUploadUX: z.boolean().optional(),
  textFallbackWithoutTools: z.boolean().optional(),
});

export type TFileConfig = z.infer<typeof fileConfigSchema>;

/**
 * Compiler for admin-supplied MIME patterns. Defaults to native `RegExp`, which browser
 * builds keep so no extra dependency is bundled. The server swaps in a linear-time engine
 * via `setFileConfigRegexCompiler` so an admin-authored catastrophic-backtracking pattern
 * cannot ReDoS the shared event loop when tested against an uploaded file's MIME type.
 */
let compileMimeRegex: (pattern: string) => RegexLike = (pattern) => new RegExp(pattern);

/** Override the MIME-pattern compiler; the server injects a linear-time engine at startup. */
export const setFileConfigRegexCompiler = (compile: (pattern: string) => RegexLike): void => {
  compileMimeRegex = compile;
};

/** Returned when every configured pattern fails to compile, so consumers that read an empty
 *  allowlist as "no restriction" fail closed instead of allowing every file. */
const rejectAllMimeMatcher: RegexLike = { test: () => false };

/** Helper function to safely convert string patterns to matcher objects */
export const convertStringsToRegex = (patterns: string[]): RegexLike[] => {
  const compiled = patterns.reduce((acc: RegexLike[], pattern) => {
    try {
      acc.push(compileMimeRegex(pattern));
    } catch (error) {
      console.error(`Invalid regex pattern "${pattern}" skipped.`, error);
    }
    return acc;
  }, [] as RegexLike[]);
  // Every configured pattern was dropped. Return an explicit reject-all matcher so consumers that
  // read an empty allowlist as "no restriction" fail closed instead of allowing every file.
  if (patterns.length > 0 && compiled.length === 0) {
    console.error(
      `All ${patterns.length} MIME type pattern(s) were invalid and skipped; the resulting allowlist rejects every file.`,
    );
    return [rejectAllMimeMatcher];
  }
  return compiled;
};

/** Detects whether the given MIME type patterns accept all file types (e.g., `.*` or `.+`). */
export const isPermissiveMimeConfig = (types?: RegexLike[]): boolean => {
  if (!types || types.length === 0) {
    return false;
  }
  return types.some((regex) => regex.test('x-librechat/x-probe'));
};

/**
 * Detects whether an endpoint's `supportedMimeTypes` were set by the admin rather than inherited
 * from the built-in default list. Inheritance is signaled by referential identity with
 * `supportedMimeTypes`, which `mergeWithDefault` preserves for unconfigured endpoints.
 */
export const isExplicitMimeConfig = (types?: RegexLike[]): types is RegexLike[] => {
  if (!types || types.length === 0) {
    return false;
  }
  return types !== supportedMimeTypes;
};

/** The kind of content a provider upload path can actually send to the model. */
export type MimeUploadCategory = 'image' | 'document' | 'audio' | 'video';

/** Describes what an upload path can send, used to scope a configured allowlist to selectable files. */
export interface MimeUploadCapability {
  /** Content categories the path forwards to the model. */
  categories: ReadonlyArray<MimeUploadCategory>;
  /** When `document` is permitted, restrict document types to this set (e.g. Bedrock formats); default: all. */
  documentMimeTypes?: readonly string[];
}

/** Media categories that collapse to a wildcard `accept` token when any member type is allowed. */
const mimeAcceptCategories: ReadonlyArray<{
  category: Exclude<MimeUploadCategory, 'document'>;
  token: string;
  samples: readonly string[];
  extras?: readonly string[];
}> = [
  {
    /** Mirrors `imageMimeTypes` (+ the code-interpreter svg variants) so every accepted type is known. */
    category: 'image',
    token: 'image/*',
    samples: [
      'image/jpeg',
      'image/gif',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'image/svg',
      'image/svg+xml',
    ],
    extras: ['.heif', '.heic'],
  },
  {
    /** Mirrors `audioMimeTypes`. */
    category: 'audio',
    token: 'audio/*',
    samples: [
      'audio/mp3',
      'audio/mpeg',
      'audio/mpeg3',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/ogg',
      'audio/vorbis',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/flac',
      'audio/x-flac',
      'audio/webm',
      'audio/aac',
      'audio/wma',
      'audio/opus',
    ],
  },
  {
    /** Mirrors `videoMimeTypes`. */
    category: 'video',
    token: 'video/*',
    samples: [
      'video/mp4',
      'video/avi',
      'video/mov',
      'video/wmv',
      'video/flv',
      'video/webm',
      'video/mkv',
      'video/m4v',
      'video/3gp',
      'video/ogv',
    ],
  },
];

/** Document/text MIME types paired with the extension(s) browsers filter on in the file picker. */
const documentMimeExtensions: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['application/pdf', ['.pdf']],
  ['application/msword', ['.doc']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['.docx']],
  ['application/vnd.ms-excel', ['.xls']],
  ['application/msexcel', ['.xls']],
  ['application/x-msexcel', ['.xls']],
  ['application/x-ms-excel', ['.xls']],
  ['application/x-excel', ['.xls']],
  ['application/x-dos_ms_excel', ['.xls']],
  ['application/xls', ['.xls']],
  ['application/x-xls', ['.xls']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['.xlsx']],
  ['application/vnd.ms-powerpoint', ['.ppt']],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ['.pptx']],
  ['application/vnd.openxmlformats-officedocument.presentationml.template', ['.potx']],
  ['application/vnd.oasis.opendocument.text', ['.odt']],
  ['application/vnd.oasis.opendocument.spreadsheet', ['.ods']],
  ['application/vnd.oasis.opendocument.presentation', ['.odp']],
  ['application/vnd.oasis.opendocument.graphics', ['.odg']],
  ['application/rtf', ['.rtf']],
  ['application/json', ['.json']],
  ['application/xml', ['.xml']],
  ['application/yaml', ['.yaml', '.yml']],
  ['application/zip', ['.zip']],
  ['application/x-zip-compressed', ['.zip']],
  ['application/epub+zip', ['.epub']],
  ['application/x-parquet', ['.parquet']],
  ['application/vnd.apache.parquet', ['.parquet']],
  ['text/csv', ['.csv']],
  ['application/csv', ['.csv']],
  ['text/tab-separated-values', ['.tsv']],
  ['text/plain', ['.txt']],
  ['text/markdown', ['.md']],
  ['text/html', ['.html', '.htm']],
  ['text/calendar', ['.ics']],
  ['message/rfc822', ['.eml']],
];

/** Preferred extension for a known document MIME type, including its leading dot. */
export function getDocumentFileExtension(mimeType?: string): string | undefined {
  const normalized = mimeType?.split(';', 1)[0].trim().toLowerCase();
  const canonical = normalized === 'text/comma-separated-values' ? 'text/csv' : normalized;
  return documentMimeExtensions.find(([type]) => type === canonical)?.[1][0];
}

const documentMimeSet = new Set(documentMimeExtensions.map(([mimeType]) => mimeType));

/** Every MIME type LibreChat may accept, used to detect patterns that reach beyond the representable set. */
const knownMimeUniverse: readonly string[] = Array.from(
  new Set<string>([
    ...fullMimeTypesList,
    ...documentMimeExtensions.map(([mimeType]) => mimeType),
    ...mimeAcceptCategories.flatMap((category) => category.samples),
  ]),
);

const categoryOf = (mimeType: string): MimeUploadCategory => {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  return 'document';
};

/** Media types are covered by their `<cat>/*` wildcard token; document types need an explicit entry. */
const isRepresentable = (mimeType: string): boolean =>
  categoryOf(mimeType) !== 'document' || documentMimeSet.has(mimeType);

/**
 * Translates a finite MIME allowlist into a file-input `accept` string, intersected with what the
 * provider upload path can actually send. Returns `undefined` (keep the provider filter) when a
 * configured pattern matches a supported, path-handleable type that cannot be represented, so the
 * picker never hides a file the path would have accepted.
 */
const buildMimeAccept = (
  types: RegexLike[],
  { categories, documentMimeTypes }: MimeUploadCapability,
): string | undefined => {
  const permittedSet = new Set<MimeUploadCategory>(categories);
  const documentAllowSet = documentMimeTypes ? new Set(documentMimeTypes) : null;
  const emittedMedia = new Set<MimeUploadCategory>();
  const emittedDocuments = new Set<string>();

  /** A pattern matching nothing known may still accept a supported type we can't represent; fall back. */
  const everyPatternKnown = types.every((regex) =>
    knownMimeUniverse.some((mimeType) => regex.test(mimeType)),
  );
  if (!everyPatternKnown) {
    return undefined;
  }

  for (const regex of types) {
    for (const mimeType of knownMimeUniverse) {
      if (!regex.test(mimeType)) {
        continue;
      }
      const category = categoryOf(mimeType);
      if (!permittedSet.has(category)) {
        continue;
      }
      /** The path handles documents but drops this specific type (e.g. Bedrock ignores pptx/ODF). */
      if (category === 'document' && documentAllowSet && !documentAllowSet.has(mimeType)) {
        continue;
      }
      if (!isRepresentable(mimeType)) {
        return undefined;
      }
      if (category === 'document') {
        emittedDocuments.add(mimeType);
      } else {
        emittedMedia.add(category);
      }
    }
  }

  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };

  for (const category of mimeAcceptCategories) {
    if (emittedMedia.has(category.category)) {
      push(category.token);
      category.extras?.forEach(push);
    }
  }

  for (const [mimeType, extensions] of documentMimeExtensions) {
    if (emittedDocuments.has(mimeType)) {
      extensions.forEach(push);
      push(mimeType);
    }
  }

  return tokens.length > 0 ? tokens.join(',') : undefined;
};

/**
 * Resolves the file-input `accept` value for a configured `supportedMimeTypes` allowlist, scoped to
 * what the current upload path (`capability`) can send to the model.
 * - `undefined` for the built-in default or a config that can't be represented safely, so callers
 *   keep their provider-specific filter.
 * - `''` for permissive configs (e.g. `.*`), leaving the picker unrestricted.
 * - a translated `accept` string for a recognized finite allowlist (images, PDFs, Office docs, etc.).
 *
 * The picker `accept` is a UX convenience, not a security boundary: the backend still enforces
 * `supportedMimeTypes` on upload.
 */
export const getConfiguredMimeAccept = (
  types: RegexLike[] | undefined,
  capability: MimeUploadCapability,
): string | undefined => {
  /** Referential identity with the built-in list signals an unconfigured endpoint (keep provider filter). */
  if (!types || types.length === 0 || types === supportedMimeTypes) {
    return undefined;
  }
  if (isPermissiveMimeConfig(types)) {
    return '';
  }
  return buildMimeAccept(types, capability);
};

/**
 * Gets the appropriate endpoint file configuration with standardized lookup logic.
 *
 * @param params - Object containing fileConfig, endpoint, and optional conversationEndpoint
 * @param params.fileConfig - The merged file configuration
 * @param params.endpoint - The endpoint name to look up
 * @param params.conversationEndpoint - Optional conversation endpoint for additional context
 * @returns The endpoint file configuration or undefined
 */
/**
 * Merges an endpoint config with the default config to ensure all fields are populated.
 * For document-supported providers, uses the comprehensive MIME type list (includes videos/audio).
 */
function mergeWithDefault(
  endpointConfig: EndpointFileConfig,
  defaultConfig: EndpointFileConfig,
  endpoint?: string | null,
): EndpointFileConfig {
  /** Use comprehensive MIME types for document-supported providers */
  const defaultMimeTypes = isDocumentSupportedProvider(endpoint)
    ? supportedMimeTypes
    : defaultConfig.supportedMimeTypes;

  return {
    disabled: endpointConfig.disabled ?? defaultConfig.disabled,
    fileLimit: endpointConfig.fileLimit ?? defaultConfig.fileLimit,
    fileSizeLimit: endpointConfig.fileSizeLimit ?? defaultConfig.fileSizeLimit,
    totalSizeLimit: endpointConfig.totalSizeLimit ?? defaultConfig.totalSizeLimit,
    supportedMimeTypes: endpointConfig.supportedMimeTypes ?? defaultMimeTypes,
    defaultLLMDeliveryPath: mergeDeliveryPathConfig(
      endpointConfig.defaultLLMDeliveryPath,
      defaultConfig.defaultLLMDeliveryPath,
    ),
    legacyFileUploadUX: endpointConfig.legacyFileUploadUX ?? defaultConfig.legacyFileUploadUX,
    textFallbackWithoutTools:
      endpointConfig.textFallbackWithoutTools ?? defaultConfig.textFallbackWithoutTools,
  };
}

/**
 * Deep-merges delivery-path config so an endpoint that supplies only one override
 * still inherits the default's fallback and shared overrides. Whole-object
 * replacement would silently drop the inherited routing.
 */
function mergeDeliveryPathConfig(
  endpointValue?: TDefaultLLMDeliveryPathConfig,
  defaultValue?: TDefaultLLMDeliveryPathConfig,
): TDefaultLLMDeliveryPathConfig | undefined {
  if (!endpointValue) {
    return defaultValue;
  }
  if (!defaultValue) {
    return endpointValue;
  }
  /* An endpoint fallback terminates resolution after that endpoint's own overrides,
   * so inheriting the lower layer's overrides would promote them above it. Only when
   * the endpoint declares no fallback does resolution continue downward, and then the
   * merged map reproduces the chain exactly: endpoint overrides, default overrides,
   * default fallback. */
  if (endpointValue.fallback != null) {
    return endpointValue;
  }
  const hasOverrides = endpointValue.overrides != null || defaultValue.overrides != null;
  return {
    ...(defaultValue.fallback != null ? { fallback: defaultValue.fallback } : {}),
    ...(hasOverrides
      ? { overrides: { ...shadowByWildcard(defaultValue.overrides, endpointValue.overrides) } }
      : {}),
  };
}

/**
 * Flattens two override layers into one map that still resolves like the layered chain.
 * Resolution reads exact keys before wildcards, so a plain spread would let a lower
 * layer's `image/png` outrank the upper layer's `image/*`. Dropping the entries an
 * upper wildcard covers restores precedence without changing how lookups work.
 */
function shadowByWildcard(
  lower?: TDeliveryPathOverrides,
  upper?: TDeliveryPathOverrides,
): TDeliveryPathOverrides {
  if (!lower) {
    return { ...upper };
  }
  const upperWildcards = new Set<string>();
  for (const key in upper) {
    if (key.endsWith('/*')) {
      upperWildcards.add(key.slice(0, -1));
    }
  }
  if (upperWildcards.size === 0) {
    return { ...lower, ...upper };
  }
  const retained: TDeliveryPathOverrides = {};
  for (const key in lower) {
    const isShadowed =
      !key.endsWith('/*') &&
      upperWildcards.has(key.slice(0, key.indexOf('/') + 1)) &&
      upper?.[key] == null;
    if (!isShadowed) {
      retained[key] = lower[key];
    }
  }
  return { ...retained, ...upper };
}

export function getEndpointFileConfig(params: {
  fileConfig?: FileConfig | null;
  endpoint?: string | null;
  endpointType?: string | null;
}): EndpointFileConfig {
  const { fileConfig: mergedFileConfig, endpoint, endpointType } = params;

  if (!mergedFileConfig?.endpoints) {
    return fileConfig.endpoints.default;
  }

  /** Compute an effective default by merging user-configured default over the base default */
  const baseDefaultConfig: EndpointFileConfig = fileConfig.endpoints.default;
  const globalDefaultConfig: EndpointFileConfig = {
    ...baseDefaultConfig,
    defaultLLMDeliveryPath: mergeDeliveryPathConfig(
      mergedFileConfig.defaultLLMDeliveryPath,
      baseDefaultConfig.defaultLLMDeliveryPath,
    ),
    legacyFileUploadUX: mergedFileConfig.legacyFileUploadUX ?? baseDefaultConfig.legacyFileUploadUX,
    textFallbackWithoutTools:
      mergedFileConfig.textFallbackWithoutTools ?? baseDefaultConfig.textFallbackWithoutTools,
  };
  const userDefaultConfig = mergedFileConfig.endpoints.default;
  const defaultConfig = userDefaultConfig
    ? mergeWithDefault(userDefaultConfig, globalDefaultConfig, 'default')
    : globalDefaultConfig;

  const normalizedEndpoint = normalizeEndpointName(endpoint ?? '');
  const standardEndpoints = new Set([
    'default',
    EModelEndpoint.agents,
    EModelEndpoint.assistants,
    EModelEndpoint.azureAssistants,
    EModelEndpoint.openAI,
    EModelEndpoint.azureOpenAI,
    EModelEndpoint.anthropic,
    EModelEndpoint.google,
    EModelEndpoint.bedrock,
  ]);

  const normalizedEndpointType = normalizeEndpointName(endpointType ?? '');
  const isCustomEndpoint =
    endpointType === EModelEndpoint.custom ||
    (!standardEndpoints.has(normalizedEndpointType) &&
      normalizedEndpoint &&
      !standardEndpoints.has(normalizedEndpoint));

  if (isCustomEndpoint) {
    /** 1. Check direct endpoint lookup (could be normalized or not) */
    if (endpoint && mergedFileConfig.endpoints[endpoint]) {
      return mergeWithDefault(mergedFileConfig.endpoints[endpoint], defaultConfig, endpoint);
    }
    /** 2. Check normalized endpoint lookup (skip standard endpoint keys) */
    for (const key in mergedFileConfig.endpoints) {
      if (!standardEndpoints.has(key) && normalizeEndpointName(key) === normalizedEndpoint) {
        return mergeWithDefault(mergedFileConfig.endpoints[key], defaultConfig, key);
      }
    }
    /** 3. Fallback to generic 'custom' config if any */
    if (mergedFileConfig.endpoints[EModelEndpoint.custom]) {
      return mergeWithDefault(
        mergedFileConfig.endpoints[EModelEndpoint.custom],
        defaultConfig,
        endpoint,
      );
    }
    /** 4. Fallback to 'agents' (all custom endpoints are non-assistants) */
    if (mergedFileConfig.endpoints[EModelEndpoint.agents]) {
      return mergeWithDefault(
        mergedFileConfig.endpoints[EModelEndpoint.agents],
        defaultConfig,
        endpoint,
      );
    }
    /** 5. Fallback to default */
    return defaultConfig;
  }

  /** Check endpointType first (most reliable for standard endpoints) */
  if (endpointType && mergedFileConfig.endpoints[endpointType]) {
    return mergeWithDefault(mergedFileConfig.endpoints[endpointType], defaultConfig, endpointType);
  }

  /** Check direct endpoint lookup */
  if (endpoint && mergedFileConfig.endpoints[endpoint]) {
    return mergeWithDefault(mergedFileConfig.endpoints[endpoint], defaultConfig, endpoint);
  }

  /** Check normalized endpoint */
  if (normalizedEndpoint && mergedFileConfig.endpoints[normalizedEndpoint]) {
    return mergeWithDefault(
      mergedFileConfig.endpoints[normalizedEndpoint],
      defaultConfig,
      normalizedEndpoint,
    );
  }

  /** Fallback to agents if endpoint is explicitly agents */
  const isAgents = isAgentsEndpoint(normalizedEndpointType || normalizedEndpoint);
  if (isAgents && mergedFileConfig.endpoints[EModelEndpoint.agents]) {
    return mergeWithDefault(
      mergedFileConfig.endpoints[EModelEndpoint.agents],
      defaultConfig,
      EModelEndpoint.agents,
    );
  }

  /** Return default config */
  return defaultConfig;
}

export function mergeFileConfig(dynamic: z.infer<typeof fileConfigSchema> | undefined): FileConfig {
  const mergedConfig: FileConfig = {
    ...fileConfig,
    endpoints: {
      ...fileConfig.endpoints,
    },
    skills: {
      ...fileConfig.skills,
    },
    ocr: {
      ...fileConfig.ocr,
      supportedMimeTypes: fileConfig.ocr?.supportedMimeTypes || [],
    },
    text: {
      ...fileConfig.text,
      supportedMimeTypes: fileConfig.text?.supportedMimeTypes || [],
    },
    stt: {
      ...fileConfig.stt,
      supportedMimeTypes: fileConfig.stt?.supportedMimeTypes || [],
    },
  };
  if (!dynamic) {
    return mergedConfig;
  }

  if (dynamic.defaultLLMDeliveryPath !== undefined) {
    mergedConfig.defaultLLMDeliveryPath = dynamic.defaultLLMDeliveryPath;
  }

  if (dynamic.legacyFileUploadUX !== undefined) {
    mergedConfig.legacyFileUploadUX = dynamic.legacyFileUploadUX;
  }

  if (dynamic.textFallbackWithoutTools !== undefined) {
    mergedConfig.textFallbackWithoutTools = dynamic.textFallbackWithoutTools;
  }

  if (dynamic.serverFileSizeLimit !== undefined) {
    mergedConfig.serverFileSizeLimit = mbToBytes(dynamic.serverFileSizeLimit);
  }

  if (dynamic.avatarSizeLimit !== undefined) {
    mergedConfig.avatarSizeLimit = mbToBytes(dynamic.avatarSizeLimit);
  }

  if (dynamic.fileTokenLimit !== undefined) {
    mergedConfig.fileTokenLimit = dynamic.fileTokenLimit;
  }

  if (dynamic.fileContextSizeLimit !== undefined) {
    mergedConfig.fileContextSizeLimit = mbToBytes(dynamic.fileContextSizeLimit);
  }

  if (dynamic.fileContextCharLimit !== undefined) {
    mergedConfig.fileContextCharLimit = dynamic.fileContextCharLimit;
  }

  if (dynamic.skills?.importCleanupConcurrency !== undefined) {
    mergedConfig.skills = {
      ...mergedConfig.skills,
      importCleanupConcurrency: dynamic.skills.importCleanupConcurrency,
    };
  }

  if (dynamic.skills?.fileSizeLimit !== undefined) {
    mergedConfig.skills = {
      ...mergedConfig.skills,
      fileSizeLimit: mbToBytes(dynamic.skills.fileSizeLimit),
    };
  }

  // Merge clientImageResize configuration; an admin-provided `enabled` overrides the user's setting
  if (dynamic.clientImageResize !== undefined) {
    mergedConfig.clientImageResize = {
      ...mergedConfig.clientImageResize,
      ...dynamic.clientImageResize,
      enforced: dynamic.clientImageResize.enabled !== undefined,
    };
  }

  if (dynamic.ocr !== undefined) {
    const { supportedMimeTypes: ocrMimeTypes, ...ocrRest } = dynamic.ocr;
    mergedConfig.ocr = {
      ...mergedConfig.ocr,
      ...ocrRest,
    };
    if (ocrMimeTypes) {
      mergedConfig.ocr.supportedMimeTypes = convertStringsToRegex(ocrMimeTypes);
    }
  }

  if (dynamic.text !== undefined) {
    const { supportedMimeTypes: textMimeTypes, ...textRest } = dynamic.text;
    mergedConfig.text = {
      ...mergedConfig.text,
      ...textRest,
    };
    if (textMimeTypes) {
      mergedConfig.text.supportedMimeTypes = convertStringsToRegex(textMimeTypes);
    }
  }

  if (!dynamic.endpoints) {
    return mergedConfig;
  }

  for (const key in dynamic.endpoints) {
    const dynamicEndpoint = (dynamic.endpoints as Record<string, EndpointFileConfig>)[key];

    /** Deep copy the base endpoint config if it exists to prevent mutation */
    if (!mergedConfig.endpoints[key]) {
      mergedConfig.endpoints[key] = {};
    } else {
      mergedConfig.endpoints[key] = { ...mergedConfig.endpoints[key] };
    }

    const mergedEndpoint = mergedConfig.endpoints[key];

    if (dynamicEndpoint.disabled === true) {
      mergedEndpoint.disabled = true;
      mergedEndpoint.fileLimit = 0;
      mergedEndpoint.fileSizeLimit = 0;
      mergedEndpoint.totalSizeLimit = 0;
      mergedEndpoint.supportedMimeTypes = [];
      continue;
    }

    if (dynamicEndpoint.fileSizeLimit !== undefined) {
      mergedEndpoint.fileSizeLimit = mbToBytes(dynamicEndpoint.fileSizeLimit);
    }

    if (dynamicEndpoint.totalSizeLimit !== undefined) {
      mergedEndpoint.totalSizeLimit = mbToBytes(dynamicEndpoint.totalSizeLimit);
    }

    const configKeys = ['fileLimit'] as const;
    configKeys.forEach((field) => {
      if (dynamicEndpoint[field] !== undefined) {
        mergedEndpoint[field] = dynamicEndpoint[field];
      }
    });

    if (dynamicEndpoint.disabled !== undefined) {
      mergedEndpoint.disabled = dynamicEndpoint.disabled;
    }

    if (dynamicEndpoint.supportedMimeTypes) {
      mergedEndpoint.supportedMimeTypes = convertStringsToRegex(
        dynamicEndpoint.supportedMimeTypes as unknown as string[],
      );
    }

    if (dynamicEndpoint.defaultLLMDeliveryPath !== undefined) {
      mergedEndpoint.defaultLLMDeliveryPath = dynamicEndpoint.defaultLLMDeliveryPath;
    }

    if (dynamicEndpoint.legacyFileUploadUX !== undefined) {
      mergedEndpoint.legacyFileUploadUX = dynamicEndpoint.legacyFileUploadUX;
    }

    if (dynamicEndpoint.textFallbackWithoutTools !== undefined) {
      mergedEndpoint.textFallbackWithoutTools = dynamicEndpoint.textFallbackWithoutTools;
    }
  }

  return mergedConfig;
}
