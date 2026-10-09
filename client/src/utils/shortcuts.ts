export type ShortcutBinding = {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

export const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

const SPECIAL_KEY_MAP: Record<string, string> = {
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  ' ': 'Space',
};

const SHIFT_TO_UNSHIFT: Record<string, string> = {
  '?': '/',
  ':': ';',
  '<': ',',
  '>': '.',
  '"': "'",
  '{': '[',
  '}': ']',
  '|': '\\',
  _: '-',
  '+': '=',
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

export function normalizeKey(key: string, shiftHeld?: boolean): string {
  if (SPECIAL_KEY_MAP[key]) {
    return SPECIAL_KEY_MAP[key];
  }
  if (key.length === 1) {
    if (shiftHeld && SHIFT_TO_UNSHIFT[key]) {
      return SHIFT_TO_UNSHIFT[key];
    }
    return key.toUpperCase();
  }
  return key;
}

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/** The event fields chord resolution reads, so callers can pass synthetic chords. */
export type KeyChordSource = Pick<
  KeyboardEvent,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
> &
  Partial<Pick<KeyboardEvent, 'code'>>;

/**
 * Punctuation shortcuts should follow the physical key advertised by the UI.
 * `KeyboardEvent.key` reports the character produced by the active layout, so
 * the physical Period key can report `:` (or another character) on a non-US
 * layout even though the displayed/ARIA shortcut is still `.`. `code` is
 * layout-independent and keeps those bindings usable without changing how
 * letter shortcuts follow the user's chosen layout.
 */
const PUNCTUATION_KEY_BY_CODE: Readonly<Record<string, string>> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

export function bindingFromEvent(e: KeyChordSource): ShortcutBinding | null {
  if (isModifierKey(e.key)) {
    return null;
  }
  const key = (e.code && PUNCTUATION_KEY_BY_CODE[e.code]) || e.key;
  return {
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: normalizeKey(key, e.shiftKey),
  };
}

const MODIFIER_TOKENS: Record<string, 'meta' | 'ctrl' | 'alt' | 'shift'> = {
  Meta: 'meta',
  Cmd: 'meta',
  Command: 'meta',
  Control: 'ctrl',
  Ctrl: 'ctrl',
  Alt: 'alt',
  Option: 'alt',
  Shift: 'shift',
};

export function parseBinding(value: string | null | undefined): ShortcutBinding | null {
  if (!value) {
    return null;
  }
  const binding: ShortcutBinding = {
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: '',
  };
  let remaining = value;
  let separatorIndex = remaining.indexOf('+');
  while (separatorIndex > 0) {
    const flag = MODIFIER_TOKENS[remaining.slice(0, separatorIndex)];
    if (!flag) {
      break;
    }
    binding[flag] = true;
    remaining = remaining.slice(separatorIndex + 1);
    separatorIndex = remaining.indexOf('+');
  }
  if (MODIFIER_TOKENS[remaining]) {
    return null;
  }
  binding.key = normalizeKey(remaining);
  if (!binding.key) {
    return null;
  }
  return binding;
}

export function bindingToString(binding: ShortcutBinding | null): string | null {
  if (!binding) {
    return null;
  }
  const parts: string[] = [];
  if (binding.meta) parts.push('Meta');
  if (binding.ctrl) parts.push('Control');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key);
  return parts.join('+');
}

export function bindingHash(binding: ShortcutBinding): string {
  const flags = [
    binding.meta ? 'M' : '',
    binding.ctrl ? 'C' : '',
    binding.alt ? 'A' : '',
    binding.shift ? 'S' : '',
  ].join('');
  return `${flags}|${binding.key}`;
}

/**
 * Whether a pressed chord is the one a shortcut is bound to. Absent on either
 * side means no match: an unset (`undefined`) or explicitly unbound (`null`)
 * shortcut is not something a keypress can match.
 */
export function bindingsMatch(
  a: ShortcutBinding | null | undefined,
  b: ShortcutBinding | null | undefined,
): boolean {
  return a != null && b != null && bindingHash(a) === bindingHash(b);
}

export function hasModifier(binding: ShortcutBinding): boolean {
  return binding.meta || binding.ctrl || binding.alt;
}

/**
 * Keys allowed as a shift-only chord. Limited to keys whose native behavior is safe to
 * override; combos like Shift+Tab, Shift+Arrow, or Shift+Backspace would otherwise hijack
 * browser focus/navigation on non-text controls.
 */
const SHIFT_SAFE_KEYS = new Set(['Escape']);

export function isValidBinding(binding: ShortcutBinding): {
  valid: boolean;
  reason?: 'noModifier';
} {
  if (hasModifier(binding)) {
    return { valid: true };
  }
  if (binding.shift && SHIFT_SAFE_KEYS.has(binding.key)) {
    return { valid: true };
  }
  return { valid: false, reason: 'noModifier' };
}

export type ComposerEnterAction = 'submit' | 'newline' | 'none';

/**
 * Resolves what an Enter press should do in the composer when `submitMessage` has been rebound.
 * The configured chord submits; a bare Enter still submits when "Enter to send" is on; any other
 * non-shift Enter inserts a newline. Returns `none` for Shift+Enter and non-Enter keys so the
 * caller leaves the browser's default behavior untouched.
 */
export function resolveSubmitOverrideAction(
  eventBinding: ShortcutBinding | null,
  submitOverride: ShortcutBinding | null,
  enterToSend: boolean,
): ComposerEnterAction {
  if (!eventBinding || eventBinding.key !== 'Enter') {
    return 'none';
  }
  const matchesChord = bindingsMatch(eventBinding, submitOverride);
  const isPlainEnter =
    !eventBinding.meta && !eventBinding.ctrl && !eventBinding.alt && !eventBinding.shift;
  if (matchesChord || (isPlainEnter && enterToSend)) {
    return 'submit';
  }
  if (!eventBinding.shift) {
    return 'newline';
  }
  return 'none';
}

export type ComposerKeyAction = ComposerEnterAction | 'block' | 'interrupt' | 'preempt' | 'other';

export interface ComposerKeyContext {
  isComposing: boolean;
  isSubmitting: boolean;
  allowSubmitWhileGenerating: boolean;
  hasDuringRunModifier: boolean;
  shortcutsEnabled: boolean;
  enterToSend: boolean;
  submitOverride: ShortcutBinding | null | undefined;
  /** `bindingHash`es of chords bound to global shortcuts that run while typing. */
  yieldedChords: ReadonlySet<string>;
}

/**
 * The composer's entire Enter decision table. Every verdict is terminal — no
 * interpretation falls through into another, which is what previously let a
 * chord that one branch declined reach a branch it never should have.
 * `yieldedChords` belong to the window-level handler in
 * `useKeyboardShortcuts`, which runs after the composer and yields any
 * keypress already claimed via `preventDefault` — so the composer must not
 * act on them at all, or the global action is silently swallowed. `block`
 * means preventDefault with no action.
 */
export function resolveComposerKeyDown(
  e: KeyChordSource,
  ctx: ComposerKeyContext,
): ComposerKeyAction {
  if (e.key !== 'Enter') {
    return 'none';
  }
  if (ctx.isSubmitting && !ctx.allowSubmitWhileGenerating) {
    return 'none';
  }
  const binding = bindingFromEvent(e);
  if (binding != null && ctx.yieldedChords.has(bindingHash(binding))) {
    return 'none';
  }
  const duringRun =
    ctx.shortcutsEnabled &&
    ctx.isSubmitting &&
    ctx.allowSubmitWhileGenerating &&
    ctx.hasDuringRunModifier;
  if (duringRun && !ctx.isComposing) {
    if (e.altKey && !bindingsMatch(binding, ctx.submitOverride)) {
      return 'interrupt';
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !bindingsMatch(binding, ctx.submitOverride)) {
      return 'preempt';
    }
    if ((e.ctrlKey || e.metaKey) && ctx.enterToSend && ctx.submitOverride === undefined) {
      return 'other';
    }
  }
  if (ctx.submitOverride !== undefined) {
    if (ctx.isComposing) {
      return 'none';
    }
    return resolveSubmitOverrideAction(binding, ctx.submitOverride, ctx.enterToSend);
  }
  const isCtrlEnter = e.ctrlKey || e.metaKey;
  if (!ctx.isComposing) {
    /** The modifier is always the inverse of plain Enter: it sends when Enter
     *  writes a newline, and writes one when Enter sends. The rebound path in
     *  `resolveSubmitOverrideAction` already reads it this way, so the default
     *  path only looked different because it had no newline branch. */
    if (isCtrlEnter) {
      return ctx.enterToSend ? 'newline' : 'submit';
    }
    if (!ctx.enterToSend) {
      return 'newline';
    }
    if (!e.shiftKey) {
      return 'submit';
    }
  }
  if (!e.shiftKey) {
    return 'block';
  }
  return 'none';
}

export function isCancelKey(e: KeyboardEvent): boolean {
  return e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

const MAC_SYMBOLS: Record<string, string> = {
  Meta: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↵',
  Escape: 'Esc',
  Tab: '⇥',
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

const OTHER_LABELS: Record<string, string> = {
  Meta: 'Win',
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Space: 'Space',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

function labelForToken(token: string, mac: boolean): string {
  const map = mac ? MAC_SYMBOLS : OTHER_LABELS;
  return map[token] ?? token;
}

export function bindingTokens(binding: ShortcutBinding): string[] {
  const tokens: string[] = [];
  if (binding.meta) tokens.push('Meta');
  if (binding.ctrl) tokens.push('Control');
  if (binding.alt) tokens.push('Alt');
  if (binding.shift) tokens.push('Shift');
  tokens.push(binding.key);
  return tokens;
}

export function bindingDisplayKeys(binding: ShortcutBinding | null, mac: boolean): string[] {
  if (!binding) {
    return [];
  }
  return bindingTokens(binding).map((token) => labelForToken(token, mac));
}

export function bindingDisplayString(binding: ShortcutBinding | null, mac: boolean): string {
  const keys = bindingDisplayKeys(binding, mac);
  return mac ? keys.join(' ') : keys.join('+');
}
