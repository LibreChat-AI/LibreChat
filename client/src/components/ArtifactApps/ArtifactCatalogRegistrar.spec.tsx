import React from 'react';
import { act, render } from '@testing-library/react';
import { Constants, QueryKeys } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { enqueueArtifactSync } from '~/components/ArtifactApps/sync/queue';
import ArtifactCatalogRegistrar from './ArtifactCatalogRegistrar';
import { logger } from '~/utils';

const mockUseRecoilValue = jest.fn();
const mockUseArtifactsContext = jest.fn();
const mockFetchQuery = jest.fn();
let mockStartupConfig: { artifactApps?: Record<string, number> } | undefined;

jest.mock('recoil', () => ({
  useRecoilValue: () => mockUseRecoilValue(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ fetchQuery: mockFetchQuery }),
}));

jest.mock('~/Providers', () => ({
  useArtifactsContext: () => mockUseArtifactsContext(),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
}));

jest.mock('~/hooks/Roles/useHasAccess', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('~/components/ArtifactApps/sync/queue', () => ({
  enqueueArtifactSync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { artifactsState: { key: 'artifactsState' } },
}));

jest.mock('~/utils', () => ({
  logger: { error: jest.fn() },
}));

const mockEnqueueArtifactSync = jest.mocked(enqueueArtifactSync);

/** Drains the resolve-then-enqueue microtask chain the registrar runs before each enqueue. */
async function flushRegistration(): Promise<void> {
  for (let tick = 0; tick < 5; tick++) {
    await Promise.resolve();
  }
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    identifier: 'chart',
    title: 'Revenue chart',
    type: 'application/vnd.react',
    content: 'export default () => <div>chart</div>;',
    messageId: 'message-1',
    lastUpdateTime: 1,
    ...overrides,
  };
}

