import React, { useMemo, useState, useEffect, useRef, useCallback, useContext } from 'react';
import debounce from 'lodash/debounce';
import MonacoEditor from '@monaco-editor/react';
import { useQueryClient } from '@tanstack/react-query';
import { MutationKeys } from 'librechat-data-provider';
import { ThemeContext, highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { QueryClient } from '@tanstack/react-query';
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

/**
 * The text the most recent successful save wrote for this artifact, which is
 * what the server now holds. The registry catches up only when the edited
 * message propagates, so an edit sent between those two moments has to be
 * rebased on the request's own record rather than on `artifact.content`.
 */
function getSavedContent(queryClient: QueryClient, target: ArtifactEditTarget): string | undefined {
  /** Mutation ids increase, so the highest one is the most recent save. */
  let latestId = -1;
  let latest: string | undefined;
  for (const mutation of queryClient
    .getMutationCache()
    .findAll({ mutationKey: [MutationKeys.editArtifact] })) {
    const vars = mutation.state.variables as ArtifactMutationVars | undefined;
    if (
      mutation.state.status !== 'success' ||
      vars == null ||
      !isSameMutationTarget(target, vars)
    ) {
      continue;
    }
    if (mutation.mutationId > latestId) {
      latestId = mutation.mutationId;
      latest = vars.updated;
    }
  }
  return latest;
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
  const queryClient = useQueryClient();
  const { isSubmitting } = useArtifactsContext();
  const readOnly = (externalReadOnly ?? false) || isSubmitting;
  const {
    currentCode,
    codeArtifactId,
    setCurrentCode,
    rejectedCode,
    rejectedCodeArtifactId,
    setRejectedCode,
    codeSession,
  } = useCodeState();
  /* The pane is remounted when it changes hosts (side panel, mobile sheet,
   * undocked window). The buffer outlives that remount, so unsaved text is
   * restored here instead of falling back to the persisted content. */
  const restoredCode = codeArtifactId === artifact.id ? currentCode : undefined;
  const [currentUpdate, setCurrentUpdate] = useState<string | null>(null);
  const { isMutating } = useMutationState();
  const artifactRef = useRef(artifact);
  const isMutatingRef = useRef(isMutating);
  const currentUpdateRef = useRef(currentUpdate);
  const setCurrentCodeRef = useRef(setCurrentCode);
  const rejectedCodeRef = useRef(rejectedCode);
  const rejectedCodeArtifactIdRef = useRef(rejectedCodeArtifactId);
  const pendingUpdateRef = useRef<PendingUpdate | null>(null);
  const runMutationRef = useRef<(code: string, original?: string) => void>(() => {});
  /** Read by the mount effect below, which must not re-run as the user types. */
  const restoredCodeRef = useRef(restoredCode);
  /* The session a save was started in. Its callbacks outlive the editor, so
   * they compare this against the live session before touching the buffer or
   * submitting a queued edit: both belong to whoever is editing now, and a
   * pane the user closed is not it. The save itself is left alone — it is the
   * request's to finish, and `isMutating` reports it until it does. */
  const mutationSessionRef = useRef(codeSession.current);
  const isStaleSession = () => codeSession.current !== mutationSessionRef.current;

  const editArtifact = useEditArtifact({
    onMutate: (vars) => {
      isMutatingRef.current = true;
      currentUpdateRef.current = vars.updated;
      setCurrentUpdate(vars.updated);
    },
    onSuccess: (_data, vars) => {
      currentUpdateRef.current = null;
      /* A save that outlived its session reports to nobody: the buffer and any
       * queued edit belong to whoever is editing now. */
      if (isStaleSession()) {
        return;
      }
      const pending = pendingUpdateRef.current;
      pendingUpdateRef.current = null;
      setCurrentUpdate(null);
      setRejectedCode(undefined);
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
        setCurrentCodeRef.current(pending.code, artifactRef.current.id);
        runMutationRef.current(pending.code, original);
      }
    },
    onError: (error) => {
      const attempted = currentUpdateRef.current;
      currentUpdateRef.current = null;
      if (isStaleSession()) {
        return;
      }
      const pending = pendingUpdateRef.current;
      pendingUpdateRef.current = null;

      const status = getResponseStatus(error);
      if (status === 400 && attempted != null) {
        setRejectedCode(attempted, artifactRef.current.id);
      }
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
        setCurrentCodeRef.current(pending.code, artifactRef.current.id);
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
  rejectedCodeRef.current = rejectedCode;
  rejectedCodeArtifactIdRef.current = rejectedCodeArtifactId;
  restoredCodeRef.current = restoredCode;

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

      if (
        rejectedCodeArtifactIdRef.current === art.id &&
        rejectedCodeRef.current != null &&
        code.trim() === rejectedCodeRef.current.trim()
      ) {
        return;
      }

      mutationSessionRef.current = codeSession.current;
      setCurrentCodeRef.current(code, art.id);
      editArtifactRef.current.mutate({
        index: target.index,
        messageId: target.messageId,
        original,
        updated: code,
      });
    },
    [codeSession, readOnly],
  );

  runMutationRef.current = runMutation;

  /** The value this component last wrote into the model, held until the change
   *  event it produces arrives. */
  const programmaticValueRef = useRef<string | null>(null);
  const writeModelValue = useCallback((ed: editor.IStandaloneCodeEditor, value: string) => {
    const model = ed.getModel();
    if (!model || model.getValue() === value) {
      return;
    }
    programmaticValueRef.current = value;
    model.setValue(value);
  }, []);

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

  /* A remount cancels the debounce mid-flight, so text the user typed just
   * before the pane changed hosts lives in the buffer and has never been sent.
   * The request its previous instance started keeps its own callbacks — React
   * Query holds them on the mutation, not on the observer — so this instance
   * must not guess at that request's state or resubmit against an `original`
   * it may already have replaced. It waits for the shared flag to go idle and
   * submits then, once.
   *
   * Only the buffer this instance inherited at mount is drained. A buffer
   * picked up by navigating back to an artifact belongs to an editor that is
   * still alive and will send it itself; submitting it here would race that
   * editor's own `setValue`. */
  const inheritedBufferRef = useRef<string | null>(restoredCode ?? null);
  const drainedBufferRef = useRef<string | null>(null);
  useEffect(() => {
    if (isMutating) {
      return;
    }

    /* An edit typed while a save was in flight is queued here, and normally
     * the callbacks of that save send it. Those callbacks belong to whichever
     * editor started it, so when the save was started by a previous session
     * nobody else will: this editor sends its own queued edit as soon as the
     * pipeline is idle.
     *
     * What that edit replaces is whatever the last save wrote, which is not
     * necessarily `artifact.content` yet — the registry catches up when the
     * edited message propagates. Sending either the content captured when the
     * edit was queued or a registry that has not caught up has the endpoint
     * reject the newest text, so the request's own record decides. */
    const queued = pendingUpdateRef.current;
    if (queued != null) {
      pendingUpdateRef.current = null;
      const currentTarget = getArtifactEditTarget(artifactRef.current);
      if (currentTarget != null && isSameArtifactTarget(queued, currentTarget)) {
        const original =
          getSavedContent(queryClient, currentTarget) ??
          artifactRef.current.content ??
          queued.original;
        if (queued.code.trim() !== original.trim()) {
          setCurrentCodeRef.current(queued.code, artifactRef.current.id);
          runMutationRef.current(queued.code, original);
          return;
        }
      }
    }

    const inherited = inheritedBufferRef.current;
    if (inherited == null || drainedBufferRef.current === inherited) {
      return;
    }
    const inheritedTarget = getArtifactEditTarget(artifactRef.current);
    const inheritedOriginal =
      (inheritedTarget != null ? getSavedContent(queryClient, inheritedTarget) : undefined) ??
      artifactRef.current.content ??
      '';
    if (inherited === inheritedOriginal) {
      return;
    }
    drainedBufferRef.current = inherited;
    prevContentRef.current = inherited;
    if (
      inheritedTarget != null &&
      rejectedCodeArtifactIdRef.current === artifactRef.current.id &&
      rejectedCodeRef.current != null &&
      inherited.trim() === rejectedCodeRef.current.trim()
    ) {
      return;
    }
    runMutationRef.current(inherited, inheritedOriginal);
  }, [isMutating, queryClient]);

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

  /* Selecting another artifact and coming back has to land on this artifact's
   * own text: its unsaved buffer when it has one, the persisted content
   * otherwise. Writing the persisted content over a retained edit would queue
   * that content behind the edit and quietly undo it.
   *
   * A retained buffer is also sent here. Its own debounce was cancelled when
   * the selection moved away, so this is where that edit finally becomes a
   * save — and it is sent for the artifact it belongs to, which is the one on
   * screen again. The rejection marker is deliberately left alone: it names
   * the artifact it was recorded for, so it cannot suppress this artifact's
   * save, and dropping it here would let this resend put the one text the
   * endpoint already refused back on the wire. */
  useEffect(() => {
    if (artifact.id === prevArtifactId.current) {
      return;
    }
    prevArtifactId.current = artifact.id;
    pendingUpdateRef.current = null;
    const restored = restoredCodeRef.current;
    const nextValue = restored ?? artifact.content;
    prevContentRef.current = nextValue ?? '';
    const ed = monacoRef.current;
    if (ed && nextValue != null) {
      writeModelValue(ed, nextValue);
    }
    if (restored != null && restored !== (artifact.content ?? '')) {
      runMutationRef.current(restored);
    }
  }, [artifact.id, artifact.content, monacoRef, writeModelValue]);

  useEffect(() => {
    if (prevReadOnly.current && !readOnly && artifact.content != null) {
      const ed = monacoRef.current;
      if (ed) {
        writeModelValue(ed, artifact.content);
        prevContentRef.current = artifact.content;
      }
    }
    prevReadOnly.current = readOnly;
  }, [readOnly, artifact.content, monacoRef, writeModelValue]);

  /* Monaco reports a write this component made through `onChange` like any
   * other edit. Treating it as typing would key the shared buffer to the
   * artifact now on screen and drop the unsaved text another artifact is
   * holding, so the value written here is recognised and consumed. */
  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) {
        return;
      }
      const programmatic = programmaticValueRef.current;
      programmaticValueRef.current = null;
      if (readOnly) {
        return;
      }
      prevContentRef.current = value;
      if (programmatic != null && value === programmatic) {
        return;
      }
      setCurrentCode(value, artifactRef.current.id);
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
        defaultValue={restoredCode ?? artifact.content}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={editorOptions}
      />
    </div>
  );
};
