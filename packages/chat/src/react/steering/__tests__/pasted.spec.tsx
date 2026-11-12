/**
 * @jest-environment jsdom
 */
import React from 'react';
import { createStore, Provider } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { ReactNode, SetStateAction } from 'react';
import type { ChatTurnsParams, TurnServices } from '../../chat/host';
import type { ExtendedFile, DuringRunAction } from '../../../core';
import type { SteerHost } from '../../steer/host';
import type { QueueEnqueue } from '../enqueue';
import type { SubmitSteer } from '../submit';
import {
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  pendingReasoningOverrideFamily,
} from '../../composer';
import { formatPastedText, isComposerFileTaken, releaseComposerFile } from '../../../core';
import { createTurnServices } from '../../chat/__fixtures__/services';
import { SteerHostProvider } from '../../steer/host';
import useDuringRunActions from '../actions';
import { useTurns } from '../../chat/turns';
import useComposerTake from '../composer';

const conversationId = 'paste-fallback-conversation';
const reasoningStateKey = conversationId;
const pastedText = '  exact local paste\r\n```\n`````\n ';

const pending = (): ExtendedFile => ({
  file_id: 'pending-paste',
  temp_file_id: 'paste-temp',
  progress: 0.2,
  size: pastedText.length,
  type: 'text/plain',
  pastedText,
});

const createFiles = (): Map<string, ExtendedFile> =>
  new Map([
    ['paste-key', pending()],
    ['done-key', { file_id: 'done-file', temp_file_id: 'done-temp', progress: 1, size: 1 }],
  ]);

const createHost = (
  cancelUploads: SteerHost['cancelUploads'],
  clearFilesToDelete: () => void,
  notify: ReturnType<SteerHost['useNotify']> = () => undefined,
): SteerHost => ({
  useSteerMessage: () => () => undefined,
  useSteerMessageAsync: () => async () => ({
    status: 'queued',
    steerId: 'steer-1',
    position: 0,
    conversationId,
  }),
  useCancelSteer: () => async () => ({ removed: true }),
  useArmSteer: () => async () => ({ armed: true }),
  useMarkFilesUsage: () => () => undefined,
  useEnqueueQueuedTurn: () => () => undefined,
  useCancelQueuedTurn: () => async () => {
    throw new Error('not queued');
  },
  useQueuedTurns: () => undefined,
  useQueuedTurnCache: () => ({ read: () => ({}), subscribe: () => () => undefined }),
  useFetchStreamStatus: () => async () => ({ active: false }),
  useRouteConversationId: () => undefined,
  useCodeApprovalInputs: () => ({ conversation: null, reachable: { agents: [], complete: true } }),
  useLocalize: () => (key) => key,
  useNotify: () => notify,
  useFileMap: () => undefined,
  useClearFilesToDelete: () => clearFilesToDelete,
  useSettings: () => ({
    duringRunDefaultAction: 'steer',
    setDuringRunDefaultAction: () => undefined,
    getPaneConversations: () => [],
  }),
  cancelUploads,
});

