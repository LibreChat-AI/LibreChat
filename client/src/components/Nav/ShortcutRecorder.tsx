import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { RefObject } from 'react';
import type { ShortcutBinding } from '~/utils/shortcuts';
import {
  bindingDisplayKeys,
  bindingHash,
  isCancelKey,
  isModifierKey,
  isValidBinding,
  normalizeKey,
} from '~/utils/shortcuts';
import { isMac } from '~/hooks/useKeyboardShortcuts';
import ShortcutKeyCombo from './ShortcutKeyCombo';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ConflictInfo = {
  conflictId: string;
  conflictLabel: string;
  binding: ShortcutBinding;
};

type RecorderState = {
  containerRef: RefObject<HTMLDivElement>;
  boundaryRef: RefObject<HTMLDivElement>;
  previewKeys: string[];
  hasConflict: boolean;
  conflict: ConflictInfo | null;
  showInvalid: boolean;
  showHint: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onKeyUp: () => void;
  onTryAgain: () => void;
};

type Options = {
  initial: ShortcutBinding | null;
  bindingMap: Map<string, string>;
  ownerId: string;
  getActionLabel: (id: string) => string;
  onSave: (binding: ShortcutBinding) => void;
  onCancel: () => void;
};

export function useShortcutRecorder({
  initial,
  bindingMap,
  ownerId,
  getActionLabel,
  onSave,
  onCancel,
}: Options): RecorderState {
  const containerRef = useRef<HTMLDivElement>(null);
  const boundaryRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<ShortcutBinding | null>(null);
  const [draft, setDraft] = useState<ShortcutBinding | null>(initial);
  const [error, setError] = useState<'noModifier' | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  const previewKeys = useMemo(() => {
    const source = pending ?? draft;
    if (!source) return [];
    return bindingDisplayKeys(source, isMac);
  }, [pending, draft]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();

      if (isCancelKey(e.nativeEvent)) {
        onCancel();
        return;
      }

      const previewBinding: ShortcutBinding = {
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        key: isModifierKey(e.key) ? '' : normalizeKey(e.key, e.shiftKey),
      };

      if (!previewBinding.key) {
        setPending({ ...previewBinding, key: '…' });
        return;
      }

      setPending(null);
      const validation = isValidBinding(previewBinding);
      if (!validation.valid) {
        setDraft(previewBinding);
        setError('noModifier');
        setConflict(null);
        return;
      }
      setError(null);
      const hash = bindingHash(previewBinding);
      const conflictId = bindingMap.get(hash);
      if (conflictId && conflictId !== ownerId) {
        setDraft(previewBinding);
        setConflict({
          conflictId,
          conflictLabel: getActionLabel(conflictId),
          binding: previewBinding,
        });
        return;
      }
      setConflict(null);
      onSave(previewBinding);
    },
    [bindingMap, getActionLabel, onCancel, onSave, ownerId],
  );

  const onKeyUp = useCallback(() => {
    setPending(null);
  }, []);

  const onTryAgain = useCallback(() => {
    setDraft(initial);
    setConflict(null);
    setError(null);
    containerRef.current?.focus();
  }, [initial]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const root = boundaryRef.current ?? containerRef.current;
      if (root && !root.contains(e.target as Node)) {
        onCancel();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onCancel]);

  return {
    containerRef,
    boundaryRef,
    previewKeys,
    hasConflict: !!conflict,
    conflict,
    showInvalid: error === 'noModifier',
    showHint: previewKeys.length === 0,
    onKeyDown,
    onKeyUp,
    onTryAgain,
  };
}

export function RecorderPill({
  state,
  ariaLabel,
  ownerId,
}: {
  state: RecorderState;
  ariaLabel: string;
  ownerId: string;
}) {
  const localize = useLocalize();
  const { containerRef, previewKeys, hasConflict, showInvalid, showHint, onKeyDown, onKeyUp } =
    state;
  let stateBorder = 'border-border-medium';
  if (hasConflict) {
    stateBorder = 'border-status-warning-border';
  } else if (showInvalid) {
    stateBorder = 'animate-shortcut-shake border-border-destructive';
  }
  return (
    <div
      ref={containerRef}
      role="textbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-describedby={`${ownerId}-recorder-hint`}
      data-testid={`shortcut-recorder-${ownerId}`}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className={cn(
        'flex h-[30px] items-center gap-1.5 rounded-md border bg-surface-primary px-2 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface-primary-alt',
        stateBorder,
      )}
    >
      {showHint ? (
        <span className="text-[11.5px] text-text-secondary">
          {localize('com_shortcut_recorder_placeholder')}
        </span>
      ) : (
        <ShortcutKeyCombo keys={previewKeys} />
      )}
    </div>
  );
}

export function RecorderInfo({
  state,
  ownerId,
  onCancel,
  onSaveReplacing,
}: {
  state: RecorderState;
  ownerId: string;
  onCancel: () => void;
  onSaveReplacing: (binding: ShortcutBinding, conflictId: string) => void;
}) {
  const localize = useLocalize();
  const { hasConflict, conflict, showInvalid, onTryAgain } = state;

  if (hasConflict && conflict) {
    return (
      <div
        id={`${ownerId}-recorder-hint`}
        className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 pl-1 text-[11.5px]"
      >
        <span className="text-text-secondary">
          {localize('com_shortcut_recorder_conflict_prefix')}{' '}
          <span className="font-medium text-text-primary">{conflict.conflictLabel}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onTryAgain}
            className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-text-secondary transition-colors hover:text-text-primary"
          >
            {localize('com_shortcut_recorder_try_again')}
          </button>
          <button
            type="button"
            onClick={() => onSaveReplacing(conflict.binding, conflict.conflictId)}
            className="whitespace-nowrap rounded-md bg-surface-tertiary px-2 py-0.5 font-medium text-text-primary transition-colors hover:bg-surface-active-alt"
          >
            {localize('com_shortcut_recorder_replace')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div id={`${ownerId}-recorder-hint`} className="flex items-center justify-end gap-2 pl-1">
      <span
        className={cn(
          'text-[11.5px]',
          showInvalid ? 'text-text-destructive' : 'text-text-secondary',
        )}
      >
        {showInvalid
          ? localize('com_shortcut_recorder_needs_modifier')
          : localize('com_shortcut_recorder_hint')}
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label={localize('com_ui_cancel')}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
