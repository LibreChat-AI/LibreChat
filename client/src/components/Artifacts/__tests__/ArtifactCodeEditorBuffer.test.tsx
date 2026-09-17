import React, { useEffect } from 'react';
import { ThemeContext } from '@librechat/client';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { editor } from 'monaco-editor';
import type { Artifact } from '~/common';
import { EditorProvider, useCodeState } from '~/Providers/EditorContext';
import { ArtifactCodeEditor } from '../ArtifactCodeEditor';

interface MonacoEditorProps {
  onChange?: (value: string | undefined) => void;
}

const editorProps: MonacoEditorProps = {};

/** One save at a time, settled by the test the way the server would. */
let inFlight: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null;
const mockEditArtifact = jest.fn(
  (vars: unknown) =>
    new Promise((resolve, reject) => {
      inFlight = {
        resolve: () =>
          resolve({ ...(vars as object), content: '', text: '', conversationId: null }),
        reject,
      };
    }),
);

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: MonacoEditorProps) => {
    Object.assign(editorProps, props);
    return null;
  },
}));

jest.mock('~/Providers', () => ({
  useArtifactsContext: () => ({ isSubmitting: false }),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { editArtifact: (vars: unknown) => mockEditArtifact(vars) },
}));

const artifactA: Artifact = {
  id: 'artifact-a',
  lastUpdateTime: 0,
  index: 0,
  messageId: 'msg-a',
  content: 'CONTENT-A',
  type: 'text/plain',
};

const artifactB: Artifact = {
  id: 'artifact-b',
  lastUpdateTime: 0,
  index: 1,
  messageId: 'msg-b',
  content: 'CONTENT-B',
  type: 'text/plain',
};

/**
 * Monaco reports a programmatic `setValue` through `onChange` exactly like a
 * keystroke, which is the behaviour these cases turn on.
 */
const createModel = (initial: string) => {
  let value = initial;
  const model = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      editorProps.onChange?.(next);
    },
    getLineCount: () => 1,
    getValueLength: () => value.length,
    getPositionAt: () => ({ lineNumber: 1, column: value.length + 1 }),
    applyEdits: jest.fn(),
  };
  const ed = {
    getModel: () => model,
    revealLine: jest.fn(),
  } as unknown as editor.IStandaloneCodeEditor;
  return { ed, read: () => value };
};

type Session = {
  endCodeSession: () => void;
  buffer: { code?: string; artifactId?: string };
};

const session: Session = { endCodeSession: () => {}, buffer: {} };

/** Publishes the shared editing state the pane's hosts drive. */
function SessionProbe() {
  const { currentCode, codeArtifactId, endCodeSession } = useCodeState();
  useEffect(() => {
    session.endCodeSession = endCodeSession;
    session.buffer = { code: currentCode, artifactId: codeArtifactId };
  });
  return null;
}

/**
 * The provider sits above the pane's hosts, so closing the pane unmounts the
 * editor while the session state and any running save stay where they are.
 */
const renderEditor = (initial: Artifact, monacoRef: React.MutableRefObject<any>) => {
  let current = initial;
  let paneOpen = true;
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <ThemeContext.Provider
        value={
          { resolvedMode: 'dark', highContrast: false } as React.ContextType<typeof ThemeContext>
        }
      >
        <EditorProvider>
          <SessionProbe />
          {paneOpen ? <ArtifactCodeEditor artifact={current} monacoRef={monacoRef} /> : null}
        </EditorProvider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
  const utils = render(tree());
  const rerender = () =>
    act(() => {
      utils.rerender(tree());
    });
  return {
    ...utils,
    select: (next: Artifact) => {
      current = next;
      rerender();
    },
    closePane: () => {
      paneOpen = false;
      rerender();
    },
    reopenPane: () => {
      paneOpen = true;
      rerender();
    },
  };
};

const type = (value: string) => {
  act(() => {
    editorProps.onChange?.(value);
  });
};

const settleDebounce = () => {
  act(() => {
    jest.advanceTimersByTime(500);
  });
};

/** Let the mutation's own promise chain and React Query's notify batch run. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await Promise.resolve();
  });
};

describe('ArtifactCodeEditor unsaved text across a selection change', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEditArtifact.mockClear();
    inFlight = null;
    editorProps.onChange = undefined;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('keeps the unsaved text of the artifact the user left', () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);

    expect(session.buffer).toEqual({ code: 'EDITED-A', artifactId: 'artifact-a' });
    expect(mockEditArtifact).not.toHaveBeenCalled();
  });

  it('restores that text and saves it when the artifact is selected again', async () => {
    const { ed, read } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);
    expect(read()).toBe('CONTENT-B');

    view.select(artifactA);
    await flush();

    expect(read()).toBe('EDITED-A');
    expect(mockEditArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-a', original: 'CONTENT-A', updated: 'EDITED-A' }),
    );
  });

  /* The save that held the lock has already replaced the content the queued
   * edit was typed against, so sending that stale `original` would have the
   * endpoint reject the newest text. */
  it('sends a queued edit against the content the finished save left', async () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    renderEditor(artifactA, monacoRef);

    type('FIRST-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* Typed while the first save is still running: queued, not sent. */
    type('SECOND-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The save lands. The registry still holds the pre-save content — it
     * catches up only when the edited message propagates — so the queued edit
     * has to be rebased on what the request wrote, not on what is on screen. */
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'msg-a',
        original: 'FIRST-EDIT',
        updated: 'SECOND-EDIT',
      }),
    );
  });

  /* The save is the request's, not the session's: a pane closed mid-save must
   * neither release it nor let the next session write over it. */
  it('waits for a save the closed session started before sending the next edit', async () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDIT-BEFORE-CLOSE');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The pane is closed and reopened while that save is still running. */
    act(() => {
      session.endCodeSession();
    });
    view.closePane();
    view.reopenPane();
    type('EDIT-AFTER-REOPEN');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'msg-a',
        original: 'EDIT-BEFORE-CLOSE',
        updated: 'EDIT-AFTER-REOPEN',
      }),
    );
  });

  it('does not resubmit rejected text when the editor remounts in the same session', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    view.closePane();
    view.reopenPane();
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  it('saves a new edit after a rejected buffer is remounted', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    view.closePane();
    view.reopenPane();
    type('NEW-EDIT');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ updated: 'NEW-EDIT' }),
    );
  });

  /* A save answers after the user has moved on, so the refusal has to be
   * recorded against the artifact whose text was refused. Filed under the
   * artifact on screen instead, it would let the one that was rejected send
   * the same text again the moment the user came back to it. */
  it('records a refusal against the artifact whose save was refused', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-A');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select(artifactB);
    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  /* A save for the artifact the user left can land while they are reading
   * another one, and the registry catches up only when the edited message
   * propagates. The edit restored on the way back replaces what that save
   * wrote, not what the registry still says, or the endpoint refuses it and
   * the text the user typed never lands. */
  it('rebases a restored edit on what the last save actually wrote', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('SAVED-A');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* A second edit whose debounce the selection change cancels. */
    type('RETAINED-A');
    view.select(artifactB);
    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'SAVED-A', updated: 'RETAINED-A' }),
    );
  });
});