function setupSteering({
  files = createFiles(),
  accepted = true,
  filesLoading = false,
  canSteer = true,
  pendingReasoningOverride,
  effectiveAction = 'steer',
  withCancellation = true,
}: {
  files?: Map<string, ExtendedFile>;
  accepted?: boolean;
  filesLoading?: boolean;
  canSteer?: boolean;
  pendingReasoningOverride?: TMessage['reasoningOverride'];
  effectiveAction?: DuringRunAction;
  withCancellation?: boolean;
} = {}) {
  const store = createStore();
  let currentFiles = files;
  const setFiles = jest.fn((update: SetStateAction<Map<string, ExtendedFile>>) => {
    currentFiles = typeof update === 'function' ? update(currentFiles) : update;
  });
  const cancelUploads = jest.fn((ids: string[]) => {
    for (const id of ids) {
      expect(isComposerFileTaken(id)).toBe(true);
    }
  });
  const clearFilesToDelete = jest.fn();
  const discardFiles = jest.fn();
  const submitSteer = jest.fn<ReturnType<SubmitSteer>, Parameters<SubmitSteer>>(() => accepted);
  const enqueue = jest.fn<
    ReturnType<QueueEnqueue['enqueue']>,
    Parameters<QueueEnqueue['enqueue']>
  >();
  const takeComposerDraft = jest.fn();
  const armDrainAfterAbort = jest.fn();
  const stopGenerating = jest.fn();
  const notify = jest.fn();
  const host = createHost(withCancellation ? cancelUploads : undefined, clearFilesToDelete, notify);
  const { result } = renderHook(
    () => {
      const composer = useComposerTake({
        conversationId,
        reasoningStateKey,
        files,
        setFiles,
        discardFiles,
      });
      return useDuringRunActions({
        composerDisabledRef: { current: false },
        filesLoading,
        canSteer,
        canControlGeneration: true,
        hasRealConvoId: true,
        duringRunActive: true,
        pausedOnApproval: false,
        effectiveAction,
        pendingReasoningOverride,
        enqueue,
        composer,
        takeComposerDraft,
        submitSteer,
        armDrainAfterAbort,
        stopGenerating,
      });
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Provider store={store}>
          <SteerHostProvider host={host}>{children}</SteerHostProvider>
        </Provider>
      ),
    },
  );
  return {
    actions: result.current,
    notify,
    files: () => currentFiles,
    store,
    setFiles,
    cancelUploads,
    clearFilesToDelete,
    discardFiles,
    submitSteer,
    enqueue,
    takeComposerDraft,
    armDrainAfterAbort,
    stopGenerating,
  };
}

beforeEach(() => {
  for (const id of [
    'paste-key',
    'pending-paste',
    'paste-temp',
    'done-key',
    'done-file',
    'done-temp',
    'source-key',
    'source-id',
  ]) {
    releaseComposerFile(id);
  }
});

