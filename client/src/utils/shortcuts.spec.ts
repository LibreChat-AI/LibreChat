import type { ShortcutBinding, ComposerKeyContext } from './shortcuts';
import {
  hasModifier,
  isCancelKey,
  bindingHash,
  normalizeKey,
  parseBinding,
  bindingsMatch,
  isModifierKey,
  isValidBinding,
  bindingTokens,
  bindingToString,
  resolveSubmitOverrideAction,
  resolveComposerKeyDown,
  bindingFromEvent,
  bindingDisplayKeys,
  bindingDisplayString,
} from './shortcuts';

function makeBinding(overrides: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return { meta: false, ctrl: false, alt: false, shift: false, key: '', ...overrides };
}

describe('normalizeKey', () => {
  it('maps special keys to their canonical token', () => {
    expect(normalizeKey('Backspace')).toBe('Backspace');
    expect(normalizeKey(' ')).toBe('Space');
    expect(normalizeKey('ArrowUp')).toBe('ArrowUp');
  });

  it('uppercases single character keys', () => {
    expect(normalizeKey('k')).toBe('K');
    expect(normalizeKey('a')).toBe('A');
  });

  it('resolves shifted punctuation back to the base key when shift is held', () => {
    expect(normalizeKey('?', true)).toBe('/');
    expect(normalizeKey(':', true)).toBe(';');
    expect(normalizeKey('?', false)).toBe('?');
  });

  it('passes through multi-character non-special keys unchanged', () => {
    expect(normalizeKey('F5')).toBe('F5');
  });
});

describe('isModifierKey', () => {
  it('recognizes modifier keys', () => {
    expect(isModifierKey('Meta')).toBe(true);
    expect(isModifierKey('Control')).toBe(true);
    expect(isModifierKey('Shift')).toBe(true);
    expect(isModifierKey('Alt')).toBe(true);
    expect(isModifierKey('k')).toBe(false);
  });
});

describe('bindingFromEvent', () => {
  it('returns null when the pressed key is itself a modifier', () => {
    const event = new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true });
    expect(bindingFromEvent(event)).toBeNull();
  });

  it('captures active modifiers and the normalized key', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(bindingFromEvent(event)).toEqual(makeBinding({ ctrl: true, shift: true, key: 'K' }));
  });

  it('normalizes special keys from the event', () => {
    const event = new KeyboardEvent('keydown', { key: 'Backspace', metaKey: true, shiftKey: true });
    expect(bindingFromEvent(event)).toEqual(
      makeBinding({ meta: true, shift: true, key: 'Backspace' }),
    );
  });

  it('uses the physical punctuation key on non-US keyboard layouts', () => {
    const event = new KeyboardEvent('keydown', {
      key: ':',
      code: 'Period',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(bindingFromEvent(event)).toEqual(makeBinding({ ctrl: true, shift: true, key: '.' }));
  });
});

describe('parseBinding', () => {
  it('returns null for empty input', () => {
    expect(parseBinding('')).toBeNull();
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding(undefined)).toBeNull();
  });

  it('parses modifier tokens and the trailing key', () => {
    expect(parseBinding('Meta+Shift+T')).toEqual(
      makeBinding({ meta: true, shift: true, key: 'T' }),
    );
    expect(parseBinding('Control+Shift+Backspace')).toEqual(
      makeBinding({ ctrl: true, shift: true, key: 'Backspace' }),
    );
  });

  it('accepts aliased modifier tokens', () => {
    expect(parseBinding('Cmd+Option+/')).toEqual(makeBinding({ meta: true, alt: true, key: '/' }));
  });

  it('returns null when the binding has no concrete key', () => {
    expect(parseBinding('Meta+Shift')).toBeNull();
  });

  it('round-trips with bindingToString', () => {
    const binding = makeBinding({ ctrl: true, shift: true, key: 'K' });
    expect(parseBinding(bindingToString(binding))).toEqual(binding);
  });
});

describe('bindingToString', () => {
  it('returns null for a null binding', () => {
    expect(bindingToString(null)).toBeNull();
  });

  it('serializes modifiers in a stable order', () => {
    expect(bindingToString(makeBinding({ meta: true, ctrl: true, shift: true, key: 'A' }))).toBe(
      'Meta+Control+Shift+A',
    );
  });
});

describe('bindingHash', () => {
  it('produces identical hashes for equivalent bindings', () => {
    const a = makeBinding({ meta: true, shift: true, key: 'T' });
    const b = makeBinding({ meta: true, shift: true, key: 'T' });
    expect(bindingHash(a)).toBe(bindingHash(b));
  });

  it('differs when modifiers or keys differ', () => {
    expect(bindingHash(makeBinding({ meta: true, key: 'T' }))).not.toBe(
      bindingHash(makeBinding({ ctrl: true, key: 'T' })),
    );
    expect(bindingHash(makeBinding({ meta: true, key: 'T' }))).not.toBe(
      bindingHash(makeBinding({ meta: true, key: 'Y' })),
    );
  });
});

