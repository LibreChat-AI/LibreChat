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
  let readOnly = false;
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
          {paneOpen ? (
            <ArtifactCodeEditor artifact={current} monacoRef={monacoRef} readOnly={readOnly} />
          ) : null}
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
    setReadOnly: (next: boolean) => {
      readOnly = next;
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

  /* Editing the artifact the user moved to must not evict the text the one
   * they left was holding: its debounce died with the selection change, so the
   * retained copy is the only place it still lives. Reported by Codex on
   * 591ab13c96 (P1). */
  it('restores the text of the left artifact after another is edited', async () => {
    const { ed, read } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);
    type('EDITED-B');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select(artifactA);
    await flush();

    /* The restored edit queues behind the running save of the other artifact,
     * and that save's callbacks send it once it lands. */
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(read()).toBe('EDITED-A');
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-a', original: 'CONTENT-A', updated: 'EDITED-A' }),
    );
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

  /* The registry can also move past this session's save from the outside:
   * another tab or session edits the artifact and the messages query
   * refetches what they wrote. The local save is then the older truth, and
   * preferring it would have the endpoint refuse every further edit. */
  it('rebases on content that moved past the local save', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('LOCAL-SAVE');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The messages query brings what another session wrote. */
    view.select({ ...artifactA, content: 'FOREIGN-CONTENT' });
    await flush();

    type('AFTER-REFRESH');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'FOREIGN-CONTENT', updated: 'AFTER-REFRESH' }),
    );
  });

  /* Two artifacts can both have a refusal on file: one marker must not be
   * overwritten by the other's, or the older refusal is forgotten and its
   * text goes back on the wire when the user returns to it. */
  it('keeps a refusal for each artifact that was refused', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-A');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select(artifactB);
    type('REJECTED-B');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(2);

    /* B's refusal must not make A's text eligible again. */
    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
  });

  /* Clearing the editor is mid-edit, not a deletion: typing never saves an
   * empty buffer, so no path that resubmits retained text may either — a host
   * change would otherwise persist the removal of the whole artifact. */
  it('does not persist a cleared editor when the pane changes hosts', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).not.toHaveBeenCalled();

    view.closePane();
    view.reopenPane();
    await flush();

    expect(mockEditArtifact).not.toHaveBeenCalled();

    view.select(artifactB);
    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).not.toHaveBeenCalled();
  });

  /* The pane changes hosts while a save is running and the user keeps typing:
   * the text they typed in the new instance is the newest thing in play, so
   * the buffer it inherited at mount must not be sent after it and put the
   * artifact back the way it was. */
  it('does not undo a newer edit with the buffer it inherited at mount', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDIT-OLD');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The host change happens while that save is still open. */
    view.closePane();
    view.reopenPane();
    await flush();

    type('EDIT-NEW');
    settleDebounce();
    await flush();

    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ updated: 'EDIT-NEW' }),
    );
  });

  /* A response starts while an edit is still waiting on its debounce, and the
   * pane changes hosts before it saves: the edit is inherited by an editor
   * that cannot save yet. It has to survive until editing returns, then be
   * saved and stay on screen rather than give way to the persisted content. */
  it('saves an inherited edit once a generation ends', async () => {
    const model = createModel('CONTENT-A');
    const monacoRef = { current: model.ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDIT-A');
    view.setReadOnly(true);
    view.closePane();
    view.reopenPane();
    settleDebounce();
    await flush();
    expect(mockEditArtifact).not.toHaveBeenCalled();

    view.setReadOnly(false);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CONTENT-A', updated: 'EDIT-A' }),
    );
    expect(model.read()).toBe('EDIT-A');
  });

  const saveAndSettle = async (text: string) => {
    type(text);
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
  };

  /* Text this tab saved is not unsaved. When another session moves the
   * artifact on, a host change must not send the saved text back over it. */
  it('does not resend saved text over a newer change made elsewhere', async () => {
    const model = createModel('CONTENT-A');
    const monacoRef = { current: model.ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('SAVED-HERE');
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select({ ...artifactA, content: 'SAVED-HERE' });
    view.select({ ...artifactA, content: 'CHANGED-ELSEWHERE' });
    await flush();

    view.closePane();
    view.reopenPane();
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(model.read()).toBe('CHANGED-ELSEWHERE');
  });

  /* Once the registry has shown this tab's save, a later change back to an
   * earlier value is made elsewhere, not lag, and the next edit replaces it. */
  it('rebases on an earlier value restored elsewhere after the save landed', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('SAVED-HERE');
    view.select({ ...artifactA, content: 'SAVED-HERE' });
    await flush();
    view.select({ ...artifactA, content: 'CONTENT-A' });
    await flush();

    type('AFTER-REVERT');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CONTENT-A', updated: 'AFTER-REVERT' }),
    );
  });

  /* The user edits away and back to the text of a save that is still open.
   * When that save is refused, the queued copy of the same text is the refused
   * text and must not go out again. */
  it('does not retry a queued edit the running save was refused for', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    renderEditor(artifactA, monacoRef);

    type('REFUSED');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    type('DETOUR');
    settleDebounce();
    type('REFUSED');
    settleDebounce();
    await flush();

    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  /* Two saves land before the registry shows either. Once it shows the first
   * one, the value before it is history: the registry going back there later
   * is a change made elsewhere, not lag. */
  it('retires lag values the registry has already passed', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('ONE');
    await saveAndSettle('TWO');
    view.select({ ...artifactA, content: 'ONE' });
    await flush();
    view.select({ ...artifactA, content: 'CONTENT-A' });
    await flush();

    type('NEXT');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CONTENT-A', updated: 'NEXT' }),
    );
  });

  /* Only the copy a save wrote is known to be saved. A user who edits away
   * and back to that same text has made an edit, and it is sent. */
  it('sends an edit that returns to previously saved text', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('SAVED');
    view.select({ ...artifactA, content: 'SAVED' });
    await flush();

    type('DETOUR');
    type('SAVED');
    view.select(artifactB);
    view.select({ ...artifactA, content: 'CHANGED-ELSEWHERE' });
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CHANGED-ELSEWHERE', updated: 'SAVED' }),
    );
  });
});