describe('during-run pasted text fallback', () => {
  it.each(['steer', 'queue', 'interrupt'] as const)(
    'accepts a paste-only draft through %s without waiting for its upload',
    (effectiveAction) => {
      const chat = setupSteering({ files: new Map([['paste-key', pending()]]), effectiveAction });
      act(() => {
        expect(chat.actions.submitDuringRun('  ')).toBe(true);
      });
      const expected = formatPastedText(pastedText);
      if (effectiveAction === 'queue') {
        expect(chat.enqueue).toHaveBeenCalledWith(expected, { files: [] });
      } else {
        expect(chat.submitSteer).toHaveBeenCalledWith(
          expected,
          [],
          {},
          {
            preempt: effectiveAction === 'interrupt',
          },
        );
      }
      expect(chat.cancelUploads).toHaveBeenCalledWith(['paste-key', 'pending-paste', 'paste-temp']);
      expect(chat.files().size).toBe(0);
      expect(chat.takeComposerDraft).toHaveBeenCalledTimes(1);
      expect(isComposerFileTaken('pending-paste')).toBe(true);
    },
  );

  it.each([
    'steerFromComposer',
    'queueFromComposer',
    'interruptAndSend',
    'interruptSteer',
  ] as const)('preserves an oversized pending paste and its context through %s', (action) => {
    const file = { ...pending(), pastedText: 'large document '.repeat(1700) };
    const chat = setupSteering({ files: new Map([['paste-key', file]]) });
    chat.store.set(pendingQuotesByConvoId(conversationId), ['keep this quote']);
    act(() => expect(chat.actions[action]('Review this')).toBe(false));
    expect(chat.files().get('paste-key')).toBe(file);
    expect(chat.cancelUploads).not.toHaveBeenCalled();
    expect(chat.setFiles).not.toHaveBeenCalled();
    expect(chat.enqueue).not.toHaveBeenCalled();
    expect(chat.submitSteer).not.toHaveBeenCalled();
    expect(chat.takeComposerDraft).not.toHaveBeenCalled();
    expect(chat.stopGenerating).not.toHaveBeenCalled();
    expect(chat.store.get(pendingQuotesByConvoId(conversationId))).toEqual(['keep this quote']);
    expect(chat.notify).toHaveBeenCalledWith({
      message: 'com_ui_pasted_text_wait_upload',
      status: 'warning',
    });
    const completed = setupSteering({
      files: new Map([['paste-key', { ...file, progress: 1, file_id: 'stored-paste' }]]),
    });
    act(() => expect(completed.actions[action]('Review this')).toBe(true));
    expect(completed.cancelUploads).not.toHaveBeenCalled();
    expect(completed.files().size).toBe(0);
  });

  it('steers completed file refs beside inline pending text, then cancels only the pending paste', () => {
    const chat = setupSteering();
    chat.store.set(pendingQuotesByConvoId(conversationId), ['quote']);
    chat.store.set(pendingManualSkillsByConvoId(conversationId), ['skill']);
    act(() => {
      expect(chat.actions.steerFromComposer(' Prompt ')).toBe(true);
    });
    expect(chat.submitSteer).toHaveBeenCalledWith(
      `Prompt\n\n${formatPastedText(pastedText)}`,
      [expect.objectContaining({ file_id: 'done-file' })],
      { quotes: ['quote'] },
      { preempt: false },
    );
    expect(chat.submitSteer.mock.invocationCallOrder[0]).toBeLessThan(
      chat.cancelUploads.mock.invocationCallOrder[0],
    );
    expect(chat.cancelUploads).toHaveBeenCalledWith(['paste-key', 'pending-paste', 'paste-temp']);
    expect(chat.store.get(pendingQuotesByConvoId(conversationId))).toEqual([]);
    expect(chat.store.get(pendingManualSkillsByConvoId(conversationId))).toEqual(['skill']);
    expect(isComposerFileTaken('done-file')).toBe(true);
    expect(isComposerFileTaken('pending-paste')).toBe(true);
  });

  it('preserves attachments, quotes and draft on a refused steer', () => {
    const files = createFiles();
    const chat = setupSteering({ files, accepted: false });
    chat.store.set(pendingQuotesByConvoId(conversationId), ['quote']);
    act(() => {
      expect(chat.actions.steerFromComposer('Prompt')).toBe(false);
    });
    expect(chat.files()).toBe(files);
    expect(chat.setFiles).not.toHaveBeenCalled();
    expect(chat.cancelUploads).not.toHaveBeenCalled();
    expect(chat.clearFilesToDelete).not.toHaveBeenCalled();
    expect(chat.takeComposerDraft).not.toHaveBeenCalled();
    expect(chat.store.get(pendingQuotesByConvoId(conversationId))).toEqual(['quote']);
    expect(isComposerFileTaken('done-file')).toBe(false);
    expect(isComposerFileTaken('pending-paste')).toBe(false);
  });

  it.each([
    'queueFromComposer',
    'steerFromComposer',
    'interruptAndSend',
    'interruptSteer',
  ] as const)(
    'blocks ordinary pending uploads at %s even if the host loading flag is false',
    (action) => {
      const files = createFiles();
      files.set('ordinary', {
        file_id: 'ordinary',
        progress: 0.5,
        size: 1,
        filename: 'pasted-text.txt',
        text: 'extracted',
      });
      const chat = setupSteering({ files });
      act(() => {
        expect(chat.actions[action]('Prompt')).toBe(false);
      });
      expect(chat.submitSteer).not.toHaveBeenCalled();
      expect(chat.enqueue).not.toHaveBeenCalled();
      expect(chat.cancelUploads).not.toHaveBeenCalled();
      expect(chat.setFiles).not.toHaveBeenCalled();
    },
  );

  it('preserves pending pastes when host loading or generation guards refuse', () => {
    for (const options of [{ filesLoading: true }, { canSteer: false }]) {
      const chat = setupSteering(options);
      act(() => {
        expect(chat.actions.steerFromComposer('Prompt')).toBe(false);
      });
      expect(chat.setFiles).not.toHaveBeenCalled();
      expect(chat.cancelUploads).not.toHaveBeenCalled();
    }
  });

  it('queues a staged reasoning choice with the inline paste and all turn context', () => {
    const reasoningOverride = { key: 'reasoning_effort', value: 'high' } as NonNullable<
      TMessage['reasoningOverride']
    >;
    const chat = setupSteering({ pendingReasoningOverride: reasoningOverride });
    chat.store.set(pendingQuotesByConvoId(conversationId), ['quote']);
    chat.store.set(pendingManualSkillsByConvoId(conversationId), ['skill']);
    chat.store.set(pendingReasoningOverrideFamily(reasoningStateKey), reasoningOverride);
    act(() => {
      expect(chat.actions.steerFromComposer('Prompt')).toBe(true);
    });
    expect(chat.submitSteer).not.toHaveBeenCalled();
    expect(chat.enqueue).toHaveBeenCalledWith(`Prompt\n\n${formatPastedText(pastedText)}`, {
      files: [expect.objectContaining({ file_id: 'done-file' })],
      quotes: ['quote'],
      manualSkills: ['skill'],
      reasoningOverride,
    });
    expect(chat.store.get(pendingReasoningOverrideFamily(reasoningStateKey))).toBeUndefined();
  });

  it('interrupts and queues a paste-only turn at the front', () => {
    const chat = setupSteering({ files: new Map([['paste-key', pending()]]) });
    act(() => {
      expect(chat.actions.interruptAndSend('')).toBe(true);
    });
    expect(chat.enqueue).toHaveBeenCalledWith(formatPastedText(pastedText), {
      files: [],
      front: true,
    });
    expect(chat.armDrainAfterAbort).toHaveBeenCalledTimes(1);
    expect(chat.stopGenerating).toHaveBeenCalledTimes(1);
  });

  it('omits an edited paste source without canceling it or marking it submitted', () => {
    const files = new Map<string, ExtendedFile>([
      ['source-key', { file_id: 'source-id', progress: 1, size: 1 }],
      ['paste-key', { ...pending(), replacesFileId: 'source-id' }],
    ]);
    const chat = setupSteering({ files });
    act(() => {
      expect(chat.actions.queueFromComposer('')).toBe(true);
    });
    expect(chat.enqueue).toHaveBeenCalledWith(formatPastedText(pastedText), { files: [] });
    expect(chat.cancelUploads).toHaveBeenCalledWith(['paste-key', 'pending-paste', 'paste-temp']);
    expect(isComposerFileTaken('source-id')).toBe(true);
    expect(chat.discardFiles).toHaveBeenCalledWith(['source-key', 'source-id']);
    expect(chat.files().size).toBe(0);
  });

  it('preserves an attachment staged during submission through the functional removal', () => {
    const files = createFiles();
    const chat = setupSteering({ files });
    chat.submitSteer.mockImplementation(() => {
      files.set('new-upload', { file_id: 'new-upload', progress: 0, size: 1 });
      return true;
    });
    act(() => {
      expect(chat.actions.steerFromComposer('Prompt')).toBe(true);
    });
    expect([...chat.files().keys()]).toEqual(['new-upload']);
  });

  it('allows hosts without optional upload cancellation', () => {
    const chat = setupSteering({ withCancellation: false });
    act(() => {
      expect(chat.actions.queueFromComposer('Prompt')).toBe(true);
    });
    expect(chat.cancelUploads).not.toHaveBeenCalled();
    expect(chat.files().size).toBe(0);
  });
});

