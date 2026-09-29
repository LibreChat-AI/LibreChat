import React, { useMemo, useState, useEffect, useRef, useCallback, useContext } from 'react';
import debounce from 'lodash/debounce';
import MonacoEditor from '@monaco-editor/react';
import { ThemeContext, highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { Monaco } from '@monaco-editor/react';
import type { IThemeRGB } from '@librechat/client';
import type { editor } from 'monaco-editor';
import type { Artifact } from '~/common';
import { useMutationState, useCodeState } from '~/Providers/EditorContext';
import { getResponseStatus } from '~/utils/errors';
import { useArtifactsContext } from '~/Providers';
import { useEditArtifact } from '~/data-provider';

const LANG_MAP: Record<string, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  css: 'css',
  json: 'json',
  markdown: 'markdown',
  html: 'html',
  xml: 'xml',
  sql: 'sql',
  yaml: 'yaml',
  shell: 'shell',
  bash: 'shell',
  tsx: 'typescript',
  jsx: 'javascript',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  go: 'go',
  rust: 'rust',
  kotlin: 'kotlin',
  swift: 'swift',
  php: 'php',
  ruby: 'ruby',
  r: 'r',
  lua: 'lua',
  scala: 'scala',
  perl: 'perl',
};

const TYPE_MAP: Record<string, string> = {
  'text/html': 'html',
  'application/vnd.code-html': 'html',
  'application/vnd.react': 'typescript',
  'application/vnd.ant.react': 'typescript',
  'text/markdown': 'markdown',
  'text/md': 'markdown',
  'text/plain': 'plaintext',
  'application/vnd.mermaid': 'markdown',
};

const HIGH_CONTRAST_LIGHT_EDITOR_THEME = 'librechat-high-contrast-light';
const HIGH_CONTRAST_DARK_EDITOR_THEME = 'librechat-high-contrast-dark';

/** Monaco's stock `vs-dark` canvas. `@monaco-editor/react` renders its loading
 *  view transparent, so the wrapper has to paint whatever the active Monaco
 *  theme paints or the Code tab flashes the wrong color before the editor
 *  mounts. The contrast themes take their canvas from the semantic palettes
 *  below; this one belongs to a Monaco built-in, so no LibreChat role names it
 *  and no theme can move it. */
const STANDARD_EDITOR_BACKGROUND = '#1e1e1e';

const toHexColor = (palette: IThemeRGB, token: keyof IThemeRGB): string => {
  const value = palette[token];
  if (value == null) {
    throw new Error(`Missing Monaco theme token: ${token}`);
  }

  const channels = value.split(/\s+/).map((channel) => Number(channel));
  if (channels.length !== 3 || channels.some((channel) => !Number.isInteger(channel))) {
    throw new Error(`Invalid Monaco theme token: ${token}`);
  }

  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
};

