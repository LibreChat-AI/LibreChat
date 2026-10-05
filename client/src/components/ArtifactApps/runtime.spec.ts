import { getArtifactMimeType } from './runtime';

describe('getArtifactMimeType', () => {
  it.each([
    ['react', 'application/vnd.react'],
    ['html', 'text/html'],
    ['svg', 'image/svg+xml'],
    ['mermaid', 'application/vnd.mermaid'],
    ['markdown', 'text/markdown'],
    ['text', 'text/plain'],
    ['code', 'application/vnd.code'],
    ['document', 'application/vnd.librechat.docx-preview'],
    ['spreadsheet', 'application/vnd.librechat.spreadsheet-preview'],
    ['presentation', 'application/vnd.librechat.presentation-preview'],
  ] as const)('maps %s snapshots to %s artifacts', (runtimeType, expected) => {
    expect(getArtifactMimeType(runtimeType)).toBe(expected);
  });
});