const conversation: TConversation = {
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: null,
  createdAt: '2026-11-09T00:00:00Z',
  updatedAt: '2026-11-09T00:00:00Z',
};

function setupTurn(files: Map<string, ExtendedFile>, overrides: Partial<TurnServices> = {}) {
  const services = createTurnServices({
    cancelUploads: jest.fn((ids: string[]) => {
      for (const id of ids) {
        expect(isComposerFileTaken(id)).toBe(true);
      }
    }),
    discardFiles: jest.fn((ids: string[]) => {
      for (const id of ids) {
        expect(isComposerFileTaken(id)).toBe(true);
      }
    }),
    ...overrides,
  });
  const setFiles = jest.fn();
  const setSubmission = jest.fn();
  const setMessages = jest.fn();
  const params: ChatTurnsParams = {
    index: 0,
    files,
    setFiles,
    getMessages: () => [],
    setMessages,
    isSubmitting: false,
    conversation,
    latestMessage: null,
    setSubmission,
    setConversation: jest.fn(),
  };
  const queryClient = new QueryClient();
  const { result } = renderHook(() => useTurns(params, services), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <Provider>{children}</Provider>
      </QueryClientProvider>
    ),
  });
  return { turns: result.current, services, setFiles, setSubmission, setMessages };
}