describe('hasModifier', () => {
  it('is true when any non-shift modifier is present', () => {
    expect(hasModifier(makeBinding({ meta: true, key: 'T' }))).toBe(true);
    expect(hasModifier(makeBinding({ ctrl: true, key: 'T' }))).toBe(true);
    expect(hasModifier(makeBinding({ alt: true, key: 'T' }))).toBe(true);
  });

  it('is false for shift-only or unmodified bindings', () => {
    expect(hasModifier(makeBinding({ shift: true, key: 'T' }))).toBe(false);
    expect(hasModifier(makeBinding({ key: 'T' }))).toBe(false);
  });
});

describe('isValidBinding', () => {
  it('accepts any key combined with a non-shift modifier', () => {
    expect(isValidBinding(makeBinding({ meta: true, key: 'T' })).valid).toBe(true);
    expect(isValidBinding(makeBinding({ ctrl: true, key: 'Tab' })).valid).toBe(true);
    expect(isValidBinding(makeBinding({ alt: true, shift: true, key: 'Enter' })).valid).toBe(true);
  });

  it('accepts shift with a known-safe key', () => {
    expect(isValidBinding(makeBinding({ shift: true, key: 'Escape' })).valid).toBe(true);
  });

  it('rejects shift-only chords on focus/navigation keys', () => {
    for (const key of ['Tab', 'ArrowUp', 'ArrowDown', 'Backspace', 'Enter', 'Space']) {
      const result = isValidBinding(makeBinding({ shift: true, key }));
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('noModifier');
    }
  });

  it('rejects unmodified and shift-only printable keys', () => {
    expect(isValidBinding(makeBinding({ key: 'A' })).valid).toBe(false);
    expect(isValidBinding(makeBinding({ shift: true, key: 'A' })).valid).toBe(false);
  });
});

describe('resolveSubmitOverrideAction', () => {
  const altEnter = makeBinding({ alt: true, key: 'Enter' });

  it('submits when the event matches the configured chord', () => {
    expect(resolveSubmitOverrideAction(altEnter, altEnter, false)).toBe('submit');
  });

  it('newlines on the default Ctrl+Enter once the chord has been rebound', () => {
    const ctrlEnter = makeBinding({ ctrl: true, key: 'Enter' });
    expect(resolveSubmitOverrideAction(ctrlEnter, altEnter, false)).toBe('newline');
    expect(resolveSubmitOverrideAction(ctrlEnter, altEnter, true)).toBe('newline');
  });

  it('still submits a bare Enter when Enter-to-send is on', () => {
    const plainEnter = makeBinding({ key: 'Enter' });
    expect(resolveSubmitOverrideAction(plainEnter, altEnter, true)).toBe('submit');
    expect(resolveSubmitOverrideAction(plainEnter, altEnter, false)).toBe('newline');
  });

  it('treats an unbound submit shortcut as disabled while keeping Enter-to-send', () => {
    const ctrlEnter = makeBinding({ ctrl: true, key: 'Enter' });
    const plainEnter = makeBinding({ key: 'Enter' });
    expect(resolveSubmitOverrideAction(ctrlEnter, null, false)).toBe('newline');
    expect(resolveSubmitOverrideAction(plainEnter, null, true)).toBe('submit');
    expect(resolveSubmitOverrideAction(plainEnter, null, false)).toBe('newline');
  });

  it('leaves Shift+Enter and non-Enter keys to the default behavior', () => {
    expect(
      resolveSubmitOverrideAction(makeBinding({ shift: true, key: 'Enter' }), altEnter, true),
    ).toBe('none');
    expect(resolveSubmitOverrideAction(makeBinding({ ctrl: true, key: 'J' }), altEnter, true)).toBe(
      'none',
    );
    expect(resolveSubmitOverrideAction(null, altEnter, true)).toBe('none');
  });
});

describe('isCancelKey', () => {
  it('is true for a bare Escape press', () => {
    expect(isCancelKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
  });

  it('is false when Escape is combined with a modifier', () => {
    expect(isCancelKey(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true }))).toBe(
      false,
    );
  });
});

