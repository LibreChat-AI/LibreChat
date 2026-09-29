import React from 'react';
import { render, act } from '@testing-library/react';
import { ThemeContext, highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { Monaco } from '@monaco-editor/react';
import type { IThemeRGB } from '@librechat/client';
import type { editor } from 'monaco-editor';
import type { Artifact } from '~/common';
import { ArtifactCodeEditor } from './ArtifactCodeEditor';

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
  beforeMount?: (monaco: Monaco) => void;
  theme?: string;
}

const mockEditorProps: MonacoEditorProps = {};
const mockMutationHandlers: MutationHandlers = {};

// Calling mutate replays onMutate synchronously so currentUpdateRef reflects the
// in-flight content, matching how react-query drives the real mutation lifecycle.
const mockMutate = jest.fn((vars: MutationVars) => {
  mockMutationHandlers.onMutate?.(vars);
});

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: MonacoEditorProps) => {
    Object.assign(mockEditorProps, props);
    return null;
  },
}));

jest.mock('~/Providers/EditorContext', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    useMutationState: () => {
      const [isMutating, setIsMutating] = ReactModule.useState(false);
      return { isMutating, setIsMutating };
    },
    useCodeState: () => {
      const [currentCode, setCurrentCode] = ReactModule.useState('');
      return { currentCode, setCurrentCode };
    },
  };
});

jest.mock('~/Providers', () => ({
  useArtifactsContext: () => ({ isSubmitting: false }),
}));

jest.mock('~/data-provider', () => ({
  useEditArtifact: (handlers: MutationHandlers) => {
    mockMutationHandlers.onMutate = handlers.onMutate;
    mockMutationHandlers.onSuccess = handlers.onSuccess;
    mockMutationHandlers.onError = handlers.onError;
    return { mutate: mockMutate };
  },
}));

const ORIGINAL = 'ORIGINAL';

const artifact: Artifact = {
  id: 'artifact-1',
  lastUpdateTime: 0,
  index: 0,
  messageId: 'msg-1',
  content: ORIGINAL,
  type: 'text/plain',
};

const otherArtifact: Artifact = {
  id: 'artifact-2',
  lastUpdateTime: 0,
  index: 0,
  messageId: 'msg-2',
  content: 'ORIGINAL-B',
  type: 'text/plain',
};

type Appearance = {
  resolvedMode: 'light' | 'dark';
  highContrast: boolean;
};

const defaultAppearance: Appearance = { resolvedMode: 'light', highContrast: false };

const renderEditor = (initial: Artifact = artifact, initialAppearance = defaultAppearance) => {
  const monacoRef: React.MutableRefObject<editor.IStandaloneCodeEditor | null> = { current: null };
  let currentArtifact = initial;
  let currentAppearance = initialAppearance;
  const tree = () => (
    <ThemeContext.Provider
      value={
        {
          resolvedMode: currentAppearance.resolvedMode,
          highContrast: currentAppearance.highContrast,
        } as React.ContextType<typeof ThemeContext>
      }
    >
      <ArtifactCodeEditor artifact={currentArtifact} monacoRef={monacoRef} />
    </ThemeContext.Provider>
  );
  const utils = render(tree());
  const rerenderWith = (next: Artifact) => {
    currentArtifact = next;
    utils.rerender(tree());
  };
  const rerenderAppearance = (next: Appearance) => {
    currentAppearance = next;
    utils.rerender(tree());
  };
  return { ...utils, rerenderWith, rerenderAppearance };
};

const toHexColor = (palette: IThemeRGB, token: keyof IThemeRGB) =>
  `#${palette[token]
    ?.split(/\s+/)
    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
    .join('')}`;

const createMonacoMock = () => {
  const defaults = {
    setDiagnosticsOptions: jest.fn(),
    setCompilerOptions: jest.fn(),
  };
  const defineTheme = jest.fn();
  const monaco = {
    editor: { defineTheme },
    languages: {
      typescript: {
        typescriptDefaults: defaults,
        javascriptDefaults: defaults,
        JsxEmit: { React: 1 },
      },
    },
  } as unknown as Monaco;

  return { monaco, defineTheme };
};

const fireEdit = (value: string) => {
  act(() => {
    mockEditorProps.onChange?.(value);
    jest.advanceTimersByTime(500);
  });
};

