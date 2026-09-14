import React, { useEffect } from 'react';
import { ThemeContext } from '@librechat/client';
import { render, act } from '@testing-library/react';
import type { editor } from 'monaco-editor';
import type { Artifact } from '~/common';
import { EditorProvider, useCodeState, useMutationState } from '~/Providers/EditorContext';
import { ArtifactCodeEditor } from '../ArtifactCodeEditor';

interface MutationVars {
  updated: string;
  messageId: string;
  index: number;
  original?: string;
}

interface MutationHandlers {
  onMutate?: (vars: MutationVars) => void;
  onSuccess?: (data: unknown, vars: MutationVars) => void;
  onError?: (error?: unknown) => void;
}

interface MonacoEditorProps {
  onChange?: (value: string | undefined) => void;
}

const editorProps: MonacoEditorProps = {};
const handlers: MutationHandlers = {};

const mockMutate = jest.fn((vars: MutationVars) => {
  handlers.onMutate?.(vars);
});

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

jest.mock('~/data-provider', () => ({
  useEditArtifact: (given: MutationHandlers) => {
    handlers.onMutate = given.onMutate;
    handlers.onSuccess = given.onSuccess;
    handlers.onError = given.onError;
    return { mutate: mockMutate };
  },
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
  const writes: string[] = [];
  const model = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      writes.push(next);
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
  return { ed, writes, read: () => value };
};

type Session = {
  endCodeSession: () => void;
  setIsMutating: (next: boolean) => void;
  buffer: { code?: string; artifactId?: string };
};

const session: Session = {
  endCodeSession: () => {},
  setIsMutating: () => {},
  buffer: {},
};

/** Publishes the shared editing state the pane's hosts drive. */
function SessionProbe() {
  const { currentCode, codeArtifactId, endCodeSession } = useCodeState();
  const { setIsMutating } = useMutationState();
  useEffect(() => {
    session.endCodeSession = endCodeSession;
    session.setIsMutating = setIsMutating;
    session.buffer = { code: currentCode, artifactId: codeArtifactId };
  });
  return null;
}

const renderEditor = (initial: Artifact, monacoRef: React.MutableRefObject<any>) => {
  let current = initial;
  const tree = () => (
    <ThemeContext.Provider
      value={
        { resolvedMode: 'dark', highContrast: false } as React.ContextType<typeof ThemeContext>
      }
    >
      <EditorProvider>
        <SessionProbe />
        <ArtifactCodeEditor artifact={current} monacoRef={monacoRef} />
      </EditorProvider>
    </ThemeContext.Provider>
  );
  const utils = render(tree());
  return {
    ...utils,
    select: (next: Artifact) => {
      current = next;
      act(() => {
        utils.rerender(tree());
      });
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

describe('ArtifactCodeEditor unsaved text across a selection change', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutate.mockClear();
    editorProps.onChange = undefined;
    handlers.onMutate = undefined;
    handlers.onSuccess = undefined;
    handlers.onError = undefined;
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
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('restores that text and saves it when the artifact is selected again', () => {
    const { ed, read } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);
    expect(read()).toBe('CONTENT-B');

    view.select(artifactA);

    expect(read()).toBe('EDITED-A');
    expect(mockMutate).toHaveBeenCalledWith({
      index: 0,
      messageId: 'msg-a',
      original: 'CONTENT-A',
      updated: 'EDITED-A',
    });
  });

  it('sends an edit queued behind a save the session no longer owns', () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    renderEditor(artifactA, monacoRef);

    /* A save started before this editor existed still holds the lock. */
    act(() => {
      session.setIsMutating(true);
    });

    type('EDITED-WHILE-LOCKED');
    settleDebounce();
    expect(mockMutate).not.toHaveBeenCalled();

    act(() => {
      session.endCodeSession();
    });

    expect(mockMutate).toHaveBeenCalledWith({
      index: 0,
      messageId: 'msg-a',
      original: 'CONTENT-A',
      updated: 'EDITED-WHILE-LOCKED',
    });
  });
});
