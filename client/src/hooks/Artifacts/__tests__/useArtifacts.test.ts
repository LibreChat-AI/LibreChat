import { getDefaultStore } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { renderHook, act } from '@testing-library/react';
import type { Artifact } from '~/common';
import { artifactsActiveTab } from '~/components/Artifacts/state';

/* Referenced only when `useCodeState` is called, so the mock factory running
 * before these initialize is fine. */
const mockEndCodeSession = jest.fn();

/** Mock dependencies */
jest.mock('~/Providers', () => ({
  useArtifactsContext: jest.fn(),
}));

jest.mock('~/utils', () => ({
  logger: {
    log: jest.fn(),
  },
}));

jest.mock('~/Providers/EditorContext', () => ({
  useCodeState: () => ({ endCodeSession: mockEndCodeSession }),
}));

/** Mock store before importing */
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    artifactsState: { key: 'artifactsState' },
    currentArtifactId: { key: 'currentArtifactId' },
    artifactsVisibility: { key: 'artifactsVisibility' },
  },
}));

jest.mock('recoil', () => {
  const actualRecoil = jest.requireActual('recoil');
  return {
    ...actualRecoil,
    useRecoilValue: jest.fn(),
    useRecoilState: jest.fn(),
    useResetRecoilState: jest.fn(),
    useRecoilCallback: jest.fn(),
  };
});

/** Import mocked functions after mocking */
import { useArtifactsContext } from '~/Providers';
import { useRecoilValue, useRecoilState, useRecoilCallback, useResetRecoilState } from 'recoil';
import { logger } from '~/utils';
import useArtifacts from '../useArtifacts';