describe('ArtifactCatalogRegistrar', () => {
  let artifacts: Record<string, Artifact | undefined>;
  let context: {
    conversationId: string;
    isSubmitting: boolean;
    latestMessageId: string | null;
    latestMessageError: boolean;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockStartupConfig = undefined;
    mockFetchQuery.mockRejectedValue({ response: { status: 404 } });
    artifacts = { 'artifact-1': makeArtifact() };
    context = {
      conversationId: 'conversation-1',
      isSubmitting: false,
      latestMessageId: 'message-1',
      latestMessageError: false,
    };
    mockUseRecoilValue.mockImplementation(() => artifacts);
    mockUseArtifactsContext.mockImplementation(() => context);
  });

  it('does not register artifacts while reading idle conversation history', async () => {
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    artifacts = { 'artifact-old': makeArtifact({ id: 'artifact-old', content: 'old snapshot' }) };
    context = {
      conversationId: 'conversation-old',
      isSubmitting: false,
      latestMessageId: 'message-old',
      latestMessageError: false,
    };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).not.toHaveBeenCalled();
  });

  it('persists only artifacts changed by a completed generation', async () => {
    const unchanged = makeArtifact({ id: 'artifact-old', identifier: 'unchanged' });
    artifacts = { 'artifact-old': unchanged };
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = {
      'artifact-old': unchanged,
      'artifact-new': makeArtifact({
        id: 'artifact-new',
        identifier: 'new-chart',
        messageId: 'message-2',
        lastUpdateTime: 2,
      }),
    };
    context = { ...context, latestMessageId: 'message-2' };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].source.sourceKey).toContain('new-chart');
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[3]).toBe(5_500);
  });

  it('does not register artifacts left over from an aborted or errored generation', async () => {
    const unchanged = makeArtifact({ id: 'artifact-old', identifier: 'unchanged' });
    artifacts = { 'artifact-old': unchanged };
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = {
      'artifact-old': unchanged,
      'artifact-new': makeArtifact({
        id: 'artifact-new',
        identifier: 'new-chart',
        messageId: 'message-2',
        lastUpdateTime: 2,
      }),
    };
    context = { ...context, latestMessageId: 'message-2' };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false, latestMessageError: true };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).not.toHaveBeenCalled();
  });

  it('continues observing previews that resolve after generation completion', async () => {
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);

    artifacts = {
      'artifact-delayed': makeArtifact({
        id: 'artifact-delayed',
        identifier: 'delayed-presentation',
        type: 'application/vnd.librechat.presentation-preview',
        content: '<html>presentation</html>',
        lastUpdateTime: 2,
      }),
    };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].artifact.type).toBe('presentation');
  });

  it('does not impose a wall-clock deadline on a completed generation', async () => {
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);

    artifacts = {
      'artifact-very-delayed': makeArtifact({
        id: 'artifact-very-delayed',
        identifier: 'very-delayed-presentation',
        type: 'application/vnd.librechat.presentation-preview',
        content: '<html>eventually ready</html>',
        lastUpdateTime: 2,
      }),
    };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
  });

  it('keeps observing a completed generation while the next generation runs', async () => {
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true, latestMessageId: 'message-a' };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: true, latestMessageId: 'message-b' };
    rerender(<ArtifactCatalogRegistrar />);

    artifacts = {
      'artifact-a': makeArtifact({
        id: 'artifact-a',
        identifier: 'generation-a',
        messageId: 'message-a',
      }),
    };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].source.messageId).toBe('message-a');
  });

  it('tracks a first generation when a new conversation receives its persisted id', async () => {
    artifacts = {};
    context = {
      conversationId: String(Constants.NEW_CONVO),
      isSubmitting: true,
      latestMessageId: 'message-new',
      latestMessageError: false,
    };
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, conversationId: 'conversation-created' };
    artifacts = {
      'artifact-new': makeArtifact({
        id: 'artifact-new',
        messageId: 'message-new',
      }),
    };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].source.conversationId).toBe(
      'conversation-created',
    );
  });

  it('ignores delayed artifacts from a message outside a completed generation', async () => {
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false, latestMessageId: 'message-new' };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = {
      'artifact-stale': makeArtifact({
        id: 'artifact-stale',
        identifier: 'stale-presentation',
        messageId: 'message-old',
      }),
    };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).not.toHaveBeenCalled();
  });

  it('uses the configured settle delay when persisting registration work', async () => {
    mockStartupConfig = {
      artifactApps: { clientSyncSettleDelayMs: 25, clientPreviewCaptureTimeoutMs: 750 },
    };
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = { 'artifact-new': makeArtifact() };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync.mock.calls[0]?.[3]).toBe(775);
  });

  it('persists the observed server-side latestVersionNumber alongside the request as a durable baseline', async () => {
    mockFetchQuery.mockResolvedValue({
      app: { latestVersionNumber: 3 },
      version: { artifactVersionId: 'version-1' },
    });
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = { 'artifact-new': makeArtifact() };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].basedOnVersionNumber).toBe(3);
    const request = mockEnqueueArtifactSync.mock.calls[0]?.[1];
    expect(mockFetchQuery).toHaveBeenCalledWith(
      [QueryKeys.artifactApp, 'source', request.source.conversationId, request.source.sourceKey],
      expect.any(Function),
      { retry: false },
    );
  });

  it('persists a confirmed-absence baseline of 0 when the source has never been synced (404)', async () => {
    mockFetchQuery.mockRejectedValue({ response: { status: 404 } });
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = { 'artifact-new': makeArtifact() };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].basedOnVersionNumber).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('leaves the baseline unresolved, and logs, when lookup fails for a non-404 reason', async () => {
    mockFetchQuery.mockRejectedValue(new Error('network down'));
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = { 'artifact-new': makeArtifact() };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].basedOnVersionNumber).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'artifacts',
      'Failed to resolve artifact baseline before sync',
      expect.any(Error),
    );
  });

  it('queues a captured preview promptly and includes it in the sync request', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      alt: 'Revenue chart',
    };
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = { 'artifact-new': makeArtifact({ preview }) };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(1);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[1].artifact.preview).toEqual(preview);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[3]).toBe(500);
  });

  it('supersedes the delayed fallback when a preview arrives after generation', async () => {
    const preview = {
      type: 'image' as const,
      imageUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    };
    artifacts = {};
    const { rerender } = render(<ArtifactCatalogRegistrar />);

    context = { ...context, isSubmitting: true };
    rerender(<ArtifactCatalogRegistrar />);
    artifacts = { 'artifact-new': makeArtifact() };
    rerender(<ArtifactCatalogRegistrar />);
    context = { ...context, isSubmitting: false };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    artifacts = { 'artifact-new': makeArtifact({ preview }) };
    rerender(<ArtifactCatalogRegistrar />);
    await act(flushRegistration);

    expect(mockEnqueueArtifactSync).toHaveBeenCalledTimes(2);
    expect(mockEnqueueArtifactSync.mock.calls[0]?.[3]).toBe(5_500);
    expect(mockEnqueueArtifactSync.mock.calls[1]?.[1].artifact.preview).toEqual(preview);
    expect(mockEnqueueArtifactSync.mock.calls[1]?.[3]).toBe(500);
  });
});