describe('ArtifactCodeEditor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEditorProps.onChange = undefined;
    mockEditorProps.beforeMount = undefined;
    mockEditorProps.theme = undefined;
    mockMutationHandlers.onMutate = undefined;
    mockMutationHandlers.onSuccess = undefined;
    mockMutationHandlers.onError = undefined;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('paints the loading canvas with the standard Monaco canvas outside high contrast', () => {
    const { container } = renderEditor();

    expect(mockEditorProps.theme).toBe('vs-dark');
    expect(container.firstElementChild).toHaveStyle({ backgroundColor: '#1e1e1e' });
  });

  it('moves the Monaco theme and its loading canvas together across contrast appearances', () => {
    const { rerenderAppearance, container } = renderEditor(artifact, {
      resolvedMode: 'light',
      highContrast: true,
    });

    expect(mockEditorProps.theme).toBe('librechat-high-contrast-light');
    expect(container.firstElementChild).toHaveStyle({
      backgroundColor: toHexColor(highContrastLightTheme, 'rgb-surface-primary-alt'),
    });

    rerenderAppearance({ resolvedMode: 'dark', highContrast: true });

    expect(mockEditorProps.theme).toBe('librechat-high-contrast-dark');
    expect(container.firstElementChild).toHaveStyle({
      backgroundColor: toHexColor(highContrastDarkTheme, 'rgb-presentation'),
    });
  });

  it('defines both contrast themes from the semantic syntax palettes', () => {
    renderEditor(artifact, { resolvedMode: 'light', highContrast: true });
    const { monaco, defineTheme } = createMonacoMock();

    mockEditorProps.beforeMount?.(monaco);

    expect(defineTheme).toHaveBeenCalledTimes(2);
    expect(defineTheme).toHaveBeenCalledWith(
      'librechat-high-contrast-light',
      expect.objectContaining({
        base: 'vs',
        inherit: false,
        colors: expect.objectContaining({
          'editor.background': toHexColor(highContrastLightTheme, 'rgb-surface-primary-alt'),
          'editor.foreground': toHexColor(highContrastLightTheme, 'rgb-syntax-text'),
          'editor.selectionBackground': toHexColor(highContrastLightTheme, 'rgb-text-primary'),
          'editor.selectionForeground': toHexColor(highContrastLightTheme, 'rgb-surface-primary'),
        }),
        rules: expect.arrayContaining([
          expect.objectContaining({
            token: 'keyword',
            foreground: toHexColor(highContrastLightTheme, 'rgb-syntax-keyword').slice(1),
          }),
        ]),
      }),
    );
    expect(defineTheme).toHaveBeenCalledWith(
      'librechat-high-contrast-dark',
      expect.objectContaining({
        base: 'vs-dark',
        inherit: false,
        colors: expect.objectContaining({
          'editor.background': toHexColor(highContrastDarkTheme, 'rgb-presentation'),
          'editor.foreground': toHexColor(highContrastDarkTheme, 'rgb-syntax-text'),
          'editor.selectionBackground': toHexColor(highContrastDarkTheme, 'rgb-text-primary'),
          'editor.selectionForeground': toHexColor(highContrastDarkTheme, 'rgb-surface-primary'),
        }),
      }),
    );
  });

  it('does not re-run a mutation for content that just failed', () => {
    renderEditor();

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 'EDITED' }));

    act(() => {
      mockMutationHandlers.onError?.({ status: 400 });
    });

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('blocks the retry for a real AxiosError 400 (production error shape)', () => {
    renderEditor();

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    act(() => {
      mockMutationHandlers.onError?.({ isAxiosError: true, response: { status: 400 } });
    });

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('blocks the synchronous pending re-run of content that just failed', () => {
    renderEditor();

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    act(() => {
      mockMutationHandlers.onError?.({ status: 400 });
    });

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('clears the guard on success so the same content can run again', () => {
    renderEditor();

    fireEdit('EDITED');
    act(() => {
      mockMutationHandlers.onError?.({ status: 400 });
    });
    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    fireEdit('DIFFERENT');
    expect(mockMutate).toHaveBeenCalledTimes(2);

    act(() => {
      mockMutationHandlers.onSuccess?.(undefined, {
        updated: 'DIFFERENT',
        messageId: 'msg-1',
        index: 0,
      });
    });
    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(3);
    expect(mockMutate).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 'EDITED' }));
  });

  it('clears the guard when the artifact changes', () => {
    const { rerenderWith } = renderEditor();

    fireEdit('EDITED');
    act(() => {
      mockMutationHandlers.onError?.({ status: 400 });
    });
    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    act(() => {
      rerenderWith(otherArtifact);
    });
    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(mockMutate).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 'EDITED' }));
  });

  it('re-runs identical content after a non-400 client error (transient, not deterministic)', () => {
    renderEditor();

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    act(() => {
      mockMutationHandlers.onError?.({ status: 429 });
    });

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(mockMutate).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 'EDITED' }));
  });

  it('re-runs identical content after a 5xx error (transient, not deterministic)', () => {
    renderEditor();

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    act(() => {
      mockMutationHandlers.onError?.({ status: 503 });
    });

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(mockMutate).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 'EDITED' }));
  });

  it('re-runs identical content after an error with no status (network blip)', () => {
    renderEditor();

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(1);

    act(() => {
      mockMutationHandlers.onError?.(new Error('Network Error'));
    });

    fireEdit('EDITED');
    expect(mockMutate).toHaveBeenCalledTimes(2);
  });
});