describe('useArtifacts', () => {
  const mockResetArtifacts = jest.fn();
  const mockResetCurrentArtifactId = jest.fn();
  const mockSetCurrentArtifactId = jest.fn();

  const createArtifact = (partial: Partial<Artifact>): Artifact => ({
    id: 'artifact-1',
    title: 'Test Artifact',
    type: 'application/vnd.react',
    content: 'const App = () => <div>Test</div>',
    messageId: 'msg-1',
    lastUpdateTime: Date.now(),
    ...partial,
  });

  const defaultContext = {
    isSubmitting: false,
    latestMessageId: 'msg-1',
    latestMessageText: '',
    conversationId: 'conv-1',
  };
  /** What a fresh snapshot reports while the hook's cleanup runs. */
  const paneSnapshot: Record<string, unknown> = {
    artifactsVisibility: false,
    currentArtifactId: null,
  };
  /** `useRecoilCallback` hands back one stable callback; a mock that returned a
   *  new function per render would re-run every effect that depends on it. */
  let builtPaneCallback: () => unknown = () => undefined;
  const stablePaneCallback = () => builtPaneCallback();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    (useArtifactsContext as jest.Mock).mockReturnValue(defaultContext);
    (useRecoilValue as jest.Mock).mockReturnValue({});
    (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);
    (useResetRecoilState as jest.Mock).mockImplementation((atom) => {
      if (atom?.key === 'artifactsState') {
        return mockResetArtifacts;
      }
      if (atom?.key === 'currentArtifactId') {
        return mockResetCurrentArtifactId;
      }
      return jest.fn();
    });
    paneSnapshot.artifactsVisibility = false;
    paneSnapshot.currentArtifactId = null;
    (useRecoilCallback as jest.Mock).mockImplementation(
      (build: (iface: unknown) => () => unknown) => {
        builtPaneCallback = build({
          snapshot: {
            getLoadable: (atom: { key: string }) => ({
              valueMaybe: () => paneSnapshot[atom.key],
            }),
          },
        });
        return stablePaneCallback;
      },
    );
    /* The tab is pane state in a module-global store now, so one test's switch
     * would otherwise be the next test's starting point. */
    getDefaultStore().set(artifactsActiveTab, 'preview');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('should initialize with preview tab active', () => {
      const { result } = renderHook(() => useArtifacts());
      expect(result.current.activeTab).toBe('preview');
    });

    it('should return null currentArtifact when no artifacts exist', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      const { result } = renderHook(() => useArtifacts());
      expect(result.current.currentArtifact).toBeNull();
    });

    it('should return empty orderedArtifactIds when no artifacts exist', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      const { result } = renderHook(() => useArtifacts());
      expect(result.current.orderedArtifactIds).toEqual([]);
    });
  });

  describe('artifact ordering', () => {
    it('should order artifacts by lastUpdateTime', () => {
      const artifacts = {
        'artifact-3': createArtifact({ id: 'artifact-3', lastUpdateTime: 3000 }),
        'artifact-1': createArtifact({ id: 'artifact-1', lastUpdateTime: 1000 }),
        'artifact-2': createArtifact({ id: 'artifact-2', lastUpdateTime: 2000 }),
      };

      (useRecoilValue as jest.Mock).mockReturnValue(artifacts);

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.orderedArtifactIds).toEqual(['artifact-1', 'artifact-2', 'artifact-3']);
    });

    it('should automatically select latest artifact', () => {
      const artifacts = {
        'artifact-1': createArtifact({ id: 'artifact-1', lastUpdateTime: 1000 }),
        'artifact-2': createArtifact({ id: 'artifact-2', lastUpdateTime: 2000 }),
      };

      (useRecoilValue as jest.Mock).mockReturnValue(artifacts);

      renderHook(() => useArtifacts());

      expect(mockSetCurrentArtifactId).toHaveBeenCalledWith('artifact-2');
    });

    it('should automatically select the latest non-code artifact when a code file is newest', () => {
      const artifacts = {
        'artifact-1': createArtifact({ id: 'artifact-1', lastUpdateTime: 1000 }),
        'artifact-2': createArtifact({
          id: 'artifact-2',
          type: 'application/vnd.code',
          title: 'helper.py',
          lastUpdateTime: 2000,
        }),
      };

      (useRecoilValue as jest.Mock).mockReturnValue(artifacts);

      renderHook(() => useArtifacts());

      expect(mockSetCurrentArtifactId).toHaveBeenCalledWith('artifact-1');
      expect(mockSetCurrentArtifactId).not.toHaveBeenCalledWith('artifact-2');
    });
  });

  describe('tab switching - enclosed artifacts', () => {
    it('should switch to preview when enclosed artifact is detected during generation', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: false,
        latestMessageText: '',
      });

      const { result, rerender } = renderHook(() => useArtifacts());

      /** Generation starts with enclosed artifact */
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test"}\nconst App = () => <div>Test</div>\n:::',
      });

      rerender();

      /** Should switch to preview when enclosed detected */
      expect(result.current.activeTab).toBe('preview');
    });

    it('should switch to preview when enclosed artifact uses a longer code fence', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      const { result, rerender } = renderHook(() => useArtifacts());

      act(() => {
        result.current.setActiveTab('code');
      });

      expect(result.current.activeTab).toBe('code');

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: [
          ':::artifact{title="Git" type="text/markdown"}',
          '````markdown',
          '# Title',
          '```bash',
          'echo one',
          '```',
          '````',
          ':::',
        ].join('\n'),
      });

      rerender();

      expect(result.current.activeTab).toBe('preview');
    });

    it('should not switch to preview when an inner marker appears before the longer fence closes', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      const { result, rerender } = renderHook(() => useArtifacts());

      act(() => {
        result.current.setActiveTab('code');
      });

      expect(result.current.activeTab).toBe('code');

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: [
          ':::artifact{title="Git" type="text/markdown"}',
          '````markdown',
          '# Title',
          '```bash',
          'echo one',
          '```',
          ':::',
        ].join('\n'),
      });

      rerender();

      expect(result.current.activeTab).toBe('code');
      expect(logger.log).not.toHaveBeenCalledWith(
        'artifacts',
        expect.stringContaining('Enclosed artifact'),
      );
    });

    it('should not switch to preview if artifact is not enclosed', () => {
      const artifact = createArtifact({
        content: 'const App = () => <div>Test</div>',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({});
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      const { result, rerender } = renderHook(() => useArtifacts());

      /** Update with non-enclosed artifact */
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test"}\nconst App = () => <div>Test</div>',
      });

      rerender();

      /** Should switch to code since artifact content is in message and not enclosed */
      expect(result.current.activeTab).toBe('code');
      expect(logger.log).not.toHaveBeenCalledWith(
        'artifacts',
        expect.stringContaining('Enclosed artifact'),
      );
    });

    it('should only switch to preview once per artifact', () => {
      const artifact = createArtifact({});
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });

      const { rerender } = renderHook(() => useArtifacts());

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test"}\ncode\n:::',
      });

      rerender();

      const firstCallCount = (logger.log as jest.Mock).mock.calls.filter((call) =>
        call[1]?.includes('Enclosed artifact'),
      ).length;

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test"}\ncode\n:::\nMore text',
      });

      rerender();

      const secondCallCount = (logger.log as jest.Mock).mock.calls.filter((call) =>
        call[1]?.includes('Enclosed artifact'),
      ).length;

      expect(secondCallCount).toBe(firstCallCount);
    });
  });

  describe('tab switching - non-enclosed artifacts', () => {
    it('should switch to code when non-enclosed artifact content appears', () => {
      const artifact = createArtifact({
        content: 'const App = () => <div>Test Component</div>',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: 'Here is the code: const App = () => <div>Test Component</div>',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('code');
    });

    it('should not switch to code if artifact content is not in message text', () => {
      const artifact = createArtifact({
        content: 'const App = () => <div>Test</div>',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: 'Some other text here',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });
  });

  describe('conversation changes', () => {
    it('should reset artifacts when conversation changes', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});

      const { rerender } = renderHook(() => useArtifacts());

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        conversationId: 'conv-2',
      });

      rerender();

      expect(mockResetArtifacts).toHaveBeenCalled();
      expect(mockResetCurrentArtifactId).toHaveBeenCalled();
    });

    it('should reset artifacts when navigating to new conversation from another conversation', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});

      /** Start with existing conversation (NOT Constants.NEW_CONVO) */
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        conversationId: 'existing-conv',
      });

      const { rerender } = renderHook(() => useArtifacts());

      jest.clearAllMocks();

      /** Navigate to NEW_CONVO - this should trigger the else if branch */
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        conversationId: Constants.NEW_CONVO,
      });

      rerender();

      expect(mockResetArtifacts).toHaveBeenCalled();
      expect(mockResetCurrentArtifactId).toHaveBeenCalled();
    });

    it('should not reset artifacts on initial render', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      renderHook(() => useArtifacts());

      expect(mockResetArtifacts).not.toHaveBeenCalled();
      expect(mockResetCurrentArtifactId).not.toHaveBeenCalled();
    });

    it('should reset when transitioning from null to NEW_CONVO', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});

      /** Start with null conversationId */
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        conversationId: null,
      });

      const { rerender } = renderHook(() => useArtifacts());

      jest.clearAllMocks();

      /** Transition to NEW_CONVO - triggers the else if branch (line 44) */
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        conversationId: Constants.NEW_CONVO,
      });

      rerender();

      /** Should reset because we're now on NEW_CONVO */
      expect(mockResetArtifacts).toHaveBeenCalled();
      expect(mockResetCurrentArtifactId).toHaveBeenCalled();
    });

    it('should reset state flags when message ID changes', () => {
      const artifact = createArtifact({});
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{}\ncode\n:::',
        latestMessageId: 'msg-1',
      });

      const { result, rerender } = renderHook(() => useArtifacts());

      // First artifact becomes enclosed
      expect(result.current.activeTab).toBe('preview');

      // New message starts
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: 'New message',
        latestMessageId: 'msg-2',
      });

      rerender();

      // Should allow switching again for the new message
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{}\nnew code\n:::',
        latestMessageId: 'msg-2',
      });

      rerender();

      expect(result.current.activeTab).toBe('preview');
    });
  });

  describe('artifact selection preservation', () => {
    it('should preserve selection when a new artifact is added', () => {
      const artifact1 = createArtifact({ id: 'artifact-1', lastUpdateTime: 1000 });

      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact1 });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      const { rerender } = renderHook(() => useArtifacts());

      mockSetCurrentArtifactId.mockClear();

      /** Append a second artifact; mock still returns 'artifact-1' as current */
      const artifact2 = createArtifact({ id: 'artifact-2', lastUpdateTime: 2000 });
      (useRecoilValue as jest.Mock).mockReturnValue({
        'artifact-1': artifact1,
        'artifact-2': artifact2,
      });

      rerender();

      expect(mockSetCurrentArtifactId).not.toHaveBeenCalled();
    });

    it('should advance to new artifact during streaming', () => {
      const artifact1 = createArtifact({ id: 'artifact-1', lastUpdateTime: 1000, content: 'c1' });

      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact1 });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageId: 'msg-1',
      });

      const { rerender } = renderHook(() => useArtifacts());
      mockSetCurrentArtifactId.mockClear();

      const artifact2 = createArtifact({ id: 'artifact-2', lastUpdateTime: 2000, content: 'c2' });
      (useRecoilValue as jest.Mock).mockReturnValue({
        'artifact-1': artifact1,
        'artifact-2': artifact2,
      });

      rerender();

      expect(mockSetCurrentArtifactId).toHaveBeenCalledWith('artifact-2');
    });

    it('does not select a historical sibling artifact when regeneration begins', () => {
      const selected = createArtifact({
        id: 'selected',
        messageId: 'original-response',
        lastUpdateTime: 1000,
      });
      const historical = createArtifact({
        id: 'historical',
        messageId: 'previous-sibling',
        lastUpdateTime: 2000,
        content: 'old preview',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({ selected });
      (useRecoilState as jest.Mock).mockReturnValue(['selected', mockSetCurrentArtifactId]);
      const { rerender } = renderHook(() => useArtifacts());
      mockSetCurrentArtifactId.mockClear();

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageId: 'original-response_',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({ selected, historical });
      rerender();

      expect(mockSetCurrentArtifactId).not.toHaveBeenCalled();
    });

    it('should not advance to a new CODE artifact during streaming', () => {
      const artifact1 = createArtifact({ id: 'artifact-1', lastUpdateTime: 1000, content: 'c1' });

      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact1 });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageId: 'msg-1',
      });

      const { rerender } = renderHook(() => useArtifacts());
      mockSetCurrentArtifactId.mockClear();

      const artifact2 = createArtifact({
        id: 'artifact-2',
        type: 'application/vnd.code',
        title: 'helper.py',
        lastUpdateTime: 2000,
        content: 'print("hi")',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({
        'artifact-1': artifact1,
        'artifact-2': artifact2,
      });

      rerender();

      expect(mockSetCurrentArtifactId).not.toHaveBeenCalledWith('artifact-2');
    });

    it('should keep a manually selected CODE artifact selected', () => {
      const artifact = createArtifact({
        id: 'artifact-1',
        type: 'application/vnd.code',
        title: 'helper.py',
      });

      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.currentArtifact).toBe(artifact);
      expect(mockSetCurrentArtifactId).not.toHaveBeenCalledWith('artifact-1');
    });

    it('should keep selection null after an explicit reset', () => {
      const artifact1 = createArtifact({ id: 'artifact-1', lastUpdateTime: 1000 });

      /** First render: valid selection */
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact1 });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      const { rerender } = renderHook(() => useArtifacts());

      mockSetCurrentArtifactId.mockClear();

      /** Rerender: currentArtifactId transitions to null (user closed the panel) */
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      rerender();

      /** Should NOT bounce back to 'artifact-1' */
      expect(mockSetCurrentArtifactId).not.toHaveBeenCalled();
    });
  });

  describe('cleanup on unmount', () => {
    it('should reset artifacts and the tab when the pane closed', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});

      const { result, unmount } = renderHook(() => useArtifacts());
      act(() => result.current.setActiveTab('code'));

      unmount();

      expect(mockResetArtifacts).toHaveBeenCalled();
      expect(mockResetCurrentArtifactId).toHaveBeenCalled();
      expect(getDefaultStore().get(artifactsActiveTab)).toBe('preview');
      /* A buffer kept past the close would come back on the next open and be
       * submitted by the drain, so closing has to discard it. */
      expect(mockEndCodeSession).toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith('artifacts_visibility', 'Unmounting artifacts');
    });

    /* Moving the pane to another host — mobile sheet, undocked window —
     * unmounts one instance and mounts another while the pane stays open;
     * wiping the registry or the tab then would undo the move the user made. */
    it('keeps the artifacts and the tab when the pane is only changing hosts', () => {
      (useRecoilValue as jest.Mock).mockReturnValue({});
      paneSnapshot.artifactsVisibility = true;
      paneSnapshot.currentArtifactId = 'artifact-1';

      const { result, unmount } = renderHook(() => useArtifacts());
      act(() => result.current.setActiveTab('code'));
      unmount();

      expect(mockResetArtifacts).not.toHaveBeenCalled();
      expect(mockResetCurrentArtifactId).not.toHaveBeenCalled();
      expect(mockEndCodeSession).not.toHaveBeenCalled();
      expect(getDefaultStore().get(artifactsActiveTab)).toBe('code');
    });
  });

  describe('manual tab switching', () => {
    it('should allow manually switching tabs', () => {
      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');

      act(() => {
        result.current.setActiveTab('code');
      });

      expect(result.current.activeTab).toBe('code');
    });

    it('should allow switching back to preview after manual switch to code', () => {
      const { result } = renderHook(() => useArtifacts());

      act(() => {
        result.current.setActiveTab('code');
      });

      expect(result.current.activeTab).toBe('code');

      act(() => {
        result.current.setActiveTab('preview');
      });

      expect(result.current.activeTab).toBe('preview');
    });
  });

  describe('currentIndex calculation', () => {
    it('should return correct index for current artifact', () => {
      const artifacts = {
        'artifact-1': createArtifact({ id: 'artifact-1', lastUpdateTime: 1000 }),
        'artifact-2': createArtifact({ id: 'artifact-2', lastUpdateTime: 2000 }),
        'artifact-3': createArtifact({ id: 'artifact-3', lastUpdateTime: 3000 }),
      };

      (useRecoilValue as jest.Mock).mockReturnValue(artifacts);
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-2', mockSetCurrentArtifactId]);

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.currentIndex).toBe(1);
    });

    it('should return -1 for non-existent artifact', () => {
      const artifacts = {
        'artifact-1': createArtifact({ id: 'artifact-1' }),
      };

      (useRecoilValue as jest.Mock).mockReturnValue(artifacts);
      (useRecoilState as jest.Mock).mockReturnValue(['non-existent', mockSetCurrentArtifactId]);

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.currentIndex).toBe(-1);
    });
  });

  describe('complex scenarios', () => {
    it('should detect and handle enclosed artifacts during generation', async () => {
      /** Start fresh with enclosed artifact already present */
      (useRecoilValue as jest.Mock).mockReturnValue({});
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Component"}\nconst App = () => <div>Test</div>\n:::',
      });

      const { result } = renderHook(() => useArtifacts());

      /** Should detect enclosed pattern and be on preview */
      expect(result.current.activeTab).toBe('preview');
    });

    it('should handle multiple artifacts in sequence', () => {
      const artifact1 = createArtifact({ id: 'artifact-1', messageId: 'msg-1' });
      const artifact2 = createArtifact({ id: 'artifact-2', messageId: 'msg-2' });

      /** First artifact */
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact1 });
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{}\ncode1\n:::',
        latestMessageId: 'msg-1',
      });

      const { result, rerender } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');

      /** Second artifact starts (new message) */
      (useRecoilValue as jest.Mock).mockReturnValue({
        'artifact-1': artifact1,
        'artifact-2': artifact2,
      });
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: 'Here is another one',
        latestMessageId: 'msg-2',
      });

      rerender();

      /** Second artifact becomes enclosed */
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{}\ncode2\n:::',
        latestMessageId: 'msg-2',
      });

      rerender();

      expect(result.current.activeTab).toBe('preview');
    });
  });

  describe('edge cases', () => {
    it('should handle null artifacts gracefully', () => {
      (useRecoilValue as jest.Mock).mockReturnValue(null);

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.orderedArtifactIds).toEqual([]);
      expect(result.current.currentArtifact).toBeNull();
    });

    it('should handle undefined artifacts gracefully', () => {
      (useRecoilValue as jest.Mock).mockReturnValue(undefined);

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.orderedArtifactIds).toEqual([]);
      expect(result.current.currentArtifact).toBeNull();
    });

    it('should handle empty latestMessageText', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: '',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });

    it('should handle malformed artifact syntax', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact\ncode but no closing',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });

    it('should handle artifact with only opening tag', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test"}',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });
  });

  describe('artifact content comparison', () => {
    it('should not switch tabs when artifact content does not change', () => {
      const artifact = createArtifact({});
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: 'Some text',
      });

      const { result, rerender } = renderHook(() => useArtifacts());

      const initialTab = result.current.activeTab;

      /** Same content, just rerender */
      rerender();

      expect(result.current.activeTab).toBe(initialTab);
    });
  });

  describe('isSubmitting state handling', () => {
    it('should process when isSubmitting is true', () => {
      const artifact = createArtifact({});
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue(['artifact-1', mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{}\ncode\n:::',
      });

      renderHook(() => useArtifacts());

      expect(mockSetCurrentArtifactId).toHaveBeenCalled();
    });

    it('should still select latest artifact even when idle (via orderedArtifactIds effect)', () => {
      const artifact = createArtifact({});
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: false,
        latestMessageText: 'Some text',
      });

      renderHook(() => useArtifacts());

      /** The orderedArtifactIds effect always runs when artifacts change */
      expect(mockSetCurrentArtifactId).toHaveBeenCalledWith('artifact-1');
    });

    it('should not auto-select an idle CODE artifact', () => {
      const artifact = createArtifact({
        id: 'artifact-1',
        type: 'application/vnd.code',
        title: 'helper.py',
      });
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: false,
        latestMessageText: 'Some text',
      });

      renderHook(() => useArtifacts());

      expect(mockSetCurrentArtifactId).not.toHaveBeenCalled();
    });

    it('should not process when latestMessageId is null', () => {
      const artifact = createArtifact({});
      (useRecoilValue as jest.Mock).mockReturnValue({ 'artifact-1': artifact });
      (useRecoilState as jest.Mock).mockReturnValue([null, mockSetCurrentArtifactId]);

      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageId: null,
        latestMessageText: ':::artifact{}\ncode\n:::',
      });

      const { result } = renderHook(() => useArtifacts());

      /** Main effect should exit early and not switch tabs */
      expect(result.current.activeTab).toBe('preview');
    });
  });

  describe('regex pattern matching', () => {
    it('should match artifact with title attribute', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="My Component"}\ncode\n:::',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });

    it('should match artifact with multiple attributes', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test" type="react" identifier="comp-1"}\ncode\n:::',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });

    it('should match artifact with code blocks inside', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{}\n```typescript\nconst x = 1;\n```\n:::',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });

    it('should match artifact with whitespace variations', () => {
      (useArtifactsContext as jest.Mock).mockReturnValue({
        ...defaultContext,
        isSubmitting: true,
        latestMessageText: ':::artifact{title="Test"}  \n\n  code here  \n\n  :::',
      });

      const { result } = renderHook(() => useArtifacts());

      expect(result.current.activeTab).toBe('preview');
    });
  });
});