describe('display helpers', () => {
  const binding = makeBinding({ meta: true, shift: true, key: 'T' });

  it('returns an empty token list for a null binding', () => {
    expect(bindingDisplayKeys(null, true)).toEqual([]);
  });

  it('lists tokens in modifier order', () => {
    expect(bindingTokens(binding)).toEqual(['Meta', 'Shift', 'T']);
  });

  it('renders mac symbols joined by spaces', () => {
    expect(bindingDisplayString(binding, true)).toBe('⌘ ⇧ T');
  });

  it('renders non-mac labels joined by plus signs', () => {
    const ctrlBinding = makeBinding({ ctrl: true, shift: true, key: 'T' });
    expect(bindingDisplayString(ctrlBinding, false)).toBe('Ctrl+Shift+T');
  });

  it('labels the Meta modifier as Win on non-mac platforms', () => {
    expect(bindingDisplayString(binding, false)).toBe('Win+Shift+T');
  });
});

describe('bindingsMatch', () => {
  const preemptChord = makeBinding({ ctrl: true, shift: true, key: 'Enter' });

  it('matches the same chord regardless of the order modifiers are written in', () => {
    expect(bindingsMatch(preemptChord, parseBinding('Ctrl+Shift+Enter'))).toBe(true);
    expect(bindingsMatch(parseBinding('Shift+Ctrl+Enter'), preemptChord)).toBe(true);
  });

  it('does not match a different chord or the same key with different modifiers', () => {
    expect(bindingsMatch(preemptChord, parseBinding('Ctrl+J'))).toBe(false);
    expect(bindingsMatch(preemptChord, parseBinding('Ctrl+Enter'))).toBe(false);
    expect(bindingsMatch(preemptChord, parseBinding('Cmd+Shift+Enter'))).toBe(false);
  });

  it('treats an unbound, unset, or unpressed side as no match', () => {
    expect(bindingsMatch(preemptChord, null)).toBe(false);
    expect(bindingsMatch(preemptChord, undefined)).toBe(false);
    expect(bindingsMatch(null, preemptChord)).toBe(false);
    expect(bindingsMatch(null, null)).toBe(false);
  });
});

