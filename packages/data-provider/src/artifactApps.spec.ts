import type { TArtifactApp, TArtifactVersion } from './artifactApps';
import {
  artifactPreviewSchema,
  isAllowedArtifactPreviewUrl,
  normalizeArtifactAppDetail,
  publishArtifactAppSchema,
  syncArtifactAppSchema,
} from './artifactApps';

const app = { artifactAppId: 'app-1' } as TArtifactApp;
const version = { artifactVersionId: 'version-1' } as TArtifactVersion;

describe('normalizeArtifactAppDetail', () => {
  it('accepts the backward-compatible app/version envelope', () => {
    expect(normalizeArtifactAppDetail({ app, version })).toEqual({ app, version });
  });

  it('accepts the raw app shape returned by short-lived rollout pods', () => {
    expect(normalizeArtifactAppDetail(app)).toEqual({ app, version: null });
  });
});

describe('syncArtifactAppSchema source identity', () => {
  const request = {
    title: 'Report',
    artifact: { type: 'html', content: '<h1>Report</h1>' },
    source: { conversationId: 'conversation-1' },
  };

  it.each([
    'artifact:v1:identifier:report:text/html',
    'artifact:v1:file:tool-artifact-file-1',
    'identifier:legacy-report:application/vnd.react',
  ])('accepts a versioned or recognized rollout key: %s', (sourceKey) => {
    expect(
      syncArtifactAppSchema.safeParse({
        ...request,
        source: { ...request.source, sourceKey },
      }).success,
    ).toBe(true);
  });

  it('rejects unversioned arbitrary identities', () => {
    expect(
      syncArtifactAppSchema.safeParse({
        ...request,
        source: { ...request.source, sourceKey: 'report:text/html' },
      }).success,
    ).toBe(false);
  });

  it('accepts only a matching truncated predecessor for a hashed source key', () => {
    const sharedPrefix = `artifact:v1:identifier:${'x'.repeat(
      491 - 'artifact:v1:identifier:'.length,
    )}`;
    const sourceKey = `${sharedPrefix}:deadbeef`;
    const legacySourceKey = `${sharedPrefix}old-tail!`;

    expect(
      syncArtifactAppSchema.safeParse({
        ...request,
        source: { ...request.source, sourceKey, legacySourceKey },
      }).success,
    ).toBe(true);
    expect(
      syncArtifactAppSchema.safeParse({
        ...request,
        source: { ...request.source, sourceKey, legacySourceKey: 'x'.repeat(500) },
      }).success,
    ).toBe(false);
  });
});

describe('artifact snapshot previews', () => {
  const preview = {
    type: 'image',
    imageUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    alt: 'Report preview',
  };
  const artifact = { type: 'html', content: '<h1>Report</h1>', preview };

  it('accepts preview metadata for publish and synchronization', () => {
    expect(publishArtifactAppSchema.parse({ title: 'Report', artifact }).artifact.preview).toEqual(
      preview,
    );
    expect(
      syncArtifactAppSchema.parse({
        title: 'Report',
        artifact,
        source: {
          conversationId: 'conversation-1',
          sourceKey: 'artifact:v1:identifier:report',
        },
      }).artifact.preview,
    ).toEqual(preview);
  });

  it.each([
    preview.imageUrl,
    'data:image/jpeg;base64,/9j/AA==',
    'data:image/webp;base64,UklGRgQAAABXRUJQ',
  ])('accepts a self-contained raster preview: %s', (imageUrl) => {
    expect(isAllowedArtifactPreviewUrl(imageUrl)).toBe(true);
    expect(artifactPreviewSchema.safeParse({ type: 'image', imageUrl }).success).toBe(true);
  });

  it.each([
    'https://attacker.example/pixel.png',
    'http://attacker.example/pixel.png',
    '//attacker.example/pixel.png',
    '/api/files/preview.png',
    'blob:https://example.com/preview',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,PHN2Zy8+',
    'data:text/html;base64,PGgxPmJhZDwvaDE+',
  ])('rejects a preview that can load remote or executable content: %s', (imageUrl) => {
    expect(isAllowedArtifactPreviewUrl(imageUrl)).toBe(false);
    expect(artifactPreviewSchema.safeParse({ type: 'image', imageUrl }).success).toBe(false);
  });
});