const createHighContrastEditorTheme = (
  palette: IThemeRGB,
  base: 'vs' | 'vs-dark',
  backgroundToken: keyof IThemeRGB,
): editor.IStandaloneThemeData => {
  const color = (token: keyof IThemeRGB) => toHexColor(palette, token);
  const syntax = (token: keyof IThemeRGB) => color(token).slice(1);

  return {
    base,
    inherit: false,
    rules: [
      { token: '', foreground: syntax('rgb-syntax-text') },
      { token: 'identifier', foreground: syntax('rgb-syntax-text') },
      { token: 'comment', foreground: syntax('rgb-syntax-comment') },
      { token: 'meta', foreground: syntax('rgb-syntax-meta') },
      { token: 'annotation', foreground: syntax('rgb-syntax-meta') },
      { token: 'delimiter', foreground: syntax('rgb-syntax-meta') },
      { token: 'predefined', foreground: syntax('rgb-syntax-builtin') },
      { token: 'class', foreground: syntax('rgb-syntax-builtin') },
      { token: 'keyword', foreground: syntax('rgb-syntax-keyword') },
      { token: 'literal', foreground: syntax('rgb-syntax-keyword') },
      { token: 'string', foreground: syntax('rgb-syntax-string') },
      { token: 'regexp', foreground: syntax('rgb-syntax-string') },
      { token: 'variable', foreground: syntax('rgb-syntax-attr') },
      { token: 'number', foreground: syntax('rgb-syntax-attr') },
      { token: 'type', foreground: syntax('rgb-syntax-attr') },
      { token: 'attribute.name', foreground: syntax('rgb-syntax-attr') },
      { token: 'tag', foreground: syntax('rgb-syntax-title') },
      { token: 'symbol', foreground: syntax('rgb-syntax-title') },
    ],
    colors: {
      'editor.background': color(backgroundToken),
      'editor.foreground': color('rgb-syntax-text'),
      'editorLineNumber.foreground': color('rgb-text-secondary'),
      'editorLineNumber.activeForeground': color('rgb-text-primary'),
      'editorCursor.foreground': color('rgb-ring-primary'),
      /** These palettes have no mid-tones, so a focused selection inverts the
       *  canvas exactly as `::selection` does in `client/src/style.css` — 21:1,
       *  and the only treatment that works without the perimeter the selected
       *  surfaces rely on elsewhere. The weaker emphases (unfocused selection,
       *  matching occurrences, other find hits) share `surface-hover-alt` so
       *  they never outshout the focused one; the current find match is told
       *  apart by its ink `findMatchBorder`. */
      'editor.selectionBackground': color('rgb-text-primary'),
      'editor.selectionForeground': color('rgb-surface-primary'),
      'editor.inactiveSelectionBackground': color('rgb-surface-hover-alt'),
      'editor.selectionHighlightBackground': color('rgb-surface-hover-alt'),
      'editor.lineHighlightBackground': color('rgb-surface-hover'),
      'editor.findMatchBackground': color('rgb-surface-hover-alt'),
      'editor.findMatchBorder': color('rgb-border-heavy'),
      'editor.findMatchHighlightBackground': color('rgb-surface-hover-alt'),
      'editorWidget.background': color('rgb-surface-dialog'),
      'editorWidget.border': color('rgb-border-medium'),
      'input.background': color('rgb-surface-primary'),
      'input.foreground': color('rgb-text-primary'),
      'input.border': color('rgb-border-medium'),
      focusBorder: color('rgb-ring-primary'),
      'editorIndentGuide.background1': color('rgb-border-light'),
      'editorIndentGuide.activeBackground1': color('rgb-border-heavy'),
      'scrollbarSlider.background': color('rgb-border-light'),
      'scrollbarSlider.hoverBackground': color('rgb-border-heavy'),
      'scrollbarSlider.activeBackground': color('rgb-border-xheavy'),
    },
  };
};

const highContrastLightEditorTheme = createHighContrastEditorTheme(
  highContrastLightTheme,
  'vs',
  'rgb-surface-primary-alt',
);
const highContrastDarkEditorTheme = createHighContrastEditorTheme(
  highContrastDarkTheme,
  'vs-dark',
  'rgb-presentation',
);

/** Theme name paired with the canvas it paints, so the wrapper behind the
 *  editor and the editor itself can never disagree. */
type EditorAppearance = { theme: string; background: string };

const standardEditorAppearance: EditorAppearance = {
  theme: 'vs-dark',
  background: STANDARD_EDITOR_BACKGROUND,
};
const highContrastLightEditorAppearance: EditorAppearance = {
  theme: HIGH_CONTRAST_LIGHT_EDITOR_THEME,
  background: highContrastLightEditorTheme.colors['editor.background'],
};
const highContrastDarkEditorAppearance: EditorAppearance = {
  theme: HIGH_CONTRAST_DARK_EDITOR_THEME,
  background: highContrastDarkEditorTheme.colors['editor.background'],
};

type ArtifactEditTarget = {
  artifactId: string;
  messageId: string;
  index: number;
};

type PendingUpdate = ArtifactEditTarget & {
  code: string;
  original: string;
};

