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

function hints(state: Partial<ComposerHintState> = {}, index = 0) {
  return <Hints {...baseState} {...state} index={index} />;
}

const description = (index = 0) => document.getElementById(composerHintId(index));

describe('composer hints', () => {
  it.each([
    {},
    { hasText: false },
    { isSubmitting: true, duringRunActive: true },
    { answerModeActive: true },
  ])('never renders a visible hint row (%j)', (state) => {
    render(hints(state));
    expect(screen.queryByTestId('composer-hints')).not.toBeInTheDocument();
    expect(description()).toHaveClass('sr-only');
  });

  it.each([{ hasText: false }, { hasText: true }, { hasText: false, duringRunActive: true }])(
    'keeps upload progress in the accessible description (%j)',
    (state) => {
      const { rerender } = render(hints(state));
      const idleDescription = description()?.textContent;

      for (const uploadingCount of [1, 2, 1, 0]) {
        rerender(hints({ ...state, uploadingCount }));
        if (uploadingCount > 0) {
          expect(description()).toHaveTextContent(/Uploading/);
        } else {
          expect(description()?.textContent).toBe(idleDescription);
        }
      }
    },
  );

  it('keeps answer mode ahead of upload status', () => {
    const { rerender } = render(hints({ answerModeActive: true }));
    const answer = description()?.textContent;

    rerender(hints({ answerModeActive: true, uploadingCount: 1 }));

    expect(description()?.textContent).toBe(answer);
    expect(description()).not.toHaveTextContent(/Uploading/);
  });

  it('keeps the accessible upload descriptions scoped to each pane', () => {
    render(
      <>
        {hints({ uploadingCount: 1 }, 0)}
        {hints({ uploadingCount: 2 }, 1)}
      </>,
    );

    expect(description(0)).toHaveTextContent('Uploading 1 file');
    expect(description(1)).toHaveTextContent('Uploading 2 files');
  });
});
