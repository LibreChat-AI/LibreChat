/** @jest-environment jsdom */
import { Button } from '@librechat/client';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import type { LivePhaseHeaderProps } from '../Live';
import { useRailHover } from '../../rail';
import LivePhaseHeader from '../Live';

type DisplayProps = Partial<Omit<LivePhaseHeaderProps, 'railHover'>>;

function renderHeader(overrides: DisplayProps = {}) {
  const hover = renderHook(useRailHover).result.current;
  const props: LivePhaseHeaderProps = {
    text: 'Reading the roadmap',
    source: 'tool:1',
    animate: true,
    lineId: 'line',
    comboId: 'combo',
    detailId: 'detail',
    combo: '',
    failedNote: '',
    cancelledNote: '',
    glyph: <span data-testid="tool-glyph" />,
    railHover: hover,
    ...overrides,
  };
  const view = (display: LivePhaseHeaderProps) => (
    <Button aria-labelledby={`${display.lineId} ${display.comboId} ${display.detailId}`}>
      <LivePhaseHeader {...display} />
    </Button>
  );
  const rendered = render(view(props));
  return {
    ...rendered,
    hover,
    update: (next: DisplayProps) => rendered.rerender(view({ ...props, ...next })),
  };
}

describe('LivePhaseHeader', () => {
  test('names the disclosure from its line and keeps the supplied glyph on the rail', () => {
    const { hover } = renderHeader();
    const button = screen.getByRole('button', { name: 'Reading the roadmap' });
    expect(screen.getByText('Reading the roadmap').parentElement).toHaveAttribute('id', 'line');
    expect(screen.getByTitle('Reading the roadmap')).toHaveClass('flex-1');
    expect(screen.queryByTestId('live-phase-combo')).toBeNull();
    expect(screen.queryByTestId('live-phase-outcome')).toBeNull();
    expect(button.firstElementChild).toHaveAttribute('aria-hidden', 'true');

    act(() => hover.set(true));
    expect(button).toContainElement(screen.getByTestId('fold-rail-knob'));
    expect(screen.getByTestId('tool-glyph').parentElement).toHaveClass('invisible');
    act(() => hover.set(false));
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
  });

  test.each([
    ['×3', false, 'sr-only'],
    ['· 3 checks', true, 'text-text-secondary'],
  ])('keeps %s beside the label with its original visibility', (combo, background, className) => {
    renderHeader({ combo, isBackgroundTaskCheck: background });

    const count = screen.getByTestId('live-phase-combo');
    expect(count).toHaveAttribute('id', 'combo');
    expect(count).toHaveClass(className);
    expect(count).toHaveTextContent(combo);
    expect(screen.getByTitle('Reading the roadmap')).not.toHaveClass('flex-1');
    expect(screen.getByRole('button')).toHaveAccessibleName(`Reading the roadmap ${combo}`);
  });

  test('hides the failed note visually and retains the visible cancelled note and both IDs', () => {
    renderHeader({
      combo: '×2',
      failedNote: '1/3 actions failed',
      cancelledNote: 'One action cancelled',
    });

    const outcome = screen.getByTestId('live-phase-outcome');
    expect(outcome).toHaveAttribute('id', 'detail');
    expect(within(outcome).getByText('· 1/3 actions failed')).toHaveClass('sr-only');
    expect(within(outcome).getByText('One action cancelled')).not.toHaveClass('sr-only');
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Reading the roadmap ×2 · 1/3 actions failed · One action cancelled',
    );
  });

  test('keeps only the failed note in the outcome when nothing was cancelled', () => {
    renderHeader({ failedNote: '1/2 actions failed' });

    const outcome = screen.getByTestId('live-phase-outcome');
    expect(outcome.children).toHaveLength(1);
    expect(outcome.firstElementChild).toHaveClass('sr-only');
  });

  test('preserves the real ticker source identity and reduced-motion input across updates', () => {
    const { update } = renderHeader();
    const current = screen.getByText('Reading the roadmap').parentElement;
    update({ text: 'Reading the roadmap and notes' });
    expect(screen.getByText('Reading the roadmap and notes').parentElement).toBe(current);
    expect(current).not.toHaveClass('animate-in');

    update({ text: 'Checking the results', source: 'tool:2' });
    expect(screen.getByText('Checking the results').parentElement).toHaveClass('animate-in');
    expect(screen.getByText('Reading the roadmap and notes').parentElement).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    update({ text: 'Finished checking', source: 'tool:3', animate: false });
    expect(screen.queryByText('Checking the results')).toBeNull();
    expect(screen.getByText('Finished checking').parentElement).not.toHaveClass('animate-in');
  });
});
