import React from 'react';
import { render, screen } from '@testing-library/react';
import type { ToolPreparationInput } from '../preparation';
import { isToolCallPreparing, ToolPreparation } from '../preparation';
import { areToolCallArgsComplete } from '../Parts/parseJsonField';
import ProgressText from '../ProgressText';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    key === 'com_ui_tool_preparing' ? `Preparing ${values?.[0]}` : key,
}));

const partialArgs = '{"intent":"Checking the database","query":"SELECT';

const prepare = (overrides: Partial<ToolPreparationInput> = {}) =>
  isToolCallPreparing({ args: partialArgs, ...overrides });

describe('tool preparation', () => {
  it.each([undefined, '', '{', partialArgs, '{"code":"echo }'])(
    'keeps incomplete args %s in preparation',
    (args) => expect(prepare({ args })).toBe(true),
  );

  it.each(['{}', '{"query":"SELECT 1"}', { query: 'SELECT 1' }])(
    'uses complete legacy args %s as the execution fallback',
    (args) => expect(prepare({ args })).toBe(false),
  );

  it('waits for explicit dispatch on a measured call even after args become valid JSON', () => {
    expect(prepare({ args: '{}', toolPreparationStartedAt: 0 })).toBe(true);
    expect(prepare({ toolPreparationStartedAt: 0, toolDispatchedAt: 100 })).toBe(false);
  });

  it.each([
    { output: 'result' },
    { progress: 1 },
    { runStepStatus: 'completed' as const },
    { runStepStatus: 'failed' as const },
    { runStepStatus: 'cancelled' as const },
    { toolDispatchedAt: 0 },
  ])('never demotes execution or a settled call to preparation: %s', (signal) => {
    expect(prepare({ toolPreparationStartedAt: 0, ...signal })).toBe(false);
  });

  it('does not confuse a trailing brace inside an unfinished string with complete args', () => {
    expect(areToolCallArgsComplete('{"code":"echo }')).toBe(false);
    expect(areToolCallArgsComplete('{"code":"echo }"}  ')).toBe(true);
  });

  it('shows preparation before dispatch and the authored execution label afterwards', () => {
    const call = { name: 'lookup', args: partialArgs, toolPreparationStartedAt: 0 };
    const card = (overrides: Partial<ToolPreparationInput> = {}, submitting = true) => (
      <ToolPreparation call={{ ...call, ...overrides }} isSubmitting={submitting}>
        <ProgressText phase="running" inProgressText="Checking the database" finishedText="Done" />
      </ToolPreparation>
    );
    const { rerender } = render(card());
    expect(screen.getByRole('button')).toHaveTextContent('Preparing lookup');
    rerender(card({ args: '{}' }));
    expect(screen.getByRole('button')).toHaveTextContent('Preparing lookup');
    rerender(card({ toolDispatchedAt: 100 }));
    expect(screen.getByRole('button')).toHaveTextContent('Checking the database');
    rerender(card({}, false));
    expect(screen.queryByText('Preparing lookup')).not.toBeInTheDocument();
  });

  it.each(['failed', 'cancelled', 'completed'] as const)(
    'does not overwrite a %s verdict with preparation',
    (phase) => {
      render(
        <ToolPreparation call={{ name: 'lookup', args: partialArgs }} isSubmitting>
          <ProgressText phase={phase} inProgressText="Running lookup" finishedText="Settled" />
        </ToolPreparation>,
      );
      expect(screen.getByRole('button')).toHaveTextContent('Settled');
      expect(screen.queryByText('Preparing lookup')).not.toBeInTheDocument();
    },
  );
});