describe('resolveComposerKeyDown', () => {
  function keydown(init: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Enter', ...init });
  }

  const idle: ComposerKeyContext = {
    isComposing: false,
    isSubmitting: false,
    allowSubmitWhileGenerating: false,
    hasDuringRunModifier: false,
    shortcutsEnabled: true,
    enterToSend: true,
    submitOverride: undefined,
    yieldedChords: new Set<string>(),
  };
  const duringRun: ComposerKeyContext = {
    ...idle,
    isSubmitting: true,
    allowSubmitWhileGenerating: true,
    hasDuringRunModifier: true,
  };
  const boundChord = (binding: ShortcutBinding) => new Set([bindingHash(binding)]);

  it('yields the entire pipeline to a chord bound to an editing-allowed shortcut during a run', () => {
    const ctx = {
      ...duringRun,
      yieldedChords: boundChord(makeBinding({ ctrl: true, shift: true, key: 'Enter' })),
    };
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), ctx)).toBe('none');
  });

  it('yields bound Alt+Enter and Ctrl+Enter chords during a run', () => {
    const altCtx = {
      ...duringRun,
      yieldedChords: boundChord(makeBinding({ alt: true, key: 'Enter' })),
    };
    expect(resolveComposerKeyDown(keydown({ altKey: true }), altCtx)).toBe('none');
    const ctrlCtx = {
      ...duringRun,
      yieldedChords: boundChord(makeBinding({ ctrl: true, key: 'Enter' })),
    };
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), ctrlCtx)).toBe('none');
  });

  it('yields a bound chord while idle too, instead of submitting through the tail', () => {
    const ctx = {
      ...idle,
      yieldedChords: boundChord(makeBinding({ ctrl: true, shift: true, key: 'Enter' })),
    };
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), ctx)).toBe('none');
  });

  it('preempts on an unbound Ctrl/Cmd+Shift+Enter during a run', () => {
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), duringRun)).toBe(
      'preempt',
    );
    expect(resolveComposerKeyDown(keydown({ metaKey: true, shiftKey: true }), duringRun)).toBe(
      'preempt',
    );
  });

  it('still preempts when submit is rebound to an unrelated chord', () => {
    const ctx = { ...duringRun, submitOverride: makeBinding({ alt: true, key: 'Enter' }) };
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), ctx)).toBe('preempt');
  });

  it('submits when submit itself is rebound to the interrupt chord', () => {
    const ctx = {
      ...duringRun,
      submitOverride: makeBinding({ ctrl: true, shift: true, key: 'Enter' }),
    };
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), ctx)).toBe('submit');
  });

  it('interrupts on Alt+Enter during a run', () => {
    expect(resolveComposerKeyDown(keydown({ altKey: true }), duringRun)).toBe('interrupt');
  });

  it('submits when submit itself is rebound to Alt+Enter during a run', () => {
    const ctx = { ...duringRun, submitOverride: makeBinding({ alt: true, key: 'Enter' }) };
    expect(resolveComposerKeyDown(keydown({ altKey: true }), ctx)).toBe('submit');
  });

  it('still interrupts on Alt+Enter when submit is rebound elsewhere', () => {
    const ctx = { ...duringRun, submitOverride: makeBinding({ ctrl: true, key: 'J' }) };
    expect(resolveComposerKeyDown(keydown({ altKey: true }), ctx)).toBe('interrupt');
  });

  it('routes Ctrl/Cmd+Enter to the alternate action during a run with default submit', () => {
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), duringRun)).toBe('other');
    expect(
      resolveComposerKeyDown(keydown({ ctrlKey: true }), { ...duringRun, enterToSend: false }),
    ).toBe('submit');
  });

  it('gates during-run shortcut chords while preserving plain Enter behavior', () => {
    const shortcutsDisabled = {
      ...duringRun,
      shortcutsEnabled: false,
      submitOverride: null,
    };

    expect(resolveComposerKeyDown(keydown({ altKey: true }), shortcutsDisabled)).toBe('newline');
    expect(
      resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), shortcutsDisabled),
    ).toBe('none');
    expect(
      resolveComposerKeyDown(keydown({ metaKey: true, shiftKey: true }), shortcutsDisabled),
    ).toBe('none');
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), shortcutsDisabled)).toBe('newline');
    expect(resolveComposerKeyDown(keydown(), shortcutsDisabled)).toBe('submit');
    expect(resolveComposerKeyDown(keydown(), { ...shortcutsDisabled, enterToSend: false })).toBe(
      'newline',
    );
  });

  it('does nothing while a run disallows submission', () => {
    expect(resolveComposerKeyDown(keydown(), { ...idle, isSubmitting: true })).toBe('none');
  });

  it('keeps idle Enter semantics', () => {
    expect(resolveComposerKeyDown(keydown(), idle)).toBe('submit');
    expect(resolveComposerKeyDown(keydown(), { ...idle, enterToSend: false })).toBe('newline');
    expect(resolveComposerKeyDown(keydown({ shiftKey: true }), idle)).toBe('none');
    expect(resolveComposerKeyDown(new KeyboardEvent('keydown', { key: 'a' }), idle)).toBe('none');
  });

  /* The modifier is the inverse of plain Enter, so whichever of the two sends,
     the other writes a newline and neither preference leaves the user without
     a way to break a line. */
  it('inverts Ctrl/Cmd+Enter against the Enter-to-send preference while idle', () => {
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), idle)).toBe('newline');
    expect(resolveComposerKeyDown(keydown({ metaKey: true }), idle)).toBe('newline');
    expect(
      resolveComposerKeyDown(keydown({ ctrlKey: true }), { ...idle, enterToSend: false }),
    ).toBe('submit');
    expect(
      resolveComposerKeyDown(keydown({ metaKey: true }), { ...idle, enterToSend: false }),
    ).toBe('submit');
  });

  it('leaves both newline chords available whichever way Enter is bound', () => {
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), idle)).toBe('newline');
    expect(resolveComposerKeyDown(keydown({ shiftKey: true }), idle)).toBe('none');
    const newlineOnEnter = { ...idle, enterToSend: false };
    expect(resolveComposerKeyDown(keydown(), newlineOnEnter)).toBe('newline');
    expect(resolveComposerKeyDown(keydown({ shiftKey: true }), newlineOnEnter)).toBe('newline');
  });

  /* The during-run table claims Ctrl/Cmd+Enter for the alternate send action,
     and it resolves before the idle tail, so the newline chord must not reach
     into a live run and swallow it. */
  it('does not let the idle newline chord displace the during-run actions', () => {
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), duringRun)).toBe('other');
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), duringRun)).toBe(
      'preempt',
    );
    expect(resolveComposerKeyDown(keydown({ altKey: true }), duringRun)).toBe('interrupt');
  });

  it('resolves through the submit override while idle', () => {
    const ctx = { ...idle, submitOverride: makeBinding({ alt: true, key: 'Enter' }) };
    expect(resolveComposerKeyDown(keydown({ altKey: true }), ctx)).toBe('submit');
    expect(resolveComposerKeyDown(keydown({ ctrlKey: true }), ctx)).toBe('newline');
    expect(resolveComposerKeyDown(keydown(), ctx)).toBe('submit');
    expect(resolveComposerKeyDown(keydown(), { ...ctx, enterToSend: false })).toBe('newline');
  });

  it('blocks a non-shift Enter without acting mid IME composition', () => {
    expect(resolveComposerKeyDown(keydown(), { ...idle, isComposing: true })).toBe('block');
    expect(
      resolveComposerKeyDown(keydown({ ctrlKey: true, shiftKey: true }), {
        ...duringRun,
        isComposing: true,
      }),
    ).toBe('none');
  });
});