type ArtifactMutationVars = {
  messageId: string;
  index: number;
  updated: string;
};

function getMonacoLanguage(type?: string, language?: string): string {
  if (language && LANG_MAP[language]) {
    return LANG_MAP[language];
  }
  return TYPE_MAP[type ?? ''] ?? 'plaintext';
}

function getArtifactEditTarget(artifact: Artifact): ArtifactEditTarget | null {
  if (artifact.index == null) {
    return null;
  }

  return {
    artifactId: artifact.id,
    messageId: artifact.messageId ?? '',
    index: artifact.index,
  };
}

function isSameArtifactTarget(left: ArtifactEditTarget, right: ArtifactEditTarget): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.messageId === right.messageId &&
    left.index === right.index
  );
}

function isSameMutationTarget(target: ArtifactEditTarget, vars: ArtifactMutationVars): boolean {
  return target.messageId === vars.messageId && target.index === vars.index;
}

export const ArtifactCodeEditor = function ArtifactCodeEditor({
  artifact,
  monacoRef,
  readOnly: externalReadOnly,
}: {
  artifact: Artifact;
  monacoRef: React.MutableRefObject<editor.IStandaloneCodeEditor | null>;
  readOnly?: boolean;
}) {
  const { resolvedMode, highContrast } = useContext(ThemeContext);
  const { isSubmitting } = useArtifactsContext();
  const readOnly = (externalReadOnly ?? false) || isSubmitting;
  const { setCurrentCode } = useCodeState();
  const [currentUpdate, setCurrentUpdate] = useState<string | null>(null);
  const { isMutating, setIsMutating } = useMutationState();
  const [failedContent, setFailedContent] = useState<string | null>(null);
  const artifactRef = useRef(artifact);
  const isMutatingRef = useRef(isMutating);
  const currentUpdateRef = useRef(currentUpdate);
  const setCurrentCodeRef = useRef(setCurrentCode);
  const failedContentRef = useRef(failedContent);
  const pendingUpdateRef = useRef<PendingUpdate | null>(null);
  const runMutationRef = useRef<(code: string, original?: string) => void>(() => {});

  const editArtifact = useEditArtifact({
    onMutate: (vars) => {
      isMutatingRef.current = true;
      currentUpdateRef.current = vars.updated;
      setIsMutating(true);
      setCurrentUpdate(vars.updated);
    },
    onSuccess: (_data, vars) => {
      isMutatingRef.current = false;
      currentUpdateRef.current = null;
      setIsMutating(false);
      setCurrentUpdate(null);
      setFailedContent(null);

      const pending = pendingUpdateRef.current;
      pendingUpdateRef.current = null;
      const currentTarget = getArtifactEditTarget(artifactRef.current);
      if (
        pending == null ||
        currentTarget == null ||
        !isSameArtifactTarget(pending, currentTarget)
      ) {
        return;
      }

      const original = isSameMutationTarget(pending, vars) ? vars.updated : pending.original;
      if (pending.code.trim() !== original.trim()) {
        setCurrentCodeRef.current(pending.code);
        runMutationRef.current(pending.code, original);
      }
    },
    onError: (error) => {
      const status = getResponseStatus(error);
      if (status === 400 && currentUpdateRef.current != null) {
        setFailedContent(currentUpdateRef.current);
        failedContentRef.current = currentUpdateRef.current;
      }
      const pending = pendingUpdateRef.current;
      pendingUpdateRef.current = null;
      isMutatingRef.current = false;
      currentUpdateRef.current = null;
      setIsMutating(false);
      setCurrentUpdate(null);

      const currentTarget = getArtifactEditTarget(artifactRef.current);
      if (
        pending == null ||
        currentTarget == null ||
        !isSameArtifactTarget(pending, currentTarget)
      ) {
        return;
      }

      if (pending.code.trim() !== pending.original.trim()) {
        setCurrentCodeRef.current(pending.code);
        runMutationRef.current(pending.code, pending.original);
      }
    },
  });

  const editArtifactRef = useRef(editArtifact);
  const prevContentRef = useRef(artifact.content ?? '');
  const prevArtifactId = useRef(artifact.id);
  const prevReadOnly = useRef(readOnly);

  artifactRef.current = artifact;
  isMutatingRef.current = isMutating;
  currentUpdateRef.current = currentUpdate;
  editArtifactRef.current = editArtifact;
  setCurrentCodeRef.current = setCurrentCode;
  failedContentRef.current = failedContent;

  const runMutation = useCallback(
    (code: string, originalOverride?: string) => {
      const art = artifactRef.current;
      const target = getArtifactEditTarget(art);
      if (readOnly || target == null) {
        return;
      }

      const original = originalOverride ?? art.content ?? '';
      if (isMutatingRef.current) {
        pendingUpdateRef.current = {
          ...target,
          code,
          original,
        };
        return;
      }

      const isNotOriginal = code.trim() !== original.trim();
      const isNotRepeated =
        currentUpdateRef.current == null ? true : code.trim() !== currentUpdateRef.current.trim();

      if (!isNotOriginal || !isNotRepeated) {
        return;
      }

      if (failedContentRef.current != null && code.trim() === failedContentRef.current.trim()) {
        return;
      }

      setCurrentCodeRef.current(code);
      editArtifactRef.current.mutate({
        index: target.index,
        messageId: target.messageId,
        original,
        updated: code,
      });
    },
    [readOnly],
  );

  runMutationRef.current = runMutation;

  const debouncedMutation = useMemo(
    () =>
      debounce((code: string) => {
        runMutationRef.current(code);
      }, 500),
    [],
  );

  useEffect(() => {
    return () => debouncedMutation.cancel();
  }, [artifact.id, debouncedMutation]);

  /**
   * Streaming: use model.applyEdits() to append new content.
   * Unlike setValue/pushEditOperations, applyEdits preserves existing
   * tokens so syntax highlighting doesn't flash during updates.
   */
  useEffect(() => {
    const ed = monacoRef.current;
    if (!ed || !readOnly) {
      return;
    }
    const newContent = artifact.content ?? '';
    const prev = prevContentRef.current;

    if (newContent === prev) {
      return;
    }

    const model = ed.getModel();
    if (!model) {
      return;
    }

    if (newContent.startsWith(prev) && prev.length > 0) {
      const appended = newContent.slice(prev.length);
      const endPos = model.getPositionAt(model.getValueLength());
      model.applyEdits([
        {
          range: {
            startLineNumber: endPos.lineNumber,
            startColumn: endPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
          },
          text: appended,
        },
      ]);
    } else {
      model.setValue(newContent);
    }

    prevContentRef.current = newContent;
    ed.revealLine(model.getLineCount());
  }, [artifact.content, readOnly, monacoRef]);

  useEffect(() => {
    if (artifact.id === prevArtifactId.current) {
      return;
    }
    prevArtifactId.current = artifact.id;
    pendingUpdateRef.current = null;
    setFailedContent(null);
    prevContentRef.current = artifact.content ?? '';
    const ed = monacoRef.current;
    if (ed && artifact.content != null) {
      ed.getModel()?.setValue(artifact.content);
    }
  }, [artifact.id, artifact.content, monacoRef]);

  useEffect(() => {
    if (prevReadOnly.current && !readOnly && artifact.content != null) {
      const ed = monacoRef.current;
      if (ed) {
        ed.getModel()?.setValue(artifact.content);
        prevContentRef.current = artifact.content;
      }
    }
    prevReadOnly.current = readOnly;
  }, [readOnly, artifact.content, monacoRef]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined || readOnly) {
        return;
      }
      prevContentRef.current = value;
      setCurrentCode(value);
      if (value.length > 0) {
        debouncedMutation(value);
      }
    },
    [readOnly, debouncedMutation, setCurrentCode],
  );

  /**
   * Disable all validation — this is an artifact viewer/editor, not an IDE.
   * Note: these are global Monaco settings that affect all editor instances on the page.
   * The `as unknown` cast is required because monaco-editor v0.55 types `.languages.typescript`
   * as `{ deprecated: true }` while the runtime API is fully functional.
   */
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    monaco.editor.defineTheme(HIGH_CONTRAST_LIGHT_EDITOR_THEME, highContrastLightEditorTheme);
    monaco.editor.defineTheme(HIGH_CONTRAST_DARK_EDITOR_THEME, highContrastDarkEditorTheme);

    const { typescriptDefaults, javascriptDefaults, JsxEmit } = monaco.languages
      .typescript as unknown as {
      typescriptDefaults: {
        setDiagnosticsOptions: (o: {
          noSemanticValidation: boolean;
          noSyntaxValidation: boolean;
        }) => void;
        setCompilerOptions: (o: {
          allowNonTsExtensions: boolean;
          allowJs: boolean;
          jsx: number;
        }) => void;
      };
      javascriptDefaults: {
        setDiagnosticsOptions: (o: {
          noSemanticValidation: boolean;
          noSyntaxValidation: boolean;
        }) => void;
        setCompilerOptions: (o: {
          allowNonTsExtensions: boolean;
          allowJs: boolean;
          jsx: number;
        }) => void;
      };
      JsxEmit: { React: number };
    };
    const diagnosticsOff = { noSemanticValidation: true, noSyntaxValidation: true };
    const compilerBase = { allowNonTsExtensions: true, allowJs: true, jsx: JsxEmit.React };
    typescriptDefaults.setDiagnosticsOptions(diagnosticsOff);
    javascriptDefaults.setDiagnosticsOptions(diagnosticsOff);
    typescriptDefaults.setCompilerOptions(compilerBase);
    javascriptDefaults.setCompilerOptions(compilerBase);
  }, []);

  const handleMount = useCallback(
    (ed: editor.IStandaloneCodeEditor) => {
      monacoRef.current = ed;
      prevContentRef.current = ed.getModel()?.getValue() ?? artifact.content ?? '';
      if (readOnly) {
        const model = ed.getModel();
        if (model) {
          ed.revealLine(model.getLineCount());
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monacoRef],
  );

  const language = getMonacoLanguage(artifact.type, artifact.language);
  let editorAppearance = standardEditorAppearance;
  if (highContrast) {
    editorAppearance =
      resolvedMode === 'dark'
        ? highContrastDarkEditorAppearance
        : highContrastLightEditorAppearance;
  }

  const editorOptions = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      readOnly,
      minimap: { enabled: false },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      fontSize: 13,
      tabSize: 2,
      wordWrap: 'on',
      automaticLayout: true,
      padding: { top: 8 },
      renderLineHighlight: readOnly ? 'none' : 'line',
      cursorStyle: readOnly ? 'underline-thin' : 'line',
      scrollbar: {
        vertical: 'visible',
        horizontal: 'auto',
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
        alwaysConsumeMouseWheel: false,
      },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      folding: false,
      glyphMargin: false,
      colorDecorators: !readOnly,
      occurrencesHighlight: readOnly ? 'off' : 'singleFile',
      selectionHighlight: !readOnly,
      renderValidationDecorations: readOnly ? 'off' : 'editable',
      quickSuggestions: !readOnly,
      suggestOnTriggerCharacters: !readOnly,
      parameterHints: { enabled: !readOnly },
      hover: { enabled: readOnly ? 'off' : 'on' },
      matchBrackets: readOnly ? 'never' : 'always',
    }),
    [readOnly],
  );

  if (!artifact.content) {
    return null;
  }

  return (
    <div className="h-full w-full" style={{ backgroundColor: editorAppearance.background }}>
      <MonacoEditor
        height="100%"
        language={readOnly ? 'plaintext' : language}
        theme={editorAppearance.theme}
        defaultValue={artifact.content}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={editorOptions}
      />
    </div>
  );
};
