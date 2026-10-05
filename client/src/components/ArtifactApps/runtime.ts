import type { ArtifactRuntimeType } from 'librechat-data-provider';

const ARTIFACT_MIME_TYPES: Record<ArtifactRuntimeType, string> = {
  react: 'application/vnd.react',
  html: 'text/html',
  svg: 'image/svg+xml',
  mermaid: 'application/vnd.mermaid',
  markdown: 'text/markdown',
  text: 'text/plain',
  code: 'application/vnd.code',
  document: 'application/vnd.librechat.docx-preview',
  spreadsheet: 'application/vnd.librechat.spreadsheet-preview',
  presentation: 'application/vnd.librechat.presentation-preview',
};

export function getArtifactMimeType(runtimeType: ArtifactRuntimeType): string {
  return ARTIFACT_MIME_TYPES[runtimeType];
}