describe('ordinary-send pasted text effects', () => {
  it('submits inline text, releases only real refs, and cancels the accepted paste once', () => {
    const chat = setupTurn(createFiles());
    act(() => {
      expect(chat.turns.ask({ text: 'Prompt' })).toBeUndefined();
      expect(chat.turns.ask({ text: 'Prompt' })).toBe(false);
    });
    expect(chat.setSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.objectContaining({
          text: `Prompt\n\n${formatPastedText(pastedText)}`,
          files: [expect.objectContaining({ file_id: 'done-file' })],
        }),
      }),
    );
    expect(chat.services.releaseFiles).toHaveBeenCalledWith(['done-key', 'done-file', 'done-temp']);
    expect(chat.services.cancelUploads).toHaveBeenCalledTimes(1);
    expect(chat.services.cancelUploads).toHaveBeenCalledWith([
      'paste-key',
      'pending-paste',
      'paste-temp',
    ]);
    expect(chat.setFiles).toHaveBeenCalledWith(new Map());
  });

  it('discards a superseded uploaded source separately from cancellation and submitted refs', () => {
    const files = new Map<string, ExtendedFile>([
      ['source-key', { file_id: 'source-id', progress: 1, size: 1 }],
      ['paste-key', { ...pending(), replacesFileId: 'source-id' }],
    ]);
    const chat = setupTurn(files);
    act(() => {
      expect(chat.turns.ask({ text: 'Prompt' })).toBeUndefined();
    });
    expect(chat.services.releaseFiles).toHaveBeenCalledWith([]);
    expect(chat.services.cancelUploads).toHaveBeenCalledWith([
      'paste-key',
      'pending-paste',
      'paste-temp',
    ]);
    expect(chat.services.discardFiles).toHaveBeenCalledWith(['source-key', 'source-id']);
    expect(chat.setSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.objectContaining({
          files: [],
          text: `Prompt\n\n${formatPastedText(pastedText)}`,
        }),
      }),
    );
  });

  it('accepts an empty text draft with only a pending pasted chip', () => {
    const chat = setupTurn(new Map([['paste-key', pending()]]));
    act(() => {
      expect(chat.turns.ask({ text: '' })).toBeUndefined();
    });
    expect(chat.setSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.objectContaining({ text: formatPastedText(pastedText), files: [] }),
      }),
    );
    expect(chat.services.releaseFiles).toHaveBeenCalledWith([]);
  });

  it('leaves a refused draft and every attachment untouched', () => {
    const files = createFiles();
    const chat = setupTurn(files, { canSubmit: () => false });
    act(() => {
      expect(chat.turns.ask({ text: 'Prompt' })).toBe(false);
    });
    expect(chat.services.cancelUploads).not.toHaveBeenCalled();
    expect(chat.services.releaseFiles).not.toHaveBeenCalled();
    expect(chat.services.discardFiles).not.toHaveBeenCalled();
    expect(chat.services.clearFilesToDelete).not.toHaveBeenCalled();
    expect(chat.setFiles).not.toHaveBeenCalled();
    expect(chat.setSubmission).not.toHaveBeenCalled();
    expect(files.size).toBe(2);
  });

  it('blocks an ordinary pending upload instead of sending an incomplete server ref', () => {
    const files = createFiles();
    files.set('ordinary', {
      file_id: 'ordinary',
      progress: 0,
      size: 1,
      filename: 'pasted-text.txt',
    });
    const chat = setupTurn(files);
    act(() => {
      expect(chat.turns.ask({ text: 'Prompt' })).toBe(false);
    });
    expect(chat.services.cancelUploads).not.toHaveBeenCalled();
    expect(chat.setFiles).not.toHaveBeenCalled();
    expect(chat.setSubmission).not.toHaveBeenCalled();
  });

  it('honors an empty override without consuming or canceling the staged paste', () => {
    const chat = setupTurn(createFiles());
    act(() => {
      expect(chat.turns.ask({ text: 'Override' }, { overrideFiles: [] })).toBeUndefined();
    });
    expect(chat.setSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.objectContaining({ text: 'Override' }),
      }),
    );
    expect(chat.services.cancelUploads).not.toHaveBeenCalled();
    expect(chat.setFiles).not.toHaveBeenCalled();
  });
});
