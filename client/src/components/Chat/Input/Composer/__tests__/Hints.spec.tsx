import React from 'react';
import { render, screen } from '@testing-library/react';
import type { ComposerHintState } from '~/hooks/Input/useComposerHint';
import Hints, { composerHintId } from '../Hints';

jest.mock('~/hooks/Input/useComposerBindings', () => ({
  __esModule: true,
  default: () => ({
    shortcutsEnabled: true,
    submitOverride: undefined,
    yieldedChords: new Set<string>(),
  }),
}));

const baseState: ComposerHintState = {
  hasText: true,
  isSubmitting: false,
  duringRunActive: false,
  canControlGeneration: true,
  duringRunAction: 'queue',
  canSteer: true,
  answerModeActive: false,
  uploadingCount: 0,
  enterToSend: true,
  idleActions: { prompts: true, mentions: true, attach: true },
};

function hints(state: Partial<ComposerHintState> = {}, showTips = false, index = 0) {
  return <Hints {...baseState} {...state} showTips={showTips} index={index} />;
}

const description = (index = 0) => document.getElementById(composerHintId(index));

describe('composer upload hints', () => {
  it.each([{ hasText: false }, { hasText: true }, { hasText: false, duringRunActive: true }])(
    'keeps uploads out of the visible hint row through progress, completion and cancellation (%j)',
    (state) => {
      const { rerender } = render(hints(state));
      const idleDescription = description()?.textContent;

      for (const uploadingCount of [1, 2, 1, 0, 1, 0]) {
        rerender(hints({ ...state, uploadingCount }));
        expect(screen.queryByTestId('composer-hints')).not.toBeInTheDocument();
        if (uploadingCount > 0) {
          expect(description()).toHaveTextContent(/Uploading/);
          expect(description()).toHaveClass('sr-only');
        } else {
          expect(description()?.textContent).toBe(idleDescription);
        }
      }
    },
  );

  it.each([
    ['enabled tips', {}, true],
    ['an active run', { isSubmitting: true, duringRunActive: true }, false],
  ] as const)('preserves %s while an upload starts and finishes', (_name, state, showTips) => {
    const { rerender } = render(hints(state, showTips));
    const visibleHint = screen.getByTestId('composer-hints');
    const text = visibleHint.textContent;

    for (const uploadingCount of [1, 2, 0]) {
      rerender(hints({ ...state, uploadingCount }, showTips));
      expect(screen.getByTestId('composer-hints')).toBe(visibleHint);
      expect(visibleHint).toHaveAttribute('aria-hidden', 'true');
      if (uploadingCount > 0) {
        expect(visibleHint).toHaveTextContent(/Uploading/);
        expect(description()).toHaveTextContent(/Uploading/);
      } else {
        expect(visibleHint.textContent).toBe(text);
        expect(description()?.textContent).toBe(text);
      }
    }
  });

  it('keeps answer mode ahead of upload status', () => {
    const { rerender } = render(hints({ answerModeActive: true }));
    const answer = description()?.textContent;

    rerender(hints({ answerModeActive: true, uploadingCount: 1 }));

    expect(description()?.textContent).toBe(answer);
    expect(screen.getByTestId('composer-hints').textContent).toBe(answer);
    expect(description()).not.toHaveTextContent(/Uploading/);
  });

  it('keeps the accessible upload descriptions scoped to each pane', () => {
    render(
      <>
        {hints({ uploadingCount: 1 }, false, 0)}
        {hints({ uploadingCount: 2 }, false, 1)}
      </>,
    );

    expect(description(0)).toHaveTextContent('Uploading 1 file');
    expect(description(1)).toHaveTextContent('Uploading 2 files');
    expect(screen.queryByTestId('composer-hints')).not.toBeInTheDocument();
  });
});
