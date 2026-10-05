import type { Artifact } from '~/common';
import {
  getArtifactRuntimeType,
  getArtifactSourceKey,
  toArtifactSyncRequest,
  toLatestArtifactSyncRequests,
} from './artifactCatalog';

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: 'chart_application/vnd.react_Revenue_message-1',
  identifier: 'revenue-chart',
  messageId: 'message-1',
  index: 0,
  title: 'Revenue chart',
  type: 'application/vnd.react',
  content: 'export default function Chart() { return <div />; }',
  lastUpdateTime: 1,
  ...overrides,
});

describe('artifact catalog identity', () => {
  it('keeps inline artifacts stable across rendering messages', () => {
    const first = artifact();
    const revision = artifact({ id: 'different-ui-id', messageId: 'message-2' });

    expect(getArtifactSourceKey(first)).toBe(getArtifactSourceKey(revision));
  });

  it('keeps an identified artifact stable when its MIME type changes', () => {
    const html = artifact({ type: 'text/html' });
    const react = artifact({ type: 'application/vnd.react' });

    expect(getArtifactSourceKey(html)).toBe('artifact:v1:identifier:revenue-chart');
    expect(getArtifactSourceKey(react)).toBe(getArtifactSourceKey(html));
  });

  it('keeps tool artifacts stable by file id', () => {
    expect(
      getArtifactSourceKey(
        artifact({ id: 'tool-artifact-file-123', identifier: undefined, messageId: 'message-2' }),
      ),
    ).toBe('artifact:v1:file:tool-artifact-file-123');
  });

  it('avoids collisions when two long identifiers share a truncation-length prefix', () => {
    const longPrefix = 'x'.repeat(600);
    const first = artifact({ identifier: `${longPrefix}-first` });
    const second = artifact({ identifier: `${longPrefix}-second` });

    const firstKey = getArtifactSourceKey(first);
    const secondKey = getArtifactSourceKey(second);
    expect(firstKey).not.toBeNull();
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey?.length).toBeLessThanOrEqual(500);
    expect(secondKey?.length).toBeLessThanOrEqual(500);
  });

  it('keeps a bounded key stable for the same overlong identifier', () => {
    const identifier = `${'y'.repeat(600)}-stable`;
    const first = getArtifactSourceKey(artifact({ identifier }));
    const second = getArtifactSourceKey(artifact({ identifier }));

    expect(first).toBe(second);
  });

  it('includes the former truncated key when hashing an overlong identity', () => {
    const identifier = `${'z'.repeat(600)}-existing`;
    const request = toArtifactSyncRequest(artifact({ identifier }), 'conversation-1');
    const previousKey = `artifact:v1:identifier:${identifier}`.slice(0, 500);

    expect(request?.source.sourceKey).not.toBe(previousKey);
    expect(request?.source.legacySourceKey).toBe(previousKey);
  });

  it('maps every renderable office and text family to a stored runtime', () => {
    expect(getArtifactRuntimeType('text/markdown')).toBe('markdown');
    expect(getArtifactRuntimeType('image/svg+xml')).toBe('svg');
    expect(getArtifactRuntimeType('application/vnd.code')).toBe('code');
    expect(getArtifactRuntimeType('application/vnd.librechat.presentation-preview')).toBe(
      'presentation',
    );
  });

  it('builds an automatic sync request from the LLM-authored artifact title', () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Revenue chart',
    };
    expect(toArtifactSyncRequest(artifact({ preview }), 'conversation-1')).toMatchObject({
      title: 'Revenue chart',
      source: {
        conversationId: 'conversation-1',
        sourceKey: 'artifact:v1:identifier:revenue-chart',
      },
      artifact: { type: 'react', preview },
    });
  });

  it('syncs only the latest revision for each stable source', () => {
    const requests = toLatestArtifactSyncRequests(
      {
        old: artifact({ content: 'old revision', lastUpdateTime: 1 }),
        latest: artifact({ id: 'new-ui-id', content: 'latest revision', lastUpdateTime: 3 }),
        separate: artifact({
          identifier: 'separate',
          content: 'other artifact',
          lastUpdateTime: 2,
        }),
      },
      'conversation-1',
    );

    expect(requests).toHaveLength(2);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact: expect.objectContaining({ content: 'latest revision' }),
        }),
        expect.objectContaining({
          artifact: expect.objectContaining({ content: 'other artifact' }),
        }),
      ]),
    );
  });
});
